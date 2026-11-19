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
const { setWarehouseSortPosition } = require('../services/warehouseSort');
const XLSX = require('xlsx');

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
    default_unit: s('default_unit') || '单',            // ★ 默认单位：空值兜底 '单'
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
  // 唯一性校验只查未删除客户（软删除客户的 customer_code/company_name 可重新使用）
  if (row.company_name && db.prepare('SELECT 1 FROM customers WHERE company_name=? AND is_deleted=0 AND customer_id!=?').get(row.company_name, excludeId))
    errs.push('公司全称已存在');
  if (row.customer_code && db.prepare('SELECT 1 FROM customers WHERE customer_code=? AND is_deleted=0 AND customer_id!=?').get(row.customer_code, excludeId))
    errs.push('货主代码已存在');
  return errs.length ? errs.join('；') : null;
}

// ---------- 列表：搜索 + 分类 + 多仓 LIKE + 分页 + 分仓独立排序 ----------
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const type = req.query.customer_type || '';
  const wh = req.query.warehouse || '';
  const coop = req.query.coop_status || '';
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));

  const where = ['c.is_deleted=0']; // 软删除客户从常规列表隐藏（仍在库、仍可被工时下拉/历史引用）
  const params = [];
  // ★ 重要：SQL 参数顺序必须严格匹配占位符出现顺序。
  // LEFT JOIN ON 的 ? 出现在 WHERE 之前，所以 wh 必须先 push！
  let joinWsc = '';
  if (wh) {
    if (!WAREHOUSES.includes(wh)) return res.status(400).json({ error: '仓库参数非法' });
    joinWsc = 'LEFT JOIN warehouse_sort_config wsc ON wsc.customer_id = c.customer_id AND wsc.warehouse = ?';
    params.push(wh);                       // ← JOIN ON 的第 1 个占位符最先 push
    where.push("',' || c.warehouse || ',' LIKE ?");
    params.push('%,' + wh + ',%');            // WHERE 的第 1 个占位符（整体 WHERE 里）精确边界匹配
  }
  const scope = ownerScope(req);
  if (scope.sql) { where.push(scope.sql.replace(/customers\./g, 'c.')); params.push(...scope.params); }
  if (type) {
    if (!CUSTOMER_TYPES.includes(type)) return res.status(400).json({ error: '客户类型非法' });
    where.push('c.customer_type = ?'); params.push(type);
  }
  if (coop) { where.push('c.coop_status = ?'); params.push(coop); }
  if (q) {
    where.push('(c.company_name LIKE ? OR c.short_name LIKE ? OR c.customer_code LIKE ? OR c.contact_person LIKE ? OR c.phone LIKE ? OR c.erp_version LIKE ?)');
    const like = '%' + q + '%';
    for (let i = 0; i < 6; i++) params.push(like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM customers c ${joinWsc} ${whereSql}`).get(...params).c;
  // 分仓排序优先：wsc.sort_order → c.sort_order → 9999
  const orderSql = wh
    ? 'ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id DESC'
    : 'ORDER BY c.sort_order ASC, c.customer_id DESC';
  const rows = db.prepare(
    `SELECT c.* ${wh ? ', COALESCE(wsc.sort_order, c.sort_order, 9999) AS warehouse_sort_order' : ''}
     FROM customers c ${joinWsc} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ data: rows, total, page, pageSize });
});

// ---------- 分仓独立排序配置 API ----------
// GET  /customers/warehouse-sort/:warehouse  → 读取该仓所有客户的排序配置
// PUT  /customers/warehouse-sort/:warehouse  → 批量 upsert 排序配置
router.get('/warehouse-sort/:warehouse', (req, res) => {
  const wh = req.params.warehouse;
  if (!WAREHOUSES.includes(wh)) return res.status(400).json({ error: '仓库参数非法' });
  const scope = ownerScope(req);
  const scopeSql = scope.sql ? 'WHERE ' + scope.sql : '';
  const rows = db.prepare(`
    SELECT c.customer_id, c.company_name,
           COALESCE(wsc.sort_order, c.sort_order, 9999) AS sort_order
    FROM customers c
    LEFT JOIN warehouse_sort_config wsc ON wsc.customer_id = c.customer_id AND wsc.warehouse = ?
    ${scopeSql}
    ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id DESC
  `).all(wh, ...scope.params);
  res.json({ warehouse: wh, data: rows });
});

