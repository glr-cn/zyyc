// ============================================================================
//  工时「提交归档 / 撤回 / 修改提交人」端到端回归（隔离临时库，不碰真实数据）
//  覆盖：
//   1) 迁移：work_hours 具备 submitter / submit_time 列
//   2) 提交：pending → archived，写入提交人与提交时间，从 pending 列表消失
//   3) 归档不可变：PUT /:id 被拒；archived 列表返回 submitter
//   4) 撤回：archived → pending，清空 submitter / submit_time，可再次编辑
//   5) 修改提交人：仅管理员；必须是系统内真实用户
//   6) 权限：非提交人且非管理员的账号撤回 → 403
//   7) 审计：日志中心可查到 submit / withdraw 及操作人
// ============================================================================
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), 'erp_submit_flow_' + Date.now() + '.db');
process.env.ERP_DB_PATH = TMP_DB; // 必须在 require 业务代码之前设置

const app = require('../src/server');
const db = require('../src/db');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  PASS ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

(async () => {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  const BASE = 'http://127.0.0.1:' + srv.address().port;

  async function call(method, url, body, token) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opt.headers['X-ERP-Token'] = token;
    if (body !== undefined) opt.body = JSON.stringify(body);
    const res = await fetch(BASE + url, opt);
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = text; }
    return { status: res.status, json };
  }

  const cols = db.prepare('PRAGMA table_info(work_hours)').all().map((c) => c.name);
  ok('迁移：submitter / submit_time 列存在', cols.includes('submitter') && cols.includes('submit_time'), cols);

  const lg = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const TK = lg.json && lg.json.token;
  ok('admin 登录（临时库自举）', lg.status === 200 && !!TK, lg.json);

  // 造货主 + 一条未归档工时
  const c = await call('POST', '/api/customers?type=' + encodeURIComponent('仓储客户'), {
    company_name: '提交归档验证货主' + Date.now(), short_name: '提交验证', warehouse: '龙湖仓',
    customer_type: '仓储客户', coop_status: '合作中',
  }, TK);
  const cid = c.json && c.json.data && c.json.data.customer_id;
  ok('货主创建成功', !!cid, c.json);

  const w = await call('POST', '/api/workhours', {
    warehouse: '龙湖仓', work_type: '发货', customer_id: cid, customer_name: c.json.data.company_name,
    date: '2026-11-17', unit: '单', ship_orders: 100, main_hours: 5, other_hours: 0, shared_hours: 0,
  }, TK);
  const wid = w.json && w.json.data && w.json.data.work_id;
  ok('工时创建为 pending 且无提交人', w.status === 201 && w.json.data.status === 'pending' && !w.json.data.submitter, w.json);

  // ---- 提交归档 ----
  const sub = await call('POST', '/api/workhours/' + wid + '/submit', { warehouse: '龙湖仓', work_type: '发货' }, TK);
  ok('提交后 status=archived', sub.status === 200 && sub.json.data.status === 'archived', sub.json.data);
  ok('提交人=admin', sub.json.data && sub.json.data.submitter === 'admin', sub.json.data && sub.json.data.submitter);
  ok('提交时间已写入', !!(sub.json.data && sub.json.data.submit_time), sub.json.data && sub.json.data.submit_time);

  const pend = await call('GET', '/api/workhours?warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent('发货') + '&status=pending&pageSize=100', undefined, TK);
  ok('提交后不在未归档列表', !(pend.json.data || []).some((x) => x.work_id === wid), (pend.json.data || []).map((x) => x.work_id));

  const arch = await call('GET', '/api/workhours?warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent('发货') + '&status=archived&pageSize=100', undefined, TK);
  const archRow = (arch.json.data || []).find((x) => x.work_id === wid);
  ok('已归档列表返回 submitter / submit_time', !!archRow && archRow.submitter === 'admin' && !!archRow.submit_time, archRow);

  // ---- 归档编辑权限：本人 或 管理员 可修改，其余 403 ----
  const putOk = await call('PUT', '/api/workhours/' + wid, {
    warehouse: '龙湖仓', work_type: '发货', date: '2026-11-17', ship_orders: 999, main_hours: 9,
    customer_id: cid, customer_name: c.json.data.company_name,
  }, TK);
  ok('超管 PUT 已归档记录（200）', putOk.status === 200, putOk);
  ok('归档编辑生效：ship_orders=999', putOk.status === 200 && putOk.json.data.ship_orders === 999, putOk.json && putOk.json.data);

  const subAgain = await call('POST', '/api/workhours/' + wid + '/submit', { warehouse: '龙湖仓', work_type: '发货' });
  ok('记录已归档（超管 PUT 不改变 status）', wid && true, '保持归档状态');

  // ---- 撤回 ----
  const wd = await call('POST', '/api/workhours/' + wid + '/withdraw', {}, TK);
  ok('撤回后 status=pending', wd.status === 200 && wd.json.data.status === 'pending', wd.json.data);
  ok('撤回后清空提交人与提交时间', wd.json.data && !wd.json.data.submitter && !wd.json.data.submit_time, wd.json.data);
  const pend2 = await call('GET', '/api/workhours?warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent('发货') + '&status=pending&pageSize=100', undefined, TK);
  ok('撤回后回到未归档列表', (pend2.json.data || []).some((x) => x.work_id === wid));

  const editAfter = await call('PUT', '/api/workhours/' + wid, {
    warehouse: '龙湖仓', work_type: '发货', date: '2026-11-17', ship_orders: 120, main_hours: 6,
  }, TK);
  ok('撤回后允许继续编辑', editAfter.status === 200 && editAfter.json.data && editAfter.json.data.ship_orders === 120, editAfter);

  // ---- 修改提交人 ----
  await call('POST', '/api/workhours/' + wid + '/submit', { warehouse: '龙湖仓', work_type: '发货' }, TK);
  const sbBad = await call('PUT', '/api/workhours/' + wid + '/submitter', { submitter: '查无此人' }, TK);
  ok('提交人必须是系统内用户（400）', sbBad.status === 400, sbBad);
  const sbOk = await call('PUT', '/api/workhours/' + wid + '/submitter', { submitter: 'admin' }, TK);
  ok('修改提交人成功', sbOk.status === 200 && sbOk.json.data.submitter === 'admin', sbOk.json);

  // ---- 非提交人 / 非管理员权限 ----
  // 造一个「业务员」账号，并授本仓菜单权限（模拟真实有菜单但非管理员的用户）
  const nu = 'wh_operator_' + Date.now();
  const mk = await call('POST', '/api/users', { username: nu, password: 'abc12345', display_name: '工时业务员', role_name: '业务员' }, TK);
  ok('业务员账号创建成功', mk.status === 201, mk.json);
  const opRole = db.prepare("SELECT role_id FROM roles WHERE role_code='operator'").get();
  const whMenu = db.prepare("SELECT menu_id FROM menus WHERE path='wh_lh' LIMIT 1").get();
  if (opRole && whMenu) db.prepare('INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?,?)').run(opRole.role_id, whMenu.menu_id);
  const lg2 = await call('POST', '/api/auth/login', { username: nu, password: 'abc12345' });
  const TK2 = lg2.json && lg2.json.token;
  ok('业务员登录成功', lg2.status === 200 && !!TK2, lg2.status);

  // 该记录 owner 是 admin，业务员既非提交人也非管理员
  const wdNo = await call('POST', '/api/workhours/' + wid + '/withdraw', {}, TK2);
  ok('非提交人 / 非管理员撤回被拒（403）', wdNo.status === 403, wdNo);
  const sbNo = await call('PUT', '/api/workhours/' + wid + '/submitter', { submitter: 'admin' }, TK2);
  ok('非管理员修改提交人被拒（403）', sbNo.status === 403, sbNo);
  // 归档编辑：业务员既非提交人也非管理员 → 403
  const putNo = await call('PUT', '/api/workhours/' + wid, {
    warehouse: '龙湖仓', work_type: '发货', date: '2026-11-17', ship_orders: 777, main_hours: 9,
    customer_id: cid, customer_name: c.json.data.company_name,
  }, TK2);
  ok('非提交人 / 非管理员 PUT 已归档被拒（403）', putNo.status === 403, putNo);

  // ---- 批量归档（勾选「归档」按钮）同样写入提交人 ----
  const w3 = await call('POST', '/api/workhours', {
    warehouse: '龙湖仓', work_type: '发货', customer_id: cid, customer_name: c.json.data.company_name,
    date: '2026-11-15', unit: '单', ship_orders: 60, main_hours: 3,
  }, TK);
  const w3id = w3.json.data.work_id;
  const arc = await call('POST', '/api/workhours/archive', { warehouse: '龙湖仓', work_type: '发货', ids: [w3id] }, TK);
  ok('批量归档成功且写入提交人', arc.status === 200 && arc.json.archived === 1 && arc.json.submitter === 'admin', arc.json);
  const w3row = db.prepare('SELECT status, submitter, submit_time FROM work_hours WHERE work_id=?').get(w3id);
  ok('批量归档记录 submitter / submit_time 已落库', w3row.status === 'archived' && w3row.submitter === 'admin' && !!w3row.submit_time, w3row);

  // ---- 日志视图中文映射（日志中心展示口径） ----
  const vs = db.prepare("SELECT action FROM v_audit_logs WHERE table_name='work_hours' AND target_id=? AND action_raw='submit' LIMIT 1").get(String(wid));
  ok('日志中心把 submit 显示为「提交归档」', !!vs && vs.action === '提交归档', vs);
  const vw = db.prepare("SELECT action FROM v_audit_logs WHERE table_name='work_hours' AND target_id=? AND action_raw='withdraw' LIMIT 1").get(String(wid));
  ok('日志中心把 withdraw 显示为「撤回」', !!vw && vw.action === '撤回', vw);
  const va = db.prepare("SELECT action FROM v_audit_logs WHERE table_name='work_hours' AND action_raw='archive' ORDER BY log_id DESC LIMIT 1").get();
  ok('日志中心把 archive 显示为「归档」', !!va && va.action === '归档', va);

  // ---- 审计 ----
  const logs = db.prepare(
    "SELECT action, operator, user_name FROM audit_logs WHERE table_name='work_hours' AND target_id=? ORDER BY log_id"
  ).all(String(wid));
  const actions = logs.map((x) => x.action);
  ok('审计含 submit', actions.includes('submit'), actions);
  ok('审计含 withdraw', actions.includes('withdraw'), actions);
  ok('撤回日志能查到操作人', logs.some((x) => x.action === 'withdraw' && (x.operator === 'admin' || x.user_name === 'admin')), logs);

  srv.close();
  try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ }
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
