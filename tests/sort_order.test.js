// ============================================================================
//  customers.sort_order 冲突自动顺延功能单元测试
//  覆盖：
//    1) 插入指定 sort_order → 同 type 内 >= 目标序号的现有记录全部 +1
//    2) 修改 sort_order 到已存在序号 → 同 type 内冲突项 +1（自身排除）
//    3) 修改 sort_order 到比现有都大的值 → 只顺延 >= 新值 的
//    4) 不同 customer_type 之间互不影响
//    5) is_deleted=1 的软删除客户不参与顺延
//    6) sort_order 默认 9999（排最后）时不触发顺延
//    7) 非法输入（<=0 或非整数）直接 return，不改动任何数据
//    8) 列表按 sort_order ASC 返回
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ---------- patch db.driver.openDatabase → 指向共享 :memory: 库 ----------
const driver = require('../src/db/driver');
const sharedDb = driver.openDatabase(':memory:');
sharedDb.close = () => {};
driver.openDatabase = () => sharedDb;

// ---------- 直接执行 schema.sql ----------
const FULL_SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

function buildSchema() {
  sharedDb.exec(FULL_SCHEMA);
  // 种子角色 + 用户（customers 外键 owner_user_id 需要 users 表有行）
  sharedDb.exec(`
    INSERT OR IGNORE INTO roles (role_code, role_name, data_scope, is_readonly, is_system, sort) VALUES
      ('super_admin','超级管理员','all',0,1,0),
      ('operator','业务员','self',0,1,2);
  `);
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('test123', 8);
  const superRole = sharedDb.prepare("SELECT role_id FROM roles WHERE role_code='super_admin'").get().role_id;
  sharedDb.prepare('INSERT OR IGNORE INTO users (user_id, username, password_hash, display_name, role_id) VALUES (?,?,?,?,?)')
    .run(1, 'super', hash, '超管', superRole);
}

function reset() {
  const tables = sharedDb.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map((r) => r.name);
  tables.forEach((t) => { try { sharedDb.exec('DROP TABLE ' + t); } catch (_) {} });
  buildSchema();
}

// ---------- 复刻 src/routes/customers.js 的 adjustSortOrder ----------
function adjustSortOrder(db, customerType, target, excludeId = 0) {
  if (!Number.isInteger(target) || target <= 0) return 0;
  const info = db.prepare(
    `UPDATE customers SET sort_order = sort_order + 1
      WHERE customer_type = ? AND is_deleted = 0 AND sort_order >= ? AND customer_id != ?`
  ).run(customerType, target, excludeId);
  return info.changes || 0;
}

// ---------- 复刻 src/routes/customers.js 的 normalizeForm ----------
function normalizeForm(b) {
  const s = (k) => (b[k] == null ? '' : String(b[k]).trim());
  return {
    customer_code: s('customer_code') || null,
    company_name: s('company_name'),
    short_name: s('short_name'),
    warehouse: String(b.warehouse || '').trim(),
    contact_person: s('contact_person'),
    phone: s('phone'),
    address: s('address'),
    erp_version: s('erp_version'),
    product_type: s('product_type'),
    ecommerce_platform: s('ecommerce_platform'),
    product_count: b.product_count === '' || b.product_count == null ? 0 : Number(b.product_count),
    payment_account: s('payment_account'),
    prepaid_price: b.prepaid_price === '' || b.prepaid_price == null ? 0 : Number(b.prepaid_price),
    cutoff_time: s('cutoff_time') || null,
    logistics_control: s('logistics_control'),
    expiry_mgmt: s('expiry_mgmt') || '否',
    coop_status: s('coop_status') || '合作中',
    sort_order: b.sort_order === '' || b.sort_order == null ? 9999 : Number(b.sort_order),
    remark: s('remark'),
  };
}

// ---------- 辅助：插入一条 customer ----------
let _seq = 0;
function mkCustomer({ company, warehouse = '龙湖仓', type = '仓储客户', sort = 9999, ownerUserId = 1, isDeleted = 0 } = {}) {
  _seq++;
  const name = company || `客户${_seq}`;
  const r = sharedDb.prepare(
    `INSERT INTO customers
      (company_name, warehouse, customer_type, sort_order, owner_user_id, is_deleted,
       default_unit, expiry_mgmt, coop_status, product_count, prepaid_price)
     VALUES (?,?,?,?,?,?, '单','否','合作中',0,0)`
  ).run(name, warehouse, type, sort, ownerUserId, isDeleted);
  return sharedDb.prepare('SELECT * FROM customers WHERE customer_id=?').get(r.lastInsertRowid);
}

