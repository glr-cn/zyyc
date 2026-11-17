// 重放 c1f075d 后端日志：所有变量取自线上真实 API（托管实例不暴露容器 stdout）
// 复刻一次 GET /api/dashboard/summary?warehouse=龙湖仓&periodType=month&startDate=2026-11-01&endDate=2026-11-30 触发的日志
const B = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const WH = '龙湖仓';
const r3 = (x) => Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;
// 复刻 SQLite COALESCE(SUM(...),0) 的显示：整数不带小数点，浮点保留原始
function sqlNum(x) {
  const n = Number(x) || 0;
  return Object.is(n, Math.round(n)) ? String(n) : String(n);
}

(async () => {
  const lr = await fetch(B + '/api/auth/login?sharecode=' + SC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const lj = await lr.json();
  const T = lj.token || (lj.data && lj.data.token);
  const H = { 'X-ERP-Token': T };

  // 库内 archived 行（龙湖仓），分本期/上期
  const q = 'warehouse=' + encodeURIComponent(WH) + '&work_type=' + encodeURIComponent('库内') + '&status=archived&page=1&pageSize=500&sharecode=' + SC;
  const j = await (await fetch(B + '/api/workhours?' + q, { headers: H })).json();
  const rows = Array.isArray(j) ? j : (j.data || j.rows || j.list || []);
  console.log('=== 库内 archived 原始行（用于核对字段）===');
  rows.forEach(r => console.log(JSON.stringify({
    date: r.date || r.suggest_date, main: r.main_hours, other: r.other_hours,
    shared: r.shared_hours, status: r.status, warehouse: r.warehouse, work_type: r.work_type,
  })));

  function agg(start, end) {
    const inRange = rows.filter(r => { const d = String(r.date || r.suggest_date || ''); return d >= start && d <= end; });
    let tmain = 0, tshared = 0;
    inRange.forEach(r => { tmain += (Number(r.main_hours) || 0) + (Number(r.other_hours) || 0); tshared += (Number(r.shared_hours) || 0); });
    return { cnt: inRange.length, tmain: r3(tmain), tshared: r3(tshared), total: r3(r3(tmain) + r3(tshared)) };
  }
  // computePeriods(month): 本期 2026-11-01~2026-11-30, 上期 2026-10-01~2026-10-31
  const curAgg = agg('2026-11-01', '2026-11-30');
  const prevAgg = agg('2026-10-01', '2026-10-31');

  // summary → 分母与参与客户
  const qs = 'warehouse=' + encodeURIComponent(WH) + '&periodType=month&startDate=2026-11-01&endDate=2026-11-30&sharecode=' + SC;
  const sum = await (await fetch(B + '/api/dashboard/summary?' + qs, { headers: H })).json();
  const ship = sum.shippingList || [];
  const qual = ship.filter(o => (Number(o.cur_ship_qty) || 0) > 100);
  const curQualSumQty = r3(qual.reduce((s, o) => s + Number(o.cur_ship_qty), 0));
  const prevQualSumQty = r3(ship.filter(o => (Number(o.prev_ship_qty) || 0) > 100).reduce((s, o) => s + Number(o.prev_ship_qty), 0));
  const names = qual.map(o => o.customer_name + '(' + o.cur_ship_qty + ')').join(',') || '(无)';

  console.log('\n=== 按线上 c1f075d 模板重放的日志行 ===');
  console.log(`[看板分摊-库内公摊] ${WH} 2026-11-01~2026-11-30 | 行=${curAgg.cnt} main+other=${sqlNum(curAgg.tmain)} shared=${sqlNum(curAgg.tshared)} => TOTAL=${sqlNum(curAgg.total)}`);
  console.log(`[看板分摊-库内公摊] ${WH} 2026-10-01~2026-10-31 | 行=${prevAgg.cnt} main+other=${sqlNum(prevAgg.tmain)} shared=${sqlNum(prevAgg.tshared)} => TOTAL=${sqlNum(prevAgg.total)}`);
  console.log(`[看板分摊-分母] curPeriod curQualSumQty=${curQualSumQty} curTotalShared=${sqlNum(curAgg.total)} | prevPeriod prevQualSumQty=${prevQualSumQty} prevTotalShared=${sqlNum(prevAgg.total)}`);
  console.log(`[看板分摊-参与客户] cur>100客户名单=${names}`);
})();
