// 诊断：html-to-image 在本页面各场景下是否产出空白图
//  A) 简单 inline div（页面内新增，无任何 class）
//  B) position:fixed;left:-9999px 的 div（复刻 hideRoot 做法）
//  C) 同 B 但 toBlob 传 style 覆盖 left:0
//  D) 同 B 但 skipFonts:true
//  E) 克隆真实 .db-sections（隐藏容器内）
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

    const results = await page.evaluate(async () => {
      const lib = window.htmlToImage;
      const out = [];
      async function run(label, node, opts) {
        try {
          const blob = await lib.toBlob(node, opts);
          const bmp = await createImageBitmap(blob);
          const cv = document.createElement('canvas');
          cv.width = bmp.width; cv.height = bmp.height;
          const cx = cv.getContext('2d');
          cx.drawImage(bmp, 0, 0);
          const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
          let nw = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) nw++;
          out.push({ label, size: bmp.width + 'x' + bmp.height, nonWhite: nw, blobSize: blob.size });
        } catch (e) {
          out.push({ label, error: e.message });
        }
      }
      // A) 简单 div
      const a = document.createElement('div');
      a.style.cssText = 'width:400px;height:120px;background:#fff;color:#111;font-size:32px;padding:10px;box-sizing:border-box;';
      a.textContent = '测试标题 ABC 123';
      document.body.appendChild(a);
      await run('A_简单div', a, { backgroundColor: '#ffffff' });
      // B) 屏外 fixed div
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;background:#ffffff;';
      b.innerHTML = '<div style="text-align:center;font-size:24px;font-weight:bold;color:#111;">标题</div><div style="color:#333;font-size:16px;">内容行</div>';
      document.body.appendChild(b);
      await run('B_屏外left-9999', b, { backgroundColor: '#ffffff', width: b.scrollWidth, height: b.scrollHeight });
      // C) 屏外 + style 覆盖
      await run('C_屏外+style覆盖', b, { backgroundColor: '#ffffff', width: b.scrollWidth, height: b.scrollHeight, style: { left: '0px', top: '0px' } });
      // D) 屏外 + skipFonts
      await run('D_屏外+skipFonts', b, { backgroundColor: '#ffffff', width: b.scrollWidth, height: b.scrollHeight, skipFonts: true });
      // E) 克隆 .db-sections 到隐藏容器
      const e = document.createElement('div');
      e.style.cssText = 'position:fixed;left:-9999px;top:0;width:1280px;background:#ffffff;';
      const secs = document.querySelector('.db-wrap .db-sections');
      if (secs) {
        e.appendChild(secs.cloneNode(true));
        document.body.appendChild(e);
        await run('E_克隆sections屏外', e, { backgroundColor: '#ffffff', width: e.scrollWidth, height: e.scrollHeight });
        await run('E2_克隆sections+style覆盖', e, { backgroundColor: '#ffffff', width: e.scrollWidth, height: e.scrollHeight, style: { left: '0px', top: '0px' } });
        // F) 不传 width/height（用节点自身尺寸）
        await run('F_克隆sections无宽高', e, { backgroundColor: '#ffffff' });
      } else {
        out.push({ label: 'E', error: '找不到 .db-sections' });
      }
      [a, b].forEach(n => n.remove());
      const e2 = Array.from(document.querySelectorAll('div')).find(d => d.style.left === '-9999px' && d.style.width === '1280px');
      if (e2) e2.remove();
      return out;
    });
    results.forEach(r => console.log('CASE |', JSON.stringify(r)));
  } catch (e) {
    console.log('ERROR |', e.message);
  } finally {
    await browser.close();
  }
})();
