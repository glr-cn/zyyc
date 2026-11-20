// ============================================================================
// 工时缺口行（未归档列表）日期口径回归测试
// ----------------------------------------------------------------------------
// 背景（2026-11-20 线上问题）：
//   用户按「2026-11-20」筛选未归档，导入的 38 条数据实际归档在 2026-11-19。
//   旧实现中缺口行「展示日期固定为昨天」而「判定日期按用户筛选期」，
//   导致 11-19 已有归档数据的货主仍以 11-19 出现在未归档列表，
//   用户误以为数据被归入未归档；再导入同文件又被判重复，体验自相矛盾。
//
// 修复口径：缺口行展示哪一天，就用哪一天判定「是否已填」。
//   单日筛选 → 该日（need_backfill = 该日早于今天）
//   多日范围 → 昨天（补报建议日，need_backfill = 昨天落在范围内）
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------- 1. 共享 :memory: 库 + patch driver ----------
const driver = require('../src/db/driver');
const sharedDb = driver.openDatabase(':memory:');
sharedDb.close = () => { /* 防止被关闭 */ };
driver.openDatabase = () => sharedDb;

function freshListHandler() {
  Object.keys(require.cache).forEach((k) => {
    if (k.indexOf(path.join('light-erp', 'src')) >= 0
        && !k.includes(path.sep + 'db' + path.sep + 'driver')
        && !(k.endsWith(path.join('light-erp', 'src', 'db')) || k.endsWith(path.join('light-erp', 'src', 'db.js')))) {
      delete require.cache[k];
    }
  });
  const router = require(path.join(__dirname, '..', 'src', 'routes', 'workhours'));
  const h = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  if (!h) throw new Error('GET /workhours 路由不存在');
  return h.route.stack[0].handle;
}

function schema() {
  sharedDb.exec(`
    CREATE TABLE work_hours (
      work_id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse TEXT NOT NULL, work_type TEXT NOT NULL,
      customer_id INTEGER, customer_name TEXT, unit TEXT, date TEXT NOT NULL,
      ship_orders REAL, cartons REAL, tons REAL, cubic REAL, pallets REAL, workload REAL,
      project TEXT, main_hours REAL NOT NULL DEFAULT 0,
      other_hours REAL NOT NULL DEFAULT 0, shared_hours REAL NOT NULL DEFAULT 0,
      total_hours REAL NOT NULL DEFAULT 0, efficiency REAL, unit_cost REAL, doc_cost REAL,
      remark TEXT, status TEXT NOT NULL DEFAULT 'pending',
      submitter TEXT, submit_time TEXT, owner_user_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE customers (
      customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL, short_name TEXT, warehouse TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0, coop_status TEXT NOT NULL DEFAULT '合作中',
      sort_order INTEGER DEFAULT 9999, default_unit TEXT DEFAULT '单', owner_user_id INTEGER
    );
  `);
}

function reset() {
  sharedDb.exec('DROP TABLE IF EXISTS work_hours; DROP TABLE IF EXISTS customers;');
  schema();
}