router.put('/warehouse-sort/:warehouse', roleGate(['管理员', '超级管理员']), (req, res) => {
  const wh = req.params.warehouse;
  if (!WAREHOUSES.includes(wh)) return res.status(400).json({ error: '仓库参数非法' });
  const items = Array.isArray(req.body) ? req.body : (req.body.items || []);
  if (!items.length) return res.status(400).json({ error: '请提供排序配置' });

  // 按提交的 sort_order 升序确定顺序，重编号为 1..n；
  // 未提交的该仓其余客户按原排序追加在后，保证序号连续无空缺。
  const given = items
    .map((it, i) => ({ id: Number(it.customer_id), so: Number(it.sort_order), i }))
    .filter((x) => Number.isInteger(x.id) && x.id > 0)
    .sort((a, b) => (Number.isFinite(a.so) ? a.so : 1e9) - (Number.isFinite(b.so) ? b.so : 1e9) || a.i - b.i)
    .map((x) => x.id);
  const givenIds = new Set(given);

  const rest = db.prepare(`
    SELECT c.customer_id
      FROM customers c
      LEFT JOIN warehouse_sort_config wsc
             ON wsc.customer_id = c.customer_id AND wsc.warehouse = ?
     WHERE ',' || c.warehouse || ',' LIKE ? AND c.is_deleted = 0
     ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id ASC
  `).all(wh, '%,' + wh + ',%').map((r) => r.customer_id).filter((id) => !givenIds.has(id));

  const ordered = [...given, ...rest];
  const upsert = db.prepare(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order, updated_at)
    VALUES (?,?,?,datetime('now','localtime'))
    ON CONFLICT(warehouse, customer_id) DO UPDATE SET
      sort_order = excluded.sort_order,
      updated_at = datetime('now','localtime')`);

  db.exec('BEGIN');
  try {
    ordered.forEach((id, idx) => upsert.run(wh, id, idx + 1));
    db.exec('COMMIT');
    res.json({ warehouse: wh, saved: ordered.length, total: items.length });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
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
    where.push("',' || warehouse || ',' LIKE ?"); params.push('%,' + req.query.warehouse + ',%');
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
// ★ 分仓独立排序：传 warehouse 参数时 LEFT JOIN warehouse_sort_config，
//   ORDER BY 按 COALESCE(wsc.sort_order, c.sort_order, 9999) 保证工时下拉框与当前仓排序一致。
router.get('/options', (req, res) => {
  const wh = req.query.warehouse || '';
  const where = [];
  const params = [];

  // ★ SQL 参数顺序：JOIN ON 的 ? 必须先 push（和 GET / 列表同理）
  let joinWsc = '';
  if (wh && WAREHOUSES.includes(wh)) {
    joinWsc = 'LEFT JOIN warehouse_sort_config wsc ON wsc.customer_id = c.customer_id AND wsc.warehouse = ?';
    params.push(wh);  // JOIN ON 的 ? 先于 WHERE 条件参数
  }

  const scope = ownerScope(req);
  if (scope.sql) { where.push(scope.sql.replace(/customers\./g, 'c.')); params.push(...scope.params); }
  if (req.query.customer_type) { where.push('c.customer_type = ?'); params.push(req.query.customer_type); }
  if (wh && WAREHOUSES.includes(wh)) { where.push("',' || c.warehouse || ',' LIKE ?"); params.push('%,' + wh + ',%'); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderSql = wh
    ? `ORDER BY ${CUST_STATUS_SQL} DESC, COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.company_name`
    : `ORDER BY ${CUST_STATUS_SQL} DESC, c.sort_order ASC, c.company_name`;
  const rows = db.prepare(
    `SELECT c.customer_id,
            c.company_name,
            COALESCE(NULLIF(c.short_name,''), c.company_name) AS owner_name,
            c.warehouse, c.customer_type, c.coop_status, c.is_deleted,
            ${CUST_STATUS_SQL} AS status,
            COALESCE(c.default_unit, '单') AS default_unit
       FROM customers c ${joinWsc} ${whereSql} ${orderSql}`
  ).all(...params);
  res.json({ data: rows });
});

// ---------- 导出当前筛选下的全部客户（分仓独立 Sheet） ----------
// GET  /customers/export?customer_type=&warehouse=&q=&coop_status=
//   * 复用列表接口筛选逻辑，但不分页（pageSize=10000）
//   * 仓储客户：每个仓库一个 Sheet，客户所属多个仓库 → 同时出现在多个 Sheet
//   * 非仓储客户：单一 Sheet（"共享单号" 或 "快运物流"）
//   * 仓库为空的客户 → 放入"未分配仓库" Sheet
router.get('/export', (req, res) => {
  if (!hasMenuPerm(req.user, 'cust_wh', 'cust_shared', 'cust_express')) {
    return res.status(403).json({ error: '无客户菜单权限' });
  }

  const q = (req.query.q || '').trim();
  const type = req.query.customer_type || '仓储客户';
  const wh = req.query.warehouse || '';
  const coop = req.query.coop_status || '';

  if (!CUSTOMER_TYPES.includes(type)) return res.status(400).json({ error: '客户类型非法' });
  if (wh && !WAREHOUSES.includes(wh)) return res.status(400).json({ error: '仓库参数非法' });

  // 复用列表接口的筛选 SQL（不分页，pageSize=10000 覆盖全部活跃客户）
  const where = ['c.is_deleted=0'];
  const params = [];
  let joinWsc = '';
  if (type === '仓储客户') {
    // 仓储客户列表页永远按仓库 LIKE 过滤；导出允许不带 warehouse → 导出全部仓
    if (wh) {
      joinWsc = 'LEFT JOIN warehouse_sort_config wsc ON wsc.customer_id = c.customer_id AND wsc.warehouse = ?';
      params.push(wh);
      where.push("',' || c.warehouse || ',' LIKE ?");
      params.push('%,' + wh + ',%');
    }
  }
  const scope = ownerScope(req);
  if (scope.sql) { where.push(scope.sql.replace(/customers\./g, 'c.')); params.push(...scope.params); }
  where.push('c.customer_type = ?'); params.push(type);
  if (coop) { where.push('c.coop_status = ?'); params.push(coop); }
  if (q) {
    where.push('(c.company_name LIKE ? OR c.short_name LIKE ? OR c.customer_code LIKE ? OR c.contact_person LIKE ? OR c.phone LIKE ? OR c.erp_version LIKE ?)');
    const like = '%' + q + '%';
    for (let i = 0; i < 6; i++) params.push(like);
  }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const rows = db.prepare(`
    SELECT c.* ${wh ? ', COALESCE(wsc.sort_order, c.sort_order, 9999) AS warehouse_sort_order' : ''}
      FROM customers c ${joinWsc} ${whereSql}
      ORDER BY c.customer_id ASC
  `).all(...params);

  if (!rows.length) {
    return res.status(404).json({ error: '当前筛选条件下无客户数据可导出' });
  }

  // 导出表头（列顺序与列表页展示一致，再补齐完整资料）
  const HEADERS = [
    '排序号（分仓）', '货主代码', '公司全称', '所在仓库', '客户简称',
    '截单时间', '预充单价', '合作状态', '联系人', '联系电话', '地址',
    'ERP 版本', '商品类型', '电商平台', '商品种类数', '默认单位',
    '支付账号', '物流管控', '效期管理', '备注', '客户分类', '创建时间', '更新时间',
  ];

  // 辅助：把一行客户转成导出行
  function rowToExport(c, targetWh) {
    // 排序号：有分仓 warehouse_sort_order 优先（列表页展示的那个），否则全局 sort_order，9999 显示为空
    const sort = c.warehouse_sort_order != null ? c.warehouse_sort_order : (c.sort_order || 9999);
    return [
      sort === 9999 ? '' : sort,
      c.customer_code || '',
      c.company_name || '',
      targetWh || c.warehouse || '',    // 当前 Sheet 的仓库名（仓储客户）或原始 warehouse 字段
      c.short_name || '',
      c.cutoff_time || '',
      c.prepaid_price != null ? Number(c.prepaid_price).toFixed(3) : '',
      c.coop_status || '',
      c.contact_person || '',
      c.phone || '',
      c.address || '',
      c.erp_version || '',
      c.product_type || '',
      c.ecommerce_platform || '',
      c.product_count != null ? c.product_count : 0,
      c.default_unit || '单',
      c.payment_account || '',
      c.logistics_control || '',
      c.expiry_mgmt || '',
      c.remark || '',
      c.customer_type || '',
      c.created_at || '',
      c.updated_at || '',
    ];
  }

  const wb = XLSX.utils.book_new();

  if (type === '仓储客户') {
    // 仓储客户：每个仓库一个 Sheet，客户所属多仓 → 同时出现在多 Sheet
    // 先按仓库拆。没有 warehouse 的放"未分配仓库"
    const groups = new Map();
    const NO_WH = '未分配仓库';

    rows.forEach((c) => {
      const whList = String(c.warehouse || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      const targets = whList.length ? whList : [NO_WH];
      targets.forEach((w) => {
        if (!WAREHOUSES.includes(w) && w !== NO_WH) return; // 跳过非法仓名
        if (!groups.has(w)) groups.set(w, []);
        groups.get(w).push(c);
      });
    });

    // 每个仓库组再单独拉分仓独立排序（保证排序和列表页一致）
    groups.forEach((list, whName) => {
      let orderedList = list;
      if (whName !== NO_WH) {
        // 用 COALESCE(wsc.sort_order, c.sort_order, 9999) 排序
        const placeholders = list.map(() => '?').join(',');
        const ids = list.map((c) => c.customer_id);
        const orderedIds = db.prepare(`
          SELECT c.customer_id
            FROM customers c
            LEFT JOIN warehouse_sort_config wsc
                   ON wsc.customer_id = c.customer_id AND wsc.warehouse = ?
           WHERE c.customer_id IN (${placeholders})
           ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id ASC
        `).all(whName, ...ids).map((r) => r.customer_id);
        orderedList = orderedIds.map((id) => list.find((c) => c.customer_id === id)).filter(Boolean);
      }
      const aoa = [HEADERS, ...orderedList.map((c) => rowToExport(c, whName))];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // 设置列宽（全给个默认宽度）
      ws['!cols'] = HEADERS.map(() => ({ wch: 14 }));
      XLSX.utils.book_append_sheet(wb, ws, whName);
    });
  } else {
    // 非仓储客户（共享单号 / 快运物流）：单一 Sheet
    const aoa = [HEADERS, ...rows.map((c) => rowToExport(c, ''))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = HEADERS.map(() => ({ wch: 14 }));
    XLSX.utils.book_append_sheet(wb, ws, type);
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `${type}_客户资料_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
  res.send(buf);
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

// ---------- sort_order 冲突处理（全局 customer_type 级，向后兼容） ----------
// 作用域：同一 customer_type 下全局排序（跨仓库），保证序号唯一且连续。
// 逻辑：把 sort_order >= target（且非当前记录）的记录统一 +1，腾出空位给当前记录。
// 注意：历史数据可能存在重复 sort_order，顺延会让所有 >= target 的都后移，天然消除重复。
function adjustSortOrder(customerType, target, excludeId = 0) {
  if (!Number.isInteger(target) || target <= 0) return; // 非法值交给 normalizeForm 兜底
  db.prepare(
    `UPDATE customers SET sort_order = sort_order + 1
      WHERE customer_type = ? AND is_deleted = 0 AND sort_order >= ? AND customer_id != ?`
  ).run(customerType, target, excludeId);
}

// 分仓独立排序见 services/warehouseSort.js：位置式重排，保证单仓序号连续 1..n

// ---------- 详情/CRUD 通用：注入所有仓的独立排序到客户对象 ----------
function enrichWithWarehouseSorts(row) {
  if (!row) return row;
  const wscRows = db.prepare('SELECT warehouse, sort_order FROM warehouse_sort_config WHERE customer_id=? AND sort_order < 9999')
    .all(row.customer_id);
  const warehouse_sorts = {};
  for (const wh of WAREHOUSES) {
    const hit = wscRows.find(x => x.warehouse === wh);
    warehouse_sorts[wh] = hit ? hit.sort_order : null;  // null 表示未设置，回退全局 sort_order
  }
  row.warehouse_sorts = warehouse_sorts;
  return row;
}

// ---------- 分仓排序入参校验（返回错误文案或 null） ----------
function validateWarehouseSorts(warehouseSorts, warehouseList) {
  if (!warehouseSorts || typeof warehouseSorts !== 'object' || Array.isArray(warehouseSorts)) return null;
  for (const [wh, soVal] of Object.entries(warehouseSorts)) {
    if (!WAREHOUSES.includes(wh)) return '排序仓库参数非法：' + wh;
    if (soVal === '' || soVal == null) continue;           // 留空 = 该仓不设置
    if (!warehouseList.includes(wh)) continue;             // 客户不属于该仓 → 忽略
    const so = Number(soVal);
    if (!Number.isInteger(so) || so <= 0) return `${wh}排序号必须为正整数`;
  }
  return null;
}

// ---------- 单条 CRUD ----------
router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '客户不存在' });
  if (!ensureOwn(req, r)) return res.status(403).json({ error: '无权访问他人负责的客户' });
  // 注入所有仓的独立排序配置，供详情页多仓 sort_order 回填
  enrichWithWarehouseSorts(r);
  res.json({ data: r });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const type = String(b.customer_type || '仓储客户');
  const row = normalizeForm(b);
  const err = validate(row, { type });
  if (err) return res.status(400).json({ error: err });

  // ★ 分仓独立 sort_order：校验（客户所属仓之外的值忽略）
  const warehouseSorts = b.warehouse_sorts;
  const hasWhSorts = !!(warehouseSorts && typeof warehouseSorts === 'object' && !Array.isArray(warehouseSorts));
  const whList = String(row.warehouse || '').split(',').map((s) => s.trim()).filter(Boolean);
  const wsErr = validateWarehouseSorts(warehouseSorts, whList);
  if (wsErr) return res.status(400).json({ error: wsErr });

  const owner_user_id = req.user.data_scope === 'self'
    ? req.user.user_id
    : (b.owner_user_id != null ? b.owner_user_id : req.user.user_id);
  const cols = [...Object.keys(row), 'customer_type', 'owner_user_id'];

  let created;
  db.exec('BEGIN');
  try {
    // 无分仓排序时，走旧的全局 sort_order 顺延
    if (!hasWhSorts && row.sort_order !== 9999 && Number.isInteger(row.sort_order) && row.sort_order > 0) {
      adjustSortOrder(type, row.sort_order, 0);
    }
    const info = db.prepare(
      `INSERT INTO customers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    ).run(...Object.keys(row).map((k) => row[k]), type, owner_user_id);

    if (hasWhSorts) {
      for (const [wh, soVal] of Object.entries(warehouseSorts)) {
        if (!WAREHOUSES.includes(wh) || !whList.includes(wh)) continue;
        if (soVal === '' || soVal == null) continue;
        setWarehouseSortPosition(db, wh, info.lastInsertRowid, soVal);
      }
    }
    created = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(info.lastInsertRowid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '新增失败：' + e.message });
  }

  enrichWithWarehouseSorts(created);
  writeAudit(req, 'create', created.customer_id, null, created);
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

  // ★ 分仓独立 sort_order：位置式重排（先改客户基本资料，再按仓重排）
  const warehouseSorts = b.warehouse_sorts;
  const hasWhSorts = !!(warehouseSorts && typeof warehouseSorts === 'object' && !Array.isArray(warehouseSorts));
  const whList = String(row.warehouse || '').split(',').map((s) => s.trim()).filter(Boolean);
  const wsErr = validateWarehouseSorts(warehouseSorts, whList);
  if (wsErr) return res.status(400).json({ error: wsErr });

  const keys = Object.keys(row);
  let updated;
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE customers SET ${keys.map((k) => k + '=?').join(',')}, customer_type=?, updated_at=datetime('now','localtime') WHERE customer_id=?`
    ).run(...keys.map((k) => row[k]), type, old.customer_id);

    if (hasWhSorts) {
      for (const [wh, soVal] of Object.entries(warehouseSorts)) {
        if (!WAREHOUSES.includes(wh) || !whList.includes(wh)) continue;
        if (soVal === '' || soVal == null) continue;
        setWarehouseSortPosition(db, wh, old.customer_id, soVal);
      }
    } else if (row.sort_order !== old.sort_order
        && row.sort_order !== 9999
        && Number.isInteger(row.sort_order) && row.sort_order > 0) {
      // ★ 用户只改了全局 sort_order → 说明他想统一，清掉所有仓的分仓排序配置
      // 否则 COALESCE(wsc, c, 9999) 优先选 wsc → 列表显示看起来没变化（用户反馈的 bug）
      db.prepare('DELETE FROM warehouse_sort_config WHERE customer_id=?').run(old.customer_id);
      adjustSortOrder(type, row.sort_order, old.customer_id);
    } else if (row.sort_order !== old.sort_order && row.sort_order === 9999) {
      // 用户把排序号清空（= 排最后）→ 同样清掉 wsc 让 COALESCE 回退到 9999
      db.prepare('DELETE FROM warehouse_sort_config WHERE customer_id=?').run(old.customer_id);
    }

    updated = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(old.customer_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '保存失败：' + e.message });
  }

  enrichWithWarehouseSorts(updated);
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
