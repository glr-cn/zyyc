// 线上发货工时 Excel 导入归档冲突追加验证（全程 mock API，不写库）
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
function makeXlsx() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['日期', '客户名称', '发货单量', '主工时'],
    ['2026-11-18', '杭州绵绵的羊网络科技有限公司', 123, 8],
    ['2026-11-19', '测试新增货主001', 50, 4],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const importCalls = [];
  try {
    // ---- mock 两个导入接口（在页面脚本发起前拦截）----
    const previewBody = {
      data: [
        { line: 2, date: '2026-11-18', customer_name: '杭州绵绵的羊网络科技有限公司', ship_orders: 123, main_hours: 8, duplicate: true, archived_conflict: true, existing: { work_id: 999, status: 'archived', ship_orders: 120, main_hours: 8 }, decision: 'blocked' },
        { line: 3, date: '2026-11-19', customer_name: '测试新增货主001', ship_orders: 50, main_hours: 4, duplicate: false, archived_conflict: false, existing: null, decision: 'create' },
      ],
      errors: [], warehouse: '龙湖仓',
      duplicateCount: 1, archivedConflictCount: 1, createCount: 1,
    };
    const commitBody = {
      created: 1, overwritten: 0, skipped: 0, archived_blocked: 1, errors: [],
      warn: '有 1 行与已归档数据冲突，已自动跳过，未写入任何重复记录。请核对后调整 Excel 再导入。',
    };
    await page.route('**/api/workhours/import/preview**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(previewBody) });
    });
    await page.route('**/api/workhours/import?*', async (route) => {
      if (route.request().method() === 'POST') {
        importCalls.push(route.request().method() + ' import');
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(commitBody) });
      } else await route.continue();
    });

    // ---- 登录 ----
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

    // ---- 进入龙湖仓发货工时 ----
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
    const shipTab = await page.$('.wh-tab[data-tp="发货"]');
    if (shipTab) { await shipTab.click(); await page.waitForTimeout(1800); }
    const activeTab = await page.evaluate(() => (document.querySelector('.wh-tab.active') || {}).textContent || '');
    ok(activeTab.indexOf('发货') >= 0, '处于发货工时页', activeTab.trim());

    const rowsBefore = await page.evaluate(() => document.querySelectorAll('#whBody tr[data-row-idx]').length);

    // ---- 注入 xlsx 到隐藏 file input，触发预览 ----
    const buf = makeXlsx();
    const fi = await page.$('#importFile');
    ok(!!fi, '存在导入文件输入 #importFile');
    if (!fi) throw new Error('no #importFile');
    await fi.setInputFiles({ name: 'dup_test.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: buf });
    await page.waitForSelector('.modal.imp-confirm', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const hasModal = !!await page.$('.modal.imp-confirm');
    ok(hasModal, '弹出导入预览弹窗');

    if (hasModal) {
      const modal = await page.evaluate(() => {
        const m = document.querySelector('.modal.imp-confirm');
        return {
          text: (m.innerText || ''),
          stopTags: m.querySelectorAll('.cust-tag-stop').length,
          blockedRows: m.querySelectorAll('tr.imp-blocked').length,
          blockedTag: m.querySelectorAll('.imp-blocked-tag').length,
          cntDup: Array.from(m.querySelectorAll('.cnt-dup')).map(e => e.textContent.trim()),
        };
      });
      ok(modal.stopTags >= 1, '预览含红色「归档冲突」标签', 'stopTags=' + modal.stopTags);
      ok(modal.blockedRows >= 1, '预览含 .imp-blocked 冲突行', 'rows=' + modal.blockedRows);
      ok(modal.blockedTag >= 1, '冲突行显示「已归档·禁止导入」', 'tags=' + modal.blockedTag);
      ok(modal.text.indexOf('1 行已归档冲突') >= 0 || modal.text.indexOf('归档冲突') >= 0, '预览提示归档冲突数量', modal.text.slice(0, 120).replace(/\n/g, '|'));
      ok(modal.cntDup.indexOf('1') >= 0, '汇总计数显示归档冲突 1 行', modal.cntDup.join('/'));

      // ---- 点确认导入 ----
      const okBtn = await page.$('.modal.imp-confirm .imp-ok');
      ok(!!okBtn, '存在确认导入按钮');
      if (okBtn) {
        await okBtn.click();
        await page.waitForTimeout(1800);
        ok(importCalls.length === 1, '确认后发起 1 次导入请求（mock 未写库）', importCalls.join(','));
        const bodyText = await page.evaluate(() => document.body.innerText || '');
        ok(bodyText.indexOf('有 1 条与已归档数据冲突已被拦截') >= 0, 'toast 含拦截数量文案');
        const rowsAfter = await page.evaluate(() => document.querySelectorAll('#whBody tr[data-row-idx]').length);
        ok(rowsAfter === rowsBefore, '列表未新增重复行', 'before=' + rowsBefore + ' after=' + rowsAfter);
      }
    }

    console.log('\n=== 汇总: PASS ' + pass + ' / FAIL ' + fail + ' ===');
  } catch (e) {
    console.log('ERR=' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
    fail++;
  } finally {
    await browser.close();
  }
  process.exit(fail > 0 ? 1 : 0);
})();
