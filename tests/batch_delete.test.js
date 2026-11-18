// ============================================================================
// 批量删除修复验证：patch driver.openDatabase → 让所有 db 操作指向同一个共享 :memory: 库
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// 1. 预先打开一个 :memory: 库 —— openDatabase(':memory:') 每次都是独立内存空间
//    但我们需要 handler 内部所有 db.prepare() 都用同一个库
//    做法：patch driver.js 的 openDatabase，让它无论传什么都返回我们的内存 db
const driver = require('../src/db/driver');
const sharedDb = driver.openDatabase(':memory:');
// 保护：防止任何地方 .close() 掉我们的共享连接
const realClose = sharedDb.close.bind(sharedDb);
sharedDb.close = () => { console.log('[TEST] sharedDb.close() BLOCKED'); };
const origOpen = driver.openDatabase;
driver.openDatabase = () => sharedDb;

// 2. 清 src/routes/workhours + 它下游引用 db 的模块，**但保留 driver + src/db 的 cache 不动**（patch 不丢）
function freshRouter() {
  Object.keys(require.cache).forEach((k) => {
    // 清 workhours 及其下游（auditLog、services/...），但保留 driver 和 db 模块
    if (k.indexOf(path.join('light-erp', 'src')) >= 0
        && !k.includes(path.sep + 'db' + path.sep + 'driver')
        && !(k.endsWith(path.join('light-erp', 'src', 'db')) || k.endsWith(path.join('light-erp', 'src', 'db.js')))) {
      delete require.cache[k];
    }
  });
  const router = require(path.join(__dirname, '..', 'src', 'routes', 'workhours'));
  const h = router.stack.find((l) => l.route && l.route.path === '/batch' && l.route.methods.delete);
  if (!h) throw new Error('DELETE /batch 路由不存在');
  return h.route.stack[0].handle;
}

// 3. 建表（用 sharedDb）— 完整 schema（handler 的 SQL 依赖 warehouse/date 等字段）
function fullSchema() {
  sharedDb.exec(`
    CREATE TABLE work_hours (
      work_id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse TEXT NOT NULL, work_type TEXT NOT NULL,
      customer_id INTEGER, customer_name TEXT, date TEXT NOT NULL,
      ship_orders REAL, main_hours REAL NOT NULL DEFAULT 0,
      other_hours REAL NOT NULL DEFAULT 0, shared_hours REAL NOT NULL DEFAULT 0,
      total_hours REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      owner_user_id INTEGER, created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE audit_logs (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id INTEGER UNIQUE, operator TEXT NOT NULL, operated_at TEXT NOT NULL,
      table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL,
      before_summary TEXT, after_summary TEXT, user_id INTEGER, user_name TEXT,
      module TEXT, target_id TEXT, content TEXT, ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
}

function reset() {
  sharedDb.exec('DROP TABLE IF EXISTS work_hours; DROP TABLE IF EXISTS audit_logs;');
  fullSchema();
}

function run(handler, user, body) {
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
  handler(
    { user, body, params: {}, headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } },
    res, () => {}
  );
  return res;
}

// ---------- 测试 ----------

test('修复验证：超管批量删 2 条 → 真删 work_hours + audit_logs 写 2 条 delete', () => {
  reset();

  const ins = sharedDb.prepare(
    `INSERT INTO work_hours (warehouse,work_type,customer_id,customer_name,date,ship_orders,main_hours,status,owner_user_id)
     VALUES ('龙湖仓','发货',?,?,?,?,?,?,?)`
  );
  ins.run(101, '货主A', '2026-11-18', 200, 18, 'pending', 1);
  ins.run(102, '货主B', '2026-11-18', 150, 12, 'pending', 1);
  ins.run(103, '货主C', '2026-11-18', 100, 10, 'archived', 1);

  const handler = freshRouter();
  const res = run(handler,
    { user_id: 1, username: 'admin', role_code: 'super_admin' },
    { ids: [1, 2], warehouse: '龙湖仓' }
  );

  assert.equal(res.statusCode, 200, `应返回 200，实际 ${res.statusCode}：${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.deleted, 2);

  const remaining = sharedDb.prepare('SELECT work_id FROM work_hours ORDER BY work_id').all().map((r) => r.work_id);
  assert.deepEqual(remaining, [3]);

  const audits = sharedDb.prepare(
    `SELECT record_id, action, table_name, user_name, module FROM audit_logs WHERE table_name='work_hours' ORDER BY log_id`
  ).all();
  assert.equal(audits.length, 2, 'audit_logs 应写 2 条（修复前这里必抛 no such table: audit_log）');
  audits.forEach((a) => {
    assert.equal(a.action, 'delete');
    assert.equal(a.table_name, 'work_hours');
    assert.equal(a.module, '工时管理');
    assert.equal(a.user_name, 'admin');
  });
  assert.deepEqual(audits.map((a) => Number(a.record_id)).sort(), [1, 2]);
});

test('非超管 → 403', () => {
  reset();
  const handler = freshRouter();
  const res = run(handler, { user_id: 2, username: 'joe', role_code: 'admin' }, { ids: [1] });
  assert.equal(res.statusCode, 403);
});

test('ids 空/非法 → 400', () => {
  reset();
  const handler = freshRouter();
  assert.equal(run(handler, { user_id: 1, role_code: 'super_admin' }, { ids: [] }).statusCode, 400);
  assert.equal(run(handler, { user_id: 1, role_code: 'super_admin' }, { ids: [-1, 0, 'abc', null] }).statusCode, 400);
});

test('跨仓保护：龙湖仓请求不能删佳新仓', () => {
  reset();
  sharedDb.exec(`INSERT INTO work_hours (warehouse,work_type,date,main_hours,status) VALUES
    ('龙湖仓','发货','2026-11-18',18,'pending'),
    ('佳新仓','发货','2026-11-18',12,'pending');`);
  const handler = freshRouter();
  const res = run(handler,
    { user_id: 1, username: 'admin', role_code: 'super_admin' },
    { ids: [1, 2], warehouse: '龙湖仓' }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 1);
  assert.equal(res.body.notFound, 1);
  const remaining = sharedDb.prepare('SELECT warehouse FROM work_hours').all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].warehouse, '佳新仓');
});

test('幂等 + 去重：ids=[1,1,999] → deleted=1, notFound=1', () => {
  reset();
  sharedDb.exec(`INSERT INTO work_hours (warehouse,work_type,date,main_hours) VALUES ('龙湖仓','发货','2026-11-18',18);`);
  const handler = freshRouter();
  const res = run(handler,
    { user_id: 1, username: 'admin', role_code: 'super_admin' },
    { ids: [1, 1, 999], warehouse: '龙湖仓' }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 1);
  assert.equal(res.body.notFound, 1);
});

test('全不存在 → 404 且无审计', () => {
  reset();
  const handler = freshRouter();
  const res = run(handler,
    { user_id: 1, username: 'admin', role_code: 'super_admin' },
    { ids: [999, 998], warehouse: '龙湖仓' }
  );
  assert.equal(res.statusCode, 404);
  const audits = sharedDb.prepare('SELECT COUNT(*) AS c FROM audit_logs').get();
  assert.equal(audits.c, 0);
});

// 恢复 driver（好公民）
test.after(() => {
  driver.openDatabase = origOpen;
});
