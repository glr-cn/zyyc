// 工时管理页（按仓库拆分）：每个仓库一个独立页面实例
// - 仓库不再由页内 Tabs 切换，而是由左侧菜单「工时 → 录入 → 各仓工时管理」路由锁定
// - 页面内保留 发货/收货/库内/后勤 四个业务类型 Tabs
// - 查询与新增弹窗的归属仓库严格锁定为当前页面配置的仓库
window.ERP_PAGES = window.ERP_PAGES || {};

// 页面 id → 仓库映射（与左侧菜单「工时 → 录入」子项一一对应）
const WH_PAGE_CONFIG = {
  wh_lh: '龙湖仓',
  wh_jx: '佳新仓',
  wh_sy: '速远仓',
  wh_ky: '开元仓',
};

function createWorkhoursPage(warehouse) {
  return function (host) {
    const c = host;
    const $ = (id) => c.querySelector("#" + id);

    const WORK_TYPES = ['发货', '收货', '库内', '后勤'];
    const UNITS = ['单', '件', '箱']; // 标准单位（与后端 svc.UNITS 一致；历史托/公斤仅校验放行不再出现在下拉）
    const PROJECT_OPTIONS = {
      库内: ['上架', '补货', '调拨', '退件', '盘点', '理货', '油叉', '转运', '卫生', '顶班'],
      后勤: ['制单人员', '管理人员', '其他'],
    };

    // 列配置（与后端 TYPE_CONFIG.columns 对应）
    const COLUMNS = {
      发货: [
        { key: 'date', label: '日期' }, { key: 'customer_name', label: '客户名称' }, { key: 'unit', label: '单位' },
        { key: 'ship_orders', label: '发货单量', num: true, trend: true }, { key: 'main_hours', label: '主工时', num: true, trend: true },
        { key: 'efficiency', label: '时效', num: true, trend: true }, { key: 'other_hours', label: '其他工时', num: true },
        { key: 'remark', label: '备注' },
        { key: 'submitter', label: '提交人' },
        // 已隐藏冗余列：shared_hours 公摊工时 / total_hours 总工时 / unit_cost 单均成本（仅展示层隐藏，数据与计算逻辑不变）
      ],
      收货: [
        { key: 'date', label: '日期' }, { key: 'customer_name', label: '客户名称' }, { key: 'unit', label: '单位' },
        { key: 'cartons', label: '箱数', num: true }, { key: 'efficiency', label: '时效', num: true },
        { key: 'tons', label: '吨', num: true }, { key: 'cubic', label: '方', num: true }, { key: 'pallets', label: '托盘', num: true },
        { key: 'main_hours', label: '主工时', num: true }, { key: 'other_hours', label: '其他工时', num: true },
        { key: 'remark', label: '备注' }, { key: 'doc_cost', label: '单据成本', num: true },
        { key: 'submitter', label: '提交人' },
      ],
      库内: [
        { key: 'date', label: '日期' }, { key: 'project', label: '项目' }, { key: 'unit', label: '单位' },
        { key: 'main_hours', label: '主工时', num: true }, { key: 'other_hours', label: '其他工时', num: true },
        { key: 'remark', label: '备注' }, { key: 'total_hours', label: '总工时', num: true },
        { key: 'submitter', label: '提交人' },
      ],
      后勤: [
        { key: 'date', label: '日期' }, { key: 'project', label: '项目' },
        { key: 'main_hours', label: '主工时', num: true }, { key: 'other_hours', label: '其他工时', num: true },
        { key: 'remark', label: '备注' }, { key: 'total_hours', label: '总工时', num: true },
        { key: 'submitter', label: '提交人' },
      ],
    };

    // 仓库由路由（页面配置）锁定，页内不可切换
    // status：pending 未归档（默认）/ archived 已归档；checked：勾选归档用
    // lastRows：当前页数据（供行内直编与局部重绘）
    const state = { warehouse: warehouse, workType: '发货', trend: 'month', status: 'pending', page: 1, pageSize: 20, q: '', dateFrom: '', dateTo: '', checked: new Set(), lastRows: [], lastTotal: 0, isSuper: false, isAdmin: false, meName: '' };

    function todayStr() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // 超级管理员判断（原生 JS 无 v-if，用条件渲染控制「删除」按钮显隐）
    // 与 smart-quote.js 口径一致；仅作前端展示控制，后端 /force 接口二次强校验
    function isSuperAdmin() {
      try {
        const u = JSON.parse(localStorage.getItem('erp_user') || '{}');
        return u.role_code === 'super_admin' || u.role === '超级管理员';
      } catch (e) { return false; }
    }

    // 实时角色校验（铁律 3：前端按真实角色动态渲染删除按钮，严禁越权）：
    // localStorage.erp_user 可能是过期快照（角色迁移/换号未重登），直接读它会造成
    // 「真超管看不到删除按钮」或「假超管看到删除按钮」两种事故。故以 /api/auth/me
    // 返回的库内最新 role_code 为准（每次页面加载刷新一次，结果缓存于 state.isSuper）。
    async function refreshRole() {
      try {
        const me = await API.get('/auth/me');
        const u = (me && me.user) || {};
        const code = u.role_code;
        state.isSuper = code === 'super_admin';
        state.isAdmin = code === 'super_admin' || code === 'admin';
        state.meName = u.display_name || u.username || '';
        // 顺手把最新用户快照写回，其他页面读 localStorage 也能拿到新角色
        localStorage.setItem('erp_user', JSON.stringify(me.user));
      } catch (e) {
        // /me 不可达时回退本地快照：宁可少显示按钮（后端仍强校验），不可越权显示
        state.isSuper = isSuperAdmin();
        state.isAdmin = state.isSuper || (function () {
          try { return JSON.parse(localStorage.getItem('erp_user') || '{}').role === '管理员'; } catch (x) { return false; }
        })();
        try { const u = JSON.parse(localStorage.getItem('erp_user') || '{}'); state.meName = u.display_name || u.username || ''; } catch (x) { state.meName = ''; }
      }
    }

    // 日期范围组件实例：对外产出 startDate/endDate，映射为后端 dateFrom/dateTo（后端零改动）
    let drp = null;
    function initDateRange() {
      const slot = $('drpSlot');
      if (!slot || !window.DateRangePicker) return;
      if (drp && drp.destroy) drp.destroy();
      drp = new DateRangePicker({
        mount: slot,
        mode: 'day',
        startDate: state.dateFrom,
        endDate: state.dateTo,
        onChange: (v) => { state.dateFrom = v.startDate; state.dateTo = v.endDate; } // 查询仍由「查询」按钮/回车触发，保持原交互
      });
    }

    function shell() {
      c.innerHTML = `
      <div class="wh-page-title"><span class="wh-title-tag">${warehouse}</span><span class="wh-title-sep">-</span><span id="whTitleText">${state.workType}工时录入</span></div>
      <div class="wh-tabs" id="typeTabs"></div>
      <div class="wh-content-card">
      <div class="toolbar">
        <label class="wh-status-label">状态
          <select id="statusFilter" title="未归档 / 已归档">
            <option value="pending" selected>未归档</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <input id="q" placeholder="搜索客户名称">
        <span id="drpSlot"></span>
        <span id="trendWrap" style="display:none;align-items:center;gap:6px;color:var(--muted)">环比
          <select id="trend">
            <option value="day">日</option>
            <option value="week">周</option>
            <option value="month" selected>月</option>
          </select>
        </span>
        <button id="qryBtn" class="primary">查询</button>
        <button id="resetBtn">重置</button>
        <span id="shipTools" style="display:none">
          <button id="templateBtn" title="下载带本仓货主的 Excel 模板">下载模板</button>
          <button id="importBtn" title="导入工时（重复项可确认覆盖/跳过）">导入工时</button>
        </span>
        <input type="file" id="importFile" accept=".xlsx,.xls" style="display:none">
        <button id="archiveBtn" title="将勾选或当前筛选的工时归档">归档</button>
        <button id="signoffBtn" style="margin-left:auto">📷 签收单</button>
        <button id="addBtn" class="primary">+ 新增工时</button>
      </div>
      <div class="wh-archive-tip" id="archiveTip" style="display:none">当前查看「已归档」记录（只读展示，如需修改请先联系管理员）</div>
      <table class="grid" id="whTable">
        <colgroup id="whColGroup"></colgroup>
        <thead><tr id="whHead"></tr></thead>
        <tbody id="whBody"><tr><td class="empty">加载中…</td></tr></tbody>
      </table>
      <div class="pager" id="pager"></div>
      </div>`;
      renderTabs();
      bindToolbar();
      initDateRange();
      $('whBody').addEventListener('click', onBodyClick);
      // 点「提交」时 pointerdown 先于 blur：打标记让 blur 不再触发一次自动保存，
      // 由提交逻辑统一读取当前输入值保存并归档（避免重复写入 / 旧值覆盖）。
      $('whBody').addEventListener('pointerdown', (e) => {
        const b = e.target.closest && e.target.closest('[data-act="submit"]');
        const tr = b && b.closest('tr');
        if (tr) tr.dataset.skipBlurSave = '1';
      }, true);
      load();
    }

    function renderTabs() {
      const tt = $('typeTabs');
      tt.innerHTML = WORK_TYPES.map((w) => `<button type="button" class="wh-tab ${w === state.workType ? 'active' : ''}" data-tp="${w}">${w}工时</button>`).join('');
      tt.querySelectorAll('.wh-tab').forEach((t) => (t.onclick = () => {
        state.workType = t.dataset.tp; state.page = 1;
        syncTabUI(); // 仅联动纯 UI（标题 / Tab 选中态 / 搜索占位符 / 环比显隐）
        load();
      }));
      syncTabUI();
    }

    // UI 联动：Tab 选中态 / 标题 / 搜索占位符 / 环比 / 状态视图（导入导出按钮、归档按钮、提示条）
    function syncTabUI() {
      const tt = $('typeTabs');
      if (tt) tt.querySelectorAll('.wh-tab').forEach((t) => t.classList.toggle('active', t.dataset.tp === state.workType));
      const title = $('whTitleText');
      if (title) title.textContent = state.workType + '工时录入';
      const q = $('q');
      if (q) q.placeholder = (state.workType === '发货' || state.workType === '收货') ? '搜索客户名称' : '搜索项目名称';
      const trend = $('trendWrap');
      if (trend) trend.style.display = state.workType === '发货' ? 'flex' : 'none';
      // 导入导出仅发货 tab 可见；归档按钮仅未归档视图可见；已归档视图显示只读提示
      const ship = $('shipTools');
      if (ship) ship.style.display = state.workType === '发货' ? 'inline' : 'none';
      const arcBtn = $('archiveBtn');
      if (arcBtn) arcBtn.style.display = state.status === 'pending' ? '' : 'none';
      const tip = $('archiveTip');
      if (tip) tip.style.display = state.status === 'archived' ? '' : 'none';
    }

    function bindToolbar() {
      $('q').value = state.q;
      $('trend').value = state.trend;
      $('statusFilter').value = state.status;
      const syncDates = () => { if (drp) { const v = drp.getValue(); state.dateFrom = v.startDate; state.dateTo = v.endDate; } };
      $('qryBtn').onclick = () => { syncDates(); readFilters(); state.page = 1; load(); };
      $('resetBtn').onclick = () => {
        state.q = ''; state.dateFrom = ''; state.dateTo = '';
        $('q').value = '';
        if (drp) drp.setValue({ startDate: '', endDate: '' }, true);
        state.page = 1; load();
      };
      $('trend').onchange = (e) => { state.trend = e.target.value; state.page = 1; load(); };
      $('statusFilter').onchange = (e) => {
        state.status = e.target.value; state.page = 1; state.checked.clear();
        syncTabUI(); load();
      };
      $('addBtn').onclick = () => openModal(null);
      $('signoffBtn').onclick = () => { if (window.ERP_CLOUD && ERP.openSignoffModal) ERP.openSignoffModal(warehouse); };
      $('templateBtn').onclick = onDownloadTemplate;
      $('importBtn').onclick = () => $('importFile').click();
      $('importFile').onchange = onImportFile;
      $('archiveBtn').onclick = onArchive;
      ['q'].forEach((id) => ($(id).onkeydown = (e) => { if (e.key === 'Enter') { syncDates(); readFilters(); state.page = 1; load(); } }));
      syncTabUI();
    }

    // 下载发货模板（带本仓货主）
    function onDownloadTemplate() {
      API.download('/workhours/template?warehouse=' + encodeURIComponent(state.warehouse) + '&work_type=' + encodeURIComponent('发货'),
        '发货工时导入模板_' + state.warehouse + '.xlsx')
        .catch((ex) => alert('下载模板失败：' + ex.message));
    }

    // 导入：选文件 → 预览检测重复 → 弹窗逐条确认覆盖/跳过 → 执行
    let pendingImport = null; // 暂存预览结果，供确认弹窗提交
    async function onImportFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!/\.(xlsx|xls)$/i.test(file.name)) { alert('请选择 .xlsx / .xls 文件'); return; }
      const fd = new FormData();
      fd.append('file', file);
      let preview;
      try {
        preview = await API.upload('/workhours/import/preview?warehouse=' + encodeURIComponent(state.warehouse), fd);
      } catch (ex) { alert('导入预览失败：' + ex.message); return; }
      const rows = preview.data || [];
      const errors = preview.errors || [];
      if (!rows.length) { alert('没有可导入的数据行' + (errors.length ? '\n' + errors.map((x) => `第${x.line}行：${x.error}`).join('\n') : '')); return; }
      pendingImport = { file, rows, errors, preview };
      openImportConfirm(pendingImport);
    }

    // 归档：优先勾选行；无勾选时归档当前筛选（需二次确认）
    async function onArchive() {
      const ids = [...state.checked].map(Number);
      const body = { warehouse: state.warehouse, work_type: state.workType, dateFrom: state.dateFrom, dateTo: state.dateTo, q: state.q };
      if (ids.length) body.ids = ids;
      else body.all = true;
      const msg = ids.length
        ? `确认归档勾选的 ${ids.length} 条工时记录？归档后将不在未归档列表显示。`
        : '当前未勾选任何记录，确认归档「当前筛选结果」中的全部未归档工时？';
      if (!confirm(msg)) return;
      try {
        const r = await API.post('/workhours/archive', body);
        state.checked.clear();
        alert('已归档 ' + (r.archived || 0) + ' 条');
        load();
      } catch (ex) { alert('归档失败：' + ex.message); }
    }

    // 导入确认弹窗：逐行展示，重复行可选「覆盖 / 跳过」，新行固定「新建」
    function openImportConfirm(ctx) {
      const { rows, errors, preview } = ctx;
      const dupCnt = preview.duplicateCount || 0;
      const rowsHtml = rows.map((r) => {
        const dup = r.duplicate;
        const ex = r.existing;
        const choice = dup
          ? `<label><input type="radio" name="dec_${r.line}" value="skip" checked> 跳过</label>
             <label><input type="radio" name="dec_${r.line}" value="overwrite"> 覆盖</label>`
          : '<span class="imp-new">新建</span>';
        const existTxt = dup && ex ? `已有：${ex.ship_orders} 单 / ${ex.main_hours}h` : '';
        return `<tr class="${dup ? 'imp-dup' : ''}">
          <td>${r.line}</td><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.customer_name)}</td>
          <td>${r.ship_orders}</td><td>${r.main_hours}</td>
          <td>${dup ? '<span class="cust-tag cust-tag-stop">重复</span> ' + escapeHtml(existTxt) : ''}</td>
          <td>${choice}</td></tr>`;
      }).join('');
      const errHtml = errors.length
        ? `<div class="imp-errors"><b>${errors.length} 行被忽略：</b><br>` + errors.map((x) => `第 ${x.line} 行：${escapeHtml(x.error)}`).join('<br>') + '</div>'
        : '';
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `<div class="modal imp-confirm" style="max-width:820px">
        <div class="modal-head"><span>导入预览 · 共 ${rows.length} 行（${dupCnt} 行重复）</span><button class="close" type="button">×</button></div>
        <div class="modal-body">
          <div class="imp-hint">重复行请逐条选择「覆盖」或「跳过」，未选择时默认跳过。确认后写入，导入过程可事务回滚。</div>
          <table class="grid imp-grid"><thead><tr>
            <th>行号</th><th>日期</th><th>客户名称</th><th>发货单量</th><th>主工时</th><th>重复提示</th><th>处理</th>
          </tr></thead><tbody>${rowsHtml}</tbody></table>
          ${errHtml}
        </div>
        <div class="modal-foot">
          <button type="button" class="imp-cancel">取消</button>
          <button type="button" class="primary imp-ok">确认导入</button>
        </div>
      </div>`;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector('.close').onclick = close;
      overlay.querySelector('.imp-cancel').onclick = close;
      overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
      overlay.querySelector('.imp-ok').onclick = async () => {
        const decisions = {};
        rows.forEach((r) => {
          if (!r.duplicate) return;
          const sel = overlay.querySelector(`input[name="dec_${r.line}"]:checked`);
          decisions[r.line] = sel ? sel.value : 'skip';
        });
        const fd = new FormData();
        fd.append('file', ctx.file);
        fd.append('decisions', JSON.stringify(decisions));
        const btn = overlay.querySelector('.imp-ok');
        btn.disabled = true; btn.textContent = '导入中…';
        try {
          const res = await API.upload('/workhours/import?warehouse=' + encodeURIComponent(state.warehouse), fd);
          close();
          alert(`导入完成：新建 ${res.created || 0} 条，覆盖 ${res.overwritten || 0} 条，跳过 ${res.skipped || 0} 条` +
            (res.errors && res.errors.length ? `\n忽略 ${res.errors.length} 行（格式/客户不匹配）` : ''));
          state.page = 1; load();
        } catch (ex) { btn.disabled = false; btn.textContent = '确认导入'; alert('导入失败：' + ex.message); }
      };
    }
    function readFilters() {
      state.q = $('q').value.trim();
      // 日期由 drp 组件的 onChange 同步；查询按钮/回车另经 syncDates() 兜底读取
    }

    async function load() {
      // 渲染前刷新真实角色：删除按钮按库内最新 role_code 门控（铁律 3）
      await refreshRole();
      const params = new URLSearchParams({ warehouse: state.warehouse, work_type: state.workType, status: state.status, page: state.page, pageSize: state.pageSize });
      if (state.workType === '发货') params.set('trend', state.trend);
      if (state.q) params.set('q', state.q);
      if (state.dateFrom) params.set('dateFrom', state.dateFrom);
      if (state.dateTo) params.set('dateTo', state.dateTo);
      const r = await API.get('/workhours?' + params.toString());
      state.lastRows = r.data || [];
      state.lastTotal = r.total || 0;
      renderRows();
      renderPager(state.lastTotal, r.page || 1, r.pageSize || state.pageSize);
    }

    // 统一渲染表头+表体（load 与行内编辑局部重绘共用）
    function renderRows() {
      renderHead();
      const rows = state.lastRows;
      const span = COLUMNS[state.workType].length + 2; // +勾选列 +操作列
      $('whBody').innerHTML = rows.length ? rows.map(rowHtml).join('')
        : `<tr><td colspan="${span}" class="empty">${state.status === 'archived' ? '暂无已归档记录' : '暂无工时记录'}</td></tr>`;
      // 发货未归档：每行都是可编辑输入行，逐行绑定实时计算 + 失焦/回车自动保存
      if (state.workType === '发货' && state.status === 'pending') {
        $('whBody').querySelectorAll('tr[data-row-cid]').forEach(bindInlineRow);
      }
    }

    // 发货行内直编的列宽（px）：勾选34 / 日期96 / 客户150 / 单位62 / 单量80 / 主工时78 / 时效72 / 其他工时84 / 备注116 / 提交人72 / 操作96
    // 用 table-layout:fixed + colgroup 锁定，输入框 width:100% 贴合列宽，杜绝撑破；操作列 sticky 贴右。
    const INLINE_WIDTHS = { 发货: [34, 96, 150, 62, 80, 78, 72, 84, 116, 72, 96] };

    function renderHead() {
      const cols = COLUMNS[state.workType];
      const inline = state.workType === '发货' && state.status === 'pending';
      const table = $('whTable');
      if (table) table.classList.toggle('wh-inline-grid', inline);
      const cg = $('whColGroup');
      if (cg) {
        if (inline && INLINE_WIDTHS[state.workType]) {
          cg.innerHTML = INLINE_WIDTHS[state.workType].map((w) => `<col style="width:${w}px">`).join('');
        } else cg.innerHTML = '';
      }
      const ck = state.status === 'pending'
        ? '<th class="wh-ck"><input type="checkbox" id="ckAll" title="勾选本页全部"></th>' : '';
      $('whHead').innerHTML = ck + cols.map((col) => `<th class="${col.num ? 'num' : ''}">${col.label}</th>`).join('') + '<th class="ops-head">操作</th>';
      if (state.status === 'pending') {
        const all = $('ckAll');
        if (all) all.onchange = (e) => {
          [...$('whBody').querySelectorAll('input.wh-row-ck')].forEach((box) => {
            box.checked = e.target.checked;
            const id = Number(box.dataset.id);
            if (e.target.checked) state.checked.add(id); else state.checked.delete(id);
          });
        };
      }
    }

    function renderPager(total, cur, size) {
      const pages = Math.ceil(total / size) || 1;
      const p = $('pager');
      p.innerHTML = `共 ${total} 条 · 第 ${cur}/${pages} 页`;
      const prev = document.createElement('button');
      prev.textContent = '上一页'; prev.disabled = cur <= 1; prev.onclick = () => { state.page = cur - 1; load(); };
      const next = document.createElement('button');
      next.textContent = '下一页'; next.disabled = cur >= pages; next.onclick = () => { state.page = cur + 1; load(); };
      p.appendChild(prev); p.appendChild(next);
    }

    function trendCell(val, t) {
      if (!t) return `<td class="num">${num(val)}</td>`;
      const arrow = t.deltaPct == null ? '<span class="trend flat">—</span>'
        : `<span class="trend ${t.dir}">${t.dir === 'up' ? '▲' : t.dir === 'down' ? '▼' : '—'}${Math.abs(t.deltaPct).toFixed(1)}%</span>`;
      return `<td class="num">${num(val)} ${arrow}</td>`;
    }

    // 缺口行单/件/箱单位下拉（行内编辑用）：sel 为空时给一个「—」占位，保持真正未选状态
    function unitOptions(sel) {
      const ph = `<option value="" ${!sel ? 'selected' : ''}>—</option>`;
      return ph + ['单', '件', '箱'].map((u) => `<option value="${u}" ${u === sel ? 'selected' : ''}>${u}</option>`).join('');
    }

    function rowHtml(r) {
      const cols = COLUMNS[state.workType];
      const trend = r.trend || null;
      // 发货 + 未归档：全部行（缺口 filled=0 与已填 filled=1）都行内直编，无「填写」按钮
      const inline = state.workType === '发货' && state.status === 'pending';
      const isGap = inline && r.filled === 0;               // 缺口行：work_id=0，提交用 POST+auto_archive
      const wid = r.work_id || 0;                            // 已填行：>0，保存用 PUT 更新原记录
      const rowAttrs = `data-row-cid="${r.customer_id}" data-row-wid="${wid}" ` +
        `data-row-date="${escapeAttr(r.date || r.suggest_date || todayStr())}" data-row-cname="${escapeAttr(r.customer_name || '')}"`;
      // 勾选列（缺口行无 work_id，禁止勾选归档）
      const ck = state.status === 'pending'
        ? '<td class="wh-ck">' + (isGap ? '' :
            `<input type="checkbox" class="wh-row-ck" data-id="${r.work_id}" ${state.checked.has(r.work_id) ? 'checked' : ''}>`) + '</td>'
        : '';
      const cells = cols.map((col) => {
        if (inline) {
          // 日期：缺口行显示建议日期（待补标红），已填行显示实际日期；均只读，按此日期入库
          if (col.key === 'date') {
            const d = isGap ? (r.suggest_date || todayStr()) : r.date;
            return `<td class="wh-inline-date">${escapeHtml(d || '')}${isGap && r.need_backfill ? ' <span class="bk-tag">[待补]</span>' : ''}</td>`;
          }
          // 客户名：缺口行用 company_name，已填行用关联最新名 + 状态标签
          if (col.key === 'customer_name') {
            let tag = '';
            if (r.customer_status === '已删除') tag = ' <span class="cust-tag cust-tag-del">(已删除)</span>';
            else if (r.customer_status === '停用') tag = ' <span class="cust-tag cust-tag-stop">(已停用)</span>';
            return `<td>${escapeHtml(r.customer_name || '')}${tag}</td>`;
          }
          // 可编辑控件：单位下拉 / 单量·主工时·其他工时数字框 / 备注文本框
          // 防脏读：空值一律渲染为空字符串（绝不写 0 或占位文字冒充已填）；placeholder 仅空时显示且浅色由 CSS 控制。
          const numVal = (v) => (v != null && Number(v) !== 0) ? v : ''; // 0 视为未填，保持真空态
          if (col.key === 'unit')        return `<td><select data-if="unit" class="wh-cell-sel">${unitOptions(isGap ? '' : (r.unit || '单'))}</select></td>`;
          if (col.key === 'ship_orders') return `<td><input data-if="ship_orders" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.ship_orders)}" placeholder="请输入单量"></td>`;
          if (col.key === 'main_hours')  return `<td><input data-if="main_hours" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.main_hours)}" placeholder="请输入主工时"></td>`;
          if (col.key === 'other_hours') return `<td><input data-if="other_hours" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.other_hours)}" placeholder="请输入其他工时"></td>`;
          if (col.key === 'remark')      return `<td><input data-if="remark" class="wh-cell-txt" type="text" value="${escapeAttr(r.remark || '')}" placeholder="请输入备注"></td>`;
          // 未归档：提交人列固定显示 -（尚未提交，不冒充已有提交人）
          if (col.key === 'submitter')   return '<td class="muted">-</td>';
          // 时效：单量与主工时都 >0 才显示计算值，否则 -（与行内 recalc 口径一致，不显示 0.000）
          if (col.key === 'efficiency') {
            const m = Number(r.main_hours) || 0, s = Number(r.ship_orders) || 0;
            return `<td class="num" data-out="efficiency">${(s > 0 && m > 0) ? num(r.efficiency) : '-'}</td>`;
          }
          return '<td class="muted">—</td>';
        }
        if (col.trend && trend) return trendCell(r[col.key], trend[col.key]);
        // 提交人：已归档显示真实提交人，未归档（含无值）显示 -
        if (col.key === 'submitter') return `<td>${escapeHtml(r.submitter || '-')}</td>`;
        if (col.num) return `<td class="num">${num(r[col.key])}</td>`;
        if (col.key === 'customer_name') {
          const name = escapeHtml(r.customer_name == null ? '' : r.customer_name);
          let tag = '';
          if (r.customer_status === '已删除') tag = ' <span class="cust-tag cust-tag-del">(已删除)</span>';
          else if (r.customer_status === '停用') tag = ' <span class="cust-tag cust-tag-stop">(已停用)</span>';
          return `<td>${name}${tag}</td>`;
        }
        return `<td>${escapeHtml(r[col.key] == null ? '' : r[col.key])}</td>`;
      }).join('');
      // 操作列 —— 铁律 3：按「行状态 + 登录用户真实角色」动态渲染，严禁越权：
      //  - archived：查看（只读）/ 撤回（本人或管理员）/ 修改提交人（管理员）/ 删除（仅超管）
      //  - pending + 行内直编（发货）：提交（蓝色，保存并归档）/ 删除（红色，仅超管物理删除）
      //  - pending + 非行内（收货/库内/后勤）：编辑 / 提交 / 删除
      // 角色取自 load() 里 refreshRole()（/api/auth/me 库内最新 role_code），不读 localStorage 旧快照。
      const archived = String(r.status || (state.status === 'archived' ? 'archived' : 'pending')) === 'archived';
      let ops;
      if (archived) {
        // 撤回：提交人本人或管理员；修改提交人：仅管理员；删除：仅超管
        const canWithdraw = state.isAdmin || (!!state.meName && r.submitter === state.meName);
        ops = `<button data-act="view" data-id="${wid}" title="查看归档详情（只读）">查看</button>`
          + (canWithdraw ? `<button data-act="withdraw" data-id="${wid}" title="撤回到未归档，撤回后可重新编辑">撤回</button>` : '')
          + (state.isAdmin ? `<button data-act="editSubmitter" data-id="${wid}" title="修改该记录的提交人">修改提交人</button>` : '')
          + (state.isSuper ? `<button data-act="delAdmin" data-id="${wid}" class="danger" title="永久删除该条记录（不可恢复）">删除</button>` : '');
      } else if (inline) {
        const submitBtn = `<button data-act="submit" data-id="${wid}" class="primary" title="保存当前行并提交归档">提交</button>`;
        const delBtn = (!isGap && state.isSuper)
          ? `<button data-act="delAdmin" data-id="${wid}" class="danger" title="永久删除该条记录（不可恢复）">删除</button>`
          : '<span class="ops-none" title="仅超级管理员可删除记录">—</span>';
        ops = submitBtn + delBtn;
      } else {
        ops = `<button data-act="edit" data-id="${r.work_id}">编辑</button>
               <button data-act="submit" data-id="${r.work_id}" class="primary" title="提交归档">提交</button>
               <button data-act="del" data-id="${r.work_id}">删除</button>`;
      }
      return `<tr class="${isGap ? 'wh-gap-row' : ''}" ${inline ? rowAttrs : ''}>${ck}${cells}<td class="ops">${ops}</td></tr>`;
    }

    // 表格行操作（事件委托）：按钮操作 + 勾选态维护
    function onBodyClick(e) {
      // 勾选框：维护 state.checked（归档用）
      if (e.target.classList && e.target.classList.contains('wh-row-ck')) {
        const id = Number(e.target.dataset.id);
        if (e.target.checked) state.checked.add(id); else state.checked.delete(id);
        return;
      }
      const act = e.target.dataset.act, id = e.target.dataset.id;
      if (!act || !id) return;
      if (act === 'edit') openModal(id);
      // 归档详情：只读查看（归档数据不可直接改，需先撤回）
      if (act === 'view') openModal(id, null, { readonly: true });
      // 提交归档：行内视图走行内保存（带当前输入值）；其他 tab 直接提交
      if (act === 'submit') {
        const tr = e.target.closest('tr');
        if (tr && typeof tr.__submit === 'function') { tr.__submit(); return; }
        if (!confirm('确定要提交归档吗？归档后不可直接修改。')) return;
        const btn = e.target; btn.disabled = true;
        API.post('/workhours/' + id + '/submit', { warehouse: state.warehouse, work_type: state.workType })
          .then(() => { alert('已提交归档'); load(); })
          .catch((ex) => { btn.disabled = false; alert('提交失败：' + ex.message); });
        return;
      }
      // 撤回：archived → pending，撤回后回到「未归档」可继续行内编辑
      if (act === 'withdraw') {
        if (!confirm('确定要撤回该条记录吗？撤回后可重新编辑。')) return;
        const btn = e.target; btn.disabled = true;
        API.post('/workhours/' + id + '/withdraw', { warehouse: state.warehouse, work_type: state.workType })
          .then(() => { alert('已撤回，可在「未归档」中继续编辑'); load(); })
          .catch((ex) => { btn.disabled = false; alert('撤回失败：' + ex.message); });
        return;
      }
      // 修改提交人：管理员弹下拉选择系统内用户
      if (act === 'editSubmitter') { openSubmitterModal(id); return; }
      // 普通删除（其他 tab，原逻辑）
      if (act === 'del' && confirm('确认删除该工时记录？此操作将写入审计日志。')) {
        API.req('DELETE', '/workhours/' + id).then(load).catch((ex) => alert(ex.message));
      }
      // 管理员永久删除（发货 tab）：二次确认 + 后端 role_code 强校验；成功后立即从页面移除该行
      if (act === 'delAdmin' && confirm('确定要彻底删除这条记录吗？')) {
        const btn = e.target;
        btn.disabled = true;
        API.req('DELETE', '/workhours/' + id + '/force')
          .then(() => {
            const tr = btn.closest('tr');
            if (tr) tr.remove();          // 立即从页面移除该行
            alert('已删除');
            load();                       // 再拉取一次，保持分页/计数一致
          })
          .catch((ex) => { btn.disabled = false; alert('删除失败：' + ex.message); });
      }
    }

    // 行内直编：实时计算时效 + 失焦/回车自动保存为 pending 草稿；「提交」按钮保存并归档。
    // 缺口行(wid=0) → POST /workhours（草稿待提交；提交时 auto_archive=true）
    // 已填行(wid>0) → PUT /workhours/:wid，提交时再 POST /:id/submit（写提交人 + 提交时间）
    function bindInlineRow(tr) {
      const el = (k) => tr.querySelector('[data-if="' + k + '"]');
      const val = (k) => { const e = el(k); return e ? e.value : ''; };
      // 时效：只有 单量>0 且 主工时>0 才计算（round3），否则一律显示 -（防脏数据冒充 0.000）
      const recalc = () => {
        const ship = Number(val('ship_orders')) || 0, main = Number(val('main_hours')) || 0;
        const out = tr.querySelector('[data-out="efficiency"]');
        if (out) out.textContent = (ship > 0 && main > 0)
          ? (Math.round((ship / main + Number.EPSILON) * 1000) / 1000).toFixed(3)
          : '-';
      };
      // 防脏读复位：把整行输入恢复成真正的未填初始态（空值 + 单位占位 + 时效 -）
      const resetRow = () => {
        tr.querySelectorAll('[data-if]').forEach((e) => { if (e.tagName !== 'SELECT') e.value = ''; });
        const u = el('unit'); if (u) u.value = '';
        recalc();
      };
      // 当前行输入 → 后端 payload（行内编辑的唯一取数口径）
      function payloadOf() {
        const cid = tr.dataset.rowCid;
        return {
          warehouse: state.warehouse, work_type: '发货',
          customer_id: cid != null && cid !== '' ? Number(cid) : null,
          customer_name: tr.dataset.rowCname || null,
          date: tr.dataset.rowDate || todayStr(),
          // 单位真空时默认按「单」提交（后端必填校验口径），但 UI 保持空不冒充已填
          unit: val('unit') || '单',
          ship_orders: Number(val('ship_orders')) || 0,
          main_hours: Number(val('main_hours')) || 0,
          other_hours: Number(val('other_hours')) || 0,
          shared_hours: 0,
          remark: (val('remark') || '').trim() || null,
        };
      }
      // archive=false：失焦草稿（pending，仍留在未归档列表）
      // archive=true ：提交归档（缺口行 POST auto_archive；已填行 PUT + /submit）
      async function persist(archive, explicit) {
        const ship = Number(val('ship_orders')) || 0;
        const main = Number(val('main_hours')) || 0;
        // 防呆核心（铁律级）：单量>0 且 主工时>0 才允许保存（与「时效必须可计算」口径一致）。
        // 空值/0 一律取消保存，绝不入库全 0 或缺主工时的脏记录。
        if (!(ship > 0) || !(main > 0)) {
          if (explicit) { alert('请先填写发货单量（>0）和主工时（>0）后再提交'); return false; }
          const w = Number(tr.dataset.rowWid) || 0;
          if (w > 0) load(); else resetRow();   // 已填行恢复库值；缺口行复位成真空态
          return false;
        }
        // 串行化：若上一次保存仍在进行，先等它完成，防止重复 POST / 旧值覆盖新值
        if (tr.__saving) { try { await tr.__saving; } catch (e) { /* 交给本轮重试 */ } }
        const wid = Number(tr.dataset.rowWid) || Number(tr.__savedWid) || 0;
        const payload = payloadOf();
        const run = (async () => {
          if (wid > 0) {
            await API.put('/workhours/' + wid, payload);
            if (archive) await API.post('/workhours/' + wid + '/submit', { warehouse: state.warehouse, work_type: '发货' });
          } else if (archive) {
            payload.auto_archive = true;      // 缺口行提交：保存即归档（后端写 submitter / submit_time）
            const res = await API.post('/workhours', payload);
            tr.__savedWid = res && res.data && res.data.work_id;
          } else {
            const res = await API.post('/workhours', payload);  // 失焦草稿：pending
            tr.__savedWid = res && res.data && res.data.work_id;
          }
        })();
        tr.__saving = run;
        try {
          await run;
        } catch (ex) {
          alert((archive ? '提交失败：' : '保存失败：') + ex.message);
          return false;
        } finally {
          tr.__saving = null;
        }
        if (archive) alert('已提交归档');
        await load();
        return true;
      }

      // 操作列「提交」：二次确认 → 保存当前行 → 归档（不再触发 blur 自动保存）
      tr.__submit = async () => {
        if (!confirm('确定要提交归档吗？归档后不可直接修改。')) return;
        await persist(true, true);
      };

      tr.querySelectorAll('[data-if]').forEach((e) => {
        e.addEventListener('input', recalc);
        e.addEventListener('blur', () => {
          // 点「提交」时 pointerdown 已打好标记：跳过本次自动保存，由提交逻辑统一处理
          if (tr.dataset.skipBlurSave === '1') { delete tr.dataset.skipBlurSave; return; }
          persist(false, false);
        });
        e.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); persist(false, false); } });
      });
      recalc();
    }

    // ---------- 弹窗（按 work_type 动态表单；归属仓库锁定为当前页面仓库） ----------
    // preset：缺口行"填写"传入的预选客户 { customer_id, customer_name, date }
    async function openModal(id, preset, opts) {
      const isEdit = !!id;
      const readonly = !!(opts && opts.readonly); // 已归档只读查看：禁用输入、隐藏保存
      preset = preset || {};
      let cur = {};
      if (isEdit) {
        try { cur = (await API.get('/workhours/' + id)).data || {}; } catch (ex) { alert(ex.message); return; }
      } else if (preset.customer_id) {
        cur = { customer_id: preset.customer_id, customer_name: preset.customer_name, date: preset.date };
      }
      const workType = isEdit ? cur.work_type : state.workType;
      // 客户下拉：按当前仓库过滤（warehouse 参数），只显示本仓货主，杜绝跨仓越权。
      // /options 返回含已删除/停用的全部客户；已删除/停用加后缀并置灰，不允许新录入。
      const owners = (await API.get('/customers/options?warehouse=' + encodeURIComponent(state.warehouse))).data || [];
      // 兜底：编辑历史工时（或缺口预选）若关联客户不在本仓下拉中（跨仓历史/纯文本），补只读占位项保留原值，绝不丢历史。
      const presetName = cur.customer_name;
      const hit = presetName && owners.some((o) =>
        (cur.customer_id != null && String(o.customer_id) === String(cur.customer_id)) ||
        o.owner_name === presetName || o.company_name === presetName);
      if (presetName && !hit) {
        owners.unshift({ customer_id: cur.customer_id || '', owner_name: presetName, status: '已删除' });
      }
      const ownerOpts = owners.map((o) => {
        const inactive = o.status === '已删除' || o.status === '停用';
        const suffix = o.status === '已删除' ? ' (已删除)' : (o.status === '停用' ? ' (已停用)' : '');
        const label = escapeHtml(o.owner_name || o.company_name || '') + suffix;
        const val = o.customer_id != null && o.customer_id !== '' ? o.customer_id : '';
        const isCur = (cur.customer_id != null && String(val) === String(cur.customer_id)) ||
                      (cur.customer_id == null && val === '' && o.owner_name === cur.customer_name);
        return `<option value="${escapeAttr(val)}"${inactive ? ' disabled' : ''}${isCur ? ' selected' : ''}>${label}</option>`;
      }).join('');
      // 历史工时的旧单位（托/公斤）若不在标准下拉中，补一项选中以保留原值，编辑不丢数据
      const unitList = (cur.unit && !UNITS.includes(cur.unit)) ? ['', ...UNITS, cur.unit] : ['', ...UNITS];
      const unitOpts = unitList.map((u) => `<option value="${u}" ${u === (cur.unit || '') ? 'selected' : ''}>${u || '（空）'}</option>`).join('');
      const projOpts = (PROJECT_OPTIONS[workType] || []).map((p) => `<option value="${p}" ${p === cur.project ? 'selected' : ''}>${p}</option>`).join('');

      const fields = [];
      if (workType === '发货' || workType === '收货') {
        fields.push(`<label>客户名称*<select id="f_customer">${ownerOpts}</select></label>`);
        fields.push(`<label>单位<select id="f_unit">${unitOpts}</select></label>`);
      }
      if (workType === '库内' || workType === '后勤') {
        fields.push(`<label>项目*<select id="f_project">${projOpts}</select></label>`);
        if (workType === '库内') fields.push(`<label>单位<select id="f_unit">${unitOpts}</select></label>`);
      }
      fields.push(`<label>日期*<input id="f_date" type="date" value="${escapeAttr(cur.date || '')}"></label>`);
      if (workType === '发货') fields.push(`<label>发货单量*<input id="f_ship" type="number" step="0.001" min="0" value="${cur.ship_orders != null ? cur.ship_orders : ''}"></label>`);
      if (workType === '收货') {
        fields.push(`<label>箱数<input id="f_cartons" type="number" step="0.001" min="0" value="${cur.cartons != null ? cur.cartons : 0}"></label>`);
        fields.push(`<label>吨<input id="f_tons" type="number" step="0.001" min="0" value="${cur.tons != null ? cur.tons : 0}"></label>`);
        fields.push(`<label>方<input id="f_cubic" type="number" step="0.001" min="0" value="${cur.cubic != null ? cur.cubic : 0}"></label>`);
        fields.push(`<label>托盘<input id="f_pallets" type="number" step="0.001" min="0" value="${cur.pallets != null ? cur.pallets : 0}"></label>`);
      }
      fields.push(`<label>主工时(小时)<input id="f_main" type="number" step="0.001" min="0" value="${cur.main_hours != null ? cur.main_hours : 0}"></label>`);
      fields.push(`<label>其他工时(小时)<input id="f_other" type="number" step="0.001" min="0" value="${cur.other_hours != null ? cur.other_hours : 0}"></label>`);
      fields.push(`<label>公摊工时(小时)<input id="f_shared" type="number" step="0.001" min="0" value="${cur.shared_hours != null ? cur.shared_hours : 0}"></label>`);
      fields.push(`<label class="full">备注<textarea id="f_remark" rows="2">${escapeHtml(cur.remark || '')}</textarea></label>`);

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
      <div class="modal">
        <div class="modal-head"><span>${readonly ? '查看' : (isEdit ? '编辑' : '新增')}工时（${workType} · ${state.warehouse}）</span><button class="close" type="button">×</button></div>
        <div class="modal-body">${fields.join('')}
          <div class="full" style="display:flex;gap:24px;color:var(--muted);font-size:13px">
            <span>总工时：<b id="f_total" style="color:var(--text)">0.000</b> 小时</span>
            <span id="f_extra"></span>
          </div>
          <div id="f_err" class="err"></div>
        </div>
        <div class="modal-foot"><button id="saveBtn" class="primary" type="button">保存</button><button class="close" type="button">取消</button></div>
      </div>`;
      document.body.appendChild(modal);
      modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
      if (readonly) {
        // 归档数据只读：全部控件禁用，移除保存按钮（修改需先撤回）
        modal.querySelectorAll('input,select,textarea').forEach((e) => { e.disabled = true; });
        const sb = modal.querySelector('#saveBtn'); if (sb) sb.remove();
      }

      function numV(id) { const v = modal.querySelector(id).value; return v === '' ? null : Number(v); }
      function preview() {
        const m = Number(modal.querySelector('#f_main').value) || 0;
        const o = Number(modal.querySelector('#f_other').value) || 0;
        const s = Number(modal.querySelector('#f_shared').value) || 0;
        const total = Math.round((m + o + s + Number.EPSILON) * 1000) / 1000;
        modal.querySelector('#f_total').textContent = total.toFixed(3);
        let extra = '';
        if (workType === '发货') {
          const ship = Number(modal.querySelector('#f_ship') ? modal.querySelector('#f_ship').value : 0) || 0;
          const eff = m ? (ship / m) : 0;
          const uc = ship ? (total / ship) : 0;
          extra = `时效：<b style="color:var(--text)">${(Math.round(eff * 1000) / 1000).toFixed(3)}</b> · 单均成本：<b style="color:var(--text)">${(Math.round(uc * 1000) / 1000).toFixed(3)}</b>`;
        } else if (workType === '收货') {
          const cartons = Number(modal.querySelector('#f_cartons') ? modal.querySelector('#f_cartons').value : 0) || 0;
          const eff = m ? (cartons / m) : 0;
          const dc = cartons ? (total / cartons) : 0;
          extra = `时效：<b style="color:var(--text)">${(Math.round(eff * 1000) / 1000).toFixed(3)}</b> · 单据成本：<b style="color:var(--text)">${(Math.round(dc * 1000) / 1000).toFixed(3)}</b>`;
        }
        modal.querySelector('#f_extra').innerHTML = extra;
      }
      ['#f_main', '#f_other', '#f_shared', '#f_ship', '#f_cartons'].forEach((sel) => { const el = modal.querySelector(sel); if (el) el.oninput = preview; });
      preview();

      modal.querySelector('#saveBtn').onclick = async () => {
        const payload = {
          warehouse: state.warehouse, work_type: workType,
          unit: modal.querySelector('#f_unit') ? (modal.querySelector('#f_unit').value || null) : null,
          date: modal.querySelector('#f_date').value,
          main_hours: modal.querySelector('#f_main').value,
          other_hours: modal.querySelector('#f_other').value,
          shared_hours: modal.querySelector('#f_shared').value,
          remark: (modal.querySelector('#f_remark').value || '').trim() || null,
        };
        if (workType === '发货' || workType === '收货') {
          const sel = modal.querySelector('#f_customer');
          const opt = sel.selectedOptions[0];
          payload.customer_id = sel.value === '' ? null : Number(sel.value);
          // 提交客户名去掉展示用后缀，后端按 id/名解析最新值
          payload.customer_name = opt ? opt.textContent.replace(/ \((已删除|已停用)\)$/, '') : sel.value;
        }
        if (workType === '库内' || workType === '后勤') payload.project = modal.querySelector('#f_project').value;
        if (workType === '发货') payload.ship_orders = modal.querySelector('#f_ship').value;
        if (workType === '收货') {
          payload.cartons = modal.querySelector('#f_cartons').value;
          payload.tons = modal.querySelector('#f_tons').value;
          payload.cubic = modal.querySelector('#f_cubic').value;
          payload.pallets = modal.querySelector('#f_pallets').value;
        }
        const errEl = modal.querySelector('#f_err');
        try {
          if (isEdit) await API.put('/workhours/' + id, payload);
          else await API.post('/workhours', payload);
          modal.remove(); load();
        } catch (ex) { errEl.textContent = ex.message; }
      };
    }

    // 修改提交人（仅管理员）：下拉选择系统内真实用户，保存后写审计（只记 submitter 前后值）
    async function openSubmitterModal(id) {
      let users = [];
      try { users = (await API.get('/users')).data || []; } catch (ex) { alert('读取用户列表失败：' + ex.message); return; }
      const names = [...new Set(users.map((u) => u.display_name || u.username).filter(Boolean))];
      if (!names.length) { alert('系统内暂无可选用户'); return; }
      const row = state.lastRows.find((x) => Number(x.work_id) === Number(id)) || {};
      const cur = row.submitter || '';
      const opts = names.map((n) => `<option value="${escapeAttr(n)}" ${n === cur ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `<div class="modal" style="max-width:420px">
        <div class="modal-head"><span>修改提交人</span><button class="close" type="button">×</button></div>
        <div class="modal-body">
          <label>提交人<select id="spName">${opts}</select></label>
          <div class="err" id="spErr"></div>
        </div>
        <div class="modal-foot"><button type="button" class="sp-cancel">取消</button><button type="button" class="primary sp-ok">保存</button></div>
      </div>`;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector('.close').onclick = close;
      overlay.querySelector('.sp-cancel').onclick = close;
      overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
      overlay.querySelector('.sp-ok').onclick = async () => {
        const name = overlay.querySelector('#spName').value;
        const btn = overlay.querySelector('.sp-ok');
        btn.disabled = true;
        try {
          await API.put('/workhours/' + id + '/submitter', { submitter: name });
          close(); await load();
        } catch (ex) {
          overlay.querySelector('#spErr').textContent = ex.message;
          btn.disabled = false;
        }
      };
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    function escapeAttr(s) { return escapeHtml(s); }
    function num(x) { return (x == null ? 0 : Number(x)).toFixed(3); }

    shell();
  };
}

// 按仓库注册独立页面实例（顶部 Tab 标题在 PAGE_META 中按页面 id 区分）
Object.keys(WH_PAGE_CONFIG).forEach(function (pageId) {
  window.ERP_PAGES[pageId] = createWorkhoursPage(WH_PAGE_CONFIG[pageId]);
});
