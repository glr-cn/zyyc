// 工时汇总页（深度重构适配）：按日/周/月 + warehouse/work_type 维度；公摊占比分摊 + 两图表
window.ERP_PAGES = window.ERP_PAGES || {};
window.ERP_PAGES.analytics = function (host) {
  const c = host;
  const $ = (id) => c.querySelector("#" + id);
  const WAREHOUSES = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];
  const WORK_TYPES = ['发货', '收货', '库内', '后勤'];
  c.innerHTML = `
    <div class="toolbar">
      <label style="display:flex;align-items:center;gap:6px">仓库
        <select id="warehouse"><option value="">全部</option>${WAREHOUSES.map((w) => `<option>${w}</option>`).join('')}</select>
      </label>
      <label style="display:flex;align-items:center;gap:6px">类型
        <select id="work_type"><option value="">全部</option>${WORK_TYPES.map((w) => `<option>${w}</option>`).join('')}</select>
      </label>
      <span id="drpSlot"></span>
      <button id="qryBtn" class="primary">查询</button>
      <button id="resetBtn">重置</button>
    </div>
    <h3>汇总表（公摊工时按各客户直接工时占比分摊；单均成本 = 分摊后总工时 ÷ 发货单量）</h3>
    <table class="grid">
      <thead><tr>
        <th>周期</th><th>仓库</th><th>类型</th><th>客户名称</th><th class="num">发货量</th><th class="num">箱数</th>
        <th class="num">主工时</th><th class="num">其他工时</th><th class="num">公摊工时</th><th class="num">总工时</th>
        <th class="num">时效</th><th class="num">单均成本</th><th class="num">单据成本</th>
      </tr></thead>
      <tbody id="sumBody"><tr><td colspan="13" class="empty">加载中…</td></tr></tbody>
    </table>
    <h3 style="margin-top:22px" id="chart1Title">趋势图</h3>
    <div class="card"><div id="chart1"></div></div>
    <h3 style="margin-top:18px">公摊工时占比变化图（每期 主/其他/公摊 构成）</h3>
    <div class="card"><div id="chart2"></div></div>`;

  const warehouse = $('warehouse');
  const workType = $('work_type');

  // 日期范围组件：mode（按日/按周/按月）同时作为后端聚合维度参数，值域一致；
  // 产出的 startDate/endDate 映射为后端 from/to（后端零改动）。默认 mode=month 与原行为一致。
  const drp = new DateRangePicker({
    mount: $('drpSlot'),
    mode: 'month',
    onChange: () => load() // analytics 切换维度/范围即刷新，与原下拉 onchange 立即生效的行为一致
  });

  $('qryBtn').onclick = load;
  $('resetBtn').onclick = () => {
    drp.setValue({ mode: 'month', startDate: '', endDate: '' }, true);
    warehouse.value = ''; workType.value = '';
    load();
  };
  load();

  async function load() {
    const v = drp.getValue();
    const params = new URLSearchParams({ mode: v.mode });
    if (warehouse.value) params.set('warehouse', warehouse.value);
    if (workType.value) params.set('work_type', workType.value);
    if (v.startDate) params.set('from', v.startDate);
    if (v.endDate) params.set('to', v.endDate);
    const r = await API.get('/analytics/summary?' + params.toString());
    const body = $('sumBody');
    const rows = r.table || [];
    body.innerHTML = rows.length ? rows.map(rowHtml).join('') : '<tr><td colspan="13" class="empty">暂无工时数据</td></tr>';

    const t1 = $('chart1Title');
    if (r.chart1 && r.chart1.type === 'unit_cost') t1.textContent = '单均成本趋势图';
    else t1.textContent = '总有效工时趋势图';
    Charts.line('chart1', r.chart1.labels, r.chart1.values, c);
    Charts.stackedBar('chart2', r.chart2.labels, { main: r.chart2.main, other: r.chart2.other, shared: r.chart2.shared }, c);
  }

  function rowHtml(r) {
    return `<tr>
      <td>${escapeHtml(r.period)}</td><td>${escapeHtml(r.warehouse)}</td><td>${escapeHtml(r.work_type)}</td>
      <td>${escapeHtml(r.customer_name)}</td>
      <td class="num">${r.ship_qty == null ? '-' : Math.round(Number(r.ship_qty))}</td><td class="num">${num(r.cartons)}</td>
      <td class="num">${num(r.main)}</td><td class="num">${num(r.other)}</td><td class="num">${num(r.shared)}</td>
      <td class="num">${num(r.total)}</td><td class="num">${num(r.efficiency)}</td>
      <td class="num">${r.unit_cost == null ? '—' : num(r.unit_cost)}</td>
      <td class="num">${r.doc_cost == null ? '—' : num(r.doc_cost)}</td>
    </tr>`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function num(x) { return (x == null ? 0 : Number(x)).toFixed(3); }
};
