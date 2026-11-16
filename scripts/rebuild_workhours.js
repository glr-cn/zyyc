// 工时表深度重构迁移脚本
// 说明：旧 work_hours 使用 owner_name/job_type/ship_quantity/shared_source，
//       新模型改为 warehouse/work_type/customer_name/ship_orders/cartons/...。
//       SQLite 不支持 DROP COLUMN，故直接重建表（开发库旧工时数据丢弃）。
// 用法：node scripts/rebuild_workhours.js
//       支持 ERP_DB_PATH 环境变量指定库路径；默认 data/erp.db
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

console.log('[1] 为 customers 补 warehouse 字段（若不存在）…');
const hasWh = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('customers') WHERE name='warehouse'").get().c;
if (!hasWh) {
  db.exec("ALTER TABLE customers ADD COLUMN warehouse TEXT NOT NULL DEFAULT ''");
  console.log('    ✓ customers.warehouse 已添加');
} else {
  console.log('    · customers.warehouse 已存在，跳过');
}

console.log('[2] 重建 work_hours 表（旧数据将丢弃）…');
db.exec('DROP TABLE IF EXISTS work_hours');
db.exec(schema); // 重新执行 schema.sql，按新结构创建 work_hours 及索引
console.log('    ✓ work_hours 已按新结构重建');

const cols = db.prepare('SELECT name FROM pragma_table_info(\'work_hours\')').all().map((r) => r.name);
console.log('[3] work_hours 列：', cols.join(', '));
console.log('迁移完成。');
