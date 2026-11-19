// ============================================================================
//  warehouse_sort_config 分仓独立排序功能单元测试
//  覆盖：
//    1) 表存在 + 主键(warehouse, customer_id)
//    2) 不同仓库配置互不干扰 —— 同一 customer_id 在不同 warehouse 有独立 sort_order
//    3) 列表查询按 COALESCE(wsc, c.sort_order, 9999) 排序
//    4) 缺失 wsc 行回退 customers.sort_order
//    5) 切仓库独立排序互不干扰
//    6) PUT upsert + 事务一致性
//    7) 删除客户 ON DELETE CASCADE
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const driver = require('../src/db/driver');
const FULL_SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

function freshDb() {
  const db = driver.openDatabase(':memory:');
  db.exec(FULL_SCHEMA);
  // 种子角色 + 用户
  db.exec(`
    INSERT OR IGNORE INTO roles (role_code, role_name, data_scope, is_readonly, is_system, sort) VALUES
      ('super_admin','超级管理员','all',0,1,0),
      ('operator','业务员','self',0,1,2);
  `);
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('test123', 8);
  const superRole = db.prepare("SELECT role_id FROM roles WHERE role_code='super_admin'").get().role_id;
  db.prepare('INSERT OR IGNORE INTO users (user_id, username, password_hash, display_name, role_id) VALUES (?,?,?,?,?)')
    .run(1, 'super', hash, '超管', superRole);
  return db;
}

function seedCustomers(db) {
  db.exec(`
    INSERT INTO customers (customer_code, company_name, warehouse, coop_status, sort_order, owner_user_id) VALUES
      ('C001','客户A','龙湖仓,佳新仓','合作中',100,1),
      ('C002','客户B','龙湖仓',      '合作中',200,1),
      ('C003','客户C','佳新仓',      '合作中',300,1);
  `);
}

// ---------- 1) 表结构 & 主键 ----------
test('1. warehouse_sort_config 表存在 + PRIMARY KEY(warehouse, customer_id)', () => {
  const db = freshDb();
  const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='warehouse_sort_config'").get();
  assert.ok(r, '表必须存在');
  const cols = db.prepare("PRAGMA table_info(warehouse_sort_config)").all();
  const colNames = cols.map(c => c.name);
  assert.deepEqual(colNames, ['warehouse', 'customer_id', 'sort_order', 'updated_at']);
  // 验证 PRIMARY KEY：同 (warehouse, customer_id) 插两次应触发 UNIQUE constraint
  seedCustomers(db);
  db.prepare("INSERT INTO warehouse_sort_config (warehouse,customer_id,sort_order) VALUES ('龙湖仓',1,10)").run();
  const dup = db.prepare("INSERT INTO warehouse_sort_config (warehouse,customer_id,sort_order) VALUES ('龙湖仓',1,99)");
  assert.throws(() => dup.run(), /UNIQUE constraint/);
});

// ---------- 2) 不同仓库配置互不干扰 ----------
test('2. 同一 customer_id 在不同 warehouse 有独立 sort_order', () => {
  const db = freshDb();
  seedCustomers(db);
  db.exec(`
    INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
      ('龙湖仓', 1, 5),
      ('佳新仓', 1, 50);
  `);
  const lh = db.prepare("SELECT sort_order FROM warehouse_sort_config WHERE warehouse='龙湖仓' AND customer_id=1").get();
  const jx = db.prepare("SELECT sort_order FROM warehouse_sort_config WHERE warehouse='佳新仓' AND customer_id=1").get();
  assert.equal(lh.sort_order, 5);
  assert.equal(jx.sort_order, 50);
  assert.notEqual(lh.sort_order, jx.sort_order);
});

// ---------- 3) 列表排序：wsc 优先 ----------
test('3. 列表排序：wsc.sort_order 优先于 customers.sort_order', () => {
  const db = freshDb();
  seedCustomers(db);
  // 全局 sort_order：A=100, B=200
  // wsc 覆盖龙湖仓：B=1 → 先出，A=2
  db.exec(`
    INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
      ('龙湖仓', 2, 1),
      ('龙湖仓', 1, 2);
  `);
  const rows = db.prepare(`
    SELECT c.customer_id, COALESCE(wsc.sort_order, c.sort_order, 9999) AS so
    FROM customers c
    LEFT JOIN warehouse_sort_config wsc ON wsc.customer_id=c.customer_id AND wsc.warehouse='龙湖仓'
    WHERE c.warehouse LIKE '%龙湖仓%' AND c.is_deleted=0
    ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id DESC
  `).all();
  assert.deepEqual(rows.map(r => r.customer_id), [2, 1]);
});

