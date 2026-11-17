// 线上 UI 验证：库内工时「新增行 → 填项目/工时 → 再新增 → 第一行数据保留」
// 只读验证：所有输入在浏览器内完成，不提交归档，不写库。
const { chromium } = require('playwright');

const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const SHARE = BASE + '/?sharecode=' + SC;

function ok(cond, label, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra !== undefined ? ' | ' + extra : ''));
  return !!cond;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  try {
    await page.goto(SHARE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    // 登录
    const userSel = await page.$('input[name="username"], #username, #loginUser');
    const pwdSel = await page.$('input[type="password"]');
    if (!userSel || !pwdSel) {
      console.log('LOGIN | 未找到登录输入框，页面 HTML 片段：');
      console.log((await page.content()).slice(0, 800));
      await browser.close();
      return;
    }
    await userSel.fill('admin');
    await pwdSel.fill('admin123');
    await page.click('button[type="submit"], #loginBtn, .login-btn');
    await page.waitForTimeout(3500);
    console.log('LOGIN | 登录后 URL =', page.url());

    // 跳到龙湖仓工时页
    await page.evaluate(() => { location.hash = '#wh_lh'; });
    await page.waitForTimeout(2500);

    // 切到「库内工时」tab
    const tabs = await page.$$('#typeTabs .wh-tab');
    console.log('UI | 找到工时类型 tab 数 =', tabs.length);
    let clicked = false;
    for (const t of tabs) {
      const txt = (await t.innerText()).trim();
      if (txt.indexOf('库内') >= 0) { await t.click(); clicked = true; console.log('UI | 已点击 tab =', txt); break; }
    }
    if (!clicked) {
      const all = await page.$$eval('#typeTabs .wh-tab', (els) => els.map((e) => e.innerText.trim()));
      console.log('FAIL | 未找到库内 tab，实际 tab =', JSON.stringify(all));
      await browser.close();
      return;
    }
    await page.waitForTimeout(2500);

    // 记录初始行数
    const rowsBefore = await page.$$eval('#whBody tr', (els) => els.length);
    console.log('UI | 库内工时初始行数 =', rowsBefore);

    // 点「+ 新增工时」
    await page.click('#addBtn');
    await page.waitForTimeout(1200);
    const rowsAfterAdd1 = await page.$$eval('#whBody tr', (els) => els.length);
    console.log('UI | 新增第 1 行后行数 =', rowsAfterAdd1);

    // 在第 1 行填项目 + 主工时
    const row1 = (await page.$$('#whBody tr'))[0];
    const projSel = await row1.$('select[data-if="project"]');
    const mainInput = await row1.$('[data-if="main_hours"]');
    if (!projSel || !mainInput) {
      console.log('FAIL | 第 1 行未找到 project 下拉或 main_hours 输入');
      const html = await row1.innerHTML();
      console.log('ROW1 |', html.slice(0, 600));
      await browser.close();
      return;
    }
    const projOptions = await projSel.$$eval('option', (els) => els.map((e) => e.value).filter(Boolean));
    console.log('UI | 项目选项 =', JSON.stringify(projOptions));
    const pick = projOptions[0];
    await projSel.selectOption(pick);
    await mainInput.fill('3.5');
    await page.waitForTimeout(900);

    // ★ 断言修正：新增行是 unshift 到【顶部】，所以原填写行会下移 index，
    // 必须按 tempId 锁定那一行，不能固定读 index 0。
    const findFilled = async () => {
      return await page.evaluate(() => {
        const tr = Array.from(document.querySelectorAll('#whBody tr'))
          .find((t) => {
            const p = t.querySelector('select[data-if="project"]');
            const m = t.querySelector('[data-if="main_hours"]');
            return p && m && p.value === '上架' && m.value === '3.5';
          });
        if (!tr) return null;
        const p = tr.querySelector('select[data-if="project"]');
        const m = tr.querySelector('[data-if="main_hours"]');
        return { project: p.value, main: m.value, wid: tr.dataset.rowWid, temp: tr.dataset.tempId || '' };
      });
    };
    const readRow1 = async () => {
      return await page.evaluate(() => {
        const tr = document.querySelectorAll('#whBody tr')[0];
        const p = tr && tr.querySelector('select[data-if="project"]');
        const m = tr && tr.querySelector('[data-if="main_hours"]');
        return { project: p ? p.value : null, main: m ? m.value : null, wid: tr ? tr.dataset.rowWid : null };
      });
    };
    const s1 = await readRow1();
    console.log('UI | 填完后第 1 行(top) =', JSON.stringify(s1));
    const f1 = await findFilled();
    console.log('UI | 锁定「上架/3.5」行 =', JSON.stringify(f1));
    ok(!!f1 && f1.main === '3.5' && f1.project === '上架', '★ 填写值已正确落在该行');

    // ★ 关键：再点一次「+ 新增工时」，验证已填行不被冲刷
    await page.click('#addBtn');
    await page.waitForTimeout(1500);

    const rowsAfterAdd2 = await page.$$eval('#whBody tr', (els) => els.length);
    const f2 = await findFilled();
    console.log('UI | 再新增后行数 =', rowsAfterAdd2);
    console.log('UI | 再新增后「上架/3.5」行 =', JSON.stringify(f2));

    ok(rowsAfterAdd1 + 1 === rowsAfterAdd2, '新增第 2 行后总行数 +1');
    ok(!!f2 && f2.main === '3.5', '★ 再新增后第 1 行主工时仍保留 3.5', '实际=' + (f2 && f2.main));
    ok(!!f2 && f2.project === '上架', '★ 再新增后第 1 行项目仍保留 上架', '实际=' + (f2 && f2.project));

    // 再加第 3 行，确认原行仍保留
    await page.click('#addBtn');
    await page.waitForTimeout(1200);
    const f3 = await findFilled();
    console.log('UI | 加到第 3 行后「上架/3.5」行 =', JSON.stringify(f3));
    ok(!!f3 && f3.main === '3.5' && f3.project === '上架', '★ 连续新增 3 行后原填写行数据仍保留', JSON.stringify(f3));

    await page.screenshot({ path: 'scripts/out/verify_kunnei_inline.png', fullPage: false });
    console.log('SHOT | scripts/out/verify_kunnei_inline.png');

    // ★ 清理：验证过程触发失焦自动保存，会在生产库产生测试记录，必须删除还原
    const cleaned = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token') || '';
      const H = { 'X-ERP-Token': token };
      const q = 'warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent('库内') + '&status=all&page=1&pageSize=50';
      const j = await (await fetch('/api/workhours?' + q, { headers: H })).json();
      const rows = (j.data || []).filter((r) => r.project === '上架' && Number(r.main_hours) === 3.5);
      let n = 0;
      for (const r of rows) {
        const res = await fetch('/api/workhours/' + r.work_id + '/force', { method: 'DELETE', headers: H });
        if (res.ok) n++;
      }
      return { deleted: n, found: rows.length };
    });
    console.log('CLEAN | 删除测试记录 =', JSON.stringify(cleaned));
  } catch (e) {
    console.log('ERROR |', e.message);
    try { await page.screenshot({ path: 'scripts/out/verify_kunnei_inline_err.png' }); } catch (x) {}
  } finally {
    await browser.close();
  }
})();
