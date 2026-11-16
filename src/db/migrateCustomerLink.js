// ============================================================================
//  客户软删除 + 工时 id 关联 —— 幂等启动迁移（数据完整性守卫）
//  ----------------------------------------------------------------------------
//  铁律：绝不 DROP TABLE / 清空业务数据。本迁移只做两类操作：
//    1) ALTER TABLE ... ADD COLUMN（customers.is_deleted / work_hours.customer_id）
//    2) 回填历史工时 customer_id（仅 UPDATE 新列，按客户名精确匹配，匹配不到留 NULL）
//  校验：迁移前后比对 customers / work_hours 的「行数 + 原有列指纹」，
//        任一不符立即 ROLLBACK，绝不带病写业务数据。
//  被 src/db/index.js 启动时调用，也可由 scripts/migrate_customer_link.js 单独调用。
// ============================================================================
const crypto = require('crypto');

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// 指纹：只取传入的「原有列」，按主键排序，任何原列值变化都会体现在指纹里
function fingerprint(db, table, cols, pk) {
  const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM ${table} ORDER BY "${pk}"`).all();
  const text = rows
    .map((r) => cols.map((c) => (r[c] == null ? '\u0000' : String(r[c]))).join('\u001f'))
    .join('\u001e');
  return { count: rows.length, hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
}

function run(db, { verbose = false } = {}) {
  const log = (...a) => { if (verbose) console.log('[cust-link-migrate]', ...a); };
  for (const t of ['customers', 'work_hours']) {
    if (!tableExists(db, t)) throw new Error(`${t} 表不存在，请先执行 schema.sql`);
  }

  const custColsBefore = columnsOf(db, 'customers');
  const whColsBefore = columnsOf(db, 'work_hours');
  const hasDeleted = custColsBefore.includes('is_deleted');
  const hasCustId = whColsBefore.includes('customer_id');

  // 【关键】指纹必须排除「本迁移自身负责回填的列」：
  //   customers.is_deleted 与 work_hours.customer_id 本来就可能已存在（schema.sql 已含），
  //   而迁移会 UPDATE 回填 customer_id（NULL → 命中客户名的 id）。
  //   若把这两列算进指纹，回填本身就会让指纹变化 → 误判「业务数据被改动」→ 整体 ROLLBACK，
  //   导致「从备份恢复后启动即崩」。（2026-11-16 空库自愈实测发现）
  // 因此指纹只覆盖「本迁移绝不触碰」的业务列。
  const CUST_MUTATED_COLS = new Set(['is_deleted']);
  const WH_MUTATED_COLS = new Set(['customer_id']);
  const custFpCols = custColsBefore.filter((c) => !CUST_MUTATED_COLS.has(c));
  const whFpCols = whColsBefore.filter((c) => !WH_MUTATED_COLS.has(c));

  // 迁移前的指纹：只覆盖「本迁移不会修改的业务列」
  const custFpBefore = fingerprint(db, 'customers', custFpCols, 'customer_id');
  const whFpBefore = fingerprint(db, 'work_hours', whFpCols, 'work_id');

  const added = [];
  db.exec('BEGIN');
  try {
    if (!hasDeleted) {
      db.exec('ALTER TABLE customers ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0');
      added.push('customers.is_deleted');
      log('新增列 customers.is_deleted');
    } else log('跳过已存在列 customers.is_deleted');

    if (!hasCustId) {
      db.exec('ALTER TABLE work_hours ADD COLUMN customer_id INTEGER');
      added.push('work_hours.customer_id');
      log('新增列 work_hours.customer_id');
    } else log('跳过已存在列 work_hours.customer_id');

    // 回填历史工时关联 id：仅当 customer_id 为空且有客户名时，按 company_name/short_name 精确匹配。
    // 一个客户名命中多条时取最小 customer_id（稳定），匹配不到保持 NULL 不影响显示。
    db.exec(`
      UPDATE work_hours
         SET customer_id = (
           SELECT c.customer_id FROM customers c
            WHERE c.company_name = work_hours.customer_name
               OR (c.short_name IS NOT NULL AND c.short_name <> '' AND c.short_name = work_hours.customer_name)
            ORDER BY c.customer_id LIMIT 1
         )
       WHERE (customer_id IS NULL)
         AND customer_name IS NOT NULL AND customer_name <> ''
    `);

    // ---- 完整性校验（不通过即回滚）----
    const custFpAfter = fingerprint(db, 'customers', custFpCols, 'customer_id');
    const whFpAfter = fingerprint(db, 'work_hours', whFpCols, 'work_id');
    if (custFpAfter.count !== custFpBefore.count || custFpAfter.hash !== custFpBefore.hash)
      throw new Error('customers 原有业务数据发生变化，已回滚');
    if (whFpAfter.count !== whFpBefore.count || whFpAfter.hash !== whFpBefore.hash)
      throw new Error('work_hours 原有业务数据发生变化，已回滚');
    const colsAfterCust = columnsOf(db, 'customers');
    const colsAfterWh = columnsOf(db, 'work_hours');
    if (!colsAfterCust.includes('is_deleted') || !colsAfterWh.includes('customer_id'))
      throw new Error('字段未对齐（新增列缺失），已回滚');

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw new Error('客户软删除/工时关联迁移失败并已回滚：' + e.message);
  }

  const linked = db.prepare("SELECT COUNT(*) c FROM work_hours WHERE customer_id IS NOT NULL").get().c;
  const orphan = db.prepare("SELECT COUNT(*) c FROM work_hours WHERE customer_name IS NOT NULL AND customer_name<>'' AND customer_id IS NULL").get().c;
  const report = { addedColumns: added, customers: custFpBefore.count, workHours: whFpBefore.count, linked, orphan };
  log('完成：', JSON.stringify(report));
  return report;
}

module.exports = { run };
