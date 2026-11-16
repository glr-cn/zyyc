// 发货工时 模板下载 + 导入（预览重复 + 覆盖/跳过）回归（隔离库 + 服务 3001）
// 启动：ERP_DB_PATH=<含test的库> PORT=3001 node src/server.js
const BASE = 'http://127.0.0.1:3001';
const DB_PATH = process.env.ERP_DB_PATH || '';
if (!/test/i.test(DB_PATH)) { console.error('必须设置隔离测试库'); process.exit(1); }
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('xlsx');
{
  const d = new DatabaseSync(DB_PATH);
  d.exec('DELETE FROM work_hours; DELETE FROM customers; DELETE FROM audit_logs;');
  d.close();
}
let TOKEN = '', failed = 0, passed = 0;
function ok(c, m, extra) {
  if (c) { passed++; console.log('PASS:', m); }
  else { failed++; console.error('FAIL:', m, extra != null ? JSON.stringify(extra).slice(0, 400) : ''); }
}
{
  const d = new DatabaseSync(DB_PATH);
  const hash = require('bcryptjs').hashSync('admin123', 10);
  d.prepare('INSERT OR IGNORE INTO users(user_id,username,password_hash,display_name,role_id) VALUES(1,?,?,?,1)').run('admin', hash, '管理员');
  d.close();
}
async function api(method, path, opts = {}) {
  const headers = {};
  if (TOKEN) headers['X-ERP-Token'] = TOKEN;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const r = await fetch(BASE + path, { method, headers, body: opts.body });
  const ct = r.headers.get('content-type') || '';
  let data;
  if (ct.includes('json')) data = await r.json();
  else data = Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
function buildXlsx(aoa) {
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, '发货工时');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function form(buf, extra = {}) {
  const f = new FormData();
  f.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'hours.xlsx');
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
}

