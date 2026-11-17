// 扫描线上看板接口，找出存在非空环比值（*_wow）的仓库/周期组合
const B = 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host';
const SC = 'EVNPURXWC2';

(async () => {
  try {
    const lr = await fetch(B + '/api/auth/login?sharecode=' + SC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const lj = await lr.json();
    const T = lj.token || (lj.data && lj.data.token);
    console.log('LOGIN | http=' + lr.status + ' token=' + (T ? 'yes' : 'NO'));
    const H = { 'X-ERP-Token': T || '' };
    const whs = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];
    const ranges = [
      ['2026-11-01', '2026-11-30'], ['2026-10-01', '2026-10-31'], ['2026-09-01', '2026-09-30'],
      ['2026-08-01', '2026-08-31'], ['2026-11-01', '2026-11-17'], ['2026-10-01', '2026-11-30'],
      ['2026-01-01', '2026-12-31'], ['2026-06-01', '2026-06-30'],
    ];
    let hits = 0;
    for (const w of whs) {
      for (const [s, e] of ranges) {
        for (const p of ['month', 'week', 'day']) {
          const u = B + '/api/dashboard/summary?warehouse=' + encodeURIComponent(w) +
            '&periodType=' + p + '&startDate=' + s + '&endDate=' + e + '&sharecode=' + SC;
          const r = await fetch(u, { headers: H });
          if (!r.ok) { console.log('HTTP', r.status, w, p, s, e); continue; }
          const j = await r.json();
          const all = [].concat(j.shippingList || [], j.receivingList || [], j.internalList || [], j.logisticsList || []);
          const wows = [];
          for (const o of all) {
            for (const k of Object.keys(o)) {
              if (/_wow$/.test(k) && o[k] != null) wows.push(k + '=' + Number(o[k]).toFixed(4));
            }
          }
          if (wows.length) {
            hits++;
            console.log('HIT | ' + w + ' ' + p + ' ' + s + '~' + e + ' | rows=' + all.length + ' | ' + wows.slice(0, 8).join(', '));
          }
        }
      }
    }
    console.log('DONE | 非空环比组合数 = ' + hits);
  } catch (e) {
    console.log('ERROR | ' + e.message);
  }
})();
