#!/usr/bin/env node
// ============================================================================
//  手动/脚本备份入口（供 cron 使用）
//    node scripts/backup_db.js
//  环境变量：ERP_DB_PATH / BACKUP_DIR / BACKUP_KEEP
//  实际逻辑在 src/services/dbBackup.js（与进程内定时备份共用）
// ============================================================================
const path = require('path');
const { runBackup } = require('../src/services/dbBackup');

const dbFile = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
const dir = process.env.BACKUP_DIR || path.join(path.dirname(dbFile), 'backups');
const keep = Number(process.env.BACKUP_KEEP) || 30;

try {
  console.log(JSON.stringify(runBackup({ dbFile, dir, keep })));
} catch (e) {
  console.error('[backup] 失败：' + e.message);
  process.exit(1);
}
