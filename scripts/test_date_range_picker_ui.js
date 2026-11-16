// 日期范围组件 真实 Chrome DOM 交互测试
// 用法：先起隔离服务 PORT=3115，再 node scripts/test_date_range_picker_ui.js
'use strict';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), http = require('http');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3115';
const PORT = 9357, CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name, extra != null ? '=> ' + JSON.stringify(extra) : ''); } }

// 当前激活页作用域（多页 DOM 并存，必须用可见的 .page-view，避免命中其他页同 id 元素）
const AV = `(function(){var a=[...document.querySelectorAll('.page-view')].find(v=>getComputedStyle(v).display!=='none');return a||document;})()`;

async function main() {
  const OUT = path.join(__dirname, '..', 'data', '_shot_drp');
  fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu', '--window-size=1600,900', `--user-data-dir=${path.join(OUT, 'p')}`, 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { target = (await httpJSON(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) {} }
  if (!target) { console.error('Chrome 启动失败'); process.exit(2); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); const v = r.result && r.result.result; if (r.exceptionDetails) return 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return v && v.value !== undefined ? v.value : 'UNDEF'; };
  const waitFor = async (expr, timeout = 12000) => { const t = Date.now(); while (Date.now() - t < timeout) { const v = await ev(expr); if (v === 'true' || v === true) return true; await sleep(300); } return false; };
  const evJSON = async (expr) => { const s = await ev(expr); try { return JSON.parse(s); } catch (e) { return { _parseErr: String(s).slice(0, 200) }; } };
  await new Promise((r) => { ws.onopen = r; }); await send('Page.enable'); await send('Runtime.enable');

  const goto = async (page) => {
    await ev(`(()=>{if(window.ERP&&ERP._go){ERP._go(${JSON.stringify(page)});return 'OK';}return 'NO_GO';})()`);
    await sleep(1000);
  };

  try {
    await send('Page.navigate', { url: BASE + '/' }); await sleep(2500);
    const lg = await ev(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});const d=await r.json();if(!d.token)return 'FAIL';localStorage.setItem('erp_token',d.token);localStorage.setItem('erp_user',JSON.stringify(d.user));return 'OK';})()`);
    ok('登录', lg === 'OK', lg);
    await send('Page.navigate', { url: BASE + '/' });
    ok('组件脚本加载完成', await waitFor(`typeof window.DateRangePicker === 'function'`), 'timeout');

    // ---- 工时页 ----
    await goto('wh_lh');
    const wh = await evJSON(`(()=>{const a=${AV};return JSON.stringify({
      slot:!!a.querySelector('#drpSlot.drp'),
      mode:(a.querySelector('#drpSlot .drp-mode')||{}).value,
      trig:!!a.querySelector('#drpSlot .drp-trigger'),
      oldFrom:!!a.querySelector('#dateFrom'),
      oldTo:!!a.querySelector('#dateTo')
    });})()`);
    ok('工时页：组件已渲染', wh.slot && wh.trig === true, wh);
    ok('工时页：默认按日', wh.mode === 'day', wh);
    ok('工时页：原生 date input 已移除', !wh.oldFrom && !wh.oldTo, wh);

    const panel = await evJSON(`(()=>{const a=${AV};a.querySelector('#drpSlot .drp-trigger').click();return JSON.stringify({
      open:!a.querySelector('#drpSlot .drp-panel').classList.contains('drp-hidden'),
      quick:a.querySelectorAll('#drpSlot .drp-quick button').length,
      cals:a.querySelectorAll('#drpSlot .drp-cal').length,
      cells:a.querySelectorAll('#drpSlot .drp-cal-grid .drp-cell[data-date]').length
    });})()`);
    ok('按日：面板打开', panel.open === true, panel);
    ok('按日：7 个快捷项', panel.quick === 7, panel);
    ok('按日：两个月历', panel.cals === 2, panel);
    ok('按日：日历有日期格', panel.cells > 40, panel);

    const todayInfo = await evJSON(`(()=>{const a=${AV};const bs=[...a.querySelectorAll('#drpSlot .drp-quick button')];const t=bs.find(b=>b.textContent.trim()==='今天');if(!t)return JSON.stringify({noBtn:true});t.click();return JSON.stringify({
      txt:a.querySelector('#drpSlot .drp-text').textContent,
      hidden:a.querySelector('#drpSlot .drp-panel').classList.contains('drp-hidden')
    });})()`);
    ok('快捷「今天」：面板关闭', todayInfo.hidden === true, todayInfo);
    ok('快捷「今天」：显示单个日期', /^\d{4}-\d{2}-\d{2}$/.test(todayInfo.txt || ''), todayInfo);

    // 容错：只点开始日期 → 点击外部关闭 → 结束=开始
    await ev(`(()=>{const a=${AV};a.querySelector('#drpSlot .drp-trigger').click();return 'OK'})()`);
    await sleep(200);
    const tol = await evJSON(`(()=>{const a=${AV};const c=a.querySelectorAll('#drpSlot .drp-cal-grid .drp-cell[data-date]')[10];if(!c)return JSON.stringify({noCell:true});const ds=c.dataset.date;c.click();
      document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      return JSON.stringify({clicked:ds,txt:a.querySelector('#drpSlot .drp-text').textContent,hidden:a.querySelector('#drpSlot .drp-panel').classList.contains('drp-hidden')});})()`);
    ok('容错：只点开始就关闭→结束=开始', tol.txt === tol.clicked && tol.hidden === true, tol);

    // 切按周 → 打开面板 → 列表
    await ev(`(()=>{const a=${AV};const s=a.querySelector('#drpSlot .drp-mode');s.value='week';s.dispatchEvent(new Event('change'));a.querySelector('#drpSlot .drp-trigger').click();return 'OK'})()`);
    await sleep(300);
    const week = await evJSON(`(()=>{const a=${AV};const items=[...a.querySelectorAll('#drpSlot .drp-list-item')];return JSON.stringify({
      count:items.length, first:items[0]?items[0].textContent:'', pattern:items[0]?/^\\d{4} 第\\d+周 · \\d{2}\\/\\d{2}~\\d{2}\\/\\d{2}$/.test(items[0].textContent):false
    });})()`);
    ok('按周：下拉列表有条目', week.count > 10, week);
    ok('按周：条目格式正确', week.pattern === true, week);
    const weekPick = await evJSON(`(()=>{const a=${AV};const it=a.querySelector('#drpSlot .drp-list-item');if(!it)return JSON.stringify({noItem:true});it.click();const txt=a.querySelector('#drpSlot .drp-text').textContent;const m=txt.match(/(\\d{4}-\\d{2}-\\d{2}) ~ (\\d{4}-\\d{2}-\\d{2})/);return JSON.stringify({txt,range:m?[m[1],m[2]]:null});})()`);
    ok('按周：显示周一~周日范围', !!weekPick.range, weekPick);
    if (weekPick.range) {
      const d0 = new Date(weekPick.range[0] + 'T00:00:00'), d1 = new Date(weekPick.range[1] + 'T00:00:00');
      ok('按周：起始为周一', d0.getDay() === 1, weekPick.range);
      ok('按周：跨度为6天', Math.round((d1 - d0) / 86400000) === 6, weekPick.range);
    }

    const netCheck = await ev(`(async()=>{const a=${AV};let captured='';const of=window.fetch;window.fetch=function(u,o){if(String(u).indexOf('/api/workhours')>=0)captured=String(u);return of.apply(this,arguments);};const btn=a.querySelector('#qryBtn');if(btn)btn.click();await new Promise(r=>setTimeout(r,700));window.fetch=of;return captured;})()`);
    ok('工时查询：仍带 dateFrom/dateTo', /dateFrom=/.test(netCheck) && /dateTo=/.test(netCheck), netCheck);

    // ---- 日志中心 ----
    await goto('log_all');
    const lg2 = await evJSON(`(()=>{const a=${AV};return JSON.stringify({
      slot:!!a.querySelector('#dateRangeSlot.drp'),
      oldFrom:!!a.querySelector('#dateFrom'),
      mode:(a.querySelector('#dateRangeSlot .drp-mode')||{}).value
    });})()`);
    ok('日志中心：组件已渲染且默认按日', lg2.slot && lg2.mode === 'day' && !lg2.oldFrom, lg2);
    await ev(`(()=>{const a=${AV};const s=a.querySelector('#dateRangeSlot .drp-mode');s.value='month';s.dispatchEvent(new Event('change'));a.querySelector('#dateRangeSlot .drp-trigger').click();return 'OK'})()`);
    await sleep(300);
    const month = await evJSON(`(()=>{const a=${AV};const items=[...a.querySelectorAll('#dateRangeSlot .drp-list-item')];return JSON.stringify({count:items.length,first:items[0]?items[0].textContent:'',pattern:items[0]?/^\\d{4}年\\d{1,2}月$/.test(items[0].textContent):false});})()`);
    ok('按月：月份列表格式正确', month.count > 10 && month.pattern, month);
    const monthPick = await ev(`(()=>{const a=${AV};const it=a.querySelector('#dateRangeSlot .drp-list-item');if(!it)return '';it.click();return a.querySelector('#dateRangeSlot .drp-text').textContent;})()`);
    ok('按月：显示月初~月末', /\d{4}-\d{2}-01 ~ \d{4}-\d{2}-\d{2}/.test(monthPick), monthPick);

    // ---- 经营分析 ----
    await goto('analytics');
    const an = await evJSON(`(()=>{const a=${AV};return JSON.stringify({
      slot:!!a.querySelector('#drpSlot.drp'),
      mode:(a.querySelector('#drpSlot .drp-mode')||{}).value,
      oldMode:!!a.querySelector('#mode'),
      oldFrom:!!a.querySelector('#from')
    });})()`);
    ok('经营分析：组件已渲染且默认按月', an.slot && an.mode === 'month' && !an.oldMode && !an.oldFrom, an);
    const anNet = await ev(`(async()=>{const a=${AV};let captured='';const of=window.fetch;window.fetch=function(u,o){if(String(u).indexOf('/api/analytics/summary')>=0)captured=String(u);return of.apply(this,arguments);};a.querySelector('#qryBtn').click();await new Promise(r=>setTimeout(r,700));window.fetch=of;return captured;})()`);
    ok('经营分析：仍带 mode 参数', /mode=/.test(anNet), anNet);

  } finally {
    try { ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
  }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
