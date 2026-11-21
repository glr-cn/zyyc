// ============================================================================
// migrateExpressRegion.js · 偏远地区设置表（2026-11-20）
// ----------------------------------------------------------------------------
// 建 express_region_rules：以快递公司为维度的大偏远/小偏远/正常区域配置。
// 仅 CREATE TABLE IF NOT EXISTS，绝不 DROP / 重建（永久数据安全规则）。
// 幂等：_erp_migrations fingerprint。
// ============================================================================

const { ensureTable } = require('../services/expressRegion');

const FINGERPRINT_NAME = 'express_region_rules_20261120';

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

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[express-region]', ...args); };
  if (isApplied(db)) { log('已迁移过，跳过'); return { skipped: true }; }
  ensureTable(db);
  log('express_region_rules 表已就绪');
  markApplied(db);
  return { skipped: false };
}

module.exports = { run, isApplied };
