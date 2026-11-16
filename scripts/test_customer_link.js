// 客户软删除 + 工时 id 关联 —— 端到端回归（隔离库）
// 覆盖：① /options 返回全部客户含 status ② 软删除不丢关联/历史
//       ③ 已删除客户历史工时正常显示名字+status ④ 工时存 customer_id 且改名跟随
//       ⑤ 已删除/停用客户禁止新录入、编辑保留原关联 ⑥ 迁移数据完整性
// 用法：node scripts/test_customer_link.js
'use strict';
delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;
delete process.env.http_proxy; delete process.env.https_proxy;
delete process.env.ALL_PROXY; delete process.env.all_proxy;

const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
process.env.ERP_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'custlink_')), 'test.db');
process.env.PORT = '0';
const BASE = 'http://127.0.0.1';

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name, extra != null ? '=> ' + JSON.stringify(extra) : ''); } }

const jwt = require('jsonwebtoken');
const SECRET = fs.readFileSync(path.join(__dirname, '..', 'jwt.secret'), 'utf8').trim();

async function main() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.ERP_DB_PATH);
  // 建库（最新 schema，含新列）+ 基础角色/管理员（模拟 seed 最小集）
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  require('../src/db/migrateCustomerLink').run(db);
  db.exec("INSERT OR IGNORE INTO roles(role_id,role_code,role_name,data_scope,is_readonly,is_system) VALUES(1,'super_admin','超级管理员','all',0,1)");
  const hash = require('bcryptjs').hashSync('x', 10);
  db.exec(`INSERT OR IGNORE INTO users(user_id,username,password_hash,display_name,role_id) VALUES(1,'admin','${hash}','admin',1)`);
  const token = jwt.sign({ user_id: 1, username: 'admin', display_name: 'admin', role: '超级管理员', role_id: 1 }, SECRET, { expiresIn: '1h' });
  db.close();

  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const H = { 'Content-Type': 'application/json', 'X-ERP-Token': token, Authorization: 'Bearer ' + token };
  const call = async (method, url, body) => {
    const r = await fetch(BASE + ':' + port + url, { method, headers: H, body: body == null ? undefined : JSON.stringify(body) });
    let j; try { j = await r.json(); } catch (e) { j = {}; }
    return { status: r.status, ...j };
  };

  try {
    // ---- 建三个客户：正常 / 将停用 / 将删除（且有关联工时） ----
    let r = await call('POST', '/api/customers', { customer_type: '仓储客户', company_name: '甲客户公司', short_name: '甲客户', warehouse: '龙湖仓', coop_status: '合作中' });
    ok('创建甲客户 201', r.status === 201, r);
    const idA = r.data && r.data.customer_id;
    r = await call('POST', '/api/customers', { customer_type: '仓储客户', company_name: '乙客户公司', short_name: '乙客户', warehouse: '龙湖仓', coop_status: '合作中' });
    const idB = r.data && r.data.customer_id;
    r = await call('POST', '/api/customers', { customer_type: '仓储客户', company_name: '丙客户公司', short_name: '丙客户', warehouse: '龙湖仓', coop_status: '合作中' });
    const idC = r.data && r.data.customer_id;
    ok('乙/丙客户创建成功', idB && idC, { idB, idC });

    // ---- 写入三条工时（含丙，用于之后验证软删除历史） ----
    r = await call('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '发货', customer_id: idA, customer_name: '甲客户', date: '2026-11-10', ship_orders: 10, main_hours: 2 });
    ok('工时按 customer_id 写入 201', r.status === 201, r);
    const whA = r.data && r.data.work_id;
    r = await call('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '发货', customer_id: idC, customer_name: '丙客户', date: '2026-11-11', ship_orders: 5, main_hours: 1 });
    ok('丙客户工时写入 201', r.status === 201, r);
    const whC = r.data && r.data.work_id;

    // 校验落库 customer_id
    const db2 = new DatabaseSync(process.env.ERP_DB_PATH);
    ok('工时表落库 customer_id=甲', db2.prepare('SELECT customer_id FROM work_hours WHERE work_id=?').get(whA).customer_id === idA);
    db2.close();

    // ---- 停用乙客户 ----
    r = await call('POST', '/api/customers/' + idB + '/toggle-status');
    ok('乙客户停用 200', r.status === 200 && r.data.coop_status === '暂停', r);

    // ---- 软删除丙客户（有工时关联，旧版会 409，新版必须成功且行保留） ----
    r = await call('DELETE', '/api/customers/' + idC);
    ok('有关联工时的客户软删除成功（不再 409）', r.status === 200 && r.data.soft === true, r);
    const db3 = new DatabaseSync(process.env.ERP_DB_PATH);
    ok('软删除后客户行仍在库（is_deleted=1）', db3.prepare('SELECT is_deleted FROM customers WHERE customer_id=?').get(idC).is_deleted === 1);
    ok('软删除后工时关联未被破坏', db3.prepare('SELECT customer_id FROM work_hours WHERE work_id=?').get(whC).customer_id === idC);
    db3.close();

    // ---- /options 返回全部客户含 status ----
    r = await call('GET', '/api/customers/options');
    ok('/options 200', r.status === 200, r);
    const byName = {}; (r.data || []).forEach((o) => byName[o.company_name] = o.status);
    ok('/options 含甲=启用', byName['甲客户公司'] === '启用', byName);
    ok('/options 含乙=停用', byName['乙客户公司'] === '停用', byName);
    ok('/options 含丙=已删除', byName['丙客户公司'] === '已删除', byName);

    // ---- 常规列表不显示已删除客户 ----
    r = await call('GET', '/api/customers?customer_type=仓储客户');
    ok('客户列表排除已删除客户', !(r.data || []).some((o) => o.customer_id === idC), (r.data || []).map((x) => x.company_name));

    // ---- 历史工时列表：已删除客户名字正常显示 + status=已删除 ----
    r = await call('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货');
    ok('工时列表 200', r.status === 200, r);
    const whC2 = (r.data || []).find((x) => x.work_id === whC);
    ok('已删除客户的历史工时名字仍显示(取客户最新名)', whC2 && whC2.customer_name === '丙客户公司', whC2);
    ok('已删除客户历史工时 status=已删除', whC2 && whC2.customer_status === '已删除', whC2);
    const whA2 = (r.data || []).find((x) => x.work_id === whA);
    ok('正常客户 status=启用', whA2 && whA2.customer_status === '启用', whA2);

    // ---- 改名跟随：改甲客户公司全称，历史工时显示新名 ----
    r = await call('PUT', '/api/customers/' + idA, { customer_type: '仓储客户', company_name: '甲客户公司改名后', short_name: '甲客户新简称', warehouse: '龙湖仓', coop_status: '合作中' });
    ok('甲客户改名 200', r.status === 200, r);
    r = await call('GET', '/api/workhours?warehouse=龙湖仓&work_type=发货');
    const whA3 = (r.data || []).find((x) => x.work_id === whA);
    ok('客户改名后历史工时显示最新名', whA3 && whA3.customer_name === '甲客户公司改名后', whA3);

    // ---- 禁止用已删除/停用客户新建工时 ----
    r = await call('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '发货', customer_id: idC, customer_name: '丙客户', date: '2026-11-12', ship_orders: 3, main_hours: 1 });
    ok('已删除客户禁止新录入 400', r.status === 400 && /已删除/.test(r.error || ''), r);
    r = await call('POST', '/api/workhours', { warehouse: '龙湖仓', work_type: '发货', customer_id: idB, customer_name: '乙客户', date: '2026-11-12', ship_orders: 3, main_hours: 1 });
    ok('停用客户禁止新录入 400', r.status === 400 && /停用/.test(r.error || ''), r);

    // ---- 编辑历史工时（已删除客户未变更）应放行 ----
    r = await call('PUT', '/api/workhours/' + whC, { warehouse: '龙湖仓', work_type: '发货', customer_id: idC, customer_name: '丙客户', date: '2026-11-11', ship_orders: 6, main_hours: 2 });
    ok('编辑已删除客户的历史工时放行 200', r.status === 200, r);

    // ---- 前端静态标记 ----
    const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'workhours.js'), 'utf8');
    ok('前端下拉走 /customers/options', fe.includes('/customers/options'));
    ok('前端已删除标签渲染', fe.includes('cust-tag-del') && fe.includes('(已删除)'));
    ok('前端 disabled 置灰', /inactive \? ' disabled'/.test(fe));
    ok('前端提交 customer_id', fe.includes('payload.customer_id'));

    // ---- 迁移幂等 ----
    const db4 = new DatabaseSync(process.env.ERP_DB_PATH);
    const before = db4.prepare('SELECT COUNT(*) c FROM customers').get().c;
    const rep = require('../src/db/migrateCustomerLink').run(db4);
    ok('迁移二次执行 addedColumns 为空', rep.addedColumns.length === 0, rep);
    ok('迁移不改变客户行数', db4.prepare('SELECT COUNT(*) c FROM customers').get().c === before);
    db4.close();

  } catch (e) {
    fail++; console.log('❌ EXCEPTION', e.stack || e.message);
  } finally {
    server.close();
  }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main();
