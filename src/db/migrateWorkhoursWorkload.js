// ============================================================================
//  库内「作业量」字段 —— 幂等启动迁移
//  ----------------------------------------------------------------------------
//  铁律：绝不 DROP TABLE / 重建表 / 清空业务数据。本迁移只做一件事：
//    ALTER TABLE work_hours ADD COLUMN workload REAL   -- 作业量（库内录入）
//  新列可空，历史行保持 NULL（= 未录入），零改动、零丢失。
//  校验：迁移前后比对 work_hours 的「行数 + 原有列指纹」，任一不符立即 ROLLBACK。
//  被 src/db/index.js 启动时调用（位于建表之后、种子之前）。
// ============================================================================
const crypto = require('crypto');

const NEW_COLS = [
  ['workload', 'ALTER TABLE work_hours ADD COLUMN workload REAL'],
];

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function fingerprint(db, table, cols, pk) {
  const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM ${table} ORDER BY "${pk}"`).all();
  const text = rows
    .map((r) => cols.map((c) => (r[c] == null ? '\u0000' : String(r[c]))).join('\u001f'))
    .join('\u001e');
  return { count: rows.length, hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
}

function run(db, { verbose = false } = {}) {
  const log = (...a) => { if (verbose) console.log('[wh-workload-migrate]', ...a); };
  if (!tableExists(db, 'work_hours')) throw new Error('work_hours 表不存在，请先执行 schema.sql');

  const colsBefore = columnsOf(db, 'work_hours');
  const missing = NEW_COLS.filter(([name]) => !colsBefore.includes(name));
  const fpBefore = fingerprint(db, 'work_hours', colsBefore, 'work_id');

  if (!missing.length) {
    const report = { changed: false, addedColumns: [], workHours: fpBefore.count };
    log('已存在 workload 列，跳过：', JSON.stringify(report));
    return report;
  }

  db.exec('BEGIN');
  try {
    for (const [, sql] of missing) db.exec(sql);

    const fpAfter = fingerprint(db, 'work_hours', colsBefore, 'work_id');
    if (fpAfter.count !== fpBefore.count || fpAfter.hash !== fpBefore.hash)
      throw new Error('work_hours 原有业务数据发生变化，已回滚');
    const colsAfter = columnsOf(db, 'work_hours');
    const stillMissing = NEW_COLS.filter(([name]) => !colsAfter.includes(name));
    if (stillMissing.length)
      throw new Error('字段未对齐（缺少 ' + stillMissing.map(([n]) => n).join(', ') + '），已回滚');

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw new Error('库内作业量字段迁移失败并已回滚：' + e.message);
  }

  const report = { changed: true, addedColumns: missing.map(([n]) => 'work_hours.' + n), workHours: fpBefore.count };
  log('完成：', JSON.stringify(report));
  return report;
}

module.exports = { run };
