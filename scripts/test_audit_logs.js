// ============================================================================
//  audit_logs 数据完整性回归测试（在「真实库副本」上运行，绝不碰生产库）
//  用法：node scripts/test_audit_logs.js
//  覆盖：迁移前/后历史列指纹、字段对齐、模块与动作映射、旧式 INSERT 兜底、
//        幂等重复执行、无重复/无错位；结束自动清理所有临时文件。
// ============================================================================
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.ERP_DB_PATH || path.join(ROOT, 'data', 'erp.db');
const TMP = path.join(ROOT, 'data', '_audit_test.db');
const { run, fingerprint, CANONICAL_COLS } = require('../src/db/migrateAuditLogs');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('PASS: ' + name); }
  catch (e) { console.error('FAIL: ' + name + ' → ' + e.message); failed++; }
}

// 清理由本测试产生的临时产物（只匹配固定前缀，绝不误删 erp.db）
function cleanup() {
  fs.readdirSync(path.dirname(TMP)).forEach((f) => {
    if (f.startsWith('_audit_test.db')) {
      try { fs.rmSync(path.join(path.dirname(TMP), f)); } catch (_) { /* ignore */ }
    }
  });
}
cleanup();
if (!fs.existsSync(SRC)) { console.error('源数据库不存在：' + SRC); process.exit(1); }
fs.copyFileSync(SRC, TMP);

const db = new DatabaseSync(TMP);
const before = fingerprint(db);
let report = null;

t('迁移执行成功且返回完整性报告', () => {
  report = run(db);
  assert.equal(report.rows, before.count);
  assert.equal(report.misaligned, 0);
  assert.equal(report.duplicated, 0);
});
t('历史 8 列逐字节未变（行数 + SHA256 指纹）', () => {
  const after = fingerprint(db);
  assert.equal(after.count, before.count);
  assert.equal(after.hash, before.hash);
});
t('8 个标准字段全部存在且无空值/无错位', () => {
  const cols = new Set(db.prepare('PRAGMA table_info(audit_logs)').all().map((c) => c.name));
  CANONICAL_COLS.forEach((c) => assert.ok(cols.has(c), '缺列 ' + c));
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE ${CANONICAL_COLS.filter((c) => c !== 'user_id').map((c) => `${c} IS NULL`).join(' OR ')}`).get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE id <> log_id OR created_at <> operated_at').get().c, 0);
});
t('标准视图行数与原表一致（无丢失、无重复）', () => {
  assert.equal(db.prepare('SELECT COUNT(*) c FROM v_audit_logs').get().c, before.count);
});
t('历史日志 module 按原 table_name 正确归类', () => {
  const rows = db.prepare('SELECT table_name, module FROM v_audit_logs').all();
  const expect = { customers: '客户资料', work_hours: '工时管理', roles: '系统/权限' };
  rows.forEach((r) => assert.equal(r.module, expect[r.table_name], r.table_name));
});
t('action 中文枚举映射（create→新增 / update→修改 / delete→删除）', () => {
  const rows = db.prepare('SELECT action_raw, action FROM v_audit_logs').all();
  const expect = { create: '新增', update: '修改', delete: '删除' };
  rows.forEach((r) => assert.equal(r.action, expect[r.action_raw], r.action_raw));
});
t('content 回填为 before/after 对比 JSON 且可解析', () => {
  db.prepare('SELECT content FROM v_audit_logs').all().forEach((r) => {
    const o = JSON.parse(r.content);
    assert.ok('before' in o && 'after' in o);
  });
});
t('旧式 INSERT 不报错且标准字段自动兜底对齐', () => {
  db.prepare('INSERT INTO audit_logs (operator,table_name,record_id,action,before_summary,after_summary) VALUES (?,?,?,?,?,?)')
    .run('admin', 'logistics_quotes', 'T-1', 'import', null, JSON.stringify({ a: 1 }));
  const r = db.prepare('SELECT * FROM v_audit_logs WHERE target_id=?').get('T-1');
  assert.equal(r.id, r.log_id, 'id 与 log_id 对齐');
  assert.equal(r.module, '物流报价');
  assert.equal(r.action, '导入');
  assert.equal(r.user_name, 'admin');
  assert.equal(r.user_id, 1);
  assert.ok(r.created_at && r.ip_address !== null);
  assert.deepEqual(JSON.parse(r.content).after, { a: 1 });
});
t('重复执行迁移幂等，不产生新行、不改历史指纹', () => {
  const n = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
  const hashBefore = fingerprint(db).hash;
  const rep2 = run(db);
  assert.equal(rep2.addedColumns.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c, n);
  assert.equal(fingerprint(db).hash, hashBefore);
});

db.close();
cleanup();
console.log('\n=== audit_logs 完整性测试：' + (failed ? `失败 ${failed} 项` : '全部通过') + ' ===');
process.exit(failed ? 1 : 0);
