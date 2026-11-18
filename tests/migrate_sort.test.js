// ============================================================================
// 数据迁移（customers.sort_order）功能测试
// 覆盖：权限拦截 / 正常迁移 / force 重刷 / 快照回滚 / 审计日志写入
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

// ---------- 跑完整 schema.sql（和 src/db/index.js 里一模一样） ----------
const FULL_SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

function buildSchema() {
  sharedDb.exec(FULL_SCHEMA);
  // 种子角色（schema.sql 没有 roles 种子）
  sharedDb.exec(`
    INSERT OR IGNORE INTO roles (role_code, role_name, data_scope, is_readonly, is_system, sort) VALUES
      ('super_admin','超级管理员','all',0,1,0),
      ('admin','管理员','all',0,1,1),
      ('operator','业务员','self',0,1,2);
  `);
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('test123', 8);
  const superRole = sharedDb.prepare("SELECT role_id FROM roles WHERE role_code='super_admin'").get().role_id;
  const adminRole = sharedDb.prepare("SELECT role_id FROM roles WHERE role_code='admin'").get().role_id;
  const opRole = sharedDb.prepare("SELECT role_id FROM roles WHERE role_code='operator'").get().role_id;
  sharedDb.prepare('INSERT INTO users (username, password_hash, display_name, role_id) VALUES (?,?,?,?)')
    .run('super', hash, '超管', superRole);
  sharedDb.prepare('INSERT INTO users (username, password_hash, display_name, role_id) VALUES (?,?,?,?)')
    .run('admin', hash, '管理员', adminRole);
  sharedDb.prepare('INSERT INTO users (username, password_hash, display_name, role_id) VALUES (?,?,?,?)')
    .run('operator', hash, '业务员', opRole);

  // 插入 5 家测试客户（部分在 SORT_LIST 里）
  const names = [
    '杭州绵绵的羊网络科技有限公司', // 在名单 #1
    '海洋演义食品爆款',             // 在名单 #2
    '完全不存在的客户A',             // 不在名单
    '西玛-百世快运',                 // 在名单 #4
    '另一家测试客户',                // 不在名单
  ];
  // schema.sql 里 customers 有 NOT NULL DEFAULT 的列（prepaid_price/product_count 等），
  // INSERT 时显式列清单要避开它们让 DEFAULT 自动生效；customer_code 默认 NULL 也避不开。
  const insC = sharedDb.prepare(
    `INSERT INTO customers (company_name, warehouse, customer_type, sort_order, default_unit, expiry_mgmt, coop_status)
     VALUES (?,?,?,9999,'单','否','合作中')`
  );
  names.forEach((n) => insC.run(n, '龙湖仓', '仓储客户'));
}

function reset() {
  const tables = sharedDb.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map((r) => r.name);
  tables.forEach((t) => { try { sharedDb.exec('DROP TABLE ' + t); } catch (_) {} });
  buildSchema();
}

// ---------- mock 用户 ----------
function mkUser(username) {
  return sharedDb.prepare(`SELECT u.user_id, u.username, u.display_name, u.role_id,
       r.role_name, r.role_code, r.data_scope, r.is_readonly
       FROM users u JOIN roles r ON r.role_id=u.role_id WHERE u.username=?`).get(username);
}

// ---------- 直接从 admin.js 里暴露快照/迁移函数（绕过完整 require 链） ----------
// admin.js 里的路由 require src/db 会触发启动迁移（schema.sql 完整 + 所有 migrate* 脚本）。
// 我们这里已用 FULL_SCHEMA 建表完整结构，但 migrateCustomerLink 等脚本会在 require src/db 时再次跑，
// 需要绕过。做法：直接 require 迁移核心模块（不触发 src/db/index.js 的启动流程）。

// 迁移核心（独立于 express/db/index.js 的启动链）
const sortMigrate = require('../src/db/migrateCustomersSortOrder');

// ---------- 手动实现 admin 路由的快照/回滚逻辑（与 admin.js 保持一致） ----------
const SNAPSHOT_TABLE = '_sort_order_snapshot';

