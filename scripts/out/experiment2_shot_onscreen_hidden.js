// 实验2：hideRoot 改为 left:0;top:0;z-index:-10000（藏到页面内容后面），克隆 sections 截图
// 预期：PNG 非空白；实验结束自动清理实验节点
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

    const res = await page.evaluate(async () => {
      const hideRoot = document.createElement('div');
      hideRoot.style.cssText = 'position:fixed;left:0;top:0;z-index:-10000;pointer-events:none;background:#ffffff;';
      const title = document.createElement('div');
      title.style.cssText = 'text-align:center;font-size:24px;font-weight:bold;margin-bottom:20px;font-family:"Microsoft YaHei",sans-serif;color:#111;line-height:1.5;';
      title.textContent = '龙湖仓    周期：2026-11-17（实验标题）';
      const secs = document.querySelector('.db-wrap .db-sections');
      hideRoot.appendChild(title);
      hideRoot.appendChild(secs.cloneNode(true));
      document.body.appendChild(hideRoot);
      let result;
      try {
        const blob = await window.htmlToImage.toBlob(hideRoot, {
          pixelRatio: 2, cacheBust: true, backgroundColor: '#ffffff',
          width: hideRoot.scrollWidth, height: hideRoot.scrollHeight,
        });
        const bmp = await createImageBitmap(blob);
        const cv = document.createElement('canvas');
        cv.width = bmp.width; cv.height = bmp.height;
        const cx = cv.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
        let nw = 0, minX = bmp.width, maxX = -1, minY = bmp.height, maxY = -1;
        for (let y = 0; y < bmp.height; y++) for (let x = 0; x < bmp.width; x++) {
          const i = (y * bmp.width + x) * 4;
          if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) {
            nw++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        // 转出 PNG 供本地核验
        const pngBlob = await new Promise(r => cv.toBlob(r, 'image/png'));
        const buf = await pngBlob.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        result = { size: bmp.width + 'x' + bmp.height, nonWhite: nw, bbox: { minX, maxX, minY, maxY }, b64: nw > 1000 ? btoa(bin) : null };
      } finally {
        hideRoot.remove();
      }
      return result;
    });
    console.log('EXP2 | size=' + res.size, 'nonWhite=' + res.nonWhite, 'bbox=' + JSON.stringify(res.bbox));
    if (res.b64) {
      fs.writeFileSync('scripts/out/experiment2_shot.png', Buffer.from(res.b64, 'base64'));
      console.log('SAVED | experiment2_shot.png（' + fs.statSync('scripts/out/experiment2_shot.png').size + ' 字节）');
    }
  } catch (e) {
    console.log('ERROR |', e.message);
  } finally {
    await browser.close();
  }
})();
