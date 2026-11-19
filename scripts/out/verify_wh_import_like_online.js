// 线上发货工时导入 LIKE 匹配口径追加验证（导入接口 mock，不写库）
// 场景1：已归档货主+已归档日期 → 预览红色归档冲突 → 整体拦截 → 零新增
// 场景2：同仓不同货主同日期 → 无冲突 → 正常导入
const { chromium } = require('playwright-core');
const XLSX = require('xlsx');
const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}
function makeXlsx(cust, date) {
  const ws = XLSX.utils.aoa_to_sheet([
    ['日期', '客户名称', '发货单量', '主工时'],
    [date, cust, 123, 8],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function gotoWorkhours(page) {
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
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const importCalls = [];
  let liveRows = [
    { work_id: 95001, date: '2026-11-18', customer_name: '已归档货主A', customer_id: 95001, ship_orders: 100, main_hours: 8, other_hours: 0, shared_hours: 0, status: 'archived', submitter: 'x' },
  ];
  try {
    // mock preview：按 xlsx 里货主名判断是否归档冲突（模拟 LIKE 匹配到"龙湖仓库"全称归档行）
    await page.route('**/api/workhours/import/preview**', async (route) => {
      const raw = route.request().postData() || '';
      const conflict = raw.indexOf('conflict.xlsx') >= 0; // 文件名区分：归档冲突场景
      let cust = conflict ? '已归档货主A' : '全新货主B', date = '2026-11-18';
      const data = [{
        line: 2, date, customer_name: cust, ship_orders: 123, main_hours: 8,
        duplicate: conflict, archived_conflict: conflict,
        existing: conflict ? { work_id: 95001, status: 'archived', ship_orders: 100, main_hours: 8 } : null,
        decision: conflict ? 'blocked' : 'create',
      }];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        data, errors: [], warehouse: '龙湖仓',
        duplicateCount: conflict ? 1 : 0, archivedConflictCount: conflict ? 1 : 0, createCount: conflict ? 0 : 1,
      }) });
    });
    // mock import：单行归档冲突 → 返回 409 整体拦截；否则成功新增（更新 liveRows）
    await page.route('**/api/workhours/import?*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      importCalls.push('POST import');
      const raw = route.request().postData() || '';
      const conflict = raw.indexOf('conflict.xlsx') >= 0;
      let cust = conflict ? '已归档货主A' : '全新货主B', date = '2026-11-18';
      if (conflict) {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
          error: '全部 1 行均与已归档数据冲突，导入已整体拦截。', code: 'IMPORT_ARCHIVED_CONFLICT',
          archivedConflictCount: 1, conflicts: [{ line: 2, date, shipper: cust }], detail: '第 2 行归档冲突',
        }) });
      } else {
        liveRows.push({ work_id: 96001, date, customer_name: cust, customer_id: 96001, ship_orders: 123, main_hours: 8, other_hours: 0, shared_hours: 0, status: 'archived', submitter: 'x' });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ created: 1, overwritten: 0, skipped: 0, archived_blocked: 0, errors: [], lines: [] }) });
      }
    });
    await page.route('**/api/workhours?**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: liveRows, total: liveRows.length, page: 1, pageSize: 20, period: {} }) });
      } else await route.continue();
    });
    await page.route('**/api/customers/options**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });

    // 登录
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
    await gotoWorkhours(page);

    // ===== 场景1：已归档货主 + 已归档日期 =====
    console.log('===== 场景1：已归档货主+日期（LIKE 命中） =====');
    const before1 = await page.evaluate(() => document.querySelectorAll('#whBody tr').length);
    await (await page.$('#importFile')).setInputFiles({ name: 'conflict.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: makeXlsx('已归档货主A', '2026-11-18') });
    await page.waitForSelector('.modal.imp-confirm', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const modal1 = await page.evaluate(() => {
      const m = document.querySelector('.modal.imp-confirm');
      return m ? { stop: m.querySelectorAll('.cust-tag-stop').length, blocked: m.querySelectorAll('tr.imp-blocked').length, text: (m.innerText || '') } : null;
    });
    ok(!!modal1, '弹出导入预览弹窗');
    if (modal1) {
      ok(modal1.stop >= 1, '预览含红色「归档冲突」标签', 'stop=' + modal1.stop);
      ok(modal1.blocked >= 1, '预览含 .imp-blocked 冲突行', 'blocked=' + modal1.blocked);
      ok(modal1.text.indexOf('归档冲突') >= 0, '预览提示归档冲突');
      await page.click('.modal.imp-confirm .imp-ok');
      await page.waitForTimeout(1600);
      const bodyTxt = await page.evaluate(() => document.body.innerText || '');
      ok(bodyTxt.indexOf('整体拦截') >= 0 || bodyTxt.indexOf('归档') >= 0 || bodyTxt.indexOf('导入失败') >= 0,
        '确认导入被整体拦截（错误提示）', bodyTxt.slice(-120).replace(/\n/g, '|'));
      const after1 = await page.evaluate(() => document.querySelectorAll('#whBody tr').length);
      ok(after1 === before1, '列表零新增', 'before=' + before1 + ' after=' + after1);
    }

    // ===== 场景2：同仓不同货主同日期 =====
    console.log('\n===== 场景2：同仓不同货主同日期（LIKE 不冲突） =====');
    // 直接移除所有残留遮罩（导入失败时预览弹窗不自动关闭）
    await page.evaluate(() => { document.querySelectorAll('.modal-overlay, .wh-err-mask').forEach(e => e.remove()); });
    await page.waitForTimeout(300);
    const before2 = await page.evaluate(() => document.querySelectorAll('#whBody tr').length);
    await (await page.$('#importFile')).setInputFiles({ name: 'newcust.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: makeXlsx('全新货主B', '2026-11-18') });
    await page.waitForSelector('.modal.imp-confirm', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const modal2 = await page.evaluate(() => {
      const m = document.querySelector('.modal.imp-confirm');
      return m ? { stop: m.querySelectorAll('.cust-tag-stop').length, blocked: m.querySelectorAll('tr.imp-blocked').length, text: (m.innerText || '') } : null;
    });
    ok(!!modal2, '弹出导入预览弹窗');
    if (modal2) {
      ok(modal2.stop === 0 && modal2.blocked === 0, '预览无归档冲突行', 'stop=' + modal2.stop + ' blocked=' + modal2.blocked);
      await page.locator('.modal.imp-confirm .imp-ok').last().click();
      await page.waitForTimeout(1600);
      const bodyTxt = await page.evaluate(() => document.body.innerText || '');
      ok(bodyTxt.indexOf('成功导入并归档 1 条记录') >= 0, 'toast 显示成功导入 1 条', bodyTxt.slice(-100).replace(/\n/g, '|'));
      const after2 = await page.evaluate(() => document.querySelectorAll('#whBody tr').length);
      ok(after2 === before2 + 1, '列表新增 1 行（正常导入）', 'before=' + before2 + ' after=' + after2);
    }
    ok(pageErrors.length === 0, '无 JS 报错', pageErrors.slice(0, 3).join(' || '));
    ok(importCalls.length === 2, '两次确认各发起 1 次导入请求（mock 未写库）', importCalls.join(','));

    console.log('\n=== 汇总: PASS ' + pass + ' / FAIL ' + fail + ' ===');
  } catch (e) {
    console.log('ERR=' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 5).join('\n'));
    fail++;
  } finally {
    await browser.close();
  }
  process.exit(fail > 0 ? 1 : 0);
})();
