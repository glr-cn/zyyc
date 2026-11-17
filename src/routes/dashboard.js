// 经营看板 · 统一聚合接口
// GET /api/dashboard/summary?warehouse=xxx&startDate=xxx&endDate=xxx&periodType=day|week|month
// 只统计 status='archived' 的归档数据。
// 返回 { periodLabel, prevPeriodLabel, shippingList, receivingList, internalList, logisticsList }

const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { ownerScope } = require('../middleware/rbac');
const round3 = require('../utils/round');

router.use(auth);

// ========== 常量 ==========
const RATE_MANAGER = 60;   // 后勤"管理人员" → 60元/小时
const RATE_NORMAL  = 17;   // 发货/收货/库内 + 后勤的"制单人员"/"其他" → 17元/小时

function calcRate(workType, project) {
  if (workType === '后勤' && project === '管理人员') return RATE_MANAGER;
  return RATE_NORMAL;
}

// ========== 周期计算 ==========
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 根据 startDate / endDate / periodType 推导本期和上期。
 * periodType 为 day/week/month；当 periodType 与实际 start~end 跨度不一致时，
 * 以传入的 startDate/endDate 作为本期边界（允许自定义区间），
 * 然后按「同跨度」向前平移得到上期。
 */
function computePeriods(startDate, endDate, periodType) {
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate + 'T00:00:00');

  // 优先按 periodType 推导（用户显式选择日/周/月）
  if (periodType === 'day') {
    const prevStart = new Date(s); prevStart.setDate(s.getDate() - 1);
    const prevEnd = new Date(s);
    return {
      cur: { start: ymd(s), end: ymd(e), label: ymd(s) },
      prev: { start: ymd(prevStart), end: ymd(prevEnd), label: ymd(prevStart) },
    };
  }
  if (periodType === 'week') {
    // 以传入 startDate 所在周的周一为起点
    const dayOffset = (s.getDay() + 6) % 7;
    const curMon = new Date(s); curMon.setDate(s.getDate() - dayOffset);
    const curSun = new Date(curMon); curSun.setDate(curMon.getDate() + 6);
    const prevMon = new Date(curMon); prevMon.setDate(curMon.getDate() - 7);
    const prevSun = new Date(curSun); prevSun.setDate(curSun.getDate() - 7);
    return {
      cur: { start: ymd(curMon), end: ymd(curSun), label: `${ymd(curMon)} ~ ${ymd(curSun)}` },
      prev: { start: ymd(prevMon), end: ymd(prevSun), label: `${ymd(prevMon)} ~ ${ymd(prevSun)}` },
    };
  }
  if (periodType === 'month') {
    const curFirst = new Date(s.getFullYear(), s.getMonth(), 1);
    const curLast  = new Date(s.getFullYear(), s.getMonth() + 1, 0);
    const prevFirst = new Date(s.getFullYear(), s.getMonth() - 1, 1);
    const prevLast  = new Date(s.getFullYear(), s.getMonth(), 0);
    return {
      cur: { start: ymd(curFirst), end: ymd(curLast), label: ymd(curFirst).slice(0, 7) },
      prev: { start: ymd(prevFirst), end: ymd(prevLast), label: ymd(prevFirst).slice(0, 7) },
    };
  }

  // fallback：按日期差平移
  const diffDays = Math.max(1, Math.round((e - s) / 86400000));
  const prevStart = new Date(s); prevStart.setDate(s.getDate() - diffDays);
  const prevEnd = new Date(e); prevEnd.setDate(e.getDate() - diffDays);
  return {
    cur: { start: ymd(s), end: ymd(e), label: `${ymd(s)} ~ ${ymd(e)}` },
    prev: { start: ymd(prevStart), end: ymd(prevEnd), label: `${ymd(prevStart)} ~ ${ymd(prevEnd)}` },
  };
}

// ========== 环比 ==========
/** prev 为 0 或 null 时返回 null（前端渲染为 "-"） */
function wow(cur, prev) {
  if (prev == null || Number(prev) === 0) return null;
  if (cur == null) cur = 0;
  return round3(((cur - prev) / prev) * 100);
}

// ========== 库内"核心数量"选取规则 ==========
// 优先 cartons → 再 pallets → 再 tons。绝不混加。
function coreQty(row) {
  if (row.cartons != null && Number(row.cartons) > 0) return Number(row.cartons);
  if (row.pallets != null && Number(row.pallets) > 0) return Number(row.pallets);
  if (row.tons != null && Number(row.tons) > 0)       return Number(row.tons);
  return 0;
}

