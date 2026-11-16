// 智能测单增强：配置(权限) + 历史测算 集成测试（隔离临时库）
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const xlsx = require('xlsx');

const TMP = path.join(__dirname, '..', 'data', '__smartq_enh_' + Date.now() + '.db');
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
process.env.ERP_DB_PATH = TMP;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } }

(async () => {
  execSync(`node ${path.join(__dirname, 'migrate_rbac.js')}`, { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });

  const db = new DatabaseSync(TMP);
  db.prepare(`INSERT INTO logistics_quotes (network_name,express_code,volume_ratio,price_rules)
    VALUES (?,?,?,?)`).run('网点A', 'ZT-A', 6000, '[{"min":0,"max":1,"price":2.5},{"min":1,"max":3,"price":4},{"min":3,"max":null,"price":6}]');
  // 植入一个业务员(op)，用于校验配置写权限
  const opHash = bcrypt.hashSync('op123', 10);
  db.prepare(`INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,?)`).run('op', opHash, '业务员', 2);
  db.close();

  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'X-ERP-Token': login.token };

  const opLogin = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op', password: 'op123' }),
  })).json();
  const OH = { 'Content-Type': 'application/json', 'X-ERP-Token': opLogin.token };

  // 1) GET /config 默认
  const cfg0 = (await (await fetch(base + '/api/smart-quote/config', { headers: H })).json()).data;
  ok('GET/config 默认起步重量=0', cfg0 && cfg0.startWeight === 0);
  ok('GET/config 默认模式=estimated', cfg0 && cfg0.startMode === 'estimated');
  ok('GET/config 默认含菜鸟/拼多多/抖音', cfg0 && ['菜鸟', '拼多多', '抖音'].every((t) => cfg0.waybillTypes.includes(t)));

  // 2) 业务员 GET /config 允许（200）
  const cfgOp = await fetch(base + '/api/smart-quote/config', { headers: OH });
  ok('业务员 GET/config 允许(200)', cfgOp.status === 200);

  // 3) 业务员 PUT /config 应 403
  const putOp = await fetch(base + '/api/smart-quote/config', { method: 'PUT', headers: OH, body: JSON.stringify({ startWeight: 5, startMode: 'billing', waybillTypes: ['抖音'] }) });
  ok('业务员 PUT/config 拒绝(403)', putOp.status === 403);

  // 4) 管理员 PUT /config 成功
  const putAdm = await (await fetch(base + '/api/smart-quote/config', { method: 'PUT', headers: H, body: JSON.stringify({ startWeight: 5, startMode: 'billing', waybillTypes: ['抖音', '快手'] }) })).json();
  ok('管理员 PUT/config 成功', putAdm && putAdm.data && putAdm.data.startWeight === 5 && putAdm.data.startMode === 'billing');
  ok('PUT/config 写入面单白名单', putAdm.data.waybillTypes.length === 2 && putAdm.data.waybillTypes.includes('快手'));

  // 5) PUT /config 校验：起步重量非法
  const badW = await fetch(base + '/api/smart-quote/config', { method: 'PUT', headers: H, body: JSON.stringify({ startWeight: -1, startMode: 'estimated', waybillTypes: ['抖音'] }) });
  ok('起步重量<0 被拒(400)', badW.status === 400);
  const noType = await fetch(base + '/api/smart-quote/config', { method: 'PUT', headers: H, body: JSON.stringify({ startWeight: 0, startMode: 'estimated', waybillTypes: [] }) });
  ok('空面单白名单被拒(400)', noType.status === 400);

  // 6) Excel 导入（多行，含不同面单类型/重量）→ 落库历史批次
  const rows = [
    ['SO单号', '货主名称', '电子面单类型', '省份', '城市', '预估重量(kg)', '总体积(立方米)'],
    ['SO01', '货主A', '抖音', '浙江', '杭州', 2, 0.012],
    ['SO02', '货主B', '菜鸟', '江苏', '南京', 1, 0.03],
    ['SO03', '货主C', '得物', '上海', '上海', 8, 0.1],
  ];
  const ws = xlsx.utils.aoa_to_sheet(rows);
  const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, '智能测单');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 't.xlsx');
  const imp = await (await fetch(base + '/api/smart-quote/import', { method: 'POST', headers: { 'X-ERP-Token': login.token }, body: fd })).json();
  ok('导入返回 3 行', imp.data && imp.data.length === 3);
  ok('导入返回 batchId', imp.batchId && Number(imp.batchId) > 0);

  // 7) 历史批次列表（管理员）
  const hist = await (await fetch(base + '/api/smart-quote/history', { headers: H })).json();
  const h0 = hist.data && hist.data[0];
  ok('历史批次列表含 1 条', hist.data && hist.data.length === 1);
  ok('批次 total_count=3', h0 && h0.total_count === 3);
  ok('批次 operator=admin', h0 && h0.operator === 'admin');

  // 8) 历史明细（搜索 + 分页）
  const recAll = await (await fetch(base + '/api/smart-quote/history/' + h0.id + '/records?page=1', { headers: H })).json();
  ok('明细返回 3 行', recAll.data && recAll.data.length === 3);
  ok('明细总条数=3', recAll.total === 3);
  const recSearch = await (await fetch(base + '/api/smart-quote/history/' + h0.id + '/records?q=SO02', { headers: H })).json();
  ok('按 SO 搜索命中 1 条', recSearch.data && recSearch.data.length === 1 && recSearch.data[0].so_no === 'SO02');

  // 9) 无 token 应 401
  const noTok = await fetch(base + '/api/smart-quote/history', { headers: {} });
  ok('历史列表无 token 401', noTok.status === 401);

  server.close();
  try { fs.unlinkSync(TMP); } catch (e) { /* 临时库清理失败不影响结果 */ }
  console.log(`\n=== 智能测单增强测试：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
