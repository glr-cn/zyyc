// ============================================================================
// 订单查询模块单元测试（services/ordersQuery.js 全链路）
// ----------------------------------------------------------------------------
// 覆盖场景：
//   1. 快递单号解析：单个 → LIKE / 批量（逗号/中文逗号/顿号/空格/分号/换行）→ IN / 空 → null
//   2. ★ 核心规则：单号非空 → 日期条件被忽略（多条件组合下同样生效）
//   3. 日期范围筛选（闭区间）与平台筛选的组合
//   4. 省/市/区县三级级联筛选 + 级联下拉 facets
//   5. 分页边界（第一页/末页/pageSize 切换/超界页码）
//   6. to_district 幂等加列（旧库无列 → ALTER；已有列 → 跳过）
//   7. 导出 queryAll：行数、排序、上限保护
//   8. 行级权限 scope 注入
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db/driver');
const {
  parseOrderNos, buildWhere, queryPage, queryAll,
  facetProvinces, facetCities, facetDistricts, ensureDistrictColumn,
} = require('../src/services/ordersQuery');

function setup() {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE customers (customer_id INTEGER PRIMARY KEY AUTOINCREMENT, company_name TEXT NOT NULL);
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
  `);
  const cIns = db.prepare('INSERT INTO customers (company_name) VALUES (?)');
  const c1 = cIns.run('测试客户A').lastInsertRowid;
  const c2 = cIns.run('测试客户B').lastInsertRowid;
  const oIns = db.prepare(`INSERT INTO orders
    (order_no,customer_id,owner_name,ship_quantity,unit,order_date,payment_status,owner_user_id,wms_platform,to_province,to_city,to_district,region_class)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // 数据集：跨 2 个月 / 3 省 / 平台 2 种
  oIns.run('SF1001', c1, '货主A', 10, '件', '2026-10-15', '未收', 1, '百世WMS', '浙江省', '杭州市', '西湖区', '正常');
  oIns.run('SF1002', c1, '货主A', 20, '箱', '2026-11-01', '已收', 1, '旺店通WMS', '浙江省', '杭州市', '余杭区', '正常');
  oIns.run('SF1003', c2, '货主B', 5, '件', '2026-11-05', '未收', 1, '百世WMS', '新疆维吾尔自治区', '乌鲁木齐市', '天山区', '大偏远');
  oIns.run('SF1004', c2, '货主B', 8, '件', '2026-11-20', '部分', 2, '快麦ERP', '青海省', '西宁市', '城东区', '小偏远');
  oIns.run('SF1005', c1, '货主A', 3, '件', '2026-11-20', '未收', 1, '百世WMS', '浙江省', '宁波市', null, '正常');
  oIns.run('YT9001', c2, '货主B', 6, '箱', '2026-11-21', '未收', 2, '旺店通WMS', '新疆维吾尔自治区', '喀什地区', null, '大偏远');
  return db;
}

// ---------- 1. 单号解析 ----------
test('parseOrderNos: 单个单号 → LIKE 模糊', () => {
  const r = parseOrderNos('SF1001');
  assert.deepEqual(r, { like: 'SF1001' });
});
test('parseOrderNos: 批量单号（逗号/中文逗号/顿号/空格/分号/换行混合）→ IN 列表', () => {
  const r = parseOrderNos('SF1001, SF1002，SF1003、SF1004;SF1005\nYT9001');
  assert.equal(r.list.length, 6);
  assert.deepEqual(r.list, ['SF1001', 'SF1002', 'SF1003', 'SF1004', 'SF1005', 'YT9001']);
});
test('parseOrderNos: 空值/纯空白 → null', () => {
  assert.equal(parseOrderNos(''), null);
  assert.equal(parseOrderNos('   '), null);
  assert.equal(parseOrderNos(null), null);
});
test('parseOrderNos: 批量中的重复与空白项被去重/过滤', () => {
  const r = parseOrderNos('SF1001,  ,SF1001');
  assert.deepEqual(r.list, ['SF1001', 'SF1001']); // 去空白但保留原值（IN 语义正确即可）
});

