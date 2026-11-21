// ============================================================================
// 偏远地区设置测试（规则优先级 / 省市降级 / 正常兜底 / 快递公司隔离 / 导入生效）
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { openDatabase } = require('../src/db/driver');

const audit = require('../src/services/auditLog');
audit.writeLog = () => {};

const region = require('../src/services/expressRegion');
const { processImport } = require('../src/services/ordersImport');

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
  region.ensureTable(db);
  return db;
}

function xlsxBuf(header, rows) {
  const ws = xlsx.utils.aoa_to_sheet([header, ...rows]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const HDR = ['快递单号', '客户', '发货件数', '发货时间', '收货省份', '收货城市', '收件区县', '电子面单类型'];

// ---------- 1. 基础判定 ----------
test('region: 大偏远优先于小偏远，省市逐级降级匹配', () => {
  const db = setupDb();
  region.saveRules(db, '申通快递', {
    '大偏远': [{ province: '新疆维吾尔自治区', city: '', district: '' }],
    '小偏远': [{ province: '新疆维吾尔自治区', city: '乌鲁木齐市', district: '' }],
    '正常': [],
  });
  // 省级大偏远命中，优先于市级小偏远
  assert.equal(region.resolveClass(db, '申通快递', '新疆维吾尔自治区', '乌鲁木齐市', '天山区'), '大偏远');
  assert.equal(region.resolveClass(db, '申通快递', '新疆维吾尔自治区', '和田市', ''), '大偏远');
  db.close();
});

test('region: 区县级规则命中，未命中区县时降级到市', () => {
  const db = setupDb();
  region.saveRules(db, '中通快递', {
    '大偏远': [{ province: '广东省', city: '深圳市', district: '南山区' }],
    '小偏远': [{ province: '广东省', city: '广州市', district: '' }],
    '正常': [],
  });
  assert.equal(region.resolveClass(db, '中通快递', '广东省', '深圳市', '南山区'), '大偏远');
  // 南山区规则不命中宝安区 → 不降级为全省（未配全省），继续落到正常
  assert.equal(region.resolveClass(db, '中通快递', '广东省', '深圳市', '宝安区'), '正常');
  assert.equal(region.resolveClass(db, '中通快递', '广东省', '广州市', '天河区'), '小偏远');
  db.close();
});

// ---------- 2. 正常区域兜底 ----------
test('region: 正常列表为空 → 未命中大/小偏远的一律为正常', () => {
  const db = setupDb();
  region.saveRules(db, '圆通快递4', {
    '大偏远': [{ province: '西藏自治区', city: '', district: '' }],
    '小偏远': [],
    '正常': [],
  });
  assert.equal(region.resolveClass(db, '圆通快递4', '浙江省', '杭州市', '西湖区'), '正常');
  assert.equal(region.resolveClass(db, '圆通快递4', '西藏自治区', '拉萨市', ''), '大偏远');
  db.close();
});

test('region: 正常列表已配置 → 未在列表内的区域为「其他」', () => {
  const db = setupDb();
  region.saveRules(db, '圆通快递5', {
    '大偏远': [{ province: '西藏自治区', city: '', district: '' }],
    '小偏远': [],
    '正常': [{ province: '浙江省', city: '', district: '' }],
  });
  assert.equal(region.resolveClass(db, '圆通快递5', '浙江省', '杭州市', ''), '正常');
  assert.equal(region.resolveClass(db, '圆通快递5', '江苏省', '南京市', ''), '其他');
  assert.equal(region.resolveClass(db, '圆通快递5', '西藏自治区', '拉萨市', ''), '大偏远');
  db.close();
});

// ---------- 3. 快递公司隔离 / 未配置 ----------
test('region: 不同快递公司规则互不影响，未配置返回 null', () => {
  const db = setupDb();
  region.saveRules(db, '顺丰', {
    '大偏远': [{ province: '新疆维吾尔自治区', city: '', district: '' }],
    '小偏远': [], '正常': [],
  });
  assert.equal(region.resolveClass(db, '顺丰', '新疆维吾尔自治区', '乌鲁木齐市', ''), '大偏远');
  assert.equal(region.resolveClass(db, '德邦快递', '新疆维吾尔自治区', '乌鲁木齐市', ''), null);
  assert.equal(region.carriers(db, ['顺丰', '德邦快递']).length, 2);
  db.close();
});

// ---------- 4. 保存校验 / 唯一性 ----------
test('region: 同一区域不能同时属于两个分类；同分类重复自动去重', () => {
  const db = setupDb();
  assert.throws(() => region.saveRules(db, '申通快递', {
    '大偏远': [{ province: '海南省', city: '', district: '' }],
    '小偏远': [{ province: '海南省', city: '', district: '' }],
    '正常': [],
  }), /同时出现在/);

  const r = region.saveRules(db, '申通快递', {
    '大偏远': [
      { province: '海南省', city: '', district: '' },
      { province: '海南省', city: '', district: '' },
    ],
    '小偏远': [], '正常': [],
  });
  assert.equal(r.count, 1);
  db.close();
});

test('region: 保存为全量替换，清空后 hasConfig=false', () => {
  const db = setupDb();
  region.saveRules(db, '申通快递', {
    '大偏远': [{ province: '海南省', city: '', district: '' }],
    '小偏远': [], '正常': [],
  });
  let r = region.listRules(db, '申通快递');
  assert.equal(r.hasConfig, true);
  assert.equal(r.groups['大偏远'].length, 1);

  r = region.saveRules(db, '申通快递', { '大偏远': [], '小偏远': [], '正常': [] });
  assert.equal(r.count, 0);
  assert.equal(r.hasConfig, false);

  region.saveRules(db, '申通快递', {
    '大偏远': [{ province: '海南省', city: '', district: '' }],
    '小偏远': [], '正常': [],
  });
  const cleared = region.clearRules(db, '申通快递');
  assert.equal(cleared.hasConfig, false);
  db.close();
});

// ---------- 5. 导入集成 ----------
test('import: 导入时按快递公司规则判定 region_class', () => {
  const db = setupDb();
  region.saveRules(db, '申通快递', {
    '大偏远': [{ province: '新疆维吾尔自治区', city: '', district: '' }],
    '小偏远': [{ province: '海南省', city: '', district: '' }],
    '正常': [],
  });
  // 内置规则：江苏省 → 小偏远（验证配置优先于内置）
  db.prepare("INSERT INTO shentong_region_class (province, city, region_class) VALUES ('江苏省', NULL, '小偏远')").run();

  const buf = xlsxBuf(HDR, [
    ['R001', '客户甲', 1, '2026-11-01', '新疆维吾尔自治区', '乌鲁木齐市', '', 'STO'],
    ['R002', '客户甲', 1, '2026-11-01', '海南省', '海口市', '', 'STO'],
    ['R003', '客户甲', 1, '2026-11-01', '江苏省', '南京市', '', 'STO'],
    ['R004', '客户甲', 1, '2026-11-01', '新疆维吾尔自治区', '乌鲁木齐市', '', 'ZTO'], // 中通未配置 → 回退内置
  ]);
  const r = processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  assert.equal(r.success, 4, JSON.stringify(r.failures));

  const cls = (no) => db.prepare('SELECT region_class FROM orders WHERE order_no=?').get(no).region_class;
  assert.equal(cls('R001'), '大偏远');
  assert.equal(cls('R002'), '小偏远');
  assert.equal(cls('R003'), '正常');        // 已配置申通规则 → 不再使用内置「小偏远」
  assert.equal(cls('R004'), '正常');        // 中通未配置 → 回退内置（新疆无内置规则 → 正常）
  db.close();
});

test('import: 正常区域已配置时，未覆盖地区写入「其他」', () => {
  const db = setupDb();
  region.saveRules(db, '申通快递', {
    '大偏远': [],
    '小偏远': [],
    '正常': [{ province: '浙江省', city: '', district: '' }],
  });
  const buf = xlsxBuf(HDR, [
    ['N001', '客户甲', 1, '2026-11-01', '浙江省', '杭州市', '西湖区', 'STO'],
    ['N002', '客户甲', 1, '2026-11-01', '江苏省', '南京市', '玄武区', 'STO'],
  ]);
  processImport({ db, req: REQ, fileBuf: buf, platform: '百世WMS' });
  const cls = (no) => db.prepare('SELECT region_class FROM orders WHERE order_no=?').get(no).region_class;
  assert.equal(cls('N001'), '正常');
  assert.equal(cls('N002'), '其他');
  db.close();
});

// ---------- 6. 历史订单重算（实时生效） ----------
test('region: 保存规则后重算该公司历史订单分类', () => {
  const db = setupDb();
  const cid = db.prepare("INSERT INTO customers (company_name) VALUES ('客户A')").run().lastInsertRowid;
  const ins = db.prepare(`INSERT INTO orders
    (order_no,customer_id,owner_name,ship_quantity,unit,order_date,to_province,to_city,to_district,region_class,waybill_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('H1', cid, '客户A', 1, '件', '2026-11-01', '新疆维吾尔自治区', '乌鲁木齐市', '', '正常', '申通快递');
  ins.run('H2', cid, '客户A', 1, '件', '2026-11-01', '浙江省', '杭州市', '', '正常', '中通快递');

  const r = region.saveRules(db, '申通快递', {
    '大偏远': [{ province: '新疆维吾尔自治区', city: '', district: '' }],
    '小偏远': [], '正常': [],
  });
  assert.equal(r.recalced, 1);
  assert.equal(db.prepare("SELECT region_class FROM orders WHERE order_no='H1'").get().region_class, '大偏远');
  assert.equal(db.prepare("SELECT region_class FROM orders WHERE order_no='H2'").get().region_class, '正常');
  db.close();
});

test('region: region-tree 汇总订单地址与规则区域', () => {
  const db = setupDb();
  const cid = db.prepare("INSERT INTO customers (company_name) VALUES ('客户A')").run().lastInsertRowid;
  db.prepare(`INSERT INTO orders (order_no,customer_id,owner_name,ship_quantity,unit,order_date,to_province,to_city,to_district)
    VALUES ('T1',?,'客户A',1,'件','2026-11-01','浙江省','杭州市','西湖区')`).run(cid);
  region.saveRules(db, '申通快递', {
    '大偏远': [{ province: '西藏自治区', city: '拉萨市', district: '城关区' }],
    '小偏远': [], '正常': [],
  });
  const tree = region.regionTree(db);
  const zj = tree.find((x) => x.province === '浙江省');
  assert.ok(zj);
  assert.ok(zj.cities.find((c) => c.city === '杭州市').districts.includes('西湖区'));
  assert.ok(tree.find((x) => x.province === '西藏自治区'));
  db.close();
});

// ---------- 7. 日期段重算（地区看板「更新」） ----------
test('region-recalc: 仅重算所选日期段内的订单，且可重复执行', () => {
  const db = setupDb();
  const cid = db.prepare("INSERT INTO customers (company_name) VALUES ('客户A')").run().lastInsertRowid;
  const ins = db.prepare(`INSERT INTO orders
    (order_no,customer_id,owner_name,ship_quantity,unit,order_date,to_province,to_city,to_district,region_class,waybill_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('D1', cid, '客户A', 1, '件', '2026-11-01', '新疆维吾尔自治区', '乌鲁木齐市', '', '正常', '申通快递');
  ins.run('D2', cid, '客户A', 1, '件', '2026-11-15', '新疆维吾尔自治区', '乌鲁木齐市', '', '正常', '申通快递');
  ins.run('D3', cid, '客户A', 1, '件', '2026-10-31', '新疆维吾尔自治区', '乌鲁木齐市', '', '正常', '申通快递');

  region.saveRules(db, '申通快递', {
    '大偏远': [{ province: '新疆维吾尔自治区', city: '', district: '' }],
    '小偏远': [], '正常': [],
  });
  // saveRules 已把 11 月两条算成偏远，先手动还原，模拟配置变更后手动更新
  db.prepare("UPDATE orders SET region_class='正常'").run();

  const r1 = region.recalcOrdersByRange(db, '2026-11-01', '2026-11-30');
  assert.deepEqual(r1, { total: 2, updated: 2 });
  assert.equal(db.prepare("SELECT region_class FROM orders WHERE order_no='D1'").get().region_class, '大偏远');
  assert.equal(db.prepare("SELECT region_class FROM orders WHERE order_no='D2'").get().region_class, '大偏远');
  assert.equal(db.prepare("SELECT region_class FROM orders WHERE order_no='D3'").get().region_class, '正常');

  const r2 = region.recalcOrdersByRange(db, '2026-11-01', '2026-11-30');
  assert.deepEqual(r2, { total: 2, updated: 0 });

  const empty = region.recalcOrdersByRange(db, '2020-01-01', '2020-01-31');
  assert.deepEqual(empty, { total: 0, updated: 0 });
  db.close();
});
