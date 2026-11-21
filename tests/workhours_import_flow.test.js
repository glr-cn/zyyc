// ============================================================================
// 工时导入全链路测试（路由级，真实 xlsx）
// ----------------------------------------------------------------------------
// 覆盖 2026-11-20 用户反馈的两个问题的修复：
//   ① 「数据错误归类至未归档列表」：同维度已有 pending 草稿时，导入必须原地提交
//      该草稿（promote_pending），而不是再插一条 archived 造成同一数据同时出现在
//      未归档与已归档两个列表。
//   ② 「重复导入报错」：全部与归档一致时返回 200 + noop（幂等成功），不再 409 报错。
// 另覆盖：新增、覆盖、脏数据（同维度 archived+pending 并存）清理。
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const XLSX = require('xlsx');

const driver = require('../src/db/driver');
const sharedDb = driver.openDatabase(':memory:');
sharedDb.close = () => { /* 防止被关闭 */ };
driver.openDatabase = () => sharedDb;

function freshImportHandler() {
  Object.keys(require.cache).forEach((k) => {
    if (k.indexOf(path.join('light-erp', 'src')) >= 0
        && !k.includes(path.sep + 'db' + path.sep + 'driver')
        && !(k.endsWith(path.join('light-erp', 'src', 'db')) || k.endsWith(path.join('light-erp', 'src', 'db.js')))) {
      delete require.cache[k];
    }
  });
  const router = require(path.join(__dirname, '..', 'src', 'routes', 'workhours'));
  const h = router.stack.find((l) => l.route && l.route.path === '/import' && l.route.methods.post);
  if (!h) throw new Error('POST /import 路由不存在');
  // stack[0] 是 multer 中间件，真正的 handler 在最后
  return h.route.stack[h.route.stack.length - 1].handle;
}

function reset() {
  sharedDb.exec('DROP TABLE IF EXISTS work_hours; DROP TABLE IF EXISTS customers; DROP TABLE IF EXISTS audit_logs;');
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
    CREATE TABLE audit_logs (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id INTEGER UNIQUE, operator TEXT NOT NULL, operated_at TEXT NOT NULL,
      table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL,
      before_summary TEXT, after_summary TEXT, user_id INTEGER, user_name TEXT,
      module TEXT, target_id TEXT, content TEXT, ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  sharedDb.exec(`INSERT INTO customers (customer_id, company_name, warehouse) VALUES (1, '货主A', '龙湖仓')`);
}

function makeXlsx(rows) {
  const aoa = [['日期', '客户名称', '单位', '发货单量', '主工时', '其他工时', '备注'], ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '发货工时');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function runImport(buffer) {
  const handler = freshImportHandler();
  let body = null, code = 200;
  const res = {
    status(c) { code = c; return this; },
    json(o) { body = o; return this; },
  };
  const req = {
    query: { warehouse: '龙湖仓' },
    body: {},
    user: { user_id: 1, username: 'admin', role_code: 'super_admin' },
    file: { buffer, originalname: 'test.xlsx' },
  };
  handler(req, res);
  return { body, code };
}

const rowsOf = () => sharedDb.prepare('SELECT * FROM work_hours ORDER BY work_id').all();

test('新增：无同维度记录 → created=1，落 archived', () => {
  reset();
  const r = runImport(makeXlsx([['2026-11-20', '货主A', '单', 100, 10, 2, '']]));
  assert.equal(r.code, 200);
  assert.equal(r.body.created, 1);
  assert.deepEqual(r.body.dates, ['2026-11-20']);
  const rows = rowsOf();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'archived');
  assert.ok(rows[0].submit_time);
});

test('重复导入：全部一致 → 200 + noop（幂等，不报错、不新增）', () => {
  reset();
  const buf = makeXlsx([['2026-11-20', '货主A', '单', 100, 10, 2, '']]);
  const r1 = runImport(buf);
  assert.equal(r1.body.created, 1);

  const r2 = runImport(buf);
  assert.equal(r2.code, 200, '重复导入不应返回 4xx');
  assert.equal(r2.body.noop, true);
  assert.equal(r2.body.created, 0);
  assert.equal(r2.body.skip_exact, 1);
  assert.deepEqual(r2.body.dates, ['2026-11-20']);
  assert.equal(rowsOf().length, 1, '不得产生重复行');
});

test('未归档草稿：同维度已有 pending → 原地提交（promote），不新增行', () => {
  reset();
  sharedDb.exec(`INSERT INTO work_hours (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,status)
                 VALUES ('龙湖仓','发货',1,'货主A','单','2026-11-20',99,9,1,'pending')`);
  const r = runImport(makeXlsx([['2026-11-20', '货主A', '单', 100, 10, 2, '']]));
  assert.equal(r.code, 200);
  assert.equal(r.body.promoted, 1);
  assert.equal(r.body.created, 0);
  const rows = rowsOf();
  assert.equal(rows.length, 1, '同一维度只能有一行');
  assert.equal(rows[0].status, 'archived');
  assert.equal(rows[0].ship_orders, 100);
  assert.equal(rows[0].main_hours, 10);
  assert.ok(rows[0].submit_time);
  // 未归档视图不再残留草稿
  assert.equal(sharedDb.prepare("SELECT COUNT(*) c FROM work_hours WHERE status='pending'").get().c, 0);
});

test('覆盖：归档值有差异 → overwritten=1，行数不变', () => {
  reset();
  sharedDb.exec(`INSERT INTO work_hours (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,status,submitter,submit_time)
                 VALUES ('龙湖仓','发货',1,'货主A','单','2026-11-20',50,5,0,'archived','admin','2026-11-20 09:00:00')`);
  const r = runImport(makeXlsx([['2026-11-20', '货主A', '单', 100, 10, 2, '']]));
  assert.equal(r.body.overwritten, 1);
  const rows = rowsOf();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ship_orders, 100);
});

