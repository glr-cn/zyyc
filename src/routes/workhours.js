// 工时管理路由（深度重构：四大仓库 × 四类工时）
// 功能：列表(强制 warehouse+work_type 过滤 + 搜索 + 日期范围 + 分页20 + 日期倒序；发货附环比)
//       新增 / 查看 / 编辑 / 删除；按 work_type 动态校验与计算；审计
const express = require('express');
const router = express.Router();
const db = require('../db');
const xlsx = require('xlsx');
const multer = require('multer');
const { auth } = require('../middleware/auth');
const { ownerScope, readonlyGate, ensureOwn, hasMenuPerm } = require('../middleware/rbac');
const svc = require('../services/workhours');
const { parseDate } = require('../utils/excel');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 发货工时导入模板表头（唯一维护点：模板生成与导入解析共用）
const IMPORT_HEADER = ['日期', '客户名称', '单位', '发货单量', '主工时', '其他工时', '备注'];
function cell(row, ...names) {
  for (const n of names) {
    if (Object.prototype.hasOwnProperty.call(row, n)) return row[n];
  }
  return undefined;
}

router.use(auth); // 本模块全部接口需登录
router.use(readonlyGate); // 查看者仅可查看，禁止写

// RBAC 菜单门禁：一个后端模块服务四个仓库页面，按 warehouse 精确映射到
// wh_lh / wh_jx / wh_sy / wh_ky（带 :id 的路由回查行内仓库），逐仓授权
const WH_PATH = { 龙湖仓: 'wh_lh', 佳新仓: 'wh_jx', 速远仓: 'wh_sy', 开元仓: 'wh_ky' };
router.use((req, res, next) => {
  // 带 id 的路由（/:id 与 /:id/force）：仓库一律以「库内该行所属仓库」为准，
  // 绝不采信请求体/查询串里的 warehouse。否则持有 A 仓菜单权限者可用 body.warehouse=A
  // 通过门禁后改写 B 仓记录、甚至把记录迁到 A 仓（跨仓越权）。
  const m = (req.path || '').match(/^\/(\d+)(?:\/|$)/);
  const rid = (req.params && req.params.id) || (m && m[1]);
  let wh = '';
  if (rid) {
    const row = db.prepare('SELECT warehouse FROM work_hours WHERE work_id=?').get(rid);
    if (!row) return next(); // 行已不存在（如刚被删除）→ 放行给路由返回 404，不在此误判 400
    wh = row.warehouse;
  } else {
    // 无 id 的接口（列表/归档/导入/模板）：按显式参数声明仓库
    wh = (req.query && req.query.warehouse) || (req.body && req.body.warehouse) || '';
  }
  const p = WH_PATH[wh];
  if (!p) return res.status(400).json({ error: '仓库参数非法（龙湖仓/佳新仓/速远仓/开元仓）' });
  if (!hasMenuPerm(req.user, p)) return res.status(403).json({ error: '无该仓库工时菜单权限' });
  next();
});

// 当前登录人展示名（提交人落库口径：display_name 优先，回退 username）
function operatorName(req) {
  const u = (req && req.user) || {};
  return u.display_name || u.username || '未知用户';
}

// 管理员口径（与前端 state.isAdmin 一致）：admin / super_admin
function isAdminUser(req) {
  const u = (req && req.user) || {};
  return u.role_code === 'admin' || u.role_code === 'super_admin';
}

