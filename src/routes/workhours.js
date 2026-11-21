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
const { warehouseExactLikeValue } = require('../utils/likeEscape');
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
router.use('/three', require('./threeHours'));
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

// 真实日历日期校验（YYYY-MM-DD）：缺口展开要把日期内联进 SQL 常量列，必须先证伪非法/不存在日期
function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(s + 'T00:00:00Z');
  return Number.isFinite(+t) && t.toISOString().slice(0, 10) === s;
}
function nextDateStr(s) {
  const t = new Date(s + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

// ========== 唯一性校验（发货/库内/后勤 禁止同日同维度重复） ==========
// 收货允许同日多客户多行（不校验）；其他三种 work_type 用 (warehouse, date, key) 联合唯一
// key 规则：发货/收货用 customer_id，库内/后勤用 project
// excludeWorkId 用于编辑场景——允许同一条记录更新自身
function checkUnique(workType, { warehouse, date, customer_id, customer_name, project }, { excludeWorkId } = {}) {
  // 收货放行
  if (workType === '收货') return null;

  const keyCol = (workType === '发货') ? 'customer_id' : 'project';
  const keyVal = (workType === '发货') ? (customer_id != null ? customer_id : null) : project;

  if (warehouse == null || date == null || keyVal == null) return null; // 缺失关键字段跳过（validateByType 会拦）

  // warehouse 精确匹配（配合覆盖索引 idx_wh_lookup(warehouse, work_type, customer_id, date, status)
  // 单行查询可命中覆盖索引 → 零回表，20 万归档数据下 PRECHECK 耗时 < 10ms / 1000 行）。
  // 历史曾用 LIKE '%仓名%' 兼容多仓逗号串，但真实数据仓库名唯一，且 LIKE 左通配导致复合索引失效
  // → 热点日（同日 10 万行）单行回表 8ms × 1000 行 = 8 秒。
  const clauses = ["warehouse = ?", "work_type = ?", "date = ?", "status = 'archived'"];
  const params = [warehouse, workType, date];

  if (workType === '发货' && keyVal != null) {
    // 优先按 customer_id 精确匹配；如果 customer_id 是 null（导入可能），fallback customer_name
    clauses.push('(customer_id = ? OR (customer_id IS NULL AND customer_name = ?))');
    params.push(keyVal, customer_name || '');
  } else {
    clauses.push('project = ?');
    params.push(keyVal);
  }

  if (excludeWorkId) {
    clauses.push('work_id != ?');
    params.push(excludeWorkId);
  }

  const row = db.prepare(
    `SELECT work_id, ${keyCol} FROM work_hours WHERE ${clauses.join(' AND ')} LIMIT 1`
  ).get(...params);

  if (!row) return null;

  const conflictLabel = (workType === '发货')
    ? (customer_name || ('客户ID=' + customer_id))
    : (project || '');

  // 结构化冲突详情：前端可直接读取日期 + 货主/项目名拼接用户友好消息
  return {
    code: 'DUPLICATE_ARCHIVED',
    date: date,
    shipper: (workType === '发货') ? conflictLabel : null,
    project: (workType !== '发货') ? conflictLabel : null,
    work_type: workType,
    archived_work_id: row.work_id,
    message: `该${workType === '发货' ? '客户' : '项目'}「${conflictLabel}」在 ${date} 已存在归档工时记录，请勿重复提交或请前往已归档列表修改。`,
  };
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
  const pageSize = Math.min(1000, Math.max(1, parseInt(req.query.pageSize || '20', 10)));

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
    // 本仓货主：warehouse 精确边界匹配多仓串；排除已删除（软删 is_deleted=1）与停用货主（仅合作中展示缺口）
    const ownerWhere = ["',' || c.warehouse || ',' LIKE ? ESCAPE '\\'", 'c.is_deleted=0', "c.coop_status='合作中'"];
    const ownerParams = [warehouseExactLikeValue(warehouse)];
    if (custScope.sql) { ownerWhere.push(custScope.sql); ownerParams.push(...custScope.params); }
    if (q) { ownerWhere.push('(COALESCE(NULLIF(c.short_name,\'\'),c.company_name) LIKE ? OR c.company_name LIKE ?)'); const like = `%${q}%`; ownerParams.push(like, like); }
    const ownerWhereSql = ownerWhere.join(' AND ');

    // filled：当前筛选下的 pending 发货记录（沿用上面的 whereSql）
    const filledWhere = whereSql === 'WHERE ' ? '' : whereSql;
    const CUST_STATUS = `CASE WHEN c.is_deleted=1 THEN '已删除' WHEN c.coop_status<>'合作中' THEN '停用' ELSE '启用' END`;
    // ★ 多日缺口展开（2026-11-21）：所选日期范围内「每一天」都生成待补行（此前多日只显示昨天一天）。
    // 判定日与展示日仍严格一致：待补行展示哪一天，就用哪一天判定是否已填（归档/草稿任一存在即抑制）。
    // need_backfill = 该日早于今天；未来日期不生成；范围上限 62 天（超出取最近 62 天，防单次查询行数失控）。
    const todayStr = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
    const gapDates = [];
    {
      let from = isRealDate(dateFrom) ? dateFrom : period.from;
      let to = isRealDate(dateTo) ? dateTo : period.to;
      if (!isRealDate(from)) from = todayStr.slice(0, 8) + '01';
      if (!isRealDate(to)) to = todayStr;
      if (to > todayStr) to = todayStr;
      const MAX_GAP_DAYS = 62;
      const floor = new Date(to + 'T00:00:00Z');
      floor.setUTCDate(floor.getUTCDate() - (MAX_GAP_DAYS - 1));
      const floorStr = floor.toISOString().slice(0, 10);
      if (from < floorStr) from = floorStr;
      for (let d = from; d <= to; d = nextDateStr(d)) gapDates.push(d);
    }
    // gapDates 全部由 isRealDate 校验后逐日推进生成，可安全内联为 SQL 常量列
    const gapDatesSql = gapDates.length
      ? "SELECT '" + gapDates.join("' AS d UNION ALL SELECT '") + "' AS d"
      : 'SELECT NULL AS d WHERE 1=0';

    const countSql = `
      SELECT (
        SELECT COUNT(*) FROM work_hours w ${JOIN} ${filledWhere}
      ) + (
        SELECT COUNT(*) FROM customers c JOIN (${gapDatesSql}) gd
         WHERE ${ownerWhereSql}
           AND NOT EXISTS (
             SELECT 1 FROM work_hours w
              WHERE w.warehouse=? AND w.work_type='发货'
                AND w.customer_id=c.customer_id AND w.date=gd.d
           )
      ) AS c`;
    const total = db.prepare(countSql).get(
      ...params,                        // filled 计数参数
      ...ownerParams,                   // owners 计数参数
      warehouse                         // NOT EXISTS 仓库参数
    ).c;

    const rows = db.prepare(`
      SELECT * FROM (
        SELECT w.work_id, w.warehouse, w.work_type, w.customer_id,
               COALESCE(cl.company_name, w.customer_name) AS customer_name,
               w.unit, w.date, w.ship_orders, w.cartons, w.tons, w.cubic, w.pallets, w.workload, w.project,
               w.main_hours, w.other_hours, w.shared_hours, w.total_hours,
               w.efficiency, w.unit_cost, w.doc_cost, w.remark, w.owner_user_id,
               w.status, w.submitter, w.submit_time,
               COALESCE(cl.sort_order, 9999) AS sort_order,
               COALESCE(cl.default_unit, '单') AS default_unit,
               ${STATUS} AS customer_status, 1 AS filled, '' AS suggest_date, 0 AS need_backfill
          FROM work_hours w ${JOIN} ${filledWhere}
        UNION ALL
        SELECT 0 AS work_id, ? AS warehouse, '发货' AS work_type, c.customer_id,
               c.company_name AS customer_name,   -- 与已填行 COALESCE(cl.company_name,...) 口径一致：填前填后名字不变
               COALESCE(c.default_unit, '单') AS unit, gd.d AS date, 0 AS ship_orders, 0 AS cartons, 0 AS tons, 0 AS cubic, 0 AS pallets, NULL AS workload, '' AS project,
               0 AS main_hours, 0 AS other_hours, 0 AS shared_hours, 0 AS total_hours,
               0 AS efficiency, 0 AS unit_cost, 0 AS doc_cost, '' AS remark, c.owner_user_id,
               'pending' AS status, NULL AS submitter, NULL AS submit_time,
               COALESCE(c.sort_order, 9999) AS sort_order,
               COALESCE(c.default_unit, '单') AS default_unit,
               ${CUST_STATUS} AS customer_status, 0 AS filled,
               gd.d AS suggest_date, CASE WHEN gd.d < ? THEN 1 ELSE 0 END AS need_backfill
          FROM customers c JOIN (${gapDatesSql}) gd
         WHERE ${ownerWhereSql}
           AND NOT EXISTS (
             SELECT 1 FROM work_hours w
              WHERE w.warehouse=? AND w.work_type='发货'
                AND w.customer_id=c.customer_id AND w.date=gd.d
           )
      ) t
      ORDER BY filled DESC, date DESC, sort_order ASC, customer_name
      LIMIT ? OFFSET ?`
    ).all(
      ...params,                       // ① filled 分支 WHERE 参数（SQL 文本中最先出现）
      warehouse,                       // ② UNION ALL 下半部 SELECT 常量 ? AS warehouse
      todayStr,                        // ③ 缺口行 need_backfill 判定基准（该日早于今天=待补）
      ...ownerParams,                  // ④ owners 分支 WHERE 参数
      warehouse,                       // ⑤ NOT EXISTS 仓库参数（日期用 gd.d，无需参数）
      pageSize, (page - 1) * pageSize  // ⑥ LIMIT / OFFSET
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

  // 归档前的唯一性预校验：每个待归档 pending 记录不能与已 archived 记录撞同维度
  if (workType !== '收货') {
    const duplicates = [];
    for (const id of targetIds) {
      const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(id);
      if (!row) continue;
      const uqDetail = checkUnique(workType, {
        warehouse: row.warehouse, date: row.date,
        customer_id: row.customer_id, customer_name: row.customer_name, project: row.project,
      });
      if (uqDetail) duplicates.push({ work_id: id, error: uqDetail.message, detail: uqDetail });
    }
    if (duplicates.length) {
      return res.status(409).json({
        error: '有 ' + duplicates.length + ' 条记录与已归档数据冲突，无法归档',
        code: 'BATCH_DUPLICATE_ARCHIVED',
        conflicts: duplicates,
      });
    }
  }

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
// 「批量提交」：一次性把勾选的 pending 记录置为 archived（单条 SQL IN 更新，避免 N 次状态往返）。
// 铁律：只影响传入且属于当前仓库/工时类型、状态仍为 pending、且当前用户有权处理的记录；
//       其余（不存在 / 跨仓跨类型 / 他人负责 / 已归档）一律跳过，绝不回退或破坏已归档数据。
// ---------------------------------------------------------------------------
router.post('/batch-submit', (req, res) => {
  const b = req.body || {};
  const warehouse = String(b.warehouse || '').trim();
  const workType = String(b.work_type || '').trim();
  if (!warehouse || !workType) return res.status(400).json({ error: '批量提交需带 warehouse / work_type' });
  const ids = Array.isArray(b.ids)
    ? [...new Set(b.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
    : [];
  if (!ids.length) return res.status(400).json({ error: '请先勾选需要提交的数据' });

  const allowed = [];
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(id);
    if (!row) continue;                                            // 已被删除：跳过
    if (row.warehouse !== warehouse || row.work_type !== workType) continue; // 跨仓/跨类型：跳过（防越权）
    if (!ensureOwn(req, row)) continue;                            // 他人负责：跳过
    if (row.status !== 'pending') continue;                        // 已归档：跳过，绝不重复提交
    allowed.push(id);
  }
  if (!allowed.length) return res.json({ submitted: 0, skipped: ids.length, ids: [] });

  // 批量提交前的唯一性预校验（与 /archive 接口同理）
  if (workType !== '收货') {
    const duplicates = [];
    for (const id of allowed) {
      const row = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(id);
      if (!row) continue;
      const uqDetail = checkUnique(workType, {
        warehouse: row.warehouse, date: row.date,
        customer_id: row.customer_id, customer_name: row.customer_name, project: row.project,
      });
      if (uqDetail) duplicates.push({ work_id: id, error: uqDetail.message, detail: uqDetail });
    }
    if (duplicates.length) {
      return res.status(409).json({
        error: '有 ' + duplicates.length + ' 条记录与已归档数据冲突，无法提交',
        code: 'BATCH_DUPLICATE_ARCHIVED',
        conflicts: duplicates,
      });
    }
  }

  const submitter = operatorName(req);
  const holders = allowed.map(() => '?').join(',');
  const info = db.prepare(
    `UPDATE work_hours SET status='archived', submitter=?, submit_time=datetime('now','localtime')
      WHERE work_id IN (${holders}) AND status='pending'`
  ).run(submitter, ...allowed);

  writeAudit(req, 'submit', 0, { scope: 'batch', ids: allowed },
    { submitted: info.changes, submitter, warehouse, work_type: workType });
  res.json({ submitted: info.changes, skipped: ids.length - info.changes, ids: allowed, submitter });
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

  // 单条提交归档前的唯一性校验
  if (old.work_type !== '收货') {
    const uqDetail = checkUnique(old.work_type, {
      warehouse: old.warehouse, date: old.date,
      customer_id: old.customer_id, customer_name: old.customer_name, project: old.project,
    });
    if (uqDetail) return res.status(409).json({ error: uqDetail.message, code: uqDetail.code, detail: uqDetail });
  }

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
  const aoa = [IMPORT_HEADER, ...owners.map((o) => [date, o.company_name, o.default_unit || '单', '', '', '', ''])]; // 单位：按客户 default_unit 带出（兜底 '单'）
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 24 }];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, '发货工时');
  const tips = xlsx.utils.aoa_to_sheet([
    ['发货工时导入说明'],
    ['1. 每行一条发货工时；日期默认今天（补报历史请改为实际日期，格式 YYYY-MM-DD）；客户名称必须是本仓货主（模板已预填，请勿改动为其他仓客户）。'],
    ['2. 单位默认「单」（可选 单/件/箱）；发货单量必须为 0~1000000 的整数（小数按四舍五入入库；负数/超上限会被拦截）；单量为 0 或留空时，需至少填写主工时、其他工时或备注，否则该行会被跳过；空行自动跳过。'],
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
    ship_orders: svc.roundShipOrders(b.ship_orders),   // 空 → null；有值 → 四舍五入取整
    cartons: b.cartons != null ? Number(b.cartons) : null,
    tons: b.tons != null ? Number(b.tons) : null,
    cubic: b.cubic != null ? Number(b.cubic) : null,
    pallets: b.pallets != null ? Number(b.pallets) : null,
    workload: b.workload != null && b.workload !== '' ? Number(b.workload) : null,
    project: b.project || null,
    main_hours: Number(b.main_hours) || 0,
    other_hours: Number(b.other_hours) || 0,
    shared_hours: Number(b.shared_hours) || 0,
    remark: b.remark || null,
    status: autoArchive ? 'archived' : 'pending',
  };
  svc.calcRow(workType, r);

  // 唯一性校验（仅 autoArchive 才校验 archived 状态；pending 草稿允许同维度多条）
  if (autoArchive) {
    const uqDetail = checkUnique(workType, {
      warehouse: r.warehouse, date: r.date,
      customer_id: r.customer_id, customer_name: r.customer_name, project: r.project,
    });
    if (uqDetail) return res.status(409).json({ error: uqDetail.message, code: uqDetail.code, detail: uqDetail });
  }

  const info = db
    .prepare(
      `INSERT INTO work_hours
        (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,cartons,tons,cubic,pallets,workload,project,
         main_hours,other_hours,shared_hours,total_hours,efficiency,unit_cost,doc_cost,remark,owner_user_id,status,
         submitter,submit_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
               CASE WHEN ?='archived' THEN datetime('now','localtime') ELSE NULL END)`
    )
    .run(
      r.warehouse, r.work_type, r.customer_id, r.customer_name, r.unit, r.date,
      r.ship_orders != null ? r.ship_orders : null,
      r.cartons != null ? r.cartons : null,
      r.tons != null ? r.tons : null,
      r.cubic != null ? r.cubic : null,
      r.pallets != null ? r.pallets : null,
      r.workload != null ? r.workload : null,
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
  // 已归档记录的编辑权限：仅提交人本人 或 管理员 可修改；pending 无额外限制。
  if (old.status === 'archived') {
    const me = operatorName(req);
    if (!isAdminUser(req) && String(old.submitter || '') !== me) {
      return res.status(403).json({ error: '已归档记录仅提交人本人或管理员可修改' });
    }
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
    ship_orders: b.ship_orders === undefined ? old.ship_orders : svc.roundShipOrders(b.ship_orders),
    cartons: b.cartons != null ? Number(b.cartons) : old.cartons,
    tons: b.tons != null ? Number(b.tons) : old.tons,
    cubic: b.cubic != null ? Number(b.cubic) : old.cubic,
    pallets: b.pallets != null ? Number(b.pallets) : old.pallets,
    workload: b.workload != null && b.workload !== '' ? Number(b.workload) : (b.workload === '' ? null : old.workload),
    project: b.project !== undefined ? b.project : old.project,
    main_hours: b.main_hours != null ? Number(b.main_hours) : old.main_hours,
    other_hours: b.other_hours != null ? Number(b.other_hours) : old.other_hours,
    shared_hours: b.shared_hours != null ? Number(b.shared_hours) : old.shared_hours,
    remark: b.remark !== undefined ? b.remark : old.remark,
  };
  svc.calcRow(workType, merged);

  // 唯一性校验：编辑后若状态仍为 archived 或目标为 pending 但即将通过 archive 接口归档，
  // 这里先拦 archived 状态的重复冲突（archive 接口也会再校一次，双重保险）
  if (old.status === 'archived') {
    const uqDetail = checkUnique(workType, {
      warehouse: merged.warehouse, date: merged.date,
      customer_id: merged.customer_id, customer_name: merged.customer_name, project: merged.project,
    }, { excludeWorkId: old.work_id });
    if (uqDetail) return res.status(409).json({ error: uqDetail.message, code: uqDetail.code, detail: uqDetail });
  }

  db.prepare(
    `UPDATE work_hours SET
      warehouse=?,work_type=?,customer_id=?,customer_name=?,unit=?,date=?,ship_orders=?,cartons=?,tons=?,cubic=?,pallets=?,workload=?,project=?,
      main_hours=?,other_hours=?,shared_hours=?,total_hours=?,efficiency=?,unit_cost=?,doc_cost=?,remark=?
     WHERE work_id=?`
  ).run(
    merged.warehouse, merged.work_type, merged.customer_id, merged.customer_name, merged.unit, merged.date,
    merged.ship_orders != null ? merged.ship_orders : null,
    merged.cartons != null ? merged.cartons : null,
    merged.tons != null ? merged.tons : null,
    merged.cubic != null ? merged.cubic : null,
    merged.pallets != null ? merged.pallets : null,
    merged.workload != null ? merged.workload : null,
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
// 批量删除（仅超级管理员）：物理删除指定 work_id 集合，写审计
// 必须满足：超管权限 + 非空 ids + 所有 id 都存在于本仓（防跨仓误删）
// 幂等：已删除的 id 直接忽略，不会报错
// 审计：复用 writeAudit（单条 action='delete'），日志中心统一口径
router.delete('/batch', (req, res) => {
  if (!req.user || req.user.role_code !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可批量删除工时记录' });
  }
  let ids;
  try { ids = req.body && req.body.ids; } catch (_) { ids = null; }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请勾选要删除的记录' });
  }
  const cleaned = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (cleaned.length === 0) {
    return res.status(400).json({ error: '请勾选要删除的记录' });
  }
  const warehouse = ((req.body && req.body.warehouse) || '').trim();

  // 事务删除 + 审计
  db.exec('BEGIN');
  try {
    const placeholders = cleaned.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM work_hours WHERE work_id IN (${placeholders})`
    ).all(...cleaned);
    const toDelete = rows.filter((r) => {
      // 跨仓保护（精确匹配，与 checkUnique 统一口径）
      if (warehouse && r.warehouse !== warehouse) return false;
      return true;
    });
    if (toDelete.length === 0) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: '所选记录不存在或已被删除' });
    }
    const delStmt = db.prepare('DELETE FROM work_hours WHERE work_id=?');
    for (const r of toDelete) {
      const oldBlob = JSON.parse(JSON.stringify(r)); // 事务内先深拷贝旧值（删完再传给 writeAudit）
      delStmt.run(r.work_id);
      writeAudit(req, 'delete', r.work_id, oldBlob, null);
    }
    db.exec('COMMIT');
    res.json({ ok: true, deleted: toDelete.length, notFound: cleaned.length - toDelete.length });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    return res.status(500).json({ error: '批量删除失败，已回滚：' + e.message });
  }
});

router.delete('/:id/force', (req, res) => {
  if (!req.user || req.user.role_code !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可永久删除工时记录' });
  }
  const id = Number(req.params.id);
  // 铁律：前端虚拟行（无 work_id 的缺口行 wid=0）严禁调后端删除；这里兜底拦截 id<=0
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: '非法记录 id（虚拟行不能调后端删除，请前端过滤）' });
  }
  const old = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(id);
  if (!old) return res.status(404).json({ error: '工时记录不存在' });
  db.prepare('DELETE FROM work_hours WHERE work_id=?').run(old.work_id);
  writeAudit(req, 'force_delete', old.work_id, old, null);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: '非法记录 id（虚拟行不能调后端删除，请前端过滤）' });
  }
  const old = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(id);
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
  const where = ["',' || warehouse || ',' LIKE ? ESCAPE '\\'", 'is_deleted=0'];
  const params = [warehouseExactLikeValue(warehouse)];
  if (activeOnly) where.push("coop_status='合作中'");
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  return db.prepare(
    `SELECT customer_id, company_name, COALESCE(NULLIF(short_name,''),company_name) AS owner_name, coop_status, sort_order,
            COALESCE(default_unit, '单') AS default_unit
       FROM customers WHERE ${where.join(' AND ')} ORDER BY sort_order ASC, company_name`
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
    // 发货单量：空值允许；填了必须能转数字并四舍五入取整，范围 0 ~ SHIP_MAX（0 允许，负数/超上限拦截）
    let shipValue = null;
    if (shipOrders !== '' && shipOrders != null) {
      const n = Number(shipOrders);
      if (!Number.isFinite(n)) { errors.push({ line, error: '发货单量为非法数字' }); return; }
      shipValue = Math.round(n); // 四舍五入，禁止截断
      if (shipValue < 0) { errors.push({ line, error: '发货单量不能为负数' }); return; }
      if (shipValue > svc.SHIP_MAX) { errors.push({ line, error: `发货单量不能超过 ${svc.SHIP_MAX}` }); return; }
    }
    const mh = Number(mainHours) || 0;
    const oh = Number(cell(r, '其他工时', 'other_hours') || 0) || 0;
    if (mh < 0) { errors.push({ line, error: '主工时不得为负' }); return; }
    if (oh < 0) { errors.push({ line, error: '其他工时不得为负' }); return; }
    const remarkOK = !!String(cell(r, '备注', 'remark') || '').trim();
    // ★ 任意有效内容项即可提交：单量>0 / 主工时 / 其他工时 / 备注。
    //   单量为 0 或留空时，必须至少还有工时或备注（支持「0 单 + 工时/备注」「仅备注」场景）。
    if (!(shipValue > 0) && !(mh > 0) && !(oh > 0) && !remarkOK) {
      errors.push({ line, error: '单量为 0 或为空时，需至少填写主工时、其他工时或备注' });
      return;
    }
    parsed.push({
      line, date, customer_name: owner.company_name, customer_id: owner.customer_id,
      owner_name: owner.owner_name, coop_status: owner.coop_status,
      unit: String(cell(r, '单位', 'unit') || '单').trim(),
      ship_orders: shipValue, main_hours: mh,
      other_hours: oh,
      remark: String(cell(r, '备注', 'remark') || '').trim(),
    });
  });
  return { parsed, errors };
}

// POST /import/preview：解析 + 标出重复（同日+同客户+同仓+发货），不写库
// 冲突分三态（用户定义的规则 2/3/4 基础）：
//   - exact_match  → 归档库中同日+同客户，且所有字段完全一致 → 规则 2 候选
//   - diff_match   → 归档库中同日+同客户，但至少一个其他字段不同 → 规则 3 候选
//   - create       → 归档库无同日+同客户记录 → 规则 1 候选
router.post('/import/preview', upload.single('file'), (req, res) => {
  const warehouse = ((req.query && req.query.warehouse) || (req.body && req.body.warehouse) || '').trim();
  if (!warehouse) return res.status(400).json({ error: '缺少 warehouse 参数' });
  if (!req.file) return res.status(400).json({ error: '请选择要导入的 Excel 文件' });
  let parsed, errors;
  try { ({ parsed, errors } = parseImportRows(req.file.buffer, warehouse, req)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // 用覆盖索引查：warehouse, work_type, customer_id, date
  // 取所有同日同客户记录（可能多条 archived，可能 archived + pending 并存）
  const findAll = db.prepare(
    `SELECT * FROM work_hours
      WHERE warehouse = ? AND work_type='发货' AND customer_id=? AND date=?
      ORDER BY CASE WHEN status='archived' THEN 0 ELSE 1 END, work_id`
  );

  // 对比函数：比较导入行 vs 归档行，返回 true 表示完全一致（共用 svc 实现，数值按 Number 比较）
  const isExactMatch = svc.isSameHoursRow;

  const seenBatch = new Set();
  const rows = parsed.map((p) => {
    const batchKey = `${p.customer_id}|${p.date}`;
    if (seenBatch.has(batchKey)) return { ...p, action: 'skip_batch_dup', existing: null };
    seenBatch.add(batchKey);
    const existingAll = findAll.all(warehouse, p.customer_id, p.date);
    // 只看 archived（pending 草稿不参与三态判定，规则只针对已归档）
    const archived = existingAll.filter((r) => r.status === 'archived');
    const pending = existingAll.filter((r) => r.status !== 'archived');
    if (archived.length === 0) {
      // 与 /import 判定保持一致：同日同客户有未归档草稿 → 提交该草稿（不新增行）
      if (pending.length) return { ...p, action: 'promote_pending', existing: pending[0] };
      return { ...p, action: 'create', existing: null };
    }
    // 取第一条 archived（ORDER BY work_id，通常只有一条）
    const arch = archived[0];
    const exact = isExactMatch(p, arch);
    if (exact) {
      return { ...p, action: 'skip_exact', existing: arch };
    }
    return { ...p, action: 'overwrite', existing: arch };
  });

  const createCnt = rows.filter((r) => r.action === 'create').length;
  const promoteCnt = rows.filter((r) => r.action === 'promote_pending').length;
  const skipCnt = rows.filter((r) => r.action === 'skip_exact').length;
  const overwriteCnt = rows.filter((r) => r.action === 'overwrite').length;
  const batchDupCnt = rows.filter((r) => r.action === 'skip_batch_dup').length;

  // 汇总规则判定（与 import PRECHECK 完全一致的三态语义）
  let rule;
  if (createCnt + promoteCnt === rows.length) rule = 1;   // 全新增/全提交草稿（零冲突）
  else if (skipCnt + batchDupCnt === rows.length) rule = 2; // 全跳过（零写入，幂等）
  else if (overwriteCnt === rows.length) rule = 3;        // 全 overwrite
  else rule = 4;                                          // 混合

  res.json({
    data: rows, errors, warehouse,
    stats: {
      create: createCnt, promote_pending: promoteCnt,
      skip_exact: skipCnt, skip_batch_dup: batchDupCnt,
      overwrite: overwriteCnt, rule,
    },
  });
});

// POST /import：后端自主判定规则 1-4，前端只需传文件，不传 decisions/forceArchive
// 导入数据 = 员工已确认的工时记录 → 直接置 archived + 写入 submitter / submit_time
// 规则判定（与 /import/preview 一致）：
//   规则 1：全 create       → 不弹窗，直接执行 → 200
//   规则 2：全 skip_exact   → 终止导入，不启动事务 → 409 + code=IMPORT_ALL_EXACT_MATCH
//   规则 3：全 overwrite    → 启动事务覆盖所有归档 → 200
//   规则 4：混合            → skip_exact 跳过 + overwrite 覆盖 + create 新增 → 200 + warn
router.post('/import', upload.single('file'), (req, res) => {
  const warehouse = ((req.query && req.query.warehouse) || (req.body && req.body.warehouse) || '').trim();
  if (!warehouse) return res.status(400).json({ error: '缺少 warehouse 参数' });
  if (!req.file) return res.status(400).json({ error: '请选择要导入的 Excel 文件' });
  let parsed, errors;
  try { ({ parsed, errors } = parseImportRows(req.file.buffer, warehouse, req)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // ---------- 三态 PRECHECK（与 preview 完全相同的判定逻辑）----------
  const findAll = db.prepare(
    `SELECT * FROM work_hours
      WHERE warehouse = ? AND work_type='发货' AND customer_id=? AND date=?
      ORDER BY CASE WHEN status='archived' THEN 0 ELSE 1 END, work_id`
  );
  const isExactMatch = svc.isSameHoursRow;   // 与 /import/preview 共用同一实现

  const ACTIONS = new Map(); // line → 'create' | 'promote_pending' | 'overwrite' | 'skip_exact' | 'skip_batch_dup'
  const seenBatch = new Set(); // 文件内同维度去重键（同客户+同日期）
  for (const p of parsed) {
    const batchKey = `${p.customer_id}|${p.date}`;
    // ★ 同一文件内重复行（同客户+同日期）→ 只认第一条，后续行跳过并计数，
    //   否则同一维度会被写两次（覆盖分支重复插行），造成数据翻倍。
    if (seenBatch.has(batchKey)) {
      ACTIONS.set(p.line, { action: 'skip_batch_dup', existing: null });
      continue;
    }
    seenBatch.add(batchKey);

    const existingAll = findAll.all(warehouse, p.customer_id, p.date);
    const archived = existingAll.filter((r) => r.status === 'archived');
    const pending = existingAll.filter((r) => r.status !== 'archived');
    if (archived.length === 0) {
      // ★ 同日同客户已有「未归档草稿」→ 直接提交该草稿（原地转 archived 并写入导入值），
      //   绝不能再插一条 archived，否则同一条业务数据会同时出现在未归档与已归档两个列表。
      if (pending.length) {
        ACTIONS.set(p.line, {
          action: 'promote_pending',
          existing: pending[0],
          extras: pending.slice(1).map((r) => r.work_id),
        });
      } else {
        ACTIONS.set(p.line, { action: 'create', existing: null });
      }
    } else {
      const arch = archived[0];
      const exact = isExactMatch(p, arch);
      ACTIONS.set(p.line, {
        action: exact ? 'skip_exact' : 'overwrite',
        existing: arch,
        // 同维度多条 archived（历史脏数据）→ 覆盖时一并清理，恢复「同日同客户唯一」不变量
        extras: archived.slice(1).map((r) => r.work_id),
        // 同维度残留的 pending 草稿一并清理（已归档优先，草稿作废）
        pendingExtras: pending.map((r) => r.work_id),
      });
    }
  }

  const createCnt = [...ACTIONS.values()].filter((v) => v.action === 'create').length;
  const skipCnt = [...ACTIONS.values()].filter((v) => v.action === 'skip_exact').length;
  const overwriteCnt = [...ACTIONS.values()].filter((v) => v.action === 'overwrite').length;
  const promoteCnt = [...ACTIONS.values()].filter((v) => v.action === 'promote_pending').length;
  const batchDupCnt = [...ACTIONS.values()].filter((v) => v.action === 'skip_batch_dup').length;

  // 本次文件覆盖的日期集合（升序）：用于前端把用户带到「已归档」视图对应日期，
  // 避免出现「导入成功但当前筛选日期看不到数据」的误解。
  const fileDates = [...new Set(parsed.map((p) => p.date))].sort();

  // ---------- 规则 2：全 skip_exact → 幂等成功（不写库、不报错） ----------
  // 重复导入同一份文件是正常操作（如网络重试、误点两次），返回 200 + noop 语义，
  // 由前端展示「已是最新，无需重复导入」的普通提示，而不是红色报错。
  if (overwriteCnt === 0 && createCnt === 0 && promoteCnt === 0 && (skipCnt > 0 || batchDupCnt > 0)) {
    const detail = parsed.map((p) => {
      const v = ACTIONS.get(p.line);
      if (v.action === 'skip_batch_dup') return `第 ${p.line} 行：${p.date} / ${p.customer_name}（文件内重复行）`;
      return `第 ${p.line} 行：${p.date} / ${p.customer_name}（已归档 work_id=${v.existing.work_id}，字段完全一致）`;
    }).join('\n');
    return res.json({
      ok: true, result: 'noop',
      created: 0, overwritten: 0, promoted: 0, skip_exact: skipCnt,
      skipped_batch_dup: batchDupCnt,
      noop: true,
      code: 'IMPORT_ALL_EXACT_MATCH',
      message: `本次无需写入（${skipCnt} 行与已归档一致${batchDupCnt ? `，${batchDupCnt} 行文件内重复` : ''}）。`,
      hint: `数据已归档在 ${fileDates.join('、')}，可在「状态=已归档」按该日期查看。`,
      dates: fileDates,
      detail,
      errors,
      lines: [],
    });
  }

  // ---------- 规则 1/3/4：启动事务执行 ----------
  const submitter = operatorName(req);
  let created = 0, overwritten = 0, promoted = 0, skippedExact = 0, skippedBatchDup = 0, repairedDuplicates = 0;
  const log = [];
  db.exec('BEGIN');
  try {
    for (const p of parsed) {
      const { action, existing, extras, pendingExtras } = ACTIONS.get(p.line);

      if (action === 'skip_batch_dup') {
        skippedBatchDup++;
        log.push({ line: p.line, action: 'skip_batch_dup' });
        continue;
      }

      if (action === 'skip_exact') {
        skippedExact++;
        log.push({ line: p.line, action: 'skip_exact', existing_work_id: existing.work_id });
        continue;
      }

      if (action === 'promote_pending') {
        // 未归档草稿 → 原地提交归档并写入导入值（不新增行，保证同维度唯一）
        const oldRow = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(existing.work_id);
        const r = {
          warehouse, work_type: '发货', customer_id: p.customer_id, customer_name: p.customer_name,
          unit: p.unit, date: p.date, ship_orders: p.ship_orders,
          main_hours: p.main_hours, other_hours: p.other_hours, shared_hours: 0,
        };
        svc.calcRow('发货', r);
        db.prepare(
          `UPDATE work_hours SET
             unit=?, ship_orders=?, main_hours=?, other_hours=?, shared_hours=?,
             total_hours=?, efficiency=?, unit_cost=?, remark=?, owner_user_id=?,
             status='archived', submitter=?, submit_time=datetime('now','localtime')
           WHERE work_id=?`
        ).run(r.unit, r.ship_orders, r.main_hours, r.other_hours, r.shared_hours,
          r.total_hours, r.efficiency, r.unit_cost, p.remark || null, req.user.user_id,
          submitter, existing.work_id);
        // 同维度多余草稿清理（只保留被提交的这一条）
        for (const dupId of (extras || [])) {
          const dupRow = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(dupId);
          if (!dupRow) continue;
          db.prepare('DELETE FROM work_hours WHERE work_id=?').run(dupId);
          writeAudit(req, 'force_delete', dupId, dupRow, JSON.stringify({
            note: '同维度多余未归档草稿清理（导入提交归档时修复）', kept_work_id: existing.work_id,
          }));
          repairedDuplicates++;
        }
        writeAudit(req, 'submit', existing.work_id, oldRow,
          db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(existing.work_id));
        promoted++;
        log.push({ line: p.line, action: 'promote_pending', work_id: existing.work_id });
        continue;
      }

      if (action === 'overwrite') {
        // DELETE 旧行（先深拷贝 old blob 用于审计）
        const oldRow = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(existing.work_id);
        db.prepare('DELETE FROM work_hours WHERE work_id=?').run(existing.work_id);
        // 一致性修复：同维度多余归档行一并清理（业务不变量：同仓+同日+同客户仅一条 archived）
        for (const dupId of (extras || [])) {
          const dupRow = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(dupId);
          if (!dupRow) continue;
          db.prepare('DELETE FROM work_hours WHERE work_id=?').run(dupId);
          writeAudit(req, 'force_archive_overwrite', dupId, dupRow, JSON.stringify({
            note: '同维度重复归档清理（导入覆盖时修复）', kept_work_id: existing.work_id,
          }));
          repairedDuplicates++;
        }
        // 同维度残留的 pending 草稿一并清理：已归档为准，避免同一数据同时出现在两个列表
        for (const dupId of (pendingExtras || [])) {
          const dupRow = db.prepare('SELECT * FROM work_hours WHERE work_id=?').get(dupId);
          if (!dupRow) continue;
          db.prepare('DELETE FROM work_hours WHERE work_id=?').run(dupId);
          writeAudit(req, 'force_delete', dupId, dupRow, JSON.stringify({
            note: '同维度未归档草稿清理（覆盖归档时修复）', kept_work_id: existing.work_id,
          }));
          repairedDuplicates++;
        }
        const r = {
          warehouse, work_type: '发货', customer_id: p.customer_id, customer_name: p.customer_name,
          unit: p.unit, date: p.date, ship_orders: p.ship_orders,
          main_hours: p.main_hours, other_hours: p.other_hours, shared_hours: 0,
        };
        svc.calcRow('发货', r);
        const info = db.prepare(
          `INSERT INTO work_hours
            (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,shared_hours,
             total_hours,efficiency,unit_cost,remark,owner_user_id,status,submitter,submit_time)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'archived', ?, datetime('now','localtime'))`
        ).run(warehouse, '发货', r.customer_id, r.customer_name, r.unit, r.date, r.ship_orders,
          r.main_hours, r.other_hours, r.shared_hours, r.total_hours, r.efficiency, r.unit_cost,
          p.remark || null, req.user.user_id, submitter);
        writeAudit(req, 'force_archive_overwrite', existing.work_id, oldRow, JSON.stringify({
          new_work_id: Number(info.lastInsertRowid), ship_orders: r.ship_orders, main_hours: r.main_hours,
        }));
        overwritten++;
        log.push({ line: p.line, action: 'overwrite', old_work_id: existing.work_id, new_work_id: Number(info.lastInsertRowid) });
        continue;
      }

      // action === 'create'
      const r = {
        warehouse, work_type: '发货', customer_id: p.customer_id, customer_name: p.customer_name,
        unit: p.unit, date: p.date, ship_orders: p.ship_orders,
        main_hours: p.main_hours, other_hours: p.other_hours, shared_hours: 0,
      };
      svc.calcRow('发货', r);
      const info = db.prepare(
        `INSERT INTO work_hours
          (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,shared_hours,
           total_hours,efficiency,unit_cost,remark,owner_user_id,status,submitter,submit_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'archived', ?, datetime('now','localtime'))`
      ).run(warehouse, '发货', r.customer_id, r.customer_name, r.unit, r.date, r.ship_orders,
        r.main_hours, r.other_hours, r.shared_hours, r.total_hours, r.efficiency, r.unit_cost,
        p.remark || null, req.user.user_id, submitter);
      created++;
      log.push({ line: p.line, action: 'create', work_id: Number(info.lastInsertRowid) });
    }
    // 边界校验（事务内，失败即整体回滚）：本次写入的每一行必须已归档且带提交时间，
    // 杜绝「写入成功但状态仍是 pending」造成的数据去向不明。
    const writtenIds = log
      .map((l) => l.work_id || l.new_work_id)
      .filter((id) => Number.isFinite(id) && id > 0);
    if (writtenIds.length) {
      const holders = writtenIds.map(() => '?').join(',');
      const bad = db.prepare(
        `SELECT COUNT(*) c FROM work_hours WHERE work_id IN (${holders}) AND (status<>'archived' OR submit_time IS NULL)`
      ).get(...writtenIds).c;
      if (bad > 0) throw new Error(`写入后状态校验失败：${bad} 行未正确归档`);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    return res.status(500).json({ error: '导入失败，已回滚：' + e.message });
  }

  writeAudit(req, 'import', 0, null, {
    warehouse, file: req.file.originalname, created, overwritten, promoted,
    skip_exact: skippedExact, skipped_batch_dup: skippedBatchDup,
    repaired_duplicates: repairedDuplicates, dates: fileDates,
    lines: log, errors,
  });
  const resp = {
    ok: true,
    result: (created > 0 || overwritten > 0 || promoted > 0) ? 'imported' : 'noop',
    created, overwritten, promoted, skip_exact: skippedExact,
    skipped_batch_dup: skippedBatchDup,
    repaired_duplicates: repairedDuplicates,
    dates: fileDates,
    errors, lines: log,
  };
  if (skippedExact > 0) {
    resp.warn = `已跳过 ${skippedExact} 行（与已归档数据完全一致，无需重复导入）`;
  }
  if (skippedBatchDup > 0) {
    resp.warn = (resp.warn ? resp.warn + '；' : '') + `已忽略 ${skippedBatchDup} 行文件内重复（同客户同日期只保留首条）`;
  }
  res.json(resp);
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
