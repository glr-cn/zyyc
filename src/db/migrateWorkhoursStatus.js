// ============================================================================
//  工时归档状态 —— 幂等启动迁移（数据完整性守卫）
//  ----------------------------------------------------------------------------
//  铁律：绝不 DROP TABLE / 清空业务数据。本迁移只做一件事：
//    ALTER TABLE work_hours ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
//  SQLite 对 NOT NULL DEFAULT 的新列会自动为所有历史行填入 'pending'，
//  因此历史工时零改动、零丢失，全部默认「未归档」。
//  校验：迁移前后比对 work_hours 的「行数 + 原有列指纹」，
//        任一不符立即 ROLLBACK，绝不带病写业务数据。
//  被 src/db/index.js 启动时调用，也可由 scripts/migrate_workhours_status.js 单独调用。
// ============================================================================
const crypto = require('crypto');

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// 指纹：只取传入的「原有列」（新增 status 不在其中），按主键排序，
// 任何原列值变化都会体现在指纹里。
function fingerprint(db, table, cols, pk) {
  const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM ${table} ORDER BY "${pk}"`).all();
  const text = rows
    .map((r) => cols.map((c) => (r[c] == null ? '\u0000' : String(r[c]))).join('\u001f'))
    .join('\u001e');
  return { count: rows.length, hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
}

function run(db, { verbose = false } = {}) {
  const log = (...a) => { if (verbose) console.log('[wh-status-migrate]', ...a); };
  if (!tableExists(db, 'work_hours')) throw new Error('work_hours 表不存在，请先执行 schema.sql');

  const colsBefore = columnsOf(db, 'work_hours');
  const hasStatus = colsBefore.includes('status');

  // 迁移前指纹：只覆盖原有列
  const fpBefore = fingerprint(db, 'work_hours', colsBefore, 'work_id');

  if (hasStatus) {
    // 幂等：列已存在则只做计数报告，不改任何数据。
    const pending = db.prepare("SELECT COUNT(*) c FROM work_hours WHERE status='pending'").get().c;
    const archived = db.prepare("SELECT COUNT(*) c FROM work_hours WHERE status='archived'").get().c;
    const report = { changed: false, addedColumns: [], workHours: fpBefore.count, pending, archived };
    log('已存在 status 列，跳过：', JSON.stringify(report));
    return report;
  }

  db.exec('BEGIN');
  try {
    db.exec("ALTER TABLE work_hours ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_wh_status_type ON work_hours(warehouse, work_type, status)');

    // ---- 完整性校验（不通过即回滚）----
    const fpAfter = fingerprint(db, 'work_hours', colsBefore, 'work_id');
    if (fpAfter.count !== fpBefore.count || fpAfter.hash !== fpBefore.hash)
      throw new Error('work_hours 原有业务数据发生变化，已回滚');
    if (!columnsOf(db, 'work_hours').includes('status'))
      throw new Error('字段未对齐（status 列缺失），已回滚');

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw new Error('工时状态迁移失败并已回滚：' + e.message);
  }

  const pending = db.prepare("SELECT COUNT(*) c FROM work_hours WHERE status='pending'").get().c;
  const report = { changed: true, addedColumns: ['work_hours.status'], workHours: fpBefore.count, pending, archived: 0 };
  log('完成：', JSON.stringify(report));
  return report;
}

module.exports = { run };
