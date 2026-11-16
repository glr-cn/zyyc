// 物流报价接口验证（进程内：加载 app 监听临时端口，绕过平台网关）
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');
const app = require('../src/server');

const SECRET = fs.readFileSync(path.join(__dirname, '..', 'jwt.secret'), 'utf8').trim();
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'erp.db'), { readOnly: true });
const superUser = db.prepare("SELECT u.user_id, u.role_id, u.username, u.display_name FROM users u JOIN roles r ON r.role_id=u.role_id WHERE r.role_code='super_admin' LIMIT 1").get();
const badUser = { user_id: 999, username: 'ghost', display_name: 'ghost', role_id: 999 };

function token(u) {
  return jwt.sign({ user_id: u.user_id, username: u.username, display_name: u.display_name, role: 'x', role_id: u.role_id }, SECRET, { expiresIn: '1h' });
}
const SUPER = token(superUser);
const BAD = token(badUser);

function call(method, url, body, tok, base) {
  const opt = { method, headers: { 'X-ERP-Token': tok, 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  return fetch(base + url, opt).then(async (res) => {
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  });
}

(async () => {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const results = [];
  const T = (name, cond, extra) => results.push({ name, pass: !!cond, extra });

  // 幂等清理
  try {
    const all = await call('GET', '/api/logistics-quotes?pageSize=100', undefined, SUPER, BASE);
    for (const r of (all.json.data || [])) await call('DELETE', '/api/logistics-quotes/' + r.id, undefined, SUPER, BASE);
  } catch (e) {}

  const ts = Date.now();
  const C1 = 'zt' + ts, C2 = 'yt' + ts;

  const h = await call('GET', '/api/health', undefined, SUPER, BASE);
  T('health 200 & logistics_quotes 表存在', h.status === 200 && Array.isArray(h.json.tables) && h.json.tables.includes('logistics_quotes'), h.json.tables);

  const noAuth = await call('GET', '/api/logistics-quotes', undefined, BAD, BASE);
  T('menuGate: 无菜单权限角色 GET -> 403', noAuth.status === 403, noAuth.json);

  const list0 = await call('GET', '/api/logistics-quotes', undefined, SUPER, BASE);
  T('列表初始为空', list0.status === 200 && list0.json.total === 0, list0.json);

  const overlap = await call('POST', '/api/logistics-quotes',
    { network_name: '中通-杭州', express_code: C1, volume_ratio: 6000,
      price_rules: [{ min: 0, max: 3, price: 2.5 }, { min: 2, max: 5, price: 4 }] }, SUPER, BASE);
  T('重叠区间 POST -> 400 含重叠提示', overlap.status === 400 && /重叠/.test(JSON.stringify(overlap.json)), overlap.json);

  // 包含关系也应被拒（[0,10] 包含 [2,5]）
  const contain = await call('POST', '/api/logistics-quotes',
    { network_name: 'x', express_code: 'cv' + ts, volume_ratio: 6000,
      price_rules: [{ min: 0, max: 10, price: 1 }, { min: 2, max: 5, price: 2 }] }, SUPER, BASE);
  T('包含关系 POST -> 400', contain.status === 400 && /重叠/.test(JSON.stringify(contain.json)), contain.json);

  const create = await call('POST', '/api/logistics-quotes',
    { network_name: '中通-杭州', express_code: C1, volume_ratio: 6000,
      price_rules: [{ min: 3, max: 5, price: 4 }, { min: 0, max: 1, price: 1.5 }] }, SUPER, BASE);
  T('新增成功 201', create.status === 201, create.json);
  const stored = create.json.data && create.json.data.price_rules ? JSON.parse(create.json.data.price_rules) : null;
  T('后端按 min 升序入库（0 在前）', stored && stored.length === 2 && stored[0].min === 0 && stored[1].min === 3, stored);

  const create2 = await call('POST', '/api/logistics-quotes',
    { network_name: '圆通-上海', express_code: C2, volume_ratio: 8000,
      price_rules: [{ min: 0, max: 10, price: 3 }, { min: 10, max: null, price: 5 }] }, SUPER, BASE);
  T('max 留空(null) 不限 新增成功', create2.status === 201, create2.json);
  const r2 = create2.json.data && create2.json.data.price_rules ? JSON.parse(create2.json.data.price_rules) : null;
  T('第二条 max 存为 null', r2 && r2[1] && r2[1].max === null, r2);

  const id = create.json.data && create.json.data.id;
  const editBad = await call('PUT', '/api/logistics-quotes/' + id,
    { network_name: '中通-杭州', express_code: C1, volume_ratio: 6000,
      price_rules: [{ min: 0, max: 5, price: 2 }, { min: 3, max: 8, price: 4 }] }, SUPER, BASE);
  T('编辑重叠区间 -> 400', editBad.status === 400 && /重叠/.test(JSON.stringify(editBad.json)), editBad.json);
  const editOk = await call('PUT', '/api/logistics-quotes/' + id,
    { network_name: '中通-杭州(改)', express_code: C1, volume_ratio: 7000,
      price_rules: [{ min: 0, max: 2, price: 1.2 }, { min: 2, max: null, price: 3.5 }] }, SUPER, BASE);
  T('编辑合法 -> 200 且重新排序', editOk.status === 200 &&
    editOk.json.data && JSON.parse(editOk.json.data.price_rules)[1].max === null, editOk.json.data);

  const dup = await call('POST', '/api/logistics-quotes',
    { network_name: 'x', express_code: C1, volume_ratio: 6000, price_rules: [] }, SUPER, BASE);
  T('重复 express_code -> 400', dup.status === 400 && /已存在/.test(JSON.stringify(dup.json)), dup.json);

  const del = await call('DELETE', '/api/logistics-quotes/' + id, undefined, SUPER, BASE);
  T('删除成功', del.status === 200 && del.json.data && del.json.data.deleted === true, del.json);
  const afterDel = await call('GET', '/api/logistics-quotes', undefined, SUPER, BASE);
  T('删除后总数=1（仅剩 C2）', afterDel.json.total === 1, afterDel.json);

  srv.close();
  let allPass = true;
  results.forEach((r) => { if (!r.pass) allPass = false; console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '  >>> ' + JSON.stringify(r.extra))); });
  console.log('\n=== ' + (allPass ? 'ALL PASS' : 'SOME FAILED') + ' ===');
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
