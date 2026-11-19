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
// ============================================================================
// ★ 分仓独立排序：服务层真实调用（services/warehouseSort.js）
//   规则：位置式重排 —— 单个仓库内序号连续 1..n，跨仓完全隔离
// ============================================================================
const { setWarehouseSortPosition } = require('../src/services/warehouseSort');

// 读取某仓当前顺序（按实际排序号升序）
function orderOf(db, wh) {
  return db.prepare(`
    SELECT c.customer_id, COALESCE(wsc.sort_order, c.sort_order, 9999) AS so
      FROM customers c
      LEFT JOIN warehouse_sort_config wsc
             ON wsc.customer_id = c.customer_id AND wsc.warehouse = ?
     WHERE c.warehouse LIKE ? AND c.is_deleted = 0
     ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id ASC
  `).all(wh, '%' + wh + '%').map((r) => ({ id: r.customer_id, so: r.so }));
}

// ---------- 8) 改到已占用位置 → 原占用及之后依次顺延 1 位 ----------
test('8. 位置式重排：改到已占用位置 → 原占用及之后顺延', () => {
  const db = freshDb();
  seedCustomers(db);  // A(1), B(2) 在龙湖仓；C(3) 仅在佳新仓
  db.exec(`INSERT INTO customers (customer_code, company_name, warehouse, coop_status, sort_order, owner_user_id)
    VALUES ('C004','客户D','龙湖仓','合作中',400,1)`);
  db.exec(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
    ('龙湖仓', 1, 1), ('龙湖仓', 2, 2), ('龙湖仓', 4, 3)`);
  // 把 D(4) 放到第 1 位 → D,A,B
  const r = setWarehouseSortPosition(db, '龙湖仓', 4, 1);
  assert.equal(r.ok, true);
  assert.equal(r.position, 1);
  assert.deepEqual(orderOf(db, '龙湖仓'), [
    { id: 4, so: 1 }, { id: 1, so: 2 }, { id: 2, so: 3 },
  ]);
});

// ---------- 9) 跨仓隔离：一个仓重排不影响另一个仓 ----------
test('9. 跨仓隔离：龙湖仓重排不影响佳新仓', () => {
  const db = freshDb();
  seedCustomers(db);  // A 在龙湖仓+佳新仓；C 在佳新仓
  db.exec(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
    ('佳新仓', 1, 7), ('佳新仓', 3, 8)`);
  const before = db.prepare("SELECT customer_id, sort_order FROM warehouse_sort_config WHERE warehouse='佳新仓' ORDER BY sort_order").all();
  // 龙湖仓重排（把 B 放到第 1 位）
  const r = setWarehouseSortPosition(db, '龙湖仓', 2, 1);
  assert.equal(r.ok, true);
  const after = db.prepare("SELECT customer_id, sort_order FROM warehouse_sort_config WHERE warehouse='佳新仓' ORDER BY sort_order").all();
  assert.deepEqual(after, before, '佳新仓排序必须原样保持不变');
  // 龙湖仓顺序：B,A
  assert.deepEqual(orderOf(db, '龙湖仓').map(x => x.id), [2, 1]);
});

// ---------- 10) 空缺序号 → 自动填充，序号连续无中断 ----------
test('10. 空缺序号：重排后该仓序号连续 1..n，无空缺', () => {
  const db = freshDb();
  seedCustomers(db);
  db.exec(`INSERT INTO customers (customer_code, company_name, warehouse, coop_status, sort_order, owner_user_id)
    VALUES ('C004','客户D','龙湖仓','合作中',400,1)`);
  // 历史数据有空洞：1, 5, 9
  db.exec(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
    ('龙湖仓', 1, 1), ('龙湖仓', 2, 5), ('龙湖仓', 4, 9)`);
  // 把 B 放到第 2 位（空缺语义 → 应落位 2，且整体连续）
  const r = setWarehouseSortPosition(db, '龙湖仓', 2, 2);
  assert.equal(r.ok, true);
  const ord = orderOf(db, '龙湖仓');
  assert.deepEqual(ord.map(x => x.id), [1, 2, 4]);
  assert.deepEqual(ord.map(x => x.so), [1, 2, 3], '序号必须连续无空缺');
});

// ---------- 11) 序号超出范围 → 自动落到末尾 ----------
test('11. 序号超出合理范围：自动落到末尾并保持连续', () => {
  const db = freshDb();
  seedCustomers(db);
  db.exec(`INSERT INTO customers (customer_code, company_name, warehouse, coop_status, sort_order, owner_user_id)
    VALUES ('C004','客户D','龙湖仓','合作中',400,1)`);
  db.exec(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
    ('龙湖仓', 1, 1), ('龙湖仓', 2, 2), ('龙湖仓', 4, 3)`);
  // A 设为 99（远大于 3）
  const r = setWarehouseSortPosition(db, '龙湖仓', 1, 99);
  assert.equal(r.ok, true);
  assert.equal(r.position, 3, '超出范围应夹到末位');
  const ord = orderOf(db, '龙湖仓');
  assert.deepEqual(ord.map(x => x.id), [2, 4, 1]);
  assert.deepEqual(ord.map(x => x.so), [1, 2, 3]);
});

// ---------- 12) 客户不属于该仓 → 拒绝且不改数据 ----------
test('12. 客户不属于该仓 → 拒绝，不产生任何排序变更', () => {
  const db = freshDb();
  seedCustomers(db);  // C(3) 只在佳新仓
  const before = db.prepare('SELECT COUNT(*) c FROM warehouse_sort_config').get().c;
  const r = setWarehouseSortPosition(db, '龙湖仓', 3, 1);
  assert.equal(r.ok, false);
  assert.match(r.error, /不属于/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM warehouse_sort_config').get().c, before);
});

// ---------- 13) 非法输入 → 拒绝（非整数 / 0 / 负数） ----------
test('13. 非法排序号：0、负数、非整数一律拒绝', () => {
  const db = freshDb();
  seedCustomers(db);
  for (const bad of [0, -1, 1.5, 'abc', '', null]) {
    const r = setWarehouseSortPosition(db, '龙湖仓', 1, bad);
    assert.equal(r.ok, false, `非法值 ${String(bad)} 应被拒绝`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM warehouse_sort_config').get().c, 0, '非法输入不得写入任何排序行');
});

// ---------- 14) 工时下拉 options 排序：wsc 优先于全局 sort_order ----------
test('14. 工时 options 按 COALESCE(wsc.sort_order, c.sort_order, 9999) 排序', () => {
  const db = freshDb();
  seedCustomers(db);
  // 全局：A=100, B=200；龙湖仓覆盖：B=1, A=2 → B 先出
  db.exec(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order) VALUES
    ('龙湖仓', 2, 1), ('龙湖仓', 1, 2)`);
  const rows = db.prepare(`
    SELECT c.customer_id
      FROM customers c
      LEFT JOIN warehouse_sort_config wsc
             ON wsc.customer_id = c.customer_id AND wsc.warehouse='龙湖仓'
     WHERE c.is_deleted = 0
     ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id DESC
  `).all();
  assert.deepEqual(rows.map(r => r.customer_id), [2, 1, 3]);
});
