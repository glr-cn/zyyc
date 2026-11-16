// 物流报价：导入模板 + Excel 导入(upsert) + 区域比价 集成测试（隔离临时库）
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('xlsx');

const TMP = path.join(__dirname, '..', 'data', '__logi_imp_' + Date.now() + '.db');
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
process.env.ERP_DB_PATH = TMP;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } }

(async () => {
  execSync(`node ${path.join(__dirname, 'migrate_rbac.js')}`, { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });

  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'X-ERP-Token': login.token };

  // 1) 模板下载
  const tmpl = await fetch(base + '/api/logistics-quotes/template', { headers: H });
  ok('模板下载 200', tmpl.status === 200);
  ok('模板为 xlsx', (tmpl.headers.get('content-type') || '').includes('spreadsheetml') && (tmpl.headers.get('content-disposition') || '').includes('logistics_quote_template.xlsx'));
  // 校验模板表头列（规范：网点名称/快递编码/抛比/省份/城市/区县 + 1kg…40kg）
  const tbuf = Buffer.from(await tmpl.arrayBuffer());
  const twb = xlsx.read(tbuf, { type: 'buffer' });
  const theader = xlsx.utils.sheet_to_json(twb.Sheets[twb.SheetNames[0]], { header: 1 })[0];
  const tjoined = theader.join(',');
  ok('模板表头含 网点名称/快递编码/抛比/省份/城市/区县', ['网点名称', '快递编码', '抛比', '省份', '城市', '区县'].every((c) => tjoined.includes(c)));
  ok('模板表头含 1kg 到 40kg', theader.includes('1kg') && theader.includes('40kg'));

  // 构造导入 Excel：3 行有效 + 1 空行 + 1 缺编码行
  const header = ['网点名称', '快递编码', '抛比', '省份', '城市', '区县', '1kg', '2kg', '3kg'];
  const rows = [
    ['中通-杭州西湖', 'ZT-XH', 6000, '浙江省', '杭州市', '西湖区', 3.5, 4.5, 5.5],
    ['中通-杭州全省', 'ZT-QS', 6000, '浙江省', '', '', 4.0, 5.0, 6.0],
    ['百世-上海', 'BS-SH', 12000, '上海', '', '', 3.0, 4.0, 5.0],
    ['', '', '', '', '', '', '', '', ''],                       // 空行 → 跳过
    ['某网点', '', 6000, '江苏省', '南京市', '', 2.0, 3.0, 4.0], // 缺编码 → 失败
  ];
  const ws = xlsx.utils.aoa_to_sheet([header, ...rows]);
  const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, '物流报价');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'q.xlsx');
  const imp = await (await fetch(base + '/api/logistics-quotes/import', { method: 'POST', headers: { 'X-ERP-Token': login.token }, body: fd })).json();
  ok('导入 created=3', imp.created === 3);
  ok('导入 failed=1（缺编码）', imp.failed === 1);
  ok('失败清单含「快递编码为空」', imp.failures && imp.failures[0] && /快递编码/.test(imp.failures[0].reason));

  // 2) 列表确认 3 行
  const list = (await (await fetch(base + '/api/logistics-quotes?page=1', { headers: H })).json());
  ok('列表 3 行', list.data && list.data.length === 3);

  // 3) 区域比价：浙江/杭州/西湖区 2kg → ZT-XH(4.5)
  const calc1 = (await (await fetch(base + '/api/smart-quote/calculate', {
    method: 'POST', headers: H,
    body: JSON.stringify({ rows: [{ estimatedWeight: 2, totalVolume: 0, province: '浙江省', city: '杭州市', district: '西湖区' }] }),
  })).json()).data[0];
  ok('西湖区 2kg → 推荐 ZT-XH(4.5)', calc1.recommendedCode === 'ZT-XH' && calc1.recommendedPrice === 4.5);

  // 4) 浙江/杭州/(无区) 2kg → 西湖区行不匹配 → ZT-QS(5.0)
  const calc2 = (await (await fetch(base + '/api/smart-quote/calculate', {
    method: 'POST', headers: H,
    body: JSON.stringify({ rows: [{ estimatedWeight: 2, totalVolume: 0, province: '浙江省', city: '杭州市', district: '' }] }),
  })).json()).data[0];
  ok('无区 2kg → 推荐 ZT-QS(5.0)', calc2.recommendedCode === 'ZT-QS' && calc2.recommendedPrice === 5.0);

  // 5) upsert：再次导入 ZT-XH 改 2kg=9.9 → updated=1，总数仍 3
  const ws2 = xlsx.utils.aoa_to_sheet([header, ['中通-杭州西湖', 'ZT-XH', 6000, '浙江省', '杭州市', '西湖区', 3.5, 1.0, 5.5]]);
  const wb2 = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb2, ws2, '物流报价');
  const buf2 = xlsx.write(wb2, { type: 'buffer', bookType: 'xlsx' });
  const fd2 = new FormData();
  fd2.append('file', new Blob([buf2], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'q2.xlsx');
  const imp2 = await (await fetch(base + '/api/logistics-quotes/import', { method: 'POST', headers: { 'X-ERP-Token': login.token }, body: fd2 })).json();
  ok('upsert updated=1', imp2.updated === 1 && imp2.created === 0);
  const list2 = (await (await fetch(base + '/api/logistics-quotes?page=1', { headers: H })).json());
  ok('upsert 后总数仍 3', list2.total === 3);
  // 验证 ZT-XH 的 2kg 已更新为 1.0（比 ZT-QS 的 5.0 更低 → 应选 ZT-XH）
  const reCalc = (await (await fetch(base + '/api/smart-quote/calculate', {
    method: 'POST', headers: H,
    body: JSON.stringify({ rows: [{ estimatedWeight: 2, totalVolume: 0, province: '浙江省', city: '杭州市', district: '西湖区' }] }),
  })).json()).data[0];
  ok('upsert 后 2kg 价格=1.0（ZT-XH 胜出）', reCalc.recommendedCode === 'ZT-XH' && reCalc.recommendedPrice === 1.0);

  // 6) 无 token → 401
  const noTok = await fetch(base + '/api/logistics-quotes/template');
  ok('无 token 401', noTok.status === 401);

  // 7) 新增必填校验：缺省份 / 缺抛比 → 失败清单带行号与原因（已落入解析层）
  const wsF = xlsx.utils.aoa_to_sheet([header,
    ['网点A', 'CODE-A', 6000, '', '杭州市', '', 1, 2, 3], // 缺省份
    ['网点B', 'CODE-B', '', '广东省', '', '', 1, 2, 3],   // 缺抛比
  ]);
  const wbF = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wbF, wsF, '物流报价');
  const bufF = xlsx.write(wbF, { type: 'buffer', bookType: 'xlsx' });
  const fdF = new FormData();
  fdF.append('file', new Blob([bufF], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'qF.xlsx');
  const impF = await (await fetch(base + '/api/logistics-quotes/import', { method: 'POST', headers: { 'X-ERP-Token': login.token }, body: fdF })).json();
  ok('新增必填校验 失败=2', impF.failed === 2);
  ok('失败含「省份为空」', (impF.failures || []).some((f) => /省份为空/.test(f.reason)));
  ok('失败含「抛比为空」', (impF.failures || []).some((f) => /抛比为空/.test(f.reason)));
  ok('失败清单含行号', (impF.failures || []).every((f) => typeof f.row === 'number'));

  server.close();
  try { fs.unlinkSync(TMP); } catch (e) {}
  console.log(`\n=== 物流报价导入/比价测试：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
