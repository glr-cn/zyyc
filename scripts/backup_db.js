#!/usr/bin/env node
// ============================================================================
//  线上库一致性快照（备份唯一入口）
// ----------------------------------------------------------------------------
//  为什么不用 cp：
//    SQLite 在 WAL / rollback journal 模式下，运行中直接 cp 可能拷到「半写事务」，
//    得到损坏或回退到旧状态的库。本脚本改用 `VACUUM INTO`——由 SQLite 自己保证
//    快照一致性，且不阻塞业务写入。
//
//  产物：${BACKUP_DIR}/erp-YYYYMMDD-HHMMSS.db（默认 BACKUP_DIR=库文件同级的 backups/）
//  校验：PRAGMA integrity_check 必须为 ok，并统计业务表行数；不合格立即删除不留下坏快照。
//  保留：默认最近 30 份（BACKUP_KEEP），旧的自动清理。
//
//  环境变量：ERP_DB_PATH / BACKUP_DIR / BACKUP_KEEP
// ============================================================================
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('../src/db/driver');

const DB_FILE = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 30);
const TABLES = ['customers', 'orders', 'inventory_transactions', 'work_hours', 'logistics_quotes', 'users'];

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function fail(msg) {
  console.error('[backup] 失败：' + msg);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(DB_FILE)) fail('数据库不存在：' + DB_FILE);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, 'erp-' + stamp(new Date()) + '.db');
  if (fs.existsSync(target)) fail('快照文件已存在，请稍后重试：' + target);

  const db = openDatabase(DB_FILE);
  try {
    db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
  } finally {
    db.close();
  }

  // ---- 快照校验：损坏即删除，绝不留下「看起来有备份、实际不可用」的文件 ----
  const snap = openDatabase(target, { readOnly: true, fileMustExist: true });
  let report;
  try {
    const integrity = snap.prepare('PRAGMA integrity_check').get();
    const ok = integrity && (integrity.integrity_check === 'ok');
    const existing = new Set(snap.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const counts = {};
    for (const t of TABLES) {
      if (existing.has(t)) counts[t] = snap.prepare('SELECT COUNT(*) c FROM ' + t).get().c;
    }
    if (!ok) { snap.close(); fs.unlinkSync(target); fail('integrity_check 未通过：' + JSON.stringify(integrity)); }
    report = counts;
  } finally {
    try { snap.close(); } catch (e) { /* ignore */ }
  }

  // ---- 轮转：只保留最近 KEEP 份 ----
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^erp-\d{8}-\d{6}\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const removed = [];
  for (const x of files.slice(KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, x.f)); removed.push(x.f); } catch (e) { /* ignore */ }
  }

  console.log(JSON.stringify({
    ok: true,
    file: target,
    sizeMB: +(fs.statSync(target).size / 1048576).toFixed(2),
    counts: report,
    kept: Math.min(files.length, KEEP),
    removed,
  }));
}

main();
