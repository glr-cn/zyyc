#!/usr/bin/env node
// ============================================================================
//  prepublish_guard.js · 发布前数据库文件守卫（数据安全铁律 · 第二层防线）
// ----------------------------------------------------------------------------
//  背景（2026-11-16 线上事故）：发布包内混入 0 字节 data/erp.db，
//  线上进程打开它 → 真实业务库被覆盖 → 数据全失。三重防线：
//    ① .deployignore        排除 data/ 与所有库文件（第一层过滤）
//    ② 本脚本 --stage       发布前物理移出库文件（第二层，本文件）
//    ③ src/db/dbPath.js     线上库只落包外持久目录 + 空库自愈（第三层兜底）
//
//  用法：
//    node scripts/prepublish_guard.js --stage     # 发布前：把库文件移到暂存目录
//    node scripts/prepublish_guard.js --restore   # 发布后/中止：按清单原样还原
//    node scripts/prepublish_guard.js --check     # 只检查，不改动（CI 自检）
//
//  暂存目录 <root>/.publish_staged_db/ 已被 .deployignore 排除，不会进发布包。
//  清单 manifest.json 记录每个文件的原始相对路径，保证 --restore 精确还原。
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAGE_DIR = path.join(ROOT, '.publish_staged_db');
const MANIFEST = path.join(STAGE_DIR, 'manifest.json');

// 需要移出的文件：数据库主文件及其所有伴生文件 / 备份 / 快照
const DB_RE = /\.(?:db|db-wal|db-shm|db-journal|sqlite|sqlite3|sqlite3-journal|bak|bak-.*|backup|backup-.*|snapshot|snapshot-|pre-drop-.*|empty-.*)$/i;
// 这些目录体积大且不含业务库，跳过以提升速度
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'logs', '.publish_staged_db']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(full, out);
    } else if (ent.isFile() && DB_RE.test(ent.name)) {
      out.push(full);
    }
  }
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch (e) { console.error('[guard] 清单损坏，无法还原：' + e.message); return null; }
}

function doStage() {
  const files = [];
  walk(ROOT, files);
  if (!files.length) {
    console.log('[guard --stage] ✅ 未发现任何数据库/备份文件，发布包洁净。');
    return;
  }
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const manifest = { stagedAt: new Date().toISOString(), files: [] };
  for (const full of files) {
    const rel = path.relative(ROOT, full);
    const dest = path.join(STAGE_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 同名文件多次 stage：保留第一次的原始路径，避免覆盖清单
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.renameSync(full, dest);
    manifest.files.push(rel);
    console.log('[guard --stage] 移出 ' + rel);
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`[guard --stage] ✅ 已移出 ${manifest.files.length} 个文件到 .publish_staged_db/（发布后可用 --restore 还原）。`);
}

function doRestore() {
  const manifest = loadManifest();
  if (!manifest) {
    console.error('[guard --restore] 无清单或清单损坏，未做任何改动。');
    process.exitCode = 1;
    return;
  }
  let n = 0;
  for (const rel of manifest.files) {
    const src = path.join(STAGE_DIR, rel);
    const dest = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      console.warn('[guard --restore] 暂存文件缺失，跳过：' + rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.renameSync(src, dest);
    n++;
    console.log('[guard --restore] 还原 ' + rel);
  }
  fs.unlinkSync(MANIFEST);
  console.log(`[guard --restore] ✅ 已还原 ${n} 个文件。`);
}

function doCheck() {
  const files = [];
  walk(ROOT, files);
  if (files.length) {
    console.error('[guard --check] ❌ 发现库文件仍在包内，禁止发布：');
    files.forEach((f) => console.error('  - ' + path.relative(ROOT, f)));
    process.exitCode = 1;
  } else {
    console.log('[guard --check] ✅ 发布包洁净，无库文件。');
  }
}

const mode = process.argv[2];
if (mode === '--stage') doStage();
else if (mode === '--restore') doRestore();
else if (mode === '--check') doCheck();
else {
  console.log('用法：node scripts/prepublish_guard.js [--stage|--restore|--check]');
  process.exitCode = 1;
}
