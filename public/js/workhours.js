// 工时管理页（按仓库拆分）：每个仓库一个独立页面实例
// - 仓库不再由页内 Tabs 切换，而是由左侧菜单「工时 → 录入 → 各仓工时管理」路由锁定
// - 页面内保留 发货/收货/库内/后勤 四个业务类型 Tabs
// - 新增一律为表格行内直编（无新增弹窗）；弹窗仅用于已归档记录修改/查看；归属仓库由页面路由锁定
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
        { key: 'date', label: '日期' }, { key: 'customer_name', label: '客户名称', left: true },
        { key: 'cartons', label: '箱数', num: true },
        { key: 'tons', label: '吨', num: true }, { key: 'cubic', label: '方', num: true }, { key: 'pallets', label: '托盘', num: true },
        { key: 'main_hours', label: '主工时', num: true }, { key: 'other_hours', label: '其他工时', num: true },
        { key: 'remark', label: '备注' },
        { key: 'submitter', label: '提交人' },
        // 已隐藏冗余列：unit/效率/单据成本（仅 UI 层删，后端数据 calc 不变）
        // ★ 公摊工时不在录入 UI 展示：仅由经营看板后端按库内工时自动分摊，禁止手动输入（提交省略字段，后端默认 0）
      ],
      库内: [
        { key: 'date', label: '日期' }, { key: 'project', label: '项目', left: true },
        { key: 'workload', label: '作业量', num: true }, { key: 'unit', label: '单位' },
        { key: 'main_hours', label: '主工时', num: true }, { key: 'other_hours', label: '其他工时', num: true },
        { key: 'remark', label: '备注' },
        { key: 'submitter', label: '提交人' },
        // ★ 总工时列已从 UI 移除（派生值后端仍计算入库，仅展示层去掉）
      ],
      后勤: [
        { key: 'date', label: '日期' }, { key: 'project', label: '项目', left: true },
        { key: 'main_hours', label: '主工时', num: true }, { key: 'other_hours', label: '其他工时', num: true },
        { key: 'remark', label: '备注' }, { key: 'total_hours', label: '总工时', num: true },
        { key: 'submitter', label: '提交人' },
      ],
    };

    // 仓库由路由（页面配置）锁定，页内不可切换
    // status：pending 未归档（默认）/ archived 已归档；checked：勾选归档用
    // lastRows：当前页数据（供行内直编与局部重绘）
    // ★ 日期范围工具函数：按 mode 计算今天所在的区间
    //   day  → {start,end} 同是今天
    //   week → {start,end} 本周一 ~ 本周日
    //   month→ {start,end} 本月1号 ~ 本月最后一天
    const _fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const _todayDate = new Date();
    const _weekStart = new Date(_todayDate); _weekStart.setDate(_weekStart.getDate() - ((_weekStart.getDay() + 6) % 7));
    const _weekEnd = new Date(_weekStart); _weekEnd.setDate(_weekEnd.getDate() + 6);
    const _monthEnd = new Date(_todayDate.getFullYear(), _todayDate.getMonth() + 1, 0);
    const RANGE_BY_MODE = {
      day:   { start: _fmt(_todayDate),          end: _fmt(_todayDate) },
      week:  { start: _fmt(_weekStart),           end: _fmt(_weekEnd) },
      month: { start: _fmt(new Date(_todayDate.getFullYear(), _todayDate.getMonth(), 1)), end: _fmt(_monthEnd) },
    };
    const state = { warehouse: warehouse, workType: '发货', status: 'pending', page: 1, pageSize: 20, q: '', dateFrom: RANGE_BY_MODE.day.start, dateTo: RANGE_BY_MODE.day.end, dateMode: 'day', checked: new Set(), lastRows: [], lastTotal: 0, isSuper: false, isAdmin: false, meName: '', customers: [] };

    // ---------- 草稿持久化（localStorage） ----------
    // 需求：用户新增工时草稿后，关闭 banner tab / 切换页面再回来，草稿不应丢失。
    // 机制：按仓库 + 工时类型（wh + wt）分 namespace 存 localStorage；
    //   读：ERP_PAGES 初始化时 + load() 时，从 localStorage 取出对应 wt 的草稿，合并到 state.lastRows 顶部；
    //   写：addVirtualRow() / renderRows()（debounce 500ms）时，过滤出 tempId≠null + work_id=0 的虚拟行写入；
    //   清：提交成功 / 删除成功 / _cleared 标记时清除对应 draft；
    // 跨 tab 隔离：每个 (wh, wt) 独立存，互不污染（已修复上一轮跨 tab 污染 bug）。
    const DRAFT_STORAGE_KEY = 'erp_wh_drafts_v1';
    function _draftNs(wh, wt) { return wh + '::' + wt; }
    function _readDrafts(wh, wt) {
      try {
        const all = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}');
        const arr = Array.isArray(all[_draftNs(wh, wt)]) ? all[_draftNs(wh, wt)] : [];
        return arr.filter((r) => r && r.tempId && Number(r.work_id) === 0 && !r._cleared);
      } catch (e) { return []; }
    }
    let _draftSaveTimer = null;
    function _saveDrafts(wh, wt, rows) {
      clearTimeout(_draftSaveTimer);
      _draftSaveTimer = setTimeout(() => {
        try {
          const all = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}');
          const valid = rows.filter((r) => r && r.tempId && Number(r.work_id) === 0 && !r._cleared);
          if (valid.length) all[_draftNs(wh, wt)] = valid;
          else delete all[_draftNs(wh, wt)];
          localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(all));
        } catch (e) { /* quota exceeded 静默降级，不能阻塞主流程 */ }
      }, 500);
    }
    function _clearDraftNs(wh, wt) {
      try {
        const all = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}');
        delete all[_draftNs(wh, wt)];
        localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(all));
      } catch (e) { /* ignore */ }
    }
    // ★ 初始化恢复：新页面实例化时，把 localStorage 里保存的草稿拉进 lastRows
    const _bootDrafts = _readDrafts(state.warehouse, state.workType);
    if (_bootDrafts.length) state.lastRows = _bootDrafts;

    function todayStr() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // 轻提示：优先用全局 ERP.toast，未加载时降级为 alert
    function toast(msg, kind) {
      if (window.ERP && typeof window.ERP.toast === 'function') window.ERP.toast(msg, kind);
      else alert(msg);
    }

    // 阻塞式错误弹窗（替代 alert/toast error）
    // title: 弹窗标题；msg: 详细错误原因（可换行）；
    // options.confirmText: 主按钮文字（默认「确定」）；
    // options.blocking: true 时强制阻塞（必须点主按钮才能关闭，遮罩/ESC/关闭按钮均禁用）
    // 默认（blocking=false）支持：× 关闭按钮 + ESC + 点击遮罩 + 主按钮 四种关闭方式
    function errAlert(title, msg, options) {
      options = options || {};
      const blocking = !!options.blocking;
      // 自动注入 modal 样式（幂等，多次调用只注入一次）
      if (!document.getElementById('__wh_err_modal_css')) {
        const st = document.createElement('style');
        st.id = '__wh_err_modal_css';
        st.textContent = [
          '.wh-err-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99999;display:flex;align-items:center;justify-content:center;}',
          '.wh-err-modal{background:#fff;border-radius:8px;min-width:320px;max-width:520px;box-shadow:0 8px 24px rgba(0,0,0,.2);padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;overflow:hidden;display:flex;flex-direction:column;max-height:85vh;}',
          '.wh-err-modal .wh-err-head{display:flex;align-items:center;gap:8px;padding:14px 20px;border-bottom:1px solid #ebeef5;}',
          '.wh-err-modal .wh-err-head .wh-err-title{font-size:15px;color:#1f2329;font-weight:600;flex:1;display:flex;align-items:center;gap:8px;}',
          '.wh-err-modal .wh-err-head .wh-err-title::before{content:"";display:inline-block;width:16px;height:16px;border-radius:50%;background:#f56c6c;position:relative;flex-shrink:0;}',
          '.wh-err-modal .wh-err-head .wh-err-title::after{content:"!";position:absolute;color:#fff;font-weight:700;font-size:12px;line-height:16px;margin-left:-12px;}',
          '.wh-err-modal .wh-err-head .wh-close-btn{background:none;border:none;font-size:18px;color:#909399;cursor:pointer;padding:0 4px;line-height:1;width:28px;height:28px;border-radius:4px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;}',
          '.wh-err-modal .wh-err-head .wh-close-btn:hover{background:#f5f7fa;color:#606266;}',
          '.wh-err-modal .wh-err-body{padding:16px 20px;font-size:14px;color:#606266;white-space:pre-wrap;word-break:break-word;line-height:1.6;overflow-y:auto;}',
          '.wh-err-modal .wh-err-foot{padding:12px 20px;border-top:1px solid #ebeef5;text-align:right;}',
          '.wh-err-modal .wh-err-foot button{background:#409eff;color:#fff;border:none;border-radius:4px;padding:6px 18px;font-size:13px;cursor:pointer;}',
          '.wh-err-modal .wh-err-foot button:hover{background:#66b1ff;}'
        ].join('\n');
        document.head.appendChild(st);
      }
      const mask = document.createElement('div');
      mask.className = 'wh-err-mask';
      mask.innerHTML = `
        <div class="wh-err-modal" role="alertdialog" aria-modal="true">
          <div class="wh-err-head">
            <span class="wh-err-title">${escapeHtml(title || '出错了')}</span>
            ${blocking ? '' : '<button class="wh-close-btn" type="button" aria-label="关闭">×</button>'}
          </div>
          <div class="wh-err-body">${escapeHtml(msg == null ? '' : String(msg))}</div>
          <div class="wh-err-foot"><button type="button">${escapeAttr(options.confirmText || '确定')}</button></div>
        </div>`;

      let _esc = null;
      const close = () => {
        mask.remove();
        if (_esc) document.removeEventListener('keydown', _esc);
      };

      // 主按钮关闭 + 清理 ESC 监听
      const btn = mask.querySelector('button:not(.wh-close-btn)');
      btn.addEventListener('click', close);

      if (!blocking) {
        // 非阻塞：支持 × 按钮 + ESC + 遮罩点击 三种便捷关闭
        const closeBtn = mask.querySelector('.wh-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', close);
        mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
        _esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', _esc);
      } else {
        // 阻塞：ESC 被拦截但不关闭；遮罩点击只聚焦按钮
        _esc = (e) => { if (e.key === 'Escape') e.preventDefault(); };
        document.addEventListener('keydown', _esc);
        mask.addEventListener('click', (e) => { if (e.target === mask) btn.focus(); });
      }

      document.body.appendChild(mask);
      btn.focus();
    }

    // 二次确认弹窗（Promise 风格，可取消）：批量删除等不可逆操作专用
    // 支持两种调用签名：
    //   confirmDialog(title, msg, options) —— 传统三参数（批量删除用）
    //   confirmDialog({ title, message, okText, cancelText, confirmOnly, warn }) —— 单对象（导入确认用）
    function confirmDialog(a1, a2, a3) {
      let title, msg, options;
      if (a1 && typeof a1 === 'object' && !Array.isArray(a1)) {
        // 单对象签名：confirmDialog({ title, message, ... })
        options = a1;
        title = options.title || '';
        msg = options.message || options.msg || '';
      } else {
        // 传统三参数签名
        title = a1;
        msg = a2;
        options = a3 || {};
      }
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        // confirmOnly=true 时隐藏取消按钮（只留一个"跳过"按钮）
        const footHtml = options.confirmOnly
          ? `<button type="button" class="primary wh-ok" style="background:#409eff;border-color:#409eff">${escapeHtml(options.okText || '确认')}</button>`
          : `<button type="button" class="wh-cancel">${escapeHtml(options.cancelText || '取消')}</button>
             <button type="button" class="primary wh-ok" style="background:#e74c3c;border-color:#e74c3c">${escapeHtml(options.okText || '确认删除')}</button>`;
        overlay.innerHTML = `
          <div class="modal wh-confirm" style="min-width:360px">
            <div class="modal-head">
              <span>${escapeHtml(title)}</span>
              ${options.confirmOnly ? '' : '<button class="close" type="button">×</button>'}
            </div>
            <div class="modal-body">
              <p style="color:#606266;font-size:14px;margin:0 0 4px">${msg}</p>
              ${options.warn ? `<p style="color:#c23a1b;font-size:13px;margin:0;margin-top:8px">${escapeHtml(options.warn)}</p>` : ''}
            </div>
            <div class="modal-foot">${footHtml}</div>
          </div>`;
        document.body.appendChild(overlay);
        const close = (val) => { overlay.remove(); resolve(!!val); };
        const closeBtn = overlay.querySelector('.close');
        if (closeBtn) closeBtn.onclick = () => close(false);
        const cancelBtn = overlay.querySelector('.wh-cancel');
        if (cancelBtn) cancelBtn.onclick = () => close(false);
        overlay.querySelector('.wh-ok').onclick = () => close(true);
        overlay.onclick = (ev) => { if (ev.target === overlay) close(false); };
      });
    }

    // 将后端结构化错误（ex.status/code/detail/conflicts）转为用户友好消息
    // 支持单条重复、批量重复、其他异常三种分支
    function friendlyErrMsg(ex, fallbackMsg) {
      // 分支1：单条 DUPLICATE_ARCHIVED —— 用 date + shipper 拼精确提示
      if (ex && ex.code === 'DUPLICATE_ARCHIVED' && ex.detail) {
        const d = ex.detail;
        const label = d.shipper ? d.shipper : (d.project || '');
        const whoType = d.shipper ? '货主' : (d.project ? '项目' : '');
        const date = d.date || '';
        if (label && whoType) {
          return `当前提交失败：归档中已存在 ${date} 日期、${label} ${whoType}的对应数据，请核对后重新提交。`;
        }
      }
      // 分支2：批量 BATCH_DUPLICATE_ARCHIVED —— 列出前几条冲突详情
      if (ex && ex.code === 'BATCH_DUPLICATE_ARCHIVED' && ex.conflicts && ex.conflicts.length) {
        const lines = ex.conflicts.slice(0, 3).map((c) => {
          const d = c.detail || {};
          const who = d.shipper || d.project || '';
          const whoType = d.shipper ? '货主' : (d.project ? '项目' : '');
          return `· ${d.date || ''}、${who} ${whoType}`;
        });
        const more = ex.conflicts.length > 3 ? `\n... 共 ${ex.conflicts.length} 条冲突` : '';
        return `当前提交失败：归档中已存在以下数据，请核对后重新提交：\n${lines.join('\n')}${more}`;
      }
      // 分支3：带 detail 但 code 未知（兜底）
      if (ex && ex.detail && ex.detail.message) return ex.detail.message;
      // 分支4：纯 ex.message（其他 4xx/5xx）
      if (ex && ex.message) return ex.message;
      return fallbackMsg || '操作失败，请稍后重试';
    }

    // 虚拟行屏蔽：超管「删除」缺口行时，把 customer_id + date 组合存入 localStorage；
    // 下次 load() 时对当前仓库的缺口行自动过滤。键按仓库隔离（不同仓屏蔽互不影响）。
    const GAP_BLOCK_KEY = 'erp_gap_block_v1';
    function gapKeyOf(r) {
      // 屏蔽键只对缺口行（filled=0 + wid=0）生效；用 customer_id 或 customer_name + suggest_date/date
      const cid = r.customer_id != null && r.customer_id !== '' ? String(r.customer_id) : '_';
      const date = r.suggest_date || r.date || '';
      return cid + '|' + date;
    }
    function readGapBlocks(wh) {
      try { const all = JSON.parse(localStorage.getItem(GAP_BLOCK_KEY) || '{}'); return new Set(all[wh] || []); }
      catch (e) { return new Set(); }
    }
    function addGapBlock(wh, key) {
      try {
        const all = JSON.parse(localStorage.getItem(GAP_BLOCK_KEY) || '{}');
        (all[wh] = all[wh] || []).push(key);
        localStorage.setItem(GAP_BLOCK_KEY, JSON.stringify(all));
      } catch (e) { /* ignore */ }
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
      // 批量删除按钮：仅超管可见（checked.size=0 时自动 disabled）
      const delBtn = $('batchDelBtn');
      if (delBtn) delBtn.style.display = state.isSuper ? '' : 'none';
    }

    // 日期范围组件实例：对外产出 startDate/endDate，映射为后端 dateFrom/dateTo（后端零改动）
    let drp = null;
    function initDateRange() {
      const slot = $('drpSlot');
      if (!slot || !window.DateRangePicker) return;
      if (drp && drp.destroy) drp.destroy();
      drp = new DateRangePicker({
        mount: slot,
        mode: state.dateMode,
        startDate: state.dateFrom,
        endDate: state.dateTo,
        onChange: (v) => {
          state.dateFrom = v.startDate;
          state.dateTo = v.endDate;
          state.dateMode = v.mode || state.dateMode;
        }
      });
    }

    function shell() {
      c.innerHTML = `
      <div class="wh-page-title"><span class="wh-title-tag">${warehouse}</span><span class="wh-title-sep">-</span><span id="whTitleText">${state.workType}工时录入</span></div>
      <div class="wh-tabs" id="typeTabs"></div>
      <div class="wh-content-card">
      <div class="toolbar">
        <label class="wh-status-label">状态
          <select id="statusFilter" title="未归档 / 已归档 / 全部">
            <option value="pending" selected>未归档</option>
            <option value="archived">已归档</option>
            <option value="all">全部</option>
          </select>
        </label>
        <input id="q" placeholder="搜索客户名称">
        <span id="drpSlot"></span>
        <button id="qryBtn" class="primary">查询</button>
        <button id="resetBtn">重置</button>
        <span id="shipTools" style="display:none">
          <button id="templateBtn" title="下载带本仓货主的 Excel 模板">下载模板</button>
          <button id="importBtn" title="导入工时（重复项可确认覆盖/跳过）">导入工时</button>
        </span>
        <input type="file" id="importFile" accept=".xlsx,.xls" style="display:none">
        <button id="archiveBtn" title="批量提交勾选的工时（未填写行自动跳过）">批量提交</button>
        <button id="batchDelBtn" class="danger" style="display:none" title="批量删除勾选的记录（仅超级管理员可用，物理删除不可恢复）">批量删除</button>
        <button id="addBtn" class="primary">+ 新增工时</button>
      </div>
      <div class="wh-archive-tip" id="archiveTip" style="display:none"></div>
      <div class="wh-tbl-scroll">
      <table class="grid wh-table" id="whTable">
        <colgroup id="whColGroup"></colgroup>
        <thead><tr id="whHead"></tr></thead>
        <tbody id="whBody"><tr><td class="empty">加载中…</td></tr></tbody>
      </table>
      </div>
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

      // UI 联动：Tab 选中态 / 标题 / 搜索占位符 / 状态视图（导入导出按钮、归档按钮、提示条）
    function syncTabUI() {
      const tt = $('typeTabs');
      if (tt) tt.querySelectorAll('.wh-tab').forEach((t) => t.classList.toggle('active', t.dataset.tp === state.workType));
      const title = $('whTitleText');
      if (title) title.textContent = state.workType + '工时录入';
      const q = $('q');
      if (q) q.placeholder = (state.workType === '发货' || state.workType === '收货') ? '搜索客户名称' : '搜索项目名称';
      // 导入导出仅发货 tab 可见；归档按钮仅未归档视图可见；已归档视图显示动态权限提示
      const ship = $('shipTools');
      if (ship) ship.style.display = state.workType === '发货' ? 'inline' : 'none';
      const addBtn = $('addBtn');
      // 发货 Tab 隐藏"新增工时"按钮——发货有缺口行机制，不需要手动新增
      if (addBtn) addBtn.style.display = state.workType === '发货' ? 'none' : '';
      const arcBtn = $('archiveBtn');
      if (arcBtn) arcBtn.style.display = state.status === 'pending' ? '' : 'none';
      const tip = $('archiveTip');
      if (tip) {
        if (state.status === 'archived') {
          if (state.isSuper) tip.textContent = '您是超级管理员，可修改归档记录、修改提交人、永久删除';
          else if (state.isAdmin) tip.textContent = '您是管理员，可修改归档记录、修改提交人；不可永久删除（仅限超级管理员）';
          else tip.textContent = '已归档记录：您可修改自己提交的、撤回自己提交的；他人提交的仅查看';
          tip.style.display = '';
        } else {
          tip.style.display = 'none';
        }
      }
    }

    function bindToolbar() {
      $('q').value = state.q;
      $('statusFilter').value = state.status;
      const syncDates = () => { if (drp) { const v = drp.getValue(); state.dateFrom = v.startDate; state.dateTo = v.endDate; } };
      $('qryBtn').onclick = () => { syncDates(); readFilters(); state.page = 1; load(); };
      $('resetBtn').onclick = () => {
        state.q = '';
        // ★ 重置回到「当前 mode 对应的默认范围」—— 用户切到按周后再重置，不应把他打回按日
        const defRange = RANGE_BY_MODE[state.dateMode] || RANGE_BY_MODE.day;
        state.dateFrom = defRange.start;
        state.dateTo = defRange.end;
        state.status = 'pending';
        state.checked.clear();
        state.page = 1;
        $('q').value = '';
        $('statusFilter').value = 'pending';
        if (drp) drp.setValue({ mode: state.dateMode, startDate: state.dateFrom, endDate: state.dateTo }, true);
        syncTabUI();
        load();
      };
      $('statusFilter').onchange = (e) => {
        state.status = e.target.value; state.page = 1; state.checked.clear();
        syncTabUI(); load();
      };
      // ★ 需求一：新增一律走「表格行内新增」，彻底取消新增弹窗。
      //   未归档视图 → 直接在数据源顶部插入虚拟行；已归档视图 → 自动切回未归档再插入。
      $('addBtn').onclick = async () => {
        if (state.status !== 'pending') {
          state.status = 'pending';
          $('statusFilter').value = 'pending';
          state.checked.clear();
          syncTabUI();
          await load();
        }
        addVirtualRow();
      };
      $('templateBtn').onclick = onDownloadTemplate;
      $('importBtn').onclick = () => $('importFile').click();
      $('importFile').onchange = onImportFile;
      $('archiveBtn').onclick = onBatchSubmit;
      $('batchDelBtn').onclick = onBatchDelete;
      // 点「批量提交」时 pointerdown 先于 blur：有勾选时跳过聚焦行的失焦自动保存，
      // 交由批量提交统一读取当前输入值再保存（避免重复写入 / 旧值覆盖）
      $('archiveBtn').addEventListener('pointerdown', () => {
        if (!state.checked.size) return;
        const a = document.activeElement;
        const tr = a && a.closest ? a.closest('tr[data-row-wid]') : null;
        if (tr) tr.dataset.skipBlurSave = '1';
      }, true);
      ['q'].forEach((id) => ($(id).onkeydown = (e) => { if (e.key === 'Enter') { syncDates(); readFilters(); state.page = 1; load(); } }));
      syncTabUI();
    }

    // 下载发货模板（带本仓货主）
    function onDownloadTemplate() {
      API.download('/workhours/template?warehouse=' + encodeURIComponent(state.warehouse) + '&work_type=' + encodeURIComponent('发货'),
        '发货工时导入模板_' + state.warehouse + '.xlsx')
        .catch((ex) => errAlert('下载模板失败', ex.message));
    }

    // 行内新增：在数据源顶部插入一条带默认值的虚拟空行（tempId 标识，取消/提交后移除）
    function addVirtualRow() {
      const type = state.workType;
      const today = todayStr();
      const base = {
        // ★ Bug#1 修复：给虚拟行加唯一 tempId（时间戳+随机），DOM 不再靠 work_id=0 做 key
        tempId: 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        work_id: 0, filled: 1, status: 'pending', submitter: null, submit_time: null,
        warehouse: state.warehouse, work_type: type, date: today, suggest_date: today, need_backfill: 0,
        remark: '', main_hours: '', other_hours: '', total_hours: '', efficiency: '',
      };
      if (type === '发货' || type === '收货') {
        base.customer_id = ''; base.customer_name = ''; base.customer_status = '启用';
        base.unit = '';
        if (type === '发货') base.ship_orders = '';
        if (type === '收货') { base.cartons = ''; base.tons = ''; base.cubic = ''; base.pallets = ''; }
      } else {
        base.project = '';
        if (type === '库内') base.unit = '';
      }
      // ★ Bug#3 修复：每次展开全新独立对象，绝不用共用引用
      state.lastRows.unshift({ ...base });
      renderRows();
      _saveDrafts(state.warehouse, state.workType, state.lastRows);
      // 聚焦首个可输入控件（日期），让用户直接开填
      const first = $('whBody').querySelector('tr[data-row-idx] input[data-if="date"]');
      if (first) first.focus();
    }

    // 导入：选文件 → 预览检测重复 → 弹窗逐条确认覆盖/跳过 → 执行
    let pendingImport = null; // 暂存预览结果，供确认弹窗提交
    async function onImportFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!/\.(xlsx|xls)$/i.test(file.name)) { errAlert('文件格式错误', '请选择 .xlsx / .xls 文件'); return; }
      const fd = new FormData();
      fd.append('file', file);
      let preview;
      try {
        preview = await API.upload('/workhours/import/preview?warehouse=' + encodeURIComponent(state.warehouse), fd);
      } catch (ex) { errAlert('导入预览失败', ex.message); return; }
      const rows = preview.data || [];
      const errors = preview.errors || [];
      if (!rows.length) { errAlert('导入预览失败', '没有可导入的数据行' + (errors.length ? '\n' + errors.map((x) => `第${x.line}行：${x.error}`).join('\n') : '')); return; }
      pendingImport = { file, rows, errors, preview };
      openImportConfirm(pendingImport);
    }

    // 批量提交：勾选行 → 过滤未填写 → 保存行内当前输入 → 一次性归档
    // 铁律：只处理「被勾选且已填写」的记录；未勾选记录与已归档记录一律不受影响。
    // 与 bindInlineRow.persist() 的 hasAny 口径一致，避免前端批量提交与单行保存规则冲突。
    function rowFilled(id) {
      const type = state.workType;
      const tr = $('whBody').querySelector('tr[data-row-wid="' + id + '"]');
      if (tr) {
        const v = (k) => (tr.querySelector('[data-if="' + k + '"]') || {}).value || '';
        const main = Number(v('main_hours')) || 0, other = Number(v('other_hours')) || 0, remark = v('remark').trim();
        if (type === '发货') {
          const ship = Number(v('ship_orders')) || 0;
          return (ship > 0) || (main > 0) || !!remark;
        }
        if (type === '收货') {
          const c = Number(v('cartons')) || 0, t = Number(v('tons')) || 0, cu = Number(v('cubic')) || 0, p = Number(v('pallets')) || 0;
          return (c > 0) || (t > 0) || (cu > 0) || (p > 0) || (main > 0) || !!remark;
        }
        if (type === '库内' || type === '后勤') {
          const proj = v('project');
          return !!proj || (main > 0) || (other > 0) || !!remark;
        }
      }
      // 兜底：从 state.lastRows 读（发货批量提交的非 inline 场景）
      const row = (state.lastRows || []).find((x) => Number(x.work_id) === Number(id));
      if (!row) return true;
      const ship = Number(row.ship_orders) || 0, m = Number(row.main_hours) || 0, rk = (row.remark || '').trim();
      return (ship > 0) || (m > 0) || !!rk;
    }

    // ★ 问题一：重复数据校验 —— 同一「日期 + 客户」（库内/后勤为「日期 + 项目」）出现 ≥2 行即重复
    // 只统计已填写且已选客户/项目的行；key 带 work_type 防跨类型误判
    function dupKeyOf(idx) {
      const row = state.lastRows[idx] || {};
      const tr = $('whBody').querySelector('tr[data-row-idx="' + idx + '"]');
      const dateEl = tr ? tr.querySelector('[data-if="date"]') : null;
      const date = (dateEl && dateEl.value) || row.date || row.suggest_date || '';
      let who = '';
      if (state.workType === '库内' || state.workType === '后勤') {
        const projEl = tr ? tr.querySelector('[data-if="project"]') : null;
        who = 'p:' + ((projEl && projEl.value) || row.project || '');
      } else {
        // 收货行内选择客户后 tr.dataset.rowCid 实时维护；发货/其余以行数据 cid 为准
        who = 'c:' + ((tr && tr.dataset.rowCid) || row.customer_id || '');
      }
      return state.workType + '|' + date + '|' + who;
    }
    function findDupGroups() {
      const map = new Map();
      state.lastRows.forEach((row, idx) => {
        const tr = $('whBody').querySelector('tr[data-row-idx="' + idx + '"]');
        if (!tr) return;
        // 未填任何内容、或未选客户/项目的行不参与判重
        const hasVal = [...tr.querySelectorAll('[data-if]')].some((e) => String(e.value || '').trim() !== '');
        if (!hasVal) return;
        const key = dupKeyOf(idx);
        const who = key.split('|')[2];
        if (who === 'c:' || who === 'p:') return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(idx);
      });
      return [...map.entries()].filter(([, v]) => v.length > 1);
    }
    // 标红重复行：整行浅红底 + 日期/客户(项目)输入框红框；保存成功重渲染后自动清除
    function markDupRows(groups) {
      $('whBody').querySelectorAll('tr.wh-dup').forEach((tr) => {
        tr.classList.remove('wh-dup');
        tr.querySelectorAll('.wh-cell-invalid').forEach((e) => e.classList.remove('wh-cell-invalid'));
      });
      const idxSet = new Set();
      groups.forEach(([, v]) => v.forEach((i) => idxSet.add(i)));
      idxSet.forEach((idx) => {
        const tr = $('whBody').querySelector('tr[data-row-idx="' + idx + '"]');
        if (!tr) return;
        tr.classList.add('wh-dup');
        const dateEl = tr.querySelector('[data-if="date"]');
        const whoEl = tr.querySelector('[data-if="customer_name_cid"], [data-if="project"]');
        if (dateEl) dateEl.classList.add('wh-cell-invalid');
        if (whoEl) whoEl.classList.add('wh-cell-invalid');
      });
    }
    function dupToastMsg(key) {
      const parts = key.split('|');
      const whoLabel = (state.workType === '库内' || state.workType === '后勤') ? '该项目' : '该客户';
      return whoLabel + '在 [' + (parts[1] || '') + '] 已有工时记录，请勿重复录入！';
    }

    // ---------- 批量删除（仅超级管理员）----------
    // 前端做二次确认（弹窗明确显示数量）→ 调 DELETE /workhours/batch → 成功后清空勾选并刷新列表
    async function onBatchDelete() {
      if (!state.isSuper) { errAlert('权限不足', '仅超级管理员可批量删除'); return; }
      const ids = [...state.checked].map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) { errAlert('批量删除失败', '请先勾选要删除的记录'); return; }
      // 二次确认弹窗：带数量 + 物理删除不可恢复警告
      const ok = await confirmDialog(
        `批量删除 ${ids.length} 条工时记录`,
        `确认删除勾选的 ${ids.length} 条工时记录？此操作不可恢复，将物理删除数据库中的对应行。`
      );
      if (!ok) return;
      try {
        const res = await API.del('/workhours/batch', { ids, warehouse: state.warehouse });
        const deleted = res.deleted || 0;
        const nf = res.notFound || 0;
        state.checked.clear();
        toast(`已删除 ${deleted} 条记录` + (nf ? `，跳过 ${nf} 条不存在/跨仓的记录` : ''));
        state.page = 1; load();
      } catch (ex) {
        errAlert('批量删除失败', friendlyErrMsg(ex));
      }
    }

    async function onBatchSubmit() {
      const ids = [...state.checked].map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) { errAlert('批量提交失败', '请先勾选需要提交的数据'); return; }
      const validIds = ids.filter(rowFilled);
      const skipped = ids.length - validIds.length;
      if (!validIds.length) { errAlert('批量提交失败', '勾选的数据尚未填写，无法提交'); return; }
      // ★ 问题一：批量提交查重 —— 勾选行中存在「日期+客户(项目)」重复时，标红全部重复行并拦截
      const widSet = new Set(validIds);
      const dupGroups = findDupGroups().filter(([, v]) => v.some((i) => {
        const row = state.lastRows[i];
        return row && widSet.has(Number(row.work_id) || 0);
      }));
      if (dupGroups.length) {
        markDupRows(dupGroups);
        errAlert('批量提交失败', dupToastMsg(dupGroups[0][0]) + '（已标红 ' + dupGroups.reduce((n, [, v]) => n + v.length, 0) + ' 行重复数据）');
        return;
      }
      if (!confirm(`确认批量提交勾选的 ${validIds.length} 条工时记录？提交后将归档，不再显示在未归档列表。`)) return;
      try {
        // 1) 逐条保存行内当前输入（★ 需求一：所有类型的编辑行都统一保存，不再仅发货；
        //    各行值不同必须逐行写；只写勾选且有效的行）
        for (const id of validIds) {
          const tr = $('whBody').querySelector('tr[data-row-wid="' + id + '"]');
          if (tr && tr.querySelector('[data-if]')) {
            await API.put('/workhours/' + id, inlinePayloadOf(tr));
          }
        }
        // 2) 一次批量归档（后端 UPDATE ... WHERE work_id IN (...)，避免 N 次状态更新往返）
        const r = await API.post('/workhours/batch-submit', {
          warehouse: state.warehouse, work_type: state.workType, ids: validIds,
        });
        const n = Number(r.submitted) || 0;
        const y = skipped + (Number(r.skipped) || 0);
        state.checked.clear();
        toast(`成功批量提交 ${n} 条记录，已自动跳过 ${y} 条未填写记录`);
        load();
      } catch (ex) { errAlert('批量提交失败', friendlyErrMsg(ex)); }
    }

    // 导入确认弹窗：前端只展示三态预览结果，后端自主判定规则 1-4
    // 行级标签：create=新增 / skip_exact=完全相同·跳过 / overwrite=有差异·覆盖
    // 底部两个按钮：取消 + 导入。不传 decisions/forceArchive，后端自己做 PRECHECK
    function openImportConfirm(ctx) {
      const { rows, errors, preview } = ctx;
      const stats = preview.stats || { create: 0, skip_exact: 0, overwrite: 0 };

      const rowsHtml = rows.map((r) => {
        const act = r.action; // 'create' | 'promote_pending' | 'skip_exact' | 'overwrite'
        const ex = r.existing;
        let tag, cls;
        if (act === 'skip_exact') { tag = '完全相同·跳过'; cls = 'imp-skip-exact'; }
        else if (act === 'skip_batch_dup') { tag = '文件内重复·跳过'; cls = 'imp-skip-exact'; }
        else if (act === 'overwrite') { tag = '有差异·覆盖'; cls = 'imp-overwrite'; }
        else if (act === 'promote_pending') { tag = '提交草稿'; cls = 'imp-create'; }
        else { tag = '新增'; cls = 'imp-create'; }
        const exTxt = ex
          ? (act === 'promote_pending'
            ? `已有未归档草稿：${ex.ship_orders || 0} 单 / ${ex.main_hours || 0}h`
            : `已有：${ex.ship_orders || 0} 单 / ${ex.main_hours || 0}h（已归档）`)
          : '';
        return `<tr class="imp-${act}">
          <td>${r.line}</td>
          <td>${escapeHtml(r.date)}</td>
          <td>${escapeHtml(r.customer_name)}</td>
          <td>${r.ship_orders == null || r.ship_orders === '' ? '-' : Math.round(Number(r.ship_orders))}</td>
          <td>${r.main_hours}</td>
          <td>${exTxt ? '<span class="cust-tag cust-tag-warn">' + (act === 'promote_pending' ? '未归档' : '归档') + '</span> ' + escapeHtml(exTxt) : '—'}</td>
          <td><span class="imp-action-tag ${cls}">${tag}</span></td>
        </tr>`;
      }).join('');

      const errHtml = errors.length
        ? `<div class="imp-errors"><b>${errors.length} 行被忽略：</b><br>` + errors.map((x) => `第 ${x.line} 行：${escapeHtml(x.error)}`).join('<br>') + '</div>'
        : '';

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal imp-confirm">
          <div class="modal-head">
            <span>导入预览 · 共 ${rows.length} 行</span>
            <button class="close" type="button">×</button>
          </div>
          <div class="modal-body">
            <div class="imp-alert">
              后端已检测出数据状态，导入操作将在单个事务内完成，任意一行失败则整体回滚。
            </div>
            <div class="imp-summary">
              <span>共 <span class="cnt">${rows.length}</span> 行</span>
              ${stats.create ? `<span>新增 <span class="cnt cnt-new">${stats.create}</span> 行</span>` : ''}
              ${stats.promote_pending ? `<span>提交草稿 <span class="cnt cnt-new">${stats.promote_pending}</span> 行</span>` : ''}
              ${stats.skip_exact ? `<span>完全相同 <span class="cnt cnt-skipexact">${stats.skip_exact}</span> 行</span>` : ''}
              ${stats.skip_batch_dup ? `<span>文件内重复 <span class="cnt cnt-skipexact">${stats.skip_batch_dup}</span> 行</span>` : ''}
              ${stats.overwrite ? `<span>有差异需覆盖 <span class="cnt cnt-overwrite">${stats.overwrite}</span> 行</span>` : ''}
            </div>
            <div class="imp-grid-wrap">
              <table class="imp-grid">
                <thead><tr>
                  <th style="width:52px">行号</th>
                  <th style="width:100px">日期</th>
                  <th>客户名称</th>
                  <th style="width:90px">发货单量</th>
                  <th style="width:90px">主工时</th>
                  <th>归档记录</th>
                  <th style="width:140px">处理方式</th>
                </tr></thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>
            ${errHtml}
          </div>
          <div class="modal-foot">
            <button type="button" class="imp-cancel">取消</button>
            <button type="button" class="primary imp-ok" style="margin-left:auto">导入</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const close = () => overlay.remove();
      overlay.querySelector('.close').onclick = close;
      overlay.querySelector('.imp-cancel').onclick = close;
      overlay.onclick = (ev) => { if (ev.target === overlay) close(); };

      // 导入按钮 — 二次确认逻辑：
      //   rule=1 全部新增/提交草稿 → 直接发请求（静默执行，不弹窗）
      //   rule=2 全部完全相同       → 幂等提示（不写库、不报错），可选跳转已归档查看
      //   rule=3 全 overwrite / rule=4 混合 → 弹标准 confirmDialog（取消+确认），用户确认后才发请求
      // 统一：把用户带到「已归档」视图对应日期（避免「导入成功却查不到」的误解）
      const gotoArchived = async (dates) => {
        const covered = !!(state.dateFrom && state.dateTo && dates.length)
          && dates.every((d) => d >= state.dateFrom && d <= state.dateTo);
        if (!dates.length || (covered && state.status === 'archived')) {
          state.page = 1; load(); return;
        }
        const go = await confirmDialog({
          title: '导入完成',
          message: `本次数据已归档在 <b>${dates.join('、')}</b>。<br><br>是否切换到「已归档」视图查看？`,
          okText: '查看已归档',
          cancelText: '留在当前页',
        });
        if (go) {
          state.status = 'archived';
          const sf = $('statusFilter'); if (sf) sf.value = 'archived';
          state.dateMode = 'day';
          state.dateFrom = dates[0];
          state.dateTo = dates[dates.length - 1];
          if (drp) drp.setValue({ mode: 'day', startDate: state.dateFrom, endDate: state.dateTo }, true);
          syncTabUI();
        }
        state.page = 1; load();
      };

      overlay.querySelector('.imp-ok').onclick = async () => {
        const s = preview.stats; // { create, promote_pending, skip_exact, overwrite, rule }
        const fmtMsg = () => {
          const parts = [];
          if (s.create) parts.push(`<span style="color:#67c23a"><b>新增 ${s.create}</b> 条</span>`);
          if (s.promote_pending) parts.push(`<span style="color:#67c23a"><b>提交草稿 ${s.promote_pending}</b> 条（替换未归档草稿）</span>`);
          if (s.skip_exact) parts.push(`<span style="color:#909399"><b>跳过 ${s.skip_exact}</b> 条（与归档完全一致）</span>`);
          if (s.overwrite) parts.push(`<span style="color:#e6a23c"><b>覆盖 ${s.overwrite}</b> 条（字段有差异）</span>`);
          return parts.join('<br>') || '无数据';
        };

        // 规则 2：全部与已归档完全一致 → 幂等成功提示（不是报错，也不写库）
        if (s.rule === 2) {
          close();
          const dupDates = [...new Set(rows.map((r) => r.date))].sort();
          toast(`无需重复导入：${s.skip_exact} 行数据已在 ${dupDates.join('、')} 归档`);
          await gotoArchived(dupDates);
          return;
        }

        // 规则 3 或 4：有 overwrite 或混合 → 弹二次确认
        if (s.rule === 3 || s.rule === 4) {
          const ok = await confirmDialog({
            title: '确认导入操作',
            message: `本次导入将处理以下数据：<br><br>${fmtMsg()}<br><br>请确认是否继续执行？`,
            okText: '确认导入',
            cancelText: '取消',
            warn: s.overwrite ? `覆盖操作将删除归档库中的原记录并写入新数据，此操作不可撤销。` : '',
          });
          if (!ok) return; // 用户取消 → 留在预览弹窗，允许改 Excel 重传
        }

        // 规则 1（全新增/提交草稿）或规则 3/4 用户已确认 → 发请求
        close();
        try {
          const fd = new FormData();
          fd.append('file', ctx.file);
          const res = await API.upload('/workhours/import?warehouse=' + encodeURIComponent(state.warehouse), fd);
          const dates = Array.isArray(res.dates) ? res.dates : [];
          // 后端幂等分支（并发/重试导致 preview 与 import 判定不一致时的兜底）
          if (res.noop) {
            toast(res.message || '数据已是最新，无需重复导入');
            await gotoArchived(dates);
            return;
          }
          let msg = `已归档 ${res.created || 0} 行`;
          if (res.promoted) msg += `，提交草稿 ${res.promoted} 行`;
          if (res.overwritten) msg += `，覆盖 ${res.overwritten} 行`;
          if (res.skip_exact) msg += `，跳过 ${res.skip_exact} 行（与归档完全一致）`;
          if (res.repaired_duplicates) msg += `，修复重复记录 ${res.repaired_duplicates} 条`;
          if (dates.length) msg += `（日期 ${dates.join('、')}）`;
          if (res.errors && res.errors.length) msg += `，忽略 ${res.errors.length} 行格式不匹配`;
          toast(msg);
          await gotoArchived(dates);
        } catch (ex) {
          errAlert('导入失败', friendlyErrMsg(ex));
        }
      };
    }
    // ---------- 客户名校验（收货工时：只允许客户列表里的名称） ----------
    // 以行内 datalist 为准，保证「看到的选项」和「校验的数据源」完全一致。
    function customerOptionOf(input) {
      if (!input) return null;
      const v = String(input.value || '').trim();
      if (!v) return null;
      const dl = input.getAttribute('list') ? document.getElementById(input.getAttribute('list')) : null;
      if (!dl) return null;
      const norm = (s) => String(s || '').replace(/\s*\((已停用|已删除)\)\s*$/, '').trim();
      return [...dl.options].find((o) => (o.value || '').trim() === v)
          || [...dl.options].find((o) => norm(o.value) === norm(v))
          || null;
    }

    function setCustomerInvalid(input, bad) {
      if (!input) return;
      input.classList.toggle('wh-cell-invalid', !!bad);
      if (bad) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }

    function readFilters() {
      state.q = $('q').value.trim();
      // 日期由 drp 组件的 onChange 同步；查询按钮/回车另经 syncDates() 兜底读取
    }

    async function load() {
      // ★ 性能优化：接口时序拆分
      // （1）refreshRole 和 workhours 核心表格并发发起（之前是串行 await refreshRole 再 Promise.all）
      // （2）/customers/options 下拉框数据剥离到 requestIdleCallback 延迟加载
      //   —— 之前 3 次串行 200ms → 总计 500-800ms 白屏
      //   —— 现在并发核心接口 300ms 出表格 → 下拉框空闲时加载，用户不感知
      const draftsMem = (state.status === 'pending')
        ? state.lastRows.filter((r) => r.tempId && Number(r.work_id) === 0 && r.work_type === state.workType)
        : [];
      const saved = _readDrafts(state.warehouse, state.workType);
      const seen = new Set(draftsMem.map((r) => r.tempId));
      const drafts = draftsMem.concat(saved.filter((r) => !seen.has(r.tempId)));
      const params = new URLSearchParams({ warehouse: state.warehouse, work_type: state.workType, status: state.status, page: state.page, pageSize: state.pageSize });
      if (state.q) params.set('q', state.q);
      if (state.dateFrom) params.set('dateFrom', state.dateFrom);
      if (state.dateTo) params.set('dateTo', state.dateTo);
      const [, r] = await Promise.all([
        refreshRole(),
        API.get('/workhours?' + params.toString()),
      ]);
      state.lastRows = r.data || [];
      state.lastTotal = r.total || 0;
      // 合并草稿到顶部
      if (drafts.length && state.status === 'pending') {
        state.lastRows = drafts.concat(state.lastRows);
      }
      renderRows();
      renderPager(state.lastTotal, r.page || 1, r.pageSize || state.pageSize);

      // ★ 非核心接口：下拉框数据 idle 时加载（不阻塞核心表格渲染）
      const _loadCustomers = async () => {
        try {
          const cResp = await API.get('/customers/options?warehouse=' + encodeURIComponent(state.warehouse));
          state.customers = cResp.data || [];
          // 下拉框 options 异步刷新（重渲染整个表格太浪费，只更新 select option）
          const selects = document.querySelectorAll('#whBody select[data-if="customer_name"], #whBody select[data-if="customer"]');
          if (selects.length) {
            const opts = (state.customers || []).map((c) => `<option value="${c.company_name}">${c.company_name}</option>`).join('');
            selects.forEach((sel) => {
              const cur = sel.value;
              sel.innerHTML = '<option value="">—</option>' + opts;
              if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
            });
          }
        } catch (e) { state.customers = []; }
      };
      if ('requestIdleCallback' in window) {
        requestIdleCallback(_loadCustomers, { timeout: 2500 });  // 最多等 2.5s 空闲
      } else {
        setTimeout(_loadCustomers, 300);  // 兜底：300ms 后跑
      }
    }

      // 统一渲染表头+表体（load 与行内编辑局部重绘共用）
      function renderRows() {
        renderHead();
        let rows = state.lastRows;
        // 虚拟行屏蔽：只读当前仓的 gap_block 集合，过滤掉已超管屏蔽的发货缺口行
        if (state.workType === '发货' && state.status === 'pending') {
          const blocks = readGapBlocks(state.warehouse);
          if (blocks.size) rows = rows.filter((r) => !(r.filled === 0 && blocks.has(gapKeyOf(r))));
        }
        state._shownRows = rows;
        const _showCkCol = (state.workType === '发货' && state.status === 'pending') || state.isSuper;
        const span = COLUMNS[state.workType].length + (_showCkCol ? 2 : 1);
        // 传 idx 给 rowHtml，rowHtml 在 inline 分支加 data-row-idx 属性
        $('whBody').innerHTML = rows.length
          ? rows.map((r) => rowHtml(r, state._shownRows.indexOf(r))).join('')
          : `<tr><td colspan="${span}" class="empty">${state.status === 'archived' ? '暂无已归档记录' : '暂无工时记录，点击右上角「新增工时」开始录入'}</td></tr>`;
        // 所有 pending 行都行内直编（含收货/库内/后勤）；已归档行只读
        if (state.status === 'pending') {
          $('whBody').querySelectorAll('tr[data-row-idx]').forEach(bindInlineRow);
        }
        // ★ 草稿持久化：每次渲染后 debounce 保存当前虚拟行到 localStorage；
        //   行内编辑 blur → updateRow → renderRows → debounce 保存，闭环。
        if (state.status === 'pending') {
          _saveDrafts(state.warehouse, state.workType, state.lastRows);
        }
      }

    // 行内直编的列宽（px）：table-layout:fixed + colgroup 锁死，输入框 width:100% 贴合列宽
    // ★★★ 2026-11-20 根因修复：本数组 **不含勾选列**，勾选列宽度由 renderHead() 按需前置拼装。
    //   历史 bug：数组里写死了勾选列（只有发货有），导致超管在所有类型都出现勾选列时
    //   widths.length !== needCols → 一致性校验失败 → colgroup 被清空 → 退回浏览器自动均分列宽
    //   → 日期列被压到 ~110px → input[type=date] 的 yyyy-mm-dd 末位被日历图标挤掉（显示 2026/11/2◢）。
    // 顺序与 COLUMNS 严格一致：日期 → [客户/项目] → 数值 → 备注 → 提交人 → 操作
    const CK_COL_WIDTH = 34;   // 勾选列固定宽度
    const INLINE_WIDTHS = {
      // 日期170 客户190 单位46 单量58 主工时62 时效56 其他62 备注100 提交人46 操作132
      发货: [170, 190, 46, 58, 62, 56, 62, 100, 46, 132],
      // 日期170 客户185 箱数56 吨46 方46 托盘52 主工时62 其他62 备注100 提交人46 操作132
      收货: [170, 185, 56, 46, 46, 52, 62, 62, 100, 46, 132],
      // 日期170 项目190 作业量62 单位46 主工时62 其他62 备注100 提交人46 操作132
      库内: [170, 190, 62, 46, 62, 62, 100, 46, 132],
      // 日期170 项目190 主工时62 其他62 备注100 总工时62 提交人46 操作132
      后勤: [170, 190, 62, 62, 100, 62, 46, 132],
    };

    function renderHead() {
      const cols = COLUMNS[state.workType];
      // 勾选列显示条件（列数/表头/行渲染三处必须完全一致，统一用这个变量）
      //   a) 历史批量提交：发货 + pending（所有用户）
      //   b) 新增批量删除：超管在所有 work_type × 所有 status 下都能勾选（包括 archived / all）
      const showCkCol = (state.workType === '发货' && state.status === 'pending') || state.isSuper;
      // 所有 pending 行都行内直编：统一开 wh-inline-grid（table-layout:fixed），
      // 但只给发货锁精细列宽；收货/库内/后勤用 colgroup 空 → 浏览器均匀分配
      const inline = state.status === 'pending';
      const table = $('whTable');
      if (table) table.classList.toggle('wh-inline-grid', inline);
      const cg = $('whColGroup');
      if (cg) {
        // ★ 列数一致性保护：colgroup 宽度项必须与「数据列 + 勾选列 + 操作列」完全一致，
        //   否则多出的 <col> 会撑出一个空表头列（历史错位问题的根因）。不一致直接退回自动布局。
        // ★ 2026-11-20 修复：INLINE_WIDTHS 不含勾选列，这里按 showCkCol 动态前置 CK_COL_WIDTH，
        //   保证超管（任意类型都有勾选列）也能命中固定列宽，日期列不会被压窄。
        const ckCols = showCkCol ? 1 : 0;
        const base = INLINE_WIDTHS[state.workType];
        const okLen = base && base.length === cols.length + 1; // 数据列 + 操作列
        if (inline && okLen) {
          const widths = (ckCols ? [CK_COL_WIDTH] : []).concat(base);
          cg.innerHTML = widths.map((w) => `<col style="width:${w}px">`).join('');
        } else {
          cg.innerHTML = '';
        }
      }
      // ★ 必填项星号（三个类型各自的必填列）
      const REQ_MAP = {
        收货: new Set(['date', 'customer_name', 'cartons', 'main_hours']),
        库内: new Set(['date', 'project', 'main_hours']),
        后勤: new Set(['date', 'project', 'main_hours']),
      };
      // 生成表头勾选列（超管在所有视图 / 批量提交在发货pending → 都有勾选）
      const ck = showCkCol
        ? '<th class="wh-ck"><input type="checkbox" id="ckAll" title="勾选本页全部"></th>' : '';
      const REQ_COLS = REQ_MAP[state.workType] || new Set();
      $('whHead').innerHTML = ck + cols.map((col) => {
        const star = REQ_COLS.has(col.key) ? '<span class="req-star">*</span> ' : '';
        return `<th class="${col.num ? 'num' : ''}">${star}${col.label}</th>`;
      }).join('') + '<th class="ops-head">操作</th>';
      if (showCkCol) {
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
      const OPTIONS = [20, 50, 100, 200, 500, 1000];
      const isCustom = OPTIONS.indexOf(size) < 0;
      const selHtml = OPTIONS.map((n) =>
        `<option value="${n}" ${n === size ? 'selected' : ''}>${n}条/页</option>`
      ).join('');
      const p = $('pager');
      p.innerHTML = `
        共 ${total} 条 · 第 ${cur}/${pages} 页
        <select id="pageSizeSel" title="每页行数" style="margin-left:12px;padding:2px 6px;border:1px solid var(--line);border-radius:4px;font-size:12px;background:var(--bg);color:var(--text)">
          ${selHtml}
        </select>`;
      const prev = document.createElement('button');
      prev.textContent = '上一页'; prev.disabled = cur <= 1; prev.onclick = () => { state.page = cur - 1; load(); };
      const next = document.createElement('button');
      next.textContent = '下一页'; next.disabled = cur >= pages; next.onclick = () => { state.page = cur + 1; load(); };
      p.appendChild(prev); p.appendChild(next);
      const sel = p.querySelector('#pageSizeSel');
      if (sel) sel.onchange = (e) => { state.pageSize = Number(e.target.value); state.page = 1; load(); };
    }

    function trendCell(val, t, fmt) {
      const f = fmt || num;
      if (!t) return `<td class="num">${f(val)}</td>`;
      const arrow = t.deltaPct == null ? '<span class="trend flat">—</span>'
        : `<span class="trend ${t.dir}">${t.dir === 'up' ? '▲' : t.dir === 'down' ? '▼' : '—'}${Math.abs(t.deltaPct).toFixed(1)}%</span>`;
      return `<td class="num">${f(val)} ${arrow}</td>`;
    }
    // 发货单量整型格式化（禁止出现小数位）
    function intFmt(x) {
      if (x == null || x === '') return '-';
      const n = Number(x);
      return Number.isFinite(n) ? String(Math.round(n)) : '-';
    }

    // 缺口行单/件/箱单位下拉（行内编辑用）：sel 为空时给一个「—」占位，保持真正未选状态
    function unitOptions(sel) {
      const ph = `<option value="" ${!sel ? 'selected' : ''}>—</option>`;
      return ph + ['单', '件', '箱'].map((u) => `<option value="${u}" ${u === sel ? 'selected' : ''}>${u}</option>`).join('');
    }

    function projectOptions(type, sel, placeholder) {
      const ph = placeholder || '—';
      const list = PROJECT_OPTIONS[type] || [];
      // ★ 需求二：占位项 disabled + hidden —— 下拉列表只显示实际可选项（上架/补货…），
      //   占位文字不可点击选中；未选择时闭合框显示占位文字（配合 required + :invalid 呈灰色）
      return `<option value="" disabled${!sel ? ' selected' : ''} hidden>${escapeHtml(ph)}</option>`
        + list.map((p) => `<option value="${escapeAttr(p)}" ${p === sel ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
    }

    function rowHtml(r, idx) {
      const cols = COLUMNS[state.workType];
      const trend = r.trend || null;
      // 所有 pending 行都行内直编（含收货/库内/后勤），发货保留缺口行(wid=0)机制；
      // 已归档行保持只读（走下面非 inline 分支）。
      const inline = state.status === 'pending';
      const isGap = inline && state.workType === '发货' && r.filled === 0; // 仅发货有缺口行
      const wid = r.work_id || 0;
      const rowAttrs = `data-row-cid="${r.customer_id}" data-row-wid="${wid}" ` +
        `data-row-date="${escapeAttr(r.date || r.suggest_date || todayStr())}" data-row-cname="${escapeAttr(r.customer_name || '')}"` +
        ((r.tempId && inline) ? ` data-temp-id="${escapeAttr(r.tempId)}"` : '') +
        (inline ? ` data-row-idx="${idx}"` : '');
      // 勾选列：发货 pending（批量提交）+ 超管所有视图（批量删除）；缺口行（wid=0）禁止勾选
      const _showCkCol = (state.workType === '发货' && state.status === 'pending') || state.isSuper;
      const ck = _showCkCol
        ? '<td class="wh-ck">' + (isGap ? '' :
            (wid > 0
              ? `<input type="checkbox" class="wh-row-ck" data-id="${wid}" ${state.checked.has(wid) ? 'checked' : ''}>`
              : '')) + '</td>'
        : '';
      // 各类型哪些字段可编辑（rowHtml inline 分支 + bindInlineRow recalc/persist 共用）
      const numVal = (v) => (v != null && Number(v) !== 0) ? v : '';
      const cells = cols.map((col) => {
        if (inline) {
          // —— 日期：仅发货缺口行只读（显示 suggest_date 带待补标签）；其余所有 pending 行都渲染 <input type="date">
          if (col.key === 'date') {
            if (isGap) {
              const d = r.suggest_date || todayStr();
              return `<td class="wh-inline-date">${escapeHtml(d || '')}${r.need_backfill ? ' <span class="bk-tag">[待补]</span>' : ''}</td>`;
            }
            const d = r.date || todayStr();
            // 收货/库内/后勤 日期都是必填；发货也用必填提示（发货必填由后端保证：ship/main/remark 至少一项）
            const ph = '* 日期（必填）';
            return `<td class="wh-input-cell"><input data-if="date" type="date" class="wh-cell-date" value="${escapeAttr(d)}" placeholder="${escapeAttr(ph)}" data-ph="${escapeAttr(ph)}"></td>`;
          }
          // —— 客户名：
          //   发货：缺口行(wid=0)只读显示（系统自动带出的货主，客户关联不可改）；
          //         已填行(wid>0)也只读（历史数据，避免误改客户归属）。
          //   收货：wid=0（新增行）或 wid>0 都行内搜索下拉（原生 datalist + text input）。
          //         option.value 存 label（浏览器自然显示中文客户名），data-cid 存 customer_id（JS 取数用）。
          if (col.key === 'customer_name') {
            if (state.workType === '收货') {
              const dlId = 'dl_customers_' + state.warehouse.replace(/[^a-zA-Z0-9]/g, '_');
              const opts = (state.customers || []).map((o) => {
                const label = (o.owner_name || o.company_name || '') +
                  (o.status === '已删除' ? ' (已删除)' : o.status === '停用' ? ' (已停用)' : '');
                const cid = o.customer_id != null && o.customer_id !== '' ? String(o.customer_id) : '';
                // ★ Bug#1 修复：option.value 存 label（浏览器显示中文），data-cid 存 customer_id（JS 取数）
                return `<option value="${escapeAttr(label)}" data-cid="${cid}">${escapeHtml(label)}</option>`;
              }).join('');
              const curCid = (r.customer_id != null && r.customer_id !== '') ? String(r.customer_id) : '';
              const curName = curCid
                ? ((state.customers || []).find((c) => String(c.customer_id) === curCid)?.owner_name || r.customer_name || '')
                : (r.customer_name || '');
              // 重渲染时按客户列表回判：非法名称继续标红（跨刷新保持错误态）
              const known = new Set();
              (state.customers || []).forEach((o) => {
                const base = o.owner_name || o.company_name || '';
                known.add(base);
                known.add(base + (o.status === '已删除' ? ' (已删除)' : o.status === '停用' ? ' (已停用)' : ''));
              });
              const nameInvalid = !!curName && !known.has(curName);
              return `<td class="wh-name-cell">
                <datalist id="${dlId}">${opts}</datalist>
                <input list="${dlId}" data-if="customer_name_cid" class="wh-cell-txt wh-cust-sel${nameInvalid ? ' wh-cell-invalid' : ''}"
                  aria-invalid="${nameInvalid ? 'true' : 'false'}"
                  placeholder="* 输入客户名搜索（必填）" autocomplete="off"
                  value="${escapeAttr(curName)}" data-cur-cid="${curCid}"
                  onfocus="this.value=''"/>
              </td>`;
            }
            // 发货：保持只读
            let tag = '';
            if (r.customer_status === '已删除') tag = ' <span class="cust-tag cust-tag-del">(已删除)</span>';
            else if (r.customer_status === '停用') tag = ' <span class="cust-tag cust-tag-stop">(已停用)</span>';
            return `<td>${escapeHtml(r.customer_name || '')}${tag}</td>`;
          }
          // —— 项目（库内/后勤）：下拉框；必填项用占位提示（占位项 disabled+hidden 不可选中）
          if (col.key === 'project') {
            const type = state.workType;
            const ph = (type === '库内' || type === '后勤') ? '请选择项目（必填）' : '—';
            // 名称列（项目）内容靠左对齐（表头仍居中）
            return `<td class="wh-name-cell"><select data-if="project" class="wh-cell-sel"${(type === '库内' || type === '后勤') ? ' required' : ''}>${projectOptions(type, r.project || '', ph)}</select></td>`;
          }
          // —— 单位（发货/收货/库内）：下拉；后勤没有此列
          if (col.key === 'unit') {
            const defUnit = state.workType === '发货' ? (r.unit || r.default_unit || '单') : (r.unit || '单');
            return `<td class="wh-input-cell"><select data-if="unit" class="wh-cell-sel">${unitOptions(defUnit)}</select></td>`;
          }
          // —— 库内「作业量」：数字输入（可空；填了必须 >= 0，后端同步校验）
          if (col.key === 'workload') {
            return `<td class="wh-input-cell"><input data-if="workload" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.workload)}" placeholder="作业量"></td>`;
          }
          // —— 发货/收货/库内/后勤：工时通用数字框；主工时对库内/后勤也是必填（与收货口径一致）
          if (col.key === 'main_hours')  {
            const ph = state.workType === '发货' ? '请输入主工时' : '* 主工时（必填）';
            return `<td class="wh-input-cell"><input data-if="main_hours" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.main_hours)}" placeholder="${escapeAttr(ph)}"></td>`;
          }
          if (col.key === 'other_hours') return `<td class="wh-input-cell"><input data-if="other_hours" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.other_hours)}" placeholder="请输入其他工时"></td>`;
          // —— 发货专属
          if (col.key === 'ship_orders') return `<td class="wh-input-cell"><input data-if="ship_orders" class="wh-cell-num" type="number" step="1" min="0" max="1000000" value="${numVal(r.ship_orders)}" placeholder="单量（整数，可 0）"></td>`;
          // —— 收货专属
          if (col.key === 'cartons')  {
            const ph = state.workType === '收货' ? '* 箱数（必填）' : '箱数';
            return `<td class="wh-input-cell"><input data-if="cartons" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.cartons)}" placeholder="${escapeAttr(ph)}"></td>`;
          }
          if (col.key === 'tons')     return `<td class="wh-input-cell"><input data-if="tons" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.tons)}" placeholder="吨"></td>`;
          if (col.key === 'cubic')    return `<td class="wh-input-cell"><input data-if="cubic" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.cubic)}" placeholder="方"></td>`;
          if (col.key === 'pallets')  return `<td class="wh-input-cell"><input data-if="pallets" class="wh-cell-num" type="number" step="0.001" min="0" value="${numVal(r.pallets)}" placeholder="托盘"></td>`;
          // —— 备注（所有类型通用）
          if (col.key === 'remark') return `<td class="wh-input-cell"><input data-if="remark" class="wh-cell-txt" type="text" value="${escapeAttr(r.remark || '')}" placeholder="请输入备注"></td>`;
          // —— 实时计算列（发货 efficiency / 收货 efficiency / 库内+后勤 total_hours）：留空交给 bindInlineRow.recalc
          if (col.key === 'efficiency') {
            const type = state.workType;
            if (type === '发货') {
              const m = Number(r.main_hours) || 0, s = Number(r.ship_orders) || 0;
              return `<td class="num" data-out="efficiency">${(s > 0 && m > 0) ? num(r.efficiency) : '-'}</td>`;
            }
            if (type === '收货') {
              const m = Number(r.main_hours) || 0, c = Number(r.cartons) || 0;
              return `<td class="num" data-out="efficiency">${(c > 0 && m > 0) ? num(r.efficiency) : '-'}</td>`;
            }
          }
          if (col.key === 'total_hours') {
            const m = Number(r.main_hours) || 0, o = Number(r.other_hours) || 0;
            return `<td class="num" data-out="total_hours">${(m + o) > 0 ? ((Math.round((m + o + Number.EPSILON) * 1000) / 1000).toFixed(3)) : '-'}</td>`;
          }
          // —— 未归档：提交人固定 -；其他展示列（doc_cost/unit_cost）未归档无值
          if (col.key === 'submitter') return '<td class="muted">-</td>';
          if (col.key === 'doc_cost' || col.key === 'unit_cost') return '<td class="muted">-</td>';
          return '<td class="muted">—</td>';
        }
        if (col.trend && trend) return trendCell(r[col.key], trend[col.key], col.key === 'ship_orders' ? intFmt : num);
        if (col.key === 'submitter') return `<td>${escapeHtml(r.submitter || '-')}</td>`;
        // 作业量可空：未录入显示 "-"，避免误显示 0.000
        if (col.key === 'workload') return `<td class="num">${r.workload != null ? num(r.workload) : '<span class="muted">-</span>'}</td>`;
        // 发货单量：强制整数展示（历史数据/接口即使带小数也不显示小数位）
        if (col.key === 'ship_orders') {
          const sv = r.ship_orders;
          return `<td class="num" data-out="ship_orders">${(sv == null || sv === '') ? '<span class="muted">-</span>' : Math.round(Number(sv))}</td>`;
        }
        if (col.num) return `<td class="num">${num(r[col.key])}</td>`;
        if (col.key === 'customer_name') {
          const name = escapeHtml(r.customer_name == null ? '' : r.customer_name);
          let tag = '';
          if (r.customer_status === '已删除') tag = ' <span class="cust-tag cust-tag-del">(已删除)</span>';
          else if (r.customer_status === '停用') tag = ' <span class="cust-tag cust-tag-stop">(已停用)</span>';
          // 名称列内容靠左对齐（表头仍居中）
          return `<td class="wh-name-cell">${name}${tag}</td>`;
        }
        if (col.left) return `<td class="wh-name-cell">${escapeHtml(r[col.key] == null ? '' : r[col.key])}</td>`;
        return `<td>${escapeHtml(r[col.key] == null ? '' : r[col.key])}</td>`;
      }).join('');
      // 操作列 —— 所有分支统一 ops-inner 包裹 + flex row nowrap（强制左右排列，不换行）
      const archived = String(r.status || (state.status === 'archived' ? 'archived' : 'pending')) === 'archived';
      let ops;
      if (archived) {
        const canEditArchived = state.isAdmin || (!!state.meName && r.submitter === state.meName);
        const canWithdraw = canEditArchived;
        ops = `<div class="ops-inner">`
          + `<button data-act="view" data-id="${wid}" title="只读查看">查看</button>`
          + (canEditArchived ? `<button data-act="editArchived" data-id="${wid}" class="primary" title="修改归档记录（弹窗编辑）">修改</button>` : '')
          + (canWithdraw ? `<button data-act="withdraw" data-id="${wid}" title="撤回到未归档，撤回后可重新编辑">撤回</button>` : '')
          + (state.isAdmin ? `<button data-act="editSubmitter" data-id="${wid}" title="修改该记录的提交人">修改提交人</button>` : '')
          + (state.isSuper ? `<button data-act="delAdmin" data-id="${wid}" class="danger" title="永久删除该条归档记录（不可恢复）">删除</button>` : '')
          + `</div>`;
      } else if (inline) {
        const submitBtn = `<button data-act="submit" data-id="${wid}" class="primary" title="保存当前行并提交归档">保存提交</button>`;
        let delBtn;
        if (wid === 0) {
          delBtn = `<button data-act="cancelNew" data-id="0" class="danger" title="取消新增（不写入数据库）">取消</button>`;
        } else if (state.isSuper) {
          delBtn = `<button data-act="delAdmin" data-id="${wid}" class="danger" ${isGap ? 'data-gap="1"' : ''}
              title="${isGap ? '将该虚拟缺口行从本页屏蔽（不再自动带出）' : '永久删除该条记录（不可恢复）'}">删除</button>`;
        } else {
          delBtn = '<span class="ops-none" title="仅超级管理员可删除记录">—</span>';
        }
        ops = `<div class="ops-inner">${submitBtn}${delBtn}</div>`;
      } else {
        ops = `<div class="ops-inner">`
          + `<button data-act="edit" data-id="${r.work_id}">编辑</button>`
          + `<button data-act="submit" data-id="${r.work_id}" class="primary" title="提交归档">提交</button>`
          + `<button data-act="del" data-id="${r.work_id}">删除</button>`
          + `</div>`;
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
      if (!act) return;
      if (act === 'cancelNew') {
        // 取消新增：用 tempId 精确匹配（避免 wid=0 误删其他虚拟行）
        const tr = e.target.closest('tr');
        const tempId = tr && tr.dataset.tempId;
        const wid = Number(tr && tr.dataset.rowWid) || 0;
        state.lastRows = state.lastRows.filter((r) => {
          if (tempId && r.tempId === tempId) return false;
          // 没 tempId 时退而用 wid=0 兜底（老数据或发货缺口行）
          if (!tempId && wid === 0 && Number(r.work_id) === 0) return false;
          return true;
        });
        tr && tr.remove();
        // ★ 修复：取消后必须把"删掉该行"的状态同步到 localStorage drafts！
        // 否则刷新页面时 _bootDrafts 又把这行拉回来了。
        _saveDrafts(state.warehouse, state.workType, state.lastRows);
        return;
      }
      // 发货 tab 的非 inline 行（已归档）edit → openModal 编辑
      if (act === 'edit') openModal(id);
      if (act === 'editArchived') openModal(id);
      if (act === 'view') openModal(id, { readonly: true });
      // 提交归档：行内视图走行内保存（带当前输入值）；其他 tab 直接提交
      if (act === 'submit') {
        const tr = e.target.closest('tr');
        if (tr && typeof tr.__submit === 'function') { tr.__submit(); return; }
        if (!confirm('确定要提交归档吗？归档后不可直接修改。')) return;
        const btn = e.target; btn.disabled = true;
        API.post('/workhours/' + id + '/submit', { warehouse: state.warehouse, work_type: state.workType })
          .then(() => { alert('已提交归档'); load(); })
          .catch((ex) => { btn.disabled = false; errAlert('提交失败', friendlyErrMsg(ex)); });
        return;
      }
      // 撤回：archived → pending，撤回后回到「未归档」可继续行内编辑
      if (act === 'withdraw') {
        if (!confirm('确定要撤回该条记录吗？撤回后可重新编辑。')) return;
        const btn = e.target; btn.disabled = true;
        API.post('/workhours/' + id + '/withdraw', { warehouse: state.warehouse, work_type: state.workType })
          .then(() => { alert('已撤回，可在「未归档」中继续编辑'); load(); })
          .catch((ex) => { btn.disabled = false; errAlert('撤回失败', ex.message); });
        return;
      }
      // 修改提交人：管理员弹下拉选择系统内用户
      if (act === 'editSubmitter') { openSubmitterModal(id); return; }
      // 普通删除（其他 tab，原逻辑）
      if (act === 'del' && confirm('确认删除该工时记录？此操作将写入审计日志。')) {
        API.req('DELETE', '/workhours/' + id).then(load).catch((ex) => alert(ex.message));
      }
      // 永久删除（仅超管可见）：二次确认 + 后端 role_code 强校验
      // 已归档记录用更严厉的提示；pending 保持原文案；虚拟缺口行（wid=0）走前端屏蔽，绝不调后端
      if (act === 'delAdmin') {
        const row = e.target.closest && e.target.closest('tr');
        const wid = row && Number(row.dataset.rowId);
        const r = state.lastRows.find((x) => x.work_id === wid);
        const isVirtual = (wid === 0 || wid == null) && !!e.target.dataset.gap;
        if (isVirtual) {
          // 虚拟缺口行：前端屏蔽（写入 localStorage + 立即 DOM 移除）
          if (!confirm('该货主尚未填报数据，确认要将其从当前列表中移除吗？（屏蔽后刷新也不会再自动带出）')) return;
          // 用 state._shownRows 里对应的那行（gap 行没有 work_id，靠 rowAttrs 里的 rowCid + rowDate 反查）
          const cid = row && row.dataset.rowCid;
          const date = row && row.dataset.rowDate;
          const gapRow = state.lastRows.find((x) => String(x.customer_id) === String(cid) && (x.suggest_date || x.date) === date && x.filled === 0);
          if (gapRow) addGapBlock(state.warehouse, gapKeyOf(gapRow));
          const tr = btn.closest('tr');
          if (tr) tr.remove();
          toast('已屏蔽该虚拟行（' + (gapRow && gapRow.customer_name ? gapRow.customer_name : '') + '）');
          return;
        }
        const isArchived = r && String(r.status || '') === 'archived';
        const prompt = isArchived
          ? '确定要永久删除该条归档记录吗？此操作不可恢复！'
          : '确定要彻底删除这条记录吗？';
        if (!confirm(prompt)) return;
        const btn = e.target;
        btn.disabled = true;
        API.req('DELETE', '/workhours/' + id + '/force')
          .then(() => {
            const tr = btn.closest('tr');
            if (tr) tr.remove();
            toast('已删除');
            load();
          })
          .catch((ex) => { btn.disabled = false; errAlert('删除失败', ex.message); });
      }
    }

    // 行内直编行 → 后端 payload（唯一取数口径：行内保存与批量提交共用）
    // 按 workType 动态组装：发货/收货带客户关联字段，库内/后勤带 project
    function inlinePayloadOf(tr) {
      const val = (k) => { const e = tr.querySelector('[data-if="' + k + '"]'); return e ? e.value : ''; };
      const type = state.workType;
      const base = { warehouse: state.warehouse, work_type: type };
      // 日期：发货缺口行只读（用 dataset.rowDate）；其余都走 date input
      base.date = (type === '发货' && Number(tr.dataset.rowWid) === 0 && (tr.dataset.rowDate || '').length === 10)
        ? tr.dataset.rowDate
        : (val('date') || tr.dataset.rowDate || todayStr());
      // 备注：trim 后真空 → null（后端 CREATE TABLE remark TEXT DEFAULT NULL 口径）
      const remark = (val('remark') || '').trim();
      base.remark = remark || null;
      // 工时通用（★ 公摊工时不在录入 UI 输入：提交省略该字段，后端默认 0 / PUT 保留旧值；
      //   看板公摊由后端按库内工时自动分摊，禁止手动输入）
      base.main_hours = Number(val('main_hours')) || 0;
      base.other_hours = Number(val('other_hours')) || 0;

      if (type === '发货' || type === '收货') {
        if (type === '收货') {
          // ★ Bug#1 修复：customer_name_cid input.value 现在是 label（客户名），不是 customer_id 数字。
          // customer_id 从 tr.dataset.rowCid 取（bindInlineRow 的 input/change 事件维护）。
          const cidSel = tr.dataset.rowCid || '';
          if (cidSel) {
            base.customer_id = Number(cidSel);
            const hit = (state.customers || []).find((c) => String(c.customer_id) === String(cidSel));
            base.customer_name = hit ? (hit.owner_name || hit.company_name) : (tr.dataset.rowCname || null);
          } else {
            base.customer_id = null;
            base.customer_name = null;
          }
        } else {
          base.customer_id = tr.dataset.rowCid != null && tr.dataset.rowCid !== '' ? Number(tr.dataset.rowCid) : null;
          base.customer_name = tr.dataset.rowCname || null;
        }
      }
      if (type === '发货') {
        base.unit = val('unit') || '单';
        base.ship_orders = Number(val('ship_orders')) || 0;
      }
      if (type === '收货') {
        // 已隐藏 unit 列，但后端 payload + calcRow 仍需要；后端校验里 unit 非必填，给个兜底
        base.unit = '单';
        base.cartons = Number(val('cartons')) || 0;
        base.tons = Number(val('tons')) || 0;
        base.cubic = Number(val('cubic')) || 0;
        base.pallets = Number(val('pallets')) || 0;
      }
      if (type === '库内' || type === '后勤') {
        base.project = val('project') || null;
      }
      if (type === '库内') {
        base.unit = val('unit') || '单';
        // 作业量：空 → null（后端可空），否则数值
        const wlRaw = val('workload');
        base.workload = String(wlRaw).trim() === '' ? null : Number(wlRaw);
      }
      return base;
    }

    // 行内直编：实时计算时效/总工时 + 失焦/回车自动保存为 pending 草稿；「保存提交」按钮保存并归档。
    // 发货缺口行(wid=0) → POST /workhours（草稿；提交时 auto_archive=true）
    // 已填行(wid>0) → PUT /workhours/:wid，提交时再 POST /:id/submit（写提交人 + 提交时间）
    function bindInlineRow(tr) {
      const el = (k) => tr.querySelector('[data-if="' + k + '"]');
      const val = (k) => { const e = el(k); return e ? e.value : ''; };
      const type = state.workType;
      // 从 data-row-idx 解析当前行在 state._shownRows 里的索引
      const idx = parseInt(tr.dataset.rowIdx, 10);
      // ★ 核心修复：syncBack 把 DOM 里用户输入的值回写到 state.lastRows[idx]
      // 这样无论 renderRows() 因何种原因重渲染（点击新增 / 局部保存后重绘），
      // 用户已填写的草稿数据都不会被丢失
      const syncBack = () => {
        if (isNaN(idx) || idx < 0) return;
        const row = state.lastRows[idx];
        if (!row) return;
        // 通用字段（所有类型共用 el 一定存在）
        const dateEl = el('date'); if (dateEl) row.date = dateEl.value || row.date;
        const mainEl = el('main_hours'); if (mainEl) row.main_hours = mainEl.value === '' ? '' : Number(mainEl.value);
        const otherEl = el('other_hours'); if (otherEl) row.other_hours = otherEl.value === '' ? '' : Number(otherEl.value);
        const remarkEl = el('remark'); if (remarkEl) row.remark = remarkEl.value || '';
        // 项目（仅库内/后勤有此列）
        const projEl = el('project'); if (projEl) row.project = projEl.value || null;
        // 单位（发货/库内有此列；收货隐藏了）
        const unitEl = el('unit'); if (unitEl) row.unit = unitEl.value || null;
        // 发货专属
        const shipEl = el('ship_orders'); if (shipEl) row.ship_orders = shipEl.value === '' ? '' : Number(shipEl.value);
        // 收货专属
        const cartonsEl = el('cartons'); if (cartonsEl) row.cartons = cartonsEl.value === '' ? '' : Number(cartonsEl.value);
        const tonsEl = el('tons'); if (tonsEl) row.tons = tonsEl.value === '' ? '' : Number(tonsEl.value);
        const cubicEl = el('cubic'); if (cubicEl) row.cubic = cubicEl.value === '' ? '' : Number(cubicEl.value);
        const palletsEl = el('pallets'); if (palletsEl) row.pallets = palletsEl.value === '' ? '' : Number(palletsEl.value);
        // 库内专属：作业量（可空，数字）
        const wlEl = el('workload'); if (wlEl) row.workload = wlEl.value === '' ? null : Number(wlEl.value);
        // 收货客户：从 tr.dataset 读取（datalist 选择后维护）
        if (type === '收货') {
          const cid = tr.dataset.rowCid || '';
          const custEl = tr.querySelector('[data-if="customer_name_cid"]');
          const typed = custEl ? String(custEl.value || '').trim() : '';
          row.customer_id = cid ? Number(cid) : null;
          // 保留用户实际输入（含未匹配的非法值），否则重渲染会悄悄清空、红框也丢掉
          row.customer_name = (typed || tr.dataset.rowCname || '') || null;
        }
      };
      // 实时计算列：发货→efficiency(ship/main)；收货→efficiency(cartons/main)；库内/后勤→total_hours
      const recalc = () => {
        const main = Number(val('main_hours')) || 0;
        const other = Number(val('other_hours')) || 0;
        if (type === '发货') {
          const ship = Number(val('ship_orders')) || 0;
          const out = tr.querySelector('[data-out="efficiency"]');
          if (out) out.textContent = (ship > 0 && main > 0)
            ? (Math.round((ship / main + Number.EPSILON) * 1000) / 1000).toFixed(3) : '-';
        } else if (type === '收货') {
          const cartons = Number(val('cartons')) || 0;
          const out = tr.querySelector('[data-out="efficiency"]');
          if (out) out.textContent = (cartons > 0 && main > 0)
            ? (Math.round((cartons / main + Number.EPSILON) * 1000) / 1000).toFixed(3) : '-';
        }
        if (type === '后勤') {
          // 总工时 = 主 + 其他（库内已移除总工时列；公摊不在录入 UI 展示，由看板后端自动分摊）
          const out = tr.querySelector('[data-out="total_hours"]');
          if (out) out.textContent = (main + other) > 0
            ? (Math.round((main + other + Number.EPSILON) * 1000) / 1000).toFixed(3) : '-';
        }
      };
      const resetRow = () => {
        tr.querySelectorAll('[data-if]').forEach((e) => { if (e.tagName !== 'SELECT' && e.tagName !== 'INPUT') e.value = ''; else if (e.tagName === 'INPUT') e.value = ''; });
        // 下拉也复位到首项（空占位）
        tr.querySelectorAll('select[data-if]').forEach((s) => { if (s.options.length) s.value = s.options[0].value; });
        recalc();
      };
      function payloadOf() { return inlinePayloadOf(tr); }
      async function persist(archive, explicit) {
        const main = Number(val('main_hours')) || 0;
        const other = Number(val('other_hours')) || 0;
        const remark = (val('remark') || '').trim();
        let ok = true, hint = '';
        if (type === '收货') {
          // 严格必填：日期 / 客户 / 箱数 / 主工时，缺一拦截
          const date = tr.dataset.rowDate || val('date') || '';
          const custEl = tr.querySelector('[data-if="customer_name_cid"]');
          const typedName = custEl ? String(custEl.value || '').trim() : '';
          // 客户名非空但不在客户列表 → 立即拦截（不等必填检查）
          if (typedName && !customerOptionOf(custEl)) {
            setCustomerInvalid(custEl, true);
            errAlert('客户校验失败', '该客户不存在，禁止录入！');
            return false;
          }
          const cidSel = tr.dataset.rowCid || '';
          const cartons = Number(val('cartons')) || 0;
          const missing = [];
          if (!date) missing.push('日期');
          if (!cidSel) missing.push('客户');
          if (!(cartons > 0)) missing.push('箱数');
          if (!(main > 0)) missing.push('主工时');
          if (missing.length) { ok = false; hint = '请填写完整的必填项（日期、客户、箱数、主工时）'; }
        } else if (type === '库内' || type === '后勤') {
          // ★ 库内/后勤与收货同一口径：严格必填日期 + 项目 + 主工时
          const date = tr.dataset.rowDate || val('date') || '';
          const proj = val('project');
          const missing = [];
          if (!date) missing.push('日期');
          if (!proj) missing.push('项目');
          if (!(main > 0)) missing.push('主工时');
          if (missing.length) { ok = false; hint = '请填写完整的必填项（日期、项目、主工时）'; }
          // 作业量（仅库内，可空）：只允许不小于 0 的数字
          if (ok && type === '库内') {
            const wlRaw = String(val('workload')).trim();
            if (wlRaw !== '') {
              const wl = Number(wlRaw);
              if (!Number.isFinite(wl) || wl < 0) { ok = false; hint = '作业量必须为不小于 0 的数字'; }
            }
          }
        } else if (type === '发货') {
          // ★ 发货单量：整数 + 范围校验（1 ~ 1,000,000），任何小数/0/负数/超上限一律拦截
          const shipRaw = String(val('ship_orders')).trim();
          const ship = Number(shipRaw) || 0;
          let shipInvalid = '';
          if (shipRaw !== '') {
            if (!Number.isFinite(ship) || !Number.isInteger(ship)) shipInvalid = '发货单量必须为整数，不支持小数';
            else if (ship < 0) shipInvalid = '发货单量不能为负数';
            else if (ship > 1000000) shipInvalid = '发货单量不能超过 1,000,000';
          }
          if (shipInvalid) { ok = false; hint = shipInvalid; }
          else {
            // 任意有效内容项即可提交（单量为 0 时需有工时或备注）
            ok = (ship > 0) || (main > 0) || (other > 0) || !!remark;
            if (!ok) hint = '单量为 0 或为空时，需至少填写主工时、其他工时或备注';
          }
        }
        if (!ok) {
          if (explicit) { errAlert('校验未通过', hint); return false; }
          return false;  // 失焦自动保存失败 → 不清空、不刷新
        }
        // ★ 问题一：行级保存查重 —— 本行与表内其他行「日期+客户(项目)」重复 → 标红并拦截
        if (!isNaN(idx) && idx >= 0) {
          const dupGroups = findDupGroups().filter(([, v]) => v.includes(idx));
          if (dupGroups.length) {
            markDupRows(dupGroups);
            errAlert('保存失败', dupToastMsg(dupGroups[0][0]));
            return false;
          }
        }
        if (tr.__saving) { try { await tr.__saving; } catch (e) { /* 交给本轮 */ } }
        const wid = Number(tr.dataset.rowWid) || Number(tr.__savedWid) || 0;
        const payload = payloadOf();
        const tempId = tr.dataset.tempId || '';
        const run = (async () => {
          if (wid > 0) {
            await API.put('/workhours/' + wid, payload);
            if (archive) await API.post('/workhours/' + wid + '/submit', { warehouse: state.warehouse, work_type: type });
          } else if (archive) {
            payload.auto_archive = true;
            const res = await API.post('/workhours', payload);
            tr.__savedWid = res && res.data && res.data.work_id;
          } else {
            const res = await API.post('/workhours', payload);
            tr.__savedWid = res && res.data && res.data.work_id;
          }
        })();
        tr.__saving = run;
        try {
          await run;
        } catch (ex) {
          // 就地显示错误条，不清空用户输入
          let errDiv = tr.querySelector('.row-inline-error');
          if (!errDiv) {
            errDiv = document.createElement('div');
            errDiv.className = 'row-inline-error';
            tr.appendChild(errDiv);
          }
          const friendlyMsg = friendlyErrMsg(ex, ex.message || ex);
          errDiv.textContent = (archive ? '提交失败：' : '保存失败：') + friendlyMsg;
          errDiv.style.display = 'block';
          // 5 秒后自动隐藏
          clearTimeout(tr.__errTimer);
          tr.__errTimer = setTimeout(() => { errDiv.style.display = 'none'; }, 5000);
          // 提交场景（用户显式点击提交按钮）额外弹全局错误弹窗，确保用户必然注意到
          if (archive) {
            errAlert('提交失败', friendlyMsg);
          }
          return false;
        } finally {
          tr.__saving = null;
        }
        if (archive) toast('✅ 已保存并提交归档', 'success');
        // ★ Bug#2 核心修复：成功后 **不 load() 全量刷新**，只做局部数组更新。
        // 这样用户正在填写的其他 wid=0 虚拟行不会被冲刷掉。
        if (archive) {
          // 归档成功 → 从当前 pending 列表里移除该行（保留其他虚拟行）
          const savedWid = Number(tr.__savedWid) || wid || 0;
          state.lastRows = state.lastRows.filter((r) => {
            // 匹配 work_id > 0 或 tempId（两种身份都过滤）
            const rwid = Number(r.work_id) || 0;
            if (rwid > 0 && rwid === savedWid) return false;
            if (tempId && r.tempId === tempId) return false;
            return true;
          });
        } else {
          // 草稿保存（失焦自动）→ 只更新该行 work_id（从 0 变成后端新分配的 ID），保留其他虚拟行
          const savedWid = Number(tr.__savedWid) || 0;
          if (savedWid > 0) {
            const idx = state.lastRows.findIndex((r) => r.tempId === tempId || Number(r.work_id) === wid);
            if (idx >= 0) state.lastRows[idx] = { ...state.lastRows[idx], work_id: savedWid };
          }
        }
        // ★ 性能优化：requestAnimationFrame 延后重绘，避免同步 innerHTML 阻塞用户输入
        requestAnimationFrame(() => renderRows());
        return true;
      }

      tr.__submit = async () => {
        if (!confirm('确定要保存并提交归档吗？归档后不可直接修改。')) return;
        await persist(true, true);
      };

      tr.querySelectorAll('[data-if]').forEach((e) => {
        // ★ 核心修复：每个 input/change 事件先 syncBack 回写 state.lastRows，再 recalc
        // 确保任何重渲染都不会丢失用户已填数据
        e.addEventListener('input', () => { syncBack(); recalc(); });
        e.addEventListener('change', () => { syncBack(); recalc(); });
        // ★ 发货单量：实时整数校验（输入/失焦即时标红 + 明确提示；非法值阻止失焦自动保存）
        if (type === '发货' && e.dataset && e.dataset.if === 'ship_orders') {
          let lastWarned = '';
          const checkShip = (showToast) => {
            const raw = String(e.value || '').trim();
            let msg = '';
            if (raw !== '') {
              const n = Number(raw);
              if (!Number.isFinite(n) || !Number.isInteger(n)) msg = '发货单量必须为整数，不支持小数';
              else if (n < 0) msg = '发货单量不能为负数';
              else if (n > 1000000) msg = '发货单量不能超过 1,000,000';
            }
            setCustomerInvalid(e, !!msg);
            e.title = msg;
            if (msg) tr.dataset.skipBlurSave = '1';
            else if (tr.dataset.skipBlurSave === '1') delete tr.dataset.skipBlurSave;
            if (msg && showToast && lastWarned !== raw) {
              lastWarned = raw;
              errAlert('发货单量校验失败', msg);
            }
            return !msg;
          };
          e.addEventListener('input', () => checkShip(false));
          e.addEventListener('change', () => checkShip(true));
          e.addEventListener('blur', () => checkShip(true));
          checkShip(false);
        }
        // ★ Bug#1 修复：收货 customer_name_cid 是 datalist input，value 存 label（客户名）。
        //   input 事件 → 遍历 datalist options 精确匹配 option.value（label），取 option.data-cid 写 dataset。
        //   写完 dataset 后再 syncBack 回写 state.lastRows。
        if (type === '收货' && e.dataset && e.dataset.if === 'customer_name_cid') {
          // ★ 实时校验：输入时只回写/标红，change / blur 再弹红色提示，避免打字过程刷屏。
          //   校验数据源就是本行 datalist（即客户列表渲染出来的选项）。
          let lastWarned = '';
          const applyCustomer = (showToast) => {
            const v = e.value.trim();
            const hit = customerOptionOf(e);
            if (!v) {
              tr.dataset.rowCid = ''; tr.dataset.rowCname = '';
              setCustomerInvalid(e, false);
              lastWarned = '';
              return true;
            }
            if (hit) {
              tr.dataset.rowCid = hit.dataset.cid || '';
              tr.dataset.rowCname = hit.value || '';
              setCustomerInvalid(e, false);
              lastWarned = '';
              return true;
            }
            tr.dataset.rowCid = ''; tr.dataset.rowCname = '';
            setCustomerInvalid(e, true);
            if (showToast && lastWarned !== v) {
              lastWarned = v;
              errAlert('客户校验失败', '该客户不存在，禁止录入！');
            }
            return false;
          };
          e.addEventListener('input', () => { applyCustomer(false); syncBack(); recalc(); });
          e.addEventListener('change', () => { applyCustomer(true); syncBack(); recalc(); });
          // 先校验，再交给下面的通用 blur 保存；校验失败则跳过本次自动保存
          e.addEventListener('blur', () => {
            if (!applyCustomer(true)) tr.dataset.skipBlurSave = '1';
          });
        }
        e.addEventListener('blur', () => {
          if (tr.dataset.skipBlurSave === '1') { delete tr.dataset.skipBlurSave; return; }
          persist(false, false);
        });
        e.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); persist(false, false); } });
      });
      recalc();
    }

    // ---------- 弹窗（仅用于已归档记录的「修改 / 查看」） ----------
    // ★ 需求一：新增已全部改为表格行内直编（addVirtualRow），弹窗不再承担新增职责。
    async function openModal(id, opts) {
      if (!id) return; // 新增走行内直编，弹窗必须传入已有记录 id
      const readonly = !!(opts && opts.readonly); // 已归档只读查看：禁用输入、隐藏保存
      let cur = {};
      try { cur = (await API.get('/workhours/' + id)).data || {}; } catch (ex) { alert(ex.message); return; }
      const workType = cur.work_type;
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
        if (workType === '库内') {
          fields.push(`<label>作业量<input id="f_workload" type="number" step="0.001" min="0" value="${cur.workload != null ? cur.workload : ''}"></label>`);
          fields.push(`<label>单位<select id="f_unit">${unitOpts}</select></label>`);
        }
      }
      fields.push(`<label>日期*<input id="f_date" type="date" value="${escapeAttr(cur.date || preset.date || todayStr())}"></label>`);
      if (workType === '发货') fields.push(`<label>发货单量<input id="f_ship" type="number" step="1" min="0" max="1000000" value="${cur.ship_orders != null ? cur.ship_orders : ''}"></label>`);
      if (workType === '收货') {
        fields.push(`<label>箱数<input id="f_cartons" type="number" step="0.001" min="0" value="${cur.cartons != null ? cur.cartons : 0}"></label>`);
        fields.push(`<label>吨<input id="f_tons" type="number" step="0.001" min="0" value="${cur.tons != null ? cur.tons : 0}"></label>`);
        fields.push(`<label>方<input id="f_cubic" type="number" step="0.001" min="0" value="${cur.cubic != null ? cur.cubic : 0}"></label>`);
        fields.push(`<label>托盘<input id="f_pallets" type="number" step="0.001" min="0" value="${cur.pallets != null ? cur.pallets : 0}"></label>`);
      }
      fields.push(`<label>主工时(小时)<input id="f_main" type="number" step="0.001" min="0" value="${cur.main_hours != null ? cur.main_hours : 0}"></label>`);
      fields.push(`<label>其他工时(小时)<input id="f_other" type="number" step="0.001" min="0" value="${cur.other_hours != null ? cur.other_hours : 0}"></label>`);
      // ★ 公摊工时不在编辑弹窗展示：仅由经营看板后端自动分摊，禁止手动输入（PUT 省略字段 → 后端保留旧值）
      fields.push(`<label class="full">备注<textarea id="f_remark" rows="2">${escapeHtml(cur.remark || '')}</textarea></label>`);

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
      <div class="modal">
        <div class="modal-head"><span>${readonly ? '查看' : '编辑'}工时（${workType} · ${state.warehouse}）</span><button class="close" type="button">×</button></div>
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
      // 客户联动单位：选完客户后，单位下拉自动切到该客户的 default_unit（兜底 '单'）
      // owners 现在由 /api/customers/options 返回含 default_unit 字段
      const custToUnit = new Map();
      owners.forEach((o) => { if (o.customer_id != null && o.customer_id !== '') custToUnit.set(String(o.customer_id), o.default_unit || '单'); });
      const custSel = modal.querySelector('#f_customer'), unitSel = modal.querySelector('#f_unit');
      if (custSel && unitSel) {
        custSel.onchange = () => {
          const du = custToUnit.get(custSel.value) || '单';
          // 用 option[value=du] 定位；如果不在 UNITS 里则补一项选中（同历史工时兜底逻辑）
          let opt = unitSel.querySelector(`option[value="${du}"]`);
          if (!opt) {
            opt = document.createElement('option'); opt.value = du; opt.textContent = du;
            unitSel.prepend(opt);
          }
          unitSel.value = du;
        };
      }
      if (readonly) {
        // 归档数据只读：全部控件禁用，移除保存按钮（修改需先撤回）
        modal.querySelectorAll('input,select,textarea').forEach((e) => { e.disabled = true; });
        const sb = modal.querySelector('#saveBtn'); if (sb) sb.remove();
      }

      function numV(id) { const v = modal.querySelector(id).value; return v === '' ? null : Number(v); }
      function preview() {
        const m = Number(modal.querySelector('#f_main').value) || 0;
        const o = Number(modal.querySelector('#f_other').value) || 0;
        // 总工时 = 主 + 其他（公摊不在弹窗展示，由看板后端自动分摊）
        const total = Math.round((m + o + Number.EPSILON) * 1000) / 1000;
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
      ['#f_main', '#f_other', '#f_ship', '#f_cartons'].forEach((sel) => { const el = modal.querySelector(sel); if (el) el.oninput = preview; });
      // ★ 发货单量：弹窗内实时整数校验（标红 + 错误文案），非法值阻止保存
      const shipInput = modal.querySelector('#f_ship');
      const shipErrMsg = () => {
        if (!shipInput) return '';
        const raw = String(shipInput.value || '').trim();
        if (raw === '') return '';
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) return '发货单量必须为整数，不支持小数';
        if (n < 0) return '发货单量不能为负数';
        if (n > 1000000) return '发货单量不能超过 1,000,000';
        return '';
      };
      if (shipInput) {
        const check = () => {
          const msg = shipErrMsg();
          shipInput.classList.toggle('wh-cell-invalid', !!msg);
          shipInput.title = msg;
          const errEl = modal.querySelector('#f_err');
          if (errEl && msg) errEl.textContent = msg;
          else if (errEl && !msg && errEl.textContent && errEl.textContent.indexOf('发货单量') === 0) errEl.textContent = '';
        };
        shipInput.addEventListener('input', check);
        shipInput.addEventListener('blur', check);
      }
      preview();

      // ★ 修复：readonly「查看」模式下 saveBtn 已被移除，必须判空再绑定（否则点击查看即抛 TypeError）
      const saveBtn = modal.querySelector('#saveBtn');
      if (saveBtn) saveBtn.onclick = async () => {
        const payload = {
          warehouse: state.warehouse, work_type: workType,
          unit: modal.querySelector('#f_unit') ? (modal.querySelector('#f_unit').value || null) : null,
          date: modal.querySelector('#f_date').value,
          main_hours: modal.querySelector('#f_main').value,
          other_hours: modal.querySelector('#f_other').value,
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
        if (workType === '库内') {
          const wlEl = modal.querySelector('#f_workload');
          payload.workload = wlEl && String(wlEl.value).trim() !== '' ? Number(wlEl.value) : null;
        }
        if (workType === '发货') {
          const shipMsg = shipErrMsg();
          if (shipMsg) {
            const ee = modal.querySelector('#f_err');
            if (ee) ee.textContent = shipMsg;
            errAlert('发货单量校验失败', shipMsg);
            return;
          }
          const raw = String(modal.querySelector('#f_ship').value || '').trim();
          payload.ship_orders = raw === '' ? null : Number(raw);
        }
        if (workType === '收货') {
          payload.cartons = modal.querySelector('#f_cartons').value;
          payload.tons = modal.querySelector('#f_tons').value;
          payload.cubic = modal.querySelector('#f_cubic').value;
          payload.pallets = modal.querySelector('#f_pallets').value;
        }
        const errEl = modal.querySelector('#f_err');
        try {
          await API.put('/workhours/' + id, payload);
          modal.remove(); load();
        } catch (ex) {
          // 弹窗编辑：同时在弹窗内和全局展示错误，重复冲突等关键错误强提醒
          errEl.textContent = friendlyErrMsg(ex);
          errAlert('保存失败', friendlyErrMsg(ex));
        }
      };
    }

    // 修改提交人（仅管理员）：下拉选择系统内真实用户，保存后写审计（只记 submitter 前后值）
    async function openSubmitterModal(id) {
      let users = [];
      try { users = (await API.get('/users')).data || []; } catch (ex) { errAlert('读取用户列表失败', ex.message); return; }
      const names = [...new Set(users.map((u) => u.display_name || u.username).filter(Boolean))];
      if (!names.length) { errAlert('操作受限', '系统内暂无可选用户'); return; }
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
