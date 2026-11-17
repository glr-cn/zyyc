// 线上追加验证：DateRangePicker 双日历面板左右对齐 + 非当月日期淡色禁点
//  1) 按日模式下弹出面板，左右两个月份各 42 格（6 行×7 列）
//  2) 逐行比较左右面板同一行的 top 值 → 完全对齐、无错位交叉
//  3) 非当月日期（.drp-other）浅灰 #bbb + pointer-events:none + 不可点击
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
      const el = document.querySelector('#dbDatePicker');
      return el && el.querySelector('.drp-mode');
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // 切到「按日」→ 弹出双日历面板
    await page.selectOption('#dbDatePicker select.drp-mode', 'day');
    await page.waitForTimeout(600);
    await page.click('#dbDatePicker button.drp-trigger');
    await page.waitForTimeout(1000);

    const cal = await page.evaluate(() => {
      const panel = document.querySelector('#dbDatePicker .drp-panel');
      const cals = panel ? Array.from(panel.querySelectorAll('.drp-cal')) : [];
      const info = cals.map(c => {
        const grid = c.querySelector('.drp-cal-grid');
        const cells = grid ? Array.from(grid.querySelectorAll('.drp-cell')) : [];
        const rows = [];
        for (let r = 0; r < 6; r++) {
          const rowCells = cells.slice(r * 7, r * 7 + 7);
          rows.push({
            r: r + 1,
            tops: rowCells.map(x => Math.round(x.getBoundingClientRect().top)),
            texts: rowCells.map(x => x.textContent.trim()),
          });
        }
        const others = cells.filter(x => x.classList.contains('drp-other'));
        const o0 = others[0];
        return {
          title: c.querySelector('.drp-cal-title') ? c.querySelector('.drp-cal-title').textContent.trim() : '',
          cellCount: cells.length,
          gridRows: grid ? getComputedStyle(grid).gridTemplateRows : null,
          rows,
          otherCount: others.length,
          otherSample: others.slice(0, 4).map(x => x.textContent.trim()),
          otherTag: o0 ? o0.tagName : null,
          otherColor: o0 ? getComputedStyle(o0).color : null,
          otherPE: o0 ? getComputedStyle(o0).pointerEvents : null,
          otherCursor: o0 ? getComputedStyle(o0).cursor : null,
        };
      });
      return {
        panelVisible: panel ? !panel.classList.contains('drp-hidden') : false,
        hasDayPanel: !!(panel && panel.querySelector('.drp-day')),
        cals: info,
      };
    });
    console.log('CAL | 面板可见 =', cal.panelVisible, ' 日模式面板 =', cal.hasDayPanel);
    ok(cal.panelVisible && cal.hasDayPanel, '★ 点击选择器弹出按日双日历面板');
    ok(cal.cals.length === 2, '★ 面板含左右两个月份', cal.cals.map(c => c.title).join(' | '));
    cal.cals.forEach(c => {
      console.log('CAL | [' + c.title + '] 格数=' + c.cellCount + ' gridRows=' + c.gridRows + ' 其他月格=' + c.otherCount + ' ' + JSON.stringify(c.otherSample));
      ok(c.cellCount === 42, '★ [' + c.title + '] 固定 42 格（6×7）', c.cellCount);
      ok(c.gridRows && c.gridRows.split(' ').length === 6, '★ [' + c.title + '] grid 行数固定为 6', c.gridRows);
      ok(c.otherCount > 0, '★ [' + c.title + '] 存在非当月日期格', c.otherCount);
      ok(c.otherTag === 'SPAN', '★ [' + c.title + '] 非当月格是 span（非 button）', c.otherTag);
      ok(c.otherColor === 'rgb(187, 187, 187)', '★ [' + c.title + '] 非当月格浅灰 #bbb', c.otherColor);
      ok(c.otherPE === 'none', '★ [' + c.title + '] 非当月格 pointer-events:none（禁点）', c.otherPE);
    });

    // 逐行对齐：左右同 index 行的 top 必须完全一致
    if (cal.cals.length === 2) {
      const L = cal.cals[0].rows, R = cal.cals[1].rows;
      let aligned = 0;
      for (let r = 0; r < 6; r++) {
        const lt = L[r].tops[0], rt = R[r].tops[0];
        const lSame = new Set(L[r].tops).size === 1;
        const rSame = new Set(R[r].tops).size === 1;
        const eq = lt === rt && lSame && rSame;
        if (eq) aligned++;
        console.log('ALIGN | 第' + (r + 1) + '行 左top=' + lt + ' 右top=' + rt + ' 左行内一致=' + lSame + ' 右行内一致=' + rSame);
      }
      ok(aligned === 6, '★ 左右双日历 6 行 top 全部对齐（无错位交叉）', aligned + '/6');
    }

    // 点击非当月格 → 不应改变取值（禁点验证）
    const before = await page.evaluate(() => {
      const t = document.querySelector('#dbDatePicker .drp-text');
      return t ? t.textContent.trim() : '';
    });
    await page.evaluate(() => {
      const other = document.querySelector('#dbDatePicker .drp-cal .drp-other');
      if (other) other.click();
    });
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => {
      const t = document.querySelector('#dbDatePicker .drp-text');
      return t ? t.textContent.trim() : '';
    });
    console.log('CLICK | 点击非当月格前 =', JSON.stringify(before), ' 后 =', JSON.stringify(after));
    ok(before === after, '★ 点击非当月日期不改变选择（禁点生效）', before + ' -> ' + after);

    await page.screenshot({ path: OUT + 'verify_dashboard_dualcal.png', fullPage: false });
    console.log('SHOT | ' + OUT + 'verify_dashboard_dualcal.png');
  } catch (e) {
    console.log('ERROR |', e.message);
    try { await page.screenshot({ path: OUT + 'verify_dashboard_dualcal_err.png' }); } catch (x) {}
  } finally {
    await browser.close();
    console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
  }
})();
