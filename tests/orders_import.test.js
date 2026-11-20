// ============================================================================
// 订单导入单元测试（services/ordersImport.js）
// ----------------------------------------------------------------------------
// 背景（2026-11-20 根因修复回归）：
//   申通/中通派件导出同时有「快递单号」与「订单号」两列，订单查询模块按快递单号检索。
//   旧逻辑 order_no 落「订单号」列（内部单号 C2611…），导致 23322 条导入全部查不到。
// 覆盖场景：
//   1. normalizeRow：快递单号类列名优先于订单号（同时有两列时）
//   2. normalizeRow：仅有订单号列 → 正常回退订单号
//   3. normalizeRow：统一模板表头（订单号/收件省/收件市/收件区县）兜底可用
//   4. processImport：批次内同单号重复 → 第二条跳过
//   5. processImport：与库内已有单号重复 → 跳过（重复导入同一文件不再翻倍）
//   6. processImport：无单号行不互相误伤
//   7. 端到端：导入后用订单查询服务按快递单号立即检索命中（忽略日期 + 省市区入库）
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { openDatabase } = require('../src/db/driver');

// 静音审计日志（避免污染本地 erp.db 的 audit_logs）
const audit = require('../src/services/auditLog');
audit.writeLog = () => {};

const { normalizeRow, processImport } = require('../src/services/ordersImport');
const { queryPage } = require('../src/services/ordersQuery');