// ========== 查询归档工时原始行 ==========
// scope: ownerScope 参数；warehouse：仓库；workType：可选；start~end：日期闭区间
function fetchArchivedRows({ req, warehouse, workType, startDate, endDate }) {
  const scope = ownerScope(req);
  const clauses = ["status = 'archived'"];
  const params = [];
  if (scope.sql)   { clauses.push(scope.sql);   params.push(...scope.params); }
  if (warehouse)   { clauses.push('warehouse = ?'); params.push(warehouse); }
  if (workType)    { clauses.push('work_type = ?'); params.push(workType); }
  clauses.push('date >= ?'); params.push(startDate);
  clauses.push('date <= ?'); params.push(endDate);
  const sql = `SELECT warehouse, work_type, customer_id, customer_name, project,
                      unit, ship_orders, cartons, tons, cubic, pallets,
                      main_hours, other_hours, shared_hours, date
               FROM work_hours WHERE ${clauses.join(' AND ')}`;
  return db.prepare(sql).all(...params);
}

// ========== 聚合：按 (customer_id, customer_name) ==========
function aggregateByCustomer(rows) {
  const map = new Map();
  for (const r of rows) {
    const cid = r.customer_id != null ? Number(r.customer_id) : -1;
    const cname = r.customer_name || '';
    const k = `${cid}|${cname}`;
    if (!map.has(k)) {
      map.set(k, {
        customer_id: r.customer_id,
        customer_name: cname,
        main_hours: 0, other_hours: 0, shared_hours: 0,
        ship_orders: 0, cartons: 0,
      });
    }
    const o = map.get(k);
    o.main_hours  += Number(r.main_hours)  || 0;
    o.other_hours += Number(r.other_hours) || 0;
    o.shared_hours+= Number(r.shared_hours)|| 0;
    o.ship_orders += Number(r.ship_orders) || 0;
    o.cartons     += Number(r.cartons)     || 0;
  }
  return [...map.values()];
}

// ========== 聚合：按 project ==========
function aggregateByProject(rows, workType) {
  const map = new Map();
  for (const r of rows) {
    const proj = r.project || '';
    if (!map.has(proj)) {
      map.set(proj, { project: proj, main_hours: 0, other_hours: 0, shared_hours: 0 });
    }
    const o = map.get(proj);
    o.main_hours   += Number(r.main_hours)   || 0;
    o.other_hours  += Number(r.other_hours)  || 0;
    o.shared_hours += Number(r.shared_hours) || 0;
  }
  // 附加 workType / 数量（库内用）
  for (const o of map.values()) o._workType = workType;
  return [...map.values()];
}

