const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const { openDatabase } = require('../src/db/driver');

const root = path.join(__dirname, '..');
const template = path.join(root, 'templates', '三类工时导入模板.xlsx');
// 不执行 src/db/index.js：即便指定临时库，该入口也可能自动搜索生产备份。
const db = openDatabase(':memory:');
const dbEntry = require.resolve('../src/db');
assert.ok(!require.cache[dbEntry], '测试必须在独立测试进程中启动');
require.cache[dbEntry] = { id: dbEntry, filename: dbEntry, loaded: true, exports: db };
const secret = crypto.randomBytes(48).toString('hex');
const roles = ['super_admin', 'admin', 'operator', 'viewer', 'custom_write', 'custom_no_menu'];
const tokens = {};
let server, base;
const day = '2026-09-12';
const receipt = [day, '测试货主全称', '箱', 12, 1.25, 2.5, 3, 4, 0.5, '收货备注'];
const internal = [day, '上架', '件', 17, 2, 0.75, '库内备注'];
const support = [day, '管理人员', 3, 0.25, '后勤备注'];
const sheets = ['收货工时', '库内工时', '后勤工时'];

before(async () => {
  db.exec(fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8'));
  db.exec(`INSERT INTO menus(menu_code,menu_name,path) VALUES ('wh_lh','龙湖仓','wh_lh');
    INSERT INTO customers(company_name,short_name,warehouse) VALUES ('测试货主全称','测试货主','龙湖仓')`);
  roles.forEach((code, i) => {
    const id = i + 1;
    db.prepare('INSERT INTO roles(role_id,role_code,role_name,data_scope,is_readonly) VALUES(?,?,?,?,?)')
      .run(id, code, code, code === 'operator' ? 'self' : 'all', Number(code === 'viewer'));
    db.prepare('INSERT INTO users(user_id,username,password_hash,display_name,role_id) VALUES(?,?,?,?,?)')
      .run(id, code, 'unused', '测试' + code, id);
    if (code !== 'custom_no_menu') db.prepare('INSERT INTO role_menus VALUES (?,1)').run(id);
    tokens[code] = jwt.sign({ user_id: id, username: code, role_id: id }, secret, { expiresIn: '10m' });
  });
  const saved = process.env.ERP_JWT_SECRET;
  process.env.ERP_JWT_SECRET = secret;
  const app = express();
  try { app.use('/api/workhours', require('../src/routes/workhours')); }
  finally {
    if (saved === undefined) delete process.env.ERP_JWT_SECRET;
    else process.env.ERP_JWT_SECRET = saved;
  }
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}/api/workhours/three`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close();
  delete require.cache[dbEntry];
});
beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fail_import_audit; DELETE FROM audit_logs; DELETE FROM work_hours;
    INSERT INTO work_hours(warehouse,work_type,date,unit,ship_orders,main_hours,status,remark,owner_user_id)
    VALUES ('龙湖仓','发货','2026-09-12','件',73,5,'pending','不可修改',2),
           ('佳新仓','库内','2026-09-12','箱',NULL,2,'archived','其他仓历史',3)`);
});
const rows = () => db.prepare('SELECT * FROM work_hours ORDER BY work_id').all();
function workbook(groups = [[receipt], [internal], [support]], change) {
  const book = XLSX.read(fs.readFileSync(template), { type: 'buffer' });
  groups.forEach((group, i) => XLSX.utils.sheet_add_aoa(book.Sheets[sheets[i]], group, { origin: 'A2' }));
  if (change) change(book);
  return XLSX.write(book, { bookType: 'xlsx', type: 'buffer' });
}
async function request(route, { role = 'super_admin', file, token, warehouse = '龙湖仓', filename = 'hours.xlsx' } = {}) {
  const headers = role ? { 'X-ERP-Token': tokens[role] } : {};
  let body;
  if (route !== 'template') {
    body = new FormData();
    if (file) body.append('file', new Blob([file]), filename);
    if (token) body.append('previewToken', token);
  }
  const res = await fetch(`${base}/${route}?${new URLSearchParams({ warehouse })}`, { method: body ? 'POST' : 'GET', headers, body });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}
async function preview(file) {
  const r = await request('preview', { file });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total, r.data.rows.length);
  assert.ok(r.data.previewToken);
  return r.data;
}
const confirm = (file, token) => request('import', { file, token });
const actions = r => r.rows.map(({ sheet, line, action }) => [sheet, line, action]);
function counts(r, created, skipped, failed) {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.batchId);
  assert.deepEqual([r.data.created, r.data.skipped, r.data.failed], [created, skipped, failed]);
}

