// 仓储客户模块 E2E：需 3001 隔离服务（ERP_DB_PATH=/tmp/erp_cust_test.db PORT=3001 node src/server.js）
// 覆盖：模板下载 / 手工 CRUD / 三分类隔离 / 多仓 LIKE / Excel Upsert / 失败清单 / 下游兼容
const assert = require('assert');
const xlsx = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { HEADERS } = require('../src/services/customerImport');

const BASE = 'http://127.0.0.1:3001';

// 可重复运行：仅在显式指定「含 test 的隔离库」时清空业务数据，绝不触碰默认主库
const DB_PATH = process.env.ERP_DB_PATH || '';
if (!/test/i.test(DB_PATH)) {
  console.error('必须设置 ERP_DB_PATH 指向隔离测试库（路径含 test），拒绝在默认主库上运行');
  process.exit(1);
}
{
  const d = new DatabaseSync(DB_PATH);
  // 顺序：先删引用方，再删被引用方（inventory_transactions.order_id → orders.customer_id → customers）
  d.exec('DELETE FROM inventory_transactions; DELETE FROM orders; DELETE FROM work_hours; DELETE FROM customers; DELETE FROM audit_logs;');
  d.close();
}

let TOKEN = '';
let pass = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fails.push({ name, msg: e.message }); console.log('FAIL ' + name + ' -> ' + e.message); }
}
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (TOKEN) opt.headers.Authorization = 'Bearer ' + TOKEN;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opt);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function xbuf(headers, rows) {
  const ws = xlsx.utils.aoa_to_sheet([headers, ...rows]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'S');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function importRows(rows) {
  return xbuf(HEADERS, rows.map((r) => HEADERS.map((h) => (r[h] == null ? '' : r[h]))));
}
async function uploadExcel(buf, type) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'import.xlsx');
  fd.append('customer_type', type || '仓储客户');
  const res = await fetch(BASE + '/api/customers/import', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd,
  });
  return { status: res.status, data: await res.json() };
}
const baseRow = (o = {}) => Object.assign({
  货主代码: 'C100', 公司全称: '测试公司', 客户简称: '测试', 所在仓库: '龙湖仓',
  客户联系人: '张三', 联系电话: '13800000000', 客户地址: '上海市', ERP版本名称: '旺店通',
  产品类型: '百货', 电商平台: '淘宝', 商品种类数: 10, 打款账户: '6222', 预充单价: 0.35,
  截单时间: '16:00', 物流公司控制: '申通', 效期管理: '是', 合作状态: '合作中', 备注: '',
}, o);
const manual = (o = {}) => Object.assign({
  customer_type: '仓储客户', customer_code: 'C001', company_name: '甲公司', short_name: '甲',
  warehouse: ['龙湖仓'], product_count: 10, prepaid_price: 0.35, cutoff_time: '16:00',
  expiry_mgmt: '是', coop_status: '合作中',
}, o);

