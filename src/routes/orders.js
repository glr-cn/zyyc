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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const UNITS = ['件', '箱', '托', '公斤'];

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

// GET /api/orders/dashboard — 地区分类看板聚合
// query: start, end, platform, class(大偏远/小偏远/正常)
router.get('/dashboard', auth, menuGate('orders_import'), (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const platform = String(req.query.platform || '').trim();
  const cls = String(req.query.class || '').trim();

  const where = [];
  const params = [];
  if (start) { where.push('o.order_date >= ?'); params.push(start); }
  if (end)   { where.push('o.order_date <= ?'); params.push(end); }
  if (platform && platform !== '全部') { where.push('o.wms_platform = ?'); params.push(platform); }
  if (cls && ['大偏远', '小偏远', '正常'].includes(cls)) {
    where.push('o.region_class = ?'); params.push(cls);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 聚合（地区分类 × 平台）
  const agg = db.prepare(`
    SELECT
      COALESCE(o.region_class, '正常') AS region_class,
      o.wms_platform,
      COUNT(*) AS cnt,
      SUM(o.ship_quantity) AS qty
    FROM orders o ${w}
    GROUP BY COALESCE(o.region_class, '正常'), o.wms_platform
  `).all(...params);

  // 汇总（3 类）
  const byClass = { '大偏远': 0, '小偏远': 0, '正常': 0 };
  for (const r of agg) {
    if (byClass[r.region_class] != null) byClass[r.region_class] += r.cnt;
  }
  const total = byClass['大偏远'] + byClass['小偏远'] + byClass['正常'];
  const remoteTotal = byClass['大偏远'] + byClass['小偏远']; // 偏远合计

  // 明细（limit 500，前端导出再调明细接口）
  const details = db.prepare(`
    SELECT o.order_id, o.order_no, o.owner_name, o.ship_quantity, o.unit,
           o.order_date, o.payment_status, o.wms_platform,
           o.to_province, o.to_city, o.region_class, c.company_name
    FROM orders o LEFT JOIN customers c ON o.customer_id = c.customer_id
    ${w}
    ORDER BY o.order_date DESC, o.order_id DESC
    LIMIT 500
  `).all(...params);

  res.json({
    total,
    remote_total: remoteTotal,
    by_class: byClass,
    platform_list: WMS_PLATFORMS,
    platform_breakdown: agg,
    details,
  });
});

module.exports = router;
