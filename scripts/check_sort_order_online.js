// 线上现状核对：把 customers 的 sort_order 与固定名单比对（只读）
const { SORT_LIST } = require('../src/db/migrateCustomersSortOrder');

const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';

async function main() {
  const lr = await (await fetch(`${BASE}/api/auth/login?sharecode=${SC}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  })).json();
  if (!lr.token) throw new Error('登录失败: ' + JSON.stringify(lr));
  const H = { 'X-ERP-Token': lr.token };

  const all = [];
  for (let p = 1; p <= 10; p++) {
    const j = await (await fetch(`${BASE}/api/customers?page=${p}&pageSize=50&sharecode=${SC}`, { headers: H })).json();
    const rows = j.data || [];
    all.push(...rows);
    if (all.length >= (j.total || 0) || !rows.length) break;
  }
  console.log('线上客户总数 =', all.length);

  const byName = new Map();
  for (const c of all) {
    if (!byName.has(c.company_name)) byName.set(c.company_name, []);
    byName.get(c.company_name).push(c);
  }

  const missing = [], ok = [], mismatch = [];
  SORT_LIST.forEach((name, i) => {
    const seq = i + 1;
    const rows = byName.get(name);
    if (!rows || !rows.length) { missing.push(`#${seq} ${name}`); return; }
    const bad = rows.filter(r => Number(r.sort_order) !== seq);
    if (bad.length) mismatch.push(`#${seq} ${name} -> 现有 ${bad.map(r => r.sort_order).join('/')}（应为 ${seq}）`);
    else ok.push(`#${seq} ${name}（${rows.length} 行）`);
  });

  console.log('\n已按名单正确排序:', ok.length, '条');
  console.log('未匹配到客户行（不会新建）:', missing.length, '条');
  missing.forEach(m => console.log('   -', m));
  console.log('顺序不符（需修正）:', mismatch.length, '条');
  mismatch.forEach(m => console.log('   -', m));

  // 需要通过 API 修正的清单
  const fix = [];
  SORT_LIST.forEach((name, i) => {
    const seq = i + 1;
    (byName.get(name) || []).forEach(c => {
      if (Number(c.sort_order) !== seq) fix.push({ customer_id: c.customer_id, company_name: name, want: seq, now: c.sort_order });
    });
  });
  console.log('\n待修正条数 =', fix.length);
  require('fs').writeFileSync(require('path').join(__dirname, 'out', 'sort_order_fix.json'), JSON.stringify(fix, null, 2));
  console.log('清单已写入 scripts/out/sort_order_fix.json');
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
