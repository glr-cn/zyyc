// 工时 service（深度重构）：类型配置 / 计算 / 校验 / 环比
// 维度：warehouse(四大仓) × work_type(发货/收货/库内/后勤)
const round3 = require('../utils/round');

const WAREHOUSES = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];
const WORK_TYPES = ['发货', '收货', '库内', '后勤'];
// 标准单位（新录入/下拉/模板）：单、件、箱
const UNITS = ['单', '件', '箱'];
// 历史兼容单位：旧数据可能为「托/公斤」，仅校验放行以不破坏历史编辑，不进新下拉
const LEGACY_UNITS = ['托', '公斤'];
const PROJECT_OPTIONS = {
  库内: ['上架', '补货', '调拨', '退件', '盘点', '理货', '油叉', '转运', '卫生', '顶班'],
  后勤: ['制单人员', '管理人员', '其他'],
};

// 工时类型中文 → 内部 key
const TYPE_KEY = { 发货: 'shipment', 收货: 'receiving', 库内: 'internal', 后勤: 'support' };
const KEY_LABEL = { shipment: '发货工时', receiving: '收货工时', internal: '库内工时', support: '后勤工时' };

// 每类工时的字段 / 列 / 计算 / 环比键（配置驱动）
const TYPE_CONFIG = {
  shipment: {
    label: '发货工时',
    fields: ['customer_name', 'unit', 'date', 'ship_orders', 'main_hours', 'other_hours', 'shared_hours', 'remark'],
    columns: ['date', 'customer_name', 'unit', 'ship_orders', 'main_hours', 'efficiency', 'other_hours', 'shared_hours', 'total_hours', 'remark', 'unit_cost'],
    trendKeys: ['ship_orders', 'main_hours', 'efficiency'],
    calc: (r) => {
      r.total_hours = round3(Number(r.main_hours) + Number(r.other_hours) + Number(r.shared_hours));
      r.efficiency = Number(r.main_hours) ? round3(Number(r.ship_orders) / Number(r.main_hours)) : 0;
      r.unit_cost = Number(r.ship_orders) ? round3(r.total_hours / Number(r.ship_orders)) : 0;
    },
  },
  receiving: {
    label: '收货工时',
    fields: ['customer_name', 'unit', 'date', 'cartons', 'tons', 'cubic', 'pallets', 'main_hours', 'other_hours', 'remark'],
    columns: ['date', 'customer_name', 'unit', 'cartons', 'efficiency', 'tons', 'cubic', 'pallets', 'main_hours', 'other_hours', 'remark', 'doc_cost'],
    trendKeys: [],
    calc: (r) => {
      r.total_hours = round3(Number(r.main_hours) + Number(r.other_hours) + Number(r.shared_hours));
      r.efficiency = Number(r.main_hours) ? round3(Number(r.cartons) / Number(r.main_hours)) : 0;
      r.doc_cost = Number(r.cartons) ? round3(r.total_hours / Number(r.cartons)) : 0;
    },
  },
  internal: {
    label: '库内工时',
    fields: ['project', 'date', 'unit', 'workload', 'main_hours', 'other_hours', 'remark'],
    columns: ['date', 'project', 'unit', 'workload', 'main_hours', 'other_hours', 'remark'],
    trendKeys: [],
    calc: (r) => {
      r.total_hours = round3(Number(r.main_hours) + Number(r.other_hours) + Number(r.shared_hours));
    },
  },
  support: {
    label: '后勤工时',
    fields: ['project', 'date', 'main_hours', 'other_hours', 'remark'],
    columns: ['date', 'project', 'main_hours', 'other_hours', 'remark', 'total_hours'],
    trendKeys: [],
    calc: (r) => {
      r.total_hours = round3(Number(r.main_hours) + Number(r.other_hours) + Number(r.shared_hours));
    },
  },
};

function workTypeKey(name) { return TYPE_KEY[name]; }
function configOf(name) { return TYPE_CONFIG[TYPE_KEY[name]]; }

// 计算派生字段（统一 round3 入库/返回），返回同一对象
function calcRow(name, raw) {
  const cfg = configOf(name);
  raw.main_hours = round3(raw.main_hours);
  raw.other_hours = round3(raw.other_hours);
  raw.shared_hours = round3(raw.shared_hours);
  cfg.calc(raw);
  return raw;
}

