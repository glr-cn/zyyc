// 库存：期初导入 + 库存台账（实时聚合）+ 负库存预警（阶段 2）
// 台账聚合口径：期初(initial入) + 入库(其余入) − 出库(out)，按货主分组，余额不落字段
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { readonlyGate, menuGate } = require('../middleware/rbac');
const multer = require('multer');
const round3 = require('../utils/round');
const { readRows, pick, parseDate } = require('../utils/excel');

const upload = multer({ storage: multer.memoryStorage() });
router.use(auth);
router.use(readonlyGate); // 查看者仅可查看台账/预警，禁止导入期初
router.use(menuGate('inventory')); // RBAC：需「库存台账」菜单授权

// 期初库存导入：模板 货主名称、数量、业务日期、备注(选填) → initial 入库流水
router.post('/import-initial', upload.single('file'), (req, res) => {
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
    const excelRow = i + 2;
    const ownerName = String(pick(row, 'owner_name') ?? '').trim();
    const qtyRaw = pick(row, 'quantity');
    const dateRaw = pick(row, 'business_date');
    const remark = String(pick(row, 'remark') ?? '').trim();

    if (!ownerName) return failures.push({ row: excelRow, reason: '货主名称为空', data: row });
    const cust = db.prepare('SELECT * FROM customers WHERE company_name=? OR short_name=?').get(ownerName, ownerName);
    if (!cust) return failures.push({ row: excelRow, reason: '货主名称不存在（须先在客户资料中建立）', data: row });
    const qty = Number(qtyRaw);
    if (qtyRaw === '' || qtyRaw == null || isNaN(qty) || qty <= 0)
      return failures.push({ row: excelRow, reason: '数量必须为正数', data: row });
    const date = parseDate(dateRaw);
    if (!date) return failures.push({ row: excelRow, reason: '业务日期格式不合法', data: row });

    successItems.push({ excelRow, ownerName, qty: round3(qty), date, remark });
  });

  let success = 0;
  successItems.forEach((it) => {
    db.exec('BEGIN');
    try {
      db.prepare(
        "INSERT INTO inventory_transactions (owner_name,quantity,direction,reference_type,business_date,remark) VALUES (?,?,'in','initial',?,?)"
      ).run(it.ownerName, it.qty, it.date, it.remark || null);
      db.exec('COMMIT');
      success++;
    } catch (e) {
      db.exec('ROLLBACK');
      failures.push({ row: it.excelRow, reason: '写入失败: ' + e.message, data: it });
    }
  });

  // 期初库存导入审计（原先遗漏）
  require('../services/auditLog').writeLog(req, {
    table: 'inventory_transactions', module: '其他业务', action: 'import',
    targetId: 'import:' + (req.file.originalname || 'initial.xlsx'),
    content: {
      file: req.file.originalname || '', success,
      failed: failures.length, failures: failures.slice(0, 50),
      rows: successItems.slice(0, 100),
    },
  });

  res.json({ success, failed: failures.length, failures });
});

// 库存台账（按货主实时聚合）
function getLedger({ owner = '', from = '', to = '' } = {}) {
  const where = [];
  const params = [];
  if (owner) {
    where.push('owner_name LIKE ?');
    params.push('%' + owner + '%');
  }
  if (from) {
    where.push('business_date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('business_date <= ?');
    params.push(to);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db
    .prepare(
      `SELECT owner_name,
         SUM(CASE WHEN reference_type='initial' AND direction='in' THEN quantity ELSE 0 END) AS opening,
         SUM(CASE WHEN direction='in' AND reference_type<>'initial' THEN quantity ELSE 0 END) AS total_in,
         SUM(CASE WHEN direction='out' THEN quantity ELSE 0 END) AS total_out,
         SUM(CASE WHEN direction='in' THEN quantity ELSE -quantity END) AS balance
       FROM inventory_transactions ${w} GROUP BY owner_name ORDER BY owner_name`
    )
    .all(...params);
  return rows.map((r) => {
    // 新客户表已移除 safety_stock 字段：此处恒为 0，预警口径改为「负库存预警」
    const safety = 0;
    return {
      owner_name: r.owner_name,
      opening: round3(r.opening),
      total_in: round3(r.total_in),
      total_out: round3(r.total_out),
      balance: round3(r.balance),
      safety_stock: safety,
      is_negative: r.balance < 0,
      below_safety: r.balance < 0,
    };
  });
}

router.get('/ledger', (req, res) => {
  res.json({ data: getLedger({ owner: req.query.owner || '', from: req.query.from || '', to: req.query.to || '' }) });
});

// 负库存预警（新客户表已无 safety_stock，口径改为余额 < 0）
router.get('/warnings', (req, res) => {
  const warnings = getLedger({})
    .filter((r) => r.below_safety)
    .sort((a, b) => a.balance - b.balance)
    .map((r) => ({
      owner_name: r.owner_name,
      balance: r.balance,
      safety_stock: r.safety_stock,
      deficit: round3(r.safety_stock - r.balance),
      is_negative: r.is_negative,
    }));
  res.json({ data: warnings, count: warnings.length });
});

module.exports = router;
