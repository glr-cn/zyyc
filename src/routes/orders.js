// 订单 Excel 导入（阶段 2）
// 模板字段：订单号、客户名称、货主名称、发货量、单位、订单日期
// 校验：客户名称存在 / 货主名称存在且匹配 / 发货量正数 / 单位∈{件,箱,托,公斤} / 日期合法 / 客户须启用
// 成功行：写 orders + 自动生成 sale 出库流水 + 写审计；失败行进入"导入失败清单"（原始行号+原因）
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { ownerScope, readonlyGate, menuGate } = require('../middleware/rbac');
const multer = require('multer');
const round3 = require('../utils/round');
const { readRows, pick, parseDate } = require('../utils/excel');
const XLSX = require('xlsx');
const {
  WMS_PLATFORMS, UNIFIED_COLUMNS,
  processImport,
} = require('../services/ordersImport');
const ordersQuery = require('../services/ordersQuery');
const auditLog = require('../services/auditLog');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const UNITS = ['件', '箱', '托', '公斤'];

// 订单查询模块：确保 to_district 列存在（幂等，先于任何查询/导入）
ordersQuery.ensureDistrictColumn(db);

// ---------- 模板字段元数据（前端/后端共享） ----------
const TEMPLATE_FIELDS = [
  { key: 'order_no',      name: '订单号',     required: false, sample: 'ORD20250101001', note: '留空则系统自动生成（ORD+时间戳+随机数）' },
  { key: 'customer_name', name: '客户名称',   required: true,  sample: '杭州绵绵的羊网络科技有限公司', note: '必须匹配 customers.company_name 或 short_name' },
  { key: 'owner_name',    name: '货主名称',   required: true,  sample: '杭州绵绵的羊网络科技有限公司', note: '必须与客户名称/简称匹配，且该客户 coop_status=合作中' },
  { key: 'ship_quantity', name: '发货量',     required: true,  sample: '1200', note: '正数；自动保留 3 位小数' },
  { key: 'unit',          name: '单位',       required: true,  sample: '件',   note: '必须是：件 / 箱 / 托 / 公斤 四选一' },
  { key: 'order_date',    name: '订单日期',   required: true,  sample: '2025-01-15', note: '日期格式 YYYY-MM-DD（Excel 日期序列号会自动转换）' },
  { key: 'payment_status',name: '付款状态',   required: false, sample: '未收',  note: '未收（默认）/ 部分 / 已收' },
];
const REQUIRED_NAMES = TEMPLATE_FIELDS.filter((f) => f.required).map((f) => f.name);

router.use(auth);
router.use(readonlyGate);
router.use(menuGate('orders'));

// ============================================================================
// 偏远地区方案管理（region_plans + region_plan_overrides）
// ----------------------------------------------------------------------------
// 设计：
//   - shentong_region_class 是静态种子（申通默认规则，不可改）
//   - region_plans 是用户可编辑方案，每个方案有若干 province→class 覆盖
//   - 有效 region_class = 方案覆盖 → shentong_region_class 精确 → 省级 → 正常
//   - 默认方案（id=1）无覆盖，完全等于 shentong_region_class
// ============================================================================

