// ============================================================================
//  数据完整性校验（最高优先级铁律的可执行落地）
//  用法：node scripts/verify_data_integrity.js [备份库路径]
//  默认取 data/ 下最新的 erp.db.bak-*，与当前库逐表比对：
//   - 业务表行数 + 全字段 SHA256 指纹（客户/订单/工时/库存流水/报价/测单/配置）
//   - audit_logs 历史 8 列指纹（新增字段不得改动任何历史值）
//   - audit_logs 新旧字段对齐（无空值、无错位、无重复、视图不丢行）
//  发布新功能 / 修 Bug / 重构前后都应执行一次，任一 FAIL 退出码为 1。
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const CUR = process.env.ERP_DB_PATH || path.join(ROOT, 'data', 'erp.db');
let BAK = process.argv[2];
if (!BAK) {
  const dir = path.dirname(CUR);
  const list = fs.readdirSync(dir)
    .filter((f) => f.startsWith(path.basename(CUR) + '.bak-'))
    .sort();
  BAK = list.length ? path.join(dir, list[list.length - 1]) : null;
}
if (!BAK || !fs.existsSync(BAK)) {
  console.error('未找到迁移前备份库；请显式传入：node scripts/verify_data_integrity.js <备份库路径>');
  process.exit(1);
}

const BUSINESS_TABLES = [
  'customers', 'orders', 'inventory_transactions', 'work_hours',
  'logistics_quotes', 'app_settings', 'smart_quote_batches', 'smart_quote_records',
];
const LEGACY_COLS = [
  'log_id', 'operator', 'operated_at', 'table_name',
  'record_id', 'action', 'before_summary', 'after_summary',
];

function signature(db, sql) {
  const rows = db.prepare(sql).all();
  const text = rows.map((r) => Object.values(r)
    .map((v) => (v == null ? '\u0000' : String(v))).join('\u001f')).join('\u001e');
  return { count: rows.length, hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
}

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (detail ? ' → ' + detail : ''));
  if (!ok) failed++;
}

const cur = new DatabaseSync(CUR);
const bak = new DatabaseSync(BAK, { readOnly: true });
console.log('当前库：' + CUR);
console.log('基准库：' + BAK + '\n');

BUSINESS_TABLES.forEach((t) => {
  const a = signature(bak, `SELECT * FROM ${t}`);
  const b = signature(cur, `SELECT * FROM ${t}`);
  check(`业务表 ${t} 数据零变化（${a.count} 行）`, a.count === b.count && a.hash === b.hash,
    a.hash === b.hash ? '' : '指纹不一致');
});
const la = signature(bak, `SELECT ${LEGACY_COLS.join(',')} FROM audit_logs ORDER BY log_id`);
const lb = signature(cur, `SELECT ${LEGACY_COLS.join(',')} FROM audit_logs ORDER BY log_id`);
check('audit_logs 历史 8 列零变化（' + la.count + ' 行）', la.count === lb.count && la.hash === lb.hash);

try {
  const bad = cur.prepare(`
    SELECT COUNT(*) c FROM audit_logs
    WHERE id IS NULL OR id <> log_id OR user_name IS NULL OR module IS NULL OR module=''
       OR target_id IS NULL OR content IS NULL OR ip_address IS NULL
       OR created_at IS NULL OR created_at <> operated_at
  `).get().c;
  check('标准字段无空值 / 无错位', bad === 0, bad + ' 行异常');
  const dup = cur.prepare('SELECT COUNT(*) c FROM (SELECT id FROM audit_logs GROUP BY id HAVING COUNT(*)>1)').get().c;
  check('无重复日志', dup === 0, dup + ' 组');
  const total = cur.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
  const view = cur.prepare('SELECT COUNT(*) c FROM v_audit_logs').get().c;
  check('标准视图不丢行 / 不多行', total === view, `${total} vs ${view}`);
} catch (e) {
  check('标准字段校验可执行', false, e.message);
}

bak.close();
cur.close();
console.log('\n=== 数据完整性校验：' + (failed ? `失败 ${failed} 项` : '全部通过') + ' ===');
process.exit(failed ? 1 : 0);