// 本期口径：优先用页面 dateFrom/dateTo；未传则默认当前月（与发货 trend=month 一致）
function resolvePeriod(dateFrom, dateTo) {
  if (dateFrom && dateTo) return { from: dateFrom, to: dateTo };
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
  const last = new Date(y, now.getMonth() + 1, 0).getDate();
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${String(last).padStart(2, '0')}` };
}

// 补报日期识别：缺口行默认显示"今天"；若本期含"昨天"且昨天早于今天，
// 则说明该货主昨天应报未报 → 显示昨天并标记 need_backfill（前端渲染红色 [待补]）。
// 仅在 today 落在 [from,to] 内时启用待补判断，避免查看历史区间时误标。
function resolveBackfillDate(period) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = fmt(new Date());
  if (today < period.from || today > period.to) return { suggest_date: today, need_backfill: false };
  const yst = new Date(); yst.setDate(yst.getDate() - 1);
  const yesterday = fmt(yst);
  if (yesterday >= period.from && yesterday <= period.to) return { suggest_date: yesterday, need_backfill: true };
  return { suggest_date: today, need_backfill: false };
}

// 列表：强制 warehouse + work_type 过滤（防串仓）+ 搜索 + 日期范围 + 分页(20) + 日期倒序
// status：默认 pending（未归档）；archived 已归档；all 全部（归档中心）
// 发货 + pending：追加「本仓未填写货主」缺口行（filled=0），供录入人员一眼看到谁没报。
router.get('/', (req, res) => {
  const warehouse = (req.query.warehouse || '').trim();
  const workType = (req.query.work_type || '').trim();
  if (!warehouse || !workType) {
    return res.status(400).json({ error: '请先选择仓库与工时类型（warehouse / work_type 必填）' });
  }
  const status = ['pending', 'archived', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const q = (req.query.q || '').trim();
  const dateFrom = (req.query.dateFrom || '').trim();
  const dateTo = (req.query.dateTo || '').trim();
  const period = resolvePeriod(dateFrom, dateTo); // 缺口行严格按本期口径联动
  const trend = ['day', 'week', 'month'].includes(req.query.trend) ? req.query.trend : null;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));

  // 列名歧义防护：工时表别名 w，客户表别名 cl；关联客户最新名覆盖快照名，并附客户状态供前端打标签。
  // 客户已被软删除时行仍在 → LEFT JOIN 依然取到名字，历史工时绝不空白/报错。
  const where = ['w.warehouse = ?', 'w.work_type = ?'];
  const params = [warehouse, workType];
  if (status !== 'all') { where.push('w.status = ?'); params.push(status); }
  const scope = ownerScope(req);
  if (scope.sql) { where.push('w.' + scope.sql); params.push(...scope.params); }
  if (q) {
    where.push('(COALESCE(cl.company_name, w.customer_name) LIKE ? OR w.project LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }
  if (dateFrom) { where.push('w.date >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('w.date <= ?'); params.push(dateTo); }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const JOIN = `LEFT JOIN customers cl ON w.customer_id = cl.customer_id`;
  // 客户状态口径与 /customers/options 一致
  const STATUS = `CASE WHEN cl.customer_id IS NULL THEN NULL
                        WHEN cl.is_deleted=1 THEN '已删除'
                        WHEN cl.coop_status<>'合作中' THEN '停用'
                        ELSE '启用' END`;

  // ---- 发货 + pending：货主驱动的全量清单（已填记录 + 本期未填货主缺口行）----
  // 只在发货 tab 的未归档视图启用；其余三个 tab / 归档视图保持原样查询。
  const gapMode = workType === '发货' && status === 'pending';
  if (gapMode) {
    // 货主侧 ownerScope：用 customers.owner_user_id 隔离（与客户资料模块一致）
    const custScope = ownerScope(req);
    // 本仓货主：warehouse LIKE 匹配多仓串；排除已删除（软删 is_deleted=1）与停用货主（仅合作中展示缺口）
    const ownerWhere = ['c.warehouse LIKE ?', 'c.is_deleted=0', "c.coop_status='合作中'"];
    const ownerParams = ['%' + warehouse + '%'];
    const backfill = resolveBackfillDate(period); // 待补日期识别：默认今天，本期含昨天则显示昨天并标待补
    if (custScope.sql) { ownerWhere.push(custScope.sql); ownerParams.push(...custScope.params); }
    if (q) { ownerWhere.push('(COALESCE(NULLIF(c.short_name,\'\'),c.company_name) LIKE ? OR c.company_name LIKE ?)'); const like = `%${q}%`; ownerParams.push(like, like); }
    const ownerWhereSql = ownerWhere.join(' AND ');

    // filled：本期已填的 pending 发货记录（沿用上面的 whereSql，追加本期日期约束）
    const filledWhere = whereSql === 'WHERE ' ? '' : whereSql;
    const CUST_STATUS = `CASE WHEN c.is_deleted=1 THEN '已删除' WHEN c.coop_status<>'合作中' THEN '停用' ELSE '启用' END`;
    // 已填记录口径：仍用 whereSql（含用户显式日期/搜索），但缺口判定统一按 period 本期。
    // 为保证「本期未填」严格联动 dateFrom/dateTo（默认当月），filled 的日期约束以 period 为准。
    const periodWhere = 'w.date >= ? AND w.date <= ?';

    const countSql = `
      SELECT (
        SELECT COUNT(*) FROM work_hours w ${JOIN} ${filledWhere}
      ) + (
        SELECT COUNT(*) FROM customers c
         WHERE ${ownerWhereSql}
           AND NOT EXISTS (
             SELECT 1 FROM work_hours w
              WHERE w.warehouse=? AND w.work_type='发货'
                AND w.customer_id=c.customer_id AND ${periodWhere}
           )
      ) AS c`;
    const total = db.prepare(countSql).get(
      ...params,                       // filled 计数参数
      ...ownerParams,                  // owners 计数参数
      warehouse, period.from, period.to // NOT EXISTS 参数
    ).c;

    const rows = db.prepare(`
      SELECT * FROM (
        SELECT w.work_id, w.warehouse, w.work_type, w.customer_id,
               COALESCE(cl.company_name, w.customer_name) AS customer_name,
               w.unit, w.date, w.ship_orders, w.cartons, w.tons, w.cubic, w.pallets, w.project,
               w.main_hours, w.other_hours, w.shared_hours, w.total_hours,
               w.efficiency, w.unit_cost, w.doc_cost, w.remark, w.owner_user_id,
               w.status, w.submitter, w.submit_time,
               ${STATUS} AS customer_status, 1 AS filled, '' AS suggest_date, 0 AS need_backfill
          FROM work_hours w ${JOIN} ${filledWhere}
        UNION ALL
        SELECT 0 AS work_id, ? AS warehouse, '发货' AS work_type, c.customer_id,
               c.company_name AS customer_name,   -- 与已填行 COALESCE(cl.company_name,...) 口径一致：填前填后名字不变
               '' AS unit, ? AS date, 0 AS ship_orders, 0 AS cartons, 0 AS tons, 0 AS cubic, 0 AS pallets, '' AS project,
               0 AS main_hours, 0 AS other_hours, 0 AS shared_hours, 0 AS total_hours,
               0 AS efficiency, 0 AS unit_cost, 0 AS doc_cost, '' AS remark, c.owner_user_id,
               'pending' AS status, NULL AS submitter, NULL AS submit_time,
               ${CUST_STATUS} AS customer_status, 0 AS filled,
               ? AS suggest_date, ? AS need_backfill
          FROM customers c
         WHERE ${ownerWhereSql}
           AND NOT EXISTS (
             SELECT 1 FROM work_hours w
              WHERE w.warehouse=? AND w.work_type='发货'
                AND w.customer_id=c.customer_id AND ${periodWhere}
           )
      ) t
      ORDER BY filled DESC, date DESC, customer_name
      LIMIT ? OFFSET ?`
    ).all(
      ...params,                       // ① filled 分支 WHERE 参数（SQL 文本中最先出现）
      warehouse,                       // ② UNION ALL 下半部 SELECT 常量 ? AS warehouse
      backfill.suggest_date,           // ③ 缺口行 ? AS date（显示用建议日期）
      backfill.suggest_date,           // ④ 缺口行 ? AS suggest_date
      backfill.need_backfill ? 1 : 0,  // ⑤ 缺口行 ? AS need_backfill
      ...ownerParams,                  // ⑥ owners 分支 WHERE 参数
      warehouse, period.from, period.to, // ⑦ NOT EXISTS 参数
      pageSize, (page - 1) * pageSize  // ⑧ LIMIT / OFFSET
    );

    const filledRows = rows.filter((r) => r.filled === 1);
    const enriched = rows.map((r) => (r.filled === 1 ? svc.calcRow(workType, r) : r));
    if (trend) {
      const enrichedFilled = enriched.filter((r) => r.filled === 1);
      svc.attachTrend(enrichedFilled, trend, db);
    }
    return res.json({ data: enriched, total, page, pageSize, period });
  }

  // ---- 原查询：其余类型 / 归档视图 ----
  const total = db.prepare(`SELECT COUNT(*) c FROM work_hours w ${JOIN} ${whereSql}`).get(...params).c;
  const rows = db
    .prepare(`SELECT w.*,
                     COALESCE(cl.company_name, w.customer_name) AS customer_name,
                     ${STATUS} AS customer_status
                FROM work_hours w ${JOIN} ${whereSql}
               ORDER BY w.date DESC, w.work_id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);

  const enriched = rows.map((r) => svc.calcRow(workType, r));
  if (workType === '发货' && trend) svc.attachTrend(enriched, trend, db);
  res.json({ data: enriched, total, page, pageSize, period });
});

