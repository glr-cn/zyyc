// 工时归档 + 发货全量货主 + 仓库隔离 端到端回归（隔离临时库 + 服务 3001）
// 启动：ERP_DB_PATH=<含test的库> PORT=3001 node src/server.js
const BASE = 'http://127.0.0.1:3001';
const DB_PATH = process.env.ERP_DB_PATH || '';
if (!/test/i.test(DB_PATH)) {
  console.error('必须设置 ERP_DB_PATH 指向隔离测试库（路径含 test）');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
{
  const d = new DatabaseSync(DB_PATH);
  d.exec('DELETE FROM work_hours; DELETE FROM customers; DELETE FROM audit_logs;');
  d.close();
}
let TOKEN = '', failed = 0, passed = 0;
function ok(c, m, extra) {
  if (c) { passed++; console.log('PASS:', m); }
  else { failed++; console.error('FAIL:', m, extra != null ? JSON.stringify(extra) : ''); }
}
async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (TOKEN) opt.headers['X-ERP-Token'] = TOKEN;
  const r = await fetch(BASE + path, opt);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const hash = bcryptHash('admin123');
function bcryptHash(p) { return require('bcryptjs').hashSync(p, 10); }
{
  // 确保 admin
  const d = new DatabaseSync(DB_PATH);
  d.prepare('INSERT OR IGNORE INTO users(user_id,username,password_hash,display_name,role_id) VALUES(1,?,?,?,1)')
    .run('admin', hash, '管理员');
  d.close();
}

(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  TOKEN = r.data && r.data.token;
  ok(r.status === 200 && !!TOKEN, '登录 admin', r.data);

  // --- 造客户：佳新仓启用 / 佳新仓停用 / 佳新+速远多仓 / 速远仓专属（已删除） ---
  const cJx = await api('POST', '/api/customers', { customer_type: '仓储客户', company_name: '佳新甲客户', short_name: '佳甲', warehouse: '佳新仓', coop_status: '合作中' });
  const cStop = await api('POST', '/api/customers', { customer_type: '仓储客户', company_name: '佳新乙客户', short_name: '佳乙', warehouse: '佳新仓', coop_status: '暂停' });
  const cMulti = await api('POST', '/api/customers', { customer_type: '仓储客户', company_name: '佳新速远丙客户', short_name: '丙多仓', warehouse: '佳新仓,速远仓', coop_status: '合作中' });
  const cSy = await api('POST', '/api/customers', { customer_type: '仓储客户', company_name: '速远专属丁客户', short_name: '速丁', warehouse: '速远仓', coop_status: '合作中' });
  ok(cJx.status === 201 && cStop.status === 201 && cMulti.status === 201 && cSy.status === 201,
    '创建 4 客户（含停用/多仓/速远专属）', [cJx.status, cStop.status, cMulti.status, cSy.status]);
  const idJx = cJx.data.data.customer_id, idStop = cStop.data.data.customer_id,
        idMulti = cMulti.data.data.customer_id, idSy = cSy.data.data.customer_id;

  // 软删速远专属客户 → /options 与缺口清单都不应出现
  await api('DELETE', '/api/customers/' + idSy);

  const PERIOD = 'dateFrom=2026-11-01&dateTo=2026-11-30';
  // --- 1. 发货缺口：佳新仓应显示 甲/丙(多仓) 两条未填；停用乙、速远专属丁均不出现 ---
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=pending&' + PERIOD);
  let rows = r.data.data || [];
  const names = rows.map((x) => x.customer_name);
  ok(r.status === 200, '发货列表 200', r.data);
  ok(names.some((n) => n.includes('佳新甲')) && names.some((n) => n.includes('丙')),
    '本仓启用/多仓货主出现', names);
  ok(!names.some((n) => n.includes('佳新乙')), '停用货主不出现在缺口清单（新语义）', names);
  ok(names.every((n) => !/^\s*$/.test(n)), '货主名称非空（缺口行显示公司全称）', names);
  ok(!names.some((n) => n.includes('速远专属')), '速远仓专属货主不出现在佳新仓缺口', names);
  ok(rows.every((x) => x.filled === 0), '当前全是未填写缺口行 filled=0', rows.map((x) => x.filled));
  // 待补日期：本期(11月)含昨天时，缺口行带 suggest_date / need_backfill=1
  const firstGap = rows.find((x) => x.filled === 0);
  ok(firstGap && /^\d{4}-\d{2}-\d{2}$/.test(firstGap.suggest_date || ''), '缺口行带建议日期 suggest_date', firstGap);
  ok(firstGap && firstGap.need_backfill === 1, '本期含昨天时缺口行标记待补 need_backfill=1', firstGap);
  ok(r.data.period && r.data.period.from === '2026-11-01', '返回本期口径', r.data.period);

  // --- 2. 录一条甲客户发货工时 → 缺口行消失、出现已填行 ---
  const add = await api('POST', '/api/workhours', {
    warehouse: '佳新仓', work_type: '发货', customer_id: idJx, customer_name: '佳甲',
    date: '2026-11-15', unit: '件', ship_orders: 100, main_hours: 5, other_hours: 0, shared_hours: 0,
  });
  ok(add.status === 201, '新增发货工时成功', add.data);
  const workId = add.data.data.work_id;
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=pending&' + PERIOD);
  rows = r.data.data || [];
  const jia = rows.find((x) => x.customer_id === idJx);
  ok(jia && jia.filled === 1 && jia.ship_orders === 100, '甲客户变为已填行 filled=1', jia);
  ok(!rows.some((x) => x.customer_id === idJx && x.filled === 0), '甲客户未填缺口行消失', rows.map((x) => [x.customer_name, x.filled]));

  // --- 3. 本期口径联动：切到 10 月，甲又变缺口 ---
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=pending&dateFrom=2026-10-01&dateTo=2026-10-31');
  rows = r.data.data || [];
  const jiaOct = rows.find((x) => x.customer_id === idJx);
  ok(jiaOct && jiaOct.filled === 0, '切到 10 月甲客户变回未填（本期联动）', jiaOct);

  // --- 4. 其他类型 tab 不展示缺口行 ---
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=收货&status=pending&' + PERIOD);
  ok((r.data.data || []).length === 0 && r.data.total === 0, '收货 tab 不展示未填货主', r.data);

  // --- 5. 默认 status=pending；归档后 pending 列表不再显示 ---
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&' + PERIOD);
  ok((r.data.data || []).some((x) => x.work_id === workId), '默认 pending 含该工时');
  const arc = await api('POST', '/api/workhours/archive', { warehouse: '佳新仓', work_type: '发货', ids: [workId] });
  ok(arc.status === 200 && arc.data.archived === 1, '勾选归档成功', arc.data);
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=pending&' + PERIOD);
  ok(!(r.data.data || []).some((x) => x.work_id === workId), '归档后 pending 列表不含该工时');
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=archived&' + PERIOD);
  ok((r.data.data || []).some((x) => x.work_id === workId), 'archived 视图可查到归档工时');
  // 缺口判定含归档：归档后甲客户本期已有记录（含 archived），不再回到缺口
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=pending&' + PERIOD);
  ok(!(r.data.data || []).some((x) => x.customer_id === idJx && x.filled === 0), '归档后甲客户不再回缺口（提交即消失语义）', r.data.data);

  // --- 6. 归档防越权：跨仓归档被拒 ---
  const badArc = await api('POST', '/api/workhours/archive', { warehouse: '速远仓', work_type: '发货', ids: [workId] });
  ok(badArc.status === 403, '跨仓归档被拒 403', badArc.data);

  // --- 7. 归档当前筛选全部（all 模式）---
  const a2 = await api('POST', '/api/workhours', {
    warehouse: '佳新仓', work_type: '发货', customer_id: idMulti, customer_name: '丙多仓',
    date: '2026-11-16', unit: '箱', ship_orders: 50, main_hours: 3, other_hours: 0, shared_hours: 0,
  });
  ok(a2.status === 201, '新增第二条发货工时', a2.data);
  const arcAll = await api('POST', '/api/workhours/archive', { warehouse: '佳新仓', work_type: '发货', all: true, dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  ok(arcAll.status === 200 && arcAll.data.archived >= 1, '归档当前筛选全部成功', arcAll.data);

  // --- 8. 软删客户后历史工时仍显示（数据完整性铁律）---
  {
    const d = new DatabaseSync(DB_PATH);
    const c = d.prepare("SELECT COUNT(*) c FROM work_hours WHERE status IN ('pending','archived')").get().c;
    const cust = d.prepare('SELECT COUNT(*) c FROM customers').get().c;
    d.close();
    ok(c >= 2, '历史工时行数未丢失', c);
    ok(cust >= 4, '客户行（含软删）未物理丢失', cust);
  }

  console.log(`\n结果：${passed} PASS / ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
