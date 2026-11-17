// ============================================================================
//  数据库快照（唯一实现，CLI 与进程内定时任务共用）
// ----------------------------------------------------------------------------
//  VACUUM INTO：由 SQLite 保证快照一致性，不阻塞业务写入，不会拷到半写事务。
//  快照后立即 integrity_check + 关键表计数；不合格则删除，绝不留下坏文件。
// ============================================================================
const fs = require('fs');
const path = require('path');
const { openDatabase } = require('../db/driver');

const COUNT_TABLES = ['customers', 'orders', 'inventory_transactions', 'work_hours', 'logistics_quotes', 'users'];
const NAME_RE = /^erp-\d{8}-\d{6}\.db$/;

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

// 列出已有快照（按时间倒序）
function listSnapshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .map((f) => ({ file: path.join(dir, f), name: f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 生成一份一致性快照
 * @param {{dbFile:string, dir?:string, keep?:number}} opts
 * @returns {{ok:true,file:string,sizeMB:number,counts:object,kept:number,removed:string[]}}
 */
function runBackup(opts) {
  const dbFile = opts.dbFile;
  if (!dbFile || !fs.existsSync(dbFile)) throw new Error('数据库不存在：' + dbFile);
  const dir = opts.dir || path.join(path.dirname(dbFile), 'backups');
  const keep = Math.max(1, Number(opts.keep) || 30);
  fs.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, 'erp-' + stamp(new Date()) + '.db');
  if (fs.existsSync(target)) throw new Error('快照文件已存在，请稍后重试：' + target);

  const db = openDatabase(dbFile);
  try {
    db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
  } finally {
    db.close();
  }

  // ---- 校验：损坏即删除 ----
  let counts = {};
  const snap = openDatabase(target, { readOnly: true, fileMustExist: true });
  try {
    const integrity = snap.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
      snap.close();
      fs.unlinkSync(target);
      throw new Error('integrity_check 未通过：' + JSON.stringify(integrity));
    }
    const existing = new Set(snap.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of COUNT_TABLES) {
      if (existing.has(t)) counts[t] = snap.prepare('SELECT COUNT(*) c FROM ' + t).get().c;
    }
  } finally {
    try { snap.close(); } catch (e) { /* ignore */ }
  }

  // ---- 轮转 ----
  const removed = [];
  for (const s of listSnapshots(dir).slice(keep)) {
    try { fs.unlinkSync(s.file); removed.push(s.name); } catch (e) { /* ignore */ }
  }

  return {
    ok: true,
    file: target,
    sizeMB: +(fs.statSync(target).size / 1048576).toFixed(2),
    counts,
    kept: Math.min(listSnapshots(dir).length, keep),
    removed,
  };
}

module.exports = { runBackup, listSnapshots };
