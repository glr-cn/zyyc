// ============================================================================
// 发货单量整数化 —— 单元测试
// ----------------------------------------------------------------------------
// 业务规则：
//   1. 表单/接口：非整数直接拒绝（不四舍五入），范围 1 ~ 1,000,000
//   2. 导入/历史数据：四舍五入取整（禁止截断），存储/派生计算/接口返回均无小数
//   3. 空值允许（无单量仅备注场景），但 0 视为非法（要求留空）
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/workhours');
const { openDatabase } = require('../src/db/driver');

// ---------- 1. 表单/接口入参：严格整数校验 ----------

test('normalizeShipOrders：合法整数（含字符串）→ 原值，无错误', () => {
  assert.deepEqual(svc.normalizeShipOrders(100), { value: 100, error: null });
  assert.deepEqual(svc.normalizeShipOrders('260'), { value: 260, error: null });
  assert.deepEqual(svc.normalizeShipOrders(' 1260 '), { value: 1260, error: null });
  assert.deepEqual(svc.normalizeShipOrders(1000000), { value: 1000000, error: null });
});

test('normalizeShipOrders：小数必须拒绝（不允许四舍五入绕过）', () => {
  for (const v of [100.5, '100.01', 0.4, '1260.0001']) {
    const r = svc.normalizeShipOrders(v);
    assert.equal(r.value, null);
    assert.match(r.error, /必须为整数/);
  }
});

test('normalizeShipOrders：0 / 负数 / 超上限 / 非数字 → 拒绝', () => {
  assert.match(svc.normalizeShipOrders(0).error, /必须大于 0/);
  assert.match(svc.normalizeShipOrders('0.4').error, /必须为整数|必须大于 0/);
  assert.match(svc.normalizeShipOrders(-5).error, /必须大于 0|必须为整数/);
  assert.match(svc.normalizeShipOrders(1000001).error, /不能超过/);
  assert.match(svc.normalizeShipOrders('abc').error, /必须为数字/);
  assert.match(svc.normalizeShipOrders(Infinity).error, /必须为数字/);
});

test('normalizeShipOrders：空值允许（无单量仅备注）', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.deepEqual(svc.normalizeShipOrders(v), { value: null, error: null });
  }
});

// ---------- 2. 导入/历史数据：四舍五入 ----------

test('roundShipOrders：四舍五入（禁止截断）', () => {
  assert.equal(svc.roundShipOrders('1260.4'), 1260);
  assert.equal(svc.roundShipOrders('1260.5'), 1261);
  assert.equal(svc.roundShipOrders(1260.49), 1260);
  assert.equal(svc.roundShipOrders('2.5'), 3);
  assert.equal(svc.roundShipOrders(0.6), 1);
  assert.equal(svc.roundShipOrders('100'), 100);
  assert.equal(svc.roundShipOrders(''), null);
  assert.equal(svc.roundShipOrders(null), null);
  assert.equal(svc.roundShipOrders('abc'), null);
});

test('calcRow：发货单量在派生计算前已取整，时效/单均成本基于整数', () => {
  const r = { ship_orders: '100.6', main_hours: 10, other_hours: 2, shared_hours: 0 };
  svc.calcRow('发货', r);
  assert.equal(r.ship_orders, 101);
  assert.equal(Number.isInteger(r.ship_orders), true);
  assert.equal(r.efficiency, 10.1);           // 101 / 10
  assert.equal(r.unit_cost, Number((12 / 101).toFixed(3)));
});

// ---------- 3. 保存校验（validateByType） ----------

function dbWithCustomer() {
  const db = openDatabase(':memory:');
  db.exec(`CREATE TABLE customers (
    customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL, short_name TEXT, warehouse TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0, coop_status TEXT NOT NULL DEFAULT '合作中',
    sort_order INTEGER DEFAULT 9999, default_unit TEXT DEFAULT '单', owner_user_id INTEGER
  )`);
  db.exec(`INSERT INTO customers (customer_id, company_name, warehouse) VALUES (1, '货主A', '龙湖仓')`);
  return db;
}

const base = { warehouse: '龙湖仓', customer_id: 1, customer_name: '货主A', date: '2026-11-21', main_hours: 0, remark: '' };

test('validateByType(发货)：小数 / 0 / 负数 / 超上限 → 返回明确错误', () => {
  const db = dbWithCustomer();
  assert.match(svc.validateByType('发货', { ...base, ship_orders: '12.5' }, db), /必须为整数/);
  assert.match(svc.validateByType('发货', { ...base, ship_orders: 0 }, db), /必须大于 0/);
  assert.match(svc.validateByType('发货', { ...base, ship_orders: -3 }, db), /必须大于 0|必须为整数/);
  assert.match(svc.validateByType('发货', { ...base, ship_orders: 1000001 }, db), /不能超过/);
});

test('validateByType(发货)：合法整数放行；空值 + 主工时/备注 也放行', () => {
  const db = dbWithCustomer();
  assert.equal(svc.validateByType('发货', { ...base, ship_orders: '1260' }, db), null);
  assert.equal(svc.validateByType('发货', { ...base, ship_orders: '', main_hours: 8 }, db), null);
  assert.equal(svc.validateByType('发货', { ...base, ship_orders: '', remark: '无单量' }, db), null);
  // 三者全空 → 仍拦截
  assert.match(svc.validateByType('发货', { ...base, ship_orders: '' }, db), /至少填写一项/);
});
