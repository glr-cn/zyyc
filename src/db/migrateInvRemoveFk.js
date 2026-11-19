// ============================================================================
// migrateInvRemoveFk.js · 去掉 inventory_transactions 表的 FK 约束
// ----------------------------------------------------------------------------
// 根因链：
//   migrateCustomersRemoveUnique → RENAME customers → 所有从 customers 指来的 FK → customers_bak
//   migrateOrdersRemoveFk        → 清了 orders 自身 FK（OK）
//   migrateOrdersRemoveFk 内部 RENAME orders → inventory_transactions.order_id FK 自动 → orders_bak ❌
//                                                                   ↑ 这次修它！
// 决策：去掉 inventory_transactions.order_id → orders 的 FK。
// 原因同 warehouse_sort_config / orders：
//   ① 上游表会被迁移重建，每次 ALTER TABLE RENAME 同步改 FK 指向 _bak
//   ② 业务层 orders 表存在性已校验，FK 多余且会引发 INSERT 失败
// ============================================================================

const FINGERPRINT_NAME = 'inventory_remove_fk_20261119';

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

// inventory_transactions 实际 9 列（来自 schema.sql + PRAGMA 对齐）
const INV_SCHEMA = `
CREATE TABLE inventory_transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER,
  owner_name     TEXT NOT NULL,
  quantity       REAL NOT NULL,
  direction      TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  business_date  TEXT NOT NULL,
  remark         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[inv-fk]', ...args); };
  if (isApplied(db)) { log('已迁移过，跳过'); return { skipped: true }; }
  if (!tableExists(db, 'inventory_transactions')) { markApplied(db); return { skipped: true, reason: 'no_inv' }; }

  const fks = db.prepare("SELECT * FROM pragma_foreign_key_list('inventory_transactions')").all();
  if (!fks.length) { log('inv 已无 FK，直接标记'); markApplied(db); return { skipped: true, reason: 'no_fks' }; }
  log('迁移前 FK 数:', fks.length, fks.map(f => `${f.from}→${f.table}`).join(', '));

  const beforeCount = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c;
  log('迁移前行数:', beforeCount);

  db.exec('BEGIN');
  try {
    db.exec('PRAGMA foreign_keys = OFF');

    db.exec(INV_SCHEMA.replace('inventory_transactions', 'inventory_transactions_new'));
    db.exec("INSERT INTO inventory_transactions_new SELECT * FROM inventory_transactions");
    db.exec("ALTER TABLE inventory_transactions RENAME TO inventory_transactions_bak");
    db.exec("ALTER TABLE inventory_transactions_new RENAME TO inventory_transactions");

    const afterCount = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c;
    if (afterCount !== beforeCount) throw new Error(`行数不一致: ${beforeCount} → ${afterCount}`);
    const afterFks = db.prepare("SELECT * FROM pragma_foreign_key_list('inventory_transactions')").all();
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
    throw e;
  }
}

module.exports = { run, isApplied };