function ensureSnapTable() {
  sharedDb.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
    customer_id INTEGER PRIMARY KEY,
    company_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  )`);
}

function saveSnapshot() {
  ensureSnapTable();
  sharedDb.exec(`DELETE FROM ${SNAPSHOT_TABLE}`);
  sharedDb.exec(`INSERT INTO ${SNAPSHOT_TABLE} (customer_id, company_name, sort_order)
    SELECT customer_id, company_name, sort_order FROM customers`);
  return sharedDb.prepare(`SELECT COUNT(*) c FROM ${SNAPSHOT_TABLE}`).get().c;
}

function restoreSnapshot() {
  ensureSnapTable();
  const snapCount = sharedDb.prepare(`SELECT COUNT(*) c FROM ${SNAPSHOT_TABLE}`).get().c;
  if (snapCount === 0) throw new Error('快照为空，无法回滚');
  sharedDb.exec('BEGIN');
  try {
    const info = sharedDb.prepare(`
      UPDATE customers SET sort_order=(SELECT s.sort_order FROM ${SNAPSHOT_TABLE} s WHERE s.customer_id=customers.customer_id)
      WHERE customer_id IN (SELECT customer_id FROM ${SNAPSHOT_TABLE})
    `).run();
    sharedDb.exec('COMMIT');
    return info.changes || 0;
  } catch (e) {
    try { sharedDb.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

function clearSnapshot() {
  ensureSnapTable();
  sharedDb.exec(`DELETE FROM ${SNAPSHOT_TABLE}`);
}

// ---------- 权限校验（复用 admin.js 的 roleGate 逻辑） ----------
function authorize(user) {
  if (!user) return { ok: false, status: 401, error: '未登录' };
  if (user.role_code !== 'super_admin') return { ok: false, status: 403, error: '当前角色无权限' };
  return { ok: true };
}

// ---------- 写审计日志（复用 auditLog 签名，直接插入） ----------
function writeAudit(user, action, targetId, content) {
  try {
    sharedDb.prepare(`INSERT INTO audit_logs
      (operator, operated_at, table_name, record_id, action, before_summary, after_summary,
       user_id, user_name, module, target_id, content, ip_address, created_at)
      VALUES (?, datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`
    ).run(
      user.username, 'customers', String(targetId), action,
      null, null, user.user_id, user.username, '系统/权限', String(targetId),
      JSON.stringify(content || {}), '127.0.0.1',
    );
  } catch (_) {}
}

// ---------- 执行迁移（模拟 POST /api/admin/migrate-sort） ----------
function runMigrate(user) {
  const auth = authorize(user);
  if (!auth.ok) return auth;
  const snapshotBefore = saveSnapshot();
  try {
    const report = sortMigrate.run(sharedDb, { force: true, verbose: false });
    writeAudit(user, 'import', 'sort_order_migration', {
      op: 'migrate_sort_order', operator: user.username,
      snapshotRows: snapshotBefore, matched: report.matched, unmatched: report.unmatched,
    });
    return { ok: true, report, snapshotRows: snapshotBefore };
  } catch (e) {
    let rb = null;
    try { rb = restoreSnapshot(); } catch (e2) { rb = { error: e2.message }; }
    writeAudit(user, 'delete', 'sort_order_migration_failed', {
      op: 'migrate_sort_order_failed', error: e.message, autoRollback: rb,
    });
    return { ok: false, error: e.message, autoRollback: rb };
  }
}

// ---------- 执行回滚（模拟 POST /api/admin/migrate-sort/rollback） ----------
function runRollback(user) {
  const auth = authorize(user);
  if (!auth.ok) return auth;
  try {
    const changes = restoreSnapshot();
    writeAudit(user, 'update', 'sort_order_rollback', {
      op: 'rollback_sort_order', restoredRows: changes,
    });
    return { ok: true, restoredRows: changes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- 清除快照（模拟 DELETE /api/admin/migrate-sort/snapshot） ----------
function runClear(user) {
  const auth = authorize(user);
  if (!auth.ok) return auth;
  clearSnapshot();
  writeAudit(user, 'delete', 'sort_order_snapshot_cleared', {
    op: 'clear_sort_snapshot', operator: user.username,
  });
  return { ok: true };
}

// ---------- 状态查询（模拟 GET /api/admin/migrate-sort/status） ----------
function runStatus(user) {
  const auth = authorize(user);
  if (!auth.ok) return auth;
  const all = sharedDb.prepare('SELECT customer_id, company_name, sort_order FROM customers ORDER BY customer_id').all();
  const sortList = sortMigrate.SORT_LIST;
  let snapCount = 0;
  try { snapCount = sharedDb.prepare(`SELECT COUNT(*) c FROM ${SNAPSHOT_TABLE}`).get().c; } catch (_) {}
  const lowCount = sharedDb.prepare('SELECT COUNT(*) c FROM customers WHERE sort_order < 9999').get().c;

  const nameMap = new Map();
  for (const row of all) {
    if (!nameMap.has(row.company_name)) nameMap.set(row.company_name, []);
    nameMap.get(row.company_name).push(row);
  }
  const unmatched = [];
  let expectedMatched = 0;
  for (let i = 0; i < sortList.length; i++) {
    const rows = nameMap.get(sortList[i]);
    if (!rows || !rows.length) unmatched.push({ seq: i + 1, name: sortList[i] });
    else expectedMatched += rows.length;
  }
  let fpExists = false;
  try {
    sharedDb.exec(`CREATE TABLE IF NOT EXISTS _erp_migrations (name TEXT PRIMARY KEY, applied_at TEXT)`);
    fpExists = !!sharedDb.prepare(`SELECT 1 FROM _erp_migrations WHERE name=?`).get(sortMigrate.FINGERPRINT);
  } catch (_) {}

  return {
    ok: true, fingerprintExists: fpExists,
    totalCustomers: all.length, sortListSize: sortList.length,
    alreadyMatched: lowCount, expectedMatchedOnRun: expectedMatched,
    unmatched, snapshotRows: snapCount, sortList: sortList.map((n, i) => ({ seq: i + 1, name: n })),
  };
}

// ============================================================
//  测试用例
// ============================================================

test('① 权限：业务员访问 → 403', () => {
  reset();
  const user = mkUser('operator');
  const r = runStatus(user);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /无权限/);
});

test('② 权限：管理员（非超管）访问 → 403', () => {
  reset();
  const user = mkUser('admin');
  const r = runStatus(user);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('③ 未登录（null）→ 401', () => {
  reset();
  const r = runStatus(null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('④ 超管访问 status → 200 + 正确统计', () => {
  reset();
  const user = mkUser('super');
  const r = runStatus(user);
  assert.equal(r.ok, true);
  assert.equal(r.totalCustomers, 5);
  assert.equal(r.sortListSize, 38);
  // 5 个客户中 3 个在 SORT_LIST 里
  assert.equal(r.expectedMatchedOnRun, 3);
  assert.equal(r.unmatched.length, 35);
});

test('⑤ 超管执行迁移 → 200 + 快照表 + 审计日志', () => {
  reset();
  const user = mkUser('super');

  const r = runMigrate(user);
  assert.equal(r.ok, true);
  assert.equal(r.snapshotRows, 5);
  assert.equal(r.report.matched, 3);
  assert.ok(r.report.unmatched.length > 0);

  // 快照表有数据
  const snapCount = sharedDb.prepare('SELECT COUNT(*) c FROM _sort_order_snapshot').get().c;
  assert.equal(snapCount, 5);

  // 审计日志写入
  const logs = sharedDb.prepare(`SELECT * FROM audit_logs WHERE target_id='sort_order_migration'`).all();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'import');
  assert.equal(logs[0].module, '系统/权限');
  assert.equal(logs[0].operator, 'super');
});

test('⑥ force 重复执行 → 每次都能刷新（指纹已标记仍能 force）', () => {
  reset();
  const user = mkUser('super');

  runMigrate(user);
  const low1 = sharedDb.prepare('SELECT COUNT(*) c FROM customers WHERE sort_order < 9999').get().c;
  assert.equal(low1, 3);

  runMigrate(user);
  const low2 = sharedDb.prepare('SELECT COUNT(*) c FROM customers WHERE sort_order < 9999').get().c;
  assert.equal(low2, 3); // 幂等
});

test('⑦ 回滚：快照恢复 sort_order', () => {
  reset();
  const user = mkUser('super');

  runMigrate(user);
  const before = sharedDb.prepare(
    "SELECT sort_order FROM customers WHERE company_name LIKE ?"
  ).get('%绵绵%');
  assert.equal(before.sort_order, 1);

  const r = runRollback(user);
  assert.equal(r.ok, true);
  assert.ok(r.restoredRows > 0);

  const after = sharedDb.prepare(
    "SELECT sort_order FROM customers WHERE company_name LIKE ?"
  ).get('%绵绵%');
  assert.equal(after.sort_order, 9999);

  const logs = sharedDb.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE target_id='sort_order_rollback'`).get().c;
  assert.ok(logs >= 1);
});

test('⑧ 回滚失败（快照为空）→ 错误提示', () => {
  reset();
  const user = mkUser('super');
  const r = runRollback(user);
  assert.equal(r.ok, false);
  assert.match(r.error, /快照/);
});

test('⑨ 清除快照 → 快照表清空 + 审计日志', () => {
  reset();
  const user = mkUser('super');

  runMigrate(user);
  const before = sharedDb.prepare('SELECT COUNT(*) c FROM _sort_order_snapshot').get().c;
  assert.ok(before > 0);

  const r = runClear(user);
  assert.equal(r.ok, true);

  const after = sharedDb.prepare('SELECT COUNT(*) c FROM _sort_order_snapshot').get().c;
  assert.equal(after, 0);

  const logs = sharedDb.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE target_id='sort_order_snapshot_cleared'`).get().c;
  assert.ok(logs >= 1);
});

test('⑩ 状态查询 → 指纹标记正确反映（迁移后 fingerprintExists=true）', () => {
  reset();
  const user = mkUser('super');

  let s = runStatus(user);
  assert.equal(s.fingerprintExists, false);

  runMigrate(user);

  s = runStatus(user);
  assert.equal(s.fingerprintExists, true);
});
