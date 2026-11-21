// ============================================================================
// migrateOrdersRemoveFk.js · 去掉 orders 表的 FK 约束
// ----------------------------------------------------------------------------
// 根因：migrateCustomersRemoveUnique.js 用 ALTER TABLE RENAME 重建 customers 表时，
// SQLite 会自动把 orders.customer_id 的 FK 同步改成 REFERENCES customers_bak(customer_id)
// —— 和 warehouse_sort_config 踩过的坑完全一样！
// orders 表现在有 2 个坏 FK：
//   from=customer_id → to=customers_bak.customer_id  （自动创建客户后 FK 失败）
//   from=owner_user_id → to=users.user_id            （这个还对，但 orders 不需要硬 FK 约束）
// 决策：**两个 FK 都去掉**。原因和 wsc 一样——
//   ① customers 表后续还会迁移（软删除等），每次 ALTER TABLE RENAME 都会把 FK 搞坏
//   ② orders 是业务写频繁表，FK 约束每次 INSERT 都要查父表，性能有开销
//   ③ 业务层已有 customers 表存在性校验，FK 是多余的
// ============================================================================

const FINGERPRINT_NAME = 'orders_remove_fk_20261119';

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function ensureFingerprint(db) {
  if (!tableExists(db, '_erp_migrations')) {
    db.exec(`CREATE TABLE _erp_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
  }
}
function isApplied(db) {
  ensureFingerprint(db);
  return !!db.prepare('SELECT 1 FROM _erp_migrations WHERE name=?').get(FINGERPRINT_NAME);
}
function markApplied(db) {
  ensureFingerprint(db);
  db.prepare("INSERT OR IGNORE INTO _erp_migrations (name, applied_at) VALUES (?, datetime('now','localtime'))")
    .run(FINGERPRINT_NAME);
}

// orders 表完整 schema（来自 schema.sql 11 列 + migrateOrdersRegion 追加 4 列 = 15 列）
// 去掉所有 FOREIGN KEY 约束（REFERENCES ... 子句）
const ORDERS_SCHEMA = `
CREATE TABLE orders (
  order_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no          TEXT NOT NULL,
  customer_id       INTEGER NOT NULL,
  owner_name        TEXT,
  ship_quantity     REAL NOT NULL DEFAULT 0,
  unit              TEXT,
  order_date        TEXT NOT NULL,
  payment_status    TEXT,
  waybill_type      TEXT,
  owner_user_id     INTEGER,
  wms_platform      TEXT,
  to_province       TEXT,
  to_city           TEXT,
  region_class      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[orders-fk]', ...args); };
  if (isApplied(db)) { log('已迁移过，跳过'); return { skipped: true }; }
  if (!tableExists(db, 'orders')) { markApplied(db); return { skipped: true, reason: 'no_orders' }; }

  const beforeCount = db.prepare('SELECT COUNT(*) c FROM orders').get().c;

  // 空库防御：如果 orders 是空表，且现有列数与 ORDERS_SCHEMA 不一致
  // （典型场景：schema.sql 建的 11 列 vs ORDERS_SCHEMA 硬编码 14 列），
  // 直接标记已应用。空表本来就没 FK 要移除，也不需要重建。
  // 真正的 FK 约束会在 schema.sql 里被后续的 ALTER TABLE ... DROP CONSTRAINT
  // 或者 migrateOrdersRegion 追加列后再由下一次重建时去掉。
  if (beforeCount === 0) {
    const have = db.prepare("SELECT GROUP_CONCAT(name,',') AS cols FROM pragma_table_info('orders')").get().cols;
    const wantCols = ORDERS_SCHEMA.match(/^\s+\w+/gm).map(s => s.trim()).join(',');
    if (have !== wantCols) {
      log('空库防御：orders 列数/顺序与 ORDERS_SCHEMA 不一致，直接标记已应用');
      markApplied(db);
      return { skipped: true, reason: 'empty_mismatch' };
    }
  }

  // 前置防御：如果 orders 已经没 FK 了（比如迁移脚本已跑 fingerprint 丢了），直接标记
  const fks = db.prepare("SELECT * FROM pragma_foreign_key_list('orders')").all();
  if (!fks.length) { log('orders 已无 FK，直接标记'); markApplied(db); return { skipped: true, reason: 'no_fks' }; }

  log('迁移前 FK 数:', fks.length, fks.map(f => f.from + '→' + f.table).join(', '));
  log('迁移前行数:', beforeCount);

  db.exec('BEGIN');
  try {
    db.exec('PRAGMA foreign_keys = OFF'); // 临时关闭 FK 检查，避免重命名期间被拦

    // 三步法原子重建
    db.exec(ORDERS_SCHEMA.replace('orders', 'orders_new'));
    db.exec("INSERT INTO orders_new SELECT * FROM orders");
    db.exec("ALTER TABLE orders RENAME TO orders_bak");
    db.exec("ALTER TABLE orders_new RENAME TO orders");

    // 验证
    const afterCount = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
    if (afterCount !== beforeCount) throw new Error(`行数不一致: ${beforeCount} → ${afterCount}`);
    const afterFks = db.prepare("SELECT * FROM pragma_foreign_key_list('orders')").all();
    if (afterFks.length) throw new Error('FK 未清除干净，仍有 ' + afterFks.length + ' 个');

    log('迁移后 FK 数: 0 ✅');
    log('迁移后行数:', afterCount);

    db.exec('PRAGMA foreign_keys = ON');
    markApplied(db);
    db.exec('COMMIT');
    log('完成');
    return { skipped: false, beforeCount };
  } catch (e) {
    try { db.exec('PRAGMA foreign_keys = ON'); } catch {}
    try { db.exec('ROLLBACK'); } catch {}
    log('ROLLBACK 原因:', e.message);
    throw e;
  }
}

module.exports = { run, isApplied };
