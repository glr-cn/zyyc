// 经营看板页：四个分组大表格（发货 / 收货 / 库内 / 后勤）
// 数据源：GET /api/dashboard/summary?warehouse=xxx&startDate=xxx&endDate=xxx&periodType=day|week|month
window.ERP_PAGES = window.ERP_PAGES || {};

const DASH_WAREHOUSES = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];

function dashboardPage(host) {
  const c = host;
  const $ = (id) => c.querySelector('#' + id);

  const state = {
    warehouse: DASH_WAREHOUSES[0],
    periodType: 'month',
    startDate: '',
    endDate: '',
    data: null,
  };

  c.innerHTML = `
    <div class="db-wrap">
      <div class="db-filter">
        <div class="db-wh-tabs" id="dbWhTabs">
          ${DASH_WAREHOUSES.map(w => `<button class="db-wh-tab ${w === state.warehouse ? 'active' : ''}" data-wh="${w}">${w}</button>`).join('')}
        </div>
        <div class="db-filter-row">
          <label class="db-f-label">时间维度
            <select id="dbPeriod">
              <option value="day">日</option>
              <option value="week">周</option>
              <option value="month" selected>月</option>
            </select>
          </label>
          <label class="db-f-label">起
            <input type="date" id="dbStart">
          </label>
          <label class="db-f-label">止
            <input type="date" id="dbEnd">
          </label>
          <button id="dbRefresh" class="primary">刷新</button>
          <span id="dbPeriodLabel" class="db-period-label"></span>
        </div>
      </div>

      <div class="db-sections">
        ${sectionHTML('shipping', '发货组')}
        ${sectionHTML('receiving', '收货组')}
        ${sectionHTML('internal', '库内组')}
        ${sectionHTML('logistics', '后勤组')}
      </div>
    </div>
  `;

  // 仓库 tabs
  $('dbWhTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.db-wh-tab');
    if (!btn) return;
    state.warehouse = btn.dataset.wh;
    c.querySelectorAll('.db-wh-tab').forEach(b => b.classList.toggle('active', b === btn));
    load();
  });

  // 时间维度
  $('dbPeriod').value = state.periodType;
  $('dbPeriod').addEventListener('change', (e) => { state.periodType = e.target.value; setDefaultDates(); load(); });
  $('dbStart').addEventListener('change', () => { state.startDate = $('dbStart').value; load(); });
  $('dbEnd').addEventListener('change',   () => { state.endDate   = $('dbEnd').value;   load(); });
  $('dbRefresh').addEventListener('click', load);

  setDefaultDates();
  load();

  function sectionHTML(key, title) {
    return `
      <section class="db-section">
        <h3 class="db-sec-title">${title}</h3>
        <div class="db-sec-content" id="db-${key}"><table class="grid"><tbody><tr><td class="empty">加载中…</td></tr></tbody></table></div>
      </section>
    `;
  }

  function setDefaultDates() {
    const now = new Date();
    const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let s, e;
    if (state.periodType === 'day') { s = e = fmt(now); }
    else if (state.periodType === 'week') {
      const dayOffset = (now.getDay() + 6) % 7;
      const mon = new Date(now); mon.setDate(now.getDate() - dayOffset);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      s = fmt(mon); e = fmt(sun);
    } else {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      s = fmt(first); e = fmt(last);
    }
    state.startDate = s; state.endDate = e;
    $('dbStart').value = s; $('dbEnd').value = e;
  }

  async function load() {
    try {
      const r = await API.get('/dashboard/summary', {
        warehouse: state.warehouse,
        periodType: state.periodType,
        startDate: state.startDate,
        endDate: state.endDate,
      });
      state.data = r;
      $('dbPeriodLabel').textContent =
        `本期：${r.periodLabel}   上期：${r.prevPeriodLabel}`;
      renderShipping(r.shippingList);
      renderReceiving(r.receivingList);
      renderInternal(r.internalList);
      renderLogistics(r.logisticsList);
    } catch (ex) {
      ['shipping','receiving','internal','logistics'].forEach(k => {
        $('db-' + k).innerHTML = `<div class="db-err">加载失败：${ex.message || ex}</div>`;
      });
    }
  }

  // ============ 渲染工具 ============
  function num3(x) {
    if (x == null || x === 0) return '0.000';
    return Number(x).toFixed(3);
  }
  function num0(x) { return (x == null ? 0 : Number(x)).toFixed(0); }
  /**
   * 环比：后端返回 null → 前端渲染为 "-"；
   * 数值 → 渲染为 "12.500%" 并按正负着色（green 正 / red 负 / muted 零）
   */
  function wowCell(v) {
    if (v == null) return `<span class="muted">-</span>`;
    const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted';
    return `<span class="wow ${cls}">${v > 0 ? '+' : ''}${Number(v).toFixed(3)}%</span>`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function dbTableHTML(cols, rows, emptyMsg) {
    const head = cols.map(c => `<th class="${c.cls || ''}">${c.label}</th>`).join('');
    const body = rows.length
      ? rows.map(row => `<tr>${row}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="empty">${emptyMsg}</td></tr>`;
    return `<table class="grid db-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // ============ 发货组 ============
  function renderShipping(list) {
    const cols = [
      { label: '客户名称', cls: 'cust' },
      { label: '本期单量', cls: 'num' },
      { label: '上期单量', cls: 'num' },
      { label: '单量环比', cls: 'num' },
      { label: '本期发货工时', cls: 'num' },
      { label: '上期发货工时', cls: 'num' },
      { label: '工时环比', cls: 'num' },
      { label: '本期时效', cls: 'num' },
      { label: '上期时效', cls: 'num' },
      { label: '时效环比', cls: 'num' },
      { label: '其他工时', cls: 'num' },
      { label: '公摊工时', cls: 'num' },
      { label: '单均成本(元)', cls: 'num' },
    ];
    const rows = list.map(o => [
      escapeHtml(o.customer_name || ''),
      num0(o.cur_ship_qty),
      num0(o.prev_ship_qty),
      wowCell(o.ship_qty_wow),
      num3(o.cur_main_hours),
      num3(o.prev_main_hours),
      wowCell(o.main_hours_wow),
      o.cur_efficiency ? num3(o.cur_efficiency) : '<span class="muted">-</span>',
      o.prev_efficiency ? num3(o.prev_efficiency) : '<span class="muted">-</span>',
      wowCell(o.efficiency_wow),
      num3(o.cur_other_hours),
      num3(o.cur_shared_hours),
      o.cur_unit_cost ? num3(o.cur_unit_cost) : '<span class="muted">-</span>',
    ].map(x => `<td class="${typeof x === 'string' && x.includes('<span') ? '' : (cols[list.indexOf(o)].cls || '')}">${x}</td>`).join(''));
    $('db-shipping').innerHTML = dbTableHTML(cols, rows, '暂无发货数据（所有客户本期/上期均无归档记录）');
  }

  // ============ 收货组 ============
  function renderReceiving(list) {
    const cols = [
      { label: '客户名称', cls: 'cust' },
      { label: '本期箱数', cls: 'num' },
      { label: '上期箱数', cls: 'num' },
      { label: '箱数环比', cls: 'num' },
      { label: '本期收货工时', cls: 'num' },
      { label: '上期收货工时', cls: 'num' },
      { label: '工时环比', cls: 'num' },
      { label: '本期时效', cls: 'num' },
      { label: '上期时效', cls: 'num' },
      { label: '时效环比', cls: 'num' },
      { label: '其他工时', cls: 'num' },
      { label: '公摊工时', cls: 'num' },
      { label: '单箱成本(元)', cls: 'num' },
    ];
    const rows = list.map(o => [
      escapeHtml(o.customer_name || ''),
      num0(o.cur_cartons),
      num0(o.prev_cartons),
      wowCell(o.cartons_wow),
      num3(o.cur_main_hours),
      num3(o.prev_main_hours),
      wowCell(o.main_hours_wow),
      o.cur_efficiency ? num3(o.cur_efficiency) : '<span class="muted">-</span>',
      o.prev_efficiency ? num3(o.prev_efficiency) : '<span class="muted">-</span>',
      wowCell(o.efficiency_wow),
      num3(o.cur_other_hours),
      num3(o.cur_shared_hours),
      o.cur_doc_cost ? num3(o.cur_doc_cost) : '<span class="muted">-</span>',
    ].map(x => `<td>${x}</td>`).join(''));
    $('db-receiving').innerHTML = dbTableHTML(cols, rows, '暂无收货归档数据');
  }

  // ============ 库内组 ============
  function renderInternal(list) {
    const cols = [
      { label: '项目名称', cls: 'cust' },
      { label: '本期数量', cls: 'num' },
      { label: '上期数量', cls: 'num' },
      { label: '数量环比', cls: 'num' },
      { label: '本期工时', cls: 'num' },
      { label: '上期工时', cls: 'num' },
      { label: '工时环比', cls: 'num' },
      { label: '本期时效', cls: 'num' },
      { label: '上期时效', cls: 'num' },
      { label: '时效环比', cls: 'num' },
      { label: '其他工时', cls: 'num' },
      { label: '单均成本(元)', cls: 'num' },
    ];
    const rows = list.map(o => [
      escapeHtml(o.project || ''),
      num0(o.cur_qty),
      num0(o.prev_qty),
      wowCell(o.qty_wow),
      num3(o.cur_main_hours),
      num3(o.prev_main_hours),
      wowCell(o.main_hours_wow),
      o.cur_efficiency ? num3(o.cur_efficiency) : '<span class="muted">-</span>',
      o.prev_efficiency ? num3(o.prev_efficiency) : '<span class="muted">-</span>',
      wowCell(o.efficiency_wow),
      num3(o.cur_other_hours),
      o.cur_unit_cost ? num3(o.cur_unit_cost) : '<span class="muted">-</span>',
    ].map(x => `<td>${x}</td>`).join(''));
    $('db-internal').innerHTML = dbTableHTML(cols, rows, '暂无库内归档数据');
  }

  // ============ 后勤组 ============
  function renderLogistics(list) {
    const cols = [
      { label: '项目名称', cls: 'cust' },
      { label: '工时单价(元/小时)', cls: 'num' },
      { label: '本期工时', cls: 'num' },
      { label: '上期工时', cls: 'num' },
      { label: '工时环比', cls: 'num' },
      { label: '本期金额(元)', cls: 'num' },
      { label: '上期金额(元)', cls: 'num' },
      { label: '金额环比', cls: 'num' },
    ];
    const rows = list.map(o => [
      escapeHtml(o.project || ''),
      o.cost_rate,
      num3(o.cur_total_hours),
      num3(o.prev_total_hours),
      wowCell(o.total_hours_wow),
      num3(o.cur_cost),
      num3(o.prev_cost),
      wowCell(o.cost_wow),
    ].map(x => `<td>${x}</td>`).join(''));
    $('db-logistics').innerHTML = dbTableHTML(cols, rows, '暂无后勤归档数据');
  }
}

window.ERP_PAGES.dashboard = dashboardPage;
