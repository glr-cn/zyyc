// 发货工时行内编辑「排版错乱 + 脏读」修复回归测试
// 覆盖：固定列宽 colgroup / 输入框不撑破 / 操作列 sticky 完整显示 / 空值真空态 /
//       脏数据拦截不入库 / 时效 - 规则 / placeholder 浅色 / admin 删除按钮可见。
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
  console.log('=== A. 造测试数据 ===');
  const lg = await req('POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' });
  ok('admin 登录', lg.status === 200 && !!lg.body.token, lg.status);
  const token = lg.body.token;
  ok('admin 为超管角色', lg.body.user && lg.body.user.role_code === 'super_admin', lg.body.user && lg.body.user.role_code);

  let custs = await req('GET', '/api/customers?pageSize=5', token);
  let list = custs.body.data || custs.body.rows || [];
  if (!list.length) {
    await req('POST', '/api/customers?type=' + encodeURIComponent('仓储客户'), token, {
      company_name: '排版修复测试货主', short_name: '排版测试', warehouse: '龙湖仓', customer_type: '仓储客户', coop_status: '合作中',
    });
    custs = await req('GET', '/api/customers?pageSize=5', token);
    list = custs.body.data || custs.body.rows || [];
  }
  const cust = list[0];
  ok('有可用客户', !!cust && !!cust.customer_id);
  // 另造一个客户 + 一条已填发货记录，供「已填行显示删除按钮」验证（用不同客户，避免占用缺口测试行）
  const made = await req('POST', '/api/customers?type=' + encodeURIComponent('仓储客户'), token, {
    company_name: '已填行测试货主' + Date.now(), short_name: '已填行', warehouse: '龙湖仓', customer_type: '仓储客户', coop_status: '合作中',
  });
  const fillCid = made.body.data && made.body.data.customer_id;
  if (fillCid) {
    await req('POST', '/api/workhours', token, {
      warehouse: '龙湖仓', work_type: '发货', customer_id: fillCid, customer_name: made.body.data.company_name,
      date: '2026-11-16', unit: '单', ship_orders: 50, main_hours: 5, other_hours: 0, shared_hours: 0, remark: '已填行测试',
    });
  }
  ok('已填行测试数据就绪', !!fillCid);

  console.log('\n=== B. 真实 Chrome UI 测试 ===');
  const PORT = 9381;
  const p = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(__dirname, '_inline3_prof'), 'about:blank'], { stdio: 'ignore' });
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
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev(`typeof ERP!=='undefined'&&typeof ERP._go==='function'&&typeof ERP_PAGES.wh_lh==='function'?'Y':'N'`) === 'Y') { ready = true; break; } }
  ok('ERP 就绪', ready);
  await ev(`ERP._go('wh_lh')`); await sleep(1500);
  const AV = `(function(){return [...document.querySelectorAll('.page-view')].find(v=>getComputedStyle(v).display!=='none')||document;})()`;

  // 1. 表格固定列宽 + 操作列 sticky
  const layout = await evJSON(`(()=>{const a=${AV};const t=a.querySelector('#whTable');const cg=a.querySelector('#whColGroup');
    return JSON.stringify({
      fixedCls:t.classList.contains('wh-inline-grid'),
      layout:getComputedStyle(t).tableLayout,
      colCount:cg?cg.querySelectorAll('col').length:0,
      colWidths:cg?[...cg.querySelectorAll('col')].map(c=>c.style.width):[],
      opsSticky:(()=>{const th=a.querySelector('#whHead th.ops-head');return th?getComputedStyle(th).position:'NO_TH'})(),
      opsRight:(()=>{const th=a.querySelector('#whHead th.ops-head');return th?getComputedStyle(th).right:'NO_TH'})()
    })})()`);
  ok('发货表格启用 wh-inline-grid', layout.fixedCls === true, layout);
  ok('table-layout=fixed', layout.layout === 'fixed', layout);
  ok('colgroup 锁定 10 列宽', layout.colCount === 10 && layout.colWidths.every((w) => /px$/.test(w)), layout);
  ok('操作列表头 sticky 贴右', layout.opsSticky === 'sticky' && layout.opsRight === '0px', layout);

  // 2. 输入框不撑破：输入框宽度 <= 列宽
  const widths = await evJSON(`(()=>{const a=${AV};const tr=a.querySelector('#whBody tr[data-row-cid]');if(!tr)return JSON.stringify({no:true});
    const num=tr.querySelector('[data-if="ship_orders"]');const td=num.closest('td');
    return JSON.stringify({inputW:num.getBoundingClientRect().width,tdW:td.getBoundingClientRect().width,box:getComputedStyle(num).boxSizing})})()`);
  ok('输入框宽度不超列宽', widths.inputW > 0 && widths.inputW <= widths.tdW + 1, widths);
  ok('输入框 box-sizing=border-box', widths.box === 'border-box', widths);

  // 3. 空值真空态：缺口行输入框 value 为空（不写 0）；placeholder 浅色
  const gapState = await evJSON(`(()=>{const a=${AV};const tr=a.querySelector('#whBody tr.wh-gap-row');if(!tr)return JSON.stringify({noGap:true});
    const ship=tr.querySelector('[data-if="ship_orders"]'),main=tr.querySelector('[data-if="main_hours"]'),other=tr.querySelector('[data-if="other_hours"]');
    const ph=getComputedStyle(ship,'::placeholder').color;
    return JSON.stringify({shipV:ship.value,mainV:main.value,otherV:other.value,ph,eff:tr.querySelector('[data-out="efficiency"]').textContent})})()`);
  ok('缺口行单量真空（非0）', gapState.shipV === '', gapState);
  ok('缺口行主工时真空（非0）', gapState.mainV === '', gapState);
  ok('缺口行其他工时真空（非0）', gapState.otherV === '', gapState);
  ok('时效无输入显示 -', gapState.eff === '-', gapState);
  ok('placeholder 浅灰色', /rgb\(1[6-9]\d|rgb\(2\d\d/.test(gapState.ph || '') || gapState.ph === 'rgb(184, 190, 201)', gapState);

  // 4. 脏数据拦截：缺口行只填主工时（单量空）→ blur → 不应入库，行仍缺口态且被复位
  const beforeCount = await req('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货&status=pending&pageSize=100', token);
  const cntBefore = (beforeCount.body.data || []).length;
  const dirty = await evJSON(`(()=>{const a=${AV};const tr=a.querySelector('#whBody tr.wh-gap-row');if(!tr)return JSON.stringify({noGap:true});
    const main=tr.querySelector('[data-if="main_hours"]');main.value='8';main.dispatchEvent(new Event('input',{bubbles:true}));
    const effAfterMain=tr.querySelector('[data-out="efficiency"]').textContent;
    main.dispatchEvent(new Event('blur',{bubbles:true}));
    return JSON.stringify({effAfterMain})})()`);
  await sleep(900);
  // 口径：单量>0 且 主工时>0 才计算时效；只填主工时（单量空）→ 时效显示 -（防脏数据冒充 0.000）
  ok('只填主工时时效显示 -（不显示 0.000）', dirty.effAfterMain === '-', dirty);
  const afterCount = await req('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货&status=pending&pageSize=100', token);
  const cntAfter = (afterCount.body.data || []).length;
  ok('脏数据未入库（记录数不变）', cntAfter === cntBefore, { cntBefore, cntAfter });

  // 5. 时效规则：单量+主工时都有值 → 实时计算 round3
  const calc = await evJSON(`(()=>{const a=${AV};const tr=a.querySelector('#whBody tr.wh-gap-row');if(!tr)return JSON.stringify({no:true});
    const s=tr.querySelector('[data-if="ship_orders"]'),m=tr.querySelector('[data-if="main_hours"]');
    s.value='120';m.value='8';s.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify({eff:tr.querySelector('[data-out="efficiency"]').textContent})})()`);
  ok('时效实时计算 120/8=15.000', calc.eff === '15.000', calc);

  // 6. admin 删除按钮：缺口行无、已填行有
  const delBtns = await evJSON(`(()=>{const a=${AV};const gap=a.querySelector('#whBody tr.wh-gap-row');
    const gapDel=gap?gap.querySelectorAll('[data-act="delAdmin"]').length:-1;
    const filled=[...a.querySelectorAll('#whBody tr[data-row-cid]')].filter(t=>!t.classList.contains('wh-gap-row'));
    const filledDel=filled.map(t=>t.querySelectorAll('[data-act="delAdmin"]').length);
    return JSON.stringify({gapDel,filledCount:filled.length,filledDel})})()`);
  ok('缺口行不显示删除按钮', delBtns.gapDel === 0, delBtns);
  ok('已填行显示删除按钮（admin）', delBtns.filledCount > 0 && delBtns.filledDel.every((n) => n === 1), delBtns);

  // 7. 正常保存：填单量+主工时 → blur → 该缺口行归档移出
  // 断言按客户 cid 精确定位（隔离库可能残留历史货主，缺口行不止一条，不能用总数判断）
  const gapCid = await ev(`(()=>{const a=${AV};const tr=a.querySelector('#whBody tr.wh-gap-row');return tr?tr.dataset.rowCid:'NONE'})()`);
  await ev(`(()=>{const a=${AV};const tr=a.querySelector('#whBody tr.wh-gap-row');const s=tr.querySelector('[data-if="ship_orders"]');s.dispatchEvent(new Event('blur',{bubbles:true}));return 1})()`);
  await sleep(1300);
  const saved = await evJSON(`(()=>{const a=${AV};const cid='${gapCid}';const tr=a.querySelector('#whBody tr[data-row-cid="'+cid+'"]');
    return JSON.stringify({gapCid:cid,stillGap:!!(tr&&tr.classList.contains('wh-gap-row')),gapTotal:a.querySelectorAll('#whBody tr.wh-gap-row').length})})()`);
  ok('正常数据保存后该缺口行移出', gapCid !== 'NONE' && saved.stillGap === false, saved);

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  ws.close(); p.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
