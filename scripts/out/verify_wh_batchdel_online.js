// 线上工时批量删除 7 项功能追加验证（角色/列表/删除接口全 mock，不写库）
const { chromium } = require('playwright-core');
const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

async function loginAndGotoWorkhours(page) {
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
  await page.waitForTimeout(1500);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const delCalls = [];
  // 取真实 /auth/me 完整响应（含 menus/permissions），仅覆盖角色字段，避免破坏 SPA 菜单渲染
  const realMe = await (async () => {
    const lr = await (await fetch(BASE + '/api/auth/login?sharecode=' + SC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    })).json();
    return await (await fetch(BASE + '/api/auth/me?sharecode=' + SC, { headers: { 'X-ERP-Token': lr.token } })).json();
  })();
  const meFor = (code) => JSON.stringify({
    ...realMe,
    user: { ...realMe.user, role_code: code, role: code === 'super_admin' ? '超级管理员' : '管理员' },
  });
  try {
    const listRows = [
      { work_id: 9001, date: '2026-11-17', customer_name: '批量删除测试货主A', customer_id: 88001, ship_orders: 10, main_hours: 2, other_hours: 0, shared_hours: 0, status: 'archived', submitter: 'x' },
      { work_id: 9002, date: '2026-11-16', customer_name: '批量删除测试货主B', customer_id: 88002, ship_orders: 20, main_hours: 3, other_hours: 0, shared_hours: 0, status: 'archived', submitter: 'x' },
    ];
    // 共享 mock：角色由外部 setRole 切换（闭包变量）
    let role = 'super_admin';
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await page.route('**/api/auth/me**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: meFor(role) });
    });
    let listGets = 0;
    await page.route('**/api/workhours?**', async (route) => {
      if (route.request().method() === 'GET') {
        listGets++;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: listRows, total: listRows.length, page: 1, pageSize: 20, period: {} }) });
      } else await route.continue();
    });
    await page.route('**/api/workhours/batch**', async (route) => {
      delCalls.push(route.request().method());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: 1, notFound: 0 }) });
    });
    await page.route('**/api/customers/options**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });

    // ===== 第一轮：超管 =====
    console.log('===== 超级管理员 =====');
    role = 'super_admin';
    await loginAndGotoWorkhours(page);

    const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#statusFilter option')).map(o => ({ v: o.value, t: o.textContent.trim() })));
    ok(opts.length === 3 && opts.map(o => o.v).join(',') === 'pending,archived,all', '状态筛选三个选项（未归档/已归档/全部）', JSON.stringify(opts));
    ok(opts.some(o => o.v === 'all' && o.t.indexOf('全部') >= 0), '含「全部」选项');

    const delBtnVisibleSuper = await page.evaluate(() => { const b = document.getElementById('batchDelBtn'); return !!b && b.style.display !== 'none'; });
    ok(delBtnVisibleSuper, '超管可见「批量删除」按钮');

    // 切到已归档
    await page.selectOption('#statusFilter', 'archived');
    await page.waitForTimeout(2000);
    const activeStatus = await page.evaluate(() => document.getElementById('statusFilter').value);
    ok(activeStatus === 'archived', '切换到「已归档」视图', activeStatus);
    const ckHeader = await page.evaluate(() => !!document.querySelector('#whHead th.wh-ck') || !!document.querySelector('.wh-ck'));
    ok(ckHeader, 'archived 视图出现勾选列表头');
    const ckRows = await page.evaluate(() => document.querySelectorAll('#whBody input.wh-row-ck').length);
    ok(ckRows >= 1, 'archived 视图行内出现勾选框', 'rows=' + ckRows);

    // 勾选第一行
    const firstCk = await page.$('#whBody input.wh-row-ck');
    ok(!!firstCk, '存在可勾选行');
    if (firstCk) {
      await firstCk.check();
      await page.waitForTimeout(300);
      const checkedCnt = await page.evaluate(() => document.querySelectorAll('#whBody input.wh-row-ck:checked').length);
      ok(checkedCnt === 1, '勾选一行成功', 'checked=' + checkedCnt);

      // 点批量删除
      await page.click('#batchDelBtn');
      await page.waitForSelector('.modal.wh-confirm', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      const hasConfirm = !!await page.$('.modal.wh-confirm');
      ok(hasConfirm, '弹出二次确认弹窗');
      if (hasConfirm) {
        const cTitle = await page.evaluate(() => (document.querySelector('.modal.wh-confirm .modal-head') || {}).textContent || '');
        const cBody = await page.evaluate(() => (document.querySelector('.modal.wh-confirm .modal-body') || {}).textContent || '');
        ok(cTitle.indexOf('1 条') >= 0 && cBody.indexOf('1 条') >= 0, '确认弹窗显示删除数量 1', cTitle.trim() + ' | ' + cBody.trim().slice(0, 60));
        const okBtnText = await page.evaluate(() => (document.querySelector('.modal.wh-confirm .wh-ok') || {}).textContent || '');
        ok(okBtnText.indexOf('确认删除') >= 0, '确认按钮为「确认删除」', okBtnText.trim());

        // 点确认删除
        await page.click('.modal.wh-confirm .wh-ok');
        await page.waitForTimeout(1800);
        ok(delCalls.filter(m => m === 'DELETE').length === 1, '发起 1 次 DELETE /workhours/batch（mock 未写库）', delCalls.join(','));
        const bodyText = await page.evaluate(() => document.body.innerText || '');
        ok(bodyText.indexOf('已删除 1 条记录') >= 0, '成功 toast「已删除 1 条记录」');
        ok(listGets >= 2, '删除后重新请求列表（自动刷新）', 'GET 次数=' + listGets);
        const ckAfterDel = await page.evaluate(() => document.querySelectorAll('#whBody input.wh-row-ck:checked').length);
        ok(ckAfterDel === 0, '删除后勾选已清空');
      }
    }

    // 切筛选自动清空勾选
    const ckBeforeSwitch = await page.evaluate(() => document.querySelectorAll('#whBody input.wh-row-ck:checked').length);
    await page.selectOption('#statusFilter', 'all');
    await page.waitForTimeout(1500);
    const ckAfterSwitch = await page.evaluate(() => document.querySelectorAll('#whBody input.wh-row-ck:checked').length);
    ok(ckAfterSwitch === 0, '切换筛选状态自动清空勾选', 'before=' + ckBeforeSwitch + ' after=' + ckAfterSwitch);

    // ===== 第二轮：普通管理员（同页重设角色并重新加载触发 refreshRole）=====
    console.log('\n===== 普通管理员 =====');
    role = 'admin';
    delCalls.length = 0;
    // 重新进入页面（新 page 保证 refreshRole 重跑）
    const page2 = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await page2.route('**/api/auth/me**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: meFor('admin') });
    });
    await page2.route('**/api/workhours?**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: listRows, total: listRows.length, page: 1, pageSize: 20, period: {} }) });
      } else await route.continue();
    });
    await page2.route('**/api/customers/options**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });
    await loginAndGotoWorkhours(page2);
    const delBtnVisibleAdmin = await page2.evaluate(() => { const b = document.getElementById('batchDelBtn'); return !!b && b.style.display !== 'none'; });
    ok(!delBtnVisibleAdmin, '普通管理员「批量删除」按钮隐藏');
    // 非发货 pending 视图（收货）勾选列隐藏
    const recvTab = await page2.$('.wh-tab[data-tp="收货"]');
    if (recvTab) { await recvTab.click(); await page2.waitForTimeout(1500); }
    const ckHeaderAdmin = await page2.evaluate(() => !!document.querySelector('#whHead th.wh-ck') || !!document.querySelector('.wh-ck'));
    ok(!ckHeaderAdmin, '普通管理员在收货 pending 视图勾选列隐藏');
    const ckRowsAdmin = await page2.evaluate(() => document.querySelectorAll('#whBody input.wh-row-ck').length);
    ok(ckRowsAdmin === 0, '普通管理员收货视图无行内勾选框', 'rows=' + ckRowsAdmin);
    await page2.close();

    console.log('\n=== 汇总: PASS ' + pass + ' / FAIL ' + fail + ' ===');
  } catch (e) {
    console.log('ERR=' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 5).join('\n'));
    fail++;
  } finally {
    await browser.close();
  }
  process.exit(fail > 0 ? 1 : 0);
})();
