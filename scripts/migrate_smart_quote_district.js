// 增量迁移：给历史测算明细表补 district（县区）列。
// 背景：schema.sql 用 CREATE TABLE IF NOT EXISTS，旧库不会自动加列。
// 幂等：已有列直接跳过；可用 ERP_DB_PATH 指定目标库（默认 data/erp.db）。
// 用法：node scripts/migrate_smart_quote_district.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');

(function main() {
  const db = new DatabaseSync(DB_PATH);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_quote_records'").get();
    if (!table) {
      console.log('[skip] smart_quote_records 表不存在（全新库启动时由 schema.sql 创建，已含 district）');
      return;
    }
    const cols = db.prepare('PRAGMA table_info(smart_quote_records)').all().map((c) => c.name);
    if (cols.includes('district')) {
      console.log('[ok] smart_quote_records.district 已存在，无需迁移');
      return;
    }
    db.exec("ALTER TABLE smart_quote_records ADD COLUMN district TEXT NOT NULL DEFAULT ''");
    const after = db.prepare('PRAGMA table_info(smart_quote_records)').all().map((c) => c.name);
    if (!after.includes('district')) throw new Error('ALTER 后仍未检测到 district 列');
    console.log('[ok] 已为 smart_quote_records 增加 district 列（历史行默认空串）');
  } finally {
    db.close();
  }
})();