// ---------- 4) 缺失 wsc 行回退 customers.sort_order ----------
test('4. 缺失 wsc 行时回退 customers.sort_order', () => {
  const db = freshDb();
  seedCustomers(db);
  db.exec("INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES ('佳新仓', 1, 1)");
  const rows = db.prepare(`
    SELECT c.customer_id, COALESCE(wsc.sort_order, c.sort_order, 9999) AS so
    FROM customers c
    LEFT JOIN warehouse_sort_config wsc ON wsc.customer_id=c.customer_id AND wsc.warehouse='佳新仓'
    WHERE c.warehouse LIKE '%佳新仓%' AND c.is_deleted=0
    ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id DESC
  `).all();
  // A(wsc=1) → C(fallback=300)
  assert.deepEqual(rows.map(r => r.customer_id), [1, 3]);
});

// ---------- 5) 切仓库独立排序互不干扰 ----------
test('5. 切仓库 TAB 独立排序 —— 同一客户在不同仓位置不同', () => {
  const db = freshDb();
  seedCustomers(db);
  db.exec(`
    INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
      ('龙湖仓', 1, 10), ('龙湖仓', 2, 20),
      ('佳新仓', 1, 100), ('佳新仓', 3, 1);
  `);
  const query = (wh) => db.prepare(`
    SELECT c.customer_id FROM customers c
    LEFT JOIN warehouse_sort_config wsc ON wsc.customer_id=c.customer_id AND wsc.warehouse=?
    WHERE c.warehouse LIKE '%' || ? || '%' AND c.is_deleted=0
    ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id DESC
  `).all(wh, wh).map(r => r.customer_id);
  const lh = query('龙湖仓');
  const jx = query('佳新仓');
  assert.deepEqual(lh, [1, 2]);
  assert.deepEqual(jx, [3, 1]);
  // 同一客户(customer_id=1) 在两个仓 TAB 位置不同
  assert.notEqual(lh.indexOf(1), jx.indexOf(1));
});

// ---------- 6) PUT upsert + 批量事务 ----------
test('6. ON CONFLICT UPSERT + 批量事务一致性', () => {
  const db = freshDb();
  seedCustomers(db);
  const upsert = db.prepare(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order, updated_at)
    VALUES (?,?,?,datetime('now','localtime'))
    ON CONFLICT(warehouse, customer_id) DO UPDATE SET sort_order=excluded.sort_order, updated_at=datetime('now','localtime')`);
  // 首次插入
  upsert.run('龙湖仓', 1, 10);
  assert.equal(db.prepare("SELECT sort_order FROM warehouse_sort_config WHERE warehouse='龙湖仓' AND customer_id=1").get().sort_order, 10);
  // 冲突更新
  upsert.run('龙湖仓', 1, 99);
  assert.equal(db.prepare("SELECT sort_order FROM warehouse_sort_config WHERE warehouse='龙湖仓' AND customer_id=1").get().sort_order, 99);
  // 批量事务
  db.exec('BEGIN');
  upsert.run('龙湖仓', 2, 5);
  upsert.run('佳新仓', 3, 7);
  db.exec('COMMIT');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM warehouse_sort_config").get().c, 3);
});

// ---------- 7) ON DELETE CASCADE ----------
test('7. 删除客户时 warehouse_sort_config 对应行级联删除', () => {
  const db = freshDb();
  seedCustomers(db);
  db.exec(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
    ('龙湖仓', 1, 10), ('佳新仓', 1, 50), ('龙湖仓', 2, 20)`);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM warehouse_sort_config").get().c, 3);
  db.exec("DELETE FROM customers WHERE customer_id=1");
  // 客户 A 属于两个仓，wsc 两行级联删除；客户 B 的行保留
  assert.equal(db.prepare("SELECT COUNT(*) c FROM warehouse_sort_config").get().c, 1);
  const remaining = db.prepare("SELECT warehouse,customer_id FROM warehouse_sort_config").all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].warehouse, '龙湖仓');
  assert.equal(remaining[0].customer_id, 2);
});
