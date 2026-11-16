// ============================================================
//  RBAC E2E 测试（隔离库 + 独立服务，可重复执行）
//  运行前提：ERP_DB_PATH 指向含 "test" 的库文件，且已用同库启动服务：
//    rm -f /tmp/erp_rbac_test.db
//    ERP_DB_PATH=/tmp/erp_rbac_test.db node scripts/migrate_rbac.js
//    ERP_DB_PATH=/tmp/erp_rbac_test.db PORT=3102 node src/server.js &
//    ERP_DB_PATH=/tmp/erp_rbac_test.db node scripts/test_rbac.js
//  覆盖：登录返回菜单树 / 未登录拦截 / 菜单门禁 / 行级隔离保留 /
//        只读保留 / 父子收敛四情形（全选·半选·仅父·取消）/ 角色 CRUD /
//        内置角色保护 / 权限即时生效
// ============================================================
const BASE = process.env.BASE || 'http://127.0.0.1:3102';
const DB_PATH = process.env.ERP_DB_PATH || '/tmp/erp_rbac_test.db';
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

async function call(method, p, body, token) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['X-ERP-Token'] = token;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}

// ---------- 测试种子（幂等）：三类内置角色账号 + 一个自定义角色 ----------
{
  const db = new DatabaseSync(DB_PATH);
  const hash = bcrypt.hashSync('pwd12345', 10);
  const roles = db.prepare('SELECT role_id, role_code FROM roles').all();
  const byCode = Object.fromEntries(roles.map((r) => [r.role_code, r.role_id]));
  const users = [
    ['rbac_admin', byCode.super_admin, '超管测试'],
    ['rbac_sales', byCode.operator, '业务员测试'],
    ['rbac_viewer', byCode.viewer, '查看者测试'],
  ];
  users.forEach(([u, rid, dn]) => {
    if (!db.prepare('SELECT 1 FROM users WHERE username=?').get(u)) {
      db.prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,?)').run(u, hash, dn, rid);
    }
  });
  if (!db.prepare("SELECT 1 FROM roles WHERE role_name='rbac临时角色'").get()) {
    db.prepare("INSERT INTO roles (role_code, role_name, description) VALUES ('rbac_tmp','rbac临时角色','测试用')").run();
  }
  db.close();
}

const T = {};
async function login(u, p) {
  const r = await call('POST', '/api/auth/login', { username: u, password: p });
  ok(r.status === 200 && r.data.token, `登录 ${u} 成功`);
  return r.data;
}