// ========== 发货组 ==========
// 主表 = 本仓未删除客户，按 sort_order ASC；每个客户填 0 或匹配到的归档数据
function buildShippingList({ req, warehouse, curStart, curEnd, prevStart, prevEnd }) {
  // 1. 取客户主表（多仓 LIKE 匹配）；customers 表只有 short_name + company_name，
  //    展示名优先 short_name（简称），fallback company_name（公司全称）
  const custRows = db.prepare(
    `SELECT customer_id, COALESCE(NULLIF(short_name,''), company_name) AS customer_name, sort_order
     FROM customers WHERE is_deleted = 0
       AND (warehouse = '' OR warehouse LIKE ?)
     ORDER BY sort_order ASC, COALESCE(NULLIF(short_name,''), company_name) ASC`
  ).all(`%${warehouse}%`);

  // 2. 本期、上期发货归档
  const curRows  = fetchArchivedRows({ req, warehouse, workType: '发货', startDate: curStart,  endDate: curEnd });
  const prevRows = fetchArchivedRows({ req, warehouse, workType: '发货', startDate: prevStart, endDate: prevEnd });
  const curAgg  = aggregateByCustomer(curRows);
  const prevAgg = aggregateByCustomer(prevRows);

  const curMap  = new Map(curAgg.map(o => [`${o.customer_id != null ? o.customer_id : '-'}|${o.customer_name}`, o]));
  const prevMap = new Map(prevAgg.map(o => [`${o.customer_id != null ? o.customer_id : '-'}|${o.customer_name}`, o]));

  // 3. 以客户表为主，左连接
  const out = [];
  for (const c of custRows) {
    const key = `${c.customer_id}|${c.customer_name}`;
    const cur  = curMap.get(key)  || { ship_orders: 0, main_hours: 0, other_hours: 0, shared_hours: 0 };
    const prev = prevMap.get(key) || { ship_orders: 0, main_hours: 0, other_hours: 0, shared_hours: 0 };

    const curMain    = round3(cur.main_hours);
    const curOther   = round3(cur.other_hours);
    const curShared  = round3(cur.shared_hours);
    const curTotal   = round3(curMain + curOther + curShared);
    const curShip    = round3(cur.ship_orders);

    const prevMain   = round3(prev.main_hours);
    const prevShared = round3(prev.shared_hours);
    const prevTotal  = round3(prev.main_hours + prev.other_hours + prev.shared_hours);
    const prevShip   = round3(prev.ship_orders);

    const curEff  = curMain > 0 && curShip > 0 ? round3(curShip / curMain) : 0;
    const prevEff = prevMain > 0 && prevShip > 0 ? round3(prevShip / prevMain) : 0;

    // 单均成本 = 工时成本(元) / 本期单量，工时费率固定 17（发货）
    const COST_RATE = RATE_NORMAL;
    const curCost  = round3(curTotal  * COST_RATE);
    const prevCost = round3(prevTotal * COST_RATE);
    const curUnitCost  = curShip  > 0 ? round3(curCost  / curShip)  : 0;
    const prevUnitCost = prevShip > 0 ? round3(prevCost / prevShip) : 0;

    out.push({
      customer_id: c.customer_id,
      customer_name: c.customer_name,
      sort_order: c.sort_order,
      // 本期
      cur_ship_qty: curShip,
      cur_main_hours: curMain,
      cur_other_hours: curOther,
      cur_shared_hours: curShared,
      cur_total_hours: curTotal,
      cur_cost: curCost,
      cur_efficiency: curEff,
      cur_unit_cost: curUnitCost,
      // 上期
      prev_ship_qty: prevShip,
      prev_main_hours: prevMain,
      prev_shared_hours: prevShared,
      prev_total_hours: prevTotal,
      prev_cost: prevCost,
      prev_efficiency: prevEff,
      prev_unit_cost: prevUnitCost,
      // 环比（null 表示 "-"）
      ship_qty_wow:   wow(curShip, prevShip),
      main_hours_wow: wow(curMain, prevMain),
      efficiency_wow:  wow(curEff, prevEff),
      unit_cost_wow:  wow(curUnitCost, prevUnitCost),
    });
  }
  return out;
}

// ========== 收货组 ==========
function buildReceivingList({ req, warehouse, curStart, curEnd, prevStart, prevEnd }) {
  const curRows  = fetchArchivedRows({ req, warehouse, workType: '收货', startDate: curStart,  endDate: curEnd });
  const prevRows = fetchArchivedRows({ req, warehouse, workType: '收货', startDate: prevStart, endDate: prevEnd });
  const curAgg  = aggregateByCustomer(curRows);
  const prevAgg = aggregateByCustomer(prevRows);

  // 按 (customer_id, customer_name) 合并
  const key = (o) => `${o.customer_id != null ? o.customer_id : '-'}|${o.customer_name}`;
  const merged = new Map();
  for (const o of curAgg)  merged.set(key(o),  { cur: o, prev: null });
  for (const o of prevAgg) {
    const k = key(o);
    if (merged.has(k)) merged.get(k).prev = o;
    else merged.set(k, { cur: null, prev: o });
  }

  const out = [];
  const COST_RATE = RATE_NORMAL;
  for (const { cur, prev } of merged.values()) {
    // 只保留有本期箱数 OR 上期箱数 的客户
    const curCartons  = cur  ? round3(cur.cartons)  : 0;
    const prevCartons = prev ? round3(prev.cartons) : 0;
    if (curCartons === 0 && prevCartons === 0) continue;

    const curMain   = cur  ? round3(cur.main_hours)  : 0;
    const curOther  = cur  ? round3(cur.other_hours) : 0;
    const curShared = cur  ? round3(cur.shared_hours): 0;
    const curTotal  = round3(curMain + curOther + curShared);

    const prevMain   = prev ? round3(prev.main_hours)  : 0;
    const prevShared = prev ? round3(prev.shared_hours): 0;
    const prevTotal  = round3((prev ? prev.main_hours : 0) + (prev ? prev.other_hours : 0) + (prev ? prev.shared_hours : 0));

    const curEff  = curMain  > 0 && curCartons  > 0 ? round3(curCartons  / curMain)  : 0;
    const prevEff = prevMain > 0 && prevCartons > 0 ? round3(prevCartons / prevMain) : 0;

    const curCost  = round3(curTotal  * COST_RATE);
    const prevCost = round3(prevTotal * COST_RATE);
    const curDocCost  = curCartons  > 0 ? round3(curCost  / curCartons)  : 0;
    const prevDocCost = prevCartons > 0 ? round3(prevCost / prevCartons) : 0;

    out.push({
      customer_id:  cur  ? cur.customer_id  : (prev ? prev.customer_id  : null),
      customer_name: cur ? cur.customer_name : (prev ? prev.customer_name : ''),
      cur_cartons: curCartons,
      cur_main_hours: curMain,
      cur_other_hours: curOther,
      cur_shared_hours: curShared,
      cur_total_hours: curTotal,
      cur_cost: curCost,
      cur_efficiency: curEff,
      cur_doc_cost: curDocCost,
      prev_cartons: prevCartons,
      prev_main_hours: prevMain,
      prev_shared_hours: prevShared,
      prev_total_hours: prevTotal,
      prev_cost: prevCost,
      prev_efficiency: prevEff,
      prev_doc_cost: prevDocCost,
      cartons_wow:   wow(curCartons, prevCartons),
      main_hours_wow: wow(curMain, prevMain),
      efficiency_wow:  wow(curEff, prevEff),
      doc_cost_wow:    wow(curDocCost, prevDocCost),
    });
  }
  out.sort((a, b) => (a.customer_name || '').localeCompare(b.customer_name || ''));
  return out;
}