test('脏数据修复：同维度 archived + pending 并存 → 覆盖后仅剩 1 条 archived', () => {
  reset();
  sharedDb.exec(`
    INSERT INTO work_hours (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,status,submitter,submit_time)
      VALUES ('龙湖仓','发货',1,'货主A','单','2026-11-20',50,5,0,'archived','admin','2026-11-20 09:00:00');
    INSERT INTO work_hours (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,status)
      VALUES ('龙湖仓','发货',1,'货主A','单','2026-11-20',60,6,0,'pending');
  `);
  const r = runImport(makeXlsx([['2026-11-20', '货主A', '单', 100, 10, 2, '']]));
  assert.equal(r.body.overwritten, 1);
  assert.ok(r.body.repaired_duplicates >= 1, '应清理同维度草稿');
  const rows = rowsOf();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'archived');
  assert.equal(rows[0].ship_orders, 100);
});

test('发货单量整数化：导入小数按四舍五入入库（1260.6 → 1261）', () => {
  reset();
  const r = runImport(makeXlsx([['2026-11-20', '货主A', '单', 1260.6, 10, 0, '']]));
  assert.equal(r.code, 200);
  assert.equal(r.body.created, 1);
  const row = rowsOf()[0];
  assert.equal(row.ship_orders, 1261, '1260.6 必须四舍五入为 1261（禁止截断为 1260）');
  assert.ok(Number.isInteger(row.ship_orders), '入库值必须是整数');
});

test('发货单量整数化：0 / 负数 / 超上限 → 全部拦截并计入 errors，不写库', () => {
  reset();
  const r = runImport(makeXlsx([
    ['2026-11-20', '货主A', '单', 0, 0, 0, ''],          // 0 → 非法
    ['2026-11-20', '货主A', '单', -5, 0, 0, ''],         // 负数 → 非法
    ['2026-11-20', '货主A', '单', 1000001, 0, 0, ''],    // 超上限 → 非法
  ]));
  assert.equal(r.body.created, 0);
  assert.equal(rowsOf().length, 0, '非法行不得写入');
  assert.equal(r.body.errors.length, 3);
  assert.match(r.body.errors[0].error, /必须大于 0/);
  assert.match(r.body.errors[2].error, /不能超过/);
});

test('发货单量整数化：留空 + 仅备注 → 存 null（不存 0）', () => {
  reset();
  const r = runImport(makeXlsx([['2026-11-20', '货主A', '单', '', 0, 0, '无单量，仅备注']]));
  assert.equal(r.body.created, 1);
  const row = rowsOf()[0];
  assert.equal(row.ship_orders, null, '空单量必须为 null，不能落库为 0');
});

test('多行混合：新增 + 提交草稿 + 跳过 + 覆盖 在同一事务内完成', () => {
  reset();
  sharedDb.exec(`INSERT INTO customers (customer_id, company_name, warehouse) VALUES (2, '货主B', '龙湖仓'), (3, '货主C', '龙湖仓')`);
  sharedDb.exec(`
    INSERT INTO work_hours (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,status)
      VALUES ('龙湖仓','发货',2,'货主B','单','2026-11-20',70,7,0,'pending');
    INSERT INTO work_hours (warehouse,work_type,customer_id,customer_name,unit,date,ship_orders,main_hours,other_hours,status,submitter,submit_time)
      VALUES ('龙湖仓','发货',3,'货主C','单','2026-11-20',80,8,0,'archived','admin','2026-11-20 09:00:00');
  `);
  const r = runImport(makeXlsx([
    ['2026-11-20', '货主A', '单', 100, 10, 0, ''],  // 新增
    ['2026-11-20', '货主B', '单', 71, 7, 0, ''],    // 提交草稿
    ['2026-11-20', '货主C', '单', 81, 8, 0, ''],    // 覆盖
    ['2026-11-20', '货主C', '单', 81, 8, 0, ''],    // 同批次重复 → 见下方断言
  ]));
  assert.equal(r.code, 200);
  assert.equal(r.body.created, 1);
  assert.equal(r.body.promoted, 1);
  assert.equal(r.body.overwritten, 1);
  assert.equal(r.body.skipped_batch_dup, 1, '文件内同客户同日期重复行应只保留首条');
  // 每客户仍然只有一行
  for (const cid of [1, 2, 3]) {
    const n = sharedDb.prepare('SELECT COUNT(*) c FROM work_hours WHERE customer_id=?').get(cid).c;
    assert.equal(n, 1, `客户 ${cid} 应只有一行，实际 ${n}`);
  }
});
