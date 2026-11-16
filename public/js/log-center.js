// 日志中心：一个工厂注册 6 个子页面（5 个业务模块 + 全部日志汇总）
// 路由键 = menus.path = ERP.PAGE_META 键，三者必须一致（见 src/db/menu_seed.sql）
// 页面只读：所有数据来自 /api/logs（后端按 scope 强制锁定 module）
(function () {
  const CONFIG = [
    { page: 'log_customer', module: '客户资料', title: '客户资料日志' },
    { page: 'log_workhours', module: '工时管理', title: '工时管理日志' },
    { page: 'log_logistics', module: '物流报价', title: '物流报价日志' },
    { page: 'log_smartquote', module: '智能测单', title: '智能测单日志' },
    { page: 'log_system', module: '系统/权限', title: '系统/权限日志' },
    { page: 'log_all', module: '', title: '全部日志' },
  ];
  const ACTIONS = ['新增', '修改', '删除', '导入', '历史未知操作'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function pretty(v) {
    if (v == null) return '（无）';
    try { return esc(JSON.stringify(v, null, 2)); } catch (e) { return esc(String(v)); }
  }
  function toast(msg) { if (window.ERP && ERP.toast) ERP.toast(msg); }

  function createPage(cfg) {
    const state = {
      page: 1, pages: 1, pageSize: 20,
      operator: '', dateFrom: '', dateTo: '', action: '', q: '',
      operators: [],
    };
    let host = null;
    let drp = null; // 日期范围组件实例：产出 startDate/endDate，映射为后端 dateFrom/dateTo（后端零改动）
    const $ = (id) => host && host.querySelector('#' + id);

    // render() 每次重建 innerHTML，故每次渲染后重新挂载日期组件
    function initDateRange() {
      const slot = $('dateRangeSlot');
      if (!slot || !window.DateRangePicker) return;
      if (drp && drp.destroy) drp.destroy();
      drp = new DateRangePicker({
        mount: slot,
        mode: 'day',
        startDate: state.dateFrom,
        endDate: state.dateTo,
        onChange: (v) => { state.dateFrom = v.startDate; state.dateTo = v.endDate; }
      });
    }
    function syncDates() {
      if (drp) { const v = drp.getValue(); state.dateFrom = v.startDate; state.dateTo = v.endDate; }
    }

    function query() {
      const p = new URLSearchParams({
        scope: cfg.page, page: String(state.page), pageSize: String(state.pageSize),
      });
      if (state.operator) p.set('operator', state.operator);
      if (state.dateFrom) p.set('dateFrom', state.dateFrom);
      if (state.dateTo) p.set('dateTo', state.dateTo);
      if (state.action) p.set('action', state.action);
      if (state.q) p.set('q', state.q);
      return '/logs?' + p.toString();
    }

    async function loadOperators() {
      try {
        const r = await API.get('/logs/operators?scope=' + encodeURIComponent(cfg.page));
        state.operators = (r && r.data) || [];
      } catch (e) { state.operators = []; }
    }

    async function load() {
      try {
        const r = await API.get(query());
        render(r || {});
      } catch (e) {
        host.innerHTML = '<div class="empty">加载失败：' + esc(e.message) +
          ' <a href="#" id="logRetry">点击重试</a></div>';
        const rt = host.querySelector('#logRetry');
        if (rt) rt.onclick = (ev) => { ev.preventDefault(); load(); };
      }
    }

    function toolbarHtml() {
      const opOpts = ['<option value="">全部操作人</option>'].concat(
        state.operators.map((o) => `<option value="${esc(o.user_name)}" ${state.operator === o.user_name ? 'selected' : ''}>${esc(o.user_name)}（${o.c} 条）</option>`)
      ).join('');
      const actOpts = ['<option value="">全部操作类型</option>'].concat(
        ACTIONS.map((a) => `<option value="${esc(a)}" ${state.action === a ? 'selected' : ''}>${esc(a)}</option>`)
      ).join('');
      return `
        <div class="toolbar log-toolbar">
          <label>操作人<select id="opSel">${opOpts}</select></label>
          <span id="dateRangeSlot"></span>
          <label>操作类型<select id="actSel">${actOpts}</select></label>
          <input id="logQ" placeholder="关键词：目标ID / 详情 / IP / 模块" value="${esc(state.q)}">
          <button id="qryBtn" class="primary">查询</button>
          <button id="resetBtn">重置</button>
          <span class="log-scope-tip">${cfg.module ? '本页仅展示：' + esc(cfg.module) : '跨模块汇总（含其他业务 / 历史未知操作）'}</span>
        </div>`;
    }

    function rowHtml(r) {
      return `<tr>
        <td>${esc(r.created_at)}</td>
        <td>${esc(r.user_name)}</td>
        <td>${esc(r.module)}</td>
        <td><span class="log-badge">${esc(r.action)}</span></td>
        <td>${esc(r.target_id)}</td>
        <td>${esc(r.ip_address) || '—'}</td>
        <td class="ops"><button id="view_${r.id}" class="mini">查看详情</button></td>
      </tr>`;
    }

    function render(r) {
      const rows = r.data || [];
      const total = r.total || 0;
      state.pages = Math.ceil(total / state.pageSize) || 1;
      host.innerHTML = toolbarHtml() + `
        <table class="grid">
          <thead><tr>
            <th>操作时间</th><th>操作人</th><th>所属模块</th><th>操作类型</th>
            <th>目标ID</th><th>IP地址</th><th>操作</th>
          </tr></thead>
          <tbody>${rows.length ? rows.map(rowHtml).join('')
            : '<tr><td colspan="7" class="empty">暂无符合条件的日志</td></tr>'}</tbody>
        </table>
        <div class="pager">
          <button id="prevBtn" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${state.page} / ${state.pages} 页（共 ${total} 条）</span>
          <button id="nextBtn" ${state.page >= state.pages ? 'disabled' : ''}>下一页</button>
        </div>`;
      bind();
      initDateRange();
      rows.forEach((row) => {
        const b = $('view_' + row.id);
        if (b) b.onclick = () => openDetail(row.id);
      });
    }

    function collect() {
      state.operator = $('opSel') ? $('opSel').value : '';
      syncDates(); // 日期由组件同步
      state.action = $('actSel') ? $('actSel').value : '';
      state.q = $('logQ') ? $('logQ').value.trim() : '';
    }

    function bind() {
      $('qryBtn').onclick = () => { collect(); state.page = 1; load(); };
      $('resetBtn').onclick = () => {
        Object.assign(state, { page: 1, operator: '', dateFrom: '', dateTo: '', action: '', q: '' });
        if (drp) drp.setValue({ startDate: '', endDate: '' }, true);
        load();
      };
      $('logQ').onkeydown = (e) => {
        if (e.key === 'Enter') { collect(); state.page = 1; load(); }
      };
      $('opSel').onchange = () => { collect(); state.page = 1; load(); };
      $('actSel').onchange = () => { collect(); state.page = 1; load(); };
      $('prevBtn').onclick = () => { if (state.page > 1) { state.page--; load(); } };
      $('nextBtn').onclick = () => { if (state.page < state.pages) { state.page++; load(); } };
    }

    // ---------- 详情弹窗：修改前后对比 JSON ----------
    async function openDetail(id) {
      let row;
      try {
        const r = await API.get('/logs/' + encodeURIComponent(id) + '?scope=' + encodeURIComponent(cfg.page));
        row = r && r.data;
      } catch (e) { toast('读取日志详情失败：' + e.message); return; }
      if (!row) { toast('日志不存在'); return; }

      let content = null;
      try { content = JSON.parse(row.content || '{}'); } catch (e) { content = { raw: row.content }; }
      const hasPair = content && typeof content === 'object' &&
        (Object.prototype.hasOwnProperty.call(content, 'before') || Object.prototype.hasOwnProperty.call(content, 'after'));

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal wide log-detail">
          <div class="modal-head"><span>日志详情 #${esc(row.id)}</span><button class="close" type="button">×</button></div>
          <div class="modal-body log-modal-body">
            <div class="log-kv log-full">
              <div class="item"><div class="k">操作时间</div><div class="v">${esc(row.created_at)}</div></div>
              <div class="item"><div class="k">操作人</div><div class="v">${esc(row.user_name)}${row.user_id ? '（ID ' + esc(row.user_id) + '）' : ''}</div></div>
              <div class="item"><div class="k">所属模块</div><div class="v">${esc(row.module)}</div></div>
              <div class="item"><div class="k">操作类型</div><div class="v">${esc(row.action)}</div></div>
              <div class="item"><div class="k">目标ID</div><div class="v">${esc(row.target_id)}</div></div>
              <div class="item"><div class="k">IP地址</div><div class="v">${esc(row.ip_address) || '—'}</div></div>
              <div class="item"><div class="k">来源数据表</div><div class="v">${esc(row.table_name)}</div></div>
              <div class="item"><div class="k">原始动作值</div><div class="v">${esc(row.action_raw)}</div></div>
            </div>
            ${hasPair ? `
              <div class="form-section log-full">修改前后对比 JSON</div>
              <div class="log-json-grid log-full">
                <div class="log-json-box"><div class="log-json-title">修改前（before）</div><pre class="log-pre">${pretty(content.before)}</pre></div>
                <div class="log-json-box"><div class="log-json-title">修改后（after）</div><pre class="log-pre">${pretty(content.after)}</pre></div>
              </div>` : ''}
            <div class="form-section log-full">完整操作详情 JSON</div>
            <div class="log-json-box log-full"><pre class="log-pre">${pretty(content)}</pre></div>
          </div>
          <div class="modal-foot"><button class="close" type="button">关闭</button></div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    }

    return function mount(pageHost) {
      host = pageHost;
      loadOperators().then(load);
    };
  }

  window.ERP_PAGES = window.ERP_PAGES || {};
  CONFIG.forEach((c) => { window.ERP_PAGES[c.page] = createPage(c); });
})();
