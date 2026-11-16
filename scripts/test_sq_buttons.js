// 智能测单「下载 Excel 模板 / 上传 Excel 测算」按钮修复回归测试
// Part A：DOM 桩真实加载 public/js/smart-quote.js，模拟点击，验证绑定与交互
// Part B：隔离临时库启动 Express，验证后端 /template 文件流与 /import 解析
// 用法：node scripts/test_sq_buttons.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('xlsx');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } }

// ==================== 轻量 DOM 桩 ====================
const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
function parseAttrs(s) {
  const a = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) a[m[1]] = m[2] !== undefined ? m[2] : m[3];
  ['hidden', 'disabled', 'checked', 'selected'].forEach((b) => {
    if (new RegExp('(?:^|\\s)' + b + '(?:\\s|$)').test(s)) a[b] = '';
  });
  return a;
}
function makeEl(tag, attrs) {
  attrs = attrs || {};
  const el = {
    tagName: (tag || 'div').toLowerCase(), id: attrs.id || '', className: attrs.class || '',
    type: attrs.type || '', attrs, style: {}, dataset: {},
    children: [], parent: null, textContent: '', _html: '',
    value: attrs.value || '', files: [], _clicked: 0, onclick: null, onchange: null,
    disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
    checked: Object.prototype.hasOwnProperty.call(attrs, 'checked'),
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); parseInto(this._html, this); },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; return c; },
    remove() { if (this.parent) this.parent.removeChild(this); },
    click() { this._clicked++; if (typeof this.onclick === 'function') this.onclick({ target: this }); },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    getAttribute(n) { return this.attrs[n]; },
    addEventListener() {},
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return matchAll(this, sel); },
  };
  Object.keys(attrs).forEach((k) => {
    if (k.indexOf('data-') === 0) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attrs[k];
  });
  return el;
}
function parseInto(html, root) {
  root.children = [];
  const re = /<([a-zA-Z][\w-]*)([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(m[2] || '')) { root.appendChild(makeEl(tag, parseAttrs(m[2] || ''))); continue; }
    root.appendChild(makeEl(tag, parseAttrs(m[2] || '')));
  }
}
function matchOne(el, sel) {
  let m = sel.match(/^#([\w-]+)$/);
  if (m) return el.id === m[1];
  m = sel.match(/^([\w-]+)?((?:\.[\w-]+)*)(:checked)?$/);
  if (!m) return false;
  const [, tag, classes, pseudo] = m;
  if (tag && el.tagName !== tag.toLowerCase()) return false;
  if (classes) {
    const own = (el.className || '').split(/\s+/).filter(Boolean);
    if (!classes.split('.').filter(Boolean).every((c) => own.includes(c))) return false;
  }
  if (pseudo === ':checked' && !el.checked) return false;
  return true;
}
function matchAll(root, sel) {
  const parts = String(sel).split(',').map((s) => s.trim());
  const all = [];
  const walk = (n) => n.children.forEach((c) => { all.push(c); walk(c); });
  walk(root);
  return all.filter((el) => parts.some((p) => matchOne(el, p)));
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'smart-quote.js'), 'utf8');
const API_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');

