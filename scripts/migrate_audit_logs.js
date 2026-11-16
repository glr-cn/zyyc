// ============================================================================
//  audit_logs 安全迁移 CLI（可单独执行；服务启动也会自动执行同一份迁移）
//  用法：node scripts/migrate_audit_logs.js     （ERP_DB_PATH 可指定库文件）
//  执行前自动做「数据库文件级备份」，迁移失败自动 ROLLBACK 并保留备份。
// ============================================================================
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let backup = null;
if (fs.existsSync(DB_PATH)) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  backup = `${DB_PATH}.bak-${ts}`;
  fs.copyFileSync(DB_PATH, backup);
  console.log('[backup] 已备份原库：' + backup);
} else {
  console.log('[backup] 数据库不存在，将新建');
}

const db = new DatabaseSync(DB_PATH);
try {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_logs'").get();
  if (!exists) {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
    console.log('[schema] 已初始化基础表结构');
  }
  const report = require('../src/db/migrateAuditLogs').run(db, { verbose: true });
  console.log('\n=== audit_logs 数据完整性校验通过 ===');
  console.log('历史日志行数        :', report.rows, '（迁移前后一致）');
  console.log('历史 8 列 SHA256   :', report.legacyHash);
  console.log('本次新增字段        :', report.addedColumns.length ? report.addedColumns.join(', ') : '无（已是最新结构）');
  console.log('新增字段空值/错位   :', report.misaligned, '行');
  console.log('重复数据            :', report.duplicated, '组');
  console.log('按模块分布          :', JSON.stringify(report.modules));
  console.log('原库备份            :', backup || '（新建库无备份）');
  db.close();
  console.log('=== 迁移完成 ===');
} catch (e) {
  db.close();
  console.error('\n=== 迁移失败：数据库已回滚到迁移前状态 ===');
  console.error(e.message);
  console.error('如需人工恢复，请使用备份文件：' + (backup || '无'));
  process.exit(1);
}
