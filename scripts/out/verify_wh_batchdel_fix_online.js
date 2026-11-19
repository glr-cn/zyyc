// 线上批量删除审计修复追加验证（角色/列表/删除接口 mock，不写库）
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
  const delCalls = [];
  const realMe = await (async () => {
    const lr = await (await fetch(BASE + '/api/auth/login?sharecode=' + SC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    })).json();
    return await (await fetch(BASE + '/api/auth/me?sharecode=' + SC, { headers: { 'X-ERP-Token': lr.token } })).json();
  })();
  const meFor = (code) => JSON.stringify({
    ...realMe, user: { ...realMe.user, role_code: code, role: '超级管理员' },
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  try {
    let live = [
      { work_id: 97001, date: '2026-11-18', customer_name: '批量删除修复测试A', customer_id: 97001, ship_orders: 10, main_hours: 2, other_hours: 0, shared_hours: 0, status: 'archived', submitter: 'x' },
      { work_id: 97002, date: '2026-11-17', customer_name: '批量删除修复测试B', customer_id: 97002, ship_orders: 20, main_hours: 3, other_hours: 0, shared_hours: 0, status: 'archived', submitter: 'x' },
    ];
    await page.route('**/api/auth/me**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: meFor('super_admin') });
    });
    await page.route('**/api/workhours?**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: live, total: live.length, page: 1, pageSize: 20, period: {} }) });
      } else await route.continue();
    });
    await page.route('**/api/workhours/batch**', async (route) => {
      const ids = JSON.parse(route.request().postData() || '{}').ids || [];
      delCalls.push({ method: route.request().method(), ids });
      live = live.filter(r => !ids.map(Number).includes(r.work_id));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, deleted: ids.length, notFound: 0 }) });
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
    await page.selectOption('#statusFilter', 'archived');
    await page.waitForTimeout(1800);

    console.log('=== 其他功能入口仍在（UI 存在性）===');
    const entries = await page.evaluate(() => ({
      importBtn: !!document.getElementById('importBtn'),
      batchDelBtn: !!document.getElementById('batchDelBtn') && document.getElementById('batchDelBtn').style.display !== 'none',
      pageSizeSel: !!document.getElementById('pageSizeSel'),
      statusFilter: !!document.getElementById('statusFilter'),
    }));
    ok(entries.importBtn, '导入 Excel 入口仍在');
    ok(entries.batchDelBtn, '批量删除按钮超管可见');
    ok(entries.pageSizeSel && entries.statusFilter, '每页行数/状态筛选仍在');

    console.log('\n=== 批量删除 2 条 ===');
    const ckBoxes = await page.$$('#whBody input.wh-row-ck');
    ok(ckBoxes.length === 2, '列表显示 2 条可勾选归档行', 'rows=' + ckBoxes.length);
    for (const c of ckBoxes) await c.check();
    await page.waitForTimeout(300);
    const checked = await page.evaluate(() => document.querySelectorAll('#whBody input.wh-row-ck:checked').length);
    ok(checked === 2, '勾选 2 条', 'checked=' + checked);
    await page.click('#batchDelBtn');
    await page.waitForSelector('.modal.wh-confirm', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);
    const confirmTxt = await page.evaluate(() => (document.querySelector('.modal.wh-confirm') || {}).innerText || '');
    ok(confirmTxt.indexOf('2 条') >= 0, '二次确认弹窗显示数量 2', confirmTxt.slice(0, 80).replace(/\n/g, '|'));
    await page.click('.modal.wh-confirm .wh-ok');
    await page.waitForTimeout(1800);
    ok(delCalls.length === 1 && delCalls[0].method === 'DELETE' && delCalls[0].ids.length === 2,
      '发起 1 次 DELETE /workhours/batch 携带 2 个 id（mock 未写库）', JSON.stringify(delCalls));
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    ok(bodyText.indexOf('已删除 2 条记录') >= 0, '成功 toast「已删除 2 条记录」');
    const rowsAfter = await page.evaluate(() => document.querySelectorAll('#whBody input.wh-row-ck').length);
    ok(rowsAfter === 0, '列表刷新后两条消失', '剩余行=' + rowsAfter);
    const emptyTxt = await page.evaluate(() => (document.querySelector('#whBody') || {}).innerText || '');
    ok(emptyTxt.indexOf('暂无') >= 0 || rowsAfter === 0, '列表显示空状态');
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