// 归档：将 pending 工时标记为 archived（不物理删除，历史数据零损耗）。
// 支持两种模式：
//   1) { ids: [work_id...] }             —— 勾选行归档（逐条校验归属，防跨仓越权）
//   2) { all: true, work_type, dateFrom, dateTo } —— 归档当前筛选全部（本期口径 + ownerScope）
// 顶层 router 已挂 auth + readonlyGate + 仓库菜单门禁；仓库参数必带。
router.post('/archive', (req, res) => {
  const b = req.body || {};
  const warehouse = (b.warehouse || '').trim();
  const workType = (b.work_type || '').trim();
  if (!warehouse || !workType) return res.status(400).json({ error: '归档需带 warehouse / work_type' });
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isFinite) : [];
  const targetIds = [];

  if (b.all === true) {
    // 批量归档当前筛选：严格按本期口径（dateFrom/dateTo，未传默认当月）+ ownerScope
    const period = resolvePeriod((b.dateFrom || '').trim(), (b.dateTo || '').trim());
    const where = ['warehouse=?', 'work_type=?', "status='pending'", 'date>=?', 'date<=?'];
    const params = [warehouse, workType, period.from, period.to];
    const scope = ownerScope(req);
    if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
    if (b.q && String(b.q).trim()) {
      where.push('(customer_name LIKE ? OR project LIKE ?)');
      const like = '%' + String(b.q).trim() + '%';
      params.push(like, like);
    }
    targetIds.push(...db.prepare(`SELECT work_id FROM work_hours WHERE ${where.join(' AND ')}`).all(...params).map((r) => r.work_id));
  } else {
    if (!ids.length) return res.status(400).json({ error: '请勾选记录或选择归档当前筛选全部' });
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(id);
      if (!row) return res.status(404).json({ error: `工时记录 ${id} 不存在` });
      if (row.warehouse !== warehouse || row.work_type !== workType)
        return res.status(403).json({ error: `记录 ${id} 不属于当前仓库/工时类型，禁止归档` });
      if (!ensureOwn(req, row)) return res.status(403).json({ error: `无权归档他人负责的记录 ${id}` });
      if (row.status !== 'archived') targetIds.push(id);
    }
  }

  if (!targetIds.length) return res.json({ archived: 0, message: '没有需要归档的记录' });

  db.exec('BEGIN');
  try {
    const submitter = operatorName(req);
    const upd = db.prepare(
      "UPDATE work_hours SET status='archived', submitter=?, submit_time=datetime('now','localtime') WHERE work_id=? AND status='pending'"
    );
    let n = 0;
    for (const id of targetIds) n += upd.run(submitter, id).changes;
    db.exec('COMMIT');
    writeAudit(req, 'archive', 0, { scope: b.all ? 'all' : 'ids', ids: targetIds },
      { archived: n, submitter, warehouse, work_type: workType });
    res.json({ archived: n, ids: targetIds, submitter });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    res.status(500).json({ error: '归档失败：' + e.message });
  }
});

