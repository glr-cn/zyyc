// 物流报价「导出 Excel」隔离库冒烟测试
// 验证：① 表头与导入模板完全一致 ② 空重量段留空(null) ③ 全国/不限兜底
//       ④ 搜索过滤生效 ⑤ 行数正确 ⑥ 导出前后 DB 数据零改动（纯只读铁律）
// 用法：node scripts/test_export.js
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('xlsx');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name, extra != null ? '=> ' + JSON.stringify(extra) : ''); } }
const rules = (p) => JSON.stringify([{ weight: 1, price: p }, { weight: 2, price: p + 1 }, { weight: 40, price: p + 2 }]);

async function main() {
  const TMP = path.join(__dirname, '..', 'data', '__export_' + Date.now() + '.db');
  process.env.ERP_DB_PATH = TMP;
  delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy; delete process.env.https_proxy;

  execSync('node ' + JSON.stringify(path.join(__dirname, 'migrate_rbac.js')),
    { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });

  // 种子数据：
  //  - ZT-SD 山东济南（简称，验证清洗）+ 空段（仅1/2/40kg有价）
  //  - YTO4  全国/不限（province 空 → 导出应填"全国"）
  //  - AB-CD 旧区间格式 [{min,max,price}]（验证兼容）
  const d = new DatabaseSync(TMP);
  const ins = d.prepare('INSERT INTO logistics_quotes (network_name,express_code,province,city,district,volume_ratio,price_rules) VALUES (?,?,?,?,?,?,?)');
  ins.run('中通-山东', 'ZT-SD', '山东', '济南', '历下', 6000, rules(5));
  ins.run('圆通全国', 'YTO4', '', '', '', 4000, rules(9));
  ins.run('旧格式快递', 'OLD-1', '浙江省', '杭州市', '', 5000, JSON.stringify([{ min: 1, max: 3, price: 7 }]));
  const snapshot = d.prepare('SELECT id,network_name,express_code,province,city,district,volume_ratio,price_rules FROM logistics_quotes ORDER BY id').all();
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
    // ---- 全量导出 ----
    const res = await fetch(base + '/api/logistics-quotes/export?sharecode=', { headers: H });
    ok('导出接口返回 200', res.status === 200, res.status);
    const ct = res.headers.get('content-type') || '';
    ok('Content-Type 为 xlsx', /spreadsheetml/.test(ct), ct);
    const cd = res.headers.get('content-disposition') || '';
    ok('带 attachment 下载头', /attachment/.test(cd) && /\.xlsx/.test(cd), cd);
    const buf = Buffer.from(await res.arrayBuffer());

    const wb = xlsx.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: undefined });
    const header = aoa[0];
    const dataRows = aoa.slice(1);

    // ① 表头与模板完全一致
    const tmpl = require('../src/services/quoteImport').buildTemplateAOA()[0];
    ok('表头与导入模板列数一致', header.length === tmpl.length, { got: header.length, want: tmpl.length });
    ok('表头与导入模板逐列完全一致', JSON.stringify(header) === JSON.stringify(tmpl), { got: header.slice(0, 8), want: tmpl.slice(0, 8) });
    ok('表头第1列=网点名称、第6列=区县、第7列=1kg、末列=40kg',
      header[0] === '网点名称' && header[5] === '区县' && header[6] === '1kg' && header[header.length - 1] === '40kg', header);

    // ⑤ 行数 = 3（一条记录一行）
    ok('导出行数=种子记录数(3)', dataRows.length === 3, dataRows.length);

    // 按编码定位行（列索引：0网点 1编码 2抛比 3省 4市 5区 6=1kg ... 45=40kg）
    const rowOf = (code) => dataRows.find((r) => r[1] === code);
    const sd = rowOf('ZT-SD');
    const yto = rowOf('YTO4');
    const old = rowOf('OLD-1');

    // ③ 全国/不限兜底
    ok('YTO4(p省为空) 省份填「全国」', yto && yto[3] === '全国', yto && yto.slice(0, 6));
    ok('YTO4 城市/区县留空', yto && (yto[4] == null || yto[4] === '') && (yto[5] == null || yto[5] === ''), yto && yto.slice(0, 6));

    // 地址清洗展示
    ok('山东→山东省（展示层清洗）', sd && sd[3] === '山东省', sd && sd.slice(0, 6));
    ok('济南→济南市', sd && sd[4] === '济南市', sd && sd.slice(0, 6));
    ok('历下→历下区', sd && sd[5] === '历下区', sd && sd.slice(0, 6));

    // ② 空重量段留空：SD 只在 1/2/40kg 有价（5/6/42），3-39kg 应全空
    ok('ZT-SD 1kg=5', sd && sd[6] === 5, sd && sd[6]);
    ok('ZT-SD 2kg=6', sd && sd[7] === 6, sd && sd[7]);
    ok('ZT-SD 3kg 留空(null/undefined)', sd && (sd[8] == null), sd && sd[8]);
    ok('ZT-SD 20kg 留空', sd && (sd[6 + 19] == null), sd && sd[6 + 19]);
    ok('ZT-SD 40kg=7', sd && sd[45] === 7, sd && sd[45]);

    // 兼容旧区间格式：min1-max3 price7 → 1/2/3kg 都=7，4kg 空
    ok('旧区间格式 1kg=7', old && old[6] === 7, old && old[6]);
    ok('旧区间格式 2kg=7', old && old[7] === 7, old && old[7]);
    ok('旧区间格式 3kg=7', old && old[8] === 7, old && old[8]);
    ok('旧区间格式 4kg 留空', old && old[9] == null, old && old[9]);

    // ④ 搜索过滤：q=ZT 只返回 ZT-SD 一行
    const res2 = await fetch(base + '/api/logistics-quotes/export?q=ZT', { headers: H });
    ok('带搜索参数返回 200', res2.status === 200, res2.status);
    const wb2 = xlsx.read(Buffer.from(await res2.arrayBuffer()), { type: 'buffer' });
    const aoa2 = xlsx.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, raw: true, defval: undefined });
    ok('搜索 q=ZT 只导出 1 行', aoa2.length - 1 === 1, aoa2.length - 1);
    ok('搜索结果编码为 ZT-SD', aoa2[1] && aoa2[1][1] === 'ZT-SD', aoa2[1] && aoa2[1][1]);

    // 搜索 q=不存在 → 只有表头，0 行
    const res3 = await fetch(base + '/api/logistics-quotes/export?q=__NOPE__', { headers: H });
    const wb3 = xlsx.read(Buffer.from(await res3.arrayBuffer()), { type: 'buffer' });
    const aoa3 = xlsx.utils.sheet_to_json(wb3.Sheets[wb3.SheetNames[0]], { header: 1 });
    ok('搜索无结果 → 仅表头0行', aoa3.length === 1, aoa3.length);

    // ⑥ 只读铁律：导出前后 DB 快照完全一致
    const d2 = new DatabaseSync(TMP);
    const after = d2.prepare('SELECT id,network_name,express_code,province,city,district,volume_ratio,price_rules FROM logistics_quotes ORDER BY id').all();
    d2.close();
    ok('导出前后 DB 数据逐行完全一致（零写库）', JSON.stringify(snapshot) === JSON.stringify(after));

  } finally {
    server.close();
    try { fs.rmSync(TMP, { force: true }); } catch (e) { /* 安全删除钩子可能拦截，忽略 */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
