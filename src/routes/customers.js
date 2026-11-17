// 客户资料路由（重构：18 业务字段 + 三分类 + 多仓 LIKE + Excel 模板导入/Upsert）
// 分类：仓储客户 / 共享单号 / 快运物流；Excel 导入按「公司全称」Upsert（用户确认口径）
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { ownerScope, readonlyGate, ensureOwn, roleGate, hasMenuPerm } = require('../middleware/rbac');
const multer = require('multer');
const round3 = require('../utils/round');
const {
  WAREHOUSES, COOP, CUTOFF_RE,
  readSheet, parseRow, normalizeWarehouse, buildTemplate,
} = require('../services/customerImport');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const CUSTOMER_TYPES = ['仓储客户', '共享单号', '快运物流'];

router.use(auth);
router.use(readonlyGate); // 查看者仅可查看，禁止新增/编辑/导入

// RBAC 菜单门禁：一份路由服务三个客户分类菜单，按 customer_type 精确映射
// （带 :id 的路由回查行内 customer_type；/template 放行任一分类；/import 在
//  multer 解析后于处理器内校验，因为 multipart body 此时尚未解析）
const TYPE_PATH = { 仓储客户: 'cust_wh', 共享单号: 'cust_shared', 快运物流: 'cust_express' };
router.use((req, res, next) => {
  // 公共端点放行：导入/模板/active/options（工时·订单下拉用，行内已按 owner 隔离）
  if (req.path === '/import' || req.path === '/template' || req.path === '/active' || req.path === '/options') return next();
  let type = (req.query && req.query.customer_type) || (req.body && req.body.customer_type) || '';
  // 注意：router.use 中间件里 req.params 恒为 {}（Express 不为 use 填充路由参数），
  // 带 :id 的 PUT/DELETE 必须从相对路径解析 id 回查行内 customer_type；
  // 行不存在 → 放行给路由处理（返回 404），而非在此 400
  if (!type) {
    const idMatch = /^\/(\d+)(?:\/|$)/.exec(req.path || '');
    if (idMatch) {
      const row = db.prepare('SELECT customer_type FROM customers WHERE customer_id=?').get(idMatch[1]);
      if (!row) return next();
      type = row.customer_type;
    } else {
      return next(); // 不带分类的列表/搜索查询放行（前端三子菜单均显式传 customer_type）
    }
  }
  const p = TYPE_PATH[type];
  if (!p) return res.status(400).json({ error: 'customer_type 参数非法（仓储客户/共享单号/快运物流）' });
  if (!hasMenuPerm(req.user, p)) return res.status(403).json({ error: '无该客户分类菜单权限' });
  next();
});

// ---------- 手工表单：归一化 + 校验 ----------
function normalizeForm(b) {
  const s = (k) => (b[k] == null ? '' : String(b[k]).trim());
  const whRaw = Array.isArray(b.warehouse) ? b.warehouse.join(',') : s('warehouse');
  return {
    customer_code: s('customer_code') || null,     // 选填：空串转 NULL（UNIQUE 允许多条 NULL）
    company_name: s('company_name'),               // 必填，Upsert 业务主键
    short_name: s('short_name'),
    warehouse: normalizeWarehouse(whRaw).value,    // 多选数组 / 中文顿号 → 英文逗号
    contact_person: s('contact_person'),
    phone: s('phone'),
    address: s('address'),
    erp_version: s('erp_version'),
    product_type: s('product_type'),
    ecommerce_platform: s('ecommerce_platform'),
    product_count: b.product_count === '' || b.product_count == null ? 0 : Number(b.product_count),
    payment_account: s('payment_account'),
    prepaid_price: round3(b.prepaid_price === '' || b.prepaid_price == null ? 0 : Number(b.prepaid_price)),
    cutoff_time: s('cutoff_time') || null,
    logistics_control: s('logistics_control'),
    expiry_mgmt: s('expiry_mgmt') || '否',
    coop_status: s('coop_status') || '合作中',
    sort_order: b.sort_order === '' || b.sort_order == null ? 9999 : Number(b.sort_order),
    remark: s('remark'),
  };
}

