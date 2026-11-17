// 线上追加验证：看板「导出 Excel」+「复制为图片」两个按钮
//  1) 两按钮存在且加载了 CDN 库（window.XLSX / window.htmlToImage）
//  2) 点导出 Excel → 捕获下载 → 用 xlsx 读回，确认含 4 个 Sheet（发货组/收货组/库内组/后勤组）
//  3) 点复制为图片 → 无报错（toast 为 ok/warn 均可，err 为失败；无 pageerror）
const { chromium } = require('playwright-core');
const XLSX = require('xlsx');
const fs = require('fs');

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
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const pageErrs = [];
  const consoleErrs = [];
  page.on('pageerror', (e) => pageErrs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  try {
    await page.goto(BASE + '/?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const u = await page.$('input[name="username"], #username, #loginUser');
    const p = await page.$('input[type="password"]');
    if (!u || !p) { console.log('FAIL | 未找到登录输入框'); await browser.close(); return; }
    await u.fill('admin');
    await p.fill('admin123');
    await page.click('button[type="submit"], #loginBtn, .login-btn');
    await page.waitForTimeout(3000);

    // 全新加载看板（自动查询）
    await page.goto(BASE + '/app.html?sharecode=' + SC + '#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('#dbExportXlsx');
      const t = document.querySelector('#db-shipping table.db-table');
      return el && t;
    }, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // ============ 1) 按钮 + CDN 库 ============
    const init = await page.evaluate(() => ({
      hasExport: !!document.querySelector('#dbExportXlsx'),
      hasCopy: !!document.querySelector('#dbCopyImg'),
      exportText: (document.querySelector('#dbExportXlsx') || {}).textContent,
      copyText: (document.querySelector('#dbCopyImg') || {}).textContent,
      hasXLSX: !!window.XLSX,
      hasHtmlToImage: !!window.htmlToImage,
      shipRows: (document.querySelector('#db-shipping table.db-table') || { querySelectorAll: () => [] }).querySelectorAll('tbody tr').length,
      errBoxes: Array.from(document.querySelectorAll('.db-err')).map(e => e.textContent.trim()),
    }));
    console.log('INIT |', JSON.stringify(init));
    ok(init.hasExport && init.hasCopy, '★ 导出Excel / 复制为图片 两个按钮存在', init.exportText + ' / ' + init.copyText);
    ok(init.hasXLSX, '★ CDN xlsx 已加载（window.XLSX）');
    ok(init.hasHtmlToImage, '★ CDN html-to-image 已加载（window.htmlToImage）');
    ok(init.errBoxes.length === 0 && init.shipRows > 1, '★ 看板数据已加载（发货 ' + init.shipRows + ' 行）', 'err=' + JSON.stringify(init.errBoxes));

    // 注入 toast 监听（toast 2.2s 后自动消失，轮询会漏读 → 用 MutationObserver 记录全部）
    await page.evaluate(() => {
      window.__toasts = [];
      const obs = new MutationObserver((muts) => {
        muts.forEach(m => m.addedNodes.forEach(n => {
          if (n.nodeType === 1 && n.classList && n.classList.contains('db-toast')) {
            window.__toasts.push({ t: n.textContent.trim(), cls: n.className });
          }
        }));
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });

    // ============ 2) 导出 Excel ============
    downloads.length = 0;
    await page.click('#dbExportXlsx');
    await page.waitForTimeout(3500);
    const exportToasts = await page.evaluate(() => window.__toasts.slice());
    console.log('DOWNLOAD | 捕获数 =', downloads.length, '| toasts =', JSON.stringify(exportToasts));
    ok(downloads.length === 1, '★ 点导出Excel触发浏览器下载（1 个文件）', 'count=' + downloads.length);
    ok(exportToasts.some(x => x.t.indexOf('Excel 已导出') >= 0 && x.cls.indexOf('db-toast-ok') >= 0), '★ 导出成功 toast（绿色 ok）', JSON.stringify(exportToasts));
    if (downloads.length) {
      const dl = downloads[0];
      const fname = dl.suggestedFilename();
      console.log('FILE |', fname);
      ok(/\.xlsx$/i.test(fname), '★ 下载文件为 .xlsx', fname);
      const savePath = OUT + 'verify_dashboard_export.xlsx';
      await dl.saveAs(savePath);
      const wb = XLSX.readFile(savePath);
      console.log('SHEETS |', JSON.stringify(wb.SheetNames));
      const expect = ['发货组', '收货组', '库内组', '后勤组'];
      ok(wb.SheetNames.length === 4 && expect.every(x => wb.SheetNames.indexOf(x) >= 0), '★ Excel 含 4 个 Sheet：发货组/收货组/库内组/后勤组', JSON.stringify(wb.SheetNames));
      const sh = wb.Sheets['发货组'];
      if (sh) {
        const aoa = XLSX.utils.sheet_to_json(sh, { header: 1 });
        console.log('发货组 | 行数 =', aoa.length, '| 表头 =', JSON.stringify(aoa[1]));
        ok(aoa.length > 2, '★ 发货组 Sheet 含数据表', 'rows=' + aoa.length);
      }
    }

    // ============ 3) 复制为图片 ============
    await page.waitForTimeout(1000);
    const beforeErrs = pageErrs.length;
    const beforeConsole = consoleErrs.length;
    downloads.length = 0;
    await page.evaluate(() => { window.__toasts = []; });
    await page.click('#dbCopyImg');
    await page.waitForTimeout(6000);
    const copy = await page.evaluate(() => ({
      toasts: window.__toasts.slice(),
      btnText: (document.querySelector('#dbCopyImg') || {}).textContent,
      btnDisabled: (document.querySelector('#dbCopyImg') || {}).disabled,
    }));
    console.log('COPY |', JSON.stringify(copy));
    console.log('PAGEERR | 新增 =', pageErrs.length - beforeErrs, JSON.stringify(pageErrs.slice(beforeErrs)));
    console.log('CONSOLE_ERR | 新增 =', consoleErrs.length - beforeConsole, JSON.stringify(consoleErrs.slice(beforeConsole).slice(0, 4)));
    const toast = copy.toasts[copy.toasts.length - 1] || { t: '', cls: '' };
    ok(toast.t && toast.cls.indexOf('db-toast-err') < 0, '★ 复制为图片无错误提示（非 err toast）', toast.t + ' | ' + toast.cls);
    ok(copy.btnText === '复制为图片' && copy.btnDisabled === false, '★ 按钮已恢复（非卡在生成中）', copy.btnText);
    ok(pageErrs.length === beforeErrs, '★ 无未捕获页面异常', JSON.stringify(pageErrs.slice(beforeErrs)));
    const realConsoleErrs = consoleErrs.slice(beforeConsole).filter(x => !/favicon|net::ERR_CERT/i.test(x));
    ok(realConsoleErrs.length === 0, '★ 无 console.error（排除 favicon/证书噪声）', JSON.stringify(realConsoleErrs.slice(0, 3)));
    const isClipboard = /剪贴板/.test(toast.t);
    const isPngFallback = /PNG/.test(toast.t);
    ok(isClipboard || isPngFallback, '★ HTTPS 走剪贴板 或 降级下载PNG（二者之一）', toast.t);

    await page.screenshot({ path: OUT + 'verify_dashboard_export.png', fullPage: true });
    console.log('SHOT | ' + OUT + 'verify_dashboard_export.png');
  } catch (e) {
    console.log('ERROR |', e.message);
    try { await page.screenshot({ path: OUT + 'verify_dashboard_export_err.png' }); } catch (x) {}
  } finally {
    await browser.close();
    console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
  }
})();