// ---------------------------------------------------------------------------
// 单条「提交归档」：pending → archived，写入当前登录人 submitter + 当前时间 submit_time。
// 只改状态字段，绝不物理删除、绝不改动业务数据；审计 action=submit（日志中心显示「提交归档」）。
// 权限：本仓菜单权限（顶层 router 门禁）+ 行级归属（ensureOwn）。
// ---------------------------------------------------------------------------
router.post('/:id/submit', (req, res) => {
  const b = req.body || {};
  const old = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '工时记录不存在' });
  if (!ensureOwn(req, old)) return res.status(403).json({ error: '无权提交他人负责的工时记录' });
  if (b.warehouse && b.warehouse !== old.warehouse) {
    return res.status(403).json({ error: '禁止跨仓提交：该记录属于' + old.warehouse });
  }
  if (old.status === 'archived') return res.status(400).json({ error: '该记录已归档，无需重复提交' });

  const submitter = operatorName(req);
  const info = db.prepare(
    "UPDATE work_hours SET status='archived', submitter=?, submit_time=datetime('now','localtime') WHERE work_id=? AND status='pending'"
  ).run(submitter, old.work_id);
  if (!info.changes) return res.status(409).json({ error: '提交失败：记录状态已变化，请刷新后重试' });

  const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(old.work_id);
  writeAudit(req, 'submit', old.work_id, old, row);
  res.json({ data: svc.calcRow(row.work_type, row) });
});

// ---------------------------------------------------------------------------
// 「撤回」：archived → pending，清空 submitter / submit_time，记录可再次行内编辑。
// 权限（双重校验）：
//   1) 提交人本人（submitter 与当前登录人展示名一致）；
//   2) 或管理员（admin / super_admin）。
// 审计 action=withdraw（日志中心显示「撤回」+ 操作人），可追溯到是谁撤回的。
// ---------------------------------------------------------------------------
router.post('/:id/withdraw', (req, res) => {
  const old = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '工时记录不存在' });
  if (!ensureOwn(req, old)) return res.status(403).json({ error: '无权撤回他人负责的工时记录' });
  if (old.status !== 'archived') return res.status(400).json({ error: '该记录未归档，无需撤回' });

  const me = operatorName(req);
  if (!isAdminUser(req) && String(old.submitter || '') !== me) {
    return res.status(403).json({ error: '仅提交人本人或管理员可撤回该记录' });
  }

  const info = db.prepare(
    "UPDATE work_hours SET status='pending', submitter=NULL, submit_time=NULL WHERE work_id=? AND status='archived'"
  ).run(old.work_id);
  if (!info.changes) return res.status(409).json({ error: '撤回失败：记录状态已变化，请刷新后重试' });

  const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(old.work_id);
  writeAudit(req, 'withdraw', old.work_id, old, row);
  res.json({ data: svc.calcRow(row.work_type, row) });
});

// ---------------------------------------------------------------------------
// 「修改提交人」：仅管理员；仅对已归档记录；提交人必须是系统内真实用户（防错别字/脏数据）。
// 只改 submitter，submit_time 保持原值；审计 action=update（before/after 对比完整留痕）。
// ---------------------------------------------------------------------------
router.put('/:id/submitter', (req, res) => {
  if (!isAdminUser(req)) return res.status(403).json({ error: '仅管理员可修改提交人' });
  const old = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '工时记录不存在' });
  if (old.status !== 'archived') return res.status(400).json({ error: '仅已归档记录可修改提交人' });

  const name = String((req.body || {}).submitter || '').trim();
  if (!name) return res.status(400).json({ error: '提交人不能为空' });
  if (name.length > 50) return res.status(400).json({ error: '提交人姓名过长（最多 50 字）' });
  const user = db.prepare('SELECT 1 FROM users WHERE display_name=? OR username=? LIMIT 1').get(name, name);
  if (!user) return res.status(400).json({ error: '提交人必须是系统内的用户' });
  if (name === String(old.submitter || '')) return res.json({ data: svc.calcRow(old.work_type, old) });

  db.prepare('UPDATE work_hours SET submitter=? WHERE work_id=?').run(name, old.work_id);
  const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(old.work_id);
  writeAudit(req, 'update', old.work_id, old, row, { content: {
    before: { submitter: old.submitter }, after: { submitter: row.submitter }, note: '修改提交人',
  } });
  res.json({ data: svc.calcRow(row.work_type, row) });
});