// --- 幂等建表（首次启动自动执行）---
(function initRegionPlanTables() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS region_plans (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        is_default  INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS region_plan_overrides (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id       INTEGER NOT NULL REFERENCES region_plans(id) ON DELETE CASCADE,
        province      TEXT NOT NULL,
        city          TEXT,
        region_class  TEXT NOT NULL CHECK(region_class IN ('大偏远','小偏远','正常')),
        UNIQUE (plan_id, province, city)
      );
    `);
    // 默认方案：首次启动时自动创建
    const cnt = db.prepare('SELECT COUNT(*) c FROM region_plans').get().c;
    if (!cnt) {
      db.prepare('INSERT INTO region_plans (name, is_default, description) VALUES (?,?,?)')
        .run('申通默认规则', 1, '使用系统内置 shentong_region_class 静态种子作为偏远地区判定规则');
    }
  } catch (e) {
    console.error('[region-plans] 建表失败:', e.message);
  }
})();

// 辅助：按方案 + 省 + 市 → 返回有效 region_class
function effectiveClass(planId, province, city) {
  if (!province) return '正常';
  // 1. 方案精确覆盖（省 + 市）
  if (planId) {
    const ex = db.prepare(
      'SELECT region_class FROM region_plan_overrides WHERE plan_id=? AND province=? AND city=?'
    ).get(planId, province, city);
    if (ex) return ex.region_class;
    const prov = db.prepare(
      'SELECT region_class FROM region_plan_overrides WHERE plan_id=? AND province=? AND city IS NULL'
    ).get(planId, province);
    if (prov) return prov.region_class;
  }
  // 2. shentong_region_class 精确
  if (city) {
    const ex = db.prepare('SELECT region_class FROM shentong_region_class WHERE province=? AND city=?').get(province, city);
    if (ex) return ex.region_class;
  }
  const prov = db.prepare('SELECT region_class FROM shentong_region_class WHERE province=? AND city IS NULL').get(province);
  if (prov) return prov.region_class;
  return '正常';
}

// --- GET /api/orders/region-plans — 列出所有方案及其覆盖条数 ---
router.get('/region-plans', (req, res) => {
  const plans = db.prepare(`
    SELECT rp.*,
           (SELECT COUNT(*) FROM region_plan_overrides rpo WHERE rpo.plan_id = rp.id) AS override_count
    FROM region_plans rp
    ORDER BY rp.is_default DESC, rp.id ASC
  `).all();
  res.json({ plans });
});

// --- POST /api/orders/region-plans — 新建方案 ---
router.post('/region-plans', (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  if (!name) return res.status(400).json({ error: '方案名称不能为空' });
  try {
    const info = db.prepare(
      'INSERT INTO region_plans (name, description) VALUES (?,?)'
    ).run(name, description || null);
    res.json({ id: info.lastInsertRowid, name });
  } catch (e) {
    res.status(400).json({ error: '创建失败：' + e.message });
  }
});

// --- PUT /api/orders/region-plans/:id — 更新方案（含覆盖规则）---
router.put('/region-plans/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效方案 ID' });
  const plan = db.prepare('SELECT * FROM region_plans WHERE id=?').get(id);
  if (!plan) return res.status(404).json({ error: '方案不存在' });

  const tx = db.transaction(() => {
    // 方案基本信息
    const name = String(req.body.name || plan.name).trim();
    const description = req.body.description != null
      ? String(req.body.description).trim()
      : plan.description;
    db.prepare('UPDATE region_plans SET name=?, description=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
      .run(name, description || null, id);

    // 覆盖规则（整体替换 — 若传 overrides 字段）
    if (Array.isArray(req.body.overrides)) {
      db.prepare('DELETE FROM region_plan_overrides WHERE plan_id=?').run(id);
      const ins = db.prepare(
        'INSERT OR REPLACE INTO region_plan_overrides (plan_id, province, city, region_class) VALUES (?,?,?,?)'
      );
      for (const o of req.body.overrides) {
        const cls = String(o.region_class || '').trim();
        if (!['大偏远', '小偏远', '正常'].includes(cls)) continue;
        const prov = String(o.province || '').trim();
        if (!prov) continue;
        ins.run(id, prov, o.city ? String(o.city).trim() : null, cls);
      }
    }
  });
  try {
    tx();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: '更新失败：' + e.message });
  }
});

// --- POST /api/orders/region-plans/:id/default — 设为默认方案 ---
router.post('/region-plans/:id/default', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效方案 ID' });
  const plan = db.prepare('SELECT * FROM region_plans WHERE id=?').get(id);
  if (!plan) return res.status(404).json({ error: '方案不存在' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE region_plans SET is_default=0').run();
    db.prepare('UPDATE region_plans SET is_default=1 WHERE id=?').run(id);
  });
  tx();
  res.json({ ok: true });
});

// --- DELETE /api/orders/region-plans/:id — 删除方案（默认方案不可删）---
router.delete('/region-plans/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效方案 ID' });
  const plan = db.prepare('SELECT * FROM region_plans WHERE id=?').get(id);
  if (!plan) return res.status(404).json({ error: '方案不存在' });
  if (plan.is_default) return res.status(400).json({ error: '默认方案不可删除' });
  db.prepare('DELETE FROM region_plans WHERE id=?').run(id);
  db.prepare('DELETE FROM region_plan_overrides WHERE plan_id=?').run(id);
  res.json({ ok: true });
});

// --- GET /api/orders/region-plans/:id/overrides — 取某个方案的覆盖列表 ---
router.get('/region-plans/:id/overrides', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = db.prepare('SELECT * FROM region_plans WHERE id=?').get(id);
  if (!plan) return res.status(404).json({ error: '方案不存在' });
  const overrides = db.prepare(`
    SELECT province, city, region_class FROM region_plan_overrides
    WHERE plan_id=? ORDER BY province, city
  `).all(id);
  res.json({ plan, overrides });
});

// --- GET /api/orders/region-plans/default — 取当前默认方案 ---
router.get('/region-plans/default', (req, res) => {
  const plan = db.prepare('SELECT * FROM region_plans WHERE is_default=1').get();
  res.json({ plan });
});

// 导入记录接口：基于 audit_logs 中 table_name='orders' AND action='import' 的条目
// 固定返回最新 20 条，每条解析出 filename/platform/timestamp/success/failed
const IMPORT_HISTORY_LIMIT = 20;

router.get('/import-history', auth, menuGate('orders_import'), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT log_id, operated_at, user_name, target_id, content
      FROM audit_logs
      WHERE table_name = 'orders' AND action = 'import'
      ORDER BY log_id DESC
      LIMIT ${IMPORT_HISTORY_LIMIT}
    `).all();

    const list = rows.map((r) => {
      let c = {};
      try { c = JSON.parse(r.content || '{}'); } catch (_) {}
      return {
        log_id: r.log_id,
        operated_at: r.operated_at,
        operator: r.user_name || '',
        platform: c.platform || '',
        filename: c.file || (c.content && c.content.file) || '',
        success: c.success != null ? c.success : 0,
        failed: c.failed != null ? c.failed : 0,
      };
    });
    res.json({ limit: IMPORT_HISTORY_LIMIT, list });
  } catch (e) {
    console.error('[orders/import-history] 异常:', e);
    res.status(500).json({ error: e.message });
  }
});

