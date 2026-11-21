// 日志中心：一个工厂注册 6 个子页面（5 个业务模块 + 全部日志汇总）
// 路由键 = menus.path = ERP.PAGE_META 键，三者必须一致（见 src/db/menu_seed.sql）
// 页面只读：所有数据来自 /api/logs（后端按 scope 强制锁定 module）
//
// 【可读性约定】日志中心面向新手：展示"谁、什么时候、做了什么"，
// 技术字段（原始动作值 / 数据表 / JSON）一律收进"技术信息（选看）"折叠区。
(function () {
  const CONFIG = [
    { page: 'log_customer', module: '客户资料', title: '客户资料日志' },
    { page: 'log_workhours', module: '工时管理', title: '工时管理日志' },
    { page: 'log_logistics', module: '物流报价', title: '物流报价日志' },
    { page: 'log_smartquote', module: '智能测单', title: '智能测单日志' },
    { page: 'log_system', module: '系统/权限', title: '系统/权限日志' },
    { page: 'log_all', module: '', title: '全部日志' },
  ];
  // 与后端 v_audit_logs 视图、/api/logs 的 action 参数保持一致
  const ACTIONS = ['新增', '修改', '删除', '导入', '历史未知操作'];

  // 操作类型 → 图标 + 给新手看的大白话解释
  const ACTION_INFO = {
    '新增': { icon: '➕', hint: '新建了一条记录' },
    '修改': { icon: '✏️', hint: '改动了已有记录的内容' },
    '删除': { icon: '🗑️', hint: '删除了一条记录（不可恢复）' },
    '导入': { icon: '📥', hint: '批量把数据导入系统' },
    '导出': { icon: '📤', hint: '把数据下载或备份到本地' },
    '提交归档': { icon: '📦', hint: '把单据提交并归档' },
    '撤回': { icon: '↩️', hint: '撤回了之前提交的内容' },
    '归档': { icon: '🗄️', hint: '把记录归档保存' },
    '历史未知操作': { icon: '❓', hint: '早期版本留下的记录，当时没有保存操作名称' },
  };

  // 常见"操作对象"代号 → 人话（未收录的代号原样显示，绝不编造）
  const TARGET_LABELS = {
    db_export: '整库备份文件',
    sort_order_migration: '客户排序整理',
    sort_order_rollback: '客户排序回滚',
    sort_order_migration_failed: '客户排序整理（失败）',
  };

  // 详情 JSON 里常见字段名 → 中文说明
  const CONTENT_KEY_LABELS = {
    op: '操作代码', operator: '操作人', file: '生成的文件名',
    error: '错误信息', timestamp: '操作时间', snapshotRows: '备份行数',
    sortListSize: '排序名单条数', matched: '匹配到行数', unmatched: '未匹配行数',
    touchedCustomers: '影响的客户数', addedColumns: '新增字段',
    autoRollback: '自动回滚结果', cleared: '清理结果', dir: '目录位置',
    batchId: '导入批次号', reason: '原因', status: '状态', count: '数量',
  };

  // 修改前后对比表里常见字段名 → 中文说明
  const FIELD_LABELS = {
    customer_name: '客户名称', name: '名称', phone: '电话', address: '地址',
    sort_order: '排序号', status: '状态', remark: '备注', waybill_type: '电子面单类型',
    order_no: '订单号', amount: '金额', quantity: '数量', price: '单价',
    username: '账号', display_name: '姓名', role_name: '角色',
  };

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
  function actionInfo(action) { return ACTION_INFO[action] || { icon: '📌', hint: '执行了一项操作' }; }
  function targetLabel(id) { return TARGET_LABELS[id] || id || '（无）'; }
  function fieldLabel(k) { return FIELD_LABELS[k] || k; }

  // 给新手的一句话总结：谁 + 什么时候 + 做了什么 + 对象是什么
  function summaryOf(row) {
    const a = actionInfo(row.action);
    const target = targetLabel(row.target_id);
    let text = esc(row.created_at || '未知时间') + '，' + esc(row.user_name || '未知用户') +
      ' 执行了「' + esc(row.action || '未知操作') + '」操作';
    if (target && target !== '（无）') text += '，对象是「' + esc(target) + '」';
    return { icon: a.icon, text: text + '。', hint: a.hint };
  }

  // 把 {a:{b:1}} 摊平成 [['a.b', 1]]，便于做修改前后对比表
  function flatten(obj, prefix) {
    const out = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...flatten(v, key));
      } else {
        out.push([key, v == null ? '（空）' : (typeof v === 'object' ? JSON.stringify(v) : String(v))]);
      }
    }
    return out;
  }

  function changesHtml(before, after) {
    const b = new Map(flatten(before));
    const a = new Map(flatten(after));
    const keys = Array.from(new Set([...b.keys(), ...a.keys()]));
    if (!keys.length) return '<div class="log-note">这条记录没有保存"修改前/修改后"的内容。</div>';
    return `<table class="log-changes"><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody>` +
      keys.map((k) => {
        const old = b.get(k), now = a.get(k);
        const changed = old !== now;
        return `<tr class="${changed ? 'changed' : ''}"><td>${esc(fieldLabel(k))}</td>` +
          `<td>${esc(old == null ? '—' : old)}</td><td>${esc(now == null ? '—' : now)}</td></tr>`;
      }).join('') + '</tbody></table>';
  }

  // 详情正文里的"操作详情"：把 JSON 的键翻译成中文Value，原始 JSON 收进折叠区
  function contentHtml(content, hasPair) {
    const obj = (content && typeof content === 'object' && !Array.isArray(content)) ? content : null;
    const rows = [];
    if (obj) {
      for (const [k, v] of Object.entries(obj)) {
        if (hasPair && (k === 'before' || k === 'after')) continue;
        const label = CONTENT_KEY_LABELS[k] || k;
        const val = (v && typeof v === 'object') ? JSON.stringify(v) : (v == null ? '（无）' : String(v));
        rows.push(`<div class="log-detail-field"><span class="k">${esc(label)}</span><span class="v">${esc(val)}</span></div>`);
      }
    }
    const body = rows.length ? rows.join('')
      : '<div class="log-note">这条记录没有额外的操作详情。</div>';
    return `<div class="log-detail-fields">${body}</div>` +
      `<details class="log-raw"><summary>查看完整原始数据（技术内容，一般不用看）</summary>` +
      `<pre class="log-pre">${pretty(content)}</pre></details>`;
  }

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
        ACTIONS.map((a) => `<option value="${esc(a)}" ${state.action === a ? 'selected' : ''}>${actionInfo(a).icon} ${esc(a)}</option>`)
      ).join('');
      return `
        <div class="toolbar log-toolbar">
          <label>操作人<select id="opSel">${opOpts}</select></label>
          <span id="dateRangeSlot"></span>
          <label>操作类型<select id="actSel">${actOpts}</select></label>
          <input id="logQ" placeholder="关键词：操作对象 / 详情 / IP / 模块" value="${esc(state.q)}">
          <button id="qryBtn" class="primary">查询</button>
          <button id="resetBtn">重置</button>
          <span class="log-scope-tip">${cfg.module ? '本页仅展示：' + esc(cfg.module) : '跨模块汇总（含其他业务 / 历史未知操作）'}</span>
        </div>`;
    }

    function rowHtml(r) {
      const a = actionInfo(r.action);
      return `<tr>
        <td>${esc(r.created_at)}</td>
        <td>${esc(r.user_name)}</td>
        <td>${esc(r.module)}</td>
        <td><span class="log-badge" title="${esc(a.hint)}">${a.icon} ${esc(r.action)}</span></td>
        <td>${esc(targetLabel(r.target_id))}</td>
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
            <th title="这次操作针对的记录或文件">操作对象</th><th title="操作人当时使用的网络地址">IP地址</th><th>操作</th>
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

    // ---------- 详情弹窗：先看"一句话说明"，技术信息按需展开 ----------
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
      const sum = summaryOf(row);

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal wide log-detail" role="dialog" aria-label="日志详情">
          <div class="modal-head"><span>日志详情 <small class="log-id">#${esc(row.id)}</small></span><button class="close" type="button">×</button></div>
          <div class="modal-body log-modal-body">
            <div class="log-summary">
              <div class="log-summary-icon">${sum.icon}</div>
              <div class="log-summary-text">
                <div class="log-summary-main">${sum.text}</div>
                <div class="log-summary-hint">这是什么意思：${esc(sum.hint)}</div>
              </div>
            </div>
            <div class="log-tip-bar">看不懂的英文和技术字段已帮您收起，需要核对时可展开下方「技术信息」。</div>

            <div class="form-section log-full">基本信息</div>
            <div class="log-kv log-full">
              <div class="item"><div class="k">操作时间</div><div class="v">${esc(row.created_at)}</div></div>
              <div class="item"><div class="k">操作人</div><div class="v">${esc(row.user_name)}${row.user_id ? '（编号 ' + esc(row.user_id) + '）' : ''}</div></div>
              <div class="item"><div class="k">所属模块</div><div class="v">${esc(row.module)}</div></div>
              <div class="item"><div class="k">操作类型</div><div class="v">${actionInfo(row.action).icon} ${esc(row.action)}</div></div>
              <div class="item"><div class="k" title="这次操作针对的记录或文件">操作对象</div><div class="v">${esc(targetLabel(row.target_id))}</div></div>
              <div class="item"><div class="k" title="操作人当时使用的网络地址">IP地址</div><div class="v">${esc(row.ip_address) || '—'}</div></div>
            </div>

            <details class="log-tech">
              <summary>技术信息（给管理员排查用，一般不用看）</summary>
              <div class="log-kv log-full">
                <div class="item"><div class="k">日志编号</div><div class="v">#${esc(row.id)}</div></div>
                <div class="item"><div class="k">用户编号</div><div class="v">${esc(row.user_id) || '—'}</div></div>
                <div class="item"><div class="k">来源数据表</div><div class="v">${esc(row.table_name)}</div></div>
                <div class="item"><div class="k">原始动作值</div><div class="v">${esc(row.action_raw)}</div></div>
              </div>
            </details>

            <div class="form-section log-full">这次操作做了什么</div>
            ${contentHtml(content, hasPair)}

            ${hasPair ? `
              <div class="form-section log-full">具体改了哪些内容（修改前 → 修改后）</div>
              <div class="log-full">${changesHtml(content.before, content.after)}</div>` : ''}
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