// GET /template：日期预填当月 1 号，客户名称列预填本仓全部货主。
// ⚠️ 必须定义在 /:id 之前，否则 "template" 会被当作 id 吞掉。
router.get('/template', (req, res) => {
  const warehouse = (req.query.warehouse || '').trim();
  const workType = (req.query.work_type || '发货').trim();
  if (!warehouse) return res.status(400).json({ error: '缺少 warehouse 参数' });
  if (workType !== '发货') return res.status(400).json({ error: '工时导入模板当前仅支持「发货」' });
  const owners = ownersOfWarehouse(req, warehouse, true); // 模板只预填合作中货主，与缺口清单一致
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // 默认今天
  const aoa = [IMPORT_HEADER, ...owners.map((o) => [date, o.company_name, '单', '', '', '', ''])]; // 单位默认「单」
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 24 }];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, '发货工时');
  const tips = xlsx.utils.aoa_to_sheet([
    ['发货工时导入说明'],
    ['1. 每行一条发货工时；日期默认今天（补报历史请改为实际日期，格式 YYYY-MM-DD）；客户名称必须是本仓货主（模板已预填，请勿改动为其他仓客户）。'],
    ['2. 单位默认「单」（可选 单/件/箱）；发货单量须 > 0；主/其他工时为数字；空行自动跳过。'],
    ['3. 导入时若「同日 + 同客户 + 同仓 + 发货 + 未归档」记录已存在，会标为重复，由你逐条选择覆盖或跳过。'],
    ['4. 停用货主可补报历史工时，但不可用已删除货主新增。'],
  ]);
  xlsx.utils.book_append_sheet(wb, tips, '填写说明');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fn = '发货工时导入模板_' + warehouse + '.xlsx';
  res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(fn));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/:id', (req, res) => {
  const r = db.prepare(
    `SELECT w.*,
            COALESCE(cl.company_name, w.customer_name) AS customer_name,
            CASE WHEN cl.customer_id IS NULL THEN NULL
                 WHEN cl.is_deleted=1 THEN '已删除'
                 WHEN cl.coop_status<>'合作中' THEN '停用'
                 ELSE '启用' END AS customer_status
       FROM work_hours w
       LEFT JOIN customers cl ON w.customer_id = cl.customer_id
      WHERE w.work_id=?`
  ).get(req.params.id);
  if (!r) return res.status(404).json({ error: '工时记录不存在' });
  res.json({ data: svc.calcRow(r.work_type, r) });
});

// 新增：按 body.work_type 选择校验与计算
router.post('/', (req, res) => {
  const b = req.body || {};
  const workType = (b.work_type || '').trim();
  // 行内快速填报：auto_archive=true 时提交即归档（落 status='archived'），该行随即从缺口清单消失。
  // 仍是标准新增路径：完整校验 + 计算 + 审计，仅状态不同；日期按前端传入（待补日）原样入库。
  const autoArchive = b.auto_archive === true || b.auto_archive === 1 || b.auto_archive === 'true';
  const err = svc.validateByType(workType, b, db);
  if (err) return res.status(400).json({ error: err });

  // 解析客户关联：按 id（新前端）或按名（旧客户端），取得稳定 id + 最新显示名
  const cust = (workType === '发货' || workType === '收货') ? svc.resolveCustomer(db, b) : null;
  const r = {
    warehouse: b.warehouse,
    work_type: workType,
    customer_id: cust ? cust.customer_id : null,
    customer_name: cust ? cust.customer_name : (b.customer_name || null),
    unit: b.unit || null,
    date: b.date,
    ship_orders: b.ship_orders != null ? Number(b.ship_orders) : null,
    cartons: b.cartons != null ? Number(b.cartons) : null,
    tons: b.tons != null ? Number(b.tons) : null,
    cubic: b.cubic != null ? Number(b.cubic) : null,
    pallets: b.pallets != null ? Number(b.pallets) : null,
    project: b.project || null,
    main_hours: Number(b.main_hours) || 0,
    other_hours: Number(b.other_hours) || 0,
    shared_hours: Number(b.shared_hours) || 0,
    remark: b.remark || null,
    status: autoArchive ? 'archived' : 'pending',
  };
  svc.calcRow(workType, r);

  const info = db
    .prepare(
      `INSERT INTO work_hours
        (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,cartons,tons,cubic,pallets,project,
         main_hours,other_hours,shared_hours,total_hours,efficiency,unit_cost,doc_cost,remark,owner_user_id,status,
         submitter,submit_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
               CASE WHEN ?='archived' THEN datetime('now','localtime') ELSE NULL END)`
    )
    .run(
      r.warehouse, r.work_type, r.customer_id, r.customer_name, r.unit, r.date,
      r.ship_orders != null ? r.ship_orders : null,
      r.cartons != null ? r.cartons : null,
      r.tons != null ? r.tons : null,
      r.cubic != null ? r.cubic : null,
      r.pallets != null ? r.pallets : null,
      r.project,
      r.main_hours, r.other_hours, r.shared_hours, r.total_hours,
      r.efficiency != null ? r.efficiency : null,
      r.unit_cost != null ? r.unit_cost : null,
      r.doc_cost != null ? r.doc_cost : null,
      r.remark, req.user.user_id, r.status,
      autoArchive ? operatorName(req) : null, // 提交人：行内提交即归档时落当前登录人
      r.status                                 // CASE 判据：archived 才写 submit_time
    );
  const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(info.lastInsertRowid);
  writeAudit(req, 'create', info.lastInsertRowid, null, row);
  res.status(201).json({ data: svc.calcRow(workType, row) });
});

