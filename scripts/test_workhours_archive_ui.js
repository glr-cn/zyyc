// 工时归档/缺口/导入导出 UI 真实 Chrome 渲染测试
// 用法：先起本地服务 3112（隔离库），再 node scripts/test_workhours_archive_ui.js
'use strict';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), http = require('http');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3112';
const PORT = 9351, CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name, extra != null ? '=> ' + JSON.stringify(extra) : ''); } }

async function main() {
  // 先用 API 造测试数据（本仓甲 + 外仓乙），保证缺口行可见
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((r) => r.json());
  const TOKEN = login.token;
  const H = { 'Content-Type': 'application/json', 'X-ERP-Token': TOKEN };
  const su = `?t=${Date.now()}`;
  await fetch(BASE + '/api/customers' + su, { method: 'POST', headers: H, body: JSON.stringify({ customer_type: '仓储客户', company_name: 'UI测试本仓货主' + Date.now(), short_name: 'UI本仓', warehouse: '龙湖仓', coop_status: '合作中' }) });
  await fetch(BASE + '/api/customers' + su, { method: 'POST', headers: H, body: JSON.stringify({ customer_type: '仓储客户', company_name: 'UI测试外仓货主' + Date.now(), short_name: 'UI外仓', warehouse: '佳新仓', coop_status: '合作中' }) });

  const OUT = path.join(__dirname, '..', 'data', '_shot_wh_arch');
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
    await send('Page.navigate', { url: BASE + '/' }); await sleep(2500);
    const lg = await ev(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});const d=await r.json();if(!d.token)return 'FAIL';localStorage.setItem('erp_token',d.token);localStorage.setItem('erp_user',JSON.stringify(d.user));return 'OK';})()`);
    ok('登录', lg === 'OK', lg);
    await send('Page.navigate', { url: BASE + '/' }); await sleep(3500);
    await ev(`(()=>{if(window.ERP&&ERP._go){ERP._go('wh_lh');return 'OK';}return 'NO_GO';})()`);
    for (let i = 0; i < 20; i++) { const n = await ev(`String(document.querySelectorAll('#whBody tr').length)`); if (n !== '1' || (await ev(`String(!!document.querySelector('.wh-gap-row'))`)) === 'true') break; await sleep(600); }

    // 1. 工具条新元素齐全
    const bar = JSON.parse(await ev(`JSON.stringify({
      status:!!document.querySelector('#statusFilter'),
      statusVal:(document.querySelector('#statusFilter')||{}).value,
      tmpl:!!document.querySelector('#templateBtn'),
      imp:!!document.querySelector('#importBtn'),
      arc:!!document.querySelector('#archiveBtn'),
      shipShown:(document.querySelector('#shipTools')||{}).style&&document.querySelector('#shipTools').style.display
    })`));
    ok('状态筛选下拉存在且默认 pending', bar.status && bar.statusVal === 'pending', bar);
    ok('发货 tab 显示下载模板/导入按钮', bar.tmpl && bar.imp && bar.shipShown === 'inline', bar);
    ok('未归档视图显示归档按钮', bar.arc === true, bar);

    // 2. 缺口行渲染（本仓货主未填 → wh-gap-row + [待补]标签 + 行内填写按钮）
    const gap = JSON.parse(await ev(`JSON.stringify({
      gapRows:document.querySelectorAll('.wh-gap-row').length,
      bkTags:document.querySelectorAll('.bk-tag').length,
      fillBtns:document.querySelectorAll('button[data-act="inlineFill"]').length,
      ckCols:document.querySelectorAll('#whHead .wh-ck').length,
      gapNames:[...document.querySelectorAll('.wh-gap-row td:nth-child(3)')].map(x=>x.textContent.trim()).slice(0,5),
      gapDates:[...document.querySelectorAll('.wh-gap-row .wh-inline-date')].map(x=>x.textContent.trim()).slice(0,5)
    })`));
    ok('存在未填写缺口行', gap.gapRows >= 1, gap);
    ok('缺口行有红色[待补]标签', gap.bkTags >= 1, gap);
    ok('缺口行有行内"填写"按钮(inlineFill)', gap.fillBtns >= 1, gap);
    ok('未归档视图有勾选列', gap.ckCols === 1, gap);
    ok('缺口行含本仓测试货主', gap.gapNames.some((n) => n.includes('UI测试本仓货主')), gap.gapNames);
    ok('缺口行不含外仓货主', !gap.gapNames.some((n) => n.includes('UI测试外仓货主')), gap.gapNames);
    ok('缺口行日期显示待补日(2026-11)', gap.gapDates.some((d) => d.includes('2026-11')), gap.gapDates);

    // 3. 点"填写"→ 行内编辑态（输入框/下拉/提交取消按钮），不再弹居中 Modal
    await ev(`(()=>{const b=document.querySelector('button[data-act="inlineFill"]');if(b)b.click();})()`);
    await sleep(600);
    const inline = JSON.parse(await ev(`JSON.stringify({
      editing:document.querySelectorAll('tr.wh-inline-editing').length,
      modalOpen:!!document.querySelector('.modal #f_customer'),
      unitSel:document.querySelectorAll('tr.wh-inline-editing select[data-if="unit"]').length,
      unitVals:[...document.querySelectorAll('tr.wh-inline-editing select[data-if="unit"] option')].map(o=>o.value),
      shipIn:document.querySelectorAll('tr.wh-inline-editing input[data-if="ship_orders"]').length,
      mainIn:document.querySelectorAll('tr.wh-inline-editing input[data-if="main_hours"]').length,
      otherIn:document.querySelectorAll('tr.wh-inline-editing input[data-if="other_hours"]').length,
      remarkIn:document.querySelectorAll('tr.wh-inline-editing input[data-if="remark"]').length,
      effOut:document.querySelectorAll('tr.wh-inline-editing td[data-out="efficiency"]').length,
      totalOut:document.querySelectorAll('tr.wh-inline-editing td[data-out="total_hours"]').length,
      submitBtn:document.querySelectorAll('tr.wh-inline-editing button[data-act="inlineSubmit"]').length,
      cancelBtn:document.querySelectorAll('tr.wh-inline-editing button[data-act="inlineCancel"]').length
    })`));
    ok('点填写进入行内编辑态（不弹 Modal）', inline.editing === 1 && inline.modalOpen === false, inline);
    ok('行内单位下拉含 单/件/箱', inline.unitSel === 1 && ['单','件','箱'].every((u)=>inline.unitVals.includes(u)), inline.unitVals);
    ok('行内有单量/主工时/其他工时/备注输入框', inline.shipIn===1&&inline.mainIn===1&&inline.otherIn===1&&inline.remarkIn===1, inline);
    ok('行内时效/总工时为只读输出列', inline.effOut === 1 && inline.totalOut === 1, inline);
    ok('操作列变提交+取消按钮', inline.submitBtn === 1 && inline.cancelBtn === 1, inline);

    // 3b. 输入单量/主工时/其他工时 → 实时计算时效、总工时
    await ev(`(()=>{const tr=document.querySelector('tr.wh-inline-editing');
      const set=(k,v)=>{const el=tr.querySelector('input[data-if="'+k+'"]');el.value=v;el.dispatchEvent(new Event('input'));};
      set('ship_orders','120');set('main_hours','6');set('other_hours','1.5');})()`);
    await sleep(300);
    const calc = JSON.parse(await ev(`JSON.stringify({
      eff:document.querySelector('tr.wh-inline-editing td[data-out="efficiency"]').textContent.trim(),
      total:document.querySelector('tr.wh-inline-editing td[data-out="total_hours"]').textContent.trim()
    })`));
    ok('实时时效=120/6=20.000', calc.eff === '20.000', calc);
    ok('实时总工时=6+1.5+0=7.500', calc.total === '7.500', calc);

    // 3c. 取消 → 恢复非编辑态
    await ev(`(()=>{const b=document.querySelector('button[data-act="inlineCancel"]');if(b)b.click();})()`);
    await sleep(300);
    ok('取消后退出行内编辑态', (await ev(`String(document.querySelectorAll('tr.wh-inline-editing').length)`)) === '0');

    // 4. 切到"已归档"→ 归档按钮隐藏 + 提示条显示 + 无缺口行
    await ev(`(()=>{const s=document.querySelector('#statusFilter');s.value='archived';s.dispatchEvent(new Event('change'));})()`);
    await sleep(1500);
    const arch = JSON.parse(await ev(`JSON.stringify({
      arcDisp:(document.querySelector('#archiveBtn')||{}).style&&document.querySelector('#archiveBtn').style.display,
      tipDisp:(document.querySelector('#archiveTip')||{}).style&&document.querySelector('#archiveTip').style.display,
      gapRows:document.querySelectorAll('.wh-gap-row').length,
      ckCols:document.querySelectorAll('#whHead .wh-ck').length,
      empty:(document.querySelector('#whBody .empty')||{}).textContent
    })`));
    ok('已归档视图隐藏归档按钮', arch.arcDisp === 'none', arch);
    ok('已归档视图显示只读提示', arch.tipDisp !== 'none', arch);
    ok('已归档视图无缺口行', arch.gapRows === 0, arch);
    ok('已归档视图无勾选列', arch.ckCols === 0, arch);
    ok('已归档空态文案正确', (arch.empty || '').includes('已归档'), arch.empty);

    // 5. 切回收货 tab → 导入导出按钮隐藏（需求4）
    await ev(`(()=>{const s=document.querySelector('#statusFilter');s.value='pending';s.dispatchEvent(new Event('change'));})()`);
    await sleep(1000);
    await ev(`(()=>{const t=[...document.querySelectorAll('.wh-tab')].find(x=>x.textContent.trim()==='收货工时');if(t)t.click();})()`);
    await sleep(1200);
    const recv = JSON.parse(await ev(`JSON.stringify({
      shipDisp:document.querySelector('#shipTools').style.display,
      gapRows:document.querySelectorAll('.wh-gap-row').length
    })`));
    ok('收货 tab 隐藏导入导出按钮', recv.shipDisp === 'none', recv);
    ok('收货 tab 无缺口行', recv.gapRows === 0, recv);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'wh-archive-ui.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('[截图]', path.join(OUT, 'wh-archive-ui.png'));
  } finally { ws.close(); proc.kill(); }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
