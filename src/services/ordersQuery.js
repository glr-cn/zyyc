// ============================================================================
// 订单查询服务层（模块化分层：路由层只做参数解析与响应，查询逻辑全部收口于此）
// ----------------------------------------------------------------------------
// 核心查询规则：
//   1. 快递单号 q 非空 → **自动忽略日期条件**（start/end 不进 WHERE），用户无需手动清除
//   2. q 支持批量：逗号 / 中文逗号 / 顿号 / 空格 / 换行分隔 → 精确 IN 匹配
//      单个单号 → LIKE 模糊匹配（兼容用户只复制了部分单号的场景）
//   3. 省/市/区县三级级联过滤（市依赖省、区县依赖省+市）
//   4. 平台、日期（order_date BETWEEN start AND end，闭区间，与地区看板规则一致）
//   5. 行级权限：ownerScope 注入的 scope.sql 原样拼接（业务员只看自己的单）
// ----------------------------------------------------------------------------
// to_district 列：2026-11-20 新增（幂等 ALTER），历史行该列为 NULL，
// 区县筛选下拉会自动跳过 NULL（选择"全部"即可查全量）。
// ============================================================================

// 幂等加列：orders.to_district（历史库无此列，ALTER 一次后永久生效）
// 注：不做模块级缓存 —— PRAGMA 开销极低，且能正确处理"连接期间表被重建"的极端场景
function ensureDistrictColumn(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(orders)').all().map((r) => r.name);
    if (!cols.includes('to_district')) {
      db.exec('ALTER TABLE orders ADD COLUMN to_district TEXT');
      console.log('[orders-query] ✅ 已新增 orders.to_district 列');
    }
  } catch (e) {
    console.error('[orders-query] to_district 加列失败（不影响查询）:', e.message);
  }
}

// ---------- 快递单号解析 ----------
// 返回 { list: [...] } 或 { like: 'xxx' } 或 null
function parseOrderNos(q) {
  const raw = String(q || '').trim();
  if (!raw) return null;
  const list = raw.split(/[,，、\s\n;；]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return { like: list[0] };   // 单个 → LIKE 模糊
  return { list };                                    // 多个 → 精确 IN
}

// ---------- WHERE 构建（查询/导出/计数共用同一份逻辑，保证口径一致） ----------
function buildWhere(filters, scope) {
  const where = [];
  const params = [];
  const { q, province, city, district, platform, start, end } = filters;

  // 行级权限（ownerScope）
  if (scope && scope.sql) {
    where.push(scope.sql);
    params.push(...scope.params);
  }

  // ★ 核心规则：单号优先，单号存在时忽略日期
  const nos = parseOrderNos(q);
  if (nos) {
    if (nos.list) {
      where.push(`o.order_no IN (${nos.list.map(() => '?').join(',')})`);
      params.push(...nos.list);
    } else {
      where.push('o.order_no LIKE ?');
      params.push(`%${nos.like}%`);
    }
  } else {
    if (start) { where.push('o.order_date >= ?'); params.push(start); }
    if (end)   { where.push('o.order_date <= ?'); params.push(end); }
  }

  // 省/市/区县（三级级联：上级为空时下级条件仍然独立生效，避免组合死锁）
  if (province) { where.push('o.to_province = ?'); params.push(province); }
  if (city)     { where.push('o.to_city = ?');     params.push(city); }
  if (district) { where.push('o.to_district = ?'); params.push(district); }

  // 平台（'全部' 视为不过滤，与地区看板口径一致）
  if (platform && platform !== '全部') { where.push('o.wms_platform = ?'); params.push(platform); }

  return { where: where.join(' AND '), params };
}

const SELECT_COLS = `
  o.order_id, o.order_no, o.wms_platform, o.owner_name,
  o.ship_quantity, o.unit, o.order_date, o.payment_status,
  o.to_province, o.to_city, o.to_district, o.region_class,
  c.company_name AS customer_name
`;

// ---------- 分页查询 ----------
function queryPage(db, filters, page, pageSize, scope) {
  ensureDistrictColumn(db);
  const { where, params } = buildWhere(filters, scope);
  const w = where ? 'WHERE ' + where : '';
  const total = db.prepare(
    `SELECT COUNT(*) c FROM orders o LEFT JOIN customers c ON c.customer_id=o.customer_id ${w}`
  ).get(...params).c;
  const rows = db.prepare(`
    SELECT ${SELECT_COLS}
    FROM orders o LEFT JOIN customers c ON c.customer_id=o.customer_id
    ${w}
    ORDER BY o.order_id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);
  return { data: rows, total, page, pageSize };
}

// ---------- 全量导出（大数据量：单次有上限保护） ----------
function queryAll(db, filters, scope, limit = 100000) {
  ensureDistrictColumn(db);
  const { where, params } = buildWhere(filters, scope);
  const w = where ? 'WHERE ' + where : '';
  return db.prepare(`
    SELECT ${SELECT_COLS}
    FROM orders o LEFT JOIN customers c ON c.customer_id=o.customer_id
    ${w}
    ORDER BY o.order_date DESC, o.order_id DESC
    LIMIT ?
  `).all(...params, limit);
}

// ---------- 级联下拉（省 → 市 → 区县） ----------
function facetProvinces(db) {
  ensureDistrictColumn(db);
  return db.prepare(`
    SELECT DISTINCT to_province AS v FROM orders
    WHERE to_province IS NOT NULL AND to_province != ''
    ORDER BY v
  `).all().map((r) => r.v);
}

function facetCities(db, province) {
  ensureDistrictColumn(db);
  if (!province) return [];
  return db.prepare(`
    SELECT DISTINCT to_city AS v FROM orders
    WHERE to_province = ? AND to_city IS NOT NULL AND to_city != ''
    ORDER BY v
  `).all(province).map((r) => r.v);
}

function facetDistricts(db, province, city) {
  ensureDistrictColumn(db);
  if (!province) return [];
  if (city) {
    return db.prepare(`
      SELECT DISTINCT to_district AS v FROM orders
      WHERE to_province = ? AND to_city = ? AND to_district IS NOT NULL AND to_district != ''
      ORDER BY v
    `).all(province, city).map((r) => r.v);
  }
  return db.prepare(`
    SELECT DISTINCT to_district AS v FROM orders
    WHERE to_province = ? AND to_district IS NOT NULL AND to_district != ''
    ORDER BY v
  `).all(province).map((r) => r.v);
}

module.exports = {
  ensureDistrictColumn,
  parseOrderNos,
  buildWhere,
  queryPage,
  queryAll,
  facetProvinces,
  facetCities,
  facetDistricts,
};
