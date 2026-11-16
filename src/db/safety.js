// ============================================================
//  数据库安全护栏（数据完整性「死规则」代码级强制）
//  ------------------------------------------------------------
//  铁律（任何人都不得在业务库上违反）：
//   1. 任何"表结构变更"优先用 ALTER TABLE ADD COLUMN；
//      SQLite 不支持的（去 UNIQUE / 改列类型 / 删列）才走"重建"流程。
//   2. 重建流程严格三步：① 建新表(new_xxx) → ② 把旧表数据【全量】拷贝过去
//      → ③ 原子重命名(old→old_bak / new→old)。绝不直接 DROP 旧表、绝不清空数据。
//   3. 任何 DROP TABLE / DELETE 全表 操作，必须经过本护栏：
//      - 先对【整个库文件】做时间戳备份（.pre-drop-<ts>.db）；
//      - 且必须显式设置环境变量 ALLOW_DB_DROP=1 才放行；否则直接 abort。
//  这样即便有人误跑破坏性脚本，也有可回滚的文件副本，且不至于悄悄丢数据。
// ============================================================
const fs = require('fs');
const path = require('path');

const ALLOW_DB_DROP = process.env.ALLOW_DB_DROP === '1';

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 对整个库文件做时间点备份（最稳妥的回滚手段）
function backupWholeDb(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const bak = `${dbPath}.pre-drop-${ts()}.db`;
  fs.copyFileSync(dbPath, bak);
  return bak;
}

// 任何破坏性 DROP 前的强制闸门：未开 ALLOW_DB_DROP 一律拒绝；开则先备份整库
function guardDestructive(dbPath, reason) {
  if (!ALLOW_DB_DROP) {
    throw new Error(
      `[数据安全护栏] 已阻止破坏性操作：${reason}\n` +
      `  本项目铁律禁止无备份的 DROP/清空。若确有必要，请先对整个库做备份，\n` +
      `  并以环境变量显式确认：ALLOW_DB_DROP=1 再运行。\n` +
      `  本次操作已中止，数据未受影响。`
    );
  }
  const bak = backupWholeDb(dbPath);
  console.log(`[数据安全护栏] ALLOW_DB_DROP=1 已确认，已先备份整库：${bak}`);
  return bak;
}

// 重建流程标准三步封装：建新表 → 全量拷贝 → 原子重命名（不 DROP 旧表，旧表改名保留）
function safeRebuild(db, tableName, newDdl, copySql, { backupFirst = true } = {}) {
  const dbPath = db._path || (db._raw && db._raw._path);
  if (backupFirst && dbPath) backupWholeDb(dbPath);
  const tmp = `new_${tableName}`;
  const bak = `${tableName}_bak`;
  db.exec(`DROP TABLE IF EXISTS ${tmp};`);
  db.exec(newDdl.replace(tableName, tmp)); // 新结构写入临时表
  db.exec(`INSERT INTO ${tmp} ${copySql};`); // 旧数据全量拷贝（字段映射由 copySql 决定）
  db.exec('BEGIN;');
  db.exec(`ALTER TABLE ${tableName} RENAME TO ${bak};`); // 旧表改名保留，不直接 DROP
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${tableName};`); // 新表上位
  db.exec('COMMIT;');
  console.log(`[数据安全护栏] ${tableName} 已安全重建：旧表保留为 ${bak}（含全部旧数据），新表已就位。`);
}

module.exports = { guardDestructive, backupWholeDb, safeRebuild, ALLOW_DB_DROP };
