// 经营看板页（阶段 5）：本月发货量 / 平均单均成本 / 公摊占比 / 货主单均成本排名（前三后三）
window.ERP_PAGES = window.ERP_PAGES || {};
window.ERP_PAGES.dashboard = function (host) {
  const c = host;
  const $ = (id) => c.querySelector("#" + id);
  c.innerHTML = `
    <div class="toolbar">
      <span id="dashMonth" class="hint"></span>
      <button id="refreshBtn" class="primary" style="margin-left:auto">刷新</button>
    </div>
    <div class="kpi-row" id="kpiRow">
      <div class="kpi"><div class="kpi-label">本月发货量</div><div class="kpi-val" id="kpiShip">—</div></div>
      <div class="kpi"><div class="kpi-label">本月平均单均成本</div><div class="kpi-val" id="kpiCost">—</div></div>
      <div class="kpi"><div class="kpi-label">公摊工时占比</div><div class="kpi-val" id="kpiShare">—</div></div>
    </div>
    <h3>货主单均成本排名（前三 / 后三）</h3>
    <div class="kpi-rank">
      <div class="card">
        <div class="card-title">单均成本最低（前三）</div>
        <table class="grid"><thead><tr><th>排名</th><th>客户名称</th><th class="num">单均成本</th><th class="num">发货量</th></tr></thead>
        <tbody id="topBody"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody></table>
      </div>
      <div class="card">
        <div class="card-title">单均成本最高（后三）</div>
        <table class="grid"><thead><tr><th>排名</th><th>客户名称</th><th class="num">单均成本</th><th class="num">发货量</th></tr></thead>
        <tbody id="bottomBody"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody></table>
      </div>
    </div>`;

  $('refreshBtn').onclick = load;
  load();

  async function load() {
    const r = await API.get('/analytics/dashboard');
    $('dashMonth').textContent = '统计月份：' + r.month;
    $('kpiShip').textContent = num(r.month_ship_qty);
    $('kpiCost').textContent = num(r.avg_unit_cost);
    $('kpiShare').textContent = (r.shared_ratio * 100).toFixed(1) + '%';

    const tb = $('topBody');
    const bb = $('bottomBody');
    tb.innerHTML = r.owner_rank.top3.length
      ? r.owner_rank.top3.map((o, i) => rankRow(i + 1, o)).join('')
      : '<tr><td colspan="4" class="empty">暂无数据</td></tr>';
    bb.innerHTML = r.owner_rank.bottom3.length
      ? r.owner_rank.bottom3.map((o, i) => rankRow(i + 1, o)).join('')
      : '<tr><td colspan="4" class="empty">暂无数据</td></tr>';
  }

  function rankRow(i, o) {
    return `<tr><td>${i}</td><td>${escapeHtml(o.customer_name)}</td><td class="num">${num(o.unit_cost)}</td><td class="num">${num(o.ship_qty)}</td></tr>`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function num(x) { return (x == null ? 0 : Number(x)).toFixed(3); }
};