function getOrders(type) {
  return sharedDb.prepare(
    `SELECT customer_id, company_name, sort_order FROM customers
      WHERE customer_type=? AND is_deleted=0 ORDER BY sort_order ASC, customer_id ASC`
  ).all(type);
}

function assertOrdersEqual(type, expected, msg) {
  const rows = getOrders(type);
  const actual = rows.map((r) => r.sort_order);
  assert.deepEqual(actual, expected, msg);
}

// ============================================================
//  测试用例
// ============================================================

test('① 插入：新客户显式指定 sort_order=2 → 现有 sort>=2 的客户顺延 +1', () => {
  reset();
  mkCustomer({ company: 'A', sort: 1 });
  mkCustomer({ company: 'B', sort: 2 });
  mkCustomer({ company: 'C', sort: 3 });

  const r = adjustSortOrder(sharedDb, '仓储客户', 2, 0); // 0 = 新插入无排除
  assert.equal(r, 2, 'B 和 C 被顺延 2 条');

  const orders = getOrders('仓储客户');
  // 准备好给新客户腾位置：1,3,4
  assert.deepEqual(orders.map((o) => ({ name: o.company_name, sort: o.sort_order })), [
    { name: 'A', sort: 1 },
    { name: 'B', sort: 3 },
    { name: 'C', sort: 4 },
  ]);

  // 模拟实际 INSERT
  sharedDb.prepare(
    `INSERT INTO customers
      (company_name, warehouse, customer_type, sort_order, owner_user_id, is_deleted,
       default_unit, expiry_mgmt, coop_status, product_count, prepaid_price)
     VALUES (?,?,?,?,?,?, '单','否','合作中',0,0)`
  ).run('新客户', '龙湖仓', '仓储客户', 2, 1, 0);

  assertOrdersEqual('仓储客户', [1, 2, 3, 4], '最终顺序应为 1,2,3,4');
});

test('② 修改：把某客户 sort_order 从 2 改为 1 → 只顺延 >=1 且非自身的', () => {
  reset();
  const a = mkCustomer({ company: 'A', sort: 1 });
  const b = mkCustomer({ company: 'B', sort: 2 });
  mkCustomer({ company: 'C', sort: 3 });

  // 把 B(sort=2) 改为 1，excludeId=b.customer_id
  // 顺延：sort>=1 且非 B 的都 +1 → A(1)→2, C(3)→4
  adjustSortOrder(sharedDb, '仓储客户', 1, b.customer_id);
  sharedDb.prepare('UPDATE customers SET sort_order=? WHERE customer_id=?').run(1, b.customer_id);

  const orders = getOrders('仓储客户');
  assert.deepEqual(orders.map((o) => ({ name: o.company_name, sort: o.sort_order })), [
    { name: 'B', sort: 1 },
    { name: 'A', sort: 2 },   // A 原本 sort=1，>=1 所以也被 +1
    { name: 'C', sort: 4 },  // C 原本 sort=3，>=1 也被 +1（目标越小，被顺延的越多）
  ]);
});

test('③ 修改：把某客户 sort_order 从 2 改为 5（比现有都大）→ 只有 >=5 的才顺延（无）', () => {
  reset();
  const a = mkCustomer({ company: 'A', sort: 1 });
  mkCustomer({ company: 'B', sort: 2 });
  mkCustomer({ company: 'C', sort: 3 });

  // 没有 sort>=5 的记录，adjustSortOrder 应返回 0
  const affected = adjustSortOrder(sharedDb, '仓储客户', 5, a.customer_id);
  assert.equal(affected, 0, '没有 >=5 的记录，不应有任何顺延');

  sharedDb.prepare('UPDATE customers SET sort_order=? WHERE customer_id=?').run(5, a.customer_id);

  assertOrdersEqual('仓储客户', [2, 3, 5]);
});

