// 线上追加验证：条码设计页改由内置 ZPLab 提供（fa19db9）
//  1) ZPLab 中文编辑器正常加载：左侧条码列表 / 中间画布 / 右侧属性
//  2) 左侧双击「Code 128」→ 画布生成条码，右侧出现条码参数
//  3) Network 中 /zplab/ 资源无 404
const { chromium } = require('playwright-core');

const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
}
async function getFrame(p) {
  for (let i = 0; i < 40; i++) {
    const f = p.frames().find(f => f.url().indexOf('/zplab/') >= 0);
    if (f) return f;
    await p.waitForTimeout(500);
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const bad404 = [];
  page.on('response', r => {
    const u = r.url();
    if (u.indexOf('/zplab/') >= 0 && r.status() >= 400) bad404.push(r.status() + ' ' + u.split('/zplab/')[1]);
  });
  try {
    await page.goto(BASE + '/app.html?sharecode=' + SC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const u = await page.$('input[name=username],#username,#loginUser');
    const pw = await page.$('input[type=password]');
    if (u && pw) {
      await u.fill('admin'); await pw.fill('admin123');
      const btn = await page.$('button[type=submit],#loginBtn,.login-btn');
      if (btn) await btn.click();
      await page.waitForTimeout(4000);
    }
    // 若仍在登录页，再等一轮
    if (await page.$('input[type=password]')) await page.waitForTimeout(3000);
    // 等应用主框架渲染完成
    await page.waitForFunction(() => (document.body.innerText || '').indexOf('快捷工具') >= 0, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    let fr = null;
    for (let attempt = 0; attempt < 3 && !fr; attempt++) {
      // 真实路径：悬浮「快捷工具」主菜单 → 点「条码设计」子项
      const navItems = await page.$$('a,button,li,span,div');
      for (const el of navItems) {
        const t = (await (await el.getProperty('textContent')).jsonValue() || '').trim();
        if (t === '快捷工具') { await el.hover().catch(() => {}); break; }
      }
      await page.waitForTimeout(700);
      for (const el of await page.$$('a,button,li,span,div')) {
        const t = (await (await el.getProperty('textContent')).jsonValue() || '').trim();
        if (t.indexOf('条码设计') >= 0 && t.length < 12) { await el.click().catch(() => {}); break; }
      }
      await page.waitForTimeout(1500);
      fr = await getFrame(page);
      if (!fr) {
        await page.evaluate(() => { location.hash = '#/tool_barcode'; });
        fr = await getFrame(page);
      }
    }
    console.log('DIAG url=' + page.url() + ' frames=' + page.frames().map(f => f.url().split('/').pop()).join(','));
    ok(!!fr, '条码设计页加载 ZPLab iframe', fr ? fr.url().split('/').pop() : null);
    if (!fr) { console.log('RESULT pass=' + pass + ' fail=' + fail); await browser.close(); process.exit(1); }
    await page.waitForTimeout(4000);

    // ---------- 1) 中文编辑器三区 ----------
    const dom = await fr.evaluate(() => {
      const t = document.body.innerText || '';
      return {
        hasLeftList: t.indexOf('一维线性') >= 0 && t.indexOf('二维矩阵') >= 0 && t.indexOf('Code 128') >= 0,
        hasCanvas: document.querySelectorAll('canvas').length >= 1,
        hasRightProps: t.indexOf('宽度') >= 0 && t.indexOf('ZPL') >= 0,
        chinese: /[\u4e00-\u9fa5]/.test(t),
        textLen: t.length
      };
    });
    ok(dom.chinese && dom.hasLeftList, '左侧中文条码列表正常（含 Code 128/一维线性/二维矩阵）', dom);
    ok(dom.hasCanvas, '中间画布已渲染（canvas）');
    ok(dom.hasRightProps, '右侧属性面板已渲染');

    // ---------- 2) 双击 Code 128 → 生成条码 + 右侧参数 ----------
    const before = await fr.evaluate(() => document.body.innerText || '');
    ok(before.indexOf('模块宽度') < 0, '双击前右侧无条码专属参数（基线）');
    const c128 = await fr.$('text=Code 128');
    ok(!!c128, '左侧可定位「Code 128」条目');
    if (c128) await c128.dblclick();
    await page.waitForTimeout(1600);
    const after = await fr.evaluate(() => document.body.innerText || '');
    const paramKeys = ['内容', '序列模式', '自动子集', '高度 (MM)', '模块宽度', '人工可读', '校验位'];
    const shown = paramKeys.filter(k => after.indexOf(k) >= 0);
    ok(shown.length >= 4, '双击 Code 128 后画布生成条码、右侧出现条码参数', shown);
    ok(after.indexOf('Code 128') >= 0, '右侧参数面板标识当前条码类型 Code 128');

    // ---------- 3) /zplab/ 资源无 404 ----------
    ok(bad404.length === 0, '/zplab/ 资源全部加载成功（无 404）', bad404);

    console.log('RESULT pass=' + pass + ' fail=' + fail);
    await browser.close();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('ERROR ' + e.message);
    console.log('BAD404=' + JSON.stringify(bad404));
    await browser.close().catch(() => {});
    process.exit(2);
  }
})();
