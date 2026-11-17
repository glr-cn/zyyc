// 线上追加验证（只读 + 自动清理测试写入）：
//   A) /app.html#/dashboard  → 四个分组大表格（发货/收货/库内/后勤）正常渲染
//   B) /app.html#/wh_lh     → 库内工时「新增行选补货 + 主工时 2 → 再新增 → 第一行数据仍在」
// 不提交归档；验证过程中若触发失焦自动保存产生的测试记录，结束时按 id 差集删除还原。
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

    // ============ A) 经营看板四表 ============
    await page.evaluate(() => { location.hash = '#dashboard'; });
    await page.waitForTimeout(1200);
    // 等四表之一渲染完成（最多 20s）
    await page.waitForFunction(() => {
      const s = document.querySelector('#db-shipping');
      return s && (s.querySelector('table.db-table') || s.querySelector('.db-err'));
    }, { timeout: 20000 }).catch(() => {});

    const dash = await page.evaluate(() => {
      const out = { title: '', period: '', groups: [] };
      const host = document.querySelector('#dashboardView') || document.body;
      out.title = (host.querySelector('.db-sec-title') ? host.querySelector('.db-sec-title').textContent.trim() : '') || '(未找到标题)';
      const all = Array.from(document.querySelectorAll('.db-sec-title')).map(e => e.textContent.trim());
      out.titles = all;
      out.period = (document.querySelector('#dbPeriodLabel') || {}).textContent || '';
      ['shipping', 'receiving', 'internal', 'logistics'].forEach(k => {
        const box = document.querySelector('#db-' + k);
        if (!box) { out.groups.push({ k, exists: false }); return; }
        const tbl = box.querySelector('table.db-table');
        const err = box.querySelector('.db-err');
        const ths = tbl ? Array.from(tbl.querySelectorAll('thead th')).map(e => e.textContent.trim()) : [];
        const trs = tbl ? Array.from(tbl.querySelectorAll('tbody tr')) : [];
        out.groups.push({
          k, exists: true,
          hasTable: !!tbl,
          err: err ? err.textContent.trim() : null,
          cols: ths.length,
          headers: ths,
          bodyRows: trs.length,
          firstRow: trs.length ? trs[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
        });
      });
      return out;
    });
    console.log('DASH | 分组标题 =', JSON.stringify(dash.titles));
    console.log('DASH | 期间 =', dash.period);
    ok(dash.titles.length === 4, '★ 看板渲染出 4 个分组标题', JSON.stringify(dash.titles));
    ok(dash.titles.join(',') === '发货组,收货组,库内组,后勤组', '★ 四分组名称正确（发货/收货/库内/后勤）', dash.titles.join(','));
    dash.groups.forEach(g => {
      ok(g.exists && g.hasTable && !g.err, '★ [' + g.k + '] 表格正常渲染', 'err=' + g.err + ' 列数=' + g.cols);
      console.log('DASH | [' + g.k + '] 列=' + JSON.stringify(g.headers) + ' 行数=' + g.bodyRows + ' 首行=' + g.firstRow);
    });
    await page.screenshot({ path: OUT + 'verify_dashboard_sync_dash.png', fullPage: true });

    // ============ B) 库内工时连续新增保留 ============
    await page.evaluate(() => { location.hash = '#wh_lh'; });
    await page.waitForTimeout(2500);

    // 记录测试前已有 work_id（用于结束时差集清理）
    const beforeIds = await page.evaluate(async () => {
      const H = { 'X-ERP-Token': localStorage.getItem('erp_token') || '' };
      const q = 'warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent('库内') + '&status=all&page=1&pageSize=200';
      const j = await (await fetch('/api/workhours?' + q, { headers: H })).json();
      return (j.data || []).map(r => Number(r.work_id));
    });
    console.log('INFO | 测试前 龙湖仓/库内 记录数 =', beforeIds.length);

    // 切到「库内工时」tab
    const tabs = await page.$$('#typeTabs .wh-tab');
    let clicked = false;
    for (const t of tabs) {
      const txt = (await t.innerText()).trim();
      if (txt.indexOf('库内') >= 0) { await t.click(); clicked = true; console.log('INFO | 已点击 tab =', txt); break; }
    }
    ok(clicked, '★ 找到并点击「库内工时」tab');
    await page.waitForTimeout(2500);

    const rowsBefore = await page.$$eval('#whBody tr', els => els.length);
    console.log('INFO | 库内工时初始行数 =', rowsBefore);

    // 新增第 1 行
    await page.click('#addBtn');
    await page.waitForTimeout(1200);

    // 定位新增行（data-temp-id 存在）
    const findNewRow = async (pred) => page.evaluate((predSrc) => {
      const p = new Function('row', 'return (' + predSrc + ')(row)');
      const rows = Array.from(document.querySelectorAll('#whBody tr[data-temp-id]'));
      const tr = rows.find((t) => {
        const pr = t.querySelector('select[data-if="project"]');
        const mh = t.querySelector('[data-if="main_hours"]');
        return pr && mh && p({ pr, mh, t });
      });
      if (!tr) return null;
      return {
        tempId: tr.dataset.tempId || '',
        project: tr.querySelector('select[data-if="project"]').value,
        main: tr.querySelector('[data-if="main_hours"]').value,
      };
    }, pred);

    const projSel = await page.$('#whBody tr[data-temp-id] select[data-if="project"]');
    const mainSel = await page.$('#whBody tr[data-temp-id] [data-if="main_hours"]');
    ok(!!projSel && !!mainSel, '★ 新增行含项目下拉与主工时输入');
    if (!projSel || !mainSel) { await browser.close(); return; }

    const projOptions = await projSel.$$eval('option', els => els.map(e => e.value).filter(Boolean));
    console.log('INFO | 库内项目选项 =', JSON.stringify(projOptions));
    ok(projOptions.indexOf('补货') >= 0, '★ 项目选项包含「补货」');

    await projSel.selectOption('补货');
    await mainSel.fill('2');
    await page.waitForTimeout(1000);

    const filled = await findNewRow('(row) => row.pr.value === "补货" && row.mh.value === "2"');
    console.log('INFO | 填写后锁定行 =', JSON.stringify(filled));
    ok(!!filled && filled.project === '补货' && filled.main === '2', '★ 填写值（补货 / 2）已落在新增行');

    // ★ 关键：再点一次新增，验证已填行不被冲刷
    await page.click('#addBtn');
    await page.waitForTimeout(1500);
    const rowsAfter2 = await page.$$eval('#whBody tr', els => els.length);
    const stillThere = await findNewRow('(row) => row.pr.value === "补货" && row.mh.value === "2"');
    console.log('INFO | 再新增后行数 =', rowsAfter2 + ' 已填行 =', JSON.stringify(stillThere));
    ok(stillThere !== null && stillThere.main === '2' && stillThere.project === '补货', '★ 再新增后第一行数据仍在（补货 / 2）', JSON.stringify(stillThere));
    ok(filled && stillThere && filled.tempId === stillThere.tempId, '★ 保留的是同一行（tempId 一致）', (filled || {}).tempId + ' -> ' + (stillThere || {}).tempId);

    // 再加第 3 行，确认连续新增仍保留
    await page.click('#addBtn');
    await page.waitForTimeout(1200);
    const stillThere3 = await findNewRow('(row) => row.pr.value === "补货" && row.mh.value === "2"');
    ok(stillThere3 !== null && stillThere3.main === '2', '★ 连续新增 3 行后已填行仍保留', JSON.stringify(stillThere3));

    await page.screenshot({ path: OUT + 'verify_dashboard_sync_wh.png', fullPage: false });

    // ---------- 清理：删除验证过程中新增的测试记录 ----------
    const cleanup = await page.evaluate(async (before) => {
      const H = { 'X-ERP-Token': localStorage.getItem('erp_token') || '' };
      const q = 'warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent('库内') + '&status=all&page=1&pageSize=200';
      const j = await (await fetch('/api/workhours?' + q, { headers: H })).json();
      const beforeSet = new Set(before.map(Number));
      const news = (j.data || []).filter(r => !beforeSet.has(Number(r.work_id)));
      let n = 0;
      for (const r of news) {
        const res = await fetch('/api/workhours/' + r.work_id + '/force', { method: 'DELETE', headers: H });
        if (res.ok) n++;
      }
      return { foundNew: news.length, deleted: n, detail: news.map(r => r.work_id + ':' + r.project + ':' + r.main_hours) };
    }, beforeIds);
    console.log('CLEAN | 新增测试记录 =', cleanup.foundNew, ' 已删除 =', cleanup.deleted, JSON.stringify(cleanup.detail));

    const afterIds = await page.evaluate(async () => {
      const H = { 'X-ERP-Token': localStorage.getItem('erp_token') || '' };
      const q = 'warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent('库内') + '&status=all&page=1&pageSize=200';
      const j = await (await fetch('/api/workhours?' + q, { headers: H })).json();
      return (j.data || []).map(r => Number(r.work_id));
    });
    ok(afterIds.length === beforeIds.length, '★ 清理后库内记录数与验证前一致', beforeIds.length + ' -> ' + afterIds.length);
  } catch (e) {
    console.log('ERROR |', e.message);
    try { await page.screenshot({ path: OUT + 'verify_dashboard_sync_err.png' }); } catch (x) {}
  } finally {
    await browser.close();
    console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
  }
})();
