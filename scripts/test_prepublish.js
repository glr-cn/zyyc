'use strict';
// ============================================================
//  发布前 6 项 E2E 验证（隔离库 + 独立端口，绝不触碰主库 data/erp.db）
//  用法：node scripts/test_prepublish.js
//  每项输出 PASS/FAIL + 具体证据；任一 FAIL 时进程退出码 = 1
// ============================================================
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'data', '__prepublish__');
const DB = path.join(TMP, 'erp.db');
const PORT = 3101;
const BASE = 'http://127.0.0.1:' + PORT;
const SECRET = 'prepublish-only-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })();

const results = [];
function record(n, name, ok, evidence) {
  results.push({ n, name, ok: !!ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${n} | ${name} | ${evidence}`);
}

async function req(method, url, opt = {}) {
  const o = { method, headers: {} };
  // 与线上前端一致：同时发自定义头，覆盖平台网关注入的 Authorization
  if (opt.token) {
    o.headers.Authorization = 'Bearer ' + opt.token;
    o.headers['X-ERP-Token'] = opt.token;
  }
  if (opt.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opt.body); }
  if (opt.form) o.body = opt.form;
  const r = await fetch(BASE + url, o);
  let data = {};
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

// ---------- 隔离库种子：4 个用户 / 2 个客户 / 2 条工时 / 1 个负库存货主 ----------
function prepareDb() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const d = new DatabaseSync(DB);
  d.exec('PRAGMA foreign_keys = ON;');
  d.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  const insRole = d.prepare('INSERT INTO roles (role_id, role_name) VALUES (?,?)');
  [[1, '管理员'], [2, '业务员'], [3, '查看者']].forEach(([i, n]) => insRole.run(i, n));

  const H = (p) => bcrypt.hashSync(p, 10);
  const insUser = d.prepare('INSERT INTO users (user_id,username,password_hash,display_name,role_id) VALUES (?,?,?,?,?)');
  insUser.run(1, 'admin', H('admin123'), '管理员', 1);
  insUser.run(2, 'salesA', H('pass123'), '业务员A', 2);
  insUser.run(3, 'salesB', H('pass123'), '业务员B', 2);
  insUser.run(4, 'viewer', H('pass123'), '查看者', 3);

  const insC = d.prepare(`INSERT INTO customers
    (customer_id,company_name,short_name,warehouse,customer_type,owner_user_id,coop_status,expiry_mgmt,product_count,prepaid_price)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insC.run(1, 'A的客户', 'A客户', '龙湖仓', '仓储客户', 2, '合作中', '否', 0, 0);
  insC.run(2, 'B的客户', 'B客户', '龙湖仓', '仓储客户', 3, '合作中', '否', 0, 0);

  // A：main 1.234 + other 0.567 + shared 0.111 = 1.912；ship 3 → unit_cost = 0.637
  const insW = d.prepare(`INSERT INTO work_hours
    (work_id,warehouse,work_type,customer_name,unit,date,ship_orders,main_hours,other_hours,shared_hours,total_hours,efficiency,unit_cost,owner_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insW.run(1, '龙湖仓', '发货', 'A的客户', '件', TODAY, 3, 1.234, 0.567, 0.111, 1.912, 2.431, 0.637, 2);
  insW.run(2, '龙湖仓', '发货', 'B的客户', '件', TODAY, 7, 2, 1, 0.5, 3.5, 3.5, 0.5, 3);

  const insT = d.prepare(`INSERT INTO inventory_transactions
    (owner_name,quantity,direction,reference_type,business_date,remark) VALUES (?,?,?,?,?,?)`);
  insT.run('测试负库存货主', 3, 'in', 'initial', TODAY, '期初');
  insT.run('测试负库存货主', 10, 'out', 'sale', TODAY, '超发制造负库存'); // balance = -7
  d.close();
}

async function startServer() {
  const srv = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), ERP_DB_PATH: DB, ERP_JWT_SECRET: SECRET,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  srv.stderr.on('data', (c) => { err += String(c); });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return srv; } catch (e) {}
    await sleep(150);
  }
  srv.kill();
  throw new Error('服务未就绪：' + err.slice(-600));
}

// ---------- 1. 未登录访问任意页面被拦截 ----------
async function v1() {
  const paths = [
    '/api/customers', '/api/orders', '/api/workhours?warehouse=龙湖仓&work_type=发货',
    '/api/inventory/ledger', '/api/analytics/summary', '/api/analytics/dashboard', '/api/users',
  ];
  const rs = [];
  for (const p of paths) rs.push(await req('GET', p));
  const all401 = rs.every((r) => r.status === 401);
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const apiJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');
  const frontGuard = /if\s*\(!token\)[\s\S]{0,140}location\.href\s*=\s*['"]login\.html['"]/.test(appJs);
  const apiGuard = /res\.status\s*===\s*401[\s\S]{0,220}location\.href\s*=\s*['"]login\.html['"]/.test(apiJs);
  const page = await fetch(BASE + '/app.html');
  record(1, '未登录访问任意页面被拦截', all401 && frontGuard && apiGuard,
    `7 个业务接口无 token 状态码 [${rs.map((r) => r.status).join(',')}] 全 401；app.js 无 token 跳登录=${frontGuard}；api.js 收到 401 跳登录=${apiGuard}；/app.html 静态壳 HTTP ${page.status}（仅为 HTML 外壳、不含数据，靠 JS 守卫跳转）`);
}

// ---------- 2. 业务员 A 看不到业务员 B 的客户和工时 ----------
async function v2(tA, tB) {
  const cA = (await req('GET', '/api/customers?customer_type=仓储客户', { token: tA })).data;
  const wA = (await req('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货', { token: tA })).data;
  const cB = (await req('GET', '/api/customers?customer_type=仓储客户', { token: tB })).data;
  const wB = (await req('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货', { token: tB })).data;
  const nA = (cA.data || []).map((x) => x.company_name);
  const hA = (wA.data || []).map((x) => x.customer_name);
  const nB = (cB.data || []).map((x) => x.company_name);
  const hB = (wB.data || []).map((x) => x.customer_name);
  const ok = cA.total === 1 && wA.total === 1
    && nA.includes('A的客户') && !nA.includes('B的客户')
    && hA.includes('A的客户') && !hA.includes('B的客户')
    && !nB.includes('A的客户') && !hB.includes('A的客户');
  record(2, '业务员A看不到业务员B的客户和工时', ok,
    `A可见 客户[${nA.join(',')}] 工时[${hA.join(',')}]；B可见 客户[${nB.join(',')}] 工时[${hB.join(',')}]；total A=${cA.total}/${wA.total} B=${cB.total}/${wB.total}`);
}

// ---------- 3. 查看者保存修改被拒绝 ----------
async function v3(tV) {
  const attempts = [
    ['POST', '/api/customers', { company_name: '越权新增', warehouse: '龙湖仓', customer_type: '仓储客户' }],
    ['PUT', '/api/workhours/1', { main_hours: 9 }],
    ['POST', '/api/orders/import', undefined],
    ['POST', '/api/inventory/import-initial', undefined],
    ['DELETE', '/api/users/2', undefined],
  ];
  const rs = [];
  for (const [m, u, b] of attempts) rs.push((await req(m, u, { token: tV, body: b })).status);
  const getStatus = (await req('GET', '/api/customers', { token: tV })).status;
  const ok = rs.every((s) => s === 403) && getStatus === 200;
  record(3, '查看者尝试保存修改被拒绝', ok,
    `5 个写操作状态码 [${rs.join(',')}] 全部 403（客户新增/工时编辑/订单导入/期初导入/删除用户）；GET /api/customers=${getStatus} 仍允许只读`);
}

// ---------- 4. 客户名不存在的订单进失败清单且未写订单表 ----------
async function v4(tAdmin) {
  const before = (await req('GET', '/api/orders', { token: tAdmin })).data.total;
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['订单号', '客户名称', '货主名称', '发货量', '单位', '订单日期'],
    ['ORD-PRE-1', '不存在的客户XYZ', '不存在的客户XYZ', 5, '件', TODAY],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'orders.xlsx');
  const r = await req('POST', '/api/orders/import', { token: tAdmin, form });
  const d = r.data;
  const after = (await req('GET', '/api/orders', { token: tAdmin })).data.total;
  const db2 = new DatabaseSync(DB);
  const cnt = db2.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const txCnt = db2.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c;
  db2.close();
  const f = (d.failures || [])[0] || {};
  const ok = r.status === 200 && d.success === 0 && d.failed === 1
    && /客户名称不存在/.test(f.reason || '') && before === after && cnt === 0 && txCnt === 2;
  record(4, '客户名不存在的订单进失败清单且未写入订单表', ok,
    `导入返回 HTTP ${r.status} success=${d.success} failed=${d.failed} row=${f.row} reason="${f.reason}"；orders 总数 ${before}→${after}（DB 实查 ${cnt} 行）；inventory_transactions=${txCnt}（仅预置 2 条，无新增 sale 流水）`);
}

// ---------- 5. 负库存台账标红提示（接口 + 前端真实渲染 + CSS） ----------
async function renderInventoryWithMock() {
  const ids = new Map();
  function mkEl() {
    return {
      _html: '', value: '', textContent: '', style: {}, dataset: {},
      onclick: null, onkeydown: null,
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v);
        const re = /id="([^"]+)"/g;
        let m;
        while ((m = re.exec(this._html))) if (!ids.has(m[1])) ids.set(m[1], mkEl());
      },
      querySelector(sel) { return ids.get(String(sel).replace(/^#/, '')) || null; },
      querySelectorAll() { return []; },
      appendChild() {}, addEventListener() {}, removeEventListener() {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
  }
  const host = mkEl();
  const mock = {
    '/inventory/warnings': { data: [{ owner_name: '测试负库存货主', balance: -7, safety_stock: 0, deficit: 7, is_negative: true }], count: 1 },
    '/inventory/ledger': { data: [{ owner_name: '测试负库存货主', opening: 3, total_in: 0, total_out: 10, balance: -7, safety_stock: 0, is_negative: true, below_safety: true }] },
  };
  const mockAPI = {
    get(u) {
      const k = Object.keys(mock).find((x) => u.indexOf(x) === 0);
      return Promise.resolve(mock[k] || { data: [], count: 0 });
    },
  };
  const win = { ERP_PAGES: {} };
  const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'inventory.js'), 'utf8');
  new Function('window', 'API', 'console', code)(win, mockAPI, console);
  win.ERP_PAGES.inventory(host);
  await sleep(0);
  await sleep(0);
  const body = ids.get('ledgerBody');
  const warn = ids.get('warnBox');
  const html = body ? body._html : '';
  return {
    hasNeg: /class="num neg"/.test(html),
    hasBadge: /负库存/.test(html),
    hasWarn: /负库存/.test(warn ? warn._html : ''),
  };
}

async function v5(tAdmin) {
  const led = await req('GET', '/api/inventory/ledger?owner=' + encodeURIComponent('测试负库存货主'), { token: tAdmin });
  const row = (led.data.data || []).find((x) => x.owner_name === '测试负库存货主');
  const wr = await req('GET', '/api/inventory/warnings', { token: tAdmin });
  const w = (wr.data.data || []).find((x) => x.owner_name === '测试负库存货主');
  const fe = await renderInventoryWithMock();
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const cssOk = /\.num\.neg\s*\{[^}]*color:\s*var\(--danger\)/.test(css);
  const ok = !!(row && row.balance === -7 && row.is_negative === true && row.below_safety === true)
    && !!(w && w.is_negative === true) && fe.hasNeg && fe.hasBadge && fe.hasWarn && cssOk;
  record(5, '负库存场景库存台账标红提示', ok,
    `ledger balance=${row && row.balance} is_negative=${row && row.is_negative} below_safety=${row && row.below_safety}；warnings count=${wr.data.count} 命中=${!!w}；前端真实渲染 class="num neg"=${fe.hasNeg} 负库存徽标=${fe.hasBadge} 预警条=${fe.hasWarn}；CSS .num.neg→--danger=${cssOk}`);
}

// ---------- 6. 单均成本列表/汇总均 3 位小数且一致 ----------
function is3(v) {
  if (typeof v !== 'number' || !isFinite(v)) return false;
  if (Math.round(v * 1000) / 1000 !== v) return false;
  const p = String(v).split('.')[1];
  return !p || p.length <= 3;
}
async function v6(tA) {
  const list = (await req('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货', { token: tA })).data;
  const row = (list.data || []).find((x) => x.work_id === 1);
  const sum = (await req('GET', '/api/analytics/summary?mode=day&warehouse=龙湖仓&work_type=发货', { token: tA })).data;
  const trow = (sum.table || []).find((x) => x.customer_name === 'A的客户');
  const period = (sum.periods || [])[0];
  const dash = (await req('GET', '/api/analytics/dashboard', { token: tA })).data;
  const vals = [row && row.unit_cost, trow && trow.unit_cost, period && period.unit_cost_overall, dash && dash.avg_unit_cost];
  const all3 = vals.every(is3);
  const same = new Set(vals.map((v) => Number(v).toFixed(3))).size === 1;
  const ok = all3 && same && vals[0] === 0.637;
  record(6, '单均成本在列表和汇总中均为3位小数且一致', ok,
    `列表=${vals[0]} / 汇总明细=${vals[1]} / 周期整体=${vals[2]} / 看板均值=${vals[3]}；全部 3 位小数=${all3}；四者一致=${same}（1.912÷3=0.637333→0.637）`);
}

(async () => {
  let srv = null;
  try {
    prepareDb();
    srv = await startServer();
    const login = async (u, p) => (await req('POST', '/api/auth/login', { body: { username: u, password: p } })).data.token;
    const tAdmin = await login('admin', 'admin123');
    const tA = await login('salesA', 'pass123');
    const tB = await login('salesB', 'pass123');
    const tV = await login('viewer', 'pass123');
    console.log('===== 发布前验证（隔离库 ' + DB + ' / 端口 ' + PORT + '）=====');
    await v1();
    await v2(tA, tB);
    await v3(tV);
    await v4(tAdmin);
    await v5(tAdmin);
    await v6(tA);
  } catch (e) {
    console.error('ERROR:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    if (srv) srv.kill();
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  }
  const failed = results.filter((r) => !r.ok);
  console.log('===== 汇总 =====');
  console.log(`通过 ${results.length - failed.length}/${results.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((r) => `${r.n}. ${r.name}`).join('；'));
    process.exitCode = 1;
  }
})();
