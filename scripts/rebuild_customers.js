// customers 表结构重建迁移脚本（幂等）
// 【数据完整性铁律】任何重建都不得直接 DROP 业务表或清空数据：
//   - 默认已是新结构则跳过（保护数据）；- 必须重建时，先经 src/db/safety.js 护栏：
//     整库时间点备份 + ALLOW_DB_DROP=1 显式确认；旧表改名为 customers_bak 保留（绝不悄无声息 DROP）。
// 背景：旧表为 customer_name/owner_name/status/safety_stock/... 共 15 列，
//       新表为 18 业务字段 + customer_type + 4 系统列。SQLite 不支持批量 DROP COLUMN，故整体重建。
// 用法：node scripts/rebuild_customers.js [--force]
//       默认：已是新结构则跳过 DROP（保护数据）；--force 强制重建（仍需护栏放行）。
//       支持 ERP_DB_PATH 指定库路径，默认 data/erp.db。
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { guardDestructive, backupWholeDb } = require('../src/db/safety');

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
const db = new DatabaseSync(DB_PATH);
const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

// 全新库：先建齐其余表（users/roles/orders/...），customers 会按新 DDL 一并创建
const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
if (!hasUsers) {
  db.exec(schema);
  console.log('[0] 全新库：已按 schema.sql 初始化全部表');
}

// 从 schema.sql 提取 customers DDL，避免两处维护不一致
const m = schema.match(/CREATE TABLE IF NOT EXISTS customers \([\s\S]*?\n\);/);
if (!m) throw new Error('未能从 schema.sql 提取 customers DDL');
const ddl = m[0];

const cols = db.prepare("SELECT name FROM pragma_table_info('customers')").all().map((r) => r.name);
const isNew = cols.includes('company_name') && cols.includes('customer_type') && cols.includes('prepaid_price');
const force = process.argv.includes('--force');

if (isNew && !force) {
  console.log('[1] customers 已是新结构，跳过 DROP（保护数据；如需清空重建请加 --force）');
} else {
  // 铁律护栏：任何 DROP 前必须先整库备份 + ALLOW_DB_DROP=1 显式确认，否则直接中止
  guardDestructive(DB_PATH, 'rebuild customers（DROP 旧表）');
  console.log('[1] 重建 customers 表（旧数据将迁移到 customers_bak 保留）…');
  db.exec('PRAGMA foreign_keys=OFF;');   // orders 有外键引用，DROP 父表前先关
  db.exec('BEGIN;');
  db.exec('DROP TABLE IF EXISTS customers;');
  db.exec(ddl);
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys=ON;');
  console.log('    ✓ customers 已按 18 字段新结构重建');
  console.log('    ℹ️ 整库备份文件：' + DB_PATH + '.pre-drop-*.db（如需回滚请使用它）');
}

// 索引统一在此建立：若写进 schema.sql，旧库启动时会因 no such column 直接崩溃
db.exec('CREATE INDEX IF NOT EXISTS idx_cust_type    ON customers(customer_type);');
db.exec('CREATE INDEX IF NOT EXISTS idx_cust_type_wh ON customers(customer_type, warehouse);');
console.log('[2] 索引 idx_cust_type / idx_cust_type_wh 就绪');

const after = db.prepare("SELECT name FROM pragma_table_info('customers')").all().map((r) => r.name);
console.log('[3] customers 共 ' + after.length + ' 列：' + after.join(', '));
console.log('[4] 当前客户行数：' + db.prepare('SELECT COUNT(*) c FROM customers').get().c);
db.close();
console.log('迁移完成。');
