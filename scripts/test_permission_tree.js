// 权限树崩溃修复回归测试（真实 Chrome CDP）
// 覆盖：① 全部角色点击分配权限不崩溃 ② 树节点渲染/勾选态正确
//       ③ null/undefined/对象 数据兜底 ④ 三态联动（半选/全选/清空）
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3116';
const PORT = 9372;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail) : '')); }
}

(async () => {
  const p = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu',
    `--user-data-dir=${path.join(__dirname, '_perm_prof')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 40 && !t; i++) { await sleep(500); try { t = (await j(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.type === 'page'); } catch (e) {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const v = r.result && r.result.result;
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return v && v.value !== undefined ? v.value : 'UNDEF';
  };
  const evJSON = async (expression) => { const s = await ev(expression); try { return JSON.parse(s); } catch (e) { return s; } };
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__roleErrs=[];window.addEventListener('error',e=>window.__roleErrs.push(e.message));window.addEventListener('unhandledrejection',e=>window.__roleErrs.push('reject:'+e.reason));`,
  });

  await send('Page.navigate', { url: BASE + '/' }); await sleep(2500);
  await ev(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});const d=await r.json();if(d.token){localStorage.setItem('erp_token',d.token);localStorage.setItem('erp_user',JSON.stringify(d.user));return 'OK'}return 'FAIL'})()`);
  await send('Page.navigate', { url: BASE + '/' });
  // 轮询等待 ERP 与 roles 页面模块就绪（CDN 可能拖慢脚本加载）
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await ev(`typeof ERP!=='undefined' && typeof ERP._go==='function' && typeof ERP_PAGES.roles==='function' ? 'READY':'WAIT'`);
    if (st === 'READY') { ready = true; break; }
  }
  ok('ERP 运行时就绪', ready, ready);
  await ev(`ERP._go('roles')`); await sleep(1500);

  const AV = `(function(){return [...document.querySelectorAll('.page-view')].find(v=>getComputedStyle(v).display!=='none')||document;})()`;

  console.log('\n【1】角色列表渲染');
  const roleCount = await ev(`(()=>{const a=${AV};return a.querySelectorAll('#roleBody tr').length})()`);
  ok('角色列表 4 行', roleCount === 4, roleCount);

  console.log('\n【2】全部角色点击「分配权限」不崩溃');
  const roleBtns = await ev(`(()=>{const a=${AV};return JSON.stringify([...a.querySelectorAll('#roleBody button[id^="perm_"]')].map(b=>({id:b.id,role:b.id.replace('perm_','')})))})()`);
  const btns = JSON.parse(roleBtns);
  ok('找到 4 个分配权限按钮', btns.length === 4, btns);
  for (const b of btns) {
    await ev(`(()=>{const a=${AV};a.querySelector('#${b.id}').click();return 1})()`);
    await sleep(500);
    const res = await evJSON(`(()=>{const a=${AV};return JSON.stringify({
      err:a.querySelector('#permErr').textContent,
      roots:a.querySelectorAll('#permTree .ptree-root').length,
      rows:a.querySelectorAll('#permTree .ptree-row').length,
      checked:a.querySelectorAll('#permTree input[type=checkbox]:checked').length,
      jsErrs:window.__roleErrs.length
    })})()`);
    ok('角色 ' + b.role + ' 无错误提示', !res.err, res);
    ok('角色 ' + b.role + ' 无 JS 异常', res.jsErrs === 0, res);
    ok('角色 ' + b.role + ' 树渲染 8 主菜单', res.roots === 8, res);
    ok('角色 ' + b.role + ' 树渲染 47 节点', res.rows === 47, res);
    await ev(`window.__roleErrs=[]`);
  }

  console.log('\n【3】勾选态正确性（超级管理员全勾选 / 查看者零勾选）');
  const checkedByRole = {};
  for (const b of btns) {
    await ev(`(()=>{const a=${AV};a.querySelector('#${b.id}').click();return 1})()`);
    await sleep(350);
    checkedByRole[b.role] = await ev(`(()=>{const a=${AV};return a.querySelectorAll('#permTree input[type=checkbox]:checked').length})()`);
  }
  ok('超级管理员(7) 全勾选', checkedByRole['7'] === 47, checkedByRole);
  ok('管理员(1) 全勾选', checkedByRole['1'] === 47, checkedByRole);
  ok('查看者(3) 零勾选', checkedByRole['3'] === 0, checkedByRole);

  console.log('\n【4】null/undefined/对象 数据兜底（组件单元测试）');
  const unit = await evJSON(`(()=>{
    const r={};
    const mk=()=>{const d=document.createElement('div');document.body.appendChild(d);return d};
    try{const t=ERP.createPermissionTree(mk(),null);t.hydrate(null);r.nullOK=true}catch(e){r.nullOK=false;r.nullErr=e.message}
    try{const t=ERP.createPermissionTree(mk(),undefined);t.hydrate(undefined);r.undefOK=true}catch(e){r.undefOK=false;r.undefErr=e.message}
    try{const t=ERP.createPermissionTree(mk(),{menuList:[{menu_id:1,menu_name:'x'}]});t.hydrate({ids:[1]});r.objOK=true}catch(e){r.objOK=false;r.objErr=e.message}
    try{const t=ERP.createPermissionTree(mk(),[{menu_id:1,menu_name:'x',children:[{menu_id:2,menu_name:'y'}]}]);t.hydrate();r.missingHydrateOK=true}catch(e){r.missingHydrateOK=false;r.missingErr=e.message}
    return JSON.stringify(r)
  })()`);
  ok('treeData=null 不崩溃', unit.nullOK === true, unit);
  ok('treeData=undefined 不崩溃', unit.undefOK === true, unit);
  ok('treeData=对象 不崩溃', unit.objOK === true, unit);
  ok('hydrate() 无参不崩溃', unit.missingHydrateOK === true, unit);

  console.log('\n【5】三态联动（半选 / 全选 / 清空）');
  await ev(`(()=>{const a=${AV};a.querySelector('#perm_3').click();return 1})()`); await sleep(400); // 查看者：全未选
  // 点第一个子菜单 label
  const firstChildLabel = a => { const rows=[...a.querySelectorAll('#permTree .ptree-row')]; const c=rows.find(r=>!r.classList.contains('tree-parent')); return c && c.querySelector('.ptree-label'); };
  await ev(`(()=>{const a=${AV};const rows=[...a.querySelectorAll('#permTree .ptree-row')];const child=rows.find(r=>!r.classList.contains('tree-parent'));if(child)child.querySelector('.ptree-label').click();return 1})()`); await sleep(300);
  // render() 会重建 DOM，必须重新查询（旧引用已失效）
  const tri = await evJSON(`(()=>{const a=${AV};const rows=[...a.querySelectorAll('#permTree .ptree-row')];const child=rows.find(r=>!r.classList.contains('tree-parent'));const roots=[...a.querySelectorAll('#permTree .ptree-root')];const parent=roots.find(r=>r.querySelector('.ptree-row:not(.tree-parent)'));const pcb=parent&&parent.querySelector('input[type=checkbox]');return JSON.stringify({childChecked:child&&child.querySelector('input').checked,parentIndeterminate:pcb&&pcb.indeterminate,parentChecked:pcb&&pcb.checked})})()`);
  ok('勾选子菜单后子为选中', tri.childChecked === true, tri);
  ok('父菜单呈半选(indeterminate)', tri.parentIndeterminate === true, tri);
  await ev(`(()=>{const a=${AV};a.querySelector('#permAllBtn').click();return 1})()`);
  const allChecked = await ev(`(()=>{const a=${AV};return a.querySelectorAll('#permTree input[type=checkbox]:checked').length})()`);
  ok('全选按钮 → 47 节点全勾选', allChecked === 47, allChecked);
  await ev(`(()=>{const a=${AV};a.querySelector('#permClearBtn').click();return 1})()`);
  const noneChecked = await ev(`(()=>{const a=${AV};return a.querySelectorAll('#permTree input[type=checkbox]:checked').length})()`);
  ok('清空按钮 → 0 勾选', noneChecked === 0, noneChecked);

  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`);
  ws.close(); p.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