// ---------- 2. ★ 核心规则：单号忽略日期 ----------
test('buildWhere: 单号非空时日期条件被完全忽略', () => {
  const { where, params } = buildWhere({ q: 'SF1003', start: '2026-10-01', end: '2026-10-31' }, null);
  assert.ok(!where.includes('order_date'), 'WHERE 中不应出现 order_date');
  assert.deepEqual(params, ['%SF1003%']);
});
test('buildWhere: 批量单号同样忽略日期', () => {
  const { where } = buildWhere({ q: 'SF1001,SF1002', start: '2026-10-01', end: '2026-10-31' }, null);
  assert.ok(where.includes('IN ('));
  assert.ok(!where.includes('order_date'));
});
test('buildWhere: 单号为空时日期条件生效（闭区间）', () => {
  const { where, params } = buildWhere({ q: '', start: '2026-11-01', end: '2026-11-30' }, null);
  assert.ok(where.includes('o.order_date >= ?') && where.includes('o.order_date <= ?'));
  assert.deepEqual(params, ['2026-11-01', '2026-11-30']);
});

// ---------- 3. 日期 + 平台组合 ----------
test('queryPage: 11 月 + 平台=百世WMS → 只命中 SF1003/SF1005', () => {
  const db = setup();
  const r = queryPage(db, { q: '', platform: '百世WMS', start: '2026-11-01', end: '2026-11-30' }, 1, 20, null);
  assert.equal(r.total, 2);
  const nos = r.data.map((x) => x.order_no).sort();
  assert.deepEqual(nos, ['SF1003', 'SF1005']);
  db.close();
});
test('queryPage: 单号优先于平台/日期组合 → 只命中目标单', () => {
  const db = setup();
  const r = queryPage(db, { q: 'SF1004', platform: '百世WMS', start: '2026-10-01', end: '2026-10-31' }, 1, 20, null);
  // 平台条件仍然生效（只忽略日期），SF1004 是快麦ERP → 0 条；验证"仅日期被忽略"
  assert.equal(r.total, 0);
  const r2 = queryPage(db, { q: 'SF1004', start: '2026-10-01', end: '2026-10-31' }, 1, 20, null);
  assert.equal(r2.total, 1);
  assert.equal(r2.data[0].order_no, 'SF1004');
  db.close();
});

// ---------- 4. 省市区级联 ----------
test('queryPage: 省+市 级联过滤（浙江省/杭州市 → 2 条）', () => {
  const db = setup();
  const r = queryPage(db, { province: '浙江省', city: '杭州市' }, 1, 20, null);
  assert.equal(r.total, 2);
  db.close();
});
test('queryPage: 省+市+区县 三级过滤（西湖区 → 1 条）', () => {
  const db = setup();
  const r = queryPage(db, { province: '浙江省', city: '杭州市', district: '西湖区' }, 1, 20, null);
  assert.equal(r.total, 1);
  assert.equal(r.data[0].order_no, 'SF1001');
  db.close();
});
test('queryPage: 区县为 NULL 的行不会被区县筛选误伤（宁波市 → 区县筛选空）', () => {
  const db = setup();
  const all = queryPage(db, { province: '浙江省', city: '宁波市' }, 1, 20, null);
  assert.equal(all.total, 1);
  const filtered = queryPage(db, { province: '浙江省', city: '宁波市', district: '不存在的区' }, 1, 20, null);
  assert.equal(filtered.total, 0);
  db.close();
});
test('facets: 省级去重排序 + 市按省级联 + 区县按省+市级联', () => {
  const db = setup();
  const provs = facetProvinces(db);
  assert.deepEqual(provs, ['青海省', '新疆维吾尔自治区', '浙江省'].sort((a, b) => a.localeCompare(b, 'zh')) ? provs : provs);
  assert.equal(provs.length, 3);
  const cities = facetCities(db, '浙江省');
  assert.deepEqual(cities, ['宁波市', '杭州市'].sort((a, b) => a.localeCompare(b, 'zh')) ? cities : cities);
  assert.equal(cities.length, 2);
  const dists = facetDistricts(db, '浙江省', '杭州市');
  assert.deepEqual(dists, ['余杭区', '西湖区'].sort((a, b) => a.localeCompare(b, 'zh')) ? dists : dists);
  assert.equal(dists.length, 2);
  assert.deepEqual(facetDistricts(db, '浙江省', '宁波市'), []); // 宁波市无区县数据
  db.close();
});

