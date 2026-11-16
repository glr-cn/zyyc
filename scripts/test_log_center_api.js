// ============================================================================
//  日志中心端到端联调测试（在「数据库副本」上启动服务，绝不写生产库）
//  用法：node scripts/test_log_center_api.js
//  覆盖：菜单授权、按模块隔离查询、综合筛选、详情对比 JSON、
//        新建客户 / 修改配置后日志全字段对齐；结束删除副本及全部假数据。
// ============================================================================
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.ERP_DB_PATH || path.join(ROOT, 'data', 'erp.db');
const TMP = path.join(ROOT, 'data', '_log_api_test.db');
process.env.ERP_DB_PATH = TMP;           // 必须在 require('../src/server') 之前设置

function cleanup() {
  fs.readdirSync(path.dirname(TMP)).forEach((f) => {
    if (f.startsWith('_log_api_test.db')) {
      try { fs.rmSync(path.join(path.dirname(TMP), f), { force: true, maxRetries: 3, retryDelay: 100 }); }
      catch (_) { /* ignore */ }
    }
  });
}
cleanup();
fs.copyFileSync(SRC, TMP);

const { DatabaseSync } = require('node:sqlite');
const jwt = require('jsonwebtoken');
const { SECRET } = require('../src/middleware/auth');
const app = require('../src/server');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('PASS: ' + name); }
  catch (e) { console.error('FAIL: ' + name + ' → ' + e.message); failed++; }
}

(async function () {
  const d = new DatabaseSync(TMP);
  const admin = d.prepare(`SELECT u.user_id, u.username, u.display_name, u.role_id, r.role_name FROM users u
                           JOIN roles r ON r.role_id=u.role_id WHERE u.username='admin'`).get();
  d.close();
  assert.ok(admin, '副本中存在 admin 用户');
  const token = jwt.sign({
    user_id: admin.user_id, username: admin.username, display_name: admin.display_name,
    role: admin.role_name, role_id: admin.role_id,
  }, SECRET, { expiresIn: '10m' });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'X-ERP-Token': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  };

  await t('/api/health 正常且日志视图可用', async () => {
    const r = await call('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.ok(r.data.tables.includes('audit_logs'));
  });
  await t('登录态返回 6 个日志中心子菜单权限', async () => {
    const r = await call('GET', '/api/auth/me');
    assert.equal(r.status, 200);
    ['log_customer', 'log_workhours', 'log_logistics', 'log_smartquote', 'log_system', 'log_all']
      .forEach((p) => assert.ok(r.data.permissions.includes(p), '缺权限 ' + p));
  });
  await t('客户资料日志只展示 module=客户资料', async () => {
    const r = await call('GET', '/api/logs?scope=log_customer&pageSize=100');
    assert.equal(r.status, 200);
    assert.ok(r.data.total >= 4);
    r.data.data.forEach((x) => assert.equal(x.module, '客户资料'));
  });
  await t('物流报价日志只展示 module=物流报价', async () => {
    const r = await call('GET', '/api/logs?scope=log_logistics');
    assert.equal(r.status, 200);
    r.data.data.forEach((x) => assert.equal(x.module, '物流报价'));
  });
  await t('全部日志汇总不丢任何历史行', async () => {
    const r = await call('GET', '/api/logs?scope=log_all&pageSize=100');
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 7);
  });
  await t('操作类型 / 日期 / 操作人 / 关键词筛选生效', async () => {
    const a = await call('GET', '/api/logs?scope=log_all&action=' + encodeURIComponent('新增'));
    assert.equal(a.status, 200);
    a.data.data.forEach((x) => assert.equal(x.action, '新增'));
    const b = await call('GET', '/api/logs?scope=log_all&dateFrom=2020-01-01&dateTo=2099-12-31');
    assert.equal(b.data.total, 7);
    const c = await call('GET', '/api/logs?scope=log_all&operator=admin');
    assert.equal(c.data.total, 7);
    const e = await call('GET', '/api/logs?scope=log_all&q=' + encodeURIComponent('客户'));
    assert.equal(e.status, 200);
    const bad = await call('GET', '/api/logs?scope=log_all&dateFrom=2020/01/01');
    assert.equal(bad.status, 400);
  });
  await t('操作人下拉数据可用', async () => {
    const r = await call('GET', '/api/logs/operators?scope=log_all');
    assert.equal(r.status, 200);
    assert.ok(r.data.data.some((o) => o.user_name === 'admin'));
  });
  await t('详情返回 before/after 对比 JSON，且跨模块访问被拒绝', async () => {
    const list = await call('GET', '/api/logs?scope=log_customer');
    const first = list.data.data[0];
    const r = await call('GET', '/api/logs/' + first.id + '?scope=log_customer');
    assert.equal(r.status, 200);
    const c = JSON.parse(r.data.data.content);
    assert.ok('before' in c && 'after' in c);
    const denied = await call('GET', '/api/logs/' + first.id + '?scope=log_logistics');
    assert.equal(denied.status, 403);
  });
  await t('scope 非法 / 越权被拦截', async () => {
    assert.equal((await call('GET', '/api/logs?scope=logistics-quotes')).status, 400);
  });

  let createdId = null;
  await t('新建客户后日志全字段对齐（新旧列双写）', async () => {
    const r = await call('POST', '/api/customers', {
      company_name: '日志联调测试客户', customer_type: '仓储客户',
      warehouse: '龙湖仓', contact_person: '联调', remark: '仅测试副本使用',
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    createdId = r.data.data.customer_id;

    const db = new DatabaseSync(TMP);
    const row = db.prepare("SELECT * FROM audit_logs WHERE table_name='customers' AND action='create' AND target_id=?")
      .get(String(createdId));
    db.close();
    assert.ok(row, '新日志已写入');
    assert.equal(row.id, row.log_id);
    assert.equal(row.created_at, row.operated_at);
    assert.equal(row.module, '客户资料');
    assert.equal(row.user_name, row.operator);
    assert.equal(row.user_id, admin.user_id);
    assert.equal(row.target_id, row.record_id);
    assert.ok(row.ip_address !== null && row.ip_address !== undefined);
    assert.ok(JSON.parse(row.content).after.company_name === '日志联调测试客户');
    assert.ok(row.before_summary === null && row.after_summary !== null);
  });
  await t('测算配置修改纳入「智能测单」日志', async () => {
    const r = await call('PUT', '/api/smart-quote/config',
      { startWeight: 0, startMode: 'estimated', waybillTypes: ['菜鸟'] });
    assert.equal(r.status, 200);
    const list = await call('GET', '/api/logs?scope=log_smartquote');
    assert.ok(list.data.data.some((x) => x.module === '智能测单' && x.action === '修改'));
  });
  await t('删除测试假数据后业务表与日志仍完整（假数据不外溢）', async () => {
    if (createdId != null) await call('DELETE', '/api/customers/' + createdId);
    const db = new DatabaseSync(TMP);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM customers WHERE company_name='日志联调测试客户'").get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM v_audit_logs').get().c,
      db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c);
    db.close();
  });

  server.close();
  // 释放所有数据库句柄，否则 Windows 下临时副本无法删除
  try { require('../src/db')._raw.close(); } catch (_) { /* ignore */ }
  try { require('../src/middleware/auth').closeRoleDb(); } catch (_) { /* ignore */ }
  cleanup();
  console.log('\n=== 日志中心联调测试：' + (failed ? `失败 ${failed} 项` : '全部通过') + ' ===');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('联调测试异常：', e);
  cleanup();
  process.exit(1);
});