// —— 构造 xlsx 内存文件（book_new 不接受参数，需 book_append_sheet）——
function xlsxBuf(header, rows) {
  const ws = xlsx.utils.aoa_to_sheet([header, ...rows]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const REQ = { headers: {}, user: { user_id: 1, username: 'tester' }, file: { originalname: 'test.xlsx' } };

function setupDb() {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE customers (
      customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      short_name TEXT,
      coop_status TEXT,
      owner_user_id INTEGER,
      created_at TEXT
    );
    CREATE TABLE orders (
      order_id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(customer_id),
      owner_name TEXT NOT NULL,
      ship_quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      order_date TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT '未收',
      owner_user_id INTEGER,
      wms_platform TEXT,
      to_province TEXT, to_city TEXT, to_district TEXT, region_class TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE inventory_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER, owner_name TEXT, quantity REAL,
      direction TEXT, reference_type TEXT, business_date TEXT, remark TEXT
    );
    CREATE TABLE shentong_region_class (province TEXT, city TEXT, region_class TEXT);
  `);
  return db;
}

// ---------- 1. 快递单号优先映射 ----------
test('normalizeRow: 百世WMS 同时有快递单号+订单号 → order_no 必须取快递单号', () => {
  const r = normalizeRow('百世WMS', {
    '客户': '沃谷(山东)临沂-化武', '快递单号': '770356000981892',
    '订单号': 'C26110127', '派送状态': '已签收',
  });
  assert.equal(r.order_no, '770356000981892');
});

test('normalizeRow: 快递单号类别名（运单号/物流单号/快递编号）均优先于订单号', () => {
  for (const col of ['运单号', '物流单号', '快递编号']) {
    const r = normalizeRow('百世WMS', { [col]: '7703', '订单号': 'C1' });
    assert.equal(r.order_no, '7703', `${col} 应优先于订单号`);
  }
});

test('normalizeRow: 仅有订单号列 → 回退正常取订单号', () => {
  const r = normalizeRow('百世WMS', { '客户': '某客户', '订单号': 'C26110127' });
  assert.equal(r.order_no, 'C26110127');
});

test('normalizeRow: 统一模板表头（订单号/收件省/收件市/收件区县）兜底可用', () => {
  const r = normalizeRow('旺店通WMS', {
    '订单号': '770999', '客户名称': '测试客户A', '发货量': 3, '单位': '件',
    '订单日期': '2026-11-19', '收件省': '浙江省', '收件市': '杭州市', '收件区县': '西湖区',
  });
  assert.equal(r.order_no, '770999');
  assert.equal(r.customer_name, '测试客户A');
  assert.equal(r.to_province, '浙江省');
  assert.equal(r.to_city, '杭州市');
  assert.equal(r.to_district, '西湖区');
});

// ---------- 1.5 发货时间映射（2026-11-20 修复回归） ----------
test('normalizeRow: 派件导出仅有「发货时间」列 → order_date 取到该列', () => {
  const r = normalizeRow('百世WMS', {
    '客户': '沃谷(山东)临沂-化武', '快递单号': '770356000981892', '发货时间': '2026-11-19 15:30:22',
  });
  assert.equal(r.order_date, '2026-11-19 15:30:22');
});

test('processImport: 发货时间含时分秒 → 入库仅保留日期，不落导入当天', () => {
  const db = setupDb();
  const buf = xlsxBuf(['快递单号', '客户', '发货件数', '收货省份', '收货城市', '发货时间'], [
    ['770356000981900', '新客户D', 1, '山东省', '济南市', '2026-11-19 15:30:22'],
  ]);
  const r = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(r.success, 1);
  const row = db.prepare('SELECT order_date FROM orders WHERE order_no=?').get('770356000981900');
  assert.equal(row.order_date, '2026-11-19');
  db.close();
});

// ---------- 2. 导入查重 ----------
test('processImport: 批次内同单号重复 → 第二条跳过，不翻倍', () => {
  const db = setupDb();
  const buf = xlsxBuf(['快递单号', '客户', '发货件数', '出库日期'], [
    ['770001', '新客户甲', 5, '2026-11-19'],
    ['770001', '新客户甲', 5, '2026-11-19'],
    ['770002', '新客户乙', 2, '2026-11-19'],
  ]);
  const r = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(r.success, 2);
  const dup = r.failures.find((f) => f.orderNo === '770001');
  assert.ok(dup, '应有一条 770001 被拦截');
  assert.ok(dup.reason.includes('已存在'));
  db.close();
});

test('processImport: 同一文件重复导入 → 全部跳过（防数据翻倍）', () => {
  const db = setupDb();
  const buf = xlsxBuf(['快递单号', '客户', '发货件数', '出库日期'], [
    ['770101', '新客户A', 5, '2026-11-19'],
    ['770102', '新客户B', 2, '2026-11-19'],
  ]);
  const first = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(first.success, 2);
  const second = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(second.success, 0);
  assert.equal(second.failed, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 2, '库内仍只有 2 条');
  db.close();
});

test('processImport: 无单号行不互相误伤（两条无单号均可导入）', () => {
  const db = setupDb();
  const buf = xlsxBuf(['客户', '发货件数', '出库日期'], [
    ['新客户C', 1, '2026-11-19'],
    ['新客户C', 2, '2026-11-19'],
  ]);
  const r = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(r.success, 2);
  db.close();
});

// ---------- 3. 端到端：导入 → 查询 ----------
test('端到端：申通式文件导入 → 订单查询按快递单号立即检索命中（忽略日期）', () => {
  const db = setupDb();
  const buf = xlsxBuf(
    ['快递单号', '订单号', '客户', '发货件数', '收货省份', '收货城市', '收货区', '出库日期'],
    [
      ['770356000981892', 'C26110127', '沃谷(山东)临沂-化武', 1, '新疆维吾尔自治区', '乌鲁木齐市', '天山区', '2026-11-19'],
      ['770356000981893', 'C26110128', '沃谷(山东)临沂-化武', 2, '浙江省', '杭州市', '西湖区', '2026-11-19'],
    ]
  );
  const r = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(r.success, 2);

  // 单号检索（带一个不匹配的日期区间，验证"忽略日期"双保险）
  const hit = queryPage(db, { q: '770356000981892', start: '2020-01-01', end: '2020-12-31' }, 1, 20, null);
  assert.equal(hit.total, 1);
  assert.equal(hit.data[0].order_no, '770356000981892');
  // 库里存的必须是快递单号，而不是内部订单号
  const wrong = queryPage(db, { q: 'C26110127' }, 1, 20, null);
  assert.equal(wrong.total, 0, '内部订单号不应落入 order_no');
  // 省市区入库
  assert.equal(hit.data[0].to_district, '天山区');
  db.close();
});
