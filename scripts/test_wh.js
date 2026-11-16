// 工时深度重构端到端验证（隔离临时库 + 临时服务 3001）
// 必须先启动：ERP_DB_PATH=/tmp/erp_wh_test.db PORT=3001 node src/server.js
const BASE = 'http://127.0.0.1:3001';

// 可重复运行：仅在显式指定「含 test 的隔离库」时清空业务数据，绝不触碰默认主库
const DB_PATH = process.env.ERP_DB_PATH || '';
if (!/test/i.test(DB_PATH)) {
  console.error('必须设置 ERP_DB_PATH 指向隔离测试库（路径含 test），拒绝在默认主库上运行');
  process.exit(1);
}
{
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(DB_PATH);
  // 顺序：先删引用方，再删被引用方（inventory_transactions.order_id → orders.customer_id → customers）
  d.exec('DELETE FROM inventory_transactions; DELETE FROM orders; DELETE FROM work_hours; DELETE FROM customers; DELETE FROM audit_logs;');
  d.close();
}

let TOKEN = '';
let failed = 0;
function assert(c, m) {
  if (!c) { console.error('FAIL: ' + m); failed++; } else console.log('PASS: ' + m);
}
async function jcall(method, path, body) {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (TOKEN) opt.headers['Authorization'] = 'Bearer ' + TOKEN;
  const r = await fetch(BASE + path, opt);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

(async () => {
  let r = await jcall('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  TOKEN = r.data.token;
  assert(r.status === 200, '登录 admin');

  const cA = await jcall('POST', '/api/customers', { customer_type: '仓储客户', company_name: '甲公司', short_name: '甲货主', warehouse: ['龙湖仓'] });
  const cB = await jcall('POST', '/api/customers', { customer_type: '仓储客户', company_name: '乙公司', short_name: '乙货主', warehouse: ['龙湖仓'] });
  assert(cA.status === 201 && cB.status === 201, '创建两个客户(货主)');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '发货', customer_name: '甲货主', unit: '件', date: '2026-11-10', ship_orders: 100, main_hours: 10, other_hours: 2, shared_hours: 3 });
  assert(r.status === 201 && r.data.data.total_hours === 15, '发货: total_hours=15');
  assert(Math.abs(r.data.data.unit_cost - 0.15) < 1e-9, '发货: unit_cost=0.150');
  assert(Math.abs(r.data.data.efficiency - 10) < 1e-9, '发货: efficiency=10.000');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '收货', customer_name: '甲货主', unit: '箱', date: '2026-11-10', cartons: 50, main_hours: 5, other_hours: 1 });
  assert(r.status === 201 && r.data.data.total_hours === 6, '收货: total_hours=6');
  assert(Math.abs(r.data.data.doc_cost - 0.12) < 1e-9, '收货: doc_cost=0.120');
  assert(Math.abs(r.data.data.efficiency - 10) < 1e-9, '收货: efficiency=10.000');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '库内', project: '上架', date: '2026-11-10', main_hours: 4, other_hours: 1 });
  assert(r.status === 201 && r.data.data.total_hours === 5, '库内: total_hours=5');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '后勤', project: '制单人员', date: '2026-11-10', main_hours: 3, other_hours: 0 });
  assert(r.status === 201 && r.data.data.total_hours === 3, '后勤: total_hours=3');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '发货', customer_name: '甲货主', unit: '件', date: '2026-10-10', ship_orders: 50, main_hours: 5, other_hours: 1, shared_hours: 2 });
  assert(r.status === 201, '上月发货录入(用于环比)');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '发货', customer_name: '不存在货主', ship_orders: 10, main_hours: 1, date: '2026-11-10' });
  assert(r.status === 400, '发货客户名不存在→400(强制关联)');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '发货', customer_name: '甲货主', ship_orders: 0, main_hours: 1, date: '2026-11-10' });
  assert(r.status === 400, '发货单量=0→400');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '库内', project: '非法项', date: '2026-11-10', main_hours: 1 });
  assert(r.status === 400, '库内项目非法→400');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '后勤', project: '非法项', date: '2026-11-10', main_hours: 1 });
  assert(r.status === 400, '后勤项目非法→400');

  r = await jcall('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '库内', project: '上架', date: '2026-11-10', main_hours: -1 });
  assert(r.status === 400, '工时为负→400');

  r = await jcall('POST', '/api/workhours', { warehouse: '外星仓', work_type: '库内', project: '上架', date: '2026-11-10', main_hours: 1 });
  assert(r.status === 400, '仓库非法→400');

  r = await jcall('GET', '/api/workhours');
  assert(r.status === 400, '列表缺 warehouse/work_type→400(防串仓)');

  r = await jcall('GET', '/api/workhours?warehouse=佳新仓&work_type=发货');
  assert(r.status === 200 && r.data.total === 0, '佳新仓(空仓)→0 条');

  r = await jcall('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货&trend=month');
  // 新版：发货 pending 视图 = 已填记录(2条甲) + 本期未填货主缺口(乙1条) = 3
  assert(r.status === 200 && r.data.total === 3, '龙湖仓发货 2 已填 + 1 未填缺口 = 3');
  assert(r.data.data.filter((x) => x.filled === 0).length === 1, '含 1 条未填写缺口行（乙货主）');
  const novRow = r.data.data.find((x) => x.date === '2026-11-10');
  assert(novRow.trend && novRow.trend.ship_orders.deltaPct === 100 && novRow.trend.ship_orders.dir === 'up', '发货环比(月): 10月100/11月100 → +100% up');
  const octRow = r.data.data.find((x) => x.date === '2026-10-10');
  assert(octRow.trend.ship_orders.deltaPct === null, '上月行更早无数据→deltaPct null');

  r = await jcall('GET', '/api/analytics/summary?mode=month');
  assert(r.status === 200 && Array.isArray(r.data.table) && r.data.table.length > 0, 'summary 按月返回 table');
  assert(r.data.chart1 && r.data.chart2, 'summary 含 chart1/chart2');

  r = await jcall('GET', '/api/analytics/dashboard');
  assert(r.status === 200 && r.data.month === '2026-11' && typeof r.data.avg_unit_cost === 'number', 'dashboard 返回本月指标');
  assert(r.data.owner_rank && Array.isArray(r.data.owner_rank.top3), 'dashboard 排名结构');

  const db = require('../src/db');
  const acts = db.prepare("SELECT DISTINCT action FROM audit_logs WHERE table_name='work_hours'").all().map((x) => x.action);
  assert(acts.includes('create'), '审计含 work_hours create (' + JSON.stringify(acts) + ')');

  console.log(failed === 0 ? '=== 全部通过 ===' : '=== 有 ' + failed + ' 项失败 ===');
  process.exit(failed === 0 ? 0 : 1);
})();
