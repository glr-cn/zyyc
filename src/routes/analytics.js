// 分析路由（深度重构：适配 warehouse × work_type × customer_name 新维度）
// /api/analytics/summary：按日/周/月汇总，公摊按桶内(main+other)占比分摊
// /api/analytics/dashboard：⚠️ 已废弃（2026-11-17 看板重构 v2 替代为 /api/dashboard/summary）。
//   仅保留供测试脚本(test_wh/test_pages/test_rbac/test_prepublish)调用，前端不请求此接口。
//   后续清理：全部测试迁到新接口后删除此路由。
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { ownerScope, menuGate } = require('../middleware/rbac');
const round3 = require('../utils/round');
const svc = require('../services/workhours');

router.use(auth);

// 取工时原始数据（行级隔离 + 可选 warehouse/work_type/日期筛选）
function fetchRows(req) {
  const q = [];
  const p = [];
  const scope = ownerScope(req);
  if (scope.sql) { q.push(scope.sql); p.push(...scope.params); }
  const warehouse = (req.query.warehouse || '').trim();
  if (warehouse) { q.push('warehouse = ?'); p.push(warehouse); }
  const workType = (req.query.work_type || '').trim();
  if (workType) { q.push('work_type = ?'); p.push(workType); }
  const from = (req.query.from || '').trim();
  if (from) { q.push('date >= ?'); p.push(from); }
  const to = (req.query.to || '').trim();
  if (to) { q.push('date <= ?'); p.push(to); }
  const w = q.length ? 'WHERE ' + q.join(' AND ') : '';
  return db
    .prepare(
      `SELECT warehouse,work_type,customer_name,ship_orders,cartons,main_hours,other_hours,shared_hours,date
       FROM work_hours ${w}`
    )
    .all(...p);
}

