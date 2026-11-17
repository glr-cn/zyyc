// ============================================================================
//  重置 admin 密码（本地/离线库直写）
// ----------------------------------------------------------------------------
//  用法：
//    node scripts/reset_admin_password.js <新密码> [用户名] [--db <路径>] [--dry-run]
//  例：
//    node scripts/reset_admin_password.js admin123
//    node scripts/reset_admin_password.js 'MyPwd@2026' admin --db data/erp.db
//    node scripts/reset_admin_password.js admin123 --dry-run
//
//  安全约定：
//    1) 改前必做【整库时间点备份】到 data/backups/，可随时回滚；
//    2) 只 UPDATE 指定用户一行，其它账号/业务表零改动；
//    3) 改后回读校验（哈希长度/前缀、compareSync 新旧密码、行数不变）；
//    4) --dry-run 只演练不落库。
//  注意：线上环境请走 API PUT /api/users/:id/password，不要直连线上库。
// ============================================================================
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

function parseArgs(argv) {
  const out = { password: null, username: 'admin', db: path.join('data', 'erp.db'), dryRun: false, rounds: 10 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--rounds') out.rounds = parseInt(argv[++i], 10) || 10;
    else rest.push(a);
  }
  out.password = rest[0] || null;
  out.username = rest[1] || out.username;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.password) {
    console.error('用法：node scripts/reset_admin_password.js <新密码> [用户名] [--db <路径>] [--dry-run]');
    process.exit(1);
  }
  if (args.password.length < 6) {
    console.error('密码至少 6 位');
    process.exit(1);
  }
  const dbAbs = path.resolve(args.db);
  if (!fs.existsSync(dbAbs)) {
    console.error('数据库不存在：' + dbAbs);
    process.exit(1);
  }

  // node:sqlite（Node 22 内置）
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) {
    console.error('需要 Node 22+（内置 node:sqlite）：' + e.message);
    process.exit(1);
  }

  // 1) 整库时间点备份
  const bakDir = path.join(path.dirname(dbAbs), 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = path.join(bakDir, path.basename(dbAbs).replace(/\.(db|sqlite3?)$/i, '') + '-' + ts + '-pre-pwd-reset.db');
  fs.copyFileSync(dbAbs, bak);
  console.log('[backup] 已备份 -> ' + bak + '（' + fs.statSync(bak).size + ' 字节）');

  const db = new DatabaseSync(dbAbs);
  try {
    const before = db.prepare('SELECT user_id, username, role_id, password_hash FROM users WHERE username=?').get(args.username);
    if (!before) { console.error('用户不存在：' + args.username); db.close(); process.exit(1); }
    const rowsBefore = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    console.log('[before] user_id=' + before.user_id + ', role_id=' + before.role_id +
      ', hash 前12=' + String(before.password_hash).slice(0, 12) + '...');

    const hash = bcrypt.hashSync(args.password, args.rounds);
    if (args.dryRun) {
      console.log('[dry-run] 未写入库；将要写入的 hash = ' + hash);
      return; // 由 finally 统一 close，避免重复关闭
    }

    // 2) 只改这一行
    const info = db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(hash, args.username);
    console.log('[update] affected rows = ' + info.changes);

    // 3) 回读校验
    const after = db.prepare('SELECT user_id, username, role_id, password_hash FROM users WHERE username=?').get(args.username);
    const rowsAfter = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    console.log('[verify] users 总行数   = ' + rowsAfter + (rowsAfter === rowsBefore ? '（与改前一致）' : '（❌ 行数变了！）'));
    console.log('[verify] hash 长度/前缀 = ' + String(after.password_hash).length + ' / ' + String(after.password_hash).slice(0, 7));
    console.log('[verify] 新密码可校验   = ' + bcrypt.compareSync(args.password, after.password_hash));
    console.log('[verify] 其他账号未动   = ' + (rowsAfter === rowsBefore));
  } finally {
    db.close();
  }
}

main();