test('匿名、四种内置角色和自定义有/无菜单角色：三个端点均经真实鉴权', async () => {
  const old = rows(), file = workbook();
  const token = (await preview(file)).previewToken;
  for (const role of [null, ...roles.slice(1)]) {
    for (const route of ['template', 'preview', 'import']) {
      assert.equal((await request(route, { role, file, token })).status, role ? 403 : 401, `${role}/${route}`);
    }
  }
  assert.deepEqual(rows(), old);
  const download = await request('template');
  assert.equal(download.status, 200);
  assert.deepEqual(download.data, fs.readFileSync(template));
  assert.deepEqual(XLSX.read(download.data).SheetNames, ['填写说明', ...sheets]);
  // 持有原超管签名的用户，改角色后旧凭证不能继续提交。
  db.exec('UPDATE users SET role_id=2 WHERE user_id=1');
  try { assert.equal((await confirm(file, token)).status, 403); }
  finally { db.exec('UPDATE users SET role_id=1 WHERE user_id=1'); }
  assert.deepEqual(rows(), old);
});

test('三张业务表预览、整批确认、文件内重复、同日多笔收货及重试', async () => {
  const old = rows();
  const more = receipt.slice(); more[3] = 24;
  const file = workbook([[receipt, receipt, more], [internal], [support]]);
  const p = await preview(file);
  const expected = [[sheets[0],2,'create'],[sheets[0],3,'skip'],[sheets[0],4,'create'],[sheets[1],2,'create'],[sheets[2],2,'create']];
  assert.deepEqual(actions(p), expected);
  assert.deepEqual(rows(), old);
  const result = await confirm(file, p.previewToken);
  counts(result, 4, 1, 0);
  assert.deepEqual(actions(result.data), expected);
  const all = rows();
  assert.deepEqual(all.slice(0, old.length), old);
  assert.equal(all.length, old.length + 4);
  const values = [
    { work_type:'收货', customer_id:1, customer_name:'测试货主', unit:'箱', cartons:12, tons:1.25, cubic:2.5, pallets:3, main_hours:4, other_hours:0.5, total_hours:4.5, efficiency:3, doc_cost:0.375, remark:'收货备注' },
    { work_type:'收货', cartons:24, efficiency:6, doc_cost:0.188 },
    { work_type:'库内', project:'上架', unit:'件', workload:17, main_hours:2, other_hours:0.75, total_hours:2.75, remark:'库内备注' },
    { work_type:'后勤', project:'管理人员', main_hours:3, other_hours:0.25, total_hours:3.25, remark:'后勤备注' },
  ];
  const created = p.rows.filter(r => r.action === 'create');
  values.forEach((expectedRow, i) => {
    const row = all[old.length + i];
    for (const [key, value] of Object.entries({ ...expectedRow, date:day, warehouse:'龙湖仓', shared_hours:0 })) {
      assert.equal(created[i].data[key], value, `预览 ${i}/${key}`);
      assert.equal(row[key], value, `写入 ${i}/${key}`);
    }
    assert.equal(row.status, 'archived'); assert.equal(row.owner_user_id, 1);
    assert.equal(row.submitter, '测试super_admin'); assert.ok(row.submit_time);
  });
  counts(await confirm(file, p.previewToken), 0, 5, 0);
  const next = await preview(file);
  assert.ok(next.rows.every(r => r.action === 'skip' && r.reason));
  counts(await confirm(file, next.previewToken), 0, 5, 0);
  assert.deepEqual(rows(), all);
});

test('已有 pending 库内行和文件内后勤冲突：给出原行号，整批不覆盖、不转归档', async () => {
  db.prepare(`INSERT INTO work_hours(warehouse,work_type,date,project,main_hours,remark,status) VALUES ('龙湖仓','库内',?,'上架',9,'历史草稿','pending')`).run(day);
  const old = rows(), changed = support.slice(); changed[2] = 7;
  const file = workbook([[receipt], [internal], [support, changed]]);
  const p = await preview(file);
  assert.deepEqual(actions(p), [[sheets[0],2,'create'],[sheets[1],2,'error'],[sheets[2],2,'create'],[sheets[2],3,'error']]);
  assert.ok(p.rows.filter(r => r.action === 'error').every(r => r.reason));
  const r = await confirm(file, p.previewToken);
  assert.equal(r.status, 400); assert.equal(r.data.created, 0); assert.equal(r.data.failed, 2);
  assert.deepEqual(rows(), old);
});

test('损坏、缺页、空模板、错扩展名、缺文件，以及预览后换文件/仓库均无写入', async () => {
  const old = rows(), file = workbook(), p = await preview(file);
  for (const opts of [{}, {file:Buffer.from('bad')}, {file, filename:'hours.txt'}]) {
    for (const route of ['preview','import']) assert.equal((await request(route, { ...opts, token:p.previewToken })).status, 400);
  }
  for (const invalid of [workbook([], b => b.SheetNames.pop()), fs.readFileSync(template)]) {
    assert.equal((await request('preview', { file: invalid })).status, 400);
    assert.equal((await confirm(invalid, p.previewToken)).status, 409, '确认首先校验上传文件与预览是否一致');
  }
  assert.equal((await confirm(file)).status, 400);
  assert.equal((await confirm(workbook([[], [internal], []]), p.previewToken)).status, 409);
  assert.equal((await request('import', { file, token:p.previewToken, warehouse:'佳新仓' })).status, 409);
  assert.deepEqual(rows(), old);
});

