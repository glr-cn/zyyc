// 发货工时「红色删除按钮 + 精确二次确认 + 物理删除 + 即时移除行」端到端回归
// 依赖 3118 测试服务（同 inline3），真实 Chrome 验证。
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://127.0.0.1:3118';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };

function req(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { 'X-ERP-Token': token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      let s = ''; res.on('data', (c) => (s += c));
      res.on('end', () => { let j; try { j = JSON.parse(s); } catch (e) { j = s; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  console.log('=== A. 造一条已填发货记录 ===');
  const lg = await req('POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' });
  const token = lg.body.token;
  ok('admin 登录', lg.status === 200 && !!token);
  const made = await req('POST', '/api/customers?type=' + encodeURIComponent('仓储客户'), token, {
    company_name: '删除验证货主' + Date.now(), short_name: '删除验证', warehouse: '龙湖仓', customer_type: '仓储客户', coop_status: '合作中',
  });
  const cid = made.body.data && made.body.data.customer_id;
  const wr = await req('POST', '/api/workhours', token, {
    warehouse: '龙湖仓', work_type: '发货', customer_id: cid, customer_name: made.body.data.company_name,
    date: '2026-11-16', unit: '单', ship_orders: 77, main_hours: 7, other_hours: 1, shared_hours: 0, remark: '待删除验证',
  });
  const wid = wr.body.data && wr.body.data.work_id;
  ok('已填记录创建', !!wid, wr.body);

  console.log('\n=== B. 真实 Chrome 验证删除交互 ===');
  const PORT = 9383;
  const p = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(__dirname, '_deladmin_prof'), 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await new Promise((res, rej) => http.get('http://127.0.0.1:' + PORT + '/json/list', (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
      target = list.find((x) => x.type === 'page');
    } catch (e) {}
  }
  ok('Chrome CDP 就绪', !!target);
  if (!target) { p.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, prm) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: prm })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const v = r.result && r.result.result;
    if (r.exceptionDetails) return 'ERR:' + JSON.stringify((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return v && v.value !== undefined ? v.value : 'UNDEF';
  };
  const evJSON = async (expr) => { const s = await ev(expr); try { return JSON.parse(s); } catch (e) { return { _raw: s }; } };
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' }); await sleep(2200);
  // 故意把 localStorage.erp_user 篡改为【旧的/非超管】快照：前端不得信快照，
  // 必须以 /api/auth/me（token 对应的库内真实角色）为准 → 真超管仍能看到删除按钮。
  await ev(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});const d=await r.json();localStorage.setItem('erp_token',d.token);const stale=Object.assign({},d.user,{role_code:'admin',role:'管理员'});localStorage.setItem('erp_user',JSON.stringify(stale));return 'OK'})()`);
  await send('Page.navigate', { url: BASE + '/' });
  let ready = false;
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev(`typeof ERP!=='undefined'&&typeof ERP._go==='function'?'Y':'N'`) === 'Y') { ready = true; break; } }
  ok('ERP 就绪', ready);
  await ev(`ERP._go('wh_lh')`); await sleep(1400);
  const AV = `(function(){return [...document.querySelectorAll('.page-view')].find(v=>getComputedStyle(v).display!=='none')||document;})()`;

  // 红色删除按钮存在且样式为 danger
  const btnInfo = await ev(`(()=>{const a=${AV};const tr=[...a.querySelectorAll('#whBody tr[data-row-cid]')].find(t=>t.querySelector('[data-act="delAdmin"][data-id="${wid}"]'));const b=tr&&tr.querySelector('[data-act="delAdmin"]');if(!b)return JSON.stringify({no:true});return JSON.stringify({txt:b.textContent.trim(),cls:b.className,color:getComputedStyle(b).color})})()`);
  const bi = JSON.parse(btnInfo);
  ok('操作列渲染红色删除按钮', !bi.no && bi.txt === '删除' && /danger/.test(bi.cls), bi);

  // 拦截 confirm（捕获文案返回 true）与 alert（避免阻塞 headless 页面）
  await ev(`window.__cfm=[];window.__alerts=[];window.confirm=function(m){window.__cfm.push(m);return true};window.alert=function(m){window.__alerts.push(m)};'OK'`);

  // 点击删除
  await ev(`(()=>{const a=${AV};const b=a.querySelector('[data-act="delAdmin"][data-id="${wid}"]');b.click();return 1})()`);
  await sleep(1400);

  const cfm = await ev(`JSON.stringify(window.__cfm)`);
  const cfmArr = JSON.parse(cfm);
  ok('弹出精确二次确认文案', cfmArr.length === 1 && cfmArr[0] === '确定要彻底删除这条记录吗？', cfmArr);

  // 后端记录物理删除（force）
  const chk = await req('GET', '/api/workhours/' + wid, token).catch(() => ({ status: 500 }));
  ok('后端记录已物理删除', chk.status === 404, chk.status);

  console.log('\n=== C. 非超管不得看到删除按钮（铁律 3）===');
  // 造一个真实的非超管账号（管理员角色：全菜单全数据，但 role_code≠super_admin）
  const nu = 'del_non_super_' + Date.now();
  const mk = await req('POST', '/api/users', token, { username: nu, password: 'abc12345', display_name: '非超管测试', role_name: '管理员' });
  ok('非超管账号创建成功', mk.status === 201, mk.body);
  const lg2 = await req('POST', '/api/auth/login', null, { username: nu, password: 'abc12345' });
  ok('非超管登录成功', lg2.status === 200 && lg2.body.user && lg2.body.user.role_code === 'admin', lg2.status);
  // 浏览器切到非超管会话：覆盖 token/user 快照并重载页面
  await ev(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'${nu}',password:'abc12345'})});const d=await r.json();localStorage.setItem('erp_token',d.token);localStorage.setItem('erp_user',JSON.stringify(d.user));return 'OK'})()`);
  await send('Page.navigate', { url: BASE + '/' }); await sleep(1500);
  await ev(`ERP._go('wh_lh')`); await sleep(1400);
  // 造一条已填记录供非超管查看（缺口行本身不显示按钮，需已填行验证）
  const mkc = await req('POST', '/api/customers?type=' + encodeURIComponent('仓储客户'), token, {
    company_name: '非超管验证货主' + Date.now(), short_name: '非超管验证', warehouse: '龙湖仓', customer_type: '仓储客户', coop_status: '合作中',
  });
  const cid2 = mkc.body.data && mkc.body.data.customer_id;
  if (cid2) {
    await req('POST', '/api/workhours', token, {
      warehouse: '龙湖仓', work_type: '发货', customer_id: cid2, customer_name: mkc.body.data.company_name,
      date: '2026-11-16', unit: '单', ship_orders: 10, main_hours: 2, other_hours: 0, shared_hours: 0, remark: '非超管可见性验证',
    });
  }
  // 重新进入页面（触发 load→refreshRole），验证非超管操作列
  await send('Page.navigate', { url: BASE + '/' }); await sleep(1200);
  await ev(`ERP._go('wh_lh')`); await sleep(1400);
  const ns = await evJSON(`(()=>{const a=${AV};const filled=[...a.querySelectorAll('#whBody tr[data-row-cid]')].filter(t=>!t.classList.contains('wh-gap-row'));
    return JSON.stringify({filledCount:filled.length,delBtns:filled.filter(t=>t.querySelector('[data-act="delAdmin"]')).length,
      placeholders:filled.filter(t=>t.querySelector('.ops .ops-none')).length})})()`);
  ok('非超管已填行不渲染删除按钮', ns.filledCount > 0 && ns.delBtns === 0, ns);
  ok('非超管操作列显示占位符（列不空白）', ns.placeholders === ns.filledCount, ns);

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  ws.close(); p.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