(async () => {
  let r = await api('POST', '/api/auth/login', { json: { username: 'admin', password: 'admin123' } });
  TOKEN = r.data.token;
  ok(r.status === 200 && !!TOKEN, '登录 admin');

  const ca = await api('POST', '/api/customers', { json: { customer_type: '仓储客户', company_name: '导入甲客户', short_name: '导甲', warehouse: '佳新仓', coop_status: '合作中' } });
  const cb = await api('POST', '/api/customers', { json: { customer_type: '仓储客户', company_name: '导入乙客户', short_name: '导乙', warehouse: '佳新仓', coop_status: '暂停' } });
  const cs = await api('POST', '/api/customers', { json: { customer_type: '仓储客户', company_name: '速远导入客户', short_name: '速导', warehouse: '速远仓', coop_status: '合作中' } });
  ok(ca.status === 201 && cb.status === 201 && cs.status === 201, '创建客户（含停用 + 速远专属）');
  const idA = ca.data.data.customer_id;

  // --- 1. 模板下载：预填本仓货主，不含速远专属；表头 7 列 ---
  r = await api('GET', '/api/workhours/template?warehouse=' + encodeURIComponent('佳新仓'));
  ok(r.status === 200 && Buffer.isBuffer(r.data), '模板下载 200（未被 /:id 吞）', r.status);
  const wb = xlsx.read(r.data, { type: 'buffer' });
  const rows = xlsx.utils.sheet_to_json(wb.Sheets['发货工时'], { defval: '' });
  const header = Object.keys(rows[0] || {});
  ok(header.length === 7 && header[0] === '日期' && header[1] === '客户名称', '模板表头 7 列正确', header);
  const names = rows.map((x) => x['客户名称']);
  ok(names.includes('导入甲客户'), '模板预填本仓启用货主', names);
  ok(!names.includes('导入乙客户'), '模板不含停用货主（新语义：停用不展现）', names);
  ok(!names.includes('速远导入客户'), '模板不含速远仓专属货主', names);
  // 模板第一列日期默认今天、单位默认「单」
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  ok(rows.every((x) => x['日期'] === todayStr), '模板日期列默认今天', rows.map((x) => x['日期']));
  ok(rows.every((x) => x['单位'] === '单'), '模板单位列默认单', rows.map((x) => x['单位']));

  // --- 2. 首次导入：2 行全新建 ---
  const a1 = buildXlsx([
    ['日期', '客户名称', '单位', '发货单量', '主工时', '其他工时', '备注'],
    ['2026-11-01', '导入甲客户', '件', 10, 2, 0, ''],
    ['2026-11-02', '导入甲客户', '件', 20, 3, 0, ''],
  ]);
  r = await api('POST', '/api/workhours/import?warehouse=' + encodeURIComponent('佳新仓'), { body: form(a1) });
  ok(r.status === 200 && r.data.created === 2, '首次导入 2 行全新建', r.data);
  // 校验总工时/单均成本派生正确（10单/2h → 效率5；总工时2 → 单均0.2）
  {
    const d = new DatabaseSync(DB_PATH);
    const row = d.prepare("SELECT * FROM work_hours WHERE date='2026-11-01' AND customer_id=?").get(idA);
    d.close();
    ok(row && row.ship_orders === 10 && row.total_hours === 2 && Math.abs(row.efficiency - 5) < 1e-6,
      '导入派生字段（总工时/效率）正确', row);
  }

  // --- 3. 预览：1 行重复 + 1 行新（停用货主补报）---
  const a2 = buildXlsx([
    ['日期', '客户名称', '单位', '发货单量', '主工时', '其他工时', '备注'],
    ['2026-11-01', '导入甲客户', '件', 99, 9, 0, '覆盖测试'],
    ['2026-11-05', '导入乙客户', '件', 5, 1, 0, '停用补报'],
  ]);
  r = await api('POST', '/api/workhours/import/preview?warehouse=' + encodeURIComponent('佳新仓'), { body: form(a2) });
  ok(r.status === 200 && r.data.duplicateCount === 1 && r.data.createCount === 1,
    '预览检测 1 重复 + 1 新建', { dup: r.data.duplicateCount, create: r.data.createCount });
  const dupRow = r.data.data.find((x) => x.duplicate);
  ok(dupRow && dupRow.line === 2 && dupRow.existing && dupRow.existing.ship_orders === 10,
    '重复行标注行号与已有值', dupRow);

  // --- 4. 确认导入：重复行 overwrite，新行 create ---
  r = await api('POST', '/api/workhours/import?warehouse=' + encodeURIComponent('佳新仓'), {
    body: form(a2, { decisions: JSON.stringify({ 2: 'overwrite', 3: 'create' }) }),
  });
  ok(r.status === 200 && r.data.overwritten === 1 && r.data.created === 1 && r.data.skipped === 0,
    '导入按决策：覆盖 1 + 新建 1', r.data);
  {
    const d = new DatabaseSync(DB_PATH);
    const covered = d.prepare("SELECT ship_orders,main_hours,total_hours,remark FROM work_hours WHERE date='2026-11-01' AND customer_id=?").get(idA);
    const stopAdded = d.prepare("SELECT COUNT(*) c FROM work_hours WHERE date='2026-11-05'").get().c;
    const total = d.prepare('SELECT COUNT(*) c FROM work_hours').get().c;
    d.close();
    ok(covered.ship_orders === 99 && covered.main_hours === 9 && covered.remark === '覆盖测试', '覆盖写入生效', covered);
    ok(stopAdded === 1, '停用货主补报成功', stopAdded);
    ok(total === 3, '总数 3（覆盖不新增行）', total);
  }

  // --- 5. 默认 skip：重复行不改 ---
  r = await api('POST', '/api/workhours/import?warehouse=' + encodeURIComponent('佳新仓'), { body: form(a2) });
  ok(r.status === 200 && r.data.skipped === 2 && r.data.created === 0,
    '无决策时重复行默认跳过', r.data);
  {
    const d = new DatabaseSync(DB_PATH);
    const still = d.prepare("SELECT ship_orders FROM work_hours WHERE date='2026-11-01' AND customer_id=?").get(idA);
    d.close();
    ok(still.ship_orders === 99, '跳过不覆盖原值', still);
  }

  // --- 6. 非法客户/跨仓客户 → errors 提示，不落库 ---
  const bad = buildXlsx([
    ['日期', '客户名称', '单位', '发货单量', '主工时', '其他工时', '备注'],
    ['2026-11-03', '速远导入客户', '件', 5, 1, 0, ''],
    ['2026-11-03', '不存在的客户', '件', 5, 1, 0, ''],
  ]);
  r = await api('POST', '/api/workhours/import?warehouse=' + encodeURIComponent('佳新仓'), { body: form(bad) });
  ok(r.status === 200 && r.data.errors.length === 2 && r.data.created === 0,
    '跨仓/不存在客户被拦截并提示', r.data.errors);

  console.log(`\n结果：${passed} PASS / ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
