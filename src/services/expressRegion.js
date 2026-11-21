// ============================================================================
// expressRegion.js · 偏远地区规则服务（2026-11-20 新增）
// ----------------------------------------------------------------------------
// 存储：express_region_rules（每行 = 某快递公司某分类下的一个行政区域）
//   - province 必填；city/district 为空串表示「全省 / 全市」
//   - 同一快递公司下，同一区域只能属于一个分类（保存时校验）
// 判定优先级（按快递公司隔离）：
//   1. 大偏远：区县 → 市 → 省 逐级降级匹配
//   2. 小偏远：同上
//   3. 正常：正常列表为空 → 未命中大/小偏远的地区一律为「正常」；
//            正常列表非空 → 仅命中列表的为「正常」，其余为「其他」
// 实时生效：每次导入/查询都从库读取，无缓存。
// ============================================================================

const CLASSES = ['大偏远', '小偏远', '正常'];
const OTHER_CLASS = '其他';
const MAX_RULES_PER_CARRIER = 3000;

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS express_region_rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      carrier      TEXT NOT NULL,
      region_class TEXT NOT NULL CHECK(region_class IN ('大偏远','小偏远','正常')),
      province     TEXT NOT NULL,
      city         TEXT NOT NULL DEFAULT '',
      district     TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (carrier, region_class, province, city, district)
    );
    CREATE INDEX IF NOT EXISTS idx_express_region_carrier ON express_region_rules(carrier, region_class);
  `);
}

function norm(s) {
  return String(s == null ? '' : s).trim();
}

function areaKey(province, city, district) {
  return `${province}|${city || ''}|${district || ''}`;
}

// 读取某快递公司的全部规则行（未规范化）
function readRows(db, carrier) {
  ensureTable(db);
  return db.prepare(`
    SELECT id, carrier, region_class, province, city, district
    FROM express_region_rules WHERE carrier=? ORDER BY region_class, province, city, district
  `).all(norm(carrier));
}

// 某快递公司已配置的规则（分组结构，供前端渲染）
function listRules(db, carrier) {
  const groups = { '大偏远': [], '小偏远': [], '正常': [] };
  const rows = readRows(db, carrier);
  for (const r of rows) {
    if (groups[r.region_class]) {
      groups[r.region_class].push({ province: r.province, city: r.city || '', district: r.district || '' });
    }
  }
  return { carrier: norm(carrier), groups, hasConfig: rows.length > 0, count: rows.length };
}

// 保存（全量替换），返回保存结果；同时重算该快递公司历史订单的地区分类
function saveRules(db, carrier, groups) {
  const name = norm(carrier);
  if (!name) throw new Error('快递公司不能为空');
  ensureTable(db);

  const items = [];
  const seen = new Map();      // 区域 key → 分类（跨分类去重）
  let total = 0;
  for (const cls of CLASSES) {
    const list = Array.isArray(groups && groups[cls]) ? groups[cls] : [];
    for (const a of list) {
      const province = norm(a && a.province);
      const city = norm(a && a.city);
      const district = norm(a && a.district);
      if (!province) continue;
      if (district && !city) throw new Error('选择区县时必须先选择城市');
      const key = areaKey(province, city, district);
      if (seen.has(key)) {
        if (seen.get(key) === cls) continue;             // 同分类重复 → 自动去重
        throw new Error(`区域「${province}${city ? ' / ' + city : ''}${district ? ' / ' + district : ''}」同时出现在「${seen.get(key)}」和「${cls}」中，请先移除其中一个`);
      }
      seen.set(key, cls);
      items.push({ cls, province, city, district });
      total++;
      if (total > MAX_RULES_PER_CARRIER) throw new Error(`单个快递公司最多配置 ${MAX_RULES_PER_CARRIER} 个区域`);
    }
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM express_region_rules WHERE carrier=?').run(name);
    const ins = db.prepare(
      'INSERT INTO express_region_rules (carrier, region_class, province, city, district) VALUES (?,?,?,?,?)'
    );
    for (const it of items) ins.run(name, it.cls, it.province, it.city, it.district);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  }

  const recalced = recalcOrders(db, name);
  return { ...listRules(db, name), recalced };
}

// 清空某快递公司配置（清空后该公司的判定回退到系统内置规则）
function clearRules(db, carrier) {
  const name = norm(carrier);
  if (!name) throw new Error('快递公司不能为空');
  ensureTable(db);
  db.prepare('DELETE FROM express_region_rules WHERE carrier=?').run(name);
  const recalced = recalcOrders(db, name);
  return { carrier: name, ...listRules(db, name), recalced };
}

// 快递公司列表：已配置规则的公司 + 物流映射里的公司（供下拉选择）
function carriers(db, mappingNames = []) {
  ensureTable(db);
  const configured = db.prepare(`
    SELECT carrier, COUNT(*) AS count FROM express_region_rules GROUP BY carrier ORDER BY carrier
  `).all();
  const map = new Map();
  for (const name of mappingNames) {
    const n = norm(name);
    if (n) map.set(n, { carrier: n, count: 0, hasConfig: false });
  }
  for (const r of configured) {
    map.set(r.carrier, { carrier: r.carrier, count: r.count, hasConfig: true });
  }
  return Array.from(map.values());
}

// 省/市/区级联数据源：订单收件地址 + 已配置规则（保证规则里的区域始终可选）
function regionTree(db) {
  const provinces = new Map(); // province → Map(city → Set(district))

  const add = (province, city, district) => {
    const p = norm(province);
    if (!p) return;
    if (!provinces.has(p)) provinces.set(p, new Map());
    const cities = provinces.get(p);
    const c = norm(city);
    if (!c) return;
    if (!cities.has(c)) cities.set(c, new Set());
    const d = norm(district);
    if (d) cities.get(c).add(d);
  };

  try {
    const rows = db.prepare(`
      SELECT DISTINCT to_province AS province, to_city AS city, to_district AS district
      FROM orders WHERE to_province IS NOT NULL AND to_province != ''
    `).all();
    for (const r of rows) add(r.province, r.city, r.district);
  } catch (e) { /* orders 表不存在等 */ }

  ensureTable(db);
  try {
    const rules = db.prepare(
      'SELECT DISTINCT province, city, district FROM express_region_rules'
    ).all();
    for (const r of rules) add(r.province, r.city, r.district);
  } catch (e) { /* ignore */ }

  return Array.from(provinces.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([province, cities]) => ({
      province,
      cities: Array.from(cities.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
        .map(([city, districts]) => ({
          city,
          districts: Array.from(districts).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
        })),
    }));
}

// 单次判定（读库；批量请用 createResolver）
function resolveClass(db, carrier, province, city, district) {
  const p = norm(province);
  if (!p) return '正常';
  const rows = readRows(db, carrier);
  if (!rows.length) return null;   // 该公司未配置 → 调用方回退系统内置规则
  return matchRows(rows, p, norm(city), norm(district));
}

// 纯匹配：rows 为该公司的规则行
function matchRows(rows, province, city, district) {
  const byClass = { '大偏远': [], '小偏远': [], '正常': [] };
  for (const r of rows) {
    if (byClass[r.region_class]) byClass[r.region_class].push(r);
  }
  const hit = (list) => {
    if (district) {
      for (const r of list) {
        if (r.province === province && r.city === city && r.district === district) return true;
      }
    }
    if (city) {
      for (const r of list) {
        if (r.province === province && r.city === city && !r.district) return true;
      }
    }
    for (const r of list) {
      if (r.province === province && !r.city) return true;
    }
    return false;
  };

  if (hit(byClass['大偏远'])) return '大偏远';
  if (hit(byClass['小偏远'])) return '小偏远';
  if (!byClass['正常'].length) return '正常';           // 正常列表为空 → 其余均为正常
  return hit(byClass['正常']) ? '正常' : OTHER_CLASS;   // 已配置正常 → 仅匹配列表
}

// 批量导入用：一次读取全部规则，返回 resolve(carrier, province, city, district)
// 未配置规则的快递公司返回 null（调用方回退到系统内置 shentong 规则）
function createResolver(db) {
  ensureTable(db);
  const all = db.prepare(
    'SELECT carrier, region_class, province, city, district FROM express_region_rules'
  ).all();
  const byCarrier = new Map();
  for (const r of all) {
    if (!byCarrier.has(r.carrier)) byCarrier.set(r.carrier, []);
    byCarrier.get(r.carrier).push(r);
  }
  return function resolve(carrier, province, city, district) {
    const p = norm(province);
    if (!p) return '正常';
    const rows = byCarrier.get(norm(carrier));
    if (!rows || !rows.length) return null;
    return matchRows(rows, p, norm(city), norm(district));
  };
}

// 配置变更后重算该快递公司的历史订单区域分类（实时生效）
function recalcOrders(db, carrier) {
  const name = norm(carrier);
  if (!name) return 0;
  let rows;
  try {
    rows = db.prepare(`
      SELECT order_id, to_province, to_city, to_district FROM orders WHERE waybill_type=?
    `).all(name);
  } catch (e) {
    return 0;
  }
  if (!rows.length) return 0;

  const resolve = createResolver(db);
  const legacy = makeLegacy(db);

  const upd = db.prepare('UPDATE orders SET region_class=? WHERE order_id=?');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const cls = resolve(name, r.to_province, r.to_city, r.to_district)
        || legacy(r.to_province, r.to_city);
      upd.run(cls, r.order_id);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    return 0;
  }
  return n;
}

// 系统内置规则判定（与导入时兜底完全一致）
function makeLegacy(db) {
  let stmtExact = null;
  let stmtProv = null;
  try {
    stmtExact = db.prepare('SELECT region_class FROM shentong_region_class WHERE province=? AND city=?');
    stmtProv = db.prepare('SELECT region_class FROM shentong_region_class WHERE province=? AND city IS NULL');
  } catch (e) { /* shentong_region_class 不存在 */ }
  return function legacy(province, city) {
    const p = norm(province);
    if (!p) return '正常';
    try {
      if (city && stmtExact) {
        const ex = stmtExact.get(p, city);
        if (ex) return ex.region_class;
      }
      const prov = stmtProv ? stmtProv.get(p) : null;
      if (prov) return prov.region_class;
    } catch (e) { /* ignore */ }
    return '正常';
  };
}

// 按日期段重算地区分类（地区看板「更新」按钮）
//   start/end 为 YYYY-MM-DD，含首尾；单事务保证一致性；仅更新发生变化的行。
function recalcOrdersByRange(db, start, end) {
  ensureTable(db);
  let rows;
  try {
    rows = db.prepare(`
      SELECT order_id, waybill_type, to_province, to_city, to_district, region_class
      FROM orders WHERE order_date >= ? AND order_date <= ?
    `).all(start, end);
  } catch (e) {
    throw new Error('读取订单失败：' + e.message);
  }
  if (!rows.length) return { total: 0, updated: 0 };

  const resolve = createResolver(db);
  const legacy = makeLegacy(db);
  const upd = db.prepare('UPDATE orders SET region_class=? WHERE order_id=?');
  let updated = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const cls = (r.waybill_type ? resolve(r.waybill_type, r.to_province, r.to_city, r.to_district) : null)
        || legacy(r.to_province, r.to_city);
      if (cls !== r.region_class) {
        upd.run(cls, r.order_id);
        updated++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw new Error('更新失败（已回滚，数据未变更）：' + e.message);
  }
  return { total: rows.length, updated };
}

module.exports = {
  CLASSES,
  OTHER_CLASS,
  ensureTable,
  listRules,
  saveRules,
  clearRules,
  carriers,
  regionTree,
  resolveClass,
  createResolver,
  recalcOrders,
  recalcOrdersByRange,
};