function validate(row, { type, excludeId = 0 } = {}) {
  const errs = [];
  if (!row.company_name) errs.push('公司全称必填');
  if (type === '仓储客户' && !row.warehouse) errs.push('所在仓库必填');
  const badWh = row.warehouse.split(',').filter((w) => w && !WAREHOUSES.includes(w));
  if (badWh.length) errs.push('所在仓库含非法仓名：' + badWh.join('、'));
  if (type && !CUSTOMER_TYPES.includes(type)) errs.push('客户类型非法');
  if (!COOP.includes(row.coop_status)) errs.push('合作状态非法（' + COOP.join('/') + '）');
  if (!['是', '否'].includes(row.expiry_mgmt)) errs.push('效期管理应为 是/否');
  if (row.cutoff_time && !CUTOFF_RE.test(row.cutoff_time)) errs.push('截单时间格式应为 HH:mm');
  if (!Number.isInteger(row.product_count) || row.product_count < 0) errs.push('商品种类数必须为非负整数');
  if (isNaN(row.prepaid_price) || row.prepaid_price < 0) errs.push('预充单价必须为非负数字');
  if (row.company_name && db.prepare('SELECT 1 FROM customers WHERE company_name=? AND customer_id!=?').get(row.company_name, excludeId))
    errs.push('公司全称已存在');
  if (row.customer_code && db.prepare('SELECT 1 FROM customers WHERE customer_code=? AND customer_id!=?').get(row.customer_code, excludeId))
    errs.push('货主代码已存在');
  return errs.length ? errs.join('；') : null;
}

// ---------- 列表：搜索 + 分类 + 多仓 LIKE + 分页 ----------
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const type = req.query.customer_type || '';
  const wh = req.query.warehouse || '';
  const coop = req.query.coop_status || '';
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));

  const where = ['is_deleted=0']; // 软删除客户从常规列表隐藏（仍在库、仍可被工时下拉/历史引用）
  const params = [];
  const scope = ownerScope(req);
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (type) {
    if (!CUSTOMER_TYPES.includes(type)) return res.status(400).json({ error: '客户类型非法' });
    where.push('customer_type = ?'); params.push(type);
  }
  if (wh) {
    // 白名单防 LIKE 注入；'龙湖仓,佳新仓' 在两个仓 Tab 下都能命中
    if (!WAREHOUSES.includes(wh)) return res.status(400).json({ error: '仓库参数非法' });
    where.push('warehouse LIKE ?'); params.push('%' + wh + '%');
  }
  if (coop) { where.push('coop_status = ?'); params.push(coop); }
  if (q) {
    where.push('(company_name LIKE ? OR short_name LIKE ? OR customer_code LIKE ? OR contact_person LIKE ? OR phone LIKE ? OR erp_version LIKE ?)');
    const like = '%' + q + '%';
    for (let i = 0; i < 6; i++) params.push(like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM customers ${whereSql}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM customers ${whereSql} ORDER BY customer_id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ data: rows, total, page, pageSize });
});

// 客户状态统一口径（下拉/列表/标签共用，避免各处 CASE 漂移）
//   is_deleted=1 → 已删除（最高优先）；coop_status<>'合作中' → 停用；否则 启用
const CUST_STATUS_SQL = `CASE WHEN is_deleted=1 THEN '已删除'
                              WHEN coop_status<>'合作中' THEN '停用'
                              ELSE '启用' END`;

// ---------- 客户下拉（兼容别名，令工时/订单前端零改动） ----------
// 注意：/active 只返回「合作中且未删除」的客户，供订单等只 accepting 新业务的场景使用；
//       工时下拉请用 /options（含已删除/停用，前端自行置灰）。
router.get('/active', (req, res) => {
  const where = ["coop_status='合作中'", 'is_deleted=0'];
  const params = [];
  const scope = ownerScope(req);
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.customer_type) { where.push('customer_type = ?'); params.push(req.query.customer_type); }
  if (req.query.warehouse && WAREHOUSES.includes(req.query.warehouse)) {
    where.push('warehouse LIKE ?'); params.push('%' + req.query.warehouse + '%');
  }
  const rows = db.prepare(
    `SELECT customer_id,
            company_name AS customer_name,
            COALESCE(NULLIF(short_name,''), company_name) AS owner_name,
            '启用' AS status,
            owner_user_id,
            COALESCE(default_unit, '单') AS default_unit
       FROM customers WHERE ${where.join(' AND ')} ORDER BY sort_order ASC, company_name`
  ).all(...params);
  res.json({ data: rows });
});