// 编辑：合并旧值 → 校验（按 work_type）→ 重算 → 审计
router.put('/:id', (req, res) => {
  const b = req.body || {};
  const old = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '工时记录不存在' });
  if (!ensureOwn(req, old)) return res.status(403).json({ error: '无权修改他人负责的工时记录' });
  // 归档不可变：已归档记录必须先在「已归档」视图撤回，回到 pending 后才可编辑。
  if (old.status === 'archived') {
    return res.status(403).json({ error: '已归档记录不可直接修改，请先撤回后再编辑' });
  }

  const workType = (b.work_type || old.work_type).trim();
  // 跨仓改写防护：记录归属仓库只由库内原值决定，禁止借编辑把记录迁到其他仓
  if (b.warehouse && b.warehouse !== old.warehouse) {
    return res.status(403).json({ error: '禁止跨仓修改：该记录属于' + old.warehouse });
  }
  // 客户关联：请求带 customer_id 时以其为准（可为空表示清空），否则沿用旧关联；
  // 显示名始终从解析出的客户取最新值（客户改名后历史工时随之更新）。
  // 编辑允许命中已删除客户（includeDeleted），但仅当「客户未变更」时放行状态校验。
  const effCustId = b.customer_id !== undefined ? b.customer_id : old.customer_id;
  const effCustName = b.customer_name != null ? b.customer_name : old.customer_name;
  const cust = (workType === '发货' || workType === '收货')
    ? svc.resolveCustomer(db, { customer_id: effCustId, customer_name: effCustName }, { includeDeleted: true })
    : null;
  // 「客户未变更」：新 id 与旧 id 一致；或旧记录无 id 时名字一致（历史纯文本）。
  const custUnchanged = !!(cust && (
    (old.customer_id != null && cust.customer_id === old.customer_id) ||
    (old.customer_id == null && effCustName === old.customer_name)
  ));
  const err = svc.validateByType(workType, {
    ...b, warehouse: old.warehouse,
    customer_name: cust ? cust.customer_name : effCustName, customer_id: cust ? cust.customer_id : effCustId,
  }, db, { allowInactiveCust: custUnchanged });
  if (err) return res.status(400).json({ error: err });
  const merged = {
    warehouse: old.warehouse, // 仓库不可变：始终沿用库内原值
    work_type: workType,
    customer_id: cust ? cust.customer_id : (b.customer_id !== undefined ? (b.customer_id || null) : (old.customer_id || null)),
    customer_name: cust ? cust.customer_name : (b.customer_name != null ? b.customer_name : old.customer_name),
    unit: b.unit !== undefined ? b.unit : old.unit,
    date: b.date || old.date,
    ship_orders: b.ship_orders != null ? Number(b.ship_orders) : old.ship_orders,
    cartons: b.cartons != null ? Number(b.cartons) : old.cartons,
    tons: b.tons != null ? Number(b.tons) : old.tons,
    cubic: b.cubic != null ? Number(b.cubic) : old.cubic,
    pallets: b.pallets != null ? Number(b.pallets) : old.pallets,
    project: b.project !== undefined ? b.project : old.project,
    main_hours: b.main_hours != null ? Number(b.main_hours) : old.main_hours,
    other_hours: b.other_hours != null ? Number(b.other_hours) : old.other_hours,
    shared_hours: b.shared_hours != null ? Number(b.shared_hours) : old.shared_hours,
    remark: b.remark !== undefined ? b.remark : old.remark,
  };
  svc.calcRow(workType, merged);

  db.prepare(
    `UPDATE work_hours SET
      warehouse=?,work_type=?,customer_id=?,customer_name=?,unit=?,date=?,ship_orders=?,cartons=?,tons=?,cubic=?,pallets=?,project=?,
      main_hours=?,other_hours=?,shared_hours=?,total_hours=?,efficiency=?,unit_cost=?,doc_cost=?,remark=?
     WHERE work_id=?`
  ).run(
    merged.warehouse, merged.work_type, merged.customer_id, merged.customer_name, merged.unit, merged.date,
    merged.ship_orders != null ? merged.ship_orders : null,
    merged.cartons != null ? merged.cartons : null,
    merged.tons != null ? merged.tons : null,
    merged.cubic != null ? merged.cubic : null,
    merged.pallets != null ? merged.pallets : null,
    merged.project,
    merged.main_hours, merged.other_hours, merged.shared_hours, merged.total_hours,
    merged.efficiency != null ? merged.efficiency : null,
    merged.unit_cost != null ? merged.unit_cost : null,
    merged.doc_cost != null ? merged.doc_cost : null,
    merged.remark, old.work_id
  );
  const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(old.work_id);
  writeAudit(req, 'update', old.work_id, old, row);
  res.json({ data: svc.calcRow(workType, row) });
});

