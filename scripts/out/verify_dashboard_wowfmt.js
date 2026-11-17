// 线上追加验证：看板环比列 2 位小数（工时/时效/成本列仍 3 位小数）
//  说明：线上工时数据全部集中在 2026-11，无上期归档 → 后端 *_wow 全为 null → 界面环比列显示「-」。
//        因此本脚本除核对 DOM 渲染外，还直接取线上部署的 dashboard.js 源码执行 wowCell(12.345) 验证格式。
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

    // ============ 1) DOM 现状：环比列 + 3 位小数列 ============
    const dom = await page.evaluate(() => {
      const wows = Array.from(document.querySelectorAll('.db-table .wow'));
      const pctBad = wows.filter(e => /\d+\.\d{3}%/.test(e.textContent)).map(e => e.textContent.trim());
      const pctOk = wows.filter(e => /\d+\.\d{2}%/.test(e.textContent)).map(e => e.textContent.trim());
      const numCells = Array.from(document.querySelectorAll('#db-shipping table.db-table tbody td.num'))
        .map(e => e.textContent.trim()).filter(t => /\d\.\d{3}$/.test(t));
      const labels = Array.from(document.querySelectorAll('#db-shipping table.db-table thead th')).map(e => e.textContent.trim());
      const costIdx = labels.indexOf('单均成本(元)');
      const costVals = costIdx >= 0 ? Array.from(document.querySelectorAll('#db-shipping table.db-table tbody tr'))
        .slice(0, 5).map(tr => (tr.children[costIdx] ? tr.children[costIdx].textContent.trim() : '')) : [];
      return {
        wowTotal: wows.length,
        pctBad, pctOk,
        num3Count: numCells.length,
        num3Sample: numCells.slice(0, 5),
        costVals,
        wowSample: wows.slice(0, 6).map(e => e.textContent.trim()),
      };
    });
    console.log('DOM | wow 单元格 =', dom.wowTotal, ' 3位小数百分比 =', JSON.stringify(dom.pctBad), ' 2位小数百分比 =', JSON.stringify(dom.pctOk));
    console.log('DOM | 3位小数数值列样例 =', JSON.stringify(dom.num3Sample), ' 单均成本列 =', JSON.stringify(dom.costVals));
    ok(dom.pctBad.length === 0, '★ 界面上不存在 3 位小数的百分比（环比已改 2 位）', JSON.stringify(dom.pctBad));
    ok(dom.num3Count > 0, '★ 工时/时效/成本列仍保持 3 位小数', dom.num3Count + ' 个，样例=' + JSON.stringify(dom.num3Sample));

    // ============ 2) 直接执行线上部署的 wowCell 验证格式 ============
    const fmt = await page.evaluate(async () => {
      const src = await (await fetch('/js/dashboard.js')).text();
      const m = src.match(/function wowCell\(v\)\s*\{[\s\S]*?\n  \}/);
      if (!m) return { found: false };
      const fn = new Function(m[0] + ' return wowCell;')();
      return {
        found: true,
        has2: src.indexOf('toFixed(2)') >= 0,
        has3: src.indexOf('toFixed(3)') >= 0,
        out12345: fn(12.345),
        outNeg: fn(-8.567),
        outZero: fn(0),
        outNull: fn(null),
        html12345: fn(12.345),
      };
    });
    console.log('FMT |', JSON.stringify(fmt));
    ok(fmt.found && fmt.has2, '★ 线上部署的 dashboard.js 含 2 位小数格式化');
    ok(fmt.has3, '★ 线上部署的 dashboard.js 仍保留 3 位小数（工时/时效/成本列）');
    if (fmt.found) {
      ok(/12\.35%/.test(fmt.out12345) && !/12\.345%/.test(fmt.out12345), '★ wowCell(12.345) → 12.35%', fmt.out12345);
      ok(/8\.57%/.test(fmt.outNeg) && /↓/.test(fmt.outNeg), '★ 负数环比带 ↓ 且 2 位小数', fmt.outNeg);
      ok(/0\.00%/.test(fmt.outZero), '★ 零值环比显示 0.00%', fmt.outZero);
      ok(/^-/.test(String(fmt.outNull).replace(/<[^>]+>/g, '')), '★ null 环比仍显示 -', fmt.outNull);
    }

    await page.screenshot({ path: OUT + 'verify_dashboard_wowfmt.png', fullPage: true });
    console.log('SHOT | ' + OUT + 'verify_dashboard_wowfmt.png');
  } catch (e) {
    console.log('ERROR |', e.message);
    try { await page.screenshot({ path: OUT + 'verify_dashboard_wowfmt_err.png' }); } catch (x) {}
  } finally {
    await browser.close();
    console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
  }
})();