// ========== 库内组 ==========
// 库内行没有单独 cartons 求和列——先按 project 聚合原始行，再对每行取 coreQty(cartons→pallets→tons) 然后求和
function aggregateInternalByProject(rows) {
  const map = new Map();
  for (const r of rows) {
    const proj = r.project || '';
    if (!map.has(proj)) {
      map.set(proj, { project: proj, main_hours: 0, other_hours: 0, shared_hours: 0, qty: 0 });
    }
    const o = map.get(proj);
    o.main_hours   += Number(r.main_hours)   || 0;
    o.other_hours  += Number(r.other_hours)  || 0;
    o.shared_hours += Number(r.shared_hours) || 0;
    // 核心数量：cartons → pallets → tons（绝不变量混加）
    o.qty += coreQty(r);
  }
  return [...map.values()];
}

function buildInternalList({ req, warehouse, curStart, curEnd, prevStart, prevEnd }) {
  const curRows  = fetchArchivedRows({ req, warehouse, workType: '库内', startDate: curStart,  endDate: curEnd });
  const prevRows = fetchArchivedRows({ req, warehouse, workType: '库内', startDate: prevStart, endDate: prevEnd });
  const curAgg  = aggregateInternalByProject(curRows);
  const prevAgg = aggregateInternalByProject(prevRows);

  const merged = new Map();
  for (const o of curAgg)  merged.set(o.project,  { cur: o, prev: null });
  for (const o of prevAgg) {
    if (merged.has(o.project)) merged.get(o.project).prev = o;
    else merged.set(o.project, { cur: null, prev: o });
  }

  const out = [];
  for (const { cur, prev } of merged.values()) {
    const curMain = cur ? round3(cur.main_hours) : 0;
    const curQty  = cur ? round3(cur.qty) : 0;
    const prevMain = prev ? round3(prev.main_hours) : 0;
    const prevQty  = prev ? round3(prev.qty) : 0;

    // 没有数量且上期也没有数量 → 不展示
    if (curQty === 0 && prevQty === 0 && curMain === 0 && prevMain === 0) continue;

    const curOther  = cur  ? round3(cur.other_hours)  : 0;
    const curShared = cur  ? round3(cur.shared_hours) : 0;
    const curTotal  = round3(curMain + curOther + curShared);

    const prevOther  = prev ? round3(prev.other_hours)  : 0;
    const prevShared = prev ? round3(prev.shared_hours) : 0;
    const prevTotal  = round3(prevMain + prevOther + prevShared);

    // 时效：qty>0 才计算；否则 0
    const curEff  = curQty  > 0 && curMain  > 0 ? round3(curQty  / curMain)  : 0;
    const prevEff = prevQty > 0 && prevMain > 0 ? round3(prevQty / prevMain) : 0;

    const COST_RATE = RATE_NORMAL;
    const curCost  = round3(curTotal  * COST_RATE);
    const prevCost = round3(prevTotal * COST_RATE);
    const curUnitCost  = curQty  > 0 ? round3(curCost  / curQty)  : 0;
    const prevUnitCost = prevQty > 0 ? round3(prevCost / prevQty) : 0;

    out.push({
      project: cur ? cur.project : prev.project,
      cur_qty: curQty,
      cur_main_hours: curMain,
      cur_other_hours: curOther,
      cur_shared_hours: curShared,
      cur_total_hours: curTotal,
      cur_cost: curCost,
      cur_efficiency: curEff,
      cur_unit_cost: curUnitCost,
      prev_qty: prevQty,
      prev_main_hours: prevMain,
      prev_efficiency: prevEff,
      qty_wow:       wow(curQty, prevQty),
      main_hours_wow: wow(curMain, prevMain),
      efficiency_wow:  wow(curEff, prevEff),
      unit_cost_wow:  wow(curUnitCost, prevUnitCost),
    });
  }
  out.sort((a, b) => (a.project || '').localeCompare(b.project || ''));
  return out;
}

