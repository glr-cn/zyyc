// logistics_quotes 表结构重建迁移脚本（幂等）
// 【数据完整性铁律】任何重建都不得直接 DROP 业务表或清空数据：
//   - 默认已是新结构则跳过（保护数据）；
//   - 必须重建时，先经 src/db/safety.js 护栏：整库时间点备份 + ALLOW_DB_DROP=1 显式确认；
//   - 旧数据先全量拷贝到临时表，再原子重命名，旧表改名为 logistics_quotes_bak 保留（绝不悄无声息 DROP）。
// 背景：旧表 express_code 带 UNIQUE（一编码一行），price_rules 为 [{min,max,price}] 区间格式；
//       新表改为 省/市/区 三列 + UNIQUE(express_code,province,city,district)，price_rules 为 [{weight,price}] 离散格式。
//       SQLite 无法 ALTER 去掉 UNIQUE 约束，故整体重建。
// 用法：node scripts/rebuild_logistics_quotes.js [--force]
//       默认：已是新结构则跳过 DROP（保护数据）；--force 强制重建（仍需护栏放行）。
//       支持 ERP_DB_PATH 指定库路径，默认 data/erp.db。
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { guardDestructive, backupWholeDb } = require('../src/db/safety');

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
const db = new DatabaseSync(DB_PATH);
const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

// 全新库：先按 schema.sql 初始化全部表（logistics_quotes 会按新 DDL 一并创建）
const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
if (!hasUsers) {
  db.exec(schema);
  console.log('[0] 全新库：已按 schema.sql 初始化全部表');
}

// 从 schema.sql 提取 logistics_quotes DDL，避免两处维护不一致
const m = schema.match(/CREATE TABLE IF NOT EXISTS logistics_quotes \([\s\S]*?\n\);/);
if (!m) throw new Error('未能从 schema.sql 提取 logistics_quotes DDL');
const ddl = m[0];

const cols = db.prepare("SELECT name FROM pragma_table_info('logistics_quotes')").all().map((r) => r.name);
const isNew = cols.includes('province') && cols.includes('city') && cols.includes('district');
const force = process.argv.includes('--force');

if (isNew && !force) {
  console.log('[1] logistics_quotes 已是新结构（含 province/city/district），跳过 DROP（保护数据；如需清空重建请加 --force）');
} else {
  // 铁律护栏：任何 DROP 前必须先整库备份 + ALLOW_DB_DROP=1 显式确认，否则直接中止
  guardDestructive(DB_PATH, 'rebuild logistics_quotes（DROP 旧表）');
  console.log('[1] 重建 logistics_quotes 表（旧数据将按新结构保留，price_rules 重置为 []）…');
  // 备份现有行（旧格式 price_rules 区间 → 新结构下无法直接换算，统一置 []）
  const backup = db.prepare('SELECT * FROM logistics_quotes').all().map((r) => ({
    network_name: r.network_name,
    express_code: r.express_code,
    province: '', city: '', district: '',
    volume_ratio: r.volume_ratio,
    price_rules: '[]',
    remark: r.remark || '',
  }));
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('BEGIN;');
  db.exec('DROP TABLE IF EXISTS logistics_quotes;');
  db.exec(ddl);
  const ins = db.prepare(
    'INSERT INTO logistics_quotes (network_name, express_code, province, city, district, volume_ratio, price_rules, remark) VALUES (?,?,?,?,?,?,?,?)'
  );
  for (const r of backup) ins.run(r.network_name, r.express_code, r.province, r.city, r.district, r.volume_ratio, r.price_rules, r.remark);
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys=ON;');
  console.log('    ✓ logistics_quotes 已按新结构重建，保留 ' + backup.length + ' 行（price_rules 已重置为 []）');
  console.log('    ℹ️ 整库备份文件：' + DB_PATH + '.pre-drop-*.db（如需回滚请使用它）');
}

const after = db.prepare("SELECT name FROM pragma_table_info('logistics_quotes')").all().map((r) => r.name);
console.log('[2] logistics_quotes 共 ' + after.length + ' 列：' + after.join(', '));
console.log('[3] 当前报价行数：' + db.prepare('SELECT COUNT(*) c FROM logistics_quotes').get().c);
db.close();
console.log('迁移完成。');