// 订单列表（搜索 + 分页，供核对/后续使用）+ 行级隔离（业务员仅自己）
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
  const where = [];
  const params = [];
  const scope = ownerScope(req);
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (q) {
    where.push('(order_no LIKE ? OR owner_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM orders ${w}`).get(...params).c;
  const rows = db
    .prepare(`SELECT * FROM orders ${w} ORDER BY order_id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ data: rows, total, page, pageSize });
});

// ============================================================================
// 订单查询模块（原地区看板重构，menu_code 仍为 order_dashboard）
// ----------------------------------------------------------------------------
// 分层：参数解析在此（路由层），WHERE 构建/查询/导出全部在 services/ordersQuery.js
// 核心规则：快递单号 q 非空 → 自动忽略日期条件（服务层 buildWhere 统一保证）
// ============================================================================

// GET /api/orders/query — 分页查询（快递单号/省/市/区县/平台/日期范围）
router.get('/query', auth, menuGate('order_dashboard'), (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim(),
    province: String(req.query.province || '').trim(),
    city: String(req.query.city || '').trim(),
    district: String(req.query.district || '').trim(),
    platform: String(req.query.platform || '').trim(),
    start: String(req.query.start || '').trim(),
    end: String(req.query.end || '').trim(),
  };
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
  // 边界防御：日期倒置自动纠正（start > end 时互换），不报错、不空结果
  if (filters.start && filters.end && filters.start > filters.end) {
    const t = filters.start; filters.start = filters.end; filters.end = t;
  }
  try {
    const result = ordersQuery.queryPage(db, filters, page, pageSize, ownerScope(req));
    res.json({ ...result, date_ignored: !!(filters.q && (filters.start || filters.end)) });
  } catch (e) {
    res.status(500).json({ error: '查询失败：' + e.message });
  }
});

// GET /api/orders/query/facets — 省/市/区县级联下拉数据源
router.get('/query/facets', auth, menuGate('order_dashboard'), (req, res) => {
  const province = String(req.query.province || '').trim();
  const city = String(req.query.city || '').trim();
  try {
    if (city) {
      return res.json({ districts: ordersQuery.facetDistricts(db, province, city) });
    }
    if (province) {
      return res.json({ cities: ordersQuery.facetCities(db, province) });
    }
    return res.json({ provinces: ordersQuery.facetProvinces(db) });
  } catch (e) {
    res.status(500).json({ error: '获取下拉数据失败：' + e.message });
  }
});

// GET /api/orders/query/export — 按当前筛选导出 xlsx（服务端生成，大数据量稳定）
router.get('/query/export', auth, menuGate('order_dashboard'), (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim(),
    province: String(req.query.province || '').trim(),
    city: String(req.query.city || '').trim(),
    district: String(req.query.district || '').trim(),
    platform: String(req.query.platform || '').trim(),
    start: String(req.query.start || '').trim(),
    end: String(req.query.end || '').trim(),
  };
  if (filters.start && filters.end && filters.start > filters.end) {
    const t = filters.start; filters.start = filters.end; filters.end = t;
  }
  try {
    const rows = ordersQuery.queryAll(db, filters, ownerScope(req), 100000);
    const EXPORT_HEADERS = ['快递单号', '平台', '客户名称', '货主名称', '发货量', '单位', '订单日期', '付款状态', '收件省', '收件市', '收件区县', '地区分类'];
    const aoa = [EXPORT_HEADERS].concat(rows.map((r) => [
      r.order_no, r.wms_platform, r.customer_name || '', r.owner_name,
      r.ship_quantity, r.unit, r.order_date, r.payment_status,
      r.to_province || '', r.to_city || '', r.to_district || '', r.region_class,
    ]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 30 }, { wch: 26 }, { wch: 10 }, { wch: 6 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '订单查询导出');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    auditLog.writeLog(req, {
      table: 'orders', module: '订单查询', action: 'export',
      targetId: 'orders_query_export',
      content: { op: 'orders_query_export', rows: rows.length, filters, operator: req.user?.username },
    });
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="orders-query-${ts}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error('[orders-query] 导出失败:', e);
    res.status(500).json({ error: '导出失败：' + e.message });
  }
});

// ---------- GET /api/orders/template ----------
// 生成带样式的订单导入 xlsx 模板：Sheet1=数据录入页（必填列红色加粗）、Sheet2=填写说明
router.get('/template', (req, res) => {
  try {
    // 构建主 sheet（含样式）
    const headers = TEMPLATE_FIELDS.map((f) => f.name);
    const sampleRow = TEMPLATE_FIELDS.map((f) => f.sample);
    const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow]);

    // 列宽自动 + 必填列红色
    const colW = TEMPLATE_FIELDS.map((f) => ({ wch: Math.max(f.name.length + 2, f.sample.length + 4, 12) }));
    ws['!cols'] = colW;

    // 给必填列表头加样式（XLSX 社区版有限样式能力：cell.s 的 fill + font）
    // 遍历首行（表头），必填列用红色背景 + 加粗
    headers.forEach((h, colIdx) => {
      if (REQUIRED_NAMES.includes(h)) {
        const addr = XLSX.utils.encode_cell({ r: 0, c: colIdx });
        if (ws[addr]) {
          ws[addr].s = {
            font: { bold: true, color: { rgb: 'FFFFFFFF' } },
            fill: { patternType: 'solid', fgColor: { rgb: 'FFE74C3C' } },
            alignment: { horizontal: 'center', vertical: 'center' },
            border: { top: { style: 'thin', color: { rgb: 'FFCCCCCC' } },
                      bottom: { style: 'thin', color: { rgb: 'FFCCCCCC' } },
                      left: { style: 'thin', color: { rgb: 'FFCCCCCC' } },
                      right: { style: 'thin', color: { rgb: 'FFCCCCCC' } } },
          };
        }
      } else {
        const addr = XLSX.utils.encode_cell({ r: 0, c: colIdx });
        if (ws[addr]) {
          ws[addr].s = {
            font: { bold: true },
            fill: { patternType: 'solid', fgColor: { rgb: 'FFF0F0F0' } },
            alignment: { horizontal: 'center', vertical: 'center' },
          };
        }
      }
    });
    // 行高（表头更宽）
    ws['!rows'] = [{ hpt: 28 }, { hpt: 22 }];

    // 第二 sheet：填写说明
    const guideAoA = [
      ['列名', '是否必填', '填写说明', '数据格式示例', '校验规则'],
      ...TEMPLATE_FIELDS.map((f) => [
        f.name,
        f.required ? '✅ 必填' : '选填',
        f.note,
        f.sample,
        f.required ? '不能为空；' : '留空则取默认值；' +
          (f.key === 'customer_name' || f.key === 'owner_name' ? '必须匹配 customers 表的 company_name 或 short_name；' : '') +
          (f.key === 'owner_name' ? '且与客户名称/简称指向同一家公司；' : '') +
          (f.key === 'ship_quantity' ? '必须是正数（>0），自动保留 3 位小数；' : '') +
          (f.key === 'unit' ? '必须是 件 / 箱 / 托 / 公斤 四选一；' : '') +
          (f.key === 'order_date' ? '日期格式 YYYY-MM-DD，Excel 日期序列号自动转换；' : '') +
          (f.key === 'payment_status' ? '未收 / 部分 / 已收 三选一，默认 未收；' : ''),
      ]),
      ['', '', '', '', ''],
      ['⚠️ 重要提示'],
      ['1.', '首次使用建议先看本 sheet 的填写说明列。'],
      ['2.', '客户名称/货主名称必须精确匹配系统内 customers 表的 company_name 或 short_name。'],
      ['3.', '该客户 coop_status 必须是「合作中」，已停用/软删除的客户无法导入。'],
      ['4.', '订单号留空系统会自动生成 ORD+时间戳+随机数，也可自行填写唯一订单号。'],
      ['5.', '建议单次导入 ≤ 2000 行以获得最佳体验，超大批量请拆分分批导入（后端无硬限制）。'],
    ];
    const wsGuide = XLSX.utils.aoa_to_sheet(guideAoA);
    wsGuide['!cols'] = [
      { wch: 14 }, { wch: 10 }, { wch: 55 }, { wch: 30 }, { wch: 55 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '订单导入模板');
    XLSX.utils.book_append_sheet(wb, wsGuide, '填写说明');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="orders_import_template.xlsx"');
    res.send(buf);
  } catch (e) {
    console.error('[orders] 模板生成失败:', e);
    res.status(500).json({ error: '模板生成失败：' + e.message });
  }
});

// GET /api/orders/platforms — 8 平台 WMS 选择器 + 统一列名（前端导入页面用）
router.get('/platforms', auth, menuGate('orders_import'), (req, res) => {
  res.json({
    platforms: WMS_PLATFORMS,
    unified_columns: UNIFIED_COLUMNS,
  });
});

// POST /api/orders/import — 批量导入（8 平台统一入口 + 自动地区分类）
// multipart fields: file(必填), platform(必填，WMS_PLATFORMS 之一)
router.post('/import', auth, menuGate('orders_import'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  const platform = String(req.body.platform || '').trim();
  if (!platform) return res.status(400).json({ error: '请选择来源平台' });
  if (!WMS_PLATFORMS.includes(platform))
    return res.status(400).json({ error: '平台不支持：' + platform });

  try {
    const result = processImport({
      db, req,
      fileBuf: req.file.buffer,
      platform,
    });
    res.json(result);
  } catch (e) {
    console.error('[orders/import] 异常:', e);
    res.status(500).json({ error: '导入失败：' + e.message });
  }
});

// GET /api/orders/dashboard — 地区分类看板聚合（支持 plan 参数）
// query: start, end, platform, class(大偏远/小偏远/正常), plan(方案 id)
router.get('/dashboard', auth, menuGate('orders_import'), (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const platform = String(req.query.platform || '').trim();
  const cls = String(req.query.class || '').trim();
  const planId = req.query.plan ? parseInt(req.query.plan, 10) : null;

  const where = [];
  const params = [];
  if (start) { where.push('o.order_date >= ?'); params.push(start); }
  if (end)   { where.push('o.order_date <= ?'); params.push(end); }
  if (platform && platform !== '全部') { where.push('o.wms_platform = ?'); params.push(platform); }
  // 注意：class 过滤不写死 o.region_class，改由 effective_class CTE 处理
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 构建 plan JOIN（planId 为空时跳过，等价于只用 shentong_region_class）
  const planExactJoin = planId
    ? 'LEFT JOIN region_plan_overrides plan_exact ON plan_exact.plan_id=? AND plan_exact.province=o.to_province AND plan_exact.city=o.to_city'
    : 'LEFT JOIN (SELECT NULL plan_id, NULL province, NULL city, NULL region_class) plan_exact ON 1=0';
  const planProvJoin  = planId
    ? 'LEFT JOIN region_plan_overrides plan_prov  ON plan_prov.plan_id=? AND plan_prov.province=o.to_province AND plan_prov.city IS NULL'
    : 'LEFT JOIN (SELECT NULL plan_id, NULL province, NULL city, NULL region_class) plan_prov ON 1=0';
  const planParams = planId ? [planId, planId] : [];

  // CTE：计算每单的 effective_class
  const effectiveSQL = `
    WITH effective AS (
      SELECT
        o.*,
        o.to_province AS province,
        COALESCE(
          plan_exact.region_class,
          plan_prov.region_class,
          st_exact.region_class,
          st_prov.region_class,
          '正常'
        ) AS effective_class
      FROM orders o
      ${planExactJoin}
      ${planProvJoin}
      LEFT JOIN shentong_region_class st_exact ON st_exact.province = o.to_province AND st_exact.city = o.to_city
      LEFT JOIN shentong_region_class st_prov  ON st_prov.province  = o.to_province AND st_prov.city IS NULL
      ${w}
    )
    SELECT * FROM effective
    ${cls && ['大偏远', '小偏远', '正常'].includes(cls) ? 'WHERE effective_class = ?' : ''}
  `;
  const sqlParams = [...planParams, ...params];
  if (cls && ['大偏远', '小偏远', '正常'].includes(cls)) sqlParams.push(cls);

  try {
    // 地区分类 × 平台聚合
    const agg = db.prepare(`
      ${effectiveSQL.includes('WHERE') ? effectiveSQL : effectiveSQL + ' WHERE 1=1'}
      GROUP BY effective_class, wms_platform
    `).all(...sqlParams);

    // 省份 × 地区分类聚合（用于 3 个省占比区块）
    const provinceAgg = db.prepare(`
      SELECT effective_class, province, COUNT(*) AS cnt
      FROM (
        WITH effective AS (
          SELECT o.*, o.to_province AS province,
            COALESCE(plan_exact.region_class, plan_prov.region_class, st_exact.region_class, st_prov.region_class, '正常') AS effective_class
          FROM orders o
          ${planExactJoin}
          ${planProvJoin}
          LEFT JOIN shentong_region_class st_exact ON st_exact.province = o.to_province AND st_exact.city = o.to_city
          LEFT JOIN shentong_region_class st_prov  ON st_prov.province  = o.to_province AND st_prov.city IS NULL
          ${w}
        )
        SELECT * FROM effective
        ${cls && ['大偏远', '小偏远', '正常'].includes(cls) ? 'WHERE effective_class = ?' : ''}
      )
      GROUP BY effective_class, province
    `).all(...sqlParams);

    // 明细（limit 500，后端带 effective_class）
    const details = db.prepare(`
      WITH effective AS (
        SELECT o.order_id, o.order_no, o.owner_name, o.ship_quantity, o.unit,
               o.order_date, o.payment_status, o.wms_platform,
               o.to_province, o.to_city, c.company_name AS customer_name,
               COALESCE(plan_exact.region_class, plan_prov.region_class, st_exact.region_class, st_prov.region_class, '正常') AS effective_class
        FROM orders o LEFT JOIN customers c ON o.customer_id = c.customer_id
        ${planExactJoin}
        ${planProvJoin}
        LEFT JOIN shentong_region_class st_exact ON st_exact.province = o.to_province AND st_exact.city = o.to_city
        LEFT JOIN shentong_region_class st_prov  ON st_prov.province  = o.to_province AND st_prov.city IS NULL
        ${w}
      )
      SELECT * FROM effective
      ${cls && ['大偏远', '小偏远', '正常'].includes(cls) ? 'WHERE effective_class = ?' : ''}
      ORDER BY order_date DESC, order_id DESC
      LIMIT 500
    `).all(...sqlParams);

    // 汇总（3 类）
    const byClass = { '大偏远': 0, '小偏远': 0, '正常': 0 };
    for (const r of agg) {
      if (byClass[r.effective_class] != null) byClass[r.effective_class] += r.cnt;
    }
    const total = byClass['大偏远'] + byClass['小偏远'] + byClass['正常'];
    const remoteTotal = byClass['大偏远'] + byClass['小偏远'];

    // 省份按地区分类聚合整理
    const byClassProvince = { '大偏远': [], '小偏远': [], '正常': [] };
    for (const r of provinceAgg) {
      if (byClassProvince[r.effective_class] && r.province) {
        byClassProvince[r.effective_class].push({
          province: r.province,
          count: r.cnt,
          pct: total ? +((r.cnt * 100) / total).toFixed(2) : 0,
        });
      }
    }
    // 每类内部按 count desc 排序
    for (const k of Object.keys(byClassProvince)) {
      byClassProvince[k].sort((a, b) => b.count - a.count);
    }

    res.json({
      total,
      remote_total: remoteTotal,
      by_class: byClass,
      platform_list: WMS_PLATFORMS,
      platform_breakdown: agg,
      by_class_province: byClassProvince,
      details,
    });
  } catch (e) {
    console.error('[orders/dashboard] 异常:', e);
    res.status(500).json({ error: '看板查询失败：' + e.message });
  }
});

module.exports = router;
