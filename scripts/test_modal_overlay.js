// 物流报价「查看弹窗省份列不可见」回归测试（真实 Chrome 渲染级）
// 背景：根因不是数据/渲染，而是 .modal-overlay(z-index:50) 低于 .sidebar(70)，
//       弹窗左侧 200px 被导航栏盖住 → 省份列(最左列)完全不可见。
// 本测试用 CDP 驱动真实 Chrome，加载本地服务，断言：
//   ① 接口返回含 province 字段且值非空（数据层）
//   ② 表头首列是「省份」且在「城市」之前（DOM 层）
//   ③ 命中测试：省份表头中心点最顶层元素必须是省份 th 本身（不被任何浮层遮挡）
//   ④ 遮罩层 z-index 必须高于侧边栏
//   ⑤ 横向滚动后省份列仍固定可见
// 用法：
//   node scripts/test_modal_overlay.js            # 需先启动本地服务(端口 3111)
//   PROBE_BASE=... PROBE_PASS=... node scripts/test_modal_overlay.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3111';
const SHARE = process.env.PROBE_SHARE || '';
const PASS = process.env.PROBE_PASS || 'admin123';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, extra != null ? '→ ' + extra : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});
const SCQ = SHARE ? ('sharecode=' + SHARE) : '';

(async () => {
  const OUT = path.join(__dirname, '..', 'data', '_shot_test');
  fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu',
    '--window-size=1600,900', `--user-data-dir=${path.join(OUT, 'profile')}`, 'about:blank'], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try { target = (await httpJSON(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) { }
  }
  if (!target) { console.log('❌ Chrome 未启动'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');

  try {
    // 注意：线上根路径 / 是跳转页（有 token→app.html，无 token→login.html），
    // 必须直接访问 /app.html 才能加载应用外壳；本地服务根路径即应用页。
    const APP_URL = BASE.endsWith('app.workbuddy.host') ? `${BASE}/app.html` : BASE;
    await send('Page.navigate', { url: `${APP_URL}?${SCQ}` });
    await sleep(3500);
    const lg = await evalJS(`(async()=>{const r=await fetch('/api/auth/login${SCQ ? '?' + SCQ : ''}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'${PASS}'})});const d=await r.json();if(!d.token)return 'FAIL';localStorage.setItem('erp_token',d.token);localStorage.setItem('erp_user',JSON.stringify(d.user));return 'OK';})()`);
    ok('登录成功', lg === 'OK', lg);

    // ① 数据层：接口返回含 province 且非空
    const api = await evalJS(`(async()=>{const t=localStorage.getItem('erp_token');const r=await fetch('/api/logistics-quotes/by-code?code=YTO4',{headers:{'X-ERP-Token':t}});const d=await r.json();const rows=d.data||[];return JSON.stringify({n:rows.length,allHaveProvince:rows.every(x=>Object.prototype.hasOwnProperty.call(x,'province')),nonEmpty:rows.filter(x=>x.province).length,sample:rows[0]?rows[0].province:''});})()`);
    const a = JSON.parse(api || '{}');
    ok('接口 by-code 返回含 province 字段', a.allHaveProvince === true, api);
    ok('接口省份值非空', a.nonEmpty > 0, api);

    await send('Page.navigate', { url: `${APP_URL}?${SCQ}` });
    await sleep(4000);
    // 线上有网关延迟，菜单渲染可能较慢：轮询等待「查看」按钮出现（最长 25s）
    let btnReady = '';
    for (let i = 0; i < 25; i++) {
      await evalJS(`window.ERP&&ERP._go&&ERP._go('logi_quotes')`);
      await sleep(1000);
      btnReady = await evalJS(`String(document.querySelectorAll('button[data-act="view"]').length)`);
      if (btnReady !== '0' && btnReady !== 'UNDEF') break;
    }
    ok('物流报价页面渲染出查看按钮', btnReady !== '0' && btnReady !== 'UNDEF', btnReady);
    await sleep(1500);
    const clicked = await evalJS(`(()=>{const b=document.querySelector('button[data-act="view"]');if(!b)return 'NO_BTN';b.click();return 'OK';})()`);
    ok('打开查看弹窗', clicked === 'OK', clicked);
    await sleep(2500);

    const diagRaw = await evalJS(`(()=>{
      const t=document.querySelector('table.xls-tbl'); if(!t) return '{}';
      const ths=[...t.querySelectorAll('thead th')].map(x=>x.textContent.trim());
      const provTh=t.querySelector('thead th.c-prov');
      const ov=document.querySelector('.modal-overlay'), sb=document.querySelector('.sidebar');
      const ovZ=ov?getComputedStyle(ov).zIndex:null, sbZ=sb?getComputedStyle(sb).zIndex:null;
      let hit='';
      if(provTh){const r=provTh.getBoundingClientRect();const el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2));hit=el?(el.tagName+'.'+String(el.className||'')):'';}
      const w=t.parentElement;
      return JSON.stringify({ths:ths.slice(0,5),total:ths.length,ovZ,sbZ,hit,scrollLeft:w.scrollLeft,
        provLeft:provTh?Math.round(provTh.getBoundingClientRect().left):null,
        sbRight:sb?Math.round(sb.getBoundingClientRect().right):null,
        firstRowProv:t.querySelector('tbody tr td.c-prov')?t.querySelector('tbody tr td.c-prov').textContent.trim():''});
    })()`);
    let diag = {};
    try { diag = JSON.parse(diagRaw || '{}'); } catch (e) { diag = { parseError: String(diagRaw).slice(0, 200) }; }

    // ② DOM 层：表头首列=省份，且在城市之前
    ok('表头第一列是「省份」', diag.ths && diag.ths[0] === '省份', JSON.stringify(diag.ths || diag.parseError));
    ok('表头第二列是「城市」（顺序正确）', diag.ths && diag.ths[1] === '城市', JSON.stringify(diag.ths || diag.parseError));
    ok('表头第三列是「区县」', diag.ths && diag.ths[2] === '区县', JSON.stringify(diag.ths || diag.parseError));
    ok('表头总列数=45', diag.total === 45, diag.total);

    // ③ 命中测试：省份 th 必须是最顶层（不被侧边栏等浮层遮挡）
    ok('省份列未被浮层遮挡（命中自身）', diag.hit === 'TH.stick c-prov', diag.hit);
    ok('遮罩层 z-index 高于侧边栏', Number(diag.ovZ) > Number(diag.sbZ), `overlay=${diag.ovZ} sidebar=${diag.sbZ}`);
    ok('省份列左边缘在侧边栏右侧之外', Number(diag.provLeft) >= Number(diag.sbRight), `provLeft=${diag.provLeft} sbRight=${diag.sbRight}`);
    ok('首行省份单元格有真实值', !!diag.firstRowProv && diag.firstRowProv !== '-', diag.firstRowProv);

    // ④ 横向滚动后省份列仍固定
    const scRaw = await evalJS(`(()=>{const t=document.querySelector('table.xls-tbl');if(!t)return '{}';const w=t.parentElement;w.scrollLeft=1200;const p=t.querySelector('tbody td.c-prov');const wr=w.getBoundingClientRect();const pr=p.getBoundingClientRect();return JSON.stringify({sl:w.scrollLeft,left:Math.round(pr.left),cLeft:Math.round(wr.left),txt:p.textContent.trim()});})()`);
    let sc = {};
    try { sc = JSON.parse(scRaw || '{}'); } catch (e) { sc = {}; }
    ok('横向滚动后省份列仍固定在容器内', sc.left >= sc.cLeft - 1 && sc.sl === 1200, JSON.stringify(sc));
    ok('横向滚动后省份值仍在', sc.txt && sc.txt !== '-', sc.txt);
  } finally {
    try { ws.close(); proc.kill(); } catch (e) { }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
