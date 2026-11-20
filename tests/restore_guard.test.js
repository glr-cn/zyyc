// ============================================================================
// 启动注入闸门测试（src/db/restoreGuard.js）
// ----------------------------------------------------------------------------
// 覆盖 run.sh 注入决策的全部五种裁决：
//   NO_BUNDLE / MISSING / EMPTY / OK / STALE（部分丢失检测）
// 以及 CLI 入口输出（require.main 分支的文本契约）
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDatabase } = require('../src/db/driver');
const { BIZ_TABLES, verdict } = require('../src/db/restoreGuard');

// —— 建真实库文件（verdict 只接路径）——
function makeDb(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rguard-'));
  const file = path.join(dir, name);
  const db = openDatabase(file);
  db.exec(`
    CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, company_name TEXT);
    CREATE TABLE orders (order_id INTEGER PRIMARY KEY, order_no TEXT);
    CREATE TABLE work_hours (work_id INTEGER PRIMARY KEY, workload REAL);
    CREATE TABLE inventory_transactions (id INTEGER PRIMARY KEY, quantity REAL);
  `);
  const insC = db.prepare('INSERT INTO customers (company_name) VALUES (?)');
  for (let i = 0; i < (opts.customers || 0); i++) insC.run('客户' + i);
  const insO = db.prepare('INSERT INTO orders (order_no) VALUES (?)');
  for (let i = 0; i < (opts.orders || 0); i++) insO.run('SF' + i);
  const insW = db.prepare('INSERT INTO work_hours (workload) VALUES (?)');
  for (let i = 0; i < (opts.workHours || 0); i++) insW.run(i + 1);
  const insI = db.prepare('INSERT INTO inventory_transactions (quantity) VALUES (?)');
  for (let i = 0; i < (opts.inventory || 0); i++) insI.run(i + 1);
  db.close();
  return file;
}

test('verdict: 包内备份不存在 → NO_BUNDLE（不注入，保持现状）', () => {
  const persist = makeDb('erp.db', { customers: 3 });
  const r = verdict(persist, path.join(os.tmpdir(), '不存在的备份-' + Date.now() + '.db'));
  assert.equal(r.v, 'NO_BUNDLE');
});

test('verdict: 持久库文件不存在 → MISSING（首次启动应注入）', () => {
  const bundle = makeDb('bundle.db', { customers: 5 });
  const r = verdict(path.join(os.tmpdir(), '不存在-' + Date.now() + '.db'), bundle);
  assert.equal(r.v, 'MISSING');
  assert.equal(r.bundle.rows.customers, 5);
});

test('verdict: 持久库业务表全空 → EMPTY（应注入）', () => {
  const persist = makeDb('erp.db', {});                 // 建表但 0 行
  const bundle = makeDb('bundle.db', { customers: 5 });
  const r = verdict(persist, bundle);
  assert.equal(r.v, 'EMPTY');
});

test('verdict: 持久库逐表 ≥ 备份 → OK（跳过注入）', () => {
  const persist = makeDb('erp.db', { customers: 6, orders: 10, workHours: 3, inventory: 2 });
  const bundle = makeDb('bundle.db', { customers: 5, orders: 10, workHours: 3, inventory: 0 });
  const r = verdict(persist, bundle);
  assert.equal(r.v, 'OK');
  assert.ok(!r.deficient);
});

test('verdict: 持久库任一业务表少于备份 → STALE（部分丢失，缺表清单准确）', () => {
  // persist: work_hours=2 < bundle: work_hours=5，其余相等或更多
  const persist = makeDb('erp.db', { customers: 5, orders: 10, workHours: 2, inventory: 1 });
  const bundle = makeDb('bundle.db', { customers: 5, orders: 10, workHours: 5, inventory: 1 });
  const r = verdict(persist, bundle);
  assert.equal(r.v, 'STALE');
  assert.deepEqual(r.deficient, ['work_hours']);
  assert.equal(r.bundle.rows.work_hours, 5);
  assert.equal(r.persist.rows.work_hours, 2);
});

test('verdict: 多表同时部分丢失 → STALE 且清单完整', () => {
  const persist = makeDb('erp.db', { customers: 5, orders: 0, workHours: 0, inventory: 1 });
  const bundle = makeDb('bundle.db', { customers: 5, orders: 3, workHours: 4, inventory: 1 });
  const r = verdict(persist, bundle);
  assert.equal(r.v, 'STALE');
  assert.ok(r.deficient.includes('orders') && r.deficient.includes('work_hours'));
  assert.equal(r.deficient.length, 2);
});

test('CLI 契约：node src/db/restoreGuard.js 输出单个裁决单词', () => {
  const { spawnSync } = require('child_process');
  const persist = makeDb('erp.db', { customers: 5 });
  const bundle = makeDb('bundle.db', { customers: 5 });
  const guard = path.join(__dirname, '..', 'src', 'db', 'restoreGuard.js');
  const r = spawnSync('node', [guard, persist, bundle], { encoding: 'utf8', timeout: 60000 });
  assert.equal(String(r.stdout).trim(), 'OK');

  // STALE 场景也走一次 CLI，确认 run.sh 的 STALE* 前缀匹配能命中
  const persistStale = makeDb('erp2.db', { customers: 5, workHours: 1 });
  const bundleStale = makeDb('bundle2.db', { customers: 5, workHours: 5 });
  const r2 = spawnSync('node', [guard, persistStale, bundleStale], { encoding: 'utf8', timeout: 60000 });
  assert.equal(String(r2.stdout).trim(), 'STALE');
});

test('BIZ_TABLES 与 dbPath.BUSINESS_TABLES 对齐（7 张 + warehouse_sort_config）', () => {
  const { BUSINESS_TABLES } = require('../src/db/dbPath');
  for (const t of BUSINESS_TABLES) assert.ok(BIZ_TABLES.includes(t), `缺少业务表 ${t}`);
  assert.ok(BIZ_TABLES.includes('warehouse_sort_config'));
});