test('日期、客户、项目、单位、数量边界及超大文件均给出明确错误', async () => {
  const old = rows();
  const badDate = receipt.slice(); badDate[0] = '2026-02-30';
  const badMain = receipt.slice(); badMain[7] = 0;
  const badOther = receipt.slice(); badOther[8] = -0.1;
  const badUnit = receipt.slice(); badUnit[2] = '吨';
  const badCust = receipt.slice(); badCust[1] = '不存在的客户';
  const badProject = internal.slice(); badProject[1] = '不存在的项目';
  const badWorkload = internal.slice(); badWorkload[3] = '非数字';
  const file = workbook([[badDate, badMain, badOther, badUnit, badCust], [badProject, badWorkload], []]);
  const p = await preview(file);
  assert.equal(p.rows.length, 7);
  assert.ok(p.rows.every(r => r.action === 'error' && r.reason), JSON.stringify(p.rows));
  const r = await confirm(file, p.previewToken);
  assert.equal(r.status, 400);
  assert.equal(r.data.created, 0);
  const oversized = await request('preview', { file: Buffer.alloc(10 * 1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  assert.match(oversized.data.error, /10 MB/);
  assert.deepEqual(rows(), old);
});

test('预览、失败和成功批次均记录操作人、分表统计与逐行结果，且不存完整业务行', async () => {
  const bad = support.slice(); bad[2] = 0;
  const p = await preview(workbook([[receipt], [internal], [bad]]));
  const failed = await confirm(workbook([[receipt], [internal], [bad]]), p.previewToken);
  assert.equal(failed.status, 400);
  const before = db.prepare("SELECT * FROM audit_logs WHERE json_extract(content,'$.source')='threeHours' ORDER BY log_id").all();
  assert.equal(before.length, 2);
  assert.ok(before.every(r => r.operator === 'super_admin' && r.user_id === 1 && r.record_id === p.batchId), JSON.stringify(before.map(r => ({ operator: r.operator, user_id: r.user_id, record_id: r.record_id, batchId: p.batchId }))));
  assert.ok(before.every(r => r.target_id === p.batchId || r.target_id === failed.data.batchId));
  assert.ok(before.every(r => r.operated_at && r.created_at && r.table_name === 'work_hours' && r.action === 'import'));
  for (const log of before) {
    const content = JSON.parse(log.content);
    assert.equal(content.filename, 'hours.xlsx');
    assert.equal(content.warehouse, '龙湖仓');
    assert.equal(content.bySheet['收货工时'].total, 1);
    assert.equal(content.bySheet['后勤工时'].failed, 1);
    assert.ok(content.rows.every(r => r.sheet && r.line && r.result));
    assert.equal(content.rows.find(r => r.sheet === '后勤工时').reason, '主工时*：必须大于零');
    assert.equal(log.content.includes('收货备注'), false);
  }
  const good = await preview(workbook());
  const result = await confirm(workbook(), good.previewToken);
  counts(result, 3, 0, 0);
  const last = db.prepare("SELECT * FROM audit_logs WHERE json_extract(content,'$.stage')='import' AND json_extract(content,'$.outcome')='success'").get();
  assert.equal(last.record_id, result.data.batchId);
  assert.equal(last.target_id, result.data.batchId);
  const content = JSON.parse(last.content);
  assert.equal(content.created, 3);
  assert.equal(content.failed, 0);
  assert.equal(content.rows.length, 3);
  assert.ok(content.rows.every(r => r.result === 'created' && Number.isInteger(r.work_id)));
  assert.equal(content.bySheet['库内工时'].created, 1);
  assert.equal(content.bySheet['后勤工时'].created, 1);
});

test('失败日志也写不进去时保留 500 故障语义，不伪装为业务拒绝', async () => {
  const old = rows();
  db.exec("CREATE TRIGGER fail_import_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END");
  try {
    for (const opts of [{ route:'preview' }, { route:'import' }]) {
      const r = await request(opts.route, { file: workbook() });
      assert.equal(r.status, 500);
      assert.match(r.data.error, /日志/);
    }
  } finally { db.exec('DROP TRIGGER fail_import_audit'); }
  assert.deepEqual(rows(), old);
});

test('成功审计写入故障：三类已插行及成功日志一起回滚；同一凭证可重试', async () => {
  const old = rows(), file = workbook(), p = await preview(file);
  db.exec(`CREATE TRIGGER fail_import_audit BEFORE INSERT ON audit_logs
    WHEN json_extract(NEW.content,'$.outcome')='success' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END`);
  const r = await confirm(file, p.previewToken);
  assert.equal(r.status, 500); assert.equal(r.data.created, 0);
  assert.deepEqual(rows(), old);
  const success = db.prepare("SELECT target_id FROM audit_logs WHERE json_extract(content,'$.outcome')='success'");
  assert.deepEqual(success.all(), []);
  db.exec('DROP TRIGGER fail_import_audit');
  const retry = await confirm(file, p.previewToken);
  counts(retry, 3, 0, 0);
  assert.deepEqual(success.all().map(r => r.target_id), [retry.data.batchId]);
  assert.equal(rows().length, old.length + 3);
  assert.deepEqual(rows().slice(0, old.length), old);
});