(async () => {
  console.log('== 1. 登录返回权限菜单树 ==');
  const admin = await login('rbac_admin', 'pwd12345');
  T.admin = admin.token;
  ok(Array.isArray(admin.menus) && admin.menus.length >= 6, '超管菜单树含全部一级菜单（≥6 个）');
  ok(admin.menus.every((m) => m.virtual !== true), '超管菜单无 virtual 容器（全量授权）');
  const dbPaths = admin.permissions.length;
  ok(dbPaths >= 10, '超管权限白名单覆盖全部可用 path（' + dbPaths + ' 项）');
  ok(admin.user.role_code === 'super_admin' && admin.user.role === '超级管理员', 'user 携带 role_code/role');
  const dash = admin.menus.find((m) => m.menu_code === 'dashboard');
  ok(dash && dash.path === 'dashboard', '看板为直达菜单（path=dashboard）');

  console.log('== 2. 未登录与越权拦截 ==');
  ok((await call('GET', '/api/roles')).status === 401, '未登录访问角色列表 → 401');
  ok((await call('GET', '/api/menus/tree')).status === 401, '未登录访问菜单树 → 401');

  console.log('== 3. 零权限角色：菜单全隐藏 + 接口全拦 ==');
  const sales = await login('rbac_sales', 'pwd12345');
  T.sales = sales.token;
  ok(sales.menus.length === 0 && sales.permissions.length === 0, '未授权角色菜单/白名单为空');
  ok((await call('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户'), undefined, T.sales)).status === 403, '零权限访问客户列表 → 403');
  ok((await call('GET', '/api/workhours?warehouse=龙湖仓&work_type=' + encodeURIComponent('发货'), undefined, T.sales)).status === 403, '零权限访问工时列表 → 403');
  ok((await call('GET', '/api/analytics/dashboard', undefined, T.sales)).status === 403, '零权限访问看板 → 403');
  ok((await call('GET', '/api/menus/tree', undefined, T.sales)).status === 403, '无「角色权限」菜单访问菜单树 → 403');

  console.log('== 4. 仅勾子菜单（父半选语义）：只放行该部分 ==');
  const roles = (await call('GET', '/api/roles', undefined, T.admin)).data.data;
  const opRole = roles.find((r) => r.role_code === 'operator');
  const master = (await call('GET', '/api/menus/tree', undefined, T.admin)).data.data.find((m) => m.menu_code === 'master');
  const custWh = master.children.find((c) => c.menu_code === 'cust_wh');
  // 只提交子节点 401（父 5 未提交）→ 收敛后授权 = [401]
  let r = await call('PUT', `/api/roles/${opRole.role_id}/menus`, { menuIds: [custWh.menu_id] }, T.admin);
  ok(r.status === 200 && r.data.granted === 1, '仅提交子节点：收敛保留 1 项（父不落库）');
  let menus = (await call('GET', '/api/auth/me', undefined, T.sales)).data.menus;
  const mMaster = menus.find((m) => m.menu_code === 'master');
  ok(mMaster && mMaster.virtual === true, '半选父节点作为容器返回（virtual=true）');
  ok(mMaster.children.length === 1 && mMaster.children[0].menu_code === 'cust_wh', '容器下仅渲染已授权的「仓储客户」');
  ok((await call('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户'), undefined, T.sales)).status === 200, '已授权分类接口 → 200');
  ok((await call('GET', '/api/customers?customer_type=' + encodeURIComponent('共享单号'), undefined, T.sales)).status === 403, '未授权分类接口 → 403（一路由三菜单不互相放行）');

  console.log('== 5. 半选提交（父+部分子）→ 父剔除、子保留 ==');
  const custShared = master.children.find((c) => c.menu_code === 'cust_shared');
  r = await call('PUT', `/api/roles/${opRole.role_id}/menus`, { menuIds: [master.menu_id, custWh.menu_id, custShared.menu_id] }, T.admin);
  ok(r.status === 200 && r.data.granted === 2 && r.data.submitted === 3, '提交 3 项（父+2/3 子）→ 收敛授权 2 项');
  const granted = (await call('GET', `/api/roles/${opRole.role_id}/menus`, undefined, T.admin)).data.data;
  ok(!granted.includes(master.menu_id), '半选父节点未落库');
  ok(granted.includes(custWh.menu_id) && granted.includes(custShared.menu_id), '已勾子菜单保留');
  ok((await call('GET', '/api/customers?customer_type=' + encodeURIComponent('快运物流'), undefined, T.sales)).status === 403, '第三个分类仍未放行');

  console.log('== 6. 全选（父+全部子）→ 父落库 ==');
  // master 共 5 个子菜单（cust_wh/shared/express/users/roles）：全部提交才算全选
  const allKids = master.children.map((c) => c.menu_id);
  r = await call('PUT', `/api/roles/${opRole.role_id}/menus`, { menuIds: [master.menu_id, ...allKids] }, T.admin);
  ok(r.status === 200 && r.data.granted === allKids.length + 1, `全选父+${allKids.length} 子 → 授权 ${allKids.length + 1} 项（含父标记）`);
  const granted2 = (await call('GET', `/api/roles/${opRole.role_id}/menus`, undefined, T.admin)).data.data;
  ok(granted2.includes(master.menu_id), '全选父节点落库（全选标记）');
  ok((await call('GET', '/api/customers?customer_type=' + encodeURIComponent('快运物流'), undefined, T.sales)).status === 200, '全选后三分类接口全部放行');
  // 还原为「仅仓储客户」供后续用例使用
  await call('PUT', `/api/roles/${opRole.role_id}/menus`, { menuIds: [custWh.menu_id] }, T.admin);

  console.log('== 7. 恶意仅提交父 → 零放行 ==');
  r = await call('PUT', `/api/roles/${opRole.role_id}/menus`, { menuIds: [master.menu_id] }, T.admin);
  ok(r.status === 200 && r.data.granted === 0, '仅提交父节点 → 收敛为 0（防伪造越权）');
  ok((await call('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户'), undefined, T.sales)).status === 403, '伪造父提交后接口 → 403');

  console.log('== 8. 工时按仓授权 ==');
  const work = (await call('GET', '/api/menus/tree', undefined, T.admin)).data.data.find((m) => m.menu_code === 'work');
  const whLh = work.children.find((c) => c.menu_code === 'wh_lh');
  await call('PUT', `/api/roles/${opRole.role_id}/menus`, { menuIds: [whLh.menu_id] }, T.admin);
  ok((await call('GET', '/api/workhours?warehouse=龙湖仓&work_type=' + encodeURIComponent('发货'), undefined, T.sales)).status === 200, '授权龙湖仓 → 工时列表 200');
  ok((await call('GET', '/api/workhours?warehouse=佳新仓&work_type=' + encodeURIComponent('发货'), undefined, T.sales)).status === 403, '未授权佳新仓 → 403（同端点按仓隔离）');

  console.log('== 9. 行级隔离与只读（字段驱动，旧语义保留） ==');
  // 业务员（data_scope=self）：授权仓储客户菜单后创建客户 → owner 归自己
  await call('PUT', `/api/roles/${opRole.role_id}/menus`, { menuIds: [custWh.menu_id] }, T.admin);
  const created = await call('POST', '/api/customers', {
    customer_type: '仓储客户', company_name: 'RBAC隔离客户', warehouse: ['龙湖仓'],
  }, T.sales);
  ok(created.status === 201, '业务员创建客户成功');
  const mine = await call('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户'), undefined, T.sales);
  ok(mine.data.total === 1 && mine.data.data[0].company_name === 'RBAC隔离客户', '业务员可见自己的客户');
  // 另一个 self 用户看不到
  const db = new DatabaseSync(DB_PATH);
  const hash2 = bcrypt.hashSync('pwd12345', 10);
  if (!db.prepare("SELECT 1 FROM users WHERE username='rbac_sales2'").get()) {
    const opId = db.prepare("SELECT role_id FROM roles WHERE role_code='operator'").get().role_id;
    db.prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,?)').run('rbac_sales2', hash2, '业务员二', opId);
  }
  db.close();
  const sales2 = await login('rbac_sales2', 'pwd12345');
  const other = await call('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户'), undefined, sales2.token);
  ok(other.data.total === 0, '另一业务员看不到他人客户（行级隔离保留）');
  // 查看者只读
  const viewer = await login('rbac_viewer', 'pwd12345');
  await call('PUT', `/api/roles/${roles.find((x) => x.role_code === 'viewer').role_id}/menus`,
    { menuIds: [master.menu_id, custWh.menu_id] }, T.admin);
  const w = await call('POST', '/api/customers', { customer_type: '仓储客户', company_name: '只读尝试', warehouse: ['龙湖仓'] }, viewer.token);
  ok(w.status === 403, '查看者写操作 → 403（is_readonly 字段驱动）');
  const g = await call('GET', '/api/customers?customer_type=' + encodeURIComponent('仓储客户'), undefined, viewer.token);
  ok(g.status === 200, '查看者读操作 → 200');
  ok(viewer.user.is_readonly === 1, 'user 携带 is_readonly');

  console.log('== 10. 角色 CRUD 与内置角色保护 ==');
  r = await call('POST', '/api/roles', { role_name: '仓库主管', description: '仓内主管，全部仓数据' }, T.admin);
  ok(r.status === 201 && r.data.data.role_code.indexOf('custom_') === 0, '新增自定义角色成功（自动 role_code）');
  const newRole = r.data.data;
  ok((await call('POST', '/api/roles', { role_name: '仓库主管' }, T.admin)).status === 409, '重名角色 → 409');
  ok((await call('PUT', `/api/roles/${newRole.role_id}`, { role_name: '仓库主管2', description: 'x' }, T.admin)).status === 200, '编辑自定义角色成功');
  ok((await call('DELETE', `/api/roles/${opRole.role_id}`, undefined, T.admin)).status === 403, '内置角色（业务员）删除 → 403');
  const sup = roles.find((x) => x.role_code === 'super_admin');
  ok((await call('DELETE', `/api/roles/${sup.role_id}`, undefined, T.admin)).status === 403, '内置角色删除 → 403');
  ok((await call('PUT', `/api/roles/${sup.role_id}`, { role_name: '改超管名' }, T.admin)).status === 403, '内置角色改名 → 403');
  ok((await call('PUT', `/api/roles/${sup.role_id}/menus`, { menuIds: [] }, T.admin)).status === 403, '超管配置权限 → 403（默认全量）');
  // 有用户挂靠的自定义角色删除 → 409（内置角色删除走 403 分支已单独覆盖）
  const holder = (await call('POST', '/api/roles', { role_name: 'rbac挂靠角色' }, T.admin)).data.data;
  const hu = await call('POST', '/api/users', { username: 'rbac_holder', password: 'pwd12345', role_name: 'rbac挂靠角色' }, T.admin);
  if (hu.status !== 201) console.log('  [debug] 创建挂靠用户失败：', hu.status, JSON.stringify(hu.data));
  ok((await call('DELETE', `/api/roles/${holder.role_id}`, undefined, T.admin)).status === 409, '有用户挂靠的角色删除 → 409');
  ok((await call('DELETE', `/api/roles/${newRole.role_id}`, undefined, T.admin)).status === 200, '删除无用户自定义角色 → 200');

  console.log('== 11. 用户管理适配 ==');
  ok((await call('POST', '/api/users', { username: 'rbac_new', password: 'pwd12345', role_name: '业务员' }, T.admin)).status === 201, '按角色名创建用户 → 201');
  ok((await call('POST', '/api/users', { username: 'rbac_sup', password: 'pwd12345', role_name: '超级管理员' }, T.admin)).status === 201, '超管可创建超管账号');
  const opRoles = (await call('GET', '/api/roles/options', undefined, T.admin)).data.data;
  ok(opRoles.some((x) => x.role_code === 'super_admin'), '超管的下拉含超管角色');
  ok((await call('GET', '/api/users', undefined, T.admin)).status === 200, '用户列表 200');

  console.log('== 12. 权限即时生效（auth 按 role_id 查库刷新） ==');
  // 收回 sales 的全部授权后，其旧 token 立即失效于业务接口（无需重登）
  await call('PUT', `/api/roles/${opRole.role_id}/menus`, { menuIds: [] }, T.admin);
  ok((await call('GET', '/api/workhours?warehouse=龙湖仓&work_type=' + encodeURIComponent('发货'), undefined, sales2.token)).status === 403, '收回授权后旧 token 立即 403（无需重登）');

  console.log('== 13. 权限树组件静态断言 ==');
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../public/js/permission-tree.js', 'utf8');
  ok(src.includes('cb.indeterminate = n.state'), '半选使用浏览器原生 indeterminate');
  ok(src.includes("n.state = all ? 'checked' : none ? 'unchecked' : 'indeterminate'"), '父状态三态推导');
  ok(src.includes('function recomputeUp'), '子→父自底向上联动');
  ok(src.includes("filter((n) => n.state === 'checked')"), 'collect 仅收集全选节点（半选父不提交）');

  // ---------- 清理测试数据（幂等可重跑） ----------
  {
    const d = new DatabaseSync(DB_PATH);
    d.prepare("DELETE FROM audit_logs WHERE table_name='customers' AND record_id IN (SELECT customer_id FROM customers WHERE company_name='RBAC隔离客户')").run();
    d.prepare("DELETE FROM customers WHERE company_name='RBAC隔离客户'").run();
    d.prepare("DELETE FROM users WHERE username IN ('rbac_new','rbac_sup','rbac_holder')").run();
    d.prepare("DELETE FROM role_menus WHERE role_id=(SELECT role_id FROM roles WHERE role_name='仓库主管')").run();
    d.prepare("DELETE FROM roles WHERE role_name='仓库主管'").run();
    d.prepare("DELETE FROM role_menus WHERE role_id=(SELECT role_id FROM roles WHERE role_name='rbac挂靠角色')").run();
    d.prepare("DELETE FROM roles WHERE role_name='rbac挂靠角色'").run();
    d.close();
  }

  console.log('\n=== 结果：' + passed + ' 通过 / ' + failed + ' 失败 ===');
  console.log(failed === 0 ? '=== RBAC E2E 全部通过 ===' : '=== 存在失败项 ===');
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
