// ============================================================================
// customers 表迁移：去掉 company_name / customer_code 的 UNIQUE 约束
// ----------------------------------------------------------------------------
// 背景：项目早期设计 company_name UNIQUE 作为 Excel 导入 Upsert 键，
//       customer_code 也有列级 UNIQUE。后来引入 is_deleted 软删除后，
//       validate 后端加了 is_deleted=0 过滤，但 SQLite 的列级 UNIQUE 约束
//       不看 is_deleted —— 只要表中有任何一行（包括软删除的）值重复就拒，
//       软删除客户的 company_name / customer_code 无法被重新使用。
// 解法：SQLite 不支持 DROP CONSTRAINT，走重建表三步法：
//       ① 建新表 customers_new（同 schema 但两列去掉 UNIQUE）
//       ② 全量拷贝（customer_id 原样保留，orders/work_hours 外键不破坏）
//       ③ 原子 RENAME：customers → customers_bak → customers_new → customers
// 幂等：首次执行后 fingerprint 表记录，后续启动直接跳过。
// ============================================================================

const FINGERPRINT_NAME = 'customers_remove_unique_20261119';

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function ensureFingerprintTable(db) {
  if (!tableExists(db, '_erp_migrations')) {
    db.exec(`CREATE TABLE _erp_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
  }
}

function isApplied(db) {
  ensureFingerprintTable(db);
  return !!db.prepare('SELECT 1 FROM _erp_migrations WHERE name=?').get(FINGERPRINT_NAME);
}

function markApplied(db) {
  ensureFingerprintTable(db);
  db.prepare("INSERT OR IGNORE INTO _erp_migrations (name, applied_at) VALUES (?, datetime('now','localtime'))")
    .run(FINGERPRINT_NAME);
}

// 构建 customers_new：与 src/db/schema.sql 的 customers 表列顺序/类型/默认值完全一致，
// 仅去掉 customer_code 和 company_name 的列级 UNIQUE 约束。
// ※ 列顺序必须与 schema.sql 逐列对齐，否则 INSERT INTO … SELECT * 会错位填值！
const NEW_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS customers_new (
  customer_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_code      TEXT,                                          -- 去掉 UNIQUE
  company_name       TEXT NOT NULL,                                  -- 去掉 UNIQUE
  short_name         TEXT,
  warehouse          TEXT NOT NULL DEFAULT '',
  contact_person     TEXT,
  phone              TEXT,
  address            TEXT,
  erp_version        TEXT,
  product_type       TEXT,
  ecommerce_platform TEXT,
  product_count      INTEGER NOT NULL DEFAULT 0,
  payment_account    TEXT,
  prepaid_price      REAL NOT NULL DEFAULT 0,
  cutoff_time        TEXT,
  logistics_control  TEXT,
  expiry_mgmt        TEXT NOT NULL DEFAULT '否',
  coop_status        TEXT NOT NULL DEFAULT '合作中',
  remark             TEXT,
  customer_type      TEXT NOT NULL DEFAULT '仓储客户',
  sort_order         INTEGER NOT NULL DEFAULT 9999,
  default_unit       TEXT NOT NULL DEFAULT '单',
  owner_user_id      INTEGER REFERENCES users(user_id),
  is_deleted         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[customers-unique-migrate]', ...args); };

  if (!tableExists(db, 'customers')) {
    throw new Error('customers 表不存在，请先执行 schema.sql 初始化数据库');
  }

  // ★ 2026-11-20 紧急修复：_bak 表残留自动恢复
  // 场景：某次迁移执行了 RENAME → customers_bak 有数据，但后续 markApplied 之前进程崩溃，
  // 或 customers_new 数据拷贝失败就执行了 RENAME，导致 customers（来自 customers_new）是空的。
  // 下次启动时 fingerprint 已标记迁移"完成"，但 customers 实际是空的！
  // 解决：只要发现 customers 全空但 customers_bak 有数据，立刻从 bak 恢复。
  if (tableExists(db, 'customers_bak')) {
    const curCount = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
    const bakCount = db.prepare('SELECT COUNT(*) c FROM customers_bak').get().c;
    if (curCount === 0 && bakCount > 0) {
      console.warn(`[customers-unique-migrate] ⚠️ 检测到 customers 空但 customers_bak 有 ${bakCount} 行！自动恢复…`);
      const columns = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
      const colList = columns.join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT INTO customers (${colList}) VALUES (${placeholders})`);
      const bakData = db.prepare(`SELECT ${colList} FROM customers_bak`).all();
      // ★ 修复 S11：db 是 src/db/index.js:228 的包装对象，只有 exec/prepare/runMigrations，
      //   没有 .transaction 方法，原写法在崩溃恢复场景必抛 "db.transaction is not a function"。
      //   改用通用 BEGIN/COMMIT 手动事务（better-sqlite3 与 node-sqlite3-wasm 均支持），
      //   失败时 ROLLBACK，保证恢复要么全成要么不留半套数据。
      db.exec('BEGIN');
      try {
        for (const r of bakData) stmt.run(...columns.map(c => r[c]));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      const after = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
      console.warn(`[customers-unique-migrate] ✅ 从 customers_bak 恢复 ${bakData.length} → customers 现在 ${after} 行`);
    }
  }

  if (isApplied(db)) {
    log('已迁移过，跳过');
    return { skipped: true, reason: 'fingerprint' };
  }

  // 前置防御：如果表已不含 UNIQUE（说明上次迁移三步法成功但 markApplied 失败），
  // 直接标记已应用并跳过，避免 customers_bak 重名冲突
  const currentSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'").get().sql;
  if (!/company_name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(currentSQL) &&
      !/customer_code\s+TEXT\s+UNIQUE/i.test(currentSQL)) {
    log('customers 表已不含 UNIQUE 约束（上次迁移三步法成功但 fingerprint 未写入），直接标记已应用');
    markApplied(db);
    return { skipped: true, reason: 'already_migrated_no_fingerprint' };
  }

  // 如果 customers_new 已存在但迁移没完成，先清理
  if (tableExists(db, 'customers_new')) {
    log('发现残留 customers_new，先清理');
    db.exec('DROP TABLE customers_new');
  }

  const beforeCount = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
  log('迁移前行数:', beforeCount);

  db.exec('BEGIN');
  try {
    // ① 建新表
    db.exec(NEW_TABLE_SQL);
    log('步骤 ① 建 customers_new 完成');

    // ② 全量拷贝（customer_id 原样保留）
    //    ※ 不能用 SELECT *，要显式列名 + COALESCE(..., DEFAULT) 兜底旧行 NULL 值
    //    （sort_order / default_unit 是后加列，旧行可能是 NULL）
    db.exec(`INSERT INTO customers_new
      SELECT customer_id, customer_code, company_name, short_name, warehouse,
             contact_person, phone, address, erp_version, product_type,
             ecommerce_platform, product_count, payment_account, prepaid_price,
             cutoff_time, logistics_control, expiry_mgmt, coop_status, remark,
             customer_type,
             COALESCE(sort_order, 9999),
             COALESCE(default_unit, '单'),
             owner_user_id, is_deleted, created_at, updated_at
      FROM customers`);
    const copiedCount = db.prepare('SELECT COUNT(*) AS c FROM customers_new').get().c;
    log('步骤 ② 拷贝完成:', copiedCount);

    if (copiedCount !== beforeCount) {
      throw new Error(`拷贝行数不匹配：前 ${beforeCount} vs 后 ${copiedCount}，回滚`);
    }

    // ③ 原子重命名（SQLite RENAME 是原子操作，不会出现 customers 不存在的中间态）
    //    customers → customers_bak（保留备份）
    //    customers_new → customers
    db.exec('ALTER TABLE customers RENAME TO customers_bak');
    db.exec('ALTER TABLE customers_new RENAME TO customers');
    log('步骤 ③ 原子 RENAME 完成');

    // 数据完整性二次校验
    const afterCount = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
    log('迁移后行数:', afterCount);
    if (afterCount !== beforeCount) {
      throw new Error(`重命名后行数不匹配：前 ${beforeCount} vs 后 ${afterCount}，回滚`);
    }

    // 验证 UNIQUE 约束确实已移除
    const uniqueCols = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='customers'
    `).get().sql;
    if (/company_name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(uniqueCols) ||
        /customer_code\s+TEXT\s+UNIQUE/i.test(uniqueCols)) {
      throw new Error('customers 表 UNIQUE 约束未移除，迁移失败');
    }
    log('✅ UNIQUE 约束确认已移除');

    markApplied(db);
    db.exec('COMMIT');
    log('迁移完成，customers_bak 保留作为备份');
    return { skipped: false, beforeCount, afterCount };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    log('ROLLBACK 原因:', err.message);
    throw err;
  }
}

module.exports = { run, isApplied };