// ---------- 工时下拉专用：返回全部客户（含已删除/停用），带 status ----------
// 铁律：已删除客户的行永久保留，因此这里能返回它们；前端负责加 (已删除)/(已停用) 后缀并置灰。
// ownerScope 行级隔离仍生效（业务员只见自己负责的客户）。
router.get('/options', (req, res) => {
  const where = [];
  const params = [];
  const scope = ownerScope(req);
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.customer_type) { where.push('customer_type = ?'); params.push(req.query.customer_type); }
  if (req.query.warehouse && WAREHOUSES.includes(req.query.warehouse)) {
    where.push('warehouse LIKE ?'); params.push('%' + req.query.warehouse + '%');
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT customer_id,
            company_name,
            COALESCE(NULLIF(short_name,''), company_name) AS owner_name,
            warehouse, customer_type, coop_status, is_deleted,
            ${CUST_STATUS_SQL} AS status,
            COALESCE(default_unit, '单') AS default_unit
       FROM customers ${whereSql}
      ORDER BY ${CUST_STATUS_SQL} DESC, sort_order ASC, company_name`
  ).all(...params);
  res.json({ data: rows });
});

// ---------- 下载导入模板（必须排在 /:id 之前；持任一客户分类授权即可） ----------
router.get('/template', (req, res) => {
  if (!hasMenuPerm(req.user, 'cust_wh', 'cust_shared', 'cust_express')) {
    return res.status(403).json({ error: '无客户菜单权限' });
  }
  const buf = buildTemplate(true);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="warehouse_customers_template.xlsx"');
  res.send(buf);
});

// ---------- Excel 导入（按公司全称 Upsert + 失败清单） ----------
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  const type = String(req.body.customer_type || '仓储客户');
  if (!CUSTOMER_TYPES.includes(type)) return res.status(400).json({ error: '客户类型非法' });
  // RBAC：multipart 在 multer 解析后校验（门禁中间件阶段 body 未解析）
  if (!hasMenuPerm(req.user, TYPE_PATH[type])) return res.status(403).json({ error: '无该客户分类菜单权限' });

  let items;
  try { items = readSheet(req.file.buffer); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!items.length) return res.status(400).json({ error: '文件中没有数据行（请保留表头）' });

  const failures = [];
  let created = 0, updated = 0;
  items.forEach(({ excelRow, raw }) => {
    const { row, error } = parseRow(raw, { requireWarehouse: type === '仓储客户' });
    if (error) return failures.push({ row: excelRow, reason: error, data: raw });

    const old = db.prepare('SELECT * FROM customers WHERE company_name=?').get(row.company_name);
    const cols = Object.keys(row);
    db.exec('BEGIN');
    try {
      if (old) {
        // 命中已软删除的同名客户 → 视为「恢复」：复活标记置 0，历史工时关联与审计链完整保留
        db.prepare(
          `UPDATE customers SET ${cols.map((c) => c + '=?').join(',')}, customer_type=?, is_deleted=0, updated_at=datetime('now','localtime') WHERE customer_id=?`
        ).run(...cols.map((c) => row[c]), type, old.customer_id);
        writeAudit(req, old.is_deleted ? 'restore' : 'update', old.customer_id, old, { ...old, ...row, customer_type: type, is_deleted: 0 });
        updated++;
      } else {
        const all = [...cols, 'customer_type', 'owner_user_id'];
        const info = db.prepare(
          `INSERT INTO customers (${all.join(',')}) VALUES (${all.map(() => '?').join(',')})`
        ).run(...cols.map((c) => row[c]), type, req.user.user_id);
        writeAudit(req, 'create', info.lastInsertRowid, null, { ...row, customer_type: type, owner_user_id: req.user.user_id });
        created++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      failures.push({ row: excelRow, reason: '写入失败：' + e.message, data: raw });
    }
  });

  // 导入批次本身补一条「导入」日志（逐行 create/update 明细日志保持不变）
  require('../services/auditLog').writeLog(req, {
    table: 'customers', module: '客户资料', action: 'import',
    targetId: 'import:' + (req.file.originalname || 'customers.xlsx'),
    content: {
      customer_type: type, file: req.file.originalname || '',
      created, updated, failed: failures.length,
      failures: failures.slice(0, 50),
    },
  });

  res.json({ success: created + updated, created, updated, failed: failures.length, failures });
});

// ---------- 单条 CRUD ----------
router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '客户不存在' });
  if (!ensureOwn(req, r)) return res.status(403).json({ error: '无权访问他人负责的客户' });
  res.json({ data: r });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const type = String(b.customer_type || '仓储客户');
  const row = normalizeForm(b);
  const err = validate(row, { type });
  if (err) return res.status(400).json({ error: err });

  const owner_user_id = req.user.data_scope === 'self'
    ? req.user.user_id
    : (b.owner_user_id != null ? b.owner_user_id : req.user.user_id);
  const cols = [...Object.keys(row), 'customer_type', 'owner_user_id'];
  const info = db.prepare(
    `INSERT INTO customers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...Object.keys(row).map((k) => row[k]), type, owner_user_id);
  const created = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(info.lastInsertRowid);
  writeAudit(req, 'create', info.lastInsertRowid, null, created);
  res.status(201).json({ data: created });
});

