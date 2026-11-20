// ============================================================================
// 电子面单类型链路测试（导入映射 / 查询筛选 / 分组统计 / 维度下拉）
// ----------------------------------------------------------------------------
// 覆盖：
//   1. 导入：编码 STO → 申通快递；名称原样；未知编码保留；空值落 NULL
//   2. 查询：waybillType 精确筛选 + 「未标注」匹配历史 NULL
//   3. 统计：平台 × 电子面单类型 发货量/单量聚合与合计
//   4. 维度下拉：去重 + 未标注排最后
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { openDatabase } = require('../src/db/driver');

const audit = require('../src/services/auditLog');
audit.writeLog = () => {};

const { processImport } = require('../src/services/ordersImport');
const { queryPage, facetWaybillTypes, statsWaybill } = require('../src/services/ordersQuery');

function xlsxBuf(header, rows) {
  const ws = xlsx.utils.aoa_to_sheet([header, ...rows]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const REQ = { headers: {}, user: { user_id: 1, username: 'tester' }, file: { originalname: 't.xlsx' } };

function setupDb() {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE customers (
      customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL, short_name TEXT, coop_status TEXT,
      owner_user_id INTEGER, created_at TEXT
    );
    CREATE TABLE orders (
      order_id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(customer_id),
      owner_name TEXT NOT NULL, ship_quantity REAL NOT NULL, unit TEXT NOT NULL,
      order_date TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT '未收',
      owner_user_id INTEGER, wms_platform TEXT, to_province TEXT, to_city TEXT,
      to_district TEXT, region_class TEXT, waybill_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE inventory_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER, owner_name TEXT, quantity REAL,
      direction TEXT, reference_type TEXT, business_date TEXT, remark TEXT
    );
    CREATE TABLE shentong_region_class (province TEXT, city TEXT, region_class TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
  `);
  return db;
}

const HDR = ['快递单号', '客户', '发货件数', '发货时间', '收货省份', '收货城市', '电子面单类型'];

// ---------- 1. 导入映射 ----------
test('processImport: 电子面单类型编码 STO/ZTO → 名称，未知保留，空值落 NULL', () => {
  const db = setupDb();
  const buf = xlsxBuf(HDR, [
    ['STO1001', '客户甲', 2, '2026-11-01', '浙江省', '杭州市', 'STO'],
    ['ZTO1001', '客户甲', 3, '2026-11-01', '浙江省', '杭州市', 'zto'],
    ['ZZZ1001', '客户甲', 1, '2026-11-01', '浙江省', '杭州市', 'JTSD'],
    ['NON1001', '客户甲', 4, '2026-11-01', '浙江省', '杭州市', ''],
  ]);
  const r = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(r.success, 4, JSON.stringify(r.failures));

  const get = (no) => db.prepare('SELECT waybill_type FROM orders WHERE order_no=?').get(no).waybill_type;
  assert.equal(get('STO1001'), '申通快递');
  assert.equal(get('ZTO1001'), '中通快递');
  assert.equal(get('ZZZ1001'), 'JTSD');
  assert.equal(get('NON1001'), null);
  db.close();
});

test('processImport: 自定义映射新增后导入立即生效', () => {
  const db = setupDb();
  const expressMap = require('../src/services/expressMap');
  expressMap.addItem(db, { code: 'JTSD', name: '极兔速递' });
  const buf = xlsxBuf(HDR, [['JT1001', '客户乙', 1, '2026-11-02', '浙江省', '杭州市', 'JTSD']]);
  processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(db.prepare('SELECT waybill_type FROM orders WHERE order_no=?').get('JT1001').waybill_type, '极兔速递');
  db.close();
});

// ---------- 1.5 历史数据回填（单号重复但面单类型为空） ----------
test('processImport: 单号已存在且面单类型为空 → 仅回填该列，不新增订单、不改其他字段', () => {
  const db = setupDb();
  const cid = db.prepare("INSERT INTO customers (company_name) VALUES ('客户甲')").run().lastInsertRowid;
  db.prepare(`INSERT INTO orders (order_no,customer_id,owner_name,ship_quantity,unit,order_date,wms_platform,waybill_type)
    VALUES ('STO9001',?, '客户甲', 8, '件', '2026-11-01', '百世WMS', NULL)`).run(cid);

  const buf = xlsxBuf(HDR, [
    ['STO9001', '客户甲', 99, '2026-11-05', '浙江省', '杭州市', 'STO'],
  ]);
  const r = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(r.success, 0);
  assert.equal(r.backfilled, 1);
  assert.equal(r.failed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 1);

  const row = db.prepare('SELECT waybill_type, ship_quantity, order_date FROM orders WHERE order_no=?').get('STO9001');
  assert.equal(row.waybill_type, '申通快递');
  assert.equal(row.ship_quantity, 8);        // 原有数值不被覆盖
  assert.equal(row.order_date, '2026-11-01'); // 原有日期不被覆盖
  db.close();
});

test('processImport: 已有面单类型不被覆盖（重复导入仍按查重跳过）', () => {
  const db = setupDb();
  const cid = db.prepare("INSERT INTO customers (company_name) VALUES ('客户甲')").run().lastInsertRowid;
  db.prepare(`INSERT INTO orders (order_no,customer_id,owner_name,ship_quantity,unit,order_date,wms_platform,waybill_type)
    VALUES ('ZTO9002',?, '客户甲', 5, '件', '2026-11-01', '百世WMS', '中通快递')`).run(cid);

  const buf = xlsxBuf(HDR, [['ZTO9002', '客户甲', 1, '2026-11-05', '浙江省', '杭州市', 'STO']]);
  const r = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(r.backfilled, 0);
  assert.equal(r.failed, 1);
  assert.equal(db.prepare('SELECT waybill_type FROM orders WHERE order_no=?').get('ZTO9002').waybill_type, '中通快递');
  db.close();
});

// ---------- 2. 查询筛选 ----------
function seed(db) {
  const cid = db.prepare("INSERT INTO customers (company_name) VALUES ('客户A')").run().lastInsertRowid;
  const ins = db.prepare(`INSERT INTO orders
    (order_no,customer_id,owner_name,ship_quantity,unit,order_date,payment_status,wms_platform,to_province,to_city,waybill_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('A1', cid, '客户A', 10, '件', '2026-11-01', '未收', '百世WMS', '浙江省', '杭州市', '申通快递');
  ins.run('A2', cid, '客户A', 20, '件', '2026-11-01', '未收', '百世WMS', '浙江省', '杭州市', '中通快递');
  ins.run('A3', cid, '客户A', 30, '件', '2026-11-02', '未收', '旺店通WMS', '浙江省', '杭州市', '申通快递');
  ins.run('A4', cid, '客户A', 40, '件', '2026-11-02', '未收', '旺店通WMS', '浙江省', '杭州市', null);
  return cid;
}

test('queryPage: 按电子面单类型精确筛选', () => {
  const db = setupDb();
  seed(db);
  const r = queryPage(db, { waybillType: '申通快递' }, 1, 50, { sql: '', params: [] });
  assert.equal(r.total, 2);
  assert.ok(r.data.every((x) => x.waybill_type === '申通快递'));
  db.close();
});

test('queryPage: 「未标注」筛选命中历史 NULL 数据', () => {
  const db = setupDb();
  seed(db);
  const r = queryPage(db, { waybillType: '未标注' }, 1, 50, { sql: '', params: [] });
  assert.equal(r.total, 1);
  assert.equal(r.data[0].order_no, 'A4');
  db.close();
});

test('queryPage: 「全部」/空值不参与筛选', () => {
  const db = setupDb();
  seed(db);
  assert.equal(queryPage(db, { waybillType: '全部' }, 1, 50, { sql: '', params: [] }).total, 4);
  assert.equal(queryPage(db, {}, 1, 50, { sql: '', params: [] }).total, 4);
  db.close();
});

// ---------- 3. 分组统计 ----------
test('statsWaybill: 平台 × 电子面单类型 聚合发货量与单量', () => {
  const db = setupDb();
  seed(db);
  const rows = statsWaybill(db, {}, { sql: '', params: [] });
  const find = (p, w) => {
    const r = rows.find((x) => x.platform === p && x.waybill_type === w);
    return r ? { ...r } : null;
  };
  assert.deepEqual(find('百世WMS', '申通快递'), { platform: '百世WMS', waybill_type: '申通快递', orders: 1, quantity: 10 });
  assert.deepEqual(find('百世WMS', '中通快递'), { platform: '百世WMS', waybill_type: '中通快递', orders: 1, quantity: 20 });
  assert.deepEqual(find('旺店通WMS', '申通快递'), { platform: '旺店通WMS', waybill_type: '申通快递', orders: 1, quantity: 30 });
  assert.deepEqual(find('旺店通WMS', '未标注'), { platform: '旺店通WMS', waybill_type: '未标注', orders: 1, quantity: 40 });
  const sum = rows.reduce((s, r) => s + r.quantity, 0);
  assert.equal(sum, 100);
  db.close();
});

test('statsWaybill: 日期与平台筛选生效，单号条件被忽略', () => {
  const db = setupDb();
  seed(db);
  const onlyDay2 = statsWaybill(db, { start: '2026-11-02', end: '2026-11-02' }, { sql: '', params: [] });
  assert.equal(onlyDay2.reduce((s, r) => s + r.quantity, 0), 70);

  const onlyBs = statsWaybill(db, { platform: '百世WMS' }, { sql: '', params: [] });
  assert.equal(onlyBs.reduce((s, r) => s + r.quantity, 0), 30);

  const withQ = statsWaybill(db, { q: 'A1' }, { sql: '', params: [] });
  assert.equal(withQ.reduce((s, r) => s + r.quantity, 0), 100);  // q 被忽略
  db.close();
});

test('statsWaybill: 行级权限 scope 生效', () => {
  const db = setupDb();
  const cid = seed(db);
  db.prepare('UPDATE orders SET owner_user_id=2 WHERE order_no IN (?,?)').run('A1', 'A2');
  const rows = statsWaybill(db, {}, { sql: 'owner_user_id = ?', params: [2] });
  assert.equal(rows.reduce((s, r) => s + r.quantity, 0), 30);
  db.close();
});

// ---------- 4. 维度下拉 ----------
test('facetWaybillTypes: 去重、排序，「未标注」排最后', () => {
  const db = setupDb();
  seed(db);
  const list = facetWaybillTypes(db);
  assert.ok(list.includes('申通快递'));
  assert.ok(list.includes('中通快递'));
  assert.equal(list[list.length - 1], '未标注');
  assert.equal(new Set(list).size, list.length);
  db.close();
});
