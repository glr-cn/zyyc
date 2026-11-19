// 线上工时 pager 每页行数下拉追加验证（列表接口 mock，不写库）
const { chromium } = require('playwright-core');
const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const reqLog = [];
  try {
    const TOTAL = 500;
    await page.route('**/api/workhours?**', async (route) => {
      const url = new URL(route.request().url());
      const size = Number(url.searchParams.get('pageSize') || 20);
      const pg = Number(url.searchParams.get('page') || 1);
      const st = url.searchParams.get('status') || 'pending';
      reqLog.push({ size, pg, st });
      const n = Math.min(size, TOTAL);
      const data = Array.from({ length: n }, (_, i) => ({
        work_id: 90000 + i, date: '2026-11-17', customer_name: '分页测试货主' + (i % 50),
        customer_id: 88000 + (i % 50), ship_orders: 10, main_hours: 2, other_hours: 0,
        shared_hours: 0, status: 'archived', submitter: 'x',
      }));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, total: TOTAL, page: pg, pageSize: size, period: {} }) });
    });
    await page.route('**/api/customers/options**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });

    // 登录 + 进入龙湖仓发货工时
    await page.goto(BASE + '/?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2200);
    const u = await page.$('input[name="username"],#username,#loginUser');
    const pw = await page.$('input[type="password"]');
    if (u && pw) {
      await u.fill('admin'); await pw.fill('admin123');
      const btn = await page.$('button[type="submit"],#loginBtn,.login-btn');
      if (btn) await btn.click();
      await page.waitForTimeout(3200);
    }
    if (await page.$('input[type="password"]')) await page.waitForTimeout(3000);
    await page.goto(BASE + '/app.html?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => { location.hash = '#/wh_lh'; });
    await page.waitForTimeout(2500);
    if (!await page.$('#whTable')) {
      for (let a = 0; a < 3 && !await page.$('#whTable'); a++) {
        for (const el of await page.$$('a,button,li,span,div')) {
          const t = (await (await el.getProperty('textContent')).jsonValue() || '').trim();
          if (t === '工时') { await el.hover().catch(() => {}); break; }
        }
        await page.waitForTimeout(700);
        for (const el of await page.$$('a,button,li,span,div')) {
          const t = (await (await el.getProperty('textContent')).jsonValue() || '').trim();
          if (t.indexOf('龙湖仓工时') >= 0 && t.length < 14) { await el.click().catch(() => {}); break; }
        }
        await page.waitForTimeout(1800);
      }
    }
    await page.waitForSelector('#whTable', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const shipTab = await page.$('.wh-tab[data-tp="发货"]');
    if (shipTab) { await shipTab.click(); await page.waitForTimeout(1000); }
    // 切 archived（普通列表渲染，行数严格=pageSize，规避 pending 缺口行机制）
    await page.selectOption('#statusFilter', 'archived');
    await page.waitForTimeout(1800);

    console.log('=== pager 下拉结构 ===');
    const sel = await page.evaluate(() => {
      const s = document.querySelector('#pager #pageSizeSel');
      if (!s) return null;
      return {
        options: Array.from(s.querySelectorAll('option')).map(o => ({ v: o.value, t: o.textContent.trim(), sel: o.selected })),
        value: s.value,
      };
    });
    ok(!!sel, 'pager 区域存在每页行数下拉 #pageSizeSel');
    if (sel) {
      const vals = sel.options.map(o => Number(o.v));
      ok(vals.join(',') === '20,50,100,200,500,1000', '选项升序 20/50/100/200/500/1000', vals.join(','));
      ok(sel.options.every(o => o.t.indexOf('条/页') >= 0), '选项文案含「条/页」');
      ok(sel.value === '20', '默认 20 条/页', sel.value);
    }

    console.log('\n=== 依次切换 20→50→100→200 ===');
    for (const target of [50, 100, 200]) {
      const before = reqLog.length;
      await page.selectOption('#pageSizeSel', String(target));
      await page.waitForTimeout(1500);
      const last = reqLog[reqLog.length - 1];
      ok(reqLog.length > before && last && last.size === target && last.pg === 1,
        `切到 ${target}：请求 pageSize=${target} 且 page 重置为 1`, last ? `size=${last.size} page=${last.pg}` : '无请求');
      const rowCnt = await page.evaluate(() => document.querySelectorAll('#whBody tr').length);
      ok(rowCnt === target, `切到 ${target}：表格行数=${target}`, '实际=' + rowCnt);
      const cur = await page.evaluate(() => document.querySelector('#pageSizeSel').value);
      ok(cur === String(target), `切到 ${target}：下拉显示值一致`, cur);
      // 翻页按钮状态（total=500：target=200 → 3页，page1：上一页禁用/下一页可用）
      const btns = await page.evaluate(() => {
        const bs = Array.from(document.querySelectorAll('#pager button'));
        return bs.map(b => ({ t: b.textContent.trim(), d: b.disabled }));
      });
      const prev = btns.find(b => b.t === '上一页');
      const next = btns.find(b => b.t === '下一页');
      ok(prev && prev.d === true, `切到 ${target}：第1页「上一页」禁用`, prev ? 'disabled=' + prev.d : '无');
      ok(next && next.d === false, `切到 ${target}：「下一页」可用`, next ? 'disabled=' + next.d : '无');
    }

    console.log('\n=== JS 异常 ===');
    ok(pageErrors.length === 0, '无 JS 报错', pageErrors.slice(0, 3).join(' || '));

    console.log('\n=== 汇总: PASS ' + pass + ' / FAIL ' + fail + ' ===');
  } catch (e) {
    console.log('ERR=' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 5).join('\n'));
    fail++;
  } finally {
    await browser.close();
  }
  process.exit(fail > 0 ? 1 : 0);
})();
