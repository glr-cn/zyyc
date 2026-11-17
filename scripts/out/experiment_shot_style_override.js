// 实验：验证「空白截图」根因 —— html-to-image 克隆节点保留了 left:-9999px，
// 内容被画到画布外。用 toBlob 的 style 覆盖参数把克隆节点拉回画布内，看 PNG 是否变正常。
const { chromium } = require('playwright-core');
const fs = require('fs');

const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  try {
    await page.goto(BASE + '/?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const u = await page.$('input[name="username"], #username, #loginUser');
    const p = await page.$('input[type="password"]');
    await u.fill('admin');
    await p.fill('admin123');
    await page.click('button[type="submit"], #loginBtn, .login-btn');
    await page.waitForTimeout(3000);
    await page.goto(BASE + '/app.html?sharecode=' + SC + '#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#db-shipping table.db-table'), { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // 拦截 clipboard.write 捕获 PNG + 给 htmlToImage.toBlob 包一层 style 覆盖
    await page.evaluate(() => {
      window.__pngB64 = null;
      if (navigator.clipboard && navigator.clipboard.write) {
        const orig = navigator.clipboard.write.bind(navigator.clipboard);
        navigator.clipboard.write = async (items) => {
          for (const it of items) {
            try {
              const blob = await it.getType('image/png');
              const buf = await blob.arrayBuffer();
              let bin = '';
              const bytes = new Uint8Array(buf);
              for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
              window.__pngB64 = btoa(bin);
            } catch (e) {}
          }
          return orig(items);
        };
      }
      const lib = window.htmlToImage;
      const origToBlob = lib.toBlob.bind(lib);
      lib.toBlob = (node, opts) => origToBlob(node, Object.assign({}, opts, {
        style: Object.assign({}, opts && opts.style, { left: '0px', top: '0px', position: 'fixed', margin: '0' }),
      }));
    });

    await page.click('#dbCopyImg');
    await page.waitForFunction(() => window.__pngB64, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    const b64 = await page.evaluate(() => window.__pngB64);
    if (!b64) { console.log('RESULT | 未捕获到 PNG'); await browser.close(); return; }
    fs.writeFileSync('scripts/out/experiment_fixed_shot.png', Buffer.from(b64, 'base64'));
    console.log('SAVED | experiment_fixed_shot.png（' + fs.statSync('scripts/out/experiment_fixed_shot.png').size + ' 字节）');
  } catch (e) {
    console.log('ERROR |', e.message);
  } finally {
    await browser.close();
  }
})();
