// 分析生成的 PNG：尺寸 + 非白像素统计 + 内容包围盒（判断是否空白/内容偏移）
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PNG = path.resolve(process.argv[2] || 'scripts/out/verify_dashboard_shot.png');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    const b64 = fs.readFileSync(PNG).toString('base64');
    const stats = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      const W = img.naturalWidth, H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const data = cx.getImageData(0, 0, W, H).data;
      let nonWhite = 0, minX = W, maxX = -1, minY = H, maxY = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a > 0 && (r < 245 || g < 245 || b < 245)) {
            nonWhite++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      return { W, H, nonWhite, ratio: (nonWhite / (W * H) * 100).toFixed(2) + '%', bbox: { minX, maxX, minY, maxY } };
    }, b64);
    console.log('SIZE |', stats.W, 'x', stats.H);
    console.log('NON-WHITE |', stats.nonWhite, '(', stats.ratio, ')');
    console.log('BBOX |', JSON.stringify(stats.bbox));
    // 输出几个横向切片的非白占比（判断内容分布）
    const slices = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await new Promise((res) => { img.onload = res; });
      const W = img.naturalWidth, H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const data = cx.getImageData(0, 0, W, H).data;
      const out = [];
      const bands = 10;
      for (let bi = 0; bi < bands; bi++) {
        const y0 = Math.floor(H * bi / bands), y1 = Math.floor(H * (bi + 1) / bands);
        let nw = 0;
        for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (data[i + 3] > 0 && (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245)) nw++;
        }
        out.push('y[' + y0 + '~' + y1 + ']=' + (nw / ((y1 - y0) * W) * 100).toFixed(2) + '%');
      }
      return out;
    }, b64);
    slices.forEach(s => console.log('BAND |', s));
  } catch (e) {
    console.log('ERROR |', e.message);
  } finally {
    await browser.close();
  }
})();
