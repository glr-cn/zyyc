// 智能测单「县区维度 + 区→市→省降级匹配」回归测试
// Part A：纯函数单测（无需 DB）——三级降级、逐快递取最特异、跨快递比价
// Part B：隔离临时库 E2E —— 模板表头/Excel 解析落库/历史明细/单笔测算/前端列
// 用法：node scripts/test_sq_district.js
'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('xlsx');
const qc = require('../src/services/quoteCalc');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } }
const rules = (p2) => JSON.stringify([{ weight: 1, price: p2 - 1 }, { weight: 2, price: p2 }, { weight: 3, price: p2 + 1 }]);
const Q = (code, p, c, d, p2, ratio) => ({ express_code: code, province: p, city: c, district: d, volume_ratio: ratio || 6000, price_rules: rules(p2) });

// ==================== Part A：核心比价纯函数 ====================
function partA() {
  console.log('\n--- Part A：区→市→省降级匹配（纯函数）---');
  const row = (o) => Object.assign({ estimatedWeight: 2, totalVolume: 0, province: '浙江省', city: '杭州市', district: '西湖区' }, o);

  // ① matchRegionLevel：三级判定
  ok('区级精确 = 1', qc.matchRegionLevel(Q('A', '浙江省', '杭州市', '西湖区', 1), '浙江省', '杭州市', '西湖区') === 1);
  ok('市级(区县为空) = 2', qc.matchRegionLevel(Q('A', '浙江省', '杭州市', '', 1), '浙江省', '杭州市', '西湖区') === 2);
  ok('省级(市/区为空) = 3', qc.matchRegionLevel(Q('A', '浙江省', '', '', 1), '浙江省', '杭州市', '西湖区') === 3);
  ok('省份不符 = 0', qc.matchRegionLevel(Q('A', '江苏省', '', '', 1), '浙江省', '杭州市', '西湖区') === 0);
  ok('区县不符的报价行 = 0（不得串用）', qc.matchRegionLevel(Q('A', '浙江省', '杭州市', '滨江区', 1), '浙江省', '杭州市', '西湖区') === 0);
  ok('城市不符的报价行 = 0', qc.matchRegionLevel(Q('A', '浙江省', '宁波市', '', 1), '浙江省', '杭州市', '西湖区') === 0);
  ok('省份为空的全国通用行 = 0（三级之外不参与）', qc.matchRegionLevel(Q('A', '', '', '', 1), '浙江省', '杭州市', '西湖区') === 0);
  ok('输入无区县时，市级行判为 2（跳过区级）', qc.matchRegionLevel(Q('A', '浙江省', '杭州市', '', 1), '浙江省', '杭州市', '') === 2);
  ok('输入无城市时，省级行判为 3（跳过区/市级）', qc.matchRegionLevel(Q('A', '浙江省', '', '', 1), '浙江省', '', '') === 3);

  // ② pickRegionQuotes：逐快递只保留最高优先级行
  const picked = qc.pickRegionQuotes([
    Q('A', '浙江省', '', '', 1.0),      // A 的省级（更便宜，但应被忽略）
    Q('A', '浙江省', '杭州市', '西湖区', 9.9), // A 的区级
    Q('B', '浙江省', '杭州市', '', 2.0),  // B 只有市级
    Q('C', '', '', '', 0.1),           // 全国通用 → 排除
    Q('D', '江苏省', '南京市', '', 0.2), // 省份不符 → 排除
  ], '浙江省', '杭州市', '西湖区');
  ok('同一快递只保留区级行（level=1）', picked.A && picked.A.level === 1 && picked.A.rows.length === 1);
  ok('只有市级的快递保留 level=2', picked.B && picked.B.level === 2);
  ok('全国通用/异省快递被排除', !picked.C && !picked.D);

  // ③ calcBestQuote：严格降级 + 跨快递取最低价
  const base = [
    Q('ZT-XH', '浙江省', '杭州市', '西湖区', 4.5),
    Q('ZT-HZ', '浙江省', '杭州市', '', 5.0),
    Q('ZT-QS', '浙江省', '', '', 6.0),
    Q('BS-SH', '上海', '', '', 3.0),
  ];
  const r1 = qc.calcBestQuote(row(), base);
  ok('西湖区 → 区级精确 ZT-XH(4.5)', r1.recommendedCode === 'ZT-XH' && r1.recommendedPrice === 4.5 && r1.matchLabel === '区级精确');
  const r2 = qc.calcBestQuote(row({ district: '' }), base);
  ok('未填县区 → 市级 ZT-HZ(5.0)', r2.recommendedCode === 'ZT-HZ' && r2.recommendedPrice === 5 && r2.matchLabel === '市级');
  const r3 = qc.calcBestQuote(row({ city: '', district: '' }), base);
  ok('未填城市 → 省级 ZT-QS(6.0)', r3.recommendedCode === 'ZT-QS' && r3.recommendedPrice === 6 && r3.matchLabel === '省级');
  const r4 = qc.calcBestQuote(row({ district: '滨江区' }), base);
  ok('别的县区 → 不得用西湖区行，降级到市级 ZT-HZ', r4.recommendedCode === 'ZT-HZ');
  const r5 = qc.calcBestQuote(row({ province: '上海', city: '', district: '' }), base);
  ok('省份不符的低价行不参与（上海 → BS-SH）', r5.recommendedCode === 'BS-SH' && r5.recommendedPrice === 3);
  const r6 = qc.calcBestQuote(row(), base.map((q) => q.express_code === 'ZT-XH'
    ? Object.assign({}, q, { price_rules: JSON.stringify([{ weight: 1, price: 1 }]) }) : q));
  ok('命中行缺该重量段 → 该快递不参与，取市级', r6.recommendedCode === 'ZT-HZ');
  const r7 = qc.calcBestQuote(row(), base.concat([Q('ALL', '', '', '', 0.1)]));
  ok('全国通用行不参与比价', r7.recommendedCode === 'ZT-XH');
  const r8 = qc.calcBestQuote(row(), [
    Q('A', '浙江省', '杭州市', '西湖区', 9.9), Q('A', '浙江省', '', '', 1.0),
    Q('B', '浙江省', '杭州市', '西湖区', 2.0),
  ]);
  ok('同快递区级优先于省级；跨快递仍取最低价 B(2.0)', r8.recommendedCode === 'B' && r8.recommendedPrice === 2);
  const r9 = qc.calcBestQuote(row({ province: '广东省', city: '深圳市', district: '南山区' }), base);
  ok('三级都不命中 → 无推荐（该快递不参与）', r9.recommendedCode === null && r9.recommendedPrice === null && r9.details.length === 0);
  // 体积换算与计费重量不被本次重构破坏
  const r10 = qc.calcBestQuote({ estimatedWeight: 2, totalVolume: 0.012, province: '浙江省', city: '杭州市', district: '西湖区' }, base);
  ok('抛比体积换算未被破坏（0.012m³÷6000×10⁶=2 → 计费2kg）', r10.volumetricWeight === 2 && r10.billingWeight === 2);

  // ④ 前端静态断言：县区输入 / 结果列 / 历史明细列
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'smart-quote.js'), 'utf8');
  const hist = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'smart-quote-history.js'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  ok('单笔录入区有县区输入框 i_dist', /id="i_dist"[^>]*placeholder="县区"/.test(ui));
  ok('录入行「县区」紧跟「城市」', ui.indexOf('id="i_dist"') > ui.indexOf('id="i_city"') && ui.indexOf('id="i_dist"') < ui.indexOf('id="i_wt"'));
  ok('结果表头「县区」在「城市」之后', /<th>城市<\/th><th>县区<\/th>/.test(ui));
  ok('结果行渲染 r.district', /esc\(r\.district/.test(ui));
  ok('单笔测算请求携带 district', /district:\s*val\('i_dist'\)/.test(ui));
  ok('智能测单表格空态 colspan=12', /colspan="12"/.test(ui));
  ok('历史明细表头有「县区」', /<th>城市<\/th><th>县区<\/th>/.test(hist));
  ok('历史明细渲染 r.district', /esc\(r\.district/.test(hist));
  ok('历史明细空态 colspan=12', /colspan="12"/.test(hist));
  const sqTable = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS smart_quote_records'));
  ok('schema 的 smart_quote_records 含 district 列', /district\s+TEXT/.test(sqTable.slice(0, sqTable.indexOf(');'))));
}

// ==================== Part B：接口 E2E ====================
async function partB() {
  console.log('\n--- Part B：模板 / 导入落库 / 历史明细 / 单笔测算 ---');
  const TMP = path.join(__dirname, '..', 'data', '__sq_dist_' + Date.now() + '.db');
  process.env.ERP_DB_PATH = TMP;
  execSync('node ' + JSON.stringify(path.join(__dirname, 'migrate_rbac.js')), { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });

  const d = new DatabaseSync(TMP);
  const ins = d.prepare('INSERT INTO logistics_quotes (network_name,express_code,province,city,district,volume_ratio,price_rules) VALUES (?,?,?,?,?,?,?)');
  const seed = [
    ['中通-西湖', 'ZT-XH', '浙江省', '杭州市', '西湖区', 6000, rules(4.5)],
    ['中通-杭州', 'ZT-HZ', '浙江省', '杭州市', '', 6000, rules(5.0)],
    ['中通-浙江', 'ZT-QS', '浙江省', '', '', 6000, rules(6.0)],
    ['百世-江苏', 'BS-JS', '江苏省', '南京市', '', 6000, rules(1.0)],
    ['全国通用', 'ALL', '', '', '', 6000, rules(0.1)],
  ];
  seed.forEach((s) => ins.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6]));
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
  const T = { 'X-ERP-Token': login.token };

  // 1) 模板：县区列在「城市」之后，示例值正确
  const tpl = await fetch(base + '/api/smart-quote/template', { headers: T });
  const twb = xlsx.read(Buffer.from(await tpl.arrayBuffer()), { type: 'buffer' });
  const aoa = xlsx.utils.sheet_to_json(twb.Sheets[twb.SheetNames[0]], { header: 1, defval: '' });
  ok('GET /template 返回 200', tpl.status === 200);
  ok('模板表头含「县区」且紧跟「城市」', aoa[0][4] === '城市' && aoa[0][5] === '县区');
  ok('模板示例县区=西湖区', aoa[1][5] === '西湖区');

  // 2) Excel 导入：县区列读取 + 落库 + 三级降级比价
  const header = ['SO单号', '货主名称', '电子面单类型', '省份', '城市', '县区', '预估重量(kg)', '总体积(立方米)'];
  const ws = xlsx.utils.aoa_to_sheet([
    header,
    ['SO01', '货主A', '菜鸟', '浙江省', '杭州市', '西湖区', 2, 0],
    ['', '', '', '', '', '', '', ''], // 空行跳过
    ['SO02', '货主B', '菜鸟', '浙江省', '杭州市', '', 2, 0],
    ['SO03', '货主C', '菜鸟', '浙江省', '', '', 2, 0],
    ['SO04', '货主D', '菜鸟', '江苏省', '南京市', '雨花台区', 2, 0],
  ]);
  const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, '智能测单');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'orders.xlsx');
  const imp = await (await fetch(base + '/api/smart-quote/import', { method: 'POST', headers: T, body: fd })).json();
  const list = imp.data || [];
  ok('导入 4 行（空行跳过）', list.length === 4 && !!imp.batchId);
  ok('导入结果保留 district=西湖区', list[0] && list[0].district === '西湖区');
  ok('导入结果未填县区时为 空串', list[1] && list[1].district === '');
  ok('SO01 命中区级 ZT-XH(4.5)', list[0] && list[0].recommendedCode === 'ZT-XH' && list[0].recommendedPrice === 4.5);
  ok('SO02 无县区 → 市级 ZT-HZ(5.0)', list[1] && list[1].recommendedCode === 'ZT-HZ' && list[1].recommendedPrice === 5);
  ok('SO03 无城市 → 省级 ZT-QS(6.0)', list[2] && list[2].recommendedCode === 'ZT-QS' && list[2].recommendedPrice === 6);
  ok('SO04 雨花台区匹配不到 → 市级 BS-JS(1.0)', list[3] && list[3].recommendedCode === 'BS-JS' && list[3].recommendedPrice === 1);
  ok('全国通用 0.1 行未参与（否则会胜出）', list.every((r) => r.recommendedCode !== 'ALL'));

  // 3) 历史明细表 district 落库 + 接口返回
  const db2 = new DatabaseSync(TMP);
  const rec = db2.prepare("SELECT district, recommended_code FROM smart_quote_records WHERE so_no='SO01'").get();
  ok('smart_quote_records.district 已落库=西湖区', rec && rec.district === '西湖区');
  db2.close();
  const detail = await (await fetch(base + '/api/smart-quote/history/' + imp.batchId + '/records?page=1', { headers: T })).json();
  ok('历史明细返回 district 字段', detail.data && detail.data.some((r) => r.so_no === 'SO01' && r.district === '西湖区'));

  // 4) 旧版「区县」表头仍兼容
  const header2 = ['SO单号', '货主名称', '电子面单类型', '省份', '城市', '区县', '预估重量(kg)', '总体积(立方米)'];
  const ws2 = xlsx.utils.aoa_to_sheet([header2, ['SO05', '货主E', '菜鸟', '浙江省', '杭州市', '滨江区', 2, 0]]);
  const wb2 = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb2, ws2, '智能测单');
  const buf2 = xlsx.write(wb2, { type: 'buffer', bookType: 'xlsx' });
  const fd2 = new FormData();
  fd2.append('file', new Blob([buf2]), 'legacy.xlsx');
  const imp2 = await (await fetch(base + '/api/smart-quote/import', { method: 'POST', headers: T, body: fd2 })).json();
  ok('旧「区县」表头兼容读取 district=滨江区', imp2.data && imp2.data[0] && imp2.data[0].district === '滨江区');
  ok('滨江区不匹配西湖区行 → 市级 ZT-HZ', imp2.data && imp2.data[0] && imp2.data[0].recommendedCode === 'ZT-HZ');

  // 5) 单笔测算带 district
  const calc = await (await fetch(base + '/api/smart-quote/calculate', {
    method: 'POST', headers: H,
    body: JSON.stringify({ rows: [{ soNo: 'S1', province: '浙江省', city: '杭州市', district: '西湖区', estimatedWeight: 2, totalVolume: 0 }] }),
  })).json();
  ok('单笔测算回传 district=西湖区', calc.data && calc.data[0] && calc.data[0].district === '西湖区');
  ok('单笔测算命中区级 ZT-XH(4.5)', calc.data && calc.data[0] && calc.data[0].recommendedCode === 'ZT-XH' && calc.data[0].recommendedPrice === 4.5);
  ok('单笔测算返回命中级别=区级精确', calc.data && calc.data[0] && calc.data[0].matchLabel === '区级精确');

  server.close();
  try { fs.unlinkSync(TMP); } catch (e) { /* Windows 安全删除钩子：清理失败不影响结果 */ }
}

(async () => {
  try { partA(); } catch (e) { fail++; console.log('❌ Part A 异常：', e && e.stack); }
  try { await partB(); } catch (e) { fail++; console.log('❌ Part B 异常：', e && e.stack); }
  console.log(`\n=== 县区维度 + 降级比价测试：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})();
