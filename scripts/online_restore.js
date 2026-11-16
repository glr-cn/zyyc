'use strict';
// ============================================================================
//  线上数据恢复（通过线上真实导入 API，幂等可重复执行）
// ----------------------------------------------------------------------------
//  前置：修复版已发布（dbPath 落包外持久目录、线上库为空）。
//  动作：登录 → 依次导入 客户(102) → 发货工时(26, 龙湖仓) → 物流报价(31 区域)
//        → 复核 /api/health counts。
//  安全：仅 upsert 幂等导入，重复执行不产生重复数据；绝不触碰本地库。
//  用法：node scripts/online_restore.js [--dry-run]
// ============================================================================
const path = require('path');
const fs = require('fs');

const BASE = process.env.ERP_ONLINE_BASE || 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SHARECODE = process.env.ERP_SHARECODE || 'EVNPURXWC2';
const USER = process.env.ERP_ADMIN_USER || 'admin';
const PASS = process.env.ERP_ADMIN_PASS || 'admin123';
const OUT = path.join(__dirname, 'out');
const DRY = process.argv.includes('--dry-run');

let pass = 0, fail = 0;
const ok = (m, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + m + (extra ? `（${extra}）` : '')); }
  else { fail++; console.log('  ❌ ' + m + (extra ? `（${extra}）` : '')); }
};
const api = (p) => `${BASE}${p}${p.includes('?') ? '&' : '?'}sharecode=${SHARECODE}`;

function fileBuf(name) {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) throw new Error('缺少恢复模板：' + p);
  return fs.readFileSync(p);
}
function form(buf, fname, fields) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fname);
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
  return fd;
}

(async () => {
  console.log(`══════ 线上数据恢复（${DRY ? 'DRY-RUN 预演' : '正式导入'}）══════`);
  console.log(`目标：${BASE}\n`);

  // ---- 0. 基线 ----
  const h0 = await (await fetch(api('/api/health'))).json();
  console.log(`[0] 基线 counts=${JSON.stringify(h0.counts)} dbPath=${h0.dbPath}`);
  if (h0.counts.customers > 0 && !process.env.FORCE_RESTORE) {
    console.log('⚠️  线上已有客户数据！为防误覆盖，已中止。确需重导请设 FORCE_RESTORE=1。');
    process.exit(1);
  }

  // ---- 登录 ----
  const login = await (await fetch(api('/api/auth/login'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })).json();
  ok('管理员登录', !!login.token);
  const H = { 'X-ERP-Token': login.token };

  if (DRY) { console.log('\n[dry-run] 预演结束，未写入任何数据'); process.exit(0); }

  // ---- 1. 客户 ----
  console.log('\n[1] 导入 客户资料_恢复模板.xlsx');
  const c = await (await fetch(api('/api/customers/import'), {
    method: 'POST', headers: H, body: form(fileBuf('客户资料_恢复模板.xlsx'), '客户.xlsx'),
  })).json();
  ok('客户导入 created=102', c.created === 102, `created=${c.created} failed=${c.failed}`);
  if (c.failures && c.failures.length) console.log('   失败明细：' + JSON.stringify(c.failures).slice(0, 400));

  // ---- 2. 工时（预览 → 决策 → 落库）----
  console.log('\n[2] 导入 发货工时_恢复模板.xlsx（龙湖仓·发货）');
  const pv = await (await fetch(api('/api/workhours/import/preview?warehouse=' + encodeURIComponent('龙湖仓')), {
    method: 'POST', headers: H, body: form(fileBuf('发货工时_恢复模板.xlsx'), '工时.xlsx'),
  })).json();
  ok('工时预览 0 错误', Array.isArray(pv.errors) && pv.errors.length === 0,
    Array.isArray(pv.errors) ? '' : String(pv.error || ''));
  ok('工时可创建 26 行', pv.createCount === 26, `create=${pv.createCount}`);
  const decisions = {};
  (pv.data || []).forEach((r) => { decisions[r.line] = r.decision === 'skip' ? 'skip' : 'overwrite'; });
  const w = await (await fetch(api('/api/workhours/import?warehouse=' + encodeURIComponent('龙湖仓')), {
    method: 'POST', headers: H, body: form(fileBuf('发货工时_恢复模板.xlsx'), '工时.xlsx', { decisions: JSON.stringify(decisions) }),
  })).json();
  ok('工时落库 26 行', (w.created || 0) === 26, `created=${w.created} errors=${(w.errors || []).length}`);

  // ---- 3. 物流报价 ----
  console.log('\n[3] 导入 物流报价_恢复模板.xlsx');
  const q = await (await fetch(api('/api/logistics-quotes/import'), {
    method: 'POST', headers: H, body: form(fileBuf('物流报价_恢复模板.xlsx'), '报价.xlsx'),
  })).json();
  ok('报价导入 created=31', q.created === 31, `created=${q.created} failed=${q.failed}`);

  // ---- 4. 复核 ----
  console.log('\n[4] 导入后复核');
  const h1 = await (await fetch(api('/api/health'))).json();
  console.log('    counts=' + JSON.stringify(h1.counts));
  ok('客户 102', h1.counts.customers === 102, String(h1.counts.customers));
  ok('工时 26', h1.counts.work_hours === 26, String(h1.counts.work_hours));
  ok('报价 31', h1.counts.logistics_quotes === 31, String(h1.counts.logistics_quotes));
  ok('审计日志有记录（导入留痕）', h1.counts.audit_logs > 0, String(h1.counts.audit_logs));

  console.log('\n────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exit(1);
  console.log('✅ 线上数据恢复完成（客户 102 / 工时 26 / 报价 31）');
  console.log('提醒：44 个缺仓库客户在「客户资料_待补仓库.xlsx」，补齐后可再次执行本脚本并入。');
})().catch((e) => { console.error('恢复异常：', e.message); process.exit(1); });
