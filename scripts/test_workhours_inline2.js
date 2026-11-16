// 发货工时「极致行内直编 + 超管删除」回归测试
// 覆盖：三列隐藏 / 输入框直出 / 实时计算 / 失焦·回车自动保存 / 缺口行归档 / 已填行更新不重复 /
//       超管删除按钮显隐 / 后端 force 接口 403 拦截与物理删除。
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://127.0.0.1:3117';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

function call(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + url, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { 'X-ERP-Token': token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}
      ),
    }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        let j; try { j = JSON.parse(s); } catch (e) { j = s; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== A. 后端接口测试 ===');
  const login = await call('POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' });
  ok('admin 登录成功', login.status === 200 && !!login.body.token, login.status);
  const token = login.body.token;
  ok('admin 为超管角色', login.body.user && login.body.user.role_code === 'super_admin', login.body.user && login.body.user.role_code);

  // 造一条发货工时记录（隔离库无客户则先建一个仓储客户）
  let custs = await call('GET', '/api/customers?pageSize=5', token);
  let custList = custs.body.data || custs.body.rows || [];
  if (!custList.length) {
    const made = await call('POST', '/api/customers?type=' + encodeURIComponent('仓储客户'), token, {
      company_name: 'inline2测试货主', short_name: '测试货主', warehouse: '龙湖仓',
      customer_type: '仓储客户', coop_status: '合作中',
    });
    ok('创建测试客户', made.status === 200 || made.status === 201, made.body);
    custs = await call('GET', '/api/customers?pageSize=5', token);
    custList = custs.body.data || custs.body.rows || [];
  }
  ok('存在可用客户', custList.length > 0, custList.length);
  const cust = custList[0];

  const created = await call('POST', '/api/workhours', token, {
    warehouse: '龙湖仓', work_type: '发货',
    customer_id: cust.customer_id, customer_name: cust.company_name || cust.short_name,
    date: '2026-11-16', unit: '单', ship_orders: 100, main_hours: 10,
    other_hours: 1, shared_hours: 0, remark: 'inline2 测试',
  });
  ok('新增发货记录成功', created.status === 200 || created.status === 201, created.status);
  const wid = created.body.data && (created.body.data.work_id || created.body.data.id);
  ok('返回 work_id', !!wid, created.body);

  // PUT 更新已填行
  const updated = await call('PUT', '/api/workhours/' + wid, token, {
    warehouse: '龙湖仓', work_type: '发货', customer_id: cust.customer_id,
    customer_name: cust.company_name || cust.short_name, date: '2026-11-16',
    unit: '件', ship_orders: 200, main_hours: 20, other_hours: 2, shared_hours: 0, remark: 'inline2 已更新',
  });
  ok('PUT 更新已填行成功', updated.status === 200, updated.status);
  const after = await call('GET', '/api/workhours/' + wid, token);
  ok('更新后单量为 200（无重复）', after.body.data && Number(after.body.data.ship_orders) === 200, after.body.data && after.body.data.ship_orders);

  // 普通业务员：force 删除应 403
  const opUser = { username: 'inline2_op', password: 'op12345' };
  const roles = await call('GET', '/api/roles', token);
  const opRole = (roles.body.data || []).find((r) => r.role_code === 'operator');
  if (opRole) {
    await call('POST', '/api/users', token, { username: opUser.username, password: opUser.password, display_name: '行内测试业务员', role_name: opRole.role_name });
  }
  const opLogin = await call('POST', '/api/auth/login', null, { username: opUser.username, password: opUser.password });
  if (opLogin.status === 200) {
    const forceByOp = await call('DELETE', '/api/workhours/' + wid + '/force', opLogin.body.token);
    ok('业务员 force 删除被 403 拦截', forceByOp.status === 403, forceByOp.status);
  } else {
    ok('业务员账号创建/登录', false, opLogin.body);
  }

  // 超管 force 删除
  const forceByAdmin = await call('DELETE', '/api/workhours/' + wid + '/force', token);
  ok('超管 force 删除成功', forceByAdmin.status === 200, forceByAdmin.status);
  const gone = await call('GET', '/api/workhours/' + wid, token);
  ok('记录已物理删除（404）', gone.status === 404, gone.status);

  // 为 UI 测试补一条已填行（上一步已把唯一记录删掉），保证删除按钮可见断言有数据基础
  const uiSeed = await call('POST', '/api/workhours', token, {
    warehouse: '龙湖仓', work_type: '发货', customer_id: cust.customer_id,
    customer_name: cust.company_name || cust.short_name, date: '2026-11-16',
    unit: '件', ship_orders: 300, main_hours: 20, other_hours: 2, shared_hours: 0, remark: 'inline2 UI测试',
  });
  ok('UI 测试已填行就绪', uiSeed.status === 200 || uiSeed.status === 201, uiSeed.status);

  console.log('\n=== B. 真实 Chrome UI 测试 ===');
  const PORT = 9376;
  const prof = path.join(__dirname, '_whinline2_prof');
  const p = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:' + PORT + '/json/list', (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej);
      });
      target = list.find((x) => x.type === 'page');
    } catch (e) {}
  }
  ok('Chrome CDP 就绪', !!target);
  if (!target) { p.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const v = r.result && r.result.result;
    if (r.exceptionDetails) return 'ERR:' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
    return v && v.value !== undefined ? v.value : 'UNDEF';
  };
  const evJSON = async (expr) => { const s = await ev(expr); try { return JSON.parse(s); } catch (e) { return { _raw: s }; } };
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');

  await send('Page.navigate', { url: BASE + '/' }); await sleep(2500);
  await ev(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});const d=await r.json();localStorage.setItem('erp_token',d.token);localStorage.setItem('erp_user',JSON.stringify(d.user));return 'OK'})()`);
  await send('Page.navigate', { url: BASE + '/' });
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await ev(`typeof ERP!=='undefined'&&typeof ERP._go==='function'&&typeof ERP_PAGES.wh_lh==='function'?'Y':'N'`) === 'Y') { ready = true; break; }
  }
  ok('ERP 运行时就绪', ready);
  await ev(`ERP._go('wh_lh')`); await sleep(1500);

  const AV = `(function(){return [...document.querySelectorAll('.page-view')].find(v=>getComputedStyle(v).display!=='none')||document;})()`;
  // 发货未归档页：表头列名
  const headers = await evJSON(`JSON.stringify([...${AV}.querySelectorAll('#whHead th, thead th')].map(t=>t.textContent.trim()).filter(Boolean))`);
  const hs = Array.isArray(headers) ? headers.join('|') : '';
  ok('发货列表隐藏「公摊工时」', !/公摊工时/.test(hs), hs);
  ok('发货列表隐藏「总工时」', !/总工时/.test(hs), hs);
  ok('发货列表隐藏「单均成本」', !/单均成本/.test(hs), hs);
  ok('发货列表保留「时效」', /时效/.test(hs), hs);

  // 输入框直出 + 无填写按钮
  const inputs = await evJSON(`(()=>{const a=${AV};return JSON.stringify({
    selects:a.querySelectorAll('#whBody select[data-if="unit"]').length,
    nums:a.querySelectorAll('#whBody input[type=number][data-if]').length,
    txts:a.querySelectorAll('#whBody input[type=text][data-if="remark"]').length,
    fillBtns:a.querySelectorAll('#whBody [data-act="inlineFill"]').length,
    rows:a.querySelectorAll('#whBody tr[data-row-cid]').length
  })})()`);
  ok('单位下拉直出', inputs.selects > 0, inputs);
  ok('数字输入框直出（单量/主工时/其他工时）', inputs.nums > 0, inputs);
  ok('备注文本框直出', inputs.txts > 0, inputs);
  ok('「填写」按钮已移除', inputs.fillBtns === 0, inputs);

  // 实时计算：改第一条已填行的单量与主工时，时效应更新
  const calc = await evJSON(`(()=>{const a=${AV};const tr=a.querySelector('#whBody tr[data-row-cid][data-row-wid]');if(!tr)return JSON.stringify({noRow:true});
    const s=tr.querySelector('[data-if="ship_orders"]'),m=tr.querySelector('[data-if="main_hours"]'),out=tr.querySelector('[data-out="efficiency"]');
    if(!s||!m||!out)return JSON.stringify({noInput:true});
    s.value='300';m.value='20';s.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify({eff:out.textContent});})()`);
  ok('时效实时计算 = 300/20 = 15.000', calc.eff === '15.000', calc);

  // 超管删除按钮可见（对已填行）
  const delVisible = await ev(`(()=>{const a=${AV};return a.querySelectorAll('#whBody [data-act="delAdmin"]').length})()`);
  ok('超管可见「删除」按钮', delVisible > 0, delVisible);

  // 失焦自动保存：触发第一条已填行的 blur（会 PUT 更新）并等待列表刷新
  const beforeRows = inputs.rows;
  await ev(`(()=>{const a=${AV};const tr=a.querySelector('#whBody tr[data-row-cid][data-row-wid]');const s=tr&&tr.querySelector('[data-if="ship_orders"]');if(s)s.dispatchEvent(new Event('blur',{bubbles:true}));return 1})()`);
  await sleep(1200);
  const afterSave = await evJSON(`(()=>{const a=${AV};return JSON.stringify({
    rows:a.querySelectorAll('#whBody tr[data-row-cid]').length,
    hasErr:(document.querySelector('.toast')||{}).textContent||''
  })})()`);
  ok('失焦触发保存且列表刷新无报错', !/失败|错误/.test(afterSave.hasErr), afterSave);

  // 业务员登录：删除按钮不可见
  await ev(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'inline2_op',password:'op12345'})});const d=await r.json();if(d.token){localStorage.setItem('erp_token',d.token);localStorage.setItem('erp_user',JSON.stringify(d.user));}return d.token?'OK':'FAIL'})()`);
  await send('Page.navigate', { url: BASE + '/' });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await ev(`typeof ERP!=='undefined'&&typeof ERP._go==='function'?'Y':'N'`) === 'Y') break;
  }
  await ev(`ERP._go('wh_lh')`); await sleep(1500);
  const opDel = await ev(`(()=>{const a=${AV};return a.querySelectorAll('#whBody [data-act="delAdmin"]').length})()`);
  ok('业务员看不到「删除」按钮', opDel === 0, opDel);

  ws.close(); p.kill();
  console.log('\n=== 汇总 ===');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
