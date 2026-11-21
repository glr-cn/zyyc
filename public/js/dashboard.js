// 经营看板页：四个分组大表格（发货 / 收货 / 库内 / 后勤）
// 数据源：GET /api/dashboard/summary?warehouse=xxx&startDate=xxx&endDate=xxx&periodType=day|week|month
window.ERP_PAGES = window.ERP_PAGES || {};

const DASH_WAREHOUSES = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];
const _pad2 = (n) => String(n).padStart(2, '0');
const _todayIso = (() => { const t = new Date(); return t.getFullYear() + '-' + _pad2(t.getMonth() + 1) + '-' + _pad2(t.getDate()); })();

function dashboardPage(host) {
  const c = host;
  const $ = (id) => c.querySelector('#' + id);

  const state = {
    warehouse: DASH_WAREHOUSES[0],
    periodType: 'day',
    startDate: _todayIso,
    endDate: _todayIso,
    data: null,
    shipCurQty: 0, // 发货组本期总单量（供后勤组「单均成本」计算）
  };

  c.innerHTML = `
    <div class="db-wrap">
      <div class="db-filter">
        <div class="db-wh-tabs" id="dbWhTabs">
          ${DASH_WAREHOUSES.map(w => `<button class="db-wh-tab ${w === state.warehouse ? 'active' : ''}" data-wh="${w}">${w}</button>`).join('')}
        </div>
        <div class="db-filter-row">
          <div id="dbDatePicker" class="db-date-picker"></div>
          <button id="dbRefresh" class="primary">刷新</button>
          <button id="dbExportXlsx" class="db-btn-ghost" title="导出当前看板为 Excel">导出 Excel</button>
          <button id="dbCopyImg" class="db-btn-ghost" title="复制看板为图片到剪贴板">复制为图片</button>
          <span id="dbPeriodLabel" class="db-period-label"></span>
        </div>
      </div>

      <div class="db-sections">
        ${sectionHTML('shipping', '发货组')}
        ${sectionHTML('receiving', '收货组')}
        ${sectionHTML('internal', '库内组 (已公摊到发货组)')}
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

  // ★ 全局高级日期范围选择器（与工时管理页面复用同一组件）
  const picker = new DateRangePicker({
    mount: $('dbDatePicker'),
    mode: state.periodType,
    startDate: state.startDate,
    endDate: state.endDate,
    onChange: (v) => {
      state.periodType = v.mode;
      state.startDate  = v.startDate;
      state.endDate    = v.endDate;
    },
  });

  $('dbRefresh').addEventListener('click', load);
  $('dbExportXlsx').addEventListener('click', exportExcel);
  $('dbCopyImg').addEventListener('click', copyImage);

  // 把 picker 当前值同步到 state（onChange 只会在用户真正操作时触发）
  function syncFromPicker() {
    const v = picker.getValue();
    state.periodType = v.mode;
    state.startDate  = v.startDate;
    state.endDate    = v.endDate;
  }

  syncFromPicker();
  load();

  function sectionHTML(key, title) {
    return `
      <section class="db-section">
        <h3 class="db-sec-title">${title}</h3>
        <div class="db-sec-content" id="db-${key}"><table class="grid"><tbody><tr><td class="empty">加载中…</td></tr></tbody></table></div>
      </section>
    `;
  }

  /** 渲染安全包装：单个分组渲染异常不影响其他分组 */
  function safeRender(groupKey, renderFn, data) {
    try {
      renderFn(data);
    } catch (ex) {
      console.error('[看板] ' + groupKey + ' 渲染异常', ex);
      $('db-' + groupKey).innerHTML = `<div class="db-err">渲染异常：${ex.message || ex}</div>`;
    }
  }

  async function load() {
    // 每次请求前从 picker 取最新值（兜底：用户改了 picker 但还没点 onChange 回调，
    // 或切换仓库时要保留当前日期范围）
    syncFromPicker();
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
      // ★ 各分组独立 try-catch：一处渲染异常不拖垮其他三个
      safeRender('shipping',  renderShipping,  r.shippingList);
      safeRender('receiving', renderReceiving, r.receivingList);
      safeRender('internal',  renderInternal,  r.internalList);
      safeRender('logistics', renderLogistics, r.logisticsList);
    } catch (ex) {
      // API 请求本身失败（网络/鉴权/500）→ 四分组一起显示错误
      console.error('[看板] 数据加载失败', ex);
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
  /** 工时/时效/金额等普通数值：保留 2 位小数（0 → '0.00'） */
  function num2(x) {
    if (x == null || x === 0) return '0.00';
    return Number(x).toFixed(2);
  }
  /** 单量/箱数/数量等计数：仅显示整数（Math.round，不保留小数） */
  function num0(x) { return Math.round(x == null ? 0 : Number(x)).toFixed(0); }

  // ---------- 汇总行计算工具 ----------
  /** 求和：字符串/null 安全转数字 */
  const sumBy = (list, key) => list.reduce((s, o) => s + (Number(o[key]) || 0), 0);
  /** 环比（%）：分母为 0 或空 → null（表格显示 "-"），与后端 wow() 口径一致 */
  const ratioWow = (cur, prev) => (Number(prev) ? ((Number(cur) - Number(prev)) / Number(prev)) * 100 : null);
  /** 安全除法：分母 <= 0 → 0 */
  const divOr = (a, b) => (Number(b) > 0 ? Number(a) / Number(b) : 0);
  /** 加权平均（如单均成本 = Σ(单价×单量)/Σ单量，等价于 总金额/总量，不能直接求和） */
  const weightedBy = (list, valKey, weightKey) => {
    let val = 0, weight = 0;
    list.forEach((o) => {
      const p = Number(o[valKey]) || 0;
      const q = Number(o[weightKey]) || 0;
      val += p * q;
      weight += q;
    });
    return weight > 0 ? val / weight : 0;
  };
  /**
   * 环比：后端返回 null → 前端渲染为 "-"；
   * 数值 → 渲染为 "12.50%" 并按正负着色（green 正 / red 负 / muted 零），保留 2 位小数
   */
  function wowCell(v) {
    if (v == null) return `<span class="wow muted">-</span>`;
    const n = Number(v);
    if (n === 0) return `<span class="wow muted">0.00%</span>`;
    const cls = n > 0 ? 'pos' : 'neg';
    const arrow = n > 0 ? '↑' : '↓';
    return `<span class="wow ${cls}">${arrow} ${Math.abs(n).toFixed(2)}%</span>`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  // 「本期」列强调：列名含"本期"，以及同属本期数据的「其他工时」「公摊工时」→ 追加 hi 类
  // （加粗 + 字号+1 + 极浅主题色背景，见 .db-table .hi 样式）
  function colCls(c) {
    const l = c.label || '';
    const hi = l.includes('本期') || l.includes('其他工时') || l.includes('公摊工时');
    return [c.cls || '', hi ? 'hi' : ''].filter(Boolean).join(' ');
  }
  // 行拼接：按列定义输出 <td>（cust / num / hi 类），保证四张表列样式一致
  function rowHTML(cells, cols) {
    return cells.map((x, ci) => `<td class="${cols[ci] ? colCls(cols[ci]) : ''}">${x}</td>`).join('');
  }
  // 首列（客户/项目名称）：超长省略 + 悬浮显示全名（原生 title，等价 show-overflow-tooltip）
  function custCell(name) {
    const t = escapeHtml(name || '');
    return `<span class="db-cust-ellipsis" title="${t}">${t}</span>`;
  }
  function dbTableHTML(cols, rows, emptyMsg, summary) {
    const head = cols.map(c => `<th class="${colCls(c)}">${c.label}</th>`).join('');
    const body = rows.length
      ? rows.map(row => `<tr>${row}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="empty">${emptyMsg}</td></tr>`;
    // 汇总行：第一格为分组标题（加粗+底色），其余按列居中；无数据时不渲染全 0 的汇总
    // summary[i+1] 与 cols[i+1] 一一对应，「本期」列同样加 hi
    const foot = (summary && rows.length)
      ? `<tfoot><tr class="db-summary"><td class="db-summary-title">${summary[0]}</td>${summary.slice(1).map((x, i) => `<td class="${colCls(cols[i + 1] || {})}">${x}</td>`).join('')}</tr></tfoot>`
      : '';
    return `<table class="grid db-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
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
    // ★ Bug 修复：原实现用 cols[list.indexOf(o)] 取列样式，当客户数 > 列数(13) 时
    //   indexOf(o) 越界 → cols[idx] 为 undefined → 读 .cls 抛错 → 整个看板加载失败。
    //   正确做法：按「单元格自身下标 ci」取对应列样式。
    const rows = list.map((o) => {
      const cells = [
        custCell(o.customer_name),
        num0(o.cur_ship_qty),
        num0(o.prev_ship_qty),
        wowCell(o.ship_qty_wow),
        num2(o.cur_main_hours),
        num2(o.prev_main_hours),
        wowCell(o.main_hours_wow),
        o.cur_efficiency ? num2(o.cur_efficiency) : '<span class="muted">-</span>',
        o.prev_efficiency ? num2(o.prev_efficiency) : '<span class="muted">-</span>',
        wowCell(o.efficiency_wow),
        num2(o.cur_other_hours),
        num2(o.cur_shared_hours),
        o.cur_unit_cost ? num3(o.cur_unit_cost) : '<span class="muted">-</span>',
      ];
      return rowHTML(cells, cols);
    });
    const curQty = sumBy(list, 'cur_ship_qty');
    state.shipCurQty = curQty; // 供后勤组「后勤单均成本」计算（renderLogistics 在其后调用）
    const prevQty = sumBy(list, 'prev_ship_qty');
    const curMain = sumBy(list, 'cur_main_hours');
    const prevMain = sumBy(list, 'prev_main_hours');
    const curEff = divOr(curQty, curMain);   // 时效 = 单量 / 主工时（与后端一致）
    const prevEff = divOr(prevQty, prevMain);
    const summary = [
      '发货汇总',
      num0(curQty),
      num0(prevQty),
      wowCell(ratioWow(curQty, prevQty)),
      num2(curMain),
      num2(prevMain),
      wowCell(ratioWow(curMain, prevMain)),
      curMain > 0 && curQty > 0 ? num2(curEff) : '<span class="muted">-</span>',
      prevMain > 0 && prevQty > 0 ? num2(prevEff) : '<span class="muted">-</span>',
      wowCell(ratioWow(curEff, prevEff)),
      num2(sumBy(list, 'cur_other_hours')),
      num2(sumBy(list, 'cur_shared_hours')),
      curQty > 0 ? num3(weightedBy(list, 'cur_unit_cost', 'cur_ship_qty')) : '<span class="muted">-</span>',
    ];
    $('db-shipping').innerHTML = dbTableHTML(cols, rows, '暂无发货数据（所有客户本期/上期均无归档记录）', summary);
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
    const rows = list.map(o => rowHTML([
      custCell(o.customer_name),
      num0(o.cur_cartons),
      num0(o.prev_cartons),
      wowCell(o.cartons_wow),
      num2(o.cur_main_hours),
      num2(o.prev_main_hours),
      wowCell(o.main_hours_wow),
      o.cur_efficiency ? num2(o.cur_efficiency) : '<span class="muted">-</span>',
      o.prev_efficiency ? num2(o.prev_efficiency) : '<span class="muted">-</span>',
      wowCell(o.efficiency_wow),
      num2(o.cur_other_hours),
      num2(o.cur_shared_hours),
      o.cur_doc_cost ? num3(o.cur_doc_cost) : '<span class="muted">-</span>',
    ], cols));
    const curCartons = sumBy(list, 'cur_cartons');
    const prevCartons = sumBy(list, 'prev_cartons');
    const curMain = sumBy(list, 'cur_main_hours');
    const prevMain = sumBy(list, 'prev_main_hours');
    const curEff = divOr(curCartons, curMain);   // 时效 = 箱数 / 主工时
    const prevEff = divOr(prevCartons, prevMain);
    const summary = [
      '收货汇总',
      num0(curCartons),
      num0(prevCartons),
      wowCell(ratioWow(curCartons, prevCartons)),
      num2(curMain),
      num2(prevMain),
      wowCell(ratioWow(curMain, prevMain)),
      curMain > 0 && curCartons > 0 ? num2(curEff) : '<span class="muted">-</span>',
      prevMain > 0 && prevCartons > 0 ? num2(prevEff) : '<span class="muted">-</span>',
      wowCell(ratioWow(curEff, prevEff)),
      num2(sumBy(list, 'cur_other_hours')),
      num2(sumBy(list, 'cur_shared_hours')),
      curCartons > 0 ? num3(weightedBy(list, 'cur_doc_cost', 'cur_cartons')) : '<span class="muted">-</span>',
    ];
    $('db-receiving').innerHTML = dbTableHTML(cols, rows, '暂无收货归档数据', summary);
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
    const rows = list.map(o => rowHTML([
      custCell(o.project),
      num0(o.cur_qty),
      num0(o.prev_qty),
      wowCell(o.qty_wow),
      num2(o.cur_main_hours),
      num2(o.prev_main_hours),
      wowCell(o.main_hours_wow),
      o.cur_efficiency ? num2(o.cur_efficiency) : '<span class="muted">-</span>',
      o.prev_efficiency ? num2(o.prev_efficiency) : '<span class="muted">-</span>',
      wowCell(o.efficiency_wow),
      num2(o.cur_other_hours),
      o.cur_unit_cost ? num3(o.cur_unit_cost) : '<span class="muted">-</span>',
    ], cols));
    const curQty = sumBy(list, 'cur_qty');
    const prevQty = sumBy(list, 'prev_qty');
    const curMain = sumBy(list, 'cur_main_hours');
    const prevMain = sumBy(list, 'prev_main_hours');
    const curEff = divOr(curQty, curMain);   // 时效 = 数量 / 主工时
    const prevEff = divOr(prevQty, prevMain);
    const summary = [
      '库内汇总',
      num0(curQty),
      num0(prevQty),
      wowCell(ratioWow(curQty, prevQty)),
      num2(curMain),
      num2(prevMain),
      wowCell(ratioWow(curMain, prevMain)),
      curMain > 0 && curQty > 0 ? num2(curEff) : '<span class="muted">-</span>',
      prevMain > 0 && prevQty > 0 ? num2(prevEff) : '<span class="muted">-</span>',
      wowCell(ratioWow(curEff, prevEff)),
      num2(sumBy(list, 'cur_other_hours')),
      curQty > 0 ? num3(weightedBy(list, 'cur_unit_cost', 'cur_qty')) : '<span class="muted">-</span>',
    ];
    $('db-internal').innerHTML = dbTableHTML(cols, rows, '暂无库内归档数据', summary);
  }

  // ============ 后勤组 ============
  function renderLogistics(list) {
    const cols = [
      { label: '项目名称', cls: 'cust' },
      { label: '工时单价(元/小时)', cls: 'num' },
      { label: '本期工时', cls: 'num' },
      { label: '上期工时', cls: 'num' },
      { label: '工时环比', cls: 'num' },
      { label: '发货总单量', cls: 'num' },
      { label: '后勤单均成本(元/单)', cls: 'num' },
    ];
    // 发货组本期总单量（来自发货组汇总）；为 0 时显示 "-"，避免除零产生 NaN/Infinity
    const shipQty = state.shipCurQty || 0;
    // 行金额 = 工时单价 × 本期工时（金额列已从 UI 移除，但底层数据仍按行计算）
    const rowAmt = (o) => (Number(o.cost_rate) || 0) * (Number(o.cur_total_hours) || 0);
    const rows = list.map(o => rowHTML([
      custCell(o.project),
      num2(o.cost_rate),
      num2(o.cur_total_hours),
      num2(o.prev_total_hours),
      wowCell(o.total_hours_wow),
      num0(shipQty),
      shipQty > 0 ? num3(rowAmt(o) / shipQty) : '<span class="muted">-</span>',
    ], cols));
    const curHours = sumBy(list, 'cur_total_hours');
    const prevHours = sumBy(list, 'prev_total_hours');
    // 后勤组本期总金额 = Σ(每行工时单价 × 本期工时)
    const curAmt = list.reduce((s, o) => s + rowAmt(o), 0);
    // 工时单价是比率，不能求和：按「总金额 / 总工时」加权，无工时显示 "-"
    const avgRate = (curHours > 0 && curAmt > 0) ? curAmt / curHours : null;
    const summary = [
      '后勤汇总',
      avgRate == null ? '<span class="muted">-</span>' : num2(avgRate),
      num2(curHours),
      num2(prevHours),
      wowCell(ratioWow(curHours, prevHours)),
      // 汇总行「发货总单量」同各行口径：直接取发货组汇总，不累加
      num0(shipQty),
      // 汇总行单均成本 = 汇总金额 / 发货组总单量（3 位小数，不累加各行的单均成本）
      shipQty > 0 ? num3(curAmt / shipQty) : '<span class="muted">-</span>',
    ];
    $('db-logistics').innerHTML = dbTableHTML(cols, rows, '暂无后勤归档数据', summary);
  }

  // ============ Toast 工具 ============
  function toast(msg, kind) {
    kind = kind || 'info';
    const el = document.createElement('div');
    el.className = 'db-toast db-toast-' + kind;
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); }, 2200);
  }

  // ============ 导出 Excel ============
  function wowStr(v) {
    if (v == null) return '-';
    const n = Number(v);
    if (n === 0) return '0.00%';
    return (n > 0 ? '↑ ' : '↓ ') + Math.abs(n).toFixed(2) + '%';
  }

  async function exportExcel() {
    if (!state.data) { toast('请先刷新数据再导出', 'warn'); return; }
    // ★ 懒加载 SheetJS：点导出时才拉取（首屏不加载 430KB 依赖）
    if (!window.XLSX) {
      if (!(window.ERP && window.ERP.ensureXlsx)) { toast('导出组件不可用，请刷新页面重试', 'err'); return; }
      toast('正在加载导出组件…');
      try {
        await window.ERP.ensureXlsx();
      } catch (e) {
        toast('导出组件加载失败，请检查网络后重试', 'err');
        return;
      }
      if (!window.XLSX) { toast('Excel 导出库未加载', 'err'); return; }
    }
    const btn = $('dbExportXlsx');
    btn.disabled = true; btn.textContent = '导出中…';

    const d = state.data;
    const shipHeader = ['客户名称','本期单量','上期单量','单量环比','本期发货工时','上期发货工时','工时环比','本期时效','上期时效','时效环比','其他工时','公摊工时','单均成本(元)'];
    const recvHeader = ['客户名称','本期箱数','上期箱数','箱数环比','本期收货工时','上期收货工时','工时环比','本期时效','上期时效','时效环比','其他工时','公摊工时','单箱成本(元)'];
    const intHeader  = ['项目名称','本期数量','上期数量','数量环比','本期工时','上期工时','工时环比','本期时效','上期时效','时效环比','其他工时','单均成本(元)'];
    const logHeader  = ['项目名称','工时单价(元/小时)','本期工时','上期工时','工时环比','发货总单量','后勤单均成本(元/单)'];

    const aoaSheet = (header, rows) => [
      [`佐雍云仓数据中心 · 经营看板（${state.warehouse} · ${d.periodLabel}）`],
      header,
      ...rows,
    ];

    const aoaShip = aoaSheet(shipHeader, d.shippingList.map(o => [
      o.customer_name || '', num0(o.cur_ship_qty), num0(o.prev_ship_qty), wowStr(o.ship_qty_wow),
      num2(o.cur_main_hours), num2(o.prev_main_hours), wowStr(o.main_hours_wow),
      o.cur_efficiency ? num2(o.cur_efficiency) : '-',
      o.prev_efficiency ? num2(o.prev_efficiency) : '-', wowStr(o.efficiency_wow),
      num2(o.cur_other_hours), num2(o.cur_shared_hours),
      o.cur_unit_cost ? num3(o.cur_unit_cost) : '-',
    ]));
    const aoaRecv = aoaSheet(recvHeader, d.receivingList.map(o => [
      o.customer_name || '', num0(o.cur_cartons), num0(o.prev_cartons), wowStr(o.cartons_wow),
      num2(o.cur_main_hours), num2(o.prev_main_hours), wowStr(o.main_hours_wow),
      o.cur_efficiency ? num2(o.cur_efficiency) : '-',
      o.prev_efficiency ? num2(o.prev_efficiency) : '-', wowStr(o.efficiency_wow),
      num2(o.cur_other_hours), num2(o.cur_shared_hours),
      o.cur_doc_cost ? num3(o.cur_doc_cost) : '-',
    ]));
    const aoaInt = aoaSheet(intHeader, d.internalList.map(o => [
      o.project || '', num0(o.cur_qty), num0(o.prev_qty), wowStr(o.qty_wow),
      num2(o.cur_main_hours), num2(o.prev_main_hours), wowStr(o.main_hours_wow),
      o.cur_efficiency ? num2(o.cur_efficiency) : '-',
      o.prev_efficiency ? num2(o.prev_efficiency) : '-', wowStr(o.efficiency_wow),
      num2(o.cur_other_hours),
      o.cur_unit_cost ? num3(o.cur_unit_cost) : '-',
    ]));
    // 后勤组：单均成本 = 行金额(单价×工时) / 发货组本期总单量（与页面同口径；总单量为 0 → '-'）
    const logShipQty = d.shippingList.reduce((s, o) => s + (Number(o.cur_ship_qty) || 0), 0);
    const logAmt = (o) => (Number(o.cost_rate) || 0) * (Number(o.cur_total_hours) || 0);
    const aoaLog = aoaSheet(logHeader, d.logisticsList.map(o => [
      o.project || '', num2(o.cost_rate),
      num2(o.cur_total_hours), num2(o.prev_total_hours), wowStr(o.total_hours_wow),
      num0(logShipQty),
      logShipQty > 0 ? num3(logAmt(o) / logShipQty) : '-',
    ]));

    const wb = XLSX.utils.book_new();

    // ★ 列宽/行高配置：客户/项目名完整展示(wch=25)，数值列紧凑(wch=12)
    // XLSX 社区版不支持字体/底色/对齐，仅 !cols / !rows 可用
    const fmtSheet = (aoa, name, nameColW, numColW) => {
      const cols = aoa[1].map((_, i) => ({ wch: i === 0 ? nameColW : numColW }));
      const rows = [];
      rows[0] = { hpt: 28 };  // 标题行（第 1 行）稍大
      rows[1] = { hpt: 22 };  // 表头行紧凑
      for (let r = 2; r < aoa.length; r++) rows[r] = { hpt: 18 }; // 数据行紧凑
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = cols;
      ws['!rows'] = rows;
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    fmtSheet(aoaShip, '发货组', 25, 12);
    fmtSheet(aoaRecv, '收货组', 25, 12);
    fmtSheet(aoaInt,  '库内组', 25, 12);
    fmtSheet(aoaLog,  '后勤组', 20, 12);
    XLSX.writeFile(wb, '佐雍云仓数据中心_经营看板_' + (d.periodLabel || _todayIso) + '.xlsx');

    btn.disabled = false; btn.textContent = '导出 Excel';
    toast('Excel 已导出', 'ok');
  }

  // ============ 复制为图片 ============
  async function copyImage() {
    const btn = $('dbCopyImg');
    btn.disabled = true; btn.textContent = '生成中…';
    const hideRoot = document.createElement('div');
    // ⚠️ 不能用 left:-9999px 屏外定位：html-to-image 会把该样式克隆进 SVG，
    // 内容被画到画布外 → 导出纯白空白图。改为 z-index:-10000 藏到页面内容后面
    //（克隆节点在自己的 SVG 里正常落在画布内，实测非空白；page 上被内容遮挡不可见）。
    hideRoot.style.cssText = 'position:fixed;left:0;top:0;z-index:-10000;pointer-events:none;background:#ffffff;';
    try {
      if (!window.htmlToImage) throw new Error('html-to-image 库未加载');
      if (!state.data) { toast('请先刷新数据再截图', 'warn'); return; }

      // 1) 构造动态标题
      const d = state.data;
      let periodText;
      if (state.periodType === 'day') {
        periodText = state.startDate;
      } else if (state.periodType === 'week') {
        // 用 d.periodLabel 里已有的周 label，没有就拼 start~end
        periodText = d.periodLabel && /第\d+周/.test(d.periodLabel) ? d.periodLabel
                   : (state.startDate + ' ~ ' + state.endDate);
      } else {
        periodText = d.periodLabel || state.startDate.slice(0, 7);
      }

      const title = document.createElement('div');
      title.style.cssText =
        'text-align:center;font-size:24px;font-weight:bold;margin-bottom:20px;' +
        'font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#111;line-height:1.5;';
      title.textContent = state.warehouse + '    周期：' + periodText;

      // 2) 克隆四个表格区（.db-sections），原 DOM 完全不动
      const sections = c.querySelector('.db-sections');
      if (!sections) throw new Error('找不到 .db-sections');
      const clone = sections.cloneNode(true);
      // 确保 clone 里没有 hover 残留（概率极低，保险）
      clone.querySelectorAll('tr').forEach(tr => tr.style.background = '');

      hideRoot.appendChild(title);
      hideRoot.appendChild(clone);
      document.body.appendChild(hideRoot);

      // 3) 截图隐藏容器
      const blob = await window.htmlToImage.toBlob(hideRoot, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: '#ffffff',
        width: hideRoot.scrollWidth,
        height: hideRoot.scrollHeight,
      });

      // 4) 写剪贴板 或 降级下载
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('图片已复制到剪贴板，可直接粘贴发送', 'ok');
      } else {
        console.warn('[看板] Clipboard API 不可用（需要 HTTPS），降级为下载图片');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '佐雍云仓数据中心_' + state.warehouse + '_' + (d.periodLabel || _todayIso) + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        toast('已下载为 PNG（非 HTTPS 环境无法写剪贴板）', 'warn');
      }
    } catch (ex) {
      console.error(ex);
      toast('生成图片失败：' + (ex.message || ex), 'err');
    } finally {
      if (hideRoot.parentNode) hideRoot.parentNode.removeChild(hideRoot);
      btn.disabled = false; btn.textContent = '复制为图片';
    }
  }
}

window.ERP_PAGES.dashboard = dashboardPage;
// 看板下「工时汇总」子菜单 → 复用同一渲染函数
window.ERP_PAGES.dash_wh_summary = dashboardPage;
// 工时模块下「工时汇总」(analytics) → 也复用同一渲染函数，三处入口数据100%一致
window.ERP_PAGES.analytics = dashboardPage;
