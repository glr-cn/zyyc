// ============================================================================
// warehouse_sort_config 表迁移：去掉 FOREIGN KEY(customer_id) REFERENCES customers
// ----------------------------------------------------------------------------
// 背景：customers 表迁移 ALTER TABLE RENAME customers→customers_bak 时，
//       SQLite 会同步重写 warehouse_sort_config 的 FK 约束：
//         REFERENCES customers(customer_id)
//         → REFERENCES customers_bak(customer_id)  ← 坏了！
//       后续 INSERT warehouse_sort_config 会检查 customers_bak 表是否有对应 customer_id，
//       而 customers_bak 是迁移前的旧表，必然找不到 → FOREIGN KEY constraint failed。
// 解法：重建 warehouse_sort_config 表，去掉 FK 约束（软删除客户时排序配置
//       应保留而非 CASCADE 删除；且 customers 表后续还会被迁移，FK 会再次指断）。
// ============================================================================

const FINGERPRINT_NAME = 'warehouse_sort_config_remove_fk_20261119';

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

// 重建 warehouse_sort_config：
// - 与 schema.sql 结构完全一致，唯一区别：去掉 FOREIGN KEY 约束
// - 保留 PRIMARY KEY(warehouse, customer_id) 保证同仓库同客户不重复
// - 保留 idx_wsc_sort 覆盖索引（排序查询加速）
const NEW_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS warehouse_sort_config_new (
  warehouse   TEXT    NOT NULL,
  customer_id INTEGER NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 9999,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (warehouse, customer_id)
  -- ※ 已去掉 FOREIGN KEY(customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
  --    原因：customers 表迁移 ALTER TABLE RENAME 会把 FK 指向 customers_bak 导致 INSERT 失败
  --    软删除客户的排序配置由后端代码（customers.js 软删时）手动处理
);
`;

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_wsc_sort
  ON warehouse_sort_config_new (warehouse, sort_order);
`;

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[wsc-fk-migrate]', ...args); };

  if (!tableExists(db, 'warehouse_sort_config')) {
    log('warehouse_sort_config 不存在，跳过（新库首次启动时会由 schema.sql 创建）');
    return { skipped: true, reason: 'table_missing' };
  }

  if (isApplied(db)) {
    log('已迁移过，跳过');
    return { skipped: true, reason: 'fingerprint' };
  }

  // 前置防御：如果表已不含 FK（上次重建成功但 fingerprint 未写入），
  // 直接标记已应用并跳过。用 PRAGMA foreign_key_list 检测（比正则更准，
  // 因为 FK 指向 customers_bak 时 /REFERENCES\s+customers/ 匹配不到）。

  // ★ 2026-11-20 紧急加固：如果 warehouse_sort_config 主表空但 _bak 有数据，
  // 说明上次 RENAME 后没数据拷贝就崩了（和 customers_remove_unique 同根因），
  // 先从 _bak 全量恢复再继续后续逻辑。
  const _bakExists = tableExists(db, 'warehouse_sort_config_bak');
  if (_bakExists) {
    const _curCount = db.prepare('SELECT COUNT(*) c FROM warehouse_sort_config').get().c;
    const _bakCount = db.prepare('SELECT COUNT(*) c FROM warehouse_sort_config_bak').get().c;
    if (_curCount === 0 && _bakCount > 0) {
      console.warn(`[wsc-fk-migrate] ⚠️ warehouse_sort_config 空但 _bak 有 ${_bakCount} 行！自动恢复…`);
      db.exec('INSERT INTO warehouse_sort_config SELECT * FROM warehouse_sort_config_bak');
      const _after = db.prepare('SELECT COUNT(*) c FROM warehouse_sort_config').get().c;
      console.warn(`[wsc-fk-migrate] ✅ 从 _bak 恢复 ${_bakCount} → 现在 ${_after} 行`);
    }
  }

  const currentFKs = db.prepare('PRAGMA foreign_key_list(warehouse_sort_config)').all();
  if (currentFKs.length === 0) {
    log('表已不含 FK（上次重建成功），直接标记');
    markApplied(db);
    return { skipped: true, reason: 'already_migrated' };
  }

  if (tableExists(db, 'warehouse_sort_config_new')) {
    log('发现残留 warehouse_sort_config_new，清理');
    db.exec('DROP TABLE warehouse_sort_config_new');
  }

  const beforeCount = db.prepare('SELECT COUNT(*) AS c FROM warehouse_sort_config').get().c;
  log('迁移前行数:', beforeCount);

  db.exec('BEGIN');
  try {
    // ① 建新表（无 FK）
    db.exec(NEW_TABLE_SQL);
    db.exec(CREATE_INDEX_SQL);
    log('步骤 ① 建 warehouse_sort_config_new 完成');

    // ② 全量拷贝（显式列名，warehouse/customer_id/sort_order 原样保留）
    db.exec('INSERT INTO warehouse_sort_config_new SELECT warehouse, customer_id, sort_order, updated_at FROM warehouse_sort_config');
    const copiedCount = db.prepare('SELECT COUNT(*) AS c FROM warehouse_sort_config_new').get().c;
    log('步骤 ② 拷贝完成:', copiedCount);

    if (copiedCount !== beforeCount) {
      throw new Error(`拷贝行数不匹配：前 ${beforeCount} vs 后 ${copiedCount}，回滚`);
    }

    // ③ 原子重命名
    db.exec('ALTER TABLE warehouse_sort_config RENAME TO warehouse_sort_config_bak');
    db.exec('ALTER TABLE warehouse_sort_config_new RENAME TO warehouse_sort_config');
    log('步骤 ③ 原子 RENAME 完成');

    const afterCount = db.prepare('SELECT COUNT(*) AS c FROM warehouse_sort_config').get().c;
    log('迁移后行数:', afterCount);
    if (afterCount !== beforeCount) {
      throw new Error(`重命名后行数不匹配：前 ${beforeCount} vs 后 ${afterCount}，回滚`);
    }

    // 验证 FK 已移除
    const fks = db.prepare('PRAGMA foreign_key_list(warehouse_sort_config)').all();
    if (fks.length > 0) {
      throw new Error('FK 未移除：' + JSON.stringify(fks));
    }
    log('✅ FK 约束确认已移除');

    markApplied(db);
    db.exec('COMMIT');
    log('迁移完成，warehouse_sort_config_bak 保留作为备份');
    return { skipped: false, beforeCount, afterCount };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    log('ROLLBACK 原因:', err.message);
    throw err;
  }
}

module.exports = { run, isApplied };