(async function run() {
  await t('health 200', async () => {
    const r = await api('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.tables.includes('customers'));
  });
  await t('登录取得 token', async () => {
    const r = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    assert.strictEqual(r.status, 200);
    TOKEN = r.data.token;
    assert.ok(TOKEN && TOKEN.length > 50);
  });
  await t('下载导入模板：xlsx 魔数 + 18 列表头', async () => {
    const res = await fetch(BASE + '/api/customers/template', { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.strictEqual(res.status, 200);
    const b = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(b.subarray(0, 2).toString(), 'PK');
    const wb = xlsx.read(b, { type: 'buffer' });
    const head = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0];
    assert.deepStrictEqual(head, HEADERS);
  });

  // ---------- 手工新增 ----------
  let idA, idB;
  await t('手工新增仓储客户 A（多仓：龙湖仓,佳新仓）', async () => {
    const r = await api('POST', '/api/customers', manual({
      company_name: '甲方供应链有限公司', short_name: '甲方', warehouse: ['龙湖仓', '佳新仓'], customer_code: 'C001',
    }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    idA = r.data.data.customer_id;
    assert.strictEqual(r.data.data.warehouse, '龙湖仓,佳新仓');
    assert.strictEqual(r.data.data.company_name, '甲方供应链有限公司');
    assert.strictEqual(r.data.data.prepaid_price, 0.35);
    assert.strictEqual(r.data.data.customer_type, '仓储客户');
  });
  await t('手工新增仓储客户 B（仅龙湖仓）/ C（仅佳新仓）', async () => {
    const b = await api('POST', '/api/customers', manual({ company_name: '乙方物流有限公司', short_name: '乙方', warehouse: ['龙湖仓'], customer_code: 'C002' }));
    const c = await api('POST', '/api/customers', manual({ company_name: '丙方商贸有限公司', short_name: '丙方', warehouse: ['佳新仓'], customer_code: 'C003' }));
    assert.strictEqual(b.status, 201, JSON.stringify(b.data));
    assert.strictEqual(c.status, 201, JSON.stringify(c.data));
    idB = b.data.data.customer_id;
  });
  await t('共享单号 / 快运物流：仓库可空且隐藏录入项也能创建', async () => {
    const s = await api('POST', '/api/customers', manual({ customer_type: '共享单号', company_name: '共享单号甲', short_name: '共享甲', warehouse: [], customer_code: 'S001' }));
    const e = await api('POST', '/api/customers', manual({ customer_type: '快运物流', company_name: '快运物流甲', short_name: '快运甲', warehouse: [], customer_code: 'E001' }));
    assert.strictEqual(s.status, 201, JSON.stringify(s.data));
    assert.strictEqual(e.status, 201, JSON.stringify(e.data));
    assert.strictEqual(s.data.data.warehouse, '');
    assert.strictEqual(e.data.data.customer_type, '快运物流');
  });

  // ---------- 分类隔离 / 多仓 LIKE ----------
  await t('分类隔离：仓储客户 3 条、共享单号 1 条、快运物流 1 条', async () => {
    for (const [type, n] of [['仓储客户', 3], ['共享单号', 1], ['快运物流', 1]]) {
      const r = await api('GET', '/api/customers?customer_type=' + encodeURIComponent(type));
      assert.strictEqual(r.data.total, n, type + ' 条数=' + r.data.total);
      assert.ok(r.data.data.every((x) => x.customer_type === type));
    }
  });
  await t('多仓 LIKE：龙湖仓命中 2 条（含多仓 A）', async () => {
    const r = await api('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户') + '&warehouse=' + encodeURIComponent('龙湖仓'));
    assert.strictEqual(r.data.total, 2);
    assert.ok(r.data.data.some((x) => x.company_name === '甲方供应链有限公司'));
  });
  await t('多仓 LIKE：佳新仓命中 2 条（含多仓 A）', async () => {
    const r = await api('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户') + '&warehouse=' + encodeURIComponent('佳新仓'));
    assert.strictEqual(r.data.total, 2);
    assert.ok(r.data.data.some((x) => x.company_name === '甲方供应链有限公司'));
  });
  await t('多仓 LIKE：速远仓 0 条；非法仓库参数 400', async () => {
    const ok = await api('GET', '/api/customers?warehouse=' + encodeURIComponent('速远仓'));
    assert.strictEqual(ok.data.total, 0);
    const bad = await api('GET', '/api/customers?warehouse=' + encodeURIComponent('龙湖仓%'));
    assert.strictEqual(bad.status, 400);
  });
  await t('搜索命中公司全称/简称', async () => {
    const r = await api('GET', '/api/customers?q=' + encodeURIComponent('甲方'));
    assert.strictEqual(r.data.total, 1);
  });

  // ---------- 手工校验 / 编辑 ----------
  await t('手工校验：公司全称重复 / 缺公司全称 / 仓储客户缺仓库 → 400', async () => {
    const dup = await api('POST', '/api/customers', manual({ company_name: '甲方供应链有限公司', customer_code: 'C999' }));
    const miss = await api('POST', '/api/customers', manual({ company_name: '', customer_code: 'C998' }));
    const nowh = await api('POST', '/api/customers', manual({ company_name: '无仓库公司', warehouse: [], customer_code: 'C997' }));
    assert.strictEqual(dup.status, 400);
    assert.strictEqual(miss.status, 400);
    assert.strictEqual(nowh.status, 400);
    assert.ok(nowh.data.error.includes('所在仓库必填'));
  });
  await t('编辑客户：字段更新 + 客户类型锁定', async () => {
    const r = await api('PUT', '/api/customers/' + idA, { prepaid_price: 1.2345, cutoff_time: '18:30', remark: '已更新' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.data.prepaid_price, 1.235);
    assert.strictEqual(r.data.data.cutoff_time, '18:30');
    assert.strictEqual(r.data.data.customer_type, '仓储客户');
    assert.strictEqual(r.data.data.company_name, '甲方供应链有限公司');
  });
  await t('合作状态切换：合作中 ↔ 暂停', async () => {
    const r = await api('POST', '/api/customers/' + idA + '/toggle-status', {});
    assert.strictEqual(r.data.data.coop_status, '暂停');
    const r2 = await api('POST', '/api/customers/' + idA + '/toggle-status', {});
    assert.strictEqual(r2.data.data.coop_status, '合作中');
  });
  await t('/active 返回兼容别名（客户名称/货主名称/状态）', async () => {
    const r = await api('GET', '/api/customers/active');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.data.length >= 3);
    const a = r.data.data.find((x) => x.company_name === undefined && x.customer_name === '甲方供应链有限公司');
    assert.ok(a, '应含公司全称别名');
    assert.strictEqual(a.owner_name, '甲方');
    assert.strictEqual(a.status, '启用');
  });

  // ---------- Excel 导入 ----------
  await t('Excel 导入：新增 + 按公司全称 Upsert + 失败清单含行号', async () => {
    const buf = importRows([
      baseRow({ 货主代码: 'C200', 公司全称: '丁方电商有限公司', 客户简称: '丁方', 所在仓库: '龙湖仓、佳新仓' }),
      baseRow({ 货主代码: '', 公司全称: '甲方供应链有限公司', 客户简称: '甲方', 预充单价: 9.8765, 所在仓库: '开元仓' }), // Upsert，货主代码为空
      baseRow({ 货主代码: 'C201', 公司全称: '', 所在仓库: '龙湖仓' }),                                            // 缺公司全称
      baseRow({ 货主代码: 'C202', 公司全称: '非法仓公司', 所在仓库: '火星仓' }),                                  // 非法仓名
      baseRow({ 货主代码: 'C203', 公司全称: '非法时间公司', 截单时间: '25:99' }),                                 // 时间非法
    ]);
    const r = await uploadExcel(buf);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.created, 1, '新增 1 条');
    assert.strictEqual(r.data.updated, 1, 'Upsert 更新 1 条');
    assert.strictEqual(r.data.failed, 3, '失败 3 条');
    assert.deepStrictEqual(r.data.failures.map((f) => f.row), [4, 5, 6]);
    assert.ok(r.data.failures[0].reason.includes('公司全称'));
    assert.ok(r.data.failures[1].reason.includes('火星仓'));
    assert.ok(r.data.failures[2].reason.includes('截单时间'));
  });
  await t('Upsert 后总行数未虚增，且字段/多仓分隔符已归一化', async () => {
    const all = await api('GET', '/api/customers?pageSize=100');
    assert.strictEqual(all.data.total, 6, '总数应仍为 6（3 仓储 + 1 共享 + 1 快运 + 1 新增）');
    const d = all.data.data.find((x) => x.company_name === '丁方电商有限公司');
    assert.strictEqual(d.warehouse, '龙湖仓,佳新仓', '中文顿号已归一为英文逗号');
    const a = all.data.data.find((x) => x.company_name === '甲方供应链有限公司');
    assert.strictEqual(a.prepaid_price, 9.877);
    assert.strictEqual(a.customer_code, null, '货主代码可空，存 NULL');
  });
  await t('表头缺列 / 非 Excel 文件 → 400 并给出明确原因', async () => {
    const badHead = await uploadExcel(xbuf(HEADERS.slice(0, 17), [HEADERS.slice(0, 17).map(() => 'x')]));
    assert.strictEqual(badHead.status, 400);
    assert.ok(badHead.data.error.includes('表头不匹配'));
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('hello')]), 'a.txt');
    const badFile = await fetch(BASE + '/api/customers/import', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
    assert.strictEqual(badFile.status, 400);
  });
  await t('共享单号页导入：仓库可空', async () => {
    const buf = importRows([baseRow({ 货主代码: 'S002', 公司全称: '共享单号乙', 客户简称: '共享乙', 所在仓库: '' })]);
    const r = await uploadExcel(buf, '共享单号');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.created, 1);
    assert.strictEqual(r.data.failed, 0);
  });

  // ---------- 下游 6 处回归 ----------
  await t('工时发货：按客户简称「甲方」强制关联通过', async () => {
    const r = await api('POST', '/api/workhours', {
      warehouse: '龙湖仓', work_type: '发货', customer_name: '甲方', unit: '件',
      date: '2026-11-14', ship_orders: 100, main_hours: 10, other_hours: 0, shared_hours: 0,
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  });
  await t('工时发货：不存在的客户被拒绝', async () => {
    const r = await api('POST', '/api/workhours', {
      warehouse: '龙湖仓', work_type: '发货', customer_name: '查无此客户', unit: '件',
      date: '2026-11-14', ship_orders: 100, main_hours: 10,
    });
    assert.strictEqual(r.status, 400);
  });
  await t('订单 Excel 导入：新客户表关联校验通过', async () => {
    const b = xbuf(['订单号', '客户名称', '货主名称', '发货量', '单位', '订单日期'],
      [['ORD001', '甲方供应链有限公司', '甲方', 50, '件', '2026-11-14']]);
    const fd = new FormData();
    fd.append('file', new Blob([b]), 'orders.xlsx');
    const res = await fetch(BASE + '/api/orders/import', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
    const j = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(j));
    assert.strictEqual(j.success, 1, JSON.stringify(j.failures));
  });
  await t('期初库存导入：新客户表关联校验通过', async () => {
    const b = xbuf(['货主名称', '数量', '业务日期', '备注'], [['甲方', 100, '2026-11-14', '期初']]);
    const fd = new FormData();
    fd.append('file', new Blob([b]), 'init.xlsx');
    const res = await fetch(BASE + '/api/inventory/import-initial', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
    const j = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(j));
    assert.strictEqual(j.success, 1, JSON.stringify(j.failures));
  });
  await t('库存台账 / 负库存预警接口正常（safety_stock 恒 0）', async () => {
    const l = await api('GET', '/api/inventory/ledger');
    assert.strictEqual(l.status, 200);
    assert.ok(l.data.data.length >= 1);
    assert.strictEqual(l.data.data[0].safety_stock, 0);
    const w = await api('GET', '/api/inventory/warnings');
    assert.strictEqual(w.status, 200);
  });
  await t('审计日志：客户新增/编辑/导入均落表', async () => {
    const db = new DatabaseSync(process.env.ERP_DB_PATH || '/tmp/erp_cust_test.db');
    const rows = db.prepare("SELECT action, COUNT(*) c FROM audit_logs WHERE table_name='customers' GROUP BY action").all();
    db.close();
    const map = Object.fromEntries(rows.map((r) => [r.action, r.c]));
    assert.ok((map.create || 0) >= 4, 'create 审计：' + JSON.stringify(map));
    assert.ok((map.update || 0) >= 3, 'update 审计：' + JSON.stringify(map));
  });

  console.log('\n' + '='.repeat(48));
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) {
    fails.forEach((f) => console.log('  - ' + f.name + ': ' + f.msg));
    process.exit(1);
  }
})();
