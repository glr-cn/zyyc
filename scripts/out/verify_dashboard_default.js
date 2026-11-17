// 线上追加验证：看板初始化默认值 = 按日 + 当天
//  1) 时间维度下拉默认选中「按日」
//  2) DateRangePicker trigger 按钮文本直接是今天日期（不是「选择日期范围」占位）
//  3) 页面加载后无需手动点刷新，自动发出一次 /api/dashboard/summary 请求
//  4) #dbPeriodLabel 自动显示 本期:2026-11-17 上期:2026-11-16
const { chromium } = require('playwright-core');

const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'scripts/out/';

const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const TODAY = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
const YEST = (() => { const d = new Date(now.getTime() - 86400000); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); })();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra !== undefined ? ' | ' + extra : ''));
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const dashReqs = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/dashboard/summary') >= 0) dashReqs.push(u);
  });
  try {
    await page.goto(BASE + '/?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    // ---------- 登录 ----------
    const userSel = await page.$('input[name="username"], #username, #loginUser');
    const pwdSel = await page.$('input[type="password"]');
    if (!userSel || !pwdSel) { console.log('FAIL | 未找到登录输入框'); await browser.close(); return; }
    await userSel.fill('admin');
    await pwdSel.fill('admin123');
    await page.click('button[type="submit"], #loginBtn, .login-btn');
    await page.waitForTimeout(3500);

    // ---------- 进入看板（不做任何点击，等它自己加载） ----------
    dashReqs.length = 0;
    await page.evaluate(() => { location.hash = '#dashboard'; });
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => {
      const el = document.querySelector('#dbDatePicker');
      return el && el.querySelector('.drp-mode');
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // ============ 1) 默认按日 + trigger 显示今天 ============
    const drp = await page.evaluate(() => {
      const root = document.querySelector('#dbDatePicker');
      if (!root) return { exists: false };
      const sel = root.querySelector('select.drp-mode');
      const text = root.querySelector('.drp-text');
      const trig = root.querySelector('button.drp-trigger');
      return {
        exists: true,
        mode: sel ? sel.value : null,
        modeText: sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : null,
        triggerText: text ? text.textContent.trim() : null,
        triggerTitle: trig ? trig.getAttribute('title') : null,
        label: (document.querySelector('#dbPeriodLabel') || {}).textContent || '',
        groups: ['shipping', 'receiving', 'internal', 'logistics'].map(k => {
          const box = document.querySelector('#db-' + k);
          const err = box ? box.querySelector('.db-err') : null;
          const tbl = box ? box.querySelector('table.db-table') : null;
          return { k, err: err ? err.textContent.trim() : null, hasTable: !!tbl, rows: tbl ? tbl.querySelectorAll('tbody tr').length : 0 };
        }),
      };
    });
    console.log('DRP |', JSON.stringify(drp));
    console.log('TODAY =', TODAY, ' YEST =', YEST);

    ok(drp.exists, '★ #dbDatePicker 存在');
    ok(drp.mode === 'day', '★ 时间维度默认选中「按日」', 'value=' + drp.mode + ' text=' + drp.modeText);
    ok(drp.triggerText === TODAY, '★ trigger 按钮文本直接是今天日期（非占位符）', 'text=' + drp.triggerText + ' 期望=' + TODAY);
    ok(drp.triggerText !== '选择日期范围' && drp.triggerText !== '选择日', '★ trigger 不再显示「选择日期范围」占位', 'text=' + drp.triggerText);

    // ============ 2) 自动发出一次请求（未点刷新） ============
    console.log('REQ | 自动请求数 =', dashReqs.length, '| 首条 =', dashReqs[0] || '(无)');
    ok(dashReqs.length >= 1, '★ 页面加载后自动发出 /api/dashboard/summary 请求（无需手动刷新）', 'count=' + dashReqs.length);
    if (dashReqs.length) {
      const u = dashReqs[0];
      ok(u.indexOf('periodType=day') >= 0, '★ 自动请求带 periodType=day', u.replace(/^.*\/api/, '/api'));
      ok(u.indexOf('startDate=' + TODAY) >= 0 && u.indexOf('endDate=' + TODAY) >= 0, '★ 自动请求带当天 startDate/endDate', TODAY);
      ok(u.indexOf('warehouse=') >= 0 && u.indexOf('warehouse=&') < 0, '★ 自动请求带非空 warehouse', (u.match(/warehouse=([^&]*)/) || [])[1]);
    }

    // ============ 3) 期间标签自动显示 ============
    console.log('LABEL |', drp.label);
    const lab = (drp.label || '').replace(/\s+/g, ' ');
    ok(lab.indexOf('本期') >= 0 && lab.indexOf(TODAY) >= 0, '★ 期间标签含 本期:' + TODAY, lab);
    ok(lab.indexOf('上期') >= 0 && lab.indexOf(YEST) >= 0, '★ 期间标签含 上期:' + YEST, lab);

    // ============ 4) 四表渲染正常 ============
    drp.groups.forEach(g => {
      ok(g.hasTable && !g.err, '★ [' + g.k + '] 表格渲染正常（无加载失败）', 'err=' + g.err + ' 行数=' + g.rows);
    });

    // ============ 5) 点刷新后仍正常（回归） ============
    await page.click('#dbRefresh');
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => {
      const out = { label: (document.querySelector('#dbPeriodLabel') || {}).textContent || '', groups: [] };
      ['shipping', 'receiving', 'internal', 'logistics'].forEach(k => {
        const box = document.querySelector('#db-' + k);
        const err = box ? box.querySelector('.db-err') : null;
        const tbl = box ? box.querySelector('table.db-table') : null;
        out.groups.push({ k, err: err ? err.textContent.trim() : null, hasTable: !!tbl, rows: tbl ? tbl.querySelectorAll('tbody tr').length : 0 });
      });
      return out;
    });
    console.log('RELOAD |', after.label);
    after.groups.forEach(g => {
      ok(g.hasTable && !g.err, '★ 刷新后 [' + g.k + '] 表格重载成功', 'err=' + g.err + ' 行数=' + g.rows);
    });
    ok((after.label || '').indexOf(TODAY) >= 0, '★ 刷新后期间标签仍为今天', after.label);

    await page.screenshot({ path: OUT + 'verify_dashboard_default.png', fullPage: true });
    console.log('SHOT | ' + OUT + 'verify_dashboard_default.png');
  } catch (e) {
    console.log('ERROR |', e.message);
    try { await page.screenshot({ path: OUT + 'verify_dashboard_default_err.png' }); } catch (x) {}
  } finally {
    await browser.close();
    console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
  }
})();
