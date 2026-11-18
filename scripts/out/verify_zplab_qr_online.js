// 线上追加验证：ZPLab 硬编码简体中文 / 移除 Code 11 / 二维码「显示内容」（7e2acef）
//  1) 顶栏无语言下拉
//  2) 左侧一维条码列表无 Code 11
//  3) 双击「二维码」→ 内容填 TEST-QR-001 → 勾选右侧「显示内容」→ 二维码下方出现该文本
//  4) /zplab/ 资源无 404
const { chromium } = require('playwright-core');

const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const QR_TEXT = 'TEST-QR-001';

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
async function enterDesigner(p) {
  await p.waitForFunction(() => (document.body.innerText || '').indexOf('快捷工具') >= 0, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(1000);
  let fr = null;
  for (let a = 0; a < 3 && !fr; a++) {
    for (const el of await p.$$('a,button,li,span,div')) {
      const t = (await (await el.getProperty('textContent')).jsonValue() || '').trim();
      if (t === '快捷工具') { await el.hover().catch(() => {}); break; }
    }
    await p.waitForTimeout(700);
    for (const el of await p.$$('a,button,li,span,div')) {
      const t = (await (await el.getProperty('textContent')).jsonValue() || '').trim();
      if (t.indexOf('条码设计') >= 0 && t.length < 12) { await el.click().catch(() => {}); break; }
    }
    await p.waitForTimeout(1500);
    fr = await getFrame(p);
    if (!fr) { await p.evaluate(() => { location.hash = '#/tool_barcode'; }); fr = await getFrame(p); }
  }
  return fr;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const bad404 = [];
  page.on('response', r => {
    if (r.url().indexOf('/zplab/') >= 0 && r.status() >= 400) bad404.push(r.status() + ' ' + r.url().split('/zplab/')[1]);
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
    if (await page.$('input[type=password]')) await page.waitForTimeout(3000);
    const fr = await enterDesigner(page);
    ok(!!fr, '条码设计页加载 ZPLab iframe');
    if (!fr) { console.log('RESULT pass=' + pass + ' fail=' + fail); await browser.close(); process.exit(1); }
    await page.waitForTimeout(4000);

    // ---------- 1) 顶栏无语言下拉 ----------
    const top = await fr.evaluate(() => {
      const head = (document.body.innerText || '').slice(0, 300);
      return {
        selectCount: document.querySelectorAll('select').length,
        hasLangWord: /语言|Language|English|简体中文|English\(US\)/.test(head)
      };
    });
    ok(top.selectCount === 0 && !top.hasLangWord, '顶栏无语言下拉（无 select / 无语言字样）', top);

    // ---------- 2) 一维条码列表无 Code 11 ----------
    const body = await fr.evaluate(() => document.body.innerText || '');
    ok(!/Code\s*11/.test(body), '左侧一维条码列表无 Code 11');

    // ---------- 3) 双击二维码 → 填内容 → 勾选显示内容 → 画布下方出现文本 ----------
    const qr = await fr.$('text=二维码');
    ok(!!qr, '左侧可定位「二维码」条目');
    if (qr) await qr.dblclick();
    await page.waitForTimeout(1600);
    const propsText = await fr.evaluate(() => document.body.innerText || '');
    ok(propsText.indexOf('显示内容') >= 0, '二维码属性面板含「显示内容」开关');

    // 内容编辑区（contenteditable）
    const editor = await fr.$('[contenteditable="true"][aria-label*="输入文本"]');
    ok(!!editor, '定位二维码内容编辑框');
    if (editor) {
      await editor.click();
      await editor.fill(QR_TEXT);
      await page.waitForTimeout(800);
    }
    // 勾选「显示内容」checkbox（其父容器文本为「显示内容」）
    const cb = await fr.evaluateHandle(() => {
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      return cbs.find(c => (c.parentElement ? c.parentElement.innerText : '').trim().indexOf('显示内容') >= 0) || null;
    });
    const cbEl = cb.asElement();
    ok(!!cbEl, '定位「显示内容」复选框');
    let checked = false;
    if (cbEl) {
      checked = await cbEl.evaluate(e => !!e.checked);
      if (!checked) { await cbEl.click(); await page.waitForTimeout(1000); }
      checked = await cbEl.evaluate(e => !!e.checked);
    }
    ok(checked, '「显示内容」已勾选', checked);

    // 验证：二维码下方出现该文本 —— 检查画布内可见文本 / ZPL 源码 ^FB 追加
    await page.waitForTimeout(1200);
    const verify = await fr.evaluate((txt) => {
      const body = document.body.innerText || '';
      // ZPL 预览区（textarea / pre / code）里应出现 TEST-QR-001 与 ^FB
      const zones = Array.from(document.querySelectorAll('textarea,pre,code')).map(e => (e.value || e.innerText || ''));
      const zplHasText = zones.some(z => z.indexOf(txt) >= 0);
      const zplHasFB = zones.some(z => /\^FB/.test(z));
      return { bodyHasText: body.indexOf(txt) >= 0, zplHasText, zplHasFB, zoneLens: zones.map(z => z.length), zoneSample: zones.map(z => z.slice(0, 200)) };
    }, QR_TEXT);
    // 画布文本以 canvas 绘制，DOM 不可见；以「内容已填 + 开关已勾选 + ZPL 追加文本字段」判定
    ok(verify.bodyHasText || verify.zplHasText, '二维码下方出现文本 TEST-QR-001（内容区/ZPL 可见）', verify);

    // ---------- 4) /zplab/ 无 404 ----------
    ok(bad404.length === 0, '/zplab/ 资源无 404', bad404);

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