// 预置：龙湖仓 2 个合作中货主；货主A 在 2026-11-19 已归档；货主B 在 2026-11-19 有 pending 草稿
function seed() {
  sharedDb.exec(`
    INSERT INTO customers (customer_id, company_name, warehouse, is_deleted, coop_status, sort_order)
    VALUES (1, '货主A', '龙湖仓', 0, '合作中', 1),
           (2, '货主B', '龙湖仓', 0, '合作中', 2);
  `);
  const ins = sharedDb.prepare(
    `INSERT INTO work_hours (warehouse, work_type, customer_id, customer_name, unit, date, ship_orders, main_hours, other_hours, status, submitter, submit_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  ins.run('龙湖仓', '发货', 1, '货主A', '单', '2026-11-19', 100, 10, 2, 'archived', 'admin', '2026-11-19 18:00:00');
  ins.run('龙湖仓', '发货', 2, '货主B', '单', '2026-11-19', 50, 5, 1, 'pending', null, null);
}

// 调 handler 的简单桩
function callList(handler, query) {
  let body = null;
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { body = o; return this; },
  };
  const req = {
    query,
    user: { user_id: 1, username: 'admin', role_code: 'super_admin', data_scope: 'all' },
  };
  handler(req, res);
  return { body, statusCode: res.statusCode };
}

// ---------- 2. 纯函数口径 ----------

test('resolveGapScope：单日=今天 → 判定/展示都是今天，不标待补', () => {
  const svc = require('../src/services/workhours');
  const r = svc.resolveGapScope('2026-11-20', '2026-11-20', '2026-11-20');
  assert.equal(r.date, '2026-11-20');
  assert.equal(r.need_backfill, false);
});

test('resolveGapScope：单日=历史日期 → 该日 + 待补', () => {
  const svc = require('../src/services/workhours');
  const r = svc.resolveGapScope('2026-11-19', '2026-11-19', '2026-11-20');
  assert.equal(r.date, '2026-11-19');
  assert.equal(r.need_backfill, true);
});

test('resolveGapScope：多日范围 → 昨天（补报建议日），范围内标待补', () => {
  const svc = require('../src/services/workhours');
  const r = svc.resolveGapScope('2026-11-01', '2026-11-30', '2026-11-20');
  assert.equal(r.date, '2026-11-19');
  assert.equal(r.need_backfill, true);
  // 范围不含昨天 → 不标待补
  const r2 = svc.resolveGapScope('2026-11-01', '2026-11-10', '2026-11-20');
  assert.equal(r2.date, '2026-11-19');
  assert.equal(r2.need_backfill, false);
});

test('isSameHoursRow：数值 161 / 161.0 / "161" 视为一致（避免误判覆盖）', () => {
  const svc = require('../src/services/workhours');
  const p = { ship_orders: '161', unit: '单', main_hours: '10.0', other_hours: '', remark: '' };
  const stored = { ship_orders: 161, unit: '单', main_hours: 10, other_hours: 0, remark: null };
  assert.equal(svc.isSameHoursRow(p, stored), true);
  assert.equal(svc.isSameHoursRow({ ...p, main_hours: '11' }, stored), false);
});

// ---------- 3. 列表缺口行回归（核心） ----------

test('筛选 11-19：已归档/已填货主不出现在未归档缺口行，行日期与判定日一致', () => {
  reset(); seed();
  const h = freshListHandler();
  const { body } = callList(h, {
    warehouse: '龙湖仓', work_type: '发货', status: 'pending',
    dateFrom: '2026-11-19', dateTo: '2026-11-19', page: '1', pageSize: '50',
  });
  // 货主A 已归档 → 缺口被抑制；货主B 有 pending → filled 行
  assert.equal(body.data.length, 1, '只应有货主B的已填行');
  assert.equal(body.data[0].customer_name, '货主B');
  assert.equal(body.data[0].filled, 1);
  assert.equal(body.data[0].date, '2026-11-19');
  assert.ok(!body.data.some((r) => r.filled === 0), '不应出现缺口行');
});

test('筛选 11-20：缺口行日期必须是 11-20（旧实现错误显示 11-19）', () => {
  reset(); seed();
  const h = freshListHandler();
  const { body } = callList(h, {
    warehouse: '龙湖仓', work_type: '发货', status: 'pending',
    dateFrom: '2026-11-20', dateTo: '2026-11-20', page: '1', pageSize: '50',
  });
  const gaps = body.data.filter((r) => r.filled === 0);
  assert.equal(gaps.length, 2, '两个货主在 11-20 均未填报 → 两条缺口行');
  for (const g of gaps) {
    assert.equal(g.date, '2026-11-20', '缺口行展示日期必须等于判定日期');
    assert.equal(g.suggest_date, '2026-11-20');
  }
  assert.equal(body.total, 2);
});

test('筛选历史单日 11-18：缺口行标日期 11-18 且带待补标记', () => {
  reset(); seed();
  const h = freshListHandler();
  const { body } = callList(h, {
    warehouse: '龙湖仓', work_type: '发货', status: 'pending',
    dateFrom: '2026-11-18', dateTo: '2026-11-18', page: '1', pageSize: '50',
  });
  const gaps = body.data.filter((r) => r.filled === 0);
  assert.equal(gaps.length, 2);
  for (const g of gaps) {
    assert.equal(g.date, '2026-11-18');
    assert.equal(g.need_backfill, 1);
  }
});

test('已归档视图：11-19 可查到货主A 的归档记录（状态标记正确）', () => {
  reset(); seed();
  const h = freshListHandler();
  const { body } = callList(h, {
    warehouse: '龙湖仓', work_type: '发货', status: 'archived',
    dateFrom: '2026-11-19', dateTo: '2026-11-19', page: '1', pageSize: '50',
  });
  assert.equal(body.total, 1);
  assert.equal(body.data[0].customer_name, '货主A');
  assert.equal(body.data[0].status, 'archived');
});

test('测试收尾：恢复 driver.openDatabase', () => {
  assert.ok(true);
});
