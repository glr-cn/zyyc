// 智能测单：隔离临时库集成测试（不污染发布库）
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('xlsx');

const TMP = path.join(__dirname, '..', 'data', '__smartq_test__.db');
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
process.env.ERP_DB_PATH = TMP;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } }

(async () => {
  // 1) 初始化临时库（角色/菜单/管理员）
  execSync(`node ${path.join(__dirname, 'migrate_rbac.js')}`, { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });

  // 2) 植入报价网点用于比价（新规则：省/市/县区三级严格降级，
  //    省份为空的「全国通用」行不再参与比价，故测试数据须带真实省市）
  const db = new DatabaseSync(TMP);
  const rules = '[{"min":0,"max":1,"price":2.5},{"min":1,"max":3,"price":4},{"min":3,"max":null,"price":6}]';
  const ins = db.prepare(`INSERT INTO logistics_quotes (network_name,express_code,province,city,district,volume_ratio,price_rules)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run('测试网点-杭州', 'ZT-TEST', '浙江', '杭州', '', 6000, rules);
  ins.run('测试网点-南京', 'ZT-TEST', '江苏', '南京', '', 6000, rules);
  db.close();

  // 3) 启动服务（监听 0 端口，绕过平台网关）
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'X-ERP-Token': login.token };

  // 4) 单笔测算：est=2, vol=0.012 → 抛比=2, 计费=2, 段[1,3]=4 → 推荐 ZT-TEST
  const calc = await (await fetch(base + '/api/smart-quote/calculate', {
    method: 'POST', headers: H, body: JSON.stringify({ rows: [{ soNo: 'S1', ownerName: '货主A', waybillType: '普通', province: '浙江', city: '杭州', estimatedWeight: 2, totalVolume: 0.012 }] }),
  })).json();
  const c0 = calc.data && calc.data[0];
  ok('单笔测算返回数据', !!c0);
  ok('推荐编码=ZT-TEST', c0 && c0.recommendedCode === 'ZT-TEST');
  ok('抛比重量≈2', c0 && Math.abs(c0.volumetricWeight - 2) < 1e-6);
  ok('计费重量=2', c0 && c0.billingWeight === 2);
  ok('推荐总价=4', c0 && c0.recommendedPrice === 4);

  // 5) 模板下载
  const tpl = await fetch(base + '/api/smart-quote/template', { headers: H });
  ok('模板下载 200', tpl.status === 200);
  ok('模板为 xlsx', (tpl.headers.get('content-type') || '').includes('spreadsheetml'));

  // 6) Excel 导入：构造一个 xlsx 上传
  const ws = xlsx.utils.aoa_to_sheet([['SO单号', '货主名称', '电子面单类型', '省份', '城市', '预估重量(kg)', '总体积(立方米)'], ['SO2', '货主B', '普通', '江苏', '南京', 5, 0.05]]);
  const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, '智能测单');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 't.xlsx');
  const imp = await (await fetch(base + '/api/smart-quote/import', { method: 'POST', headers: { 'X-ERP-Token': login.token }, body: fd })).json();
  const i0 = imp.data && imp.data[0];
  ok('导入返回 1 行', imp.data && imp.data.length === 1);
  // vol=0.05 → 0.05*1e6/6000=8.333 → 计费=9 → 段[3,∞]=6 → 推荐 ZT-TEST, 价6
  ok('导入推荐编码=ZT-TEST', i0 && i0.recommendedCode === 'ZT-TEST');
  ok('导入计费重量=9', i0 && i0.billingWeight === 9);
  ok('导入推荐总价=6', i0 && i0.recommendedPrice === 6);

  // 7) 无 token 应 401
  const noTok = await fetch(base + '/api/smart-quote/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok('无 token 401', noTok.status === 401);

  server.close();
  try { fs.unlinkSync(TMP); } catch (e) { /* Windows 安全删除钩子：清理失败不影响测试结果 */ }
  console.log(`\n=== 智能测单集成测试：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
