// 工时管理 Tabs 视觉联动测试（真实 Chrome 渲染级）
// 验证：① 标题随 Tab 联动 ② 搜索框 placeholder 联动 ③ Tab 选中态 ④ 内容区卡片
//       ⑤ 客户页通用 .tab 不受影响（本页用 .wh-tab 专用 class）
// 用法：node scripts/test_workhours_tabs.js（需本地服务 3112 已启动）
'use strict';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), http = require('http');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3112';
const PORT = 9350, CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name, extra != null ? '=> ' + JSON.stringify(extra) : ''); } }

async function main() {
  const OUT = path.join(__dirname, '..', 'data', '_shot_wh');
  fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu', '--window-size=1600,900', `--user-data-dir=${path.join(OUT, 'p')}`, 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { target = (await httpJSON(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); const v = r.result && r.result.result; return v && v.value !== undefined ? v.value : 'UNDEF'; };
  await new Promise((r) => { ws.onopen = r; }); await send('Page.enable'); await send('Runtime.enable');

  try {
    await send('Page.navigate', { url: BASE + '/' }); await sleep(3000);
    const lg = await ev(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});const d=await r.json();if(!d.token)return 'FAIL';localStorage.setItem('erp_token',d.token);localStorage.setItem('erp_user',JSON.stringify(d.user));return 'OK';})()`);
    ok('登录成功', lg === 'OK', lg);
    await send('Page.navigate', { url: BASE + '/' }); await sleep(4000);
    const go = await ev(`(()=>{if(window.ERP&&ERP._go){ERP._go('wh_lh');return 'OK';}return 'NO_GO';})()`);
    ok('跳转龙湖仓工时页', go === 'OK', go);
    // 等待 tab 渲染
    for (let i = 0; i < 15; i++) { const n = await ev(`String(document.querySelectorAll('.wh-tab').length)`); if (n === '4') break; await sleep(600); }

    const init = JSON.parse(await ev(`JSON.stringify({
      tabs: document.querySelectorAll('.wh-tab').length,
      title: (document.querySelector('#whTitleText')||{}).textContent,
      ph: (document.querySelector('#q')||{}).placeholder,
      active: (document.querySelector('.wh-tab.active')||{}).textContent,
      card: !!document.querySelector('.wh-content-card'),
      customTab: document.querySelectorAll('#typeTabs .tab').length
    })`));
    ok('4 个 wh-tab 渲染', init.tabs === 4, init);
    ok('初始标题=发货工时录入', init.title === '发货工时录入', init.title);
    ok('初始 placeholder=搜索客户名称', init.ph === '搜索客户名称', init.ph);
    ok('初始选中=发货工时', init.active === '发货工时', init.active);
    ok('内容区卡片存在', init.card === true, init.card);
    ok('未使用全局 .tab（不影响客户页）', init.customTab === 0, init.customTab);

    // 逐 Tab 切换验证联动
    const expect = [
      { tp: '收货工时', title: '收货工时录入', ph: '搜索客户名称' },
      { tp: '库内工时', title: '库内工时录入', ph: '搜索项目名称' },
      { tp: '后勤工时', title: '后勤工时录入', ph: '搜索项目名称' },
      { tp: '发货工时', title: '发货工时录入', ph: '搜索客户名称' },
    ];
    for (const e of expect) {
      await ev(`(()=>{const t=[...document.querySelectorAll('.wh-tab')].find(x=>x.textContent.trim()==='${e.tp}');if(t)t.click();})()`);
      await sleep(700);
      const s = JSON.parse(await ev(`JSON.stringify({
        title:(document.querySelector('#whTitleText')||{}).textContent,
        ph:(document.querySelector('#q')||{}).placeholder,
        active:(document.querySelector('.wh-tab.active')||{}).textContent,
        activeCount:document.querySelectorAll('.wh-tab.active').length
      })`));
      ok(`切到【${e.tp}】标题联动`, s.title === e.title, s.title);
      ok(`切到【${e.tp}】placeholder 联动`, s.ph === e.ph, s.ph);
      ok(`切到【${e.tp}】仅一个选中且为自身`, s.active === e.tp && s.activeCount === 1, s);
    }

    // 视觉快照：选中态样式（品牌蓝底/白字/加粗/下划线）
    const vis = JSON.parse(await ev(`(()=>{const t=document.querySelector('.wh-tab.active');const s=getComputedStyle(t);const u=getComputedStyle(t,'::after');const normal=document.querySelector('.wh-tab:not(.active)');const ns=getComputedStyle(normal);return JSON.stringify({
      activeBg:s.backgroundColor,activeColor:s.color,activeWeight:s.fontWeight,
      underlineH:u.height,underlineBg:u.backgroundColor,
      normalBg:ns.backgroundColor,normalColor:ns.color
    });})()`));
    ok('选中 Tab=品牌蓝底', vis.activeBg === 'rgb(47, 111, 237)', vis);
    ok('选中 Tab=白字', vis.activeColor === 'rgb(255, 255, 255)', vis);
    ok('选中 Tab=加粗(700)', vis.activeWeight === '700', vis.activeWeight);
    ok('选中 Tab 有下划线指示器', vis.underlineH === '3px', vis.underlineH);
    ok('未选中 Tab=浅灰底', vis.normalBg === 'rgb(238, 241, 246)', vis.normalBg);
    ok('未选中 Tab=深色字', vis.normalColor === 'rgb(74, 85, 102)', vis.normalColor);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'wh-tabs.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('[截图]', path.join(OUT, 'wh-tabs.png'));

  } finally {
    ws.close(); proc.kill();
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
