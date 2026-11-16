// 物流报价查看弹窗「省份列 + 冻结列」修复测试
// ① 前端渲染结构静态断言（省份列存在/顺序/colgroup 锁宽/left 累加/空值兜底/z-index/阴影）
// ② 后端 by-code 返回 province + province_disp（数据链路完整，含省份为空的行也有 province 字段）
// 用法：node scripts/test_xls_sticky.js
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } }
const rules = (p) => JSON.stringify([{ weight: 1, price: p }, { weight: 40, price: p + 2 }]);

async function main() {
  const ROOT = path.join(__dirname, '..');
  const js = fs.readFileSync(path.join(ROOT, 'public/js/logistics-quotes.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');

  // ---------- A. 前端静态断言 ----------
  ok('表头首列是省份且在城市之前', /<th class="stick c-prov"[\s\S]{0,80}省份<\/th>[\s\S]{0,80}<th class="stick c-city"[\s\S]{0,40}城市<\/th>/.test(js));
  ok('表体首列渲染省份 dispAddr(province)', /<td class="stick c-prov"[^>]*>\$\{dispAddr\(row, 'province'\)\}<\/td>/.test(js));
  ok('省份空值兜底为「未知」', /key === 'province'\) return '<span class="addr-unknown"[^>]*>未知<\/span>'/.test(js));
  ok('colgroup 存在且锁宽', /<colgroup>\$\{cols\}<\/colgroup>/.test(js) && /cols = \[[\s\S]{0,300}<col style="width:\$\{COLW\.addr\}px">/.test(js));
  ok('冻结 left 偏移由列宽常量计算', /const FRZ = \{[\s\S]{0,240}city: `left:\$\{COLW\.addr\}px`[\s\S]{0,120}dist: `left:\$\{COLW\.addr \* 2\}px`/.test(js));
  ok('冻结单元格注入内联 left（表头+表体）', (js.match(/frzStyle\(/g) || []).length >= 8);
  // 列宽累加：addr*3 + ratio + w*40 + op 必须等于 GRID_W 公式
  ok('表格总宽公式含全部列', /GRID_W = COLW\.addr \* 3 \+ COLW\.ratio \+ COLW\.w \* WEIGHTS\.length \+ COLW\.op/.test(js));
  // CSS：table-layout:fixed / 四象限 z-index / 阴影 / col 宽变量
  ok('CSS table-layout:fixed', /table\.xls-tbl \{[^}]*table-layout: fixed/.test(css));
  ok('CSS 四象限 z-index（表头10/冻结列20/交叉30）', /thead th \{[^}]*z-index: 10/.test(css) && /\.stick \{ position: sticky; z-index: 20/.test(css) && /thead \.stick \{ z-index: 30/.test(css));
  ok('CSS 冻结列 left 累加 112/224/336', /\.c-prov[\s\S]{0,120}left: 0/.test(css) && /\.c-city[\s\S]{0,120}left: 112px/.test(css) && /\.c-dist[\s\S]{0,120}left: 224px/.test(css) && /\.c-ratio[\s\S]{0,160}left: 336px/.test(css));
  ok('CSS 冻结区右缘阴影', /\.c-ratio \{ box-shadow: 2px 0 5px/.test(css));
  ok('CSS 操作列左缘阴影', /\.c-op \{[\s\S]{0,120}box-shadow: -2px 0 5px/.test(css));
  ok('未知地址样式存在', /table\.xls-tbl \.addr-unknown/.test(css));

  // ---------- B. 后端隔离库实跑 ----------
  const TMP = path.join(__dirname, '..', 'data', '__stick_' + Date.now() + '.db');
  process.env.ERP_DB_PATH = TMP;
  delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy; delete process.env.https_proxy;
  execSync('node ' + JSON.stringify(path.join(__dirname, 'migrate_rbac.js')),
    { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });
  const d = new DatabaseSync(TMP);
  const ins = d.prepare('INSERT INTO logistics_quotes (network_name,express_code,province,city,district,volume_ratio,price_rules) VALUES (?,?,?,?,?,?,?)');
  ins.run('中通-杭州', 'ST-ZJ', '浙江省', '杭州市', '西湖区', 6000, rules(5));
  ins.run('全国通用', 'ST-ZJ', '', '', '', 6000, rules(9)); // 省份为空的行
  d.close();

  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const H = { 'X-ERP-Token': login.token };
  try {
    const res = await (await fetch(base + '/api/logistics-quotes/by-code?code=ST-ZJ', { headers: H })).json();
    const rows = res.data || [];
    ok('by-code 返回两行（含省份为空行）', rows.length === 2);
    const withProv = rows.find((r) => r.province === '浙江省');
    ok('有省份行：province 字段存在且非空', withProv && withProv.province === '浙江省');
    ok('有省份行：province_disp 存在', withProv && withProv.province_disp === '浙江省');
    const emptyProv = rows.find((r) => r.province === '');
    ok('空省份行：province 字段依然存在（前端据此显示「未知」）', !!emptyProv && emptyProv.hasOwnProperty('province'));
    ok('空省份行：province_disp 为空字符串', emptyProv && emptyProv.province_disp === '');
  } finally {
    server.close();
    try { fs.rmSync(TMP, { force: true }); } catch (e) { /* 安全钩子可能拦截，忽略 */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
