// 线上看板追加验证：四分组全部渲染 + 无 .db-err + Console 无 [看板分摊- 调试日志
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
  const consoleMsgs = [];
  const pageErrors = [];
  page.on('console', m => consoleMsgs.push(m.type() + ':' + m.text()));
  page.on('pageerror', e => pageErrors.push(e.message));
  try {
    // 登录页
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

    // 进入应用并设置看板路由（应用加载后再设 hash，避免被弹回）
    await page.goto(BASE + '/app.html?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => { location.hash = '#/dashboard'; });
    await page.waitForTimeout(2500);
    // 兜底：真实菜单导航
    if (!await page.$('#db-shipping')) {
      for (let a = 0; a < 3 && !await page.$('#db-shipping'); a++) {
        for (const el of await page.$$('a,button,li,span,div')) {
          const t = (await (await el.getProperty('textContent')).jsonValue() || '').trim();
          if (t.indexOf('经营看板') >= 0 && t.length < 10) { await el.click().catch(() => {}); break; }
        }
        await page.waitForTimeout(1800);
      }
    }
    await page.waitForSelector('#db-shipping', { timeout: 20000 }).catch(() => {});
    // 等待四分组从"加载中…"变为表格或空提示
    await page.waitForFunction(() => {
      const ks = ['shipping', 'receiving', 'internal', 'logistics'];
      return ks.every(k => {
        const el = document.getElementById('db-' + k);
        if (!el) return false;
        const t = el.textContent || '';
        return t.indexOf('加载中') < 0;
      });
    }, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);

    console.log('\n=== 四分组渲染 ===');
    const groups = await page.evaluate(() => {
      const ks = ['shipping', 'receiving', 'internal', 'logistics'];
      const labels = { shipping: '发货', receiving: '收货', internal: '库内', logistics: '后勤' };
      return ks.map(k => {
        const el = document.getElementById('db-' + k);
        if (!el) return { k, label: labels[k], exists: false };
        return {
          k, label: labels[k], exists: true,
          hasErr: !!el.querySelector('.db-err'),
          errText: el.querySelector('.db-err') ? el.querySelector('.db-err').textContent.trim() : '',
          hasTable: !!el.querySelector('table.db-table'),
          hasEmpty: !!el.querySelector('.empty') || (el.textContent || '').indexOf('暂无') >= 0,
          text: (el.textContent || '').trim().slice(0, 30),
        };
      });
    });
    groups.forEach(g => {
      ok(g.exists, g.label + '组容器存在');
      if (g.exists) {
        ok(!g.hasErr, g.label + '组无 .db-err', g.hasErr ? g.errText : '');
        ok(g.hasTable || g.hasEmpty, g.label + '组正常渲染（表格或空提示）', g.text);
      }
    });

    console.log('\n=== Console 调试日志 ===');
    const allocLogs = consoleMsgs.filter(m => m.indexOf('看板分摊') >= 0 || m.indexOf('[看板分摊-') >= 0);
    ok(allocLogs.length === 0, 'Console 无 [看板分摊- 调试日志', allocLogs.slice(0, 5).join(' || '));
    ok(pageErrors.length === 0, '无未捕获页面异常', pageErrors.slice(0, 5).join(' || '));

    console.log('\n=== 汇总: PASS ' + pass + ' / FAIL ' + fail + ' ===');
    if (fail > 0) {
      console.log('--- console 全文(前30) ---');
      consoleMsgs.slice(0, 30).forEach(m => console.log('  ' + m.slice(0, 200)));
    }
  } catch (e) {
    console.log('ERR=' + e.message);
    fail++;
  } finally {
    await browser.close();
  }
  process.exit(fail > 0 ? 1 : 0);
})();
