// 线上追加验证：看板顶部日期筛选器已替换为全局 DateRangePicker 高级组件
//  1) #dbDatePicker 是 .drp 高级组件（select.drp-mode + button.drp-trigger），不再是原生 input[type=date]
//  2) 切到「按周」→ 面板出现「2026 第XX周 · MM/DD~MM/DD」格式的周列表
//  3) 选一个月 → 点刷新 → 四个表格重载
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

    // ---------- 登录 ----------
    const userSel = await page.$('input[name="username"], #username, #loginUser');
    const pwdSel = await page.$('input[type="password"]');
    if (!userSel || !pwdSel) { console.log('FAIL | 未找到登录输入框'); await browser.close(); return; }
    await userSel.fill('admin');
    await pwdSel.fill('admin123');
    await page.click('button[type="submit"], #loginBtn, .login-btn');
    await page.waitForTimeout(3500);
    console.log('INFO | 登录后 URL =', page.url());

    // ---------- 进入看板 ----------
    await page.evaluate(() => { location.hash = '#dashboard'; });
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => {
      const el = document.querySelector('#dbDatePicker');
      return el && el.querySelector('.drp-mode');
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // ============ 1) 高级日期组件结构 ============
    const drp = await page.evaluate(() => {
      const root = document.querySelector('#dbDatePicker');
      if (!root) return { exists: false };
      const sel = root.querySelector('select.drp-mode');
      const trig = root.querySelector('button.drp-trigger');
      const text = root.querySelector('.drp-text');
      const panel = root.querySelector('.drp-panel');
      const pageNativeDates = document.querySelectorAll('.db-filter input[type="date"], .db-wrap input[type="date"]').length;
      return {
        exists: true,
        isDrp: root.classList.contains('drp'),
        modeOptions: sel ? Array.from(sel.options).map(o => o.value + '/' + o.textContent.trim()) : [],
        hasTrigger: !!trig,
        triggerText: text ? text.textContent.trim() : null,
        hasPanel: !!panel,
        panelHidden: panel ? panel.classList.contains('drp-hidden') : null,
        nativeDateInputs: root.querySelectorAll('input[type="date"]').length,
        pageNativeDates,
        label: (document.querySelector('#dbPeriodLabel') || {}).textContent || '',
      };
    });
    console.log('DRP |', JSON.stringify(drp));
    ok(drp.exists && drp.isDrp, '★ #dbDatePicker 渲染为 .drp 高级组件');
    ok(drp.hasTrigger && drp.hasPanel, '★ 含 trigger 按钮与浮层面板');
    ok(drp.modeOptions.join(',') === 'day/按日,week/按周,month/按月', '★ 时间维度下拉含 按日/按周/按月', JSON.stringify(drp.modeOptions));
    ok(drp.nativeDateInputs === 0 && drp.pageNativeDates === 0, '★ 顶部已无原生 input[type=date]', 'picker内=' + drp.nativeDateInputs + ' 页面内=' + drp.pageNativeDates);

    // ============ 2) 切到「按周」 ============
    await page.selectOption('#dbDatePicker select.drp-mode', 'week');
    await page.waitForTimeout(800);
    await page.click('#dbDatePicker button.drp-trigger');
    await page.waitForTimeout(900);
    const week = await page.evaluate(() => {
      const panel = document.querySelector('#dbDatePicker .drp-panel');
      const list = panel ? panel.querySelector('.drp-list-week') : null;
      const items = list ? Array.from(list.querySelectorAll('.drp-list-item')) : [];
      return {
        panelVisible: panel ? !panel.classList.contains('drp-hidden') : false,
        listCls: list ? list.className : null,
        count: items.length,
        labels: items.map(i => i.textContent.trim()),
        sample: items.length ? items[items.length - 1].textContent.trim() : '',
      };
    });
    console.log('WEEK | 项数 =', week.count, ' 样例 =', week.sample, ' 首项 =', week.labels[0]);
    ok(week.panelVisible && week.listCls && week.listCls.indexOf('drp-list-week') >= 0, '★ 按周面板渲染出周列表');
    ok(week.count > 0 && week.labels.every(l => /^\d{4} 第\d+周 · \d{2}\/\d{2}~\d{2}\/\d{2}$/.test(l)), '★ 周标签格式为「2026 第XX周 · MM/DD~MM/DD」', week.sample);
    ok(/^\d{4} 第\d+周 · /.test(week.sample), '★ 存在 2026 开头��周次标签', week.sample);

    // 选一个周（当前周/最后一项）
    await page.evaluate(() => {
      const items = document.querySelectorAll('#dbDatePicker .drp-list-week .drp-list-item');
      const last = items[items.length - 1];
      if (last) last.click();
    });
    await page.waitForTimeout(900);
    const afterWeek = await page.evaluate(() => {
      const text = document.querySelector('#dbDatePicker .drp-text');
      const panel = document.querySelector('#dbDatePicker .drp-panel');
      return {
        text: text ? text.textContent.trim() : null,
        closed: panel ? panel.classList.contains('drp-hidden') : null,
      };
    });
    console.log('WEEK | 选中后 trigger 文本 =', afterWeek.text);
    ok(/^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/.test(afterWeek.text || ''), '★ 选中周后显示日期区间', afterWeek.text);

    // ============ 3) 选一个月 → 刷新 → 四表重载 ============
    await page.selectOption('#dbDatePicker select.drp-mode', 'month');
    await page.waitForTimeout(800);
    await page.click('#dbDatePicker button.drp-trigger');
    await page.waitForTimeout(900);
    const month = await page.evaluate(() => {
      const list = document.querySelector('#dbDatePicker .drp-list-month');
      const items = list ? Array.from(list.querySelectorAll('.drp-list-item')) : [];
      return { count: items.length, labels: items.map(i => i.textContent.trim()) };
    });
    console.log('MONTH | 项数 =', month.count, ' 样例 =', month.labels[month.labels.length - 1]);
    ok(month.count > 0 && month.labels.every(l => /^\d{4}年\d{1,2}月$/.test(l)), '★ 月份列表格式为「2026年11月」', month.labels[month.labels.length - 1]);

    await page.evaluate(() => {
      const items = document.querySelectorAll('#dbDatePicker .drp-list-month .drp-list-item');
      const target = Array.from(items).find(i => i.textContent.trim() === '2026年11月') || items[items.length - 1];
      if (target) target.click();
    });
    await page.waitForTimeout(900);
    const afterMonth = await page.evaluate(() => {
      const text = document.querySelector('#dbDatePicker .drp-text');
      return { text: text ? text.textContent.trim() : null };
    });
    console.log('MONTH | 选中后 trigger 文本 =', afterMonth.text);
    ok(/^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/.test(afterMonth.text || ''), '★ 选中月后显示该月起止', afterMonth.text);

    // 点刷新 → 四表重载
    const before = await page.evaluate(() => {
      const t = document.querySelector('#db-shipping table.db-table');
      return { html: t ? t.innerHTML.length : 0, label: (document.querySelector('#dbPeriodLabel') || {}).textContent || '' };
    });
    await page.click('#dbRefresh');
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => {
      const groups = ['shipping', 'receiving', 'internal', 'logistics'];
      const out = { label: (document.querySelector('#dbPeriodLabel') || {}).textContent || '', groups: [] };
      groups.forEach(k => {
        const box = document.querySelector('#db-' + k);
        const tbl = box ? box.querySelector('table.db-table') : null;
        const err = box ? box.querySelector('.db-err') : null;
        out.groups.push({ k, hasTable: !!tbl, err: err ? err.textContent.trim() : null, rows: tbl ? tbl.querySelectorAll('tbody tr').length : 0 });
      });
      return out;
    });
    console.log('RELOAD | 期间 =', after.label, ' | 刷新前表长 =', before.html);
    after.groups.forEach(g => {
      ok(g.hasTable && !g.err, '★ 刷新后 [' + g.k + '] 表格重载成功', 'err=' + g.err + ' 行数=' + g.rows);
    });
    ok(after.label && after.label.indexOf('本期') >= 0, '★ 期间标签已刷新', after.label);

    await page.screenshot({ path: OUT + 'verify_dashboard_drp.png', fullPage: true });
    console.log('SHOT | ' + OUT + 'verify_dashboard_drp.png');
  } catch (e) {
    console.log('ERROR |', e.message);
    try { await page.screenshot({ path: OUT + 'verify_dashboard_drp_err.png' }); } catch (x) {}
  } finally {
    await browser.close();
    console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
  }
})();