// 周期分桶：日=日期；月=YYYY-MM；周=当周周一(YYYY-MM-DD)
function bucket(mode, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (mode === 'month') return dateStr.slice(0, 7);
  if (mode === 'week') {
    const dow = (d.getDay() + 6) % 7;
    const mon = new Date(d);
    mon.setDate(d.getDate() - dow);
    return ymd(mon);
  }
  return dateStr;
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 派生指标：total / efficiency / unit_cost / doc_cost（按 work_type）
function metrics(workType, agg) {
  const total = round3(agg.main + agg.other + agg.shared);
  const out = { total };
  if (workType === '发货') {
    out.efficiency = agg.main ? round3(agg.ship / agg.main) : 0;
    out.unit_cost = agg.ship > 0 ? round3(total / agg.ship) : 0;
  } else if (workType === '收货') {
    out.efficiency = agg.main ? round3(agg.cartons / agg.main) : 0;
    out.doc_cost = agg.cartons > 0 ? round3(total / agg.cartons) : 0;
  }
  return out;
}

// 在“一个(周期,仓库,类型)桶”内按各客户(main+other)占比分摊公摊
function allocateBucket(list) {
  const totalDirect = list.reduce((s, o) => s + o.main + o.other, 0);
  const pool = list.reduce((s, o) => s + o.shared, 0);
  const single = list.length === 1;
  list.forEach((o) => {
    const direct = o.main + o.other;
    const alloc = single ? pool : totalDirect > 0 ? round3((pool * direct) / totalDirect) : 0;
    o.shared_alloc = round3(alloc);
    o.agg = { main: o.main, other: o.other, shared: o.shared_alloc, ship: o.ship, cartons: o.cartons };
    const m = metrics(o.work_type, o.agg);
    o.total = m.total;
    o.efficiency = m.efficiency || 0;
    o.unit_cost = m.unit_cost != null ? m.unit_cost : null;
    o.doc_cost = m.doc_cost != null ? m.doc_cost : null;
  });
  return list;
}

// 阶段 4：按日/周/月汇总（RBAC：需「工时汇总」菜单授权）
router.get('/summary', menuGate('analytics'), (req, res) => {
  const mode = ['day', 'week', 'month'].includes(req.query.mode) ? req.query.mode : 'day';
  const rows = fetchRows(req);
  // key: period | warehouse | work_type | customer_name
  const map = new Map();
  rows.forEach((r) => {
    const p = bucket(mode, r.date);
    const k = [p, r.warehouse, r.work_type, r.customer_name || '—'].join('|');
    if (!map.has(k)) map.set(k, { period: p, warehouse: r.warehouse, work_type: r.work_type, customer_name: r.customer_name || '—', main: 0, other: 0, shared: 0, ship: 0, cartons: 0 });
    const o = map.get(k);
    o.main += Number(r.main_hours);
    o.other += Number(r.other_hours);
    o.shared += Number(r.shared_hours);
    o.ship += Number(r.ship_orders) || 0;
    o.cartons += Number(r.cartons) || 0;
  });

  // 按 (period, warehouse, work_type) 分摊公摊
  const bucketMap = new Map();
  for (const o of map.values()) {
    const bk = [o.period, o.warehouse, o.work_type].join('|');
    if (!bucketMap.has(bk)) bucketMap.set(bk, []);
    bucketMap.get(bk).push(o);
  }
  const table = [];
  const periods = [];
  for (const [bk, list] of bucketMap.entries()) {
    const [period, warehouse, work_type] = bk.split('|');
    allocateBucket(list);
    const main = round3(list.reduce((s, o) => s + o.main, 0));
    const other = round3(list.reduce((s, o) => s + o.other, 0));
    const shared = round3(list.reduce((s, o) => s + o.shared_alloc, 0));
    const valid = round3(main + other + shared);
    const ship = round3(list.reduce((s, o) => s + o.ship, 0));
    const unit_cost_overall = ship > 0 ? round3(valid / ship) : 0;
    periods.push({ period, warehouse, work_type, main, other, shared, valid, ship, unit_cost_overall });
    list
      .map((o) => ({
        period, warehouse, work_type, customer_name: o.customer_name,
        ship_qty: round3(o.ship), cartons: round3(o.cartons),
        main: round3(o.main), other: round3(o.other),
        shared: o.shared_alloc, total: o.total,
        efficiency: o.efficiency, unit_cost: o.unit_cost, doc_cost: o.doc_cost,
      }))
      .sort((a, b) => (a.customer_name < b.customer_name ? -1 : 1))
      .forEach((x) => table.push(x));
  }
  periods.sort((a, b) => (a.period < b.period ? -1 : 1));
  table.sort((a, b) => (a.period < b.period ? -1 : a.customer_name < b.customer_name ? -1 : 1));

  // 图表：有发货数据 → 单均成本趋势；否则总有效工时趋势
  const hasShip = table.some((t) => t.ship_qty > 0);
  const chart1 = {
    type: hasShip ? 'unit_cost' : 'total_hours',
    labels: periods.map((p) => p.period),
    values: periods.map((p) => (hasShip ? p.unit_cost_overall : p.valid)),
  };
  const chart2 = {
    labels: periods.map((p) => p.period),
    main: periods.map((p) => p.main),
    other: periods.map((p) => p.other),
    shared: periods.map((p) => p.shared),
  };
  res.json({ mode, table, periods, chart1, chart2 });
});

// ⚠️ 已废弃看板接口 —— 2026-11-17 看板重构 v2 新接口为 GET /api/dashboard/summary
//   前端 dashboard.js 已切换到新接口；本路由仅保留供旧测试脚本(test_wh/test_rbac/test_prepublish/test_pages)调用，
//   数据口径仍基于 work_hours archived，但缺少公摊分摊/四分组分区/Day-Week-Month 灵活筛选等新能力。
function monthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: ymd(start), to: ymd(end) };
}
// 经营看板数据源（RBAC：需「工时汇总」菜单授权；与「工时汇总」分开控制）
// ★ 修复 S5：原 menuGate('dashboard') 的 path 是主菜单容器、不在 role_menus 授权内，
//   改为可授权的子菜单 dash_wh_summary（工时汇总），保持旧测试脚本可访问。
router.get('/dashboard', menuGate('dash_wh_summary'), (req, res) => {
  const { from, to } = monthRange();
  const rows = fetchRows(req);
  const inMonth = rows.filter((r) => r.date >= from && r.date <= to);
  // 仅发货类参与单均成本口径
  const shipRows = inMonth.filter((r) => r.work_type === '发货');
  const list = shipRows.map((r) => ({ main: Number(r.main_hours), other: Number(r.other_hours), shared: Number(r.shared_hours), ship: Number(r.ship_orders) || 0, customer_name: r.customer_name || '—' }));
  const totalValid = round3(list.reduce((s, o) => s + o.main + o.other + o.shared, 0));
  const totalShip = round3(list.reduce((s, o) => s + o.ship, 0));
  const totalShared = round3(list.reduce((s, o) => s + o.shared, 0));
  const avgUnitCost = totalShip > 0 ? round3(totalValid / totalShip) : 0;
  const sharedRatio = totalValid > 0 ? round3(totalShared / totalValid) : 0;

  // 本月发货量（来自 orders，按角色隔离）
  const oscope = ownerScope(req);
  const ow = oscope.sql ? 'AND ' + oscope.sql : '';
  const shipRes = db
    .prepare(`SELECT COALESCE(SUM(ship_quantity),0) c FROM orders WHERE order_date >= ? AND order_date <= ? ${ow}`)
    .get(from, to, ...oscope.params);
  const monthShip = round3(shipRes.c);

  // 客户单均成本排名：升序，取最低前三与最高后三
  const byCust = new Map();
  list.forEach((o) => {
    const k = o.customer_name;
    if (!byCust.has(k)) byCust.set(k, { ship: 0, valid: 0 });
    const c = byCust.get(k);
    c.ship += o.ship; c.valid += o.main + o.other + o.shared;
  });
  const ranked = [...byCust.entries()]
    .map(([customer_name, c]) => ({ customer_name, ship_qty: round3(c.ship), unit_cost: c.ship > 0 ? round3(c.valid / c.ship) : 0 }))
    .sort((a, b) => a.unit_cost - b.unit_cost);
  const top3 = ranked.slice(0, 3);
  const bottom3 = ranked.slice(-3).reverse();

  res.json({
    month: from.slice(0, 7),
    month_ship_qty: monthShip,
    avg_unit_cost: avgUnitCost,
    shared_ratio: sharedRatio,
    owner_rank: { top3, bottom3 },
  });
});

module.exports = router;