async function partA() {
  console.log('\n--- Part A：前端按钮 DOM 桩 ---');
  const host = makeEl('div');
  const alerts = [], calls = [];
  let uploadResult = { data: [] };
  const DEF = { startWeight: 0, startMode: 'estimated', waybillTypes: ['菜鸟', '拼多多', '抖音'] };
  const API = {
    get(u) { calls.push(['get', u]); return Promise.resolve({ data: JSON.parse(JSON.stringify(DEF)) }); },
    post(u, b) { calls.push(['post', u, b]); return Promise.resolve({ data: [] }); },
    put(u, b) { calls.push(['put', u, b]); return Promise.resolve({ data: JSON.parse(JSON.stringify(DEF)) }); },
    download(u, filename) { calls.push(['download', u, filename]); return Promise.resolve(); },
    upload(u, fd) { calls.push(['upload', u, fd]); return Promise.resolve(uploadResult); },
  };
  class FormDataStub { constructor() { this.entries = []; } append(k, v) { this.entries.push([k, v]); } }
  const body = makeEl('body');
  const documentStub = {
    body, title: '',
    createElement(tag) { return makeEl(tag, {}); },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };
  const ctx = {
    window: null, document: documentStub, API, FormData: FormDataStub,
    navigator: {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { search: '', href: '' }, console,
    alert: (m) => alerts.push(String(m)),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout, clearTimeout,
  };
  ctx.window = ctx;
  ctx.window.ERP_USER = { role: '管理员' };
  vm.runInNewContext(SRC, ctx, { filename: 'smart-quote.js' });

  const mount = ctx.window.ERP_PAGES && ctx.window.ERP_PAGES.smart_quote;
  ok('页面模块已注册 ERP_PAGES.smart_quote', typeof mount === 'function');
  mount(host);
  await new Promise((r) => setTimeout(r, 30));

  const tplBtn = host.querySelector('#tplBtn');
  const xlsBtn = host.querySelector('#xlsBtn');
  const xlsInput = host.querySelector('#xlsInput');
  ok('下载模板按钮存在且已绑定 onclick', !!tplBtn && typeof tplBtn.onclick === 'function');
  ok('上传按钮是真实 <button> 且已绑定 onclick', !!xlsBtn && xlsBtn.tagName === 'button' && typeof xlsBtn.onclick === 'function');
  ok('隐藏 file input 存在且已绑定 onchange', !!xlsInput && xlsInput.tagName === 'input' && xlsInput.type === 'file' && typeof xlsInput.onchange === 'function');
  ok('不再使用 <label for="xlsInput">（改显式 click）',
    !host.children.some((e) => e.tagName === 'label' && e.attrs && e.attrs.for === 'xlsInput'));

  // ① 点击上传按钮 → 必须触发 file input 的 click()
  xlsBtn.onclick({ target: xlsBtn });
  ok('点击「上传 Excel 测算」触发 fileInput.click()', xlsInput._clicked === 1);

  // ② 点击下载模板 → 必须传文件名（否则 a.download=undefined 不触发下载）
  tplBtn.onclick({ target: tplBtn });
  await new Promise((r) => setTimeout(r, 10));
  const dl = calls.find((c) => c[0] === 'download');
  ok('点击「下载 Excel 模板」调用 API.download', !!dl && dl[1] === '/smart-quote/template');
  ok('下载传入了有效 .xlsx 文件名', !!dl && /\.xlsx$/i.test(String(dl[2] || '')));
  ok('下载完成有成功反馈', /模板已下载/.test(host.querySelector('#sqMsg').textContent));

  // ③ 文件格式不对 → 弹窗提示，且不发起请求
  calls.length = 0; alerts.length = 0;
  xlsInput.files = [{ name: '订单.csv', size: 100 }];
  xlsInput.onchange({ target: xlsInput });
  ok('选择非 Excel 文件弹出格式提示', alerts.some((a) => /格式不对/.test(a)));
  ok('格式错误时不调用上传接口', !calls.some((c) => c[0] === 'upload'));

  // ④ 合法文件 → 上传接口 → 刷新表格
  uploadResult = {
    data: [
      { soNo: 'SO01', ownerName: '货主A', waybillType: '菜鸟', province: '浙江省', city: '杭州市', estimatedWeight: 3, totalVolume: 0.01, volumetricWeight: 1.667, billingWeight: 3, recommendedCode: 'ZT-XH', recommendedPrice: 4.5 },
      { soNo: 'SO02', ownerName: '货主B', waybillType: '拼多多', province: '浙江省', city: '杭州市', estimatedWeight: 2, totalVolume: 0.01, volumetricWeight: 1.667, billingWeight: 2, recommendedCode: 'ZT-QS', recommendedPrice: 5 },
    ], batchId: 1,
  };
  calls.length = 0; alerts.length = 0;
  xlsInput.files = [{ name: '订单.xlsx', size: 2048 }];
  xlsInput.onchange({ target: xlsInput });
  await new Promise((r) => setTimeout(r, 30));
  ok('合法文件调用 /smart-quote/import', calls.some((c) => c[0] === 'upload' && c[1] === '/smart-quote/import'));
  ok('上传用 FormData 携带 file 字段', (() => { const c = calls.find((x) => x[0] === 'upload'); return c && c[2] && c[2].entries.some((e) => e[0] === 'file'); })());
  ok('测算结果刷新到下方表格（SO01 可见）', /SO01/.test(host.innerHTML));
  // 上传成功会 render() 重建 DOM，提示由 toolbarHtml 直接写入 innerHTML；
  // 本桩不解析标签间文本，故用 innerHTML 断言（真实浏览器 textContent 同样有值）
  ok('给出「导入成功 N 行」可见反馈', /导入成功 2 行/.test(host.innerHTML));

  // ⑤ 结果被配置白名单过滤时，必须明确提示（否则用户以为上传没反应）
  uploadResult = { data: [{ soNo: 'SO99', waybillType: '得物', estimatedWeight: 3, totalVolume: 0, billingWeight: 3, recommendedCode: 'X', recommendedPrice: 1 }], batchId: 2 };
  xlsInput.files = [{ name: '订单2.xlsx', size: 2048 }];
  xlsInput.onchange({ target: xlsInput });
  await new Promise((r) => setTimeout(r, 30));
  ok('被白名单过滤时提示「未显示」原因', /未显示/.test(host.innerHTML));

  // ⑥ bind() 判空：模拟某元素缺失，不能抛异常、不能中断其他按钮绑定
  const origQS = host.querySelector;
  host.querySelector = function (sel) { if (sel === '#tplBtn') return null; return origQS.call(this, sel); };
  let bindErr = null;
  try {
    const save = host.querySelector('#saveCfgBtn');
    save.onclick({ target: save });          // 保存配置 → 触发 render() → bind()
    await new Promise((r) => setTimeout(r, 30));
  } catch (e) { bindErr = e; }
  host.querySelector = origQS;
  ok('元素缺失时 bind() 不抛异常（无控制台红错）', !bindErr);
  ok('元素缺失不影响上传按钮继续绑定', typeof host.querySelector('#xlsBtn').onclick === 'function');

  // ⑦ 静态断言：绑定期不再有裸的 $('...').onclick = 链式赋值
  ok('bind() 全部走判空辅助 on()', /function on\(id, evt, fn\)/.test(SRC) && !/\$\('[A-Za-z]+'\)\.onclick\s*=/.test(SRC));
  // ⑧ api.js 下载兜底
  ok('api.js 有 filename 兜底（不会 a.download=undefined）',
    /if \(!name\)/.test(API_SRC) && /Content-Disposition/.test(API_SRC) && /download\.xlsx/.test(API_SRC));
}

// ==================== Part B：后端接口 ====================
async function partB() {
  console.log('\n--- Part B：后端模板 / 导入接口（隔离临时库）---');
  const TMP = path.join(__dirname, '..', 'data', '__sq_btn_' + Date.now() + '.db');
  process.env.ERP_DB_PATH = TMP;
  execSync('node ' + JSON.stringify(path.join(__dirname, 'migrate_rbac.js')), { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });

  // 预置一条区县级报价，验证导入的「区县」列真能参与省市区匹配
  const d = new DatabaseSync(TMP);
  d.prepare('INSERT INTO logistics_quotes (network_name,express_code,province,city,district,volume_ratio,price_rules) VALUES (?,?,?,?,?,?,?)')
    .run('中通-西湖', 'ZT-XH', '浙江省', '杭州市', '西湖区', 6000, JSON.stringify([{ weight: 3, price: 4.5 }]));
  d.close();

  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'X-ERP-Token': login.token };

  // 模板下载：必须是真正可解析的 xlsx 文件流
  const tpl = await fetch(base + '/api/smart-quote/template', { headers: H });
  ok('GET /template 返回 200', tpl.status === 200);
  ok('Content-Type 为 xlsx', (tpl.headers.get('content-type') || '').includes('spreadsheetml'));
  ok('Content-Disposition 带 .xlsx 文件名', /smart_quote_template\.xlsx/.test(tpl.headers.get('content-disposition') || ''));
  const tplBuf = Buffer.from(await tpl.arrayBuffer());
  const twb = xlsx.read(tplBuf, { type: 'buffer' });
  const tAoa = xlsx.utils.sheet_to_json(twb.Sheets[twb.SheetNames[0]], { header: 1, defval: '' });
  ok('模板是合法 xlsx 且含 2 个工作表', twb.SheetNames.length === 2 && twb.SheetNames[1] === '填写说明');
  ok('模板表头含「县区」列', tAoa[0].includes('县区'));
  ok('「县区」列紧随「城市」之后', tAoa[0].indexOf('县区') === tAoa[0].indexOf('城市') + 1);
  ok('模板示例面单在默认白名单内（菜鸟）', tAoa[1][2] === '菜鸟');

  // 导入：8 列（旧版「区县」表头，验证向后兼容别名）+ 1 空行 → 空行跳过 + 命中区级报价
  const header = ['SO单号', '货主名称', '电子面单类型', '省份', '城市', '区县', '预估重量(kg)', '总体积(立方米)'];
  const rows = [
    ['SO01', '货主A', '菜鸟', '浙江省', '杭州市', '西湖区', 3, 0],
    ['', '', '', '', '', '', '', ''],  // 空行
  ];
  const ws = xlsx.utils.aoa_to_sheet([header, ...rows]);
  const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, '智能测单');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'orders.xlsx');
  const imp = await (await fetch(base + '/api/smart-quote/import', { method: 'POST', headers: { 'X-ERP-Token': login.token }, body: fd })).json();
  ok('导入成功且空行被跳过（仅 1 行结果）', imp.data && imp.data.length === 1);
  ok('导入返回 batchId（历史批次已落库）', !!imp.batchId);
  ok('区县列参与匹配，命中区级报价 ZT-XH(4.5)', imp.data && imp.data[0].recommendedCode === 'ZT-XH' && imp.data[0].recommendedPrice === 4.5);

  // 伪装文件：后缀 .xlsx 但内容是纯文本 → 400 且提示明确
  const fd2 = new FormData();
  fd2.append('file', new Blob(['a,b,c\n1,2,3\n'], { type: 'text/csv' }), 'fake.xlsx');
  const bad = await fetch(base + '/api/smart-quote/import', { method: 'POST', headers: { 'X-ERP-Token': login.token }, body: fd2 });
  const badJ = await bad.json();
  ok('伪装 CSV 被拒绝（400）', bad.status === 400);
  ok('错误信息明确提示文件格式不对', /格式不对/.test(badJ.error || ''));

  // 只有表头 → 400，避免生成空批次
  const ws3 = xlsx.utils.aoa_to_sheet([header]);
  const wb3 = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb3, ws3, '智能测单');
  const buf3 = xlsx.write(wb3, { type: 'buffer', bookType: 'xlsx' });
  const fd3 = new FormData();
  fd3.append('file', new Blob([buf3]), 'empty.xlsx');
  const empty = await fetch(base + '/api/smart-quote/import', { method: 'POST', headers: { 'X-ERP-Token': login.token }, body: fd3 });
  ok('只有表头返回 400（不生成空批次）', empty.status === 400);

  const noTok = await fetch(base + '/api/smart-quote/template');
  ok('无 token 访问模板 401', noTok.status === 401);

  server.close();
  try { fs.unlinkSync(TMP); } catch (e) { /* Windows 安全删除钩子：忽略 */ }
}

(async () => {
  try { await partA(); } catch (e) { fail++; console.log('❌ Part A 异常：', e && e.stack); }
  try { await partB(); } catch (e) { fail++; console.log('❌ Part B 异常：', e && e.stack); }
  console.log(`\n=== 智能测单按钮修复回归：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})();
