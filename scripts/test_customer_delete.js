// 客户删除功能 E2E：需 3001 隔离服务（ERP_DB_PATH=/tmp/erp_del_test.db PORT=3001 node src/server.js）
// 覆盖：RBAC（管理员可删/业务员查看者 403）/ 软删除（行保留、关联不破坏）/ 重复删拦截 / 恢复 / 审计日志
// ⚠️ 2026-11-16 语义变更：删除由「物理删除 + 有关联即 409 阻断」改为「软删除（is_deleted=1）」。
//    有关联工时的客户现在可以删除（行与关联全保留，历史工时正常显示并标 (已删除)），故原「强关联阻断」断言已移除。
const assert = require('assert');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://127.0.0.1:3001';

// 可重复运行：仅在显式指定「含 test 的隔离库」时操作，绝不触碰默认主库
const DB_PATH = process.env.ERP_DB_PATH || '';
if (!/test/i.test(DB_PATH)) {
  console.error('必须设置 ERP_DB_PATH 指向隔离测试库（路径含 test），拒绝在默认主库上运行');
  process.exit(1);
}
// 种子：重置业务数据 + 确保 admin/admin123 存在（服务端不自动建管理员）+ 追加 业务员/查看者
{
  const d = new DatabaseSync(DB_PATH);
  d.exec('DELETE FROM inventory_transactions; DELETE FROM orders; DELETE FROM work_hours; DELETE FROM customers; DELETE FROM audit_logs;');
  d.prepare("DELETE FROM users WHERE username IN ('sales1','viewer1')").run();
  const admin = d.prepare("SELECT 1 x FROM users WHERE username='admin'").get();
  if (!admin) {
    d.prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,1)')
      .run('admin', bcrypt.hashSync('admin123', 10), '管理员');
  }
  const hash = bcrypt.hashSync('pwd12345', 10);
  d.prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,2)').run('sales1', hash, '业务员甲');
  d.prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,3)').run('viewer1', hash, '查看者乙');
  d.close();
}

let TOKEN = '';
let pass = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fails.push({ name, msg: e.message }); console.log('FAIL ' + name + ' -> ' + e.message); }
}
async function api(method, url, body, token) {
  const opt = { method, headers: {} };
  const tk = token || TOKEN;
  if (tk) opt.headers.Authorization = 'Bearer ' + tk;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opt);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const manual = (o = {}) => Object.assign({
  customer_type: '仓储客户', customer_code: '', company_name: '', short_name: '',
  warehouse: ['龙湖仓'], product_count: 0, prepaid_price: 0, coop_status: '合作中',
}, o);
const getIdByName = (name) =>
  new DatabaseSync(DB_PATH).prepare('SELECT customer_id FROM customers WHERE company_name=?').get(name)?.customer_id;