router.put('/:id', (req, res) => {
  const b = req.body || {};
  const old = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '客户不存在' });
  if (!ensureOwn(req, old)) return res.status(403).json({ error: '无权修改他人负责的客户' });

  const type = String(b.customer_type || old.customer_type);   // 类型由所在页面锁定
  const row = normalizeForm({ ...old, ...b });                 // 未传字段沿用旧值
  const err = validate(row, { type, excludeId: old.customer_id });
  if (err) return res.status(400).json({ error: err });

  const keys = Object.keys(row);
  db.prepare(
    `UPDATE customers SET ${keys.map((k) => k + '=?').join(',')}, customer_type=?, updated_at=datetime('now','localtime') WHERE customer_id=?`
  ).run(...keys.map((k) => row[k]), type, old.customer_id);
  const updated = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(old.customer_id);
  writeAudit(req, 'update', old.customer_id, old, updated);
  res.json({ data: updated });
});

// 合作状态切换：合作中 ↔ 暂停（兼容原「停用/启用」按钮语义）
router.post('/:id/toggle-status', (req, res) => {
  const old = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '客户不存在' });
  if (!ensureOwn(req, old)) return res.status(403).json({ error: '无权操作他人负责的客户' });
  const next = old.coop_status === '合作中' ? '暂停' : '合作中';
  db.prepare("UPDATE customers SET coop_status=?, updated_at=datetime('now','localtime') WHERE customer_id=?")
    .run(next, old.customer_id);
  const row = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(old.customer_id);
  writeAudit(req, 'update', old.customer_id, old, row);
  res.json({ data: row });
});

// 删除客户：仅 管理员/超级管理员；【软删除】只打 is_deleted=1 标记，行永久保留。
// 铁律：绝不物理删除已关联工时/订单的客户数据——行在，则 orders.customer_id 外键、
//       work_hours.customer_id 关联、按名字记录的历史流水与审计链全部原样保留。
// 因此解除旧版「有关联即 409 阻断」限制；已删除客户在工时下拉显示 (已删除) 并置灰。
// 双重防线：前端按角色隐藏按钮，后端 roleGate 二次校验（绕过前端直调也会 403）。
router.delete('/:id', roleGate('管理员', '超级管理员'), (req, res) => {
  const old = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '客户不存在' });
  if (!ensureOwn(req, old)) return res.status(403).json({ error: '无权删除他人负责的客户' });
  if (old.is_deleted === 1) return res.status(409).json({ error: '该客户已处于删除状态，无需重复操作' });

  // 关联计数仅用于审计留痕与前端提示，不再阻断删除
  const names = [...new Set([old.company_name, old.short_name].filter(Boolean))];
  const inClause = names.map(() => '?').join(',');
  const orderCnt = db.prepare('SELECT COUNT(*) c FROM orders WHERE customer_id=?').get(old.customer_id).c;
  const whCnt = db.prepare(`SELECT COUNT(*) c FROM work_hours WHERE customer_name IN (${inClause})`).get(...names).c;
  const ivCnt = db.prepare(`SELECT COUNT(*) c FROM inventory_transactions WHERE owner_name IN (${inClause})`).get(...names).c;

  db.exec('BEGIN');
  try {
    // 软删除：只置标记 + 时间戳；不 DELETE、不改任何业务字段、不动任何关联
    db.prepare("UPDATE customers SET is_deleted=1, updated_at=datetime('now','localtime') WHERE customer_id=?")
      .run(old.customer_id);
    writeAudit(req, 'delete', old.customer_id, old,
      { deleted: true, soft: true, company_name: old.company_name, customer_type: old.customer_type,
        detail: { orders: orderCnt, work_hours: whCnt, inventory_transactions: ivCnt } });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '删除失败：' + e.message });
  }
  res.json({ data: { customer_id: old.customer_id, company_name: old.company_name, deleted: true, soft: true } });
});

// 恢复客户：把软删除标记置回 0（关联的历史工时/订单全程未动，恢复即重新可用）
router.post('/:id/restore', roleGate('管理员', '超级管理员'), (req, res) => {
  const old = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '客户不存在' });
  if (!ensureOwn(req, old)) return res.status(403).json({ error: '无权操作他人负责的客户' });
  if (old.is_deleted !== 1) return res.status(409).json({ error: '该客户未处于删除状态' });
  db.prepare("UPDATE customers SET is_deleted=0, updated_at=datetime('now','localtime') WHERE customer_id=?")
    .run(old.customer_id);
  const row = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(old.customer_id);
  writeAudit(req, 'restore', old.customer_id, old, row);
  res.json({ data: row });
});

// 审计：统一走全局日志服务（新旧字段双写，模块=客户资料）
function writeAudit(req, action, recordId, before, after) {
  require('../services/auditLog').writeLog(req, {
    table: 'customers', module: '客户资料', action,
    targetId: recordId, before, after,
  });
}

module.exports = router;
