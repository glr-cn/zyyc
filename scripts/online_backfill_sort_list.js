// 线上补建：把固定排序名单里缺失的货主补齐（幂等）
// 用法：node scripts/online_backfill_sort_list.js [--dry-run]
// 规则：仓储客户·龙湖仓；company_name 严格按名单；sort_order 写入名单序号；
//       company_name 为 UNIQUE，名单同名多条只建一行（取首次出现的序号）
const { SORT_LIST } = require('../src/db/migrateCustomersSortOrder');

const BASE = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const WAREHOUSE = '龙湖仓';
const DRY = process.argv.includes('--dry-run');

async function main() {
  const lr = await (await fetch(`${BASE}/api/auth/login?sharecode=${SC}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  })).json();
  if (!lr.token) throw new Error('登录失败: ' + JSON.stringify(lr));
  const H = { 'X-ERP-Token': lr.token, 'Content-Type': 'application/json' };

  // 拉全量客户（含 company_name / customer_id / sort_order）
  const all = [];
  for (let p = 1; p <= 5; p++) {
    const j = await (await fetch(`${BASE}/api/customers?page=${p}&pageSize=50&sharecode=${SC}`, { headers: H })).json();
    all.push(...(j.data || []));
    if (all.length >= (j.total || 0) || !(j.data || []).length) break;
  }
  const exists = new Map();
  for (const c of all) if (!exists.has(c.company_name)) exists.set(c.company_name, c);
  console.log(`线上现有客户 ${all.length} 个`);

  // 名单去重（同 company_name 只保留首次出现的序号）
  const targets = [];
  const seen = new Set();
  SORT_LIST.forEach((name, i) => {
    if (seen.has(name)) { console.log(`  · #${i + 1} ${name}（名单同名，company_name UNIQUE → 与首次出现合并，不重复建）`); return; }
    seen.add(name);
    targets.push({ name, seq: i + 1 });
  });

  const missing = targets.filter(t => !exists.has(t.name));
  console.log(`\n需补建 ${missing.length} 条：`);
  missing.forEach(t => console.log(`  #${t.seq} ${t.name} → ${WAREHOUSE}`));

  if (DRY) { console.log('\n[dry-run] 未做任何写入'); return; }

  let created = 0, updated = 0, failed = 0;
  for (const t of missing) {
    const body = {
      customer_type: '仓储客户', company_name: t.name, short_name: '', warehouse: WAREHOUSE,
      contact_person: '', phone: '', address: '', erp_version: '', product_type: '',
      ecommerce_platform: '', product_count: 0, payment_account: '', prepaid_price: 0,
      cutoff_time: '', logistics_control: '', expiry_mgmt: '否', coop_status: '合作中',
      sort_order: t.seq, remark: `排序名单 #${t.seq}（2026-11-17 补建）`
    };
    const r = await fetch(`${BASE}/api/customers?customer_type=${encodeURIComponent('仓储客户')}&sharecode=${SC}`, {
      method: 'POST', headers: H, body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { created++; console.log(`  ✔ 新建 #${t.seq} ${t.name} (id=${j.data.customer_id}, sort_order=${j.data.sort_order})`); }
    else { failed++; console.log(`  ✘ 失败 #${t.seq} ${t.name} → HTTP ${r.status} ${j.error || ''}`); }
  }

  // 顺带修正顺序不符的（名单内已存在但 sort_order 不对）
  for (const t of targets) {
    const c = exists.get(t.name);
    if (!c || Number(c.sort_order) === t.seq) continue;
    const r = await fetch(`${BASE}/api/customers/${c.customer_id}?sharecode=${SC}`, {
      method: 'PUT', headers: H, body: JSON.stringify({ sort_order: t.seq })
    });
    if (r.ok) { updated++; console.log(`  ↻ 修正 ${t.name}: ${c.sort_order} → ${t.seq}`); }
    else { failed++; console.log(`  ✘ 修正失败 ${t.name} → HTTP ${r.status}`); }
  }

  console.log(`\n完成：新建 ${created} / 修正 ${updated} / 失败 ${failed}`);

  // 回读校验
  const after = [];
  for (let p = 1; p <= 5; p++) {
    const j = await (await fetch(`${BASE}/api/customers?page=${p}&pageSize=50&sharecode=${SC}`, { headers: H })).json();
    after.push(...(j.data || []));
    if (after.length >= (j.total || 0) || !(j.data || []).length) break;
  }
  const m2 = new Map();
  for (const c of after) if (!m2.has(c.company_name)) m2.set(c.company_name, c);
  const okN = targets.filter(t => m2.has(t.name) && Number(m2.get(t.name).sort_order) === t.seq).length;
  const stillMissing = targets.filter(t => !m2.has(t.name));
  console.log(`回读：客户总数 ${after.length}；名单命中且顺序正确 ${okN}/${targets.length}；仍缺失 ${stillMissing.length}`);
  stillMissing.forEach(t => console.log('   -', t.name));
  const head = after.filter(c => Number(c.sort_order) < 9999).sort((a, b) => a.sort_order - b.sort_order);
  console.log('排序头 10 条：');
  head.slice(0, 10).forEach(c => console.log(`   ${c.sort_order}. ${c.company_name}（${c.warehouse}）`));
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