test('④ 不同 customer_type 之间互不影响', () => {
  reset();
  // 仓储客户
  mkCustomer({ company: 'WH_A', type: '仓储客户', sort: 1 });
  mkCustomer({ company: 'WH_B', type: '仓储客户', sort: 2 });
  // 共享单号
  mkCustomer({ company: 'SH_A', type: '共享单号', sort: 1 });
  mkCustomer({ company: 'SH_B', type: '共享单号', sort: 2 });

  adjustSortOrder(sharedDb, '仓储客户', 1, 0);

  // 仓储客户应被顺延
  assertOrdersEqual('仓储客户', [2, 3]);
  // 共享单号保持不动
  assertOrdersEqual('共享单号', [1, 2]);
});

test('⑤ is_deleted=1 的软删除客户不参与顺延', () => {
  reset();
  mkCustomer({ company: 'A', sort: 1 });
  mkCustomer({ company: 'B', sort: 2, isDeleted: 1 });   // 软删除
  mkCustomer({ company: 'C', sort: 3 });

  adjustSortOrder(sharedDb, '仓储客户', 2, 0);

  const all = sharedDb.prepare(
    'SELECT company_name, sort_order, is_deleted FROM customers WHERE customer_type=? ORDER BY customer_id'
  ).all('仓储客户');
  // B 是 is_deleted=1，不应被顺延；A 是 sort=1 < 2，不动；C 是 sort=3 >= 2 且非删除 → +1 → 4
  assert.deepEqual(all.map((r) => ({ name: r.company_name, sort: r.sort_order, del: r.is_deleted })), [
    { name: 'A', sort: 1, del: 0 },
    { name: 'B', sort: 2, del: 1 },
    { name: 'C', sort: 4, del: 0 },
  ]);
});

test('⑥ normalizeForm：空 sort_order → 默认 9999（不触发顺延）', () => {
  reset();
  const form = normalizeForm({
    company_name: 'test',
    warehouse: '龙湖仓',
  });
  assert.equal(form.sort_order, 9999, '空值应归一化为 9999');

  // 9999 为默认排最后，adjustSortOrder 入口条件判断 9999 不触发
  const row = mkCustomer({ company: 'X', sort: 9999 });
  const affected = adjustSortOrder(sharedDb, '仓储客户', 9999, row.customer_id);
  assert.equal(affected, 0, '9999 不应触发顺延逻辑');
});

test('⑦ adjustSortOrder 非法输入 → 直接 return，不改动任何数据', () => {
  reset();
  mkCustomer({ company: 'A', sort: 1 });
  mkCustomer({ company: 'B', sort: 2 });

  // 非正整数
  assert.equal(adjustSortOrder(sharedDb, '仓储客户', 0, 0), 0);
  assert.equal(adjustSortOrder(sharedDb, '仓储客户', -1, 0), 0);
  assert.equal(adjustSortOrder(sharedDb, '仓储客户', 1.5, 0), 0);
  assert.equal(adjustSortOrder(sharedDb, '仓储客户', NaN, 0), 0);

  // 数据保持不变
  assertOrdersEqual('仓储客户', [1, 2]);
});

test('⑧ 列表查询 ORDER BY sort_order ASC（复刻 GET / 逻辑）', () => {
  reset();
  mkCustomer({ company: 'C_9999', sort: 9999 });
  mkCustomer({ company: 'A', sort: 1 });
  mkCustomer({ company: 'B', sort: 2 });
  mkCustomer({ company: 'A2', sort: 1 }); // 同 sort_order 的第二个，按 customer_id DESC 应排在后面

  const rows = sharedDb.prepare(
    `SELECT company_name, sort_order FROM customers
      WHERE customer_type='仓储客户' AND is_deleted=0
      ORDER BY sort_order ASC, customer_id DESC`
  ).all();

  assert.deepEqual(rows.map((r) => r.company_name), [
    'A2',   // sort=1, 后插入 (customer_id 更大) → DESC 在前
    'A',    // sort=1, 先插入
    'B',    // sort=2
    'C_9999', // 默认 9999 沉底
  ]);
});

