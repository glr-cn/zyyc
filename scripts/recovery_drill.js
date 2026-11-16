'use strict';
// ============================================================================
//  线上恢复演练（E2E · 隔离临时库）
// ----------------------------------------------------------------------------
//  目的：证明「把 scripts/out/ 的恢复模板丢到线上点导入按钮」这条恢复路径真的走得通。
//  做法：建隔离临时库 → 起真实 Express 服务 → 走真实鉴权与真实导入接口
//        → 依次导入 客户 / 发货工时 / 物流报价 → 核对落库结果。
//  用法：node scripts/recovery_drill.js
//  注意：全程不触碰 data/erp.db 与任何线上库。
// ============================================================================
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TMP = path.join(__dirname, '..', 'data', '__recovery_drill_' + Date.now() + '.db');
if (fs.existsSync(TMP)) { try { fs.unlinkSync(TMP); } catch (e) {} }
process.env.ERP_DB_PATH = TMP;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? `（${extra}）` : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? `（${extra}）` : '')); }
}

const OUT = path.join(__dirname, 'out');
function fileBuf(name) {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) throw new Error('缺少恢复模板：' + p);
  return fs.readFileSync(p);
}
function asForm(buf, fname) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fname);
  return fd;
}

(async () => {
  console.log('══════ 线上恢复演练（隔离临时库，不影响任何真实数据）══════\n');
  execSync(`node ${path.join(__dirname, 'migrate_rbac.js')}`, { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });

  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  ok('管理员登录成功', !!login.token);
  const H = { 'Content-Type': 'application/json', 'X-ERP-Token': login.token };

  // ---------------------------------------------------------- 0. 基线
  const health0 = await (await fetch(base + '/api/health')).json();
  console.log(`\n[0] 演练基线：dbPath=${health0.dbPath} counts=${JSON.stringify(health0.counts)}\n`);
  ok('演练库初始无业务数据', health0.counts.customers === 0 && health0.counts.work_hours === 0);

  // ---------------------------------------------------------- 1. 客户
  console.log('[1] 导入 客户资料_恢复模板.xlsx（102 行）');
  const custRes = await (await fetch(base + '/api/customers/import', {
    method: 'POST', headers: { 'X-ERP-Token': login.token }, body: asForm(fileBuf('客户资料_恢复模板.xlsx'), '客户资料_恢复模板.xlsx'),
  })).json();
  ok('客户导入成功（created=102）', custRes.created === 102 || custRes.success === 102 || (custRes.data && custRes.data.created === 102),
    `返回 ${JSON.stringify(custRes).slice(0, 160)}`);

  const clist = await (await fetch(base + '/api/customers?page=1&pageSize=5', { headers: H })).json();
  const total = clist.total != null ? clist.total : (clist.data && clist.data.total);
  ok('客户总数 = 102', total === 102, `实际 ${total}`);

  // ---------------------------------------------------------- 2. 发货工时
  console.log('\n[2] 导入 发货工时_恢复模板.xlsx（26 行，龙湖仓）');
  const whPrev = await (await fetch(base + '/api/workhours/import/preview?warehouse=龙湖仓', {
    method: 'POST', headers: { 'X-ERP-Token': login.token }, body: asForm(fileBuf('发货工时_恢复模板.xlsx'), '发货工时_恢复模板.xlsx'),
  })).json();
  ok('工时预览无错误行', Array.isArray(whPrev.errors) && whPrev.errors.length === 0,
    Array.isArray(whPrev.errors) ? whPrev.errors.slice(0, 3).map((e) => e.error).join(' | ') : JSON.stringify(whPrev).slice(0, 160));
  ok('工时预览可创建 26 行', whPrev.createCount === 26, `实际 ${whPrev.createCount}`);

  const decisions = {};
  (whPrev.data || []).forEach((r) => { decisions[r.line] = r.decision === 'skip' ? 'skip' : 'overwrite'; });
  const whImp = await (await fetch(base + '/api/workhours/import?warehouse=龙湖仓', {
    method: 'POST', headers: { 'X-ERP-Token': login.token },
    body: (() => { const fd = asForm(fileBuf('发货工时_恢复模板.xlsx'), '发货工时_恢复模板.xlsx'); fd.append('decisions', JSON.stringify(decisions)); return fd; })(),
  })).json();
  ok('工时导入落库成功', (whImp.created || whImp.success || 0) >= 26, `返回 ${JSON.stringify(whImp).slice(0, 160)}`);

  // ---------------------------------------------------------- 3. 物流报价
  console.log('\n[3] 导入 物流报价_恢复模板.xlsx（31 个区域）');
  const lqImp = await (await fetch(base + '/api/logistics-quotes/import', {
    method: 'POST', headers: { 'X-ERP-Token': login.token }, body: asForm(fileBuf('物流报价_恢复模板.xlsx'), '物流报价_恢复模板.xlsx'),
  })).json();
  ok('物流报价导入成功（created=31）', lqImp.created === 31, `返回 ${JSON.stringify(lqImp).slice(0, 160)}`);

  // ---------------------------------------------------------- 4. 复核
  console.log('\n[4] 导入后复核');
  const health1 = await (await fetch(base + '/api/health')).json();
  console.log('     counts = ' + JSON.stringify(health1.counts));
  ok('客户 102', health1.counts.customers === 102, `实际 ${health1.counts.customers}`);
  ok('工时 26', health1.counts.work_hours === 26, `实际 ${health1.counts.work_hours}`);
  ok('物流报价 31', health1.counts.logistics_quotes === 31, `实际 ${health1.counts.logistics_quotes}`);

  const wl = await (await fetch(base + '/api/workhours?warehouse=龙湖仓&work_type=发货&status=all&page=1&pageSize=1', { headers: H })).json();
  const wt = wl.total != null ? wl.total : (wl.data && wl.data.total);
  ok('工时列表可查（龙湖仓·发货·全部状态）', wt === 26, `实际 ${wt}`);

  const wlPending = await (await fetch(base + '/api/workhours?warehouse=龙湖仓&work_type=发货&page=1&pageSize=1', { headers: H })).json();
  ok('发货待填视图可渲染（货主驱动）', Array.isArray(wlPending.data) && wlPending.data.length > 0,
    `缺口清单 ${Array.isArray(wlPending.data) ? wlPending.data.length : 'N/A'} 行`);

  // 幂等：再导一次不应产生重复
  console.log('\n[5] 幂等性复验（重复导入同一批模板）');
  const custAgain = await (await fetch(base + '/api/customers/import', {
    method: 'POST', headers: { 'X-ERP-Token': login.token }, body: asForm(fileBuf('客户资料_恢复模板.xlsx'), '客户资料_恢复模板.xlsx'),
  })).json();
  const health2 = await (await fetch(base + '/api/health')).json();
  ok('重复导入客户不新增记录', health2.counts.customers === 102, `实际 ${health2.counts.customers}`);
  ok('重复导入客户无失败', (custAgain.failed || 0) === 0, `failed=${custAgain.failed}`);

  server.close();
  try { fs.unlinkSync(TMP); } catch (e) {}
  for (const f of [TMP + '-journal', TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }

  console.log('\n────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exit(1);
  console.log('✅ 恢复演练成功：4 个模板可通过线上「导入」按钮完整还原数据');
})().catch((e) => {
  console.error('演练异常：', e && e.message, e && e.stack);
  try { fs.unlinkSync(TMP); } catch (e2) {}
  process.exit(1);
});
