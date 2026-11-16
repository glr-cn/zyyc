// 发货工时行内填报（提交即归档）+ 待补日期 + 模板默认 端到端回归（隔离临时库 + 服务 3001）
// 启动：ERP_DB_PATH=<含test的库> PORT=3001 node src/server.js
const BASE = 'http://127.0.0.1:3001';
const DB_PATH = process.env.ERP_DB_PATH || '';
if (!/test/i.test(DB_PATH)) {
  console.error('必须设置 ERP_DB_PATH 指向隔离测试库（路径含 test）');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
{
  const d = new DatabaseSync(DB_PATH);
  d.exec('DELETE FROM work_hours; DELETE FROM customers; DELETE FROM audit_logs;');
  d.prepare('INSERT OR IGNORE INTO users(user_id,username,password_hash,display_name,role_id) VALUES(1,?,?,?,1)')
    .run('admin', bcrypt.hashSync('admin123', 10), '管理员');
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
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  TOKEN = r.data && r.data.token;
  ok(r.status === 200 && !!TOKEN, '登录 admin', r.data);

  // 造客户：启用甲、停用乙、启用丙
  const cJia = await api('POST', '/api/customers', { customer_type: '仓储客户', company_name: '行填报甲公司', short_name: '填报甲', warehouse: '佳新仓', coop_status: '合作中' });
  const cYi = await api('POST', '/api/customers', { customer_type: '仓储客户', company_name: '行填报乙公司', short_name: '填报乙', warehouse: '佳新仓', coop_status: '暂停' });
  const cBing = await api('POST', '/api/customers', { customer_type: '仓储客户', company_name: '行填报丙公司', short_name: '填报丙', warehouse: '佳新仓', coop_status: '合作中' });
  ok(cJia.status === 201 && cYi.status === 201 && cBing.status === 201, '创建 3 客户（含停用）');
  const idJia = cJia.data.data.customer_id, idYi = cYi.data.data.customer_id, idBing = cBing.data.data.customer_id;

  const PERIOD = 'dateFrom=2026-11-01&dateTo=2026-11-30';
  // 1. 缺口：启用甲/丙出现，停用乙不出现
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=pending&' + PERIOD);
  let gaps = (r.data.data || []).filter((x) => x.filled === 0);
  const gnames = gaps.map((x) => x.customer_name);
  ok(gnames.some((n) => n.includes('甲')) && gnames.some((n) => n.includes('丙')), '缺口含启用甲/丙', gnames);
  ok(!gnames.some((n) => n.includes('乙')), '缺口不含停用乙', gnames);
  const suggest = (gaps.find((x) => x.customer_id === idJia) || {}).suggest_date;
  const needBf = (gaps.find((x) => x.customer_id === idJia) || {}).need_backfill;
  ok(!!suggest, '缺口行返回 suggest_date', suggest);
  ok(needBf === 1, '本期含昨天时 need_backfill=1', needBf);

  // 2. 行内提交：auto_archive=true，日期用待补日 suggest，单位=单
  const add = await api('POST', '/api/workhours', {
    warehouse: '佳新仓', work_type: '发货', customer_id: idJia, customer_name: '填报甲',
    date: suggest, unit: '单', ship_orders: 120, main_hours: 6, other_hours: 1.5, shared_hours: 0,
    remark: '行内补报', auto_archive: true,
  });
  ok(add.status === 201, '行内提交成功', add.data);
  const rec = add.data && add.data.data;
  ok(rec && rec.status === 'archived', '提交即归档 status=archived', rec);
  ok(rec && rec.date === suggest, '日期用待补日原样入库（非今天）', { stored: rec && rec.date, suggest, today: todayStr() });
  ok(rec && rec.unit === '单', '单位=单落库', rec && rec.unit);
  ok(rec && rec.efficiency === 20, '时效=120/6=20', rec && rec.efficiency);        // 120/6
  ok(rec && rec.total_hours === 7.5, '总工时=6+1.5+0=7.5', rec && rec.total_hours);
  ok(rec && Math.abs(rec.unit_cost - 0.0625) < 1e-9 || rec.unit_cost === 0.063, '单均成本=7.5/120≈0.063', rec && rec.unit_cost);

  // 3. 提交后甲从缺口消失（缺口判定含归档）
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=pending&' + PERIOD);
  gaps = (r.data.data || []).filter((x) => x.filled === 0);
  ok(!gaps.some((x) => x.customer_id === idJia), '提交后甲从缺口消失', gaps.map((x) => x.customer_name));
  // 归档视图可见
  r = await api('GET', '/api/workhours?warehouse=佳新仓&work_type=发货&status=archived&' + PERIOD);
  ok((r.data.data || []).some((x) => x.customer_id === idJia), '归档视图可见刚提交的记录');

  // 4. 单位白名单：单/件/箱 通过；非法单位被拒（托/公斤不再是标准，但历史兼容放行——见 service LEGACY_UNITS）
  for (const [u, expect] of [['单', 201], ['件', 201], ['箱', 201], ['公斤', 201], ['光', 400]]) {
    const rr = await api('POST', '/api/workhours', {
      warehouse: '佳新仓', work_type: '发货', customer_id: idBing, customer_name: '填报丙',
      date: '2026-11-14', unit: u, ship_orders: 10, main_hours: 2, auto_archive: true,
    });
    ok(rr.status === expect, `单位「${u}」返回 ${expect}`, rr.data);
  }

  // 5. 模板：第一列日期=今天，单位=单（解析 xlsx）
  const tplR = await fetch(BASE + '/api/workhours/template?warehouse=' + encodeURIComponent('佳新仓') + '&work_type=' + encodeURIComponent('发货'), { headers: { 'X-ERP-Token': TOKEN } });
  const buf = Buffer.from(await tplR.arrayBuffer());
  ok(tplR.status === 200 && buf.length > 4 && buf[0] === 0x50, '模板下载为 xlsx', tplR.status);
  const xlsx = require('xlsx');
  const wb = xlsx.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
  ok(aoa[0][0] === '日期' && aoa[0][2] === '单位', '模板表头正确', aoa[0]);
  ok(aoa[1] && aoa[1][0] === todayStr(), '模板日期列默认今天', aoa[1]);
  ok(aoa[1] && aoa[1][2] === '单', '模板单位列默认单', aoa[1]);
  ok(aoa.length === 3, '模板只预填启用货主（甲+丙，停用乙排除）', aoa.map((x) => x[1]));

  // 6. 历史数据零损：所有写入行都在
  {
    const d = new DatabaseSync(DB_PATH);
    const c = d.prepare("SELECT COUNT(*) c FROM work_hours WHERE status IN ('pending','archived')").get().c;
    d.close();
    ok(c >= 5, '历史工时行数未丢失（1行内提交+4单位测试行）', c);
  }

  // 前端标记检查（函数级）
  const fs = require('fs');
  const js = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'workhours.js'), 'utf8');
  // 行内直编改造后：新标记必须存在
  for (const kw of ['bindInlineRow', 'data-row-cid', 'bk-tag', 'auto_archive = true', 'data-out="efficiency"', 'delAdmin']) {
    ok(js.includes(kw), '前端含标记 ' + kw);
  }
  // 旧「填写按钮 + 提交」逻辑必须已彻底移除
  for (const kw of ['inlineFill', 'inlineSubmit', 'inlineCancel', 'bindInlineCalc', 'data-act="fill"']) {
    ok(!js.includes(kw), '旧标记已移除 ' + kw);
  }

  console.log(`\n结果：${passed} PASS / ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
