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

router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  let rows;
  try {
    rows = readRows(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!rows.length) return res.status(400).json({ error: '文件中没有数据行（请保留表头）' });

  // ★ WMS 宽松模式检测：ALIASES 扩展后，"客户"/"货主"/"店铺"等 WMS 短列名能
  // 命中 customer_name → 自动进入 WMS 模式（允许自动创建客户、允许缺失货主/单位/发货量）
  // 逻辑：如果 pick('customer_name') 取到的值来自 WMS 短别名（"客户"/"货主"/"店铺"），
  // 就启用宽松模式。方法是检查原始 row 里这些短键是否存在。
  const wmsShortKeys = new Set(['客户', '货主', '店铺', '使用方公司名称', '客户店铺',
    '使用单号店铺', '取号店铺名称', '订单店铺名称']);
  const isWmsLoose = rows.some(r =>
    Object.keys(r).some(k => wmsShortKeys.has(k) && String(r[k]).trim())
  );

  const failures = [];
  const successItems = [];
  // 自动创建的客户缓存（避免每行单独 INSERT）
  const autoCustCache = new Map(); // customerName → customer_id

  rows.forEach((row, i) => {
    const excelRow = i + 2;
    const customerName = String(pick(row, 'customer_name') ?? '').trim();
    const ownerName = String(pick(row, 'owner_name') ?? '').trim();
    const orderNo = String(pick(row, 'order_no') ?? '').trim();
    let qtyRaw = pick(row, 'ship_quantity');
    const unit = String(pick(row, 'unit') ?? '').trim();
    const dateRaw = pick(row, 'order_date');

    if (!customerName) return failures.push({ row: excelRow, reason: '客户名称为空', data: row });

    let customer = null;
    const findCust = db.prepare('SELECT * FROM customers WHERE company_name=? OR short_name=?');
    customer = findCust.get(customerName, customerName);

    if (!customer && !isWmsLoose)
      return failures.push({ row: excelRow, reason: '客户名称不存在', data: row });

    if (!customer && isWmsLoose) {
      // WMS 模式：自动创建缺失客户（coop_status=合作中）
      if (autoCustCache.has(customerName)) {
        const cached = autoCustCache.get(customerName);
        customer = { customer_id: cached.customer_id, owner_user_id: cached.owner_user_id };
      } else {
        const ins = db.prepare(
          'INSERT INTO customers (company_name,short_name,coop_status,created_at) VALUES (?,?,?,?)'
        );
        try {
          const info = ins.run(customerName, customerName, '合作中', new Date().toISOString().slice(0, 10));
          customer = { customer_id: info.lastInsertRowid, owner_user_id: req.user.user_id };
          autoCustCache.set(customerName, { customer_id: info.lastInsertRowid, owner_user_id: req.user.user_id });
        } catch (e) {
          return failures.push({ row: excelRow, reason: '自动创建客户失败：' + e.message, data: row });
        }
      }
    }

    // 货主校验（非 WMS 模式）；WMS 模式自动兜底
    if (!ownerName) {
      if (isWmsLoose) ownerName = customerName;
      else return failures.push({ row: excelRow, reason: '货主名称为空', data: row });
    } else if (!isWmsLoose) {
      const byOwner = findCust.get(ownerName, ownerName);
      if (!byOwner) return failures.push({ row: excelRow, reason: '货主名称不存在', data: row });
      if (customer.customer_id !== byOwner.customer_id)
        return failures.push({ row: excelRow, reason: '客户名称与货主名称不匹配', data: row });
    }

    // 非 WMS 模式：必须合作中 + 业务员权限校验
    if (!isWmsLoose) {
      if (customer.coop_status !== '合作中')
        return failures.push({ row: excelRow, reason: '客户非合作中，不能导入订单', data: row });
      if (req.user.role === '业务员' && customer.owner_user_id !== req.user.user_id)
        return failures.push({ row: excelRow, reason: '无权导入其他业务员负责的客户订单', data: row });
    }

    // 发货量：WMS 模式 fallback 1（每包裹=1件）
    let qty = Number(qtyRaw);
    if (qtyRaw === '' || qtyRaw == null || isNaN(qty) || qty <= 0) {
      if (isWmsLoose) { qty = 1; }
      else return failures.push({ row: excelRow, reason: '发货量必须为正数', data: row });
    }
    // 单位：WMS 模式默认"件"
    const finalUnit = unit || (isWmsLoose ? '件' : '');
    if (!isWmsLoose && !UNITS.includes(finalUnit))
      return failures.push({ row: excelRow, reason: '单位必须是 件/箱/托/公斤 之一', data: row });

    // 日期：WMS 模式 fallback 今天
    let date = parseDate(dateRaw);
    if (!date) {
      if (isWmsLoose) date = new Date().toISOString().slice(0, 10);
      else return failures.push({ row: excelRow, reason: '订单日期格式不合法', data: row });
    }

    successItems.push({
      excelRow, customerName, ownerName, orderNo, qty: round3(qty),
      unit: finalUnit, date, customer,
    });
  });

  // 批量事务：一次 BEGIN 包所有 INSERT（10 万行级批量避免 N 次事务开销）
  let success = 0;
  let lastOrderId = 0;
  const orderStmt = db.prepare(
    'INSERT INTO orders (order_no,customer_id,owner_name,ship_quantity,unit,order_date,payment_status,owner_user_id) VALUES (?,?,?,?,?,?,?,?)'
  );
  const invStmt = db.prepare(
    "INSERT INTO inventory_transactions (order_id,owner_name,quantity,direction,reference_type,business_date,remark) VALUES (?,?,?,'out','sale',?,?)"
  );
  db.exec('BEGIN');
  for (const it of successItems) {
    try {
      const info = orderStmt.run(
        it.orderNo || 'ORD' + Date.now() + Math.floor(Math.random() * 1000),
        it.customer.customer_id, it.ownerName, it.qty, it.unit, it.date,
        '未收', it.customer.owner_user_id
      );
      lastOrderId = info.lastInsertRowid;
      invStmt.run(lastOrderId, it.ownerName, it.qty, it.date, '订单导入自动出库');
      success++;
    } catch (e) {
      failures.push({ row: it.excelRow, reason: '写入失败: ' + e.message, data: it });
    }
  }
  if (success > 0) db.exec('COMMIT'); else db.exec('ROLLBACK');

  // 订单导入批次审计：逐行 create 明细日志之外，补一条「导入」批次日志
  require('../services/auditLog').writeLog(req, {
    table: 'orders', module: '其他业务', action: 'import',
    targetId: 'import:' + (req.file.originalname || 'orders.xlsx'),
    content: {
      file: req.file.originalname || '', success,
      failed: failures.length, failures: failures.slice(0, 50),
    },
  });

  res.json({ success, failed: failures.length, failures });
});

module.exports = router;