(async function run() {
  await t('登录管理员', async () => {
    const r = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    assert.strictEqual(r.status, 200);
    TOKEN = r.data.token;
  });

  // ---------- A. 无关联客户：软删除成功（行保留、列表隐藏） ----------
  let idA = 0;
  await t('创建无关联客户 A', async () => {
    const r = await api('POST', '/api/customers', manual({
      customer_code: 'DA01', company_name: '删除测试甲公司', short_name: '删甲',
    }));
    assert.strictEqual(r.status, 201);
    idA = r.data.data.customer_id;
    assert.ok(idA > 0);
  });
  await t('删除无关联客户 A → 200 且 data.deleted=true / soft=true', async () => {
    const r = await api('DELETE', '/api/customers/' + idA);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.data.deleted, true);
    assert.strictEqual(r.data.data.soft, true);
    assert.strictEqual(r.data.data.company_name, '删除测试甲公司');
  });
  await t('软删除后常规列表隐藏、单条查询仍在（软删除，行保留）', async () => {
    const list = await api('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户') + '&q=' + encodeURIComponent('删除测试甲'));
    assert.strictEqual(list.data.total, 0);
    const one = await api('GET', '/api/customers/' + idA);
    assert.strictEqual(one.status, 200, '行仍在库，soft-delete 不物理删除');
  });
  await t('/options 仍能返回已删除客户且 status=已删除', async () => {
    const r = await api('GET', '/api/customers/options');
    const arr = r.data && r.data.data ? r.data.data : [];
    const hit = arr.find((o) => o.customer_id === idA);
    assert.ok(hit, 'options 含已删除客户');
    assert.strictEqual(hit.status, '已删除');
  });
  await t('审计日志写入 delete 动作（操作人 admin / 客户ID / 公司全称）', async () => {
    const d = new DatabaseSync(DB_PATH);
    const logs = d.prepare("SELECT * FROM audit_logs WHERE table_name='customers' AND action='delete' AND record_id=?").all(String(idA));
    d.close();
    assert.strictEqual(logs.length, 1, '应恰好 1 条 delete 审计');
    assert.strictEqual(logs[0].operator, 'admin');
    assert.ok(logs[0].before_summary.includes('删除测试甲公司'), 'before_summary 含公司全称');
    assert.ok(logs[0].operated_at, '含操作时间');
  });
  await t('重复删除同一客户 → 409（已处于删除状态）', async () => {
    const r = await api('DELETE', '/api/customers/' + idA);
    assert.strictEqual(r.status, 409);
  });
  await t('恢复客户 A → 200 且 is_deleted=0、重新出现在列表', async () => {
    const r = await api('POST', '/api/customers/' + idA + '/restore');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.data.is_deleted, 0);
    const list = await api('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户') + '&q=' + encodeURIComponent('删除测试甲'));
    assert.strictEqual(list.data.total, 1, '恢复后重新可见');
    // 复原到删除态供后续断言连贯
    await api('DELETE', '/api/customers/' + idA);
  });

  // ---------- B. 工时强关联：软删除允许且关联完整保留 ----------
  await t('有工时记录的客户 B → 软删除成功、工时关联完整保留', async () => {
    const c = await api('POST', '/api/customers', manual({ company_name: '删除测试乙公司', short_name: '删乙' }));
    const idB = c.data.data.customer_id;
    const d = new DatabaseSync(DB_PATH);
    d.prepare("INSERT INTO work_hours (warehouse,work_type,customer_id,customer_name,date,main_hours,other_hours,shared_hours,total_hours) VALUES ('龙湖仓','发货',?,'删乙','2026-11-01',1,0,0,1)").run(idB);
    d.close();
    const r = await api('DELETE', '/api/customers/' + idB);
    assert.strictEqual(r.status, 200, '有关联工时也可软删除');
    assert.strictEqual(r.data.data.soft, true);
    const d2 = new DatabaseSync(DB_PATH);
    assert.strictEqual(d2.prepare('SELECT is_deleted FROM customers WHERE customer_id=?').get(idB).is_deleted, 1);
    assert.strictEqual(d2.prepare('SELECT customer_id FROM work_hours WHERE customer_name=? AND date=?').get('删乙', '2026-11-01').customer_id, idB, '工时关联未被破坏');
    d2.close();
    const wh = await api('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货');
    const row = (wh.data.data || []).find((x) => x.customer_name === '删乙' || x.customer_name === '删除测试乙公司');
    assert.ok(row, '已删除客户的历史工时仍在列表可见');
    assert.strictEqual(row.customer_status, '已删除', '带「已删除」状态供前端标红');
  });

  // ---------- C. 订单强关联：软删除允许且外键完整 ----------
  await t('有订单的客户 C → 软删除成功、订单外键完整', async () => {
    const c = await api('POST', '/api/customers', manual({ company_name: '删除测试丙公司', short_name: '删丙' }));
    const idC = c.data.data.customer_id;
    const d = new DatabaseSync(DB_PATH);
    d.prepare("INSERT INTO orders (order_no,customer_id,owner_name,ship_quantity,unit,order_date) VALUES ('SO-DEL-1',?,'删丙',10,'件','2026-11-01')").run(idC);
    d.close();
    const r = await api('DELETE', '/api/customers/' + idC);
    assert.strictEqual(r.status, 200);
    const d2 = new DatabaseSync(DB_PATH);
    assert.strictEqual(d2.prepare('SELECT customer_id FROM orders WHERE order_no=?').get('SO-DEL-1').customer_id, idC, '订单外键未破坏');
    d2.close();
  });

  // ---------- D. 简称弱关联：软删除同样保留 ----------
  await t('工时按简称记录的 D 客户 → 软删除成功且行保留', async () => {
    const c = await api('POST', '/api/customers', manual({ company_name: '丁方供应链有限公司', short_name: '丁方' }));
    const idD = c.data.data.customer_id;
    const d = new DatabaseSync(DB_PATH);
    d.prepare("INSERT INTO work_hours (warehouse,work_type,customer_name,date,main_hours,other_hours,shared_hours,total_hours) VALUES ('佳新仓','收货','丁方','2026-11-02',2,0,0,2)").run();
    d.close();
    const r = await api('DELETE', '/api/customers/' + idD);
    assert.strictEqual(r.status, 200);
    const d2 = new DatabaseSync(DB_PATH);
    assert.strictEqual(d2.prepare('SELECT is_deleted FROM customers WHERE customer_id=?').get(idD).is_deleted, 1);
    d2.close();
  });

  // ---------- E. RBAC：业务员 / 查看者 均无权删除 ----------
  let salesToken = '', viewerToken = '';
  await t('登录业务员与查看者', async () => {
    const s = await api('POST', '/api/auth/login', { username: 'sales1', password: 'pwd12345' });
    const v = await api('POST', '/api/auth/login', { username: 'viewer1', password: 'pwd12345' });
    assert.strictEqual(s.status, 200); assert.strictEqual(v.status, 200);
    salesToken = s.data.token; viewerToken = v.data.token;
  });
  await t('业务员删除客户 → 403（且不产生审计）', async () => {
    const c = await api('POST', '/api/customers', manual({ company_name: '删除测试戊公司', short_name: '删戊' }));
    const idE = c.data.data.customer_id;
    const r = await api('DELETE', '/api/customers/' + idE, undefined, salesToken);
    assert.strictEqual(r.status, 403);
    const back = await api('GET', '/api/customers/' + idE);
    assert.strictEqual(back.status, 200);
    const d = new DatabaseSync(DB_PATH);
    const n = d.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='delete' AND record_id=?").get(String(idE)).c;
    d.close();
    assert.strictEqual(n, 0, '被拒绝的删除不写审计');
  });
  await t('查看者删除客户 → 403（readonlyGate 前置拦截）', async () => {
    const idE = getIdByName('删除测试戊公司');
    const r = await api('DELETE', '/api/customers/' + idE, undefined, viewerToken);
    assert.strictEqual(r.status, 403);
  });

  // ---------- F. 管理员仍可删除刚建的无关联客户 ----------
  await t('管理员删除无关联的戊客户 → 200', async () => {
    const idE = getIdByName('删除测试戊公司');
    const r = await api('DELETE', '/api/customers/' + idE);
    assert.strictEqual(r.status, 200);
  });

  console.log('================================================');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) { fails.forEach((f) => console.log('  FAIL: ' + f.name + ' -> ' + f.msg)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