// 客户关联解析：优先按 customer_id，其次按 customer_name（兼容历史纯文本/旧客户端）。
// 返回 { customer_id, customer_name, status } 或 null。仅发货/收货使用。
// opts.includeDeleted=true：编辑历史工时保留已删除客户关联时使用（新增一律 exclude）。
function resolveCustomer(db, b, opts = {}) {
  if (!db) return null;
  let row = null;
  if (b.customer_id != null && b.customer_id !== '') {
    row = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(b.customer_id);
    if (row) return {
      customer_id: row.customer_id,
      customer_name: row.short_name || row.company_name, // 下拉显示名=简称优先，与 /options 的 owner_name 一致
      warehouse: row.warehouse || '',
      status: row.is_deleted === 1 ? '已删除' : (row.coop_status !== '合作中' ? '停用' : '启用'),
    };
  }
  if (b.customer_name) {
    row = db.prepare(
      'SELECT * FROM customers WHERE (company_name=? OR short_name=?)' + (opts.includeDeleted ? '' : ' AND is_deleted=0')
    ).get(b.customer_name, b.customer_name);
    if (row) return {
      customer_id: row.customer_id,
      customer_name: b.customer_name,
      warehouse: row.warehouse || '',
      status: row.is_deleted === 1 ? '已删除' : (row.coop_status !== '合作中' ? '停用' : '启用'),
    };
  }
  return null;
}

// 客户归属仓校验：customers.warehouse 为多仓逗号串（如「龙湖仓,佳新仓」），
// 必须包含目标仓才允许录入，杜绝把 A 仓货主的工时写进 B 仓。
// 历史客户 warehouse 为空时无法判定归属，放行以免旧数据不可编辑。
function customerBelongs(cust, warehouse) {
  if (!cust) return false;
  const list = String(cust.warehouse || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  return list.includes(warehouse);
}

// 校验：返回 errorMessage 字符串，或 null 表示通过。db 用于客户名关联校验。
// opts.allowInactiveCust=true：编辑历史工时且客户未变更时，允许保留已删除/停用客户关联。
function validateByType(name, b, db, opts = {}) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!b.warehouse || !WAREHOUSES.includes(b.warehouse)) return '仓库非法（应为 龙湖仓/佳新仓/速远仓/开元仓）';
  if (!WORK_TYPES.includes(name)) return '工时类型非法';
  if (!b.date || !DATE_RE.test(b.date)) return '日期格式应为 YYYY-MM-DD';

  const m = b.main_hours != null ? Number(b.main_hours) : 0;
  const o = b.other_hours != null ? Number(b.other_hours) : 0;
  const s = b.shared_hours != null ? Number(b.shared_hours) : 0;
  if ([m, o, s].some((x) => isNaN(x))) return '工时必须为数字';
  if (m < 0 || o < 0 || s < 0) return '三类工时均不得为负';

  if (b.unit && !UNITS.includes(b.unit) && !LEGACY_UNITS.includes(b.unit)) return '单位非法（应为 单/件/箱）';

  if (name === '发货') {
    if (!b.customer_name && (b.customer_id == null || b.customer_id === '')) return '客户名称必填';
    const cust = resolveCustomer(db, b);
    if (!cust) return '客户名称在客户表中不存在（强制关联）';
    if (!opts.allowInactiveCust && (cust.status === '已删除' || cust.status === '停用'))
      return '不能选择「' + cust.status + '」客户录入新工时';
    if (!opts.allowInactiveCust && !customerBelongs(cust, b.warehouse))
      return '客户「' + cust.customer_name + '」不属于' + b.warehouse + '，禁止跨仓录入';
    // 放宽校验：ship_orders / main_hours / remark 三者任意有值即允许保存（支持"无单量仅备注"场景）；
    // 只有三者全空/全0 才算脏数据并拦截。
    const ship = Number(b.ship_orders) || 0;
    const mh = Number(b.main_hours) || 0;
    const rk = (b.remark || '').trim();
    if (!(ship > 0) && !(mh > 0) && !rk) return '发货单量、主工时、备注至少填写一项';
  } else if (name === '收货') {
    if (!b.customer_name && (b.customer_id == null || b.customer_id === '')) return '客户名称必填';
    const cust = resolveCustomer(db, b);
    if (!cust) return '客户名称在客户表中不存在（强制关联）';
    if (!opts.allowInactiveCust && (cust.status === '已删除' || cust.status === '停用'))
      return '不能选择「' + cust.status + '」客户录入新工时';
    if (!opts.allowInactiveCust && !customerBelongs(cust, b.warehouse))
      return '客户「' + cust.customer_name + '」不属于' + b.warehouse + '，禁止跨仓录入';
    if (Number(b.cartons) < 0 || Number(b.tons) < 0 || Number(b.cubic) < 0 || Number(b.pallets) < 0)
      return '箱数/吨/方/托盘不得为负';
  } else if (name === '库内') {
    if (!b.project || !PROJECT_OPTIONS['库内'].includes(b.project)) return '项目非法（库内下拉项）';
    // 作业量：可空；填了就必须是不小于 0 的数字
    if (b.workload != null && b.workload !== '') {
      const wl = Number(b.workload);
      if (!Number.isFinite(wl) || wl < 0) return '作业量必须为不小于 0 的数字';
    }
  } else if (name === '后勤') {
    if (!b.project || !PROJECT_OPTIONS['后勤'].includes(b.project)) return '项目非法（后勤下拉项）';
  }
  return null;
}