// ========== 后勤组 ==========
function buildLogisticsList({ req, warehouse, curStart, curEnd, prevStart, prevEnd }) {
  const curRows  = fetchArchivedRows({ req, warehouse, workType: '后勤', startDate: curStart,  endDate: curEnd });
  const prevRows = fetchArchivedRows({ req, warehouse, workType: '后勤', startDate: prevStart, endDate: prevEnd });
  const curAgg  = aggregateByProject(curRows, '后勤');
  const prevAgg = aggregateByProject(prevRows, '后勤');

  const merged = new Map();
  for (const o of curAgg)  merged.set(o.project,  { cur: o, prev: null });
  for (const o of prevAgg) {
    if (merged.has(o.project)) merged.get(o.project).prev = o;
    else merged.set(o.project, { cur: null, prev: o });
  }

  const out = [];
  for (const { cur, prev } of merged.values()) {
    const curTotal  = cur  ? round3(cur.main_hours + cur.other_hours + cur.shared_hours) : 0;
    const prevTotal = prev ? round3(prev.main_hours + prev.other_hours + prev.shared_hours) : 0;
    if (curTotal === 0 && prevTotal === 0) continue;

    const project = cur ? cur.project : prev.project;
    const rate = calcRate('后勤', project);
    const curCost  = round3(curTotal  * rate);
    const prevCost = round3(prevTotal * rate);

    out.push({
      project,
      cost_rate: rate,
      cur_total_hours: curTotal,
      cur_cost: curCost,
      prev_total_hours: prevTotal,
      prev_cost: prevCost,
      total_hours_wow: wow(curTotal, prevTotal),
      cost_wow:         wow(curCost, prevCost),
    });
  }
  out.sort((a, b) => (a.project || '').localeCompare(b.project || ''));
  return out;
}

// ========== 主接口 ==========
router.get('/summary', (req, res) => {
  const warehouse  = (req.query.warehouse || '').trim();
  const periodType = ['day', 'week', 'month'].includes(req.query.periodType) ? req.query.periodType : 'month';
  // startDate / endDate 允许前端传自定义区间；不传则默认本月
  const now = new Date();
  let startDate = (req.query.startDate || '').trim();
  let endDate   = (req.query.endDate   || '').trim();
  if (!startDate || !endDate) {
    if (periodType === 'day') { startDate = endDate = ymd(now); }
    else if (periodType === 'week') {
      const dayOffset = (now.getDay() + 6) % 7;
      const mon = new Date(now); mon.setDate(now.getDate() - dayOffset);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      startDate = ymd(mon); endDate = ymd(sun);
    } else {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      startDate = ymd(first); endDate = ymd(last);
    }
  }

  const { cur, prev } = computePeriods(startDate, endDate, periodType);

  const shipping  = buildShippingList({ req, warehouse, curStart: cur.start,  curEnd: cur.end,  prevStart: prev.start, prevEnd: prev.end });
  const receiving = buildReceivingList({ req, warehouse, curStart: cur.start,  curEnd: cur.end,  prevStart: prev.start, prevEnd: prev.end });
  const internal  = buildInternalList({ req, warehouse, curStart: cur.start,  curEnd: cur.end,  prevStart: prev.start, prevEnd: prev.end });
  const logistics = buildLogisticsList({ req, warehouse, curStart: cur.start,  curEnd: cur.end,  prevStart: prev.start, prevEnd: prev.end });

  res.json({
    warehouse,
    periodType,
    periodLabel: cur.label,
    prevPeriodLabel: prev.label,
    curRange:  { start: cur.start,  end: cur.end },
    prevRange: { start: prev.start, end: prev.end },
    shippingList: shipping,
    receivingList: receiving,
    internalList: internal,
    logisticsList: logistics,
  });
});

module.exports = router;
