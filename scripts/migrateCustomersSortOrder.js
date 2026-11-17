// ============================================================================
//  customers.sort_order 迁移 CLI（可独立执行；服务启动也会自动执行同一份迁移）
//  用法：node scripts/migrateCustomersSortOrder.js
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
  // 确保基础表结构存在（全新库时）
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customers'").get();
  if (!exists) {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
    console.log('[schema] 已初始化基础表结构');
  }

  const mig = require('../src/db/migrateCustomersSortOrder');
  const report = mig.run(db, { verbose: true });

  const total = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  const matchedRows = db.prepare('SELECT COUNT(*) c FROM customers WHERE sort_order < 9999').get().c;
  const listCount = mig.SORT_LIST.length;

  console.log('\n=== customers.sort_order 迁移报告 ===');
  console.log('客户总行数          :', total);
  console.log('本次名单条数        :', listCount);
  console.log('名单匹配行数        :', report.matched, '(已刷入 sort_order)');
  console.log('未匹配（跳过+WARN） :', report.unmatched.length);
  if (report.unmatched.length) {
    console.log('未匹配名单：');
    report.unmatched.forEach((x) => console.log('  - ' + x));
  }
  console.log('已分配 sort_order 行数:', matchedRows, '(<9999)');
  console.log('默认 9999 未分配行数  :', total - matchedRows);
  console.log('原库备份            :', backup || '（新建库无备份）');

  db.close();
  console.log('\n=== 迁移完成 ===');
} catch (e) {
  try { db.close(); } catch (_) { /* ignore */ }
  console.error('\n=== 迁移失败 ===');
  console.error(e.message);
  console.error('如需人工恢复，请使用备份文件：' + (backup || '无'));
  process.exit(1);
}
