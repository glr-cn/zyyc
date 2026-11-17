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
    // ★ Bug 修复：原实现用 cols[list.indexOf(o)] 取列样式，当客户数 > 列数(13) 时
    //   indexOf(o) 越界 → cols[idx] 为 undefined → 读 .cls 抛错 → 整个看板加载失败。
    //   正确做法：按「单元格自身下标 ci」取对应列样式。
    const rows = list.map((o) => {
      const cells = [
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
      ];
      return cells
        .map((x, ci) => `<td class="${typeof x === 'string' && x.includes('<span') ? '' : ((cols[ci] && cols[ci].cls) || '')}">${x}</td>`)
        .join('');
    });
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

  function exportExcel() {
    if (!state.data) { toast('请先刷新数据再导出', 'warn'); return; }
    if (!window.XLSX) { toast('Excel 导出库未加载', 'err'); return; }
    const btn = $('dbExportXlsx');
    btn.disabled = true; btn.textContent = '导出中…';

    const d = state.data;
    const shipHeader = ['客户名称','本期单量','上期单量','单量环比','本期发货工时','上期发货工时','工时环比','本期时效','上期时效','时效环比','其他工时','公摊工时','单均成本(元)'];
    const recvHeader = ['客户名称','本期箱数','上期箱数','箱数环比','本期收货工时','上期收货工时','工时环比','本期时效','上期时效','时效环比','其他工时','公摊工时','单箱成本(元)'];
    const intHeader  = ['项目名称','本期数量','上期数量','数量环比','本期工时','上期工时','工时环比','本期时效','上期时效','时效环比','其他工时','单均成本(元)'];
    const logHeader  = ['项目名称','工时单价(元/小时)','本期工时','上期工时','工时环比','本期金额(元)','上期金额(元)','金额环比'];

    const aoaSheet = (header, rows) => [
      [`佐雍云仓数据中心 · 经营看板（${state.warehouse} · ${d.periodLabel}）`],
      header,
      ...rows,
    ];

    const aoaShip = aoaSheet(shipHeader, d.shippingList.map(o => [
      o.customer_name || '', num0(o.cur_ship_qty), num0(o.prev_ship_qty), wowStr(o.ship_qty_wow),
      num3(o.cur_main_hours), num3(o.prev_main_hours), wowStr(o.main_hours_wow),
      o.cur_efficiency ? num3(o.cur_efficiency) : '-',
      o.prev_efficiency ? num3(o.prev_efficiency) : '-', wowStr(o.efficiency_wow),
      num3(o.cur_other_hours), num3(o.cur_shared_hours),
      o.cur_unit_cost ? num3(o.cur_unit_cost) : '-',
    ]));
    const aoaRecv = aoaSheet(recvHeader, d.receivingList.map(o => [
      o.customer_name || '', num0(o.cur_cartons), num0(o.prev_cartons), wowStr(o.cartons_wow),
      num3(o.cur_main_hours), num3(o.prev_main_hours), wowStr(o.main_hours_wow),
      o.cur_efficiency ? num3(o.cur_efficiency) : '-',
      o.prev_efficiency ? num3(o.prev_efficiency) : '-', wowStr(o.efficiency_wow),
      num3(o.cur_other_hours), num3(o.cur_shared_hours),
      o.cur_doc_cost ? num3(o.cur_doc_cost) : '-',
    ]));
    const aoaInt = aoaSheet(intHeader, d.internalList.map(o => [
      o.project || '', num0(o.cur_qty), num0(o.prev_qty), wowStr(o.qty_wow),
      num3(o.cur_main_hours), num3(o.prev_main_hours), wowStr(o.main_hours_wow),
      o.cur_efficiency ? num3(o.cur_efficiency) : '-',
      o.prev_efficiency ? num3(o.prev_efficiency) : '-', wowStr(o.efficiency_wow),
      num3(o.cur_other_hours),
      o.cur_unit_cost ? num3(o.cur_unit_cost) : '-',
    ]));
    const aoaLog = aoaSheet(logHeader, d.logisticsList.map(o => [
      o.project || '', o.cost_rate,
      num3(o.cur_total_hours), num3(o.prev_total_hours), wowStr(o.total_hours_wow),
      num3(o.cur_cost), num3(o.prev_cost), wowStr(o.cost_wow),
    ]));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaShip), '发货组');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaRecv), '收货组');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaInt),  '库内组');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaLog),  '后勤组');
    XLSX.writeFile(wb, '佐雍云仓数据中心_经营看板_' + (d.periodLabel || _todayIso) + '.xlsx');

    btn.disabled = false; btn.textContent = '导出 Excel';
    toast('Excel 已导出', 'ok');
  }

  // ============ 复制为图片 ============
  async function copyImage() {
    const btn = $('dbCopyImg');
    btn.disabled = true; btn.textContent = '生成中…';
    const hideRoot = document.createElement('div');
    hideRoot.style.cssText = 'position:fixed;left:-9999px;top:0;width:1280px;background:#ffffff;';
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
