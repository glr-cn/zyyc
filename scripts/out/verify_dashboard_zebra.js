// 线上追加验证：看板仓库 tabs 传参修复（API.get 第二参数）+ 四表斑马线
//  1) 切换 龙湖仓 / 佳新仓 → 每次 /api/dashboard/summary 请求 URL 都必须带 warehouse=xxx
//  2) 四个表格偶数行单元格有浅灰背景 #f9f9f9（斑马线）
const { chromium } = require('playwright-core');

const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'scripts/out/';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra !== undefined ? ' | ' + extra : ''));
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const reqs = [];
  page.on('request', (r) => { if (r.url().indexOf('dashboard/summary') >= 0) reqs.push(r.url()); });
  try {
    await page.goto(BASE + '/?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    const userSel = await page.$('input[name="username"], #username, #loginUser');
    const pwdSel = await page.$('input[type="password"]');
    if (!userSel || !pwdSel) { console.log('FAIL | 未找到登录输入框'); await browser.close(); return; }
    await userSel.fill('admin');
    await pwdSel.fill('admin123');
    await page.click('button[type="submit"], #loginBtn, .login-btn');
    await page.waitForTimeout(3500);

    await page.evaluate(() => { location.hash = '#dashboard'; });
    await page.waitForFunction(() => {
      const s = document.querySelector('#db-shipping');
      return s && (s.querySelector('table.db-table') || s.querySelector('.db-err'));
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log('INFO | 初始请求数 =', reqs.length, ' 首个 =', reqs[reqs.length - 1] || '(无)');

    // ============ 1) 切换仓库 tabs，检查请求参数 ============
    const checkTab = async (wh) => {
      const before = reqs.length;
      await page.click('#dbWhTabs button[data-wh="' + wh + '"]');
      await page.waitForTimeout(3000);
      const fresh = reqs.slice(before);
      const url = fresh.length ? fresh[fresh.length - 1] : '';
      const parsed = url ? new URL(url) : null;
      const got = parsed ? parsed.searchParams.get('warehouse') : null;
      console.log('NET | 切到 ' + wh + ' → 新请求 ' + fresh.length + ' 条: ' + url);
      ok(fresh.length > 0, '★ 切换 ' + wh + ' 触发了 summary 请求', '条数=' + fresh.length);
      ok(got === wh, '★ 请求 URL 带 warehouse=' + wh + '（非空且正确）', '实际=' + got);
      ok(parsed ? parsed.searchParams.get('periodType') !== null : false, '★ 请求同时带 periodType', parsed ? parsed.searchParams.get('periodType') : 'null');
      return got;
    };
    await checkTab('佳新仓');
    await checkTab('龙湖仓');

    // ============ 2) 四表斑马线（偶数行浅灰底） ============
    const zebra = await page.evaluate(() => {
      const out = [];
      ['shipping', 'receiving', 'internal', 'logistics'].forEach(k => {
        const box = document.querySelector('#db-' + k);
        const trs = box ? Array.from(box.querySelectorAll('table.db-table tbody tr')) : [];
        const rows = trs.slice(0, 4).map((tr, i) => {
          const td = tr.querySelector('td');
          return { i: i + 1, bg: td ? getComputedStyle(td).backgroundColor : null, text: tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 24) };
        });
        out.push({ k, total: trs.length, rows });
      });
      return out;
    });
    zebra.forEach(g => {
      console.log('ZEBRA | [' + g.k + '] 总行数=' + g.total + ' ' + JSON.stringify(g.rows));
      if (g.total >= 2) {
        const odd = g.rows[0].bg, even = g.rows[1].bg;
        ok(even === 'rgb(249, 249, 249)', '★ [' + g.k + '] 偶数行浅灰底 #f9f9f9', 'odd=' + odd + ' even=' + even);
        ok(odd !== even, '★ [' + g.k + '] 奇偶行背景不同（斑马线生效）', odd + ' vs ' + even);
      } else {
        console.log('SKIP | [' + g.k + '] 行数不足 2，无法验证斑马线');
      }
    });

    // ============ 3) 环比箭头/颜色抽查 ============
    const wow = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.db-table .wow')).slice(0, 6);
      return items.map(e => ({ text: e.textContent.trim(), cls: e.className, color: getComputedStyle(e).color }));
    });
    console.log('WOW |', JSON.stringify(wow));

    await page.screenshot({ path: OUT + 'verify_dashboard_zebra.png', fullPage: true });
    console.log('SHOT | ' + OUT + 'verify_dashboard_zebra.png');
  } catch (e) {
    console.log('ERROR |', e.message);
    try { await page.screenshot({ path: OUT + 'verify_dashboard_zebra_err.png' }); } catch (x) {}
  } finally {
    await browser.close();
    console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
  }
})();
