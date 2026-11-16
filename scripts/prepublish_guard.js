'use strict';
// ============================================================================
//  发布前「零数据库文件」强制闸门（数据安全铁律 · 最高优先）
// ----------------------------------------------------------------------------
//  用法：node scripts/prepublish_guard.js            → 只检查，失败退出码 1
//        node scripts/prepublish_guard.js --stage    → 检查 + 把库移出项目（发布用）
//        node scripts/prepublish_guard.js --restore → 把库移回项目（发布后本地开发用）
//  背景（2026-11-16 线上事故）：
//    发布包内混入了一个 0 字节的 data/erp.db，线上进程按包内路径打开它 →
//    真实业务库被 0 字节文件替换 → 线上被重建成空库，数据全部消失。
//    本脚本是「机制级防呆」：不靠人记得挪文件，而是在发布前用脚本强制校验，
//    发现任何 .db / .sqlite 文件即将进入发布包时直接中止。
//  铁律：发布包内【绝对不允许】出现任何数据库文件。
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STAGE_DIR = path.join(ROOT, '.publish_staged_db');

// 会被打进发布包的数据库文件特征
const DB_RE = /\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/i;
// 备份/快照类文件（同样绝不能进包）
const BAK_RE = /\.(bak|backup|snapshot)(-|$)/i;
// 这些目录整体排除
const SKIP_DIRS = new Set(['node_modules', '.git', '.publish_staged_db', 'backups']);

const args = process.argv.slice(2);
const mode = args.includes('--stage') ? 'stage' : args.includes('--restore') ? 'restore' : 'check';

/** 递归扫描项目目录，找出所有会被打进发布包的数据库文件 */
function scanDbFiles(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      scanDbFiles(full, acc);
    } else if (ent.isFile()) {
      if (DB_RE.test(ent.name) || BAK_RE.test(ent.name)) {
        acc.push({ file: full, rel: path.relative(ROOT, full), size: fs.statSync(full).size });
      }
    }
  }
  return acc;
}

function stage() {
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const found = scanDbFiles(ROOT);
  if (found.length === 0) {
    console.log('[guard] 项目内无任何数据库文件，无需暂存。');
    return 0;
  }
  for (const f of found) {
    const dest = path.join(STAGE_DIR, path.basename(f.file));
    try {
      fs.copyFileSync(f.file, dest);
      fs.unlinkSync(f.file);
      console.log(`[guard] 已暂存并移出项目：${f.rel} → ${path.relative(ROOT, dest)}（${f.size} 字节）`);
    } catch (e) {
      console.error(`[guard] 移出失败：${f.rel} → ${e.message}`);
      return 1;
    }
  }
  console.log(`[guard] 共移出 ${found.length} 个数据库文件。发布完成后请运行 --restore 移回本地开发环境。`);
  return 0;
}

function restore() {
  if (!fs.existsSync(STAGE_DIR)) {
    console.log('[guard] 无暂存目录，无需恢复。');
    return 0;
  }
  const files = fs.readdirSync(STAGE_DIR).filter((f) => DB_RE.test(f) || BAK_RE.test(f));
  if (files.length === 0) {
    try { fs.rmSync(STAGE_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('[guard] 暂存目录为空，已清理。');
    return 0;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of files) {
    const dest = path.join(DATA_DIR, f);
    try {
      fs.copyFileSync(path.join(STAGE_DIR, f), dest);
      console.log(`[guard] 已恢复：${path.relative(ROOT, dest)}`);
    } catch (e) {
      console.error(`[guard] 恢复失败：${f} → ${e.message}`);
      return 1;
    }
  }
  try { fs.rmSync(STAGE_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('[guard] 本地开发库已归位。');
  return 0;
}

function check() {
  const found = scanDbFiles(ROOT);
  if (found.length === 0) {
    console.log('[guard] ✅ 通过：项目内 0 个数据库文件，发布包不可能携带任何库文件。');
    return 0;
  }
  console.error('[guard] ❌ 阻断发布：项目内发现数据库文件，它们会被打进发布包并覆盖线上真实数据：');
  for (const f of found) {
    console.error(`        - ${f.rel}（${f.size} 字节）`);
  }
  console.error('[guard] 处理方式：运行 node scripts/prepublish_guard.js --stage 暂存移出，发布后 --restore 移回。');
  return 1;
}

let code = 0;
if (mode === 'stage') code = stage();
else if (mode === 'restore') code = restore();
else code = check();
process.exit(code);
