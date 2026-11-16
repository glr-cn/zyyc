// ============================================================================
//  audit_logs 幂等迁移执行器（数据完整性守卫）
//  - SQL 单一来源：src/db/audit_logs_migration.sql（按 -- @@ 分段）
//  - 逐列判断 PRAGMA table_info：已存在的列跳过 ALTER → 可重复执行
//  - 全事务；迁移前后比对「历史 8 列」的行数与 SHA256 指纹，
//    并校验无空值/无错位/无重复/视图行数一致，任一不符立即 ROLLBACK
//  - 被 src/db/index.js 启动时调用，也被 scripts/migrate_audit_logs.js 调用
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEGACY_COLS = [
  'log_id', 'operator', 'operated_at', 'table_name',
  'record_id', 'action', 'before_summary', 'after_summary',
];
const CANONICAL_COLS = [
  'id', 'user_id', 'user_name', 'module', 'target_id',
  'content', 'ip_address', 'created_at',
];

// 去掉整行注释，保留语句内部（触发器 BEGIN…END 里的分号不能被切碎）
function stripComments(part) {
  return part
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnsOf(db) {
  return new Set(db.prepare('PRAGMA table_info(audit_logs)').all().map((c) => c.name));
}

// 历史列指纹：只取原有 8 列，任何 UPDATE/DROP/改值都会让指纹变化
function fingerprint(db) {
  const rows = db.prepare(`SELECT ${LEGACY_COLS.join(',')} FROM audit_logs ORDER BY log_id`).all();
  const text = rows
    .map((r) => LEGACY_COLS.map((c) => (r[c] == null ? '\u0000' : String(r[c]))).join('\u001f'))
    .join('\u001e');
  return {
    count: rows.length,
    hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[audit-migrate]', ...args); };
  if (!tableExists(db, 'audit_logs')) {
    throw new Error('audit_logs 表不存在，请先执行 schema.sql 初始化数据库');
  }

  const sql = fs.readFileSync(path.join(__dirname, 'audit_logs_migration.sql'), 'utf8');
  const parts = sql.split(/^\s*--\s*@@\s*$/m).map(stripComments).filter(Boolean);
  const have = columnsOf(db);
  const before = fingerprint(db);
  const added = [];

  db.exec('BEGIN');
  try {
    for (const part of parts) {
      const m = /^ALTER\s+TABLE\s+audit_logs\s+ADD\s+COLUMN\s+(\w+)/i.exec(part);
      if (m) {
        if (have.has(m[1])) { log('跳过已存在列', m[1]); continue; }
        db.exec(part);
        have.add(m[1]);
        added.push(m[1]);
        log('新增列', m[1]);
      } else {
        db.exec(part);
      }
    }

    // ---- 数据完整性校验（不通过即回滚） ----
    const after = fingerprint(db);
    if (after.count !== before.count || after.hash !== before.hash) {
      throw new Error('历史业务数据发生变化（行数或历史列指纹不一致），已回滚');
    }
    const cols = columnsOf(db);
    const missing = [...LEGACY_COLS, ...CANONICAL_COLS].filter((c) => !cols.has(c));
    if (missing.length) throw new Error('字段未对齐，缺失：' + missing.join(','));

    const bad = db.prepare(`
      SELECT COUNT(*) c FROM audit_logs
      WHERE id IS NULL OR id <> log_id
         OR user_name IS NULL OR user_name = ''
         OR module IS NULL OR module = ''
         OR target_id IS NULL
         OR content IS NULL
         OR ip_address IS NULL
         OR created_at IS NULL OR created_at <> operated_at
    `).get().c;
    if (bad) throw new Error(`${bad} 行新增字段为空或新旧字段错位，已回滚`);

    const dup = db.prepare('SELECT COUNT(*) c FROM (SELECT id FROM audit_logs GROUP BY id HAVING COUNT(*) > 1)').get().c;
    if (dup) throw new Error(`id 存在 ${dup} 组重复，已回滚`);

    const viewCount = db.prepare('SELECT COUNT(*) c FROM v_audit_logs').get().c;
    if (viewCount !== after.count) throw new Error('标准视图行数与原表不一致（数据丢失或重复），已回滚');

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw new Error('audit_logs 迁移失败并已回滚：' + e.message);
  }

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length) throw new Error('外键校验失败：' + JSON.stringify(fk));

  const report = {
    rows: before.count,
    legacyHash: before.hash,
    addedColumns: added,
    modules: db.prepare('SELECT module, COUNT(*) c FROM v_audit_logs GROUP BY module ORDER BY module').all(),
    duplicated: 0,
    misaligned: 0,
  };
  log(`完成：${report.rows} 行历史日志全部对齐，新增列 ${added.length} 个`);
  return report;
}

module.exports = { run, fingerprint, LEGACY_COLS, CANONICAL_COLS };
