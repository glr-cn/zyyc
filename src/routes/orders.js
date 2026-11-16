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

const upload = multer({ storage: multer.memoryStorage() });
const UNITS = ['件', '箱', '托', '公斤'];

router.use(auth);
router.use(readonlyGate); // 查看者仅可查看，禁止导入/修改
router.use(menuGate('orders')); // RBAC：需「订单导入」菜单授权

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

router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  let rows;
  try {
    rows = readRows(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!rows.length) return res.status(400).json({ error: '文件中没有数据行（请保留表头）' });

  const failures = [];
  const successItems = [];

  rows.forEach((row, i) => {
    const excelRow = i + 2; // 第 1 行为表头
    const customerName = String(pick(row, 'customer_name') ?? '').trim();
    const ownerName = String(pick(row, 'owner_name') ?? '').trim();
    const orderNo = String(pick(row, 'order_no') ?? '').trim();
    const qtyRaw = pick(row, 'ship_quantity');
    const unit = String(pick(row, 'unit') ?? '').trim();
    const dateRaw = pick(row, 'order_date');

    if (!customerName) return failures.push({ row: excelRow, reason: '客户名称为空', data: row });
    if (!ownerName) return failures.push({ row: excelRow, reason: '货主名称为空', data: row });

    // 新客户表：company_name(公司全称) / short_name(客户简称) 替代旧 customer_name / owner_name
    const findCust = db.prepare('SELECT * FROM customers WHERE company_name=? OR short_name=?');
    const byName = findCust.get(customerName, customerName);
    if (!byName) return failures.push({ row: excelRow, reason: '客户名称不存在', data: row });
    const byOwner = findCust.get(ownerName, ownerName);
    if (!byOwner) return failures.push({ row: excelRow, reason: '货主名称不存在', data: row });
    if (byName.customer_id !== byOwner.customer_id)
      return failures.push({ row: excelRow, reason: '客户名称与货主名称不匹配', data: row });
    if (byName.coop_status !== '合作中')
      return failures.push({ row: excelRow, reason: '客户非合作中，不能导入订单', data: row });
    // 业务员只能导入自己负责的客户订单
    if (req.user.role === '业务员' && byName.owner_user_id !== req.user.user_id)
      return failures.push({ row: excelRow, reason: '无权导入其他业务员负责的客户订单', data: row });

    const qty = Number(qtyRaw);
    if (qtyRaw === '' || qtyRaw == null || isNaN(qty) || qty <= 0)
      return failures.push({ row: excelRow, reason: '发货量必须为正数', data: row });
    if (!UNITS.includes(unit))
      return failures.push({ row: excelRow, reason: '单位必须是 件/箱/托/公斤 之一', data: row });
    const date = parseDate(dateRaw);
    if (!date) return failures.push({ row: excelRow, reason: '订单日期格式不合法', data: row });

    successItems.push({
      excelRow,
      customerName,
      ownerName,
      orderNo,
      qty: round3(qty),
      unit,
      date,
      customer: byName,
    });
  });

  let success = 0;
  successItems.forEach((it) => {
    db.exec('BEGIN');
    try {
      const info = db
        .prepare(
          'INSERT INTO orders (order_no,customer_id,owner_name,ship_quantity,unit,order_date,payment_status,owner_user_id) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(it.orderNo || 'ORD' + Date.now() + Math.floor(Math.random() * 1000), it.customer.customer_id, it.ownerName, it.qty, it.unit, it.date, '未收', it.customer.owner_user_id);
      const orderId = info.lastInsertRowid;
      db.prepare(
        "INSERT INTO inventory_transactions (order_id,owner_name,quantity,direction,reference_type,business_date,remark) VALUES (?,?,?,'out','sale',?,?)"
      ).run(orderId, it.ownerName, it.qty, it.date, '订单导入自动出库');
      // 审计：统一走全局日志服务（新旧字段双写，模块=其他业务）
      require('../services/auditLog').writeLog(req, {
        table: 'orders', module: '其他业务', action: 'create', targetId: orderId,
        after: { order_no: it.orderNo, customer_id: it.customer.customer_id, owner_name: it.ownerName, ship_quantity: it.qty, unit: it.unit, order_date: it.date },
      });
      db.exec('COMMIT');
      success++;
    } catch (e) {
      db.exec('ROLLBACK');
      failures.push({ row: it.excelRow, reason: '写入失败: ' + e.message, data: it });
    }
  });

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