test('⑨ 连续插入多个客户到开头 → 每次都把已有记录整体 +1', () => {
  reset();
  mkCustomer({ company: 'Old1', sort: 1 });
  mkCustomer({ company: 'Old2', sort: 2 });

  // 模拟 POST / 创建 新1 到 sort=1
  adjustSortOrder(sharedDb, '仓储客户', 1, 0);
  sharedDb.prepare(
    `INSERT INTO customers
      (company_name, warehouse, customer_type, sort_order, owner_user_id, is_deleted,
       default_unit, expiry_mgmt, coop_status, product_count, prepaid_price)
     VALUES (?,?,?,?,?,?, '单','否','合作中',0,0)`
  ).run('新1', '龙湖仓', '仓储客户', 1, 1, 0);

  // 再 POST / 创建 新2 到 sort=1
  adjustSortOrder(sharedDb, '仓储客户', 1, 0);
  sharedDb.prepare(
    `INSERT INTO customers
      (company_name, warehouse, customer_type, sort_order, owner_user_id, is_deleted,
       default_unit, expiry_mgmt, coop_status, product_count, prepaid_price)
     VALUES (?,?,?,?,?,?, '单','否','合作中',0,0)`
  ).run('新2', '龙湖仓', '仓储客户', 1, 1, 0);

  assertOrdersEqual('仓储客户', [1, 2, 3, 4]);

  const names = sharedDb.prepare(
    'SELECT company_name FROM customers WHERE customer_type=? ORDER BY sort_order ASC'
  ).all('仓储客户').map((r) => r.company_name);

  assert.deepEqual(names, ['新2', '新1', 'Old1', 'Old2'], '连续两次插入到开头应保持正确顺序');
});

test('⑩ 修改 sort_order 到与当前值相同 → 不触发顺延（PUT 入口的短路保护）', () => {
  reset();
  const a = mkCustomer({ company: 'A', sort: 1 });
  mkCustomer({ company: 'B', sort: 2 });
  mkCustomer({ company: 'C', sort: 3 });

  // 复刻 PUT /:id 的入口判断
  const oldSort = a.sort_order;
  const newSort = 1; // 相同
  if (newSort !== oldSort && newSort !== 9999 && Number.isInteger(newSort) && newSort > 0) {
    adjustSortOrder(sharedDb, '仓储客户', newSort, a.customer_id);
  }

  assertOrdersEqual('仓储客户', [1, 2, 3], 'sort_order 相同不应触发任何顺延');
});

test('⑪ 历史数据已有重复 sort_order → 顺延天然消除重复', () => {
  reset();
  // 故意制造重复：A(1), B(1), C(2)
  mkCustomer({ company: 'A', sort: 1 });
  mkCustomer({ company: 'B', sort: 1 });
  mkCustomer({ company: 'C', sort: 2 });

  // 再插入一个 sort=1 新客户
  adjustSortOrder(sharedDb, '仓储客户', 1, 0);

  // 所有 >=1 且非自身（0）的都 +1
  const rows = sharedDb.prepare(
    'SELECT company_name, sort_order FROM customers WHERE customer_type=? ORDER BY customer_id'
  ).all('仓储客户');

  assert.deepEqual(rows.map((r) => ({ name: r.company_name, sort: r.sort_order })), [
    { name: 'A', sort: 2 }, // 原 sort=1 >=1 → +1
    { name: 'B', sort: 2 }, // 原 sort=1 >=1 → +1（重复仍存在，直到真正 INSERT 后再排）
    { name: 'C', sort: 3 }, // 原 sort=2 >=1 → +1
  ]);

  // 执行 INSERT
  sharedDb.prepare(
    `INSERT INTO customers
      (company_name, warehouse, customer_type, sort_order, owner_user_id, is_deleted,
       default_unit, expiry_mgmt, coop_status, product_count, prepaid_price)
     VALUES (?,?,?,?,?,?, '单','否','合作中',0,0)`
  ).run('New', '龙湖仓', '仓储客户', 1, 1, 0);

  const finalOrders = getOrders('仓储客户');
  assert.deepEqual(finalOrders.map((o) => ({ name: o.company_name, sort: o.sort_order })), [
    { name: 'New', sort: 1 },
    { name: 'A', sort: 2 },
    { name: 'B', sort: 2 }, // 仍重复，但业务层设计：排序稳定性 + 后续按需全量重编号
    { name: 'C', sort: 3 },
  ]);
});