// 超级管理员专用：永久删除单条工时记录（物理 DELETE，前端仅超管可见删除按钮）。
// 与普通删除分离：普通录入员仍可删自己的记录（走下方 /:id），超管接口额外做 role_code 强校验。
router.delete('/:id/force', (req, res) => {
  if (!req.user || req.user.role_code !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可永久删除工时记录' });
  }
  const old = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '工时记录不存在' });
  db.prepare('DELETE FROM work_hours WHERE work_id=?').run(old.work_id);
  writeAudit(req, 'force_delete', old.work_id, old, null);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '工时记录不存在' });
  if (!ensureOwn(req, old)) return res.status(403).json({ error: '无权删除他人负责的工时记录' });
  // 已归档记录默认不可删：管理员也请先撤回；仅超级管理员可走 /force 物理删除。
  if (old.status === 'archived' && (!req.user || req.user.role_code !== 'super_admin')) {
    return res.status(403).json({ error: '已归档记录不可直接删除，请先撤回（或联系超级管理员）' });
  }
  db.prepare('DELETE FROM work_hours WHERE work_id=?').run(old.work_id);
  writeAudit(req, 'delete', old.work_id, old, null);
  res.json({ ok: true });
});

// ---------- 发货工时：模板下载 + 导入（两步：预览检测重复 → 确认覆盖/跳过）----------

// 本仓货主（未删除）。默认含停用（导入补报语义）；activeOnly=true 时仅合作中（模板预填口径，与缺口清单一致）
function ownersOfWarehouse(req, warehouse, activeOnly) {
  const scope = ownerScope(req);
  const where = ['warehouse LIKE ?', 'is_deleted=0'];
  const params = ['%' + warehouse + '%'];
  if (activeOnly) where.push("coop_status='合作中'");
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  return db.prepare(
    `SELECT customer_id, company_name, COALESCE(NULLIF(short_name,''),company_name) AS owner_name, coop_status
       FROM customers WHERE ${where.join(' AND ')} ORDER BY company_name`
  ).all(...params);
}

// 解析上传文件为标准化工时行（公共：preview 与 import 复用）
function parseImportRows(buf, warehouse, req) {
  const isZip = buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isZip) throw new Error('文件格式不对：请上传真正的 .xlsx / .xls Excel 文件');
  const wb = xlsx.read(buf, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('文件中没有工作表');
  const raw = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  // 本仓货主名 → id（按公司全称 / 简称精确匹配，含停用、排除已删除）
  const owners = ownersOfWarehouse(req, warehouse);
  const byName = new Map();
  owners.forEach((o) => {
    byName.set(o.company_name, o);
    if (o.owner_name) byName.set(o.owner_name, o);
  });
  const parsed = [];
  const errors = [];
  raw.forEach((r, idx) => {
    const line = idx + 2; // Excel 行号（表头占第 1 行）
    const date = parseDate(cell(r, '日期', 'date'));
    const name = String(cell(r, '客户名称', '客户', '货主名称', 'customer_name') || '').trim();
    const shipOrders = cell(r, '发货单量', '发货量', 'ship_orders');
    const mainHours = cell(r, '主工时', 'main_hours');
    if (!date && !name && (shipOrders === '' || shipOrders == null)) return; // 空行跳过
    if (!date) { errors.push({ line, error: '日期为空或格式错误' }); return; }
    if (!name) { errors.push({ line, error: '客户名称为空' }); return; }
    const owner = byName.get(name);
    if (!owner) { errors.push({ line, error: `客户「${name}」不属于本仓或已删除` }); return; }
    if (!(Number(shipOrders) > 0)) { errors.push({ line, error: '发货单量必须 > 0' }); return; }
    const mh = Number(mainHours) || 0;
    if (mh < 0) { errors.push({ line, error: '主工时不得为负' }); return; }
    parsed.push({
      line, date, customer_name: owner.company_name, customer_id: owner.customer_id,
      owner_name: owner.owner_name, coop_status: owner.coop_status,
      unit: String(cell(r, '单位', 'unit') || '单').trim(),
      ship_orders: Number(shipOrders), main_hours: mh,
      other_hours: Number(cell(r, '其他工时', 'other_hours') || 0) || 0,
      remark: String(cell(r, '备注', 'remark') || '').trim(),
    });
  });
  return { parsed, errors };
}