// ---------- 环比（仅发货类型）：同 warehouse+客户 的上期同维度对比 ----------
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function weekMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow);
  return ymd(d);
}
// 返回上一周期闭区间 [start, end]
function prevRange(mode, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (mode === 'month') {
    const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const last = new Date(d.getFullYear(), d.getMonth(), 0);
    return { start: ymd(new Date(m.getFullYear(), m.getMonth(), 1)), end: ymd(last) };
  }
  if (mode === 'week') {
    const mon = new Date(weekMonday(dateStr));
    const prevMon = new Date(mon); prevMon.setDate(mon.getDate() - 7);
    const prevSun = new Date(mon); prevSun.setDate(mon.getDate() - 1);
    return { start: ymd(prevMon), end: ymd(prevSun) };
  }
  // day
  const prev = new Date(d); prev.setDate(d.getDate() - 1);
  return { start: ymd(prev), end: ymd(prev) };
}
function trendObj(cur, prev) {
  if (prev == null || prev === 0) return { cur: round3(cur), prev: 0, deltaPct: null, dir: 'flat' };
  const deltaPct = round3(((cur - prev) / prev) * 100);
  const dir = deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat';
  return { cur: round3(cur), prev: round3(prev), deltaPct, dir };
}
// 为发货类型明细行附加 trend（ship_orders/main_hours/efficiency 三列环比）
// 环比键优先用 customer_id（稳定、不受客户改名/简称-全称差异影响），
// 历史纯文本行无 id 时回退 customer_name（兼容旧数据）。
function attachTrend(rows, mode, db) {
  rows.forEach((r) => {
    const range = prevRange(mode, r.date);
    const byId = r.customer_id != null;
    const prev = db
      .prepare(
        `SELECT COALESCE(SUM(ship_orders),0) s, COALESCE(SUM(main_hours),0) m
         FROM work_hours WHERE warehouse=? AND work_type='发货' AND ${byId ? 'customer_id=?' : 'customer_name=?'} AND date>=? AND date<=?`
      )
      .get(r.warehouse, byId ? r.customer_id : r.customer_name, range.start, range.end);
    const prevEff = prev.m > 0 ? prev.s / prev.m : 0;
    r.trend = {
      ship_orders: trendObj(r.ship_orders, prev.s),
      main_hours: trendObj(r.main_hours, prev.m),
      efficiency: trendObj(r.efficiency, prevEff),
    };
  });
  return rows;
}

// ---------- 缺口（未填报货主）判定口径 ----------
// 背景（2026-11-20 修复）：缺口行的「判定日期」与「展示日期」此前不一致——
//   判定按用户筛选期（如按日 2026-11-20），展示却固定为「昨天」（2026-11-19）。
//   于是 11-19 已归档的数据仍在未归档列表以 11-19 日期出现，用户误以为导入被归到未归档。
// 统一口径：缺口行展示哪一天，就用哪一天判定是否已填。
//   单日筛选（dateFrom === dateTo）→ 判定/展示都用该日；need_backfill = 该日早于今天
//   多日范围 → 沿用「昨天」作为补报建议日；need_backfill = 昨天落在范围内
function resolveGapScope(dateFrom, dateTo, todayStr) {
  const today = todayStr || ymd(new Date());
  const yst = new Date(today + 'T00:00:00');
  yst.setDate(yst.getDate() - 1);
  const yesterday = ymd(yst);

  if (dateFrom && dateTo && dateFrom === dateTo) {
    return { date: dateFrom, need_backfill: dateFrom < today };
  }
  const inRange = (!dateFrom || yesterday >= dateFrom) && (!dateTo || yesterday <= dateTo);
  return { date: yesterday, need_backfill: inRange };
}

// ---------- 导入重复判定（预览 / 导入共用同一实现） ----------
// 数值字段统一转 Number 比较：Excel 里 161 与库内 161.0、'161' 必须视为一致，
// 否则会被误判为「有差异」而触发覆盖写（无谓删除+重插，且审计噪音）。
function parseNum(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function isSameHoursRow(a, b) {
  const eqText = (x, y) => String(x ?? '').trim() === String(y ?? '').trim();
  return parseNum(a.ship_orders) === parseNum(b.ship_orders)
    && eqText(a.unit, b.unit)
    && parseNum(a.main_hours) === parseNum(b.main_hours)
    && parseNum(a.other_hours) === parseNum(b.other_hours)
    && eqText(a.remark ?? '', b.remark ?? '');
}

module.exports = {
  WAREHOUSES, WORK_TYPES, UNITS, LEGACY_UNITS, PROJECT_OPTIONS,
  TYPE_CONFIG, TYPE_KEY, KEY_LABEL, workTypeKey, configOf,
  calcRow, validateByType, attachTrend, resolveCustomer,
  resolveGapScope, parseNum, isSameHoursRow,
};
