// 线上追加验证 7e8c617：截图升级——排除顶部筛选区 + 动态居中大标题
//  1) 拦截 navigator.clipboard.write 捕获生成的 PNG blob（HTTPS 主路径）
//  2) PNG 落地本地 → ViewImage 人工核验：居中大标题「龙湖仓 周期：2026-11-17」+ 四个表格，无顶部按钮/tabs
//  3) 原 DOM 零影响（隐藏克隆 div 在 finally 移除）、无报错
const { chromium } = require('playwright-core');
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
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const pageErrs = [];
  page.on('pageerror', (e) => pageErrs.push(e.message));
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

    // 全新加载看板
    await page.goto(BASE + '/app.html?sharecode=' + SC + '#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('#dbCopyImg');
      const t = document.querySelector('#db-shipping table.db-table');
      return el && t;
    }, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // ============ 1) 初始状态 ============
    const init = await page.evaluate(() => ({
      hasCopy: !!document.querySelector('#dbCopyImg'),
      wh: (document.querySelector('.db-wh-tab.active') || {}).textContent || null,
      label: (document.querySelector('#dbPeriodLabel') || {}).textContent || '',
      shipRows: (document.querySelector('#db-shipping table.db-table') || { querySelectorAll: () => [] }).querySelectorAll('tbody tr').length,
      errBoxes: Array.from(document.querySelectorAll('.db-err')).map(e => e.textContent.trim()),
    }));
    console.log('INIT |', JSON.stringify(init));
    ok(init.hasCopy && init.errBoxes.length === 0 && init.shipRows > 1, '★ 看板已加载（当前仓库=' + init.wh + '，发货 ' + init.shipRows + ' 行）');

    // ============ 2) 拦截剪贴板写入，捕获 PNG blob ============
    await page.evaluate(() => {
      window.__pngB64 = null;
      window.__toasts = [];
      const obs = new MutationObserver((muts) => {
        muts.forEach(m => m.addedNodes.forEach(n => {
          if (n.nodeType === 1 && n.classList && n.classList.contains('db-toast')) {
            window.__toasts.push({ t: n.textContent.trim(), cls: n.className });
          }
        }));
      });
      obs.observe(document.body, { childList: true, subtree: true });
      if (navigator.clipboard && navigator.clipboard.write) {
        const orig = navigator.clipboard.write.bind(navigator.clipboard);
        navigator.clipboard.write = async (items) => {
          try {
            for (const it of items) {
              const blob = await it.getType('image/png');
              if (blob) {
                const buf = await blob.arrayBuffer();
                let bin = '';
                const bytes = new Uint8Array(buf);
                for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                window.__pngB64 = btoa(bin);
              }
            }
          } catch (e) { console.warn('拦截失败', e); }
          return orig(items);
        };
      }
    });

    await page.click('#dbCopyImg');
    await page.waitForFunction(() => window.__pngB64, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => ({
      hasPng: !!window.__pngB64,
      pngLen: window.__pngB64 ? window.__pngB64.length : 0,
      toasts: window.__toasts.slice(),
      btnText: (document.querySelector('#dbCopyImg') || {}).textContent,
      hideRootLeft: Array.from(document.querySelectorAll('div')).filter(d => d.style && d.style.left === '-9999px').length,
    }));
    console.log('COPY |', JSON.stringify({ hasPng: after.hasPng, pngLen: after.pngLen, toasts: after.toasts, btnText: after.btnText, hideRootLeft: after.hideRootLeft }));
    ok(after.hasPng && after.pngLen > 10000, '★ 捕获到生成的 PNG blob', 'base64长度=' + after.pngLen);
    ok(after.toasts.some(x => x.t.indexOf('剪贴板') >= 0 && x.cls.indexOf('db-toast-ok') >= 0), '★ HTTPS 主路径 toast（写入剪贴板，非降级）', JSON.stringify(after.toasts));
    ok(after.hideRootLeft === 0, '★ 隐藏克隆 div 已清理（原 DOM 零影响）', '残留=' + after.hideRootLeft);
    ok(pageErrs.length === 0, '★ 无未捕获页面异常', JSON.stringify(pageErrs));

    // ============ 3) PNG 落地并人工核验 ============
    if (after.hasPng) {
      const b64 = await page.evaluate(() => window.__pngB64);
      const pngPath = OUT + 'verify_dashboard_shot.png';
      fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
      console.log('PNG | 已保存 ' + pngPath + '（' + fs.statSync(pngPath).size + ' 字节）');
      ok(fs.statSync(pngPath).size > 10000, '★ PNG 已落地本地，待人工打开核验内容', pngPath);
    }
  } catch (e) {
    console.log('ERROR |', e.message);
  } finally {
    await browser.close();
    console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
  }
})();
