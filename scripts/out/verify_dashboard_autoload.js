// 复核：看板在「全新加载页面」时自动发出一次 /api/dashboard/summary（未点刷新）
const { chromium } = require('playwright-core');
const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const reqs = [];
  page.on('request', (r) => { if (r.url().indexOf('/api/dashboard/summary') >= 0) reqs.push(r.url()); });
  try {
    await page.goto(BASE + '/?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const u = await page.$('input[name="username"], #username, #loginUser');
    const p = await page.$('input[type="password"]');
    await u.fill('admin');
    await p.fill('admin123');
    await page.click('button[type="submit"], #loginBtn, .login-btn');
    await page.waitForTimeout(3000);

    // ★ 全新加载看板页（不做任何点击），记录该页加载后发生的请求
    reqs.length = 0;
    await page.goto(BASE + '/app.html?sharecode=' + SC + '#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('#dbDatePicker');
      return el && el.querySelector('.drp-mode');
    }, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3500);

    const dom = await page.evaluate(() => ({
      mode: (document.querySelector('#dbDatePicker select.drp-mode') || {}).value || null,
      trigger: (document.querySelector('#dbDatePicker .drp-text') || {}).textContent || null,
      label: (document.querySelector('#dbPeriodLabel') || {}).textContent || '',
      err: Array.from(document.querySelectorAll('.db-err')).map(e => e.textContent.trim()),
      rows: ['shipping', 'receiving', 'internal', 'logistics'].map(k => {
        const b = document.querySelector('#db-' + k);
        const t = b ? b.querySelector('table.db-table') : null;
        return k + '=' + (t ? t.querySelectorAll('tbody tr').length : 0);
      }).join(' '),
    }));
    console.log('REQ 数 =', reqs.length);
    reqs.forEach((u, i) => console.log('  #' + (i + 1), u.replace(/^.*\/api/, '/api')));
    console.log('DOM |', JSON.stringify(dom));
    console.log(reqs.length >= 1 ? 'PASS | 页面加载自动发出 dashboard/summary 请求' : 'FAIL | 未捕获到自动请求');
    console.log(reqs[0] && reqs[0].indexOf('periodType=day') >= 0 ? 'PASS | 自动请求 periodType=day' : 'FAIL | 自动请求未带 periodType=day');
  } catch (e) {
    console.log('ERROR |', e.message);
  } finally {
    await browser.close();
  }
})();