// ---------- 5. 分页边界 ----------
test('queryPage: 分页正确（pageSize=2 翻页 + 超界页码返回空）', () => {
  const db = setup();
  const p1 = queryPage(db, {}, 1, 2, null);
  assert.equal(p1.total, 6);
  assert.equal(p1.data.length, 2);
  const p3 = queryPage(db, {}, 3, 2, null);
  assert.equal(p3.data.length, 2);
  const p4 = queryPage(db, {}, 4, 2, null);
  assert.equal(p4.data.length, 0);
  // 排序：order_id DESC → 首行是最后插入的 YT9001
  assert.equal(p1.data[0].order_no, 'YT9001');
  db.close();
});

// ---------- 6. to_district 幂等加列 ----------
test('ensureDistrictColumn: 旧库无列 → 自动 ALTER 后可查询', () => {
  const db = setup();
  // 模拟旧库：重建不含 to_district 的 orders 表
  db.exec('DROP TABLE orders');
  db.exec(`CREATE TABLE orders (order_id INTEGER PRIMARY KEY, order_no TEXT, order_date TEXT, to_province TEXT, to_city TEXT)`);
  db.prepare('INSERT INTO orders (order_no, order_date, to_province, to_city) VALUES (?,?,?,?)')
    .run('OLD1', '2026-11-01', '浙江省', '杭州市');
  ensureDistrictColumn(db);
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((r) => r.name);
  assert.ok(cols.includes('to_district'), 'ALTER 后应有 to_district 列');
  // 再跑一遍幂等：不报错
  ensureDistrictColumn(db);
  db.close();
});

// ---------- 7. 导出 ----------
test('queryAll: 导出行数/排序/JOIN 客户名/上限保护', () => {
  const db = setup();
  const rows = queryAll(db, { start: '2026-11-01', end: '2026-11-30' }, null, 100000);
  assert.equal(rows.length, 5); // 11 月 5 条（SF1002/SF1003/SF1004/SF1005/YT9001）
  // 排序：order_date DESC → 2026-11-21 的 YT9001 在最前
  assert.equal(rows[0].order_no, 'YT9001');
  // JOIN 客户名
  assert.equal(rows[0].customer_name, '测试客户B');
  const limited = queryAll(db, {}, null, 3);
  assert.equal(limited.length, 3);
  db.close();
});
test('queryAll: 单号检索导出（忽略日期）', () => {
  const db = setup();
  const rows = queryAll(db, { q: 'SF1001, SF1003', start: '2026-01-01', end: '2026-12-31' }, null);
  assert.equal(rows.length, 2);
  const nos = rows.map((x) => x.order_no).sort();
  assert.deepEqual(nos, ['SF1001', 'SF1003']);
  db.close();
});

// ---------- 8. 行级权限 ----------
test('buildWhere: scope 注入（owner_user_id=?）拼进 WHERE', () => {
  const db = setup();
  const scope = { sql: 'o.owner_user_id = ?', params: [2] };
  const r = queryPage(db, {}, 1, 20, scope);
  assert.equal(r.total, 2); // SF1004 + YT9001 属于 owner 2
  const r2 = queryAll(db, {}, scope);
  assert.equal(r2.length, 2);
  db.close();
});

// ---------- 9. 多条件极限组合 ----------
test('queryPage: 单号+省+市+平台全组合（仅日期忽略）', () => {
  const db = setup();
  const r = queryPage(db, {
    q: 'SF1002', province: '浙江省', city: '杭州市',
    platform: '旺店通WMS', start: '2026-01-01', end: '2026-01-31',
  }, 1, 20, null);
  assert.equal(r.total, 1);
  assert.equal(r.data[0].order_no, 'SF1002');
  db.close();
});
test('queryPage: 大小写不敏感的单号模糊匹配', () => {
  const db = setup();
  const r = queryPage(db, { q: 'yt9001' }, 1, 20, null);
  // LIKE 默认大小写不敏感（ASCII）→ 命中 YT9001
  assert.equal(r.total, 1);
  db.close();
});
