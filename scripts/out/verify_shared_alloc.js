// 只读验证 db7c034：发货组「库内公摊按单量比例分摊」规则是否生效
//  1) 取线上 dashboard/summary（龙湖仓 · 2026-11 全月 · month）
//  2) 独立从 /api/workhours 拉库内归档行，SUM(shared_hours) = TotalPublicShared
//  3) 复算：qty>100 的客户 shared = TotalShared * qty / sumQty(qty>100)；qty<=100 → 0
//  4) 对照 API 返回的 cur_shared_hours / cur_total_hours / cur_cost / cur_unit_cost
const B = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';
const RATE = 17;
const r3 = (x) => Math.round(x * 1000) / 1000;

(async () => {
  const lr = await fetch(B + '/api/auth/login?sharecode=' + SC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const lj = await lr.json();
  const T = lj.token || (lj.data && lj.data.token);
  const H = { 'X-ERP-Token': T };

  const qs = 'warehouse=' + encodeURIComponent('龙湖仓') + '&periodType=month&startDate=2026-11-01&endDate=2026-11-30';
  const sum = await (await fetch(B + '/api/dashboard/summary?' + qs + '&sharecode=' + SC, { headers: H })).json();
  console.log('periodLabel =', sum.periodLabel, '| prev =', sum.prevPeriodLabel);
  const ship = sum.shippingList || [];
  console.log('发货组行数 =', ship.length);

  // 独立取库内归档 shared 总额（本期 + 上期）
  async function internalShared(start, end) {
    let total = 0, rows = 0;
    for (const wt of ['库内']) {
      const q = 'warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent(wt) + '&status=archived&page=1&pageSize=500&sharecode=' + SC;
      const j = await (await fetch(B + '/api/workhours?' + q, { headers: H })).json();
      const list = Array.isArray(j) ? j : (j.data || j.rows || j.list || []);
      for (const r of list) {
        const d = String(r.date || r.suggest_date || '');
        if (d >= start && d <= end) { total += Number(r.shared_hours) || 0; rows++; }
      }
    }
    return { total: r3(total), rows };
  }
  const cur = await internalShared('2026-11-01', '2026-11-30');
  const prev = await internalShared('2026-10-01', '2026-10-31');
  console.log('库内归档行 cur=' + cur.rows + ' shared总额=' + cur.total, '| prev=' + prev.rows + ' shared总额=' + prev.total);

  // 复算分摊
  const sumCur = ship.filter(o => o.cur_ship_qty > 100).reduce((s, o) => s + o.cur_ship_qty, 0);
  const sumPrev = ship.filter(o => o.prev_ship_qty > 100).reduce((s, o) => s + o.prev_ship_qty, 0);
  console.log('qty>100 客户数 cur=', ship.filter(o => o.cur_ship_qty > 100).length, 'sumQty=', sumCur, '| prev=', ship.filter(o => o.prev_ship_qty > 100).length, 'sumQty=', sumPrev);

  let pass = 0, fail = 0;
  function ok(c, label, extra) { if (c) pass++; else fail++; console.log((c ? 'PASS' : 'FAIL') + ' | ' + label + (extra !== undefined ? ' | ' + extra : '')); }

  const samples = [];
  for (const o of ship) {
    const expCur = (cur.total > 0 && sumCur > 0 && o.cur_ship_qty > 100) ? r3(cur.total * (o.cur_ship_qty / sumCur)) : 0;
    const expPrev = (prev.total > 0 && sumPrev > 0 && o.prev_ship_qty > 100) ? r3(prev.total * (o.prev_ship_qty / sumPrev)) : 0;
    const gotCur = Number(o.cur_shared_hours) || 0;
    const gotPrev = Number(o.prev_shared_hours) || 0;
    const okShared = Math.abs(expCur - gotCur) < 0.002 && Math.abs(expPrev - gotPrev) < 0.002;
    // 联动重算
    const expTotal = r3((Number(o.cur_main_hours) || 0) + (Number(o.cur_other_hours) || 0) + gotCur);
    const expCost = r3(expTotal * RATE);
    const expUC = (Number(o.cur_ship_qty) || 0) > 0 ? r3(expCost / o.cur_ship_qty) : 0;
    const okTotal = Math.abs(expTotal - (Number(o.cur_total_hours) || 0)) < 0.002;
    const okCost = Math.abs(expCost - (Number(o.cur_cost) || 0)) < 0.002;
    const okUC = Math.abs(expUC - (Number(o.cur_unit_cost) || 0)) < 0.002;
    if (!okShared || !okTotal || !okCost || !okUC) {
      console.log('MISMATCH |', o.customer_name, '| shared got=' + gotCur + ' exp=' + expCur, '| total got=' + o.cur_total_hours + ' exp=' + expTotal, '| cost got=' + o.cur_cost + ' exp=' + expCost, '| UC got=' + o.cur_unit_cost + ' exp=' + expUC);
    }
    if (o.cur_ship_qty > 100 && samples.length < 5) samples.push({ name: o.customer_name, qty: o.cur_ship_qty, shared: gotCur, total: o.cur_total_hours, cost: o.cur_cost, uc: o.cur_unit_cost });
    if (okShared) pass++; else fail++;
    if (okTotal) pass++; else fail++;
    if (okCost) pass++; else fail++;
    if (okUC) pass++; else fail++;
  }
  console.log('SAMPLE | qty>100 客户分摊示例：');
  samples.forEach(s => console.log('  ', JSON.stringify(s)));
  // 非参与客户应全 0
  const below = ship.filter(o => (o.cur_ship_qty || 0) <= 100);
  const badBelow = below.filter(o => (Number(o.cur_shared_hours) || 0) !== 0);
  ok(badBelow.length === 0, '★ 单量≤100 的客户公摊工时全为 0（' + below.length + ' 行）', badBelow.slice(0, 3).map(o => o.customer_name + '=' + o.cur_shared_hours).join(', '));
  const sumGot = r3(ship.reduce((s, o) => s + (Number(o.cur_shared_hours) || 0), 0));
  ok(Math.abs(sumGot - cur.total) < 0.05, '★ 分摊总和 = 库内公摊总额', '分摊合计=' + sumGot + ' 库内总额=' + cur.total);
  console.log('RESULT | PASS=' + pass + ' FAIL=' + fail);
})();