// POST /import/preview：解析 + 标出重复（同日+同客户+同仓+发货+pending），不写库
router.post('/import/preview', upload.single('file'), (req, res) => {
  // warehouse 优先取 query（RBAC 门禁在 multer 之前执行，也读 query），兼容 multipart body
  const warehouse = ((req.query && req.query.warehouse) || (req.body && req.body.warehouse) || '').trim();
  if (!warehouse) return res.status(400).json({ error: '缺少 warehouse 参数' });
  if (!req.file) return res.status(400).json({ error: '请选择要导入的 Excel 文件' });
  let parsed, errors;
  try { ({ parsed, errors } = parseImportRows(req.file.buffer, warehouse, req)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // 查重复：本仓 + 发货 + pending + 同客户 + 同日
  const rows = parsed.map((p) => {
    const dup = db.prepare(
      `SELECT work_id, ship_orders, main_hours, total_hours FROM work_hours
        WHERE warehouse=? AND work_type='发货' AND status='pending' AND customer_id=? AND date=?
        ORDER BY work_id LIMIT 1`
    ).get(warehouse, p.customer_id, p.date);
    return { ...p, duplicate: !!dup, existing: dup || null, decision: dup ? 'skip' : 'create' };
  });
  res.json({
    data: rows, errors, warehouse,
    duplicateCount: rows.filter((r) => r.duplicate).length,
    createCount: rows.filter((r) => !r.duplicate).length,
  });
});

// POST /import：按 decisions（行号 → overwrite / skip）落库，事务 + 审计
router.post('/import', upload.single('file'), (req, res) => {
  // warehouse 优先取 query（RBAC 门禁在 multer 之前执行，也读 query），兼容 multipart body
  const warehouse = ((req.query && req.query.warehouse) || (req.body && req.body.warehouse) || '').trim();
  if (!warehouse) return res.status(400).json({ error: '缺少 warehouse 参数' });
  if (!req.file) return res.status(400).json({ error: '请选择要导入的 Excel 文件' });
  let decisions = {};
  try { decisions = JSON.parse(req.body.decisions || '{}'); } catch (_) { /* 空决策：全按默认 */ }
  let parsed, errors;
  try { ({ parsed, errors } = parseImportRows(req.file.buffer, warehouse, req)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let created = 0, overwritten = 0, skipped = 0;
  const log = [];
  db.exec('BEGIN');
  try {
    for (const p of parsed) {
      // 找同日同客户 pending 记录（覆盖或新建）
      const existing = db.prepare(
        `SELECT * FROM work_hours WHERE warehouse=? AND work_type='发货' AND status='pending' AND customer_id=? AND date=? ORDER BY work_id LIMIT 1`
      ).get(warehouse, p.customer_id, p.date);
      // import 自己按当前库判定重复（不能依赖 preview 的 p.duplicate——两次调用间数据可能变化）
      const decision = decisions[p.line] || (existing ? 'skip' : 'create');
      if (decision === 'skip') { skipped++; continue; }
      if (decision === 'overwrite' && existing) {
        if (!ensureOwn(req, existing)) throw new Error(`第 ${p.line} 行：无权覆盖他人负责的工时记录`);
        const r = {
          warehouse, work_type: '发货', customer_id: p.customer_id, customer_name: p.customer_name,
          unit: p.unit, date: p.date, ship_orders: p.ship_orders,
          main_hours: p.main_hours, other_hours: p.other_hours, shared_hours: 0,
        };
        svc.calcRow('发货', r);
        db.prepare(
          `UPDATE work_hours SET customer_id=?,customer_name=?,unit=?,date=?,ship_orders=?,
            main_hours=?,other_hours=?,shared_hours=?,total_hours=?,efficiency=?,unit_cost=?,remark=?
            WHERE work_id=?`
        ).run(r.customer_id, r.customer_name, r.unit, r.date, r.ship_orders,
          r.main_hours, r.other_hours, r.shared_hours, r.total_hours, r.efficiency, r.unit_cost,
          p.remark || null, existing.work_id);
        overwritten++;
        log.push({ line: p.line, action: 'overwrite', work_id: existing.work_id });
      } else {
        // 新建：停用货主允许补报历史（导入是"补报"语义），已删除已被 parseImportRows 排除
        const r = {
          warehouse, work_type: '发货', customer_id: p.customer_id, customer_name: p.customer_name,
          unit: p.unit, date: p.date, ship_orders: p.ship_orders,
          main_hours: p.main_hours, other_hours: p.other_hours, shared_hours: 0,
        };
        svc.calcRow('发货', r);
        const info = db.prepare(
          `INSERT INTO work_hours
            (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,shared_hours,
             total_hours,efficiency,unit_cost,remark,owner_user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(warehouse, '发货', r.customer_id, r.customer_name, r.unit, r.date, r.ship_orders,
          r.main_hours, r.other_hours, r.shared_hours, r.total_hours, r.efficiency, r.unit_cost,
          p.remark || null, req.user.user_id);
        created++;
        log.push({ line: p.line, action: 'create', work_id: Number(info.lastInsertRowid) });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    return res.status(500).json({ error: '导入失败，已回滚：' + e.message });
  }
  writeAudit(req, 'import', 0, null, {
    warehouse, file: req.file.originalname, created, overwritten, skipped, lines: log, errors,
  });
  res.json({ created, overwritten, skipped, errors, lines: log });
});

// 审计：统一走全局日志服务（新旧字段双写，模块=工时管理）
// extra：可传 { content } 覆盖 before/after 对比内容（如「修改提交人」只记该字段）
function writeAudit(req, action, recordId, before, after, extra) {
  require('../services/auditLog').writeLog(req, {
    table: 'work_hours', module: '工时管理', action,
    targetId: recordId, before, after,
    ...(extra || {}),
  });
}

module.exports = router;
