// 客户资料（重构）：三页工厂 + 18 字段表单 + 仓库 Tabs 多仓 LIKE + Excel 模板导入
// 三页各持独立 state/host，避免 keep-alive 同时打开时互相串写
(function () {
  const WAREHOUSES = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];
  const COOP = ['合作中', '暂停', '终止'];
  const CONFIG = {
    cust_wh:      { type: '仓储客户', title: '仓储客户', withWarehouse: true },
    cust_shared:  { type: '共享单号', title: '共享单号', withWarehouse: false },
    cust_express: { type: '快运物流', title: '快运物流', withWarehouse: false },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const num = (x) => (x == null ? 0 : Number(x)).toFixed(3);
  const opts = (arr, cur) => arr.map((x) => `<option value="${esc(x)}" ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('');

  // 删除按钮 RBAC（前端展示控制）：仅 管理员/超级管理员 渲染「删除」。
  // 业务员/查看者不渲染该按钮；后端 roleGate 另有二次校验，防止绕过前端直调接口。
  function canDelete() {
    const role = (window.ERP_USER || {}).role;
    return role === '管理员' || role === '超级管理员';
  }

  function createPage(cfg) {
    const state = { page: 1, pages: 1, q: '', pageSize: 20, warehouse: WAREHOUSES[0] };
    let host = null;
    const $ = (id) => host && host.querySelector('#' + id);

    function query() {
      const p = new URLSearchParams({
        customer_type: cfg.type, q: state.q, page: state.page, pageSize: state.pageSize,
      });
      if (cfg.withWarehouse) p.set('warehouse', state.warehouse);  // 后端 LIKE '%仓名%'
      return '/customers?' + p.toString();
    }
    async function load() {
      const r = await API.get(query());
      render(r);
    }

    function render(r) {
      const rows = r.data || [];
      const total = r.total || 0;
      state.pages = Math.ceil(total / state.pageSize) || 1;
      const colCount = cfg.withWarehouse ? 9 : 8;
      host.innerHTML = `
        ${cfg.withWarehouse ? `
        <div class="tabs wh-tabs" id="whTabs">
          ${WAREHOUSES.map((w) => `<div class="tab ${w === state.warehouse ? 'active' : ''}" data-wh="${w}">${w}</div>`).join('')}
        </div>` : ''}
        <div class="toolbar">
          <input id="searchInput" placeholder="搜索货主代码/公司全称/简称/联系人/电话" value="${esc(state.q)}">
          <button id="searchBtn">搜索</button>
          <button id="addBtn" class="primary">+ 新增客户</button>
          <span class="toolbar-spacer"></span>
          <button id="tplBtn">下载导入模板</button>
          <button id="importBtn">导入 Excel</button>
          <input type="file" id="fileInput" accept=".xlsx,.xls" hidden>
        </div>
        <table class="grid">
          <thead><tr>
            <th>排序号</th><th>货主代码</th><th>公司全称</th>
            ${cfg.withWarehouse ? '<th>所在仓库</th>' : ''}
            <th>客户简称</th><th>截单时间</th><th>预充单价</th><th>合作状态</th><th>操作</th>
          </tr></thead>
          <tbody>${rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="${colCount}" class="empty">暂无数据</td></tr>`}</tbody>
        </table>
        <div class="pager">
          <button id="prevBtn" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${state.page} / ${state.pages} 页（共 ${total} 条）</span>
          <button id="nextBtn" ${state.page >= state.pages ? 'disabled' : ''}>下一页</button>
        </div>`;
      bind();          // 事件必须在 DOM 渲染后绑定
      bindRows(rows);
    }

    function rowHtml(r) {
      const badge = r.coop_status === '合作中'
        ? '<span class="badge ok">合作中</span>'
        : `<span class="badge off">${esc(r.coop_status || '')}</span>`;
      // 删除按钮：仅管理员可见；已物理删除的行不会出现在列表中，
      // 非「合作中」行（暂停/终止）走「恢复」回归合作，删除按钮照常可用（由后端关联校验兜底）
      const delBtn = canDelete()
        ? `<button id="del_${r.customer_id}" class="danger">删除</button>`
        : '';
      // ★ 列表页 sort 单元格：纯文本展示，不可编辑（编辑入口已收敛至详情页）
      // 后端已按 COALESCE(wsc.sort_order, c.sort_order, 9999) 排序
      let sortDisplay;
      const so = cfg.withWarehouse
        ? (r.warehouse_sort_order != null ? r.warehouse_sort_order : (r.sort_order || 9999))
        : (r.sort_order || 9999);
      sortDisplay = (so !== 9999)
        ? esc(so)
        : '<span style="color:#aaa">-</span>';
      const sortCell = `<td class="num">${sortDisplay}</td>`;
      return `<tr>
        ${sortCell}
        <td>${esc(r.customer_code || '')}</td>
        <td>${esc(r.company_name || '')}</td>
        ${cfg.withWarehouse ? `<td>${esc(r.warehouse || '')}</td>` : ''}
        <td>${esc(r.short_name || '')}</td>
        <td>${esc(r.cutoff_time || '')}</td>
        <td class="num">${num(r.prepaid_price)}</td>
        <td>${badge}</td>
        <td class="ops">
          <button id="view_${r.customer_id}">查看</button>
          <button id="edit_${r.customer_id}">编辑</button>
          <button id="toggle_${r.customer_id}">${r.coop_status === '合作中' ? '暂停' : '恢复'}</button>
          ${delBtn}
        </td>
      </tr>`;
    }

    function bind() {
      // 仓库 Tabs 联动：切仓重置分页 + 重新查询（后端按 COALESCE 自动分仓排序）
      if (cfg.withWarehouse && $('whTabs')) {
        $('whTabs').addEventListener('click', (e) => {
          const tab = e.target.closest('[data-wh]');
          if (!tab || tab.dataset.wh === state.warehouse) return;
          state.warehouse = tab.dataset.wh;
          state.page = 1;
          load();
        });
      }
      $('searchBtn').onclick = () => { state.q = $('searchInput').value.trim(); state.page = 1; load(); };
      $('searchInput').onkeydown = (e) => {
        if (e.key === 'Enter') { state.q = e.target.value.trim(); state.page = 1; load(); }
      };
      $('addBtn').onclick = () => openModal('create', null);
      $('prevBtn').onclick = () => { if (state.page > 1) { state.page--; load(); } };
      $('nextBtn').onclick = () => { if (state.page < state.pages) { state.page++; load(); } };
      $('tplBtn').onclick = async () => {
        try { await API.download('/customers/template', cfg.title + '导入模板.xlsx'); }
        catch (ex) { alert(ex.message); }
      };
      $('importBtn').onclick = () => $('fileInput').click();
      $('fileInput').onchange = (e) => {
        const f = e.target.files[0];
        if (f) doImport(f);
        e.target.value = '';
      };
    }

    function bindRows(rows) {
      rows.forEach((row) => {
        const v = $('view_' + row.customer_id);
        const ed = $('edit_' + row.customer_id);
        const tg = $('toggle_' + row.customer_id);
        const del = $('del_' + row.customer_id);
        if (v) v.onclick = () => openModal('view', row);
        if (ed) ed.onclick = () => openModal('edit', row);
        if (tg) tg.onclick = () => toggle(row);
        if (del) del.onclick = () => confirmDelete(row);
        // 注意：列表页 sort 单元格不再有行内编辑入口（编辑已收敛至详情页 openModal）
      });
    }

    // ---------- 删除：二次确认弹窗（关键防呆） ----------
    // 只有点击「确定删除」才发起 DELETE 请求；后端关联校验失败时把
    // 「该客户下存在历史订单或工时记录，严禁删除…」原样展示在弹窗内
    function confirmDelete(row) {
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal">
          <div class="modal-head"><span>删除客户确认</span><button class="close" type="button">×</button></div>
          <div class="modal-body">
            <div class="del-warn">确定要删除客户 [${esc(row.company_name)}] 吗？删除后将不可恢复，且可能导致该客户的历史订单和工时数据无法追溯！</div>
            <div class="del-tip">若该客户存在历史订单或工时记录，系统将拒绝删除；建议改用「暂停 / 恢复」控制合作状态。</div>
            <div id="delErr" class="err" style="display:none"></div>
          </div>
          <div class="modal-foot">
            <button id="delOkBtn" class="danger" type="button">确定删除</button>
            <button class="close" type="button">取消</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
      modal.querySelector('#delOkBtn').onclick = async () => {
        const errEl = modal.querySelector('#delErr');
        try {
          await API.req('DELETE', '/customers/' + row.customer_id);
          modal.remove();
          load();
        } catch (ex) {
          errEl.style.display = 'block';
          errEl.textContent = ex.message;
        }
      };
    }

    // ---------- 手工表单：18 字段 + 分仓独立 sort_order（withWarehouse） ----------
    async function openModal(mode, row) {
      const isView = mode === 'view';
      const isEdit = mode === 'edit';
      let v = row || {};

      // ★ edit 时先拉详情 —— 列表返回的 row 没有 warehouse_sorts（所有仓的独立排序映射），
      // 只有 GET /customers/:id 详情接口才注入该字段
      if (isEdit && v.customer_id) {
        try {
          const detail = await API.get('/customers/' + v.customer_id);
          if (detail && detail.data) v = detail.data;
        } catch (e) { /* 拉不到就用列表数据降级 */ }
      }

      const d = isView ? 'disabled' : '';
      const curWh = String(v.warehouse || '').split(/[,，、]/).map((s) => s.trim());
      const wsMap = v.warehouse_sorts || {};  // 详情接口返回的 { '龙湖仓': 5, ... }

      // ★ withWarehouse 客户：每个仓独立 sort_order 输入；非 withWarehouse 或未勾选时保留全局 sort_order
      let sortSectionHtml;
      if (cfg.withWarehouse) {
        sortSectionHtml = `
          <div class="form-section">分仓独立排序（每个仓库可设不同序号，互不影响）</div>
          ${WAREHOUSES.map((wh) => {
            const checked = curWh.includes(wh);
            const curSo = wsMap[wh];  // null/undefined 表示未设置
            const soVal = (curSo != null && curSo !== '' && Number(curSo) !== 9999) ? curSo : '';
            const disabled = (!checked || isView) ? 'disabled' : '';
            return `<label class="field wh-sort-field" data-wh="${wh}">
              <span class="wh-sort-label">${esc(wh)}排序号</span>
              <input id="f_sort_${wh}" type="number" min="1" step="1"
                placeholder="留空则排最后"
                value="${soVal}" ${disabled}>
            </label>`;
          }).join('')}
        `;
      } else {
        const soVal = (v.sort_order != null && v.sort_order !== '' && Number(v.sort_order) !== 9999) ? v.sort_order : '';
        sortSectionHtml = `
          <div class="form-section">排序设置</div>
          <label class="field">排序号<input id="f_sort_order" type="number" min="1" step="1" placeholder="留空默认排最后" value="${soVal}" ${d}></label>
        `;
      }

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal wide">
          <div class="modal-head"><span>${isView ? '查看' : isEdit ? '编辑' : '新增'}${cfg.title}</span><button class="close" type="button">×</button></div>
          <div class="modal-body">
            <div class="form-section">基础信息</div>
            <label class="field">货主代码<input id="f_code" value="${esc(v.customer_code || '')}" ${d}></label>
            <label class="field">公司全称*<input id="f_company" value="${esc(v.company_name || '')}" ${d}></label>
            <label class="field">客户简称<input id="f_short" value="${esc(v.short_name || '')}" ${d}></label>
            ${cfg.withWarehouse ? `
            <div class="field full"><span>所在仓库*（可多选）</span>
              <div class="multi-select" id="f_wh">
                ${WAREHOUSES.map((w) => `<label class="chk"><input type="checkbox" value="${w}" ${curWh.includes(w) ? 'checked' : ''} ${d}>${w}</label>`).join('')}
              </div>
            </div>` : ''}
            <label class="field">客户联系人<input id="f_contact" value="${esc(v.contact_person || '')}" ${d}></label>
            <label class="field">联系电话<input id="f_phone" value="${esc(v.phone || '')}" ${d}></label>
            <label class="field full">客户地址<input id="f_address" value="${esc(v.address || '')}" ${d}></label>
            <label class="field">ERP版本名称<input id="f_erp" value="${esc(v.erp_version || '')}" ${d}></label>
            <label class="field">产品类型<input id="f_product" value="${esc(v.product_type || '')}" ${d}></label>

            <div class="form-section">业务配置</div>
            <label class="field">电商平台<input id="f_platform" value="${esc(v.ecommerce_platform || '')}" ${d}></label>
            <label class="field">商品种类数<input id="f_count" type="number" min="0" step="1" value="${v.product_count != null ? v.product_count : 0}" ${d}></label>
            <label class="field">打款账户<input id="f_account" value="${esc(v.payment_account || '')}" ${d}></label>
            <label class="field">预充单价<input id="f_price" type="number" min="0" step="0.001" value="${v.prepaid_price != null ? v.prepaid_price : 0}" ${d}></label>
            <label class="field">截单时间<input id="f_cutoff" type="time" value="${esc(v.cutoff_time || '')}" ${d}></label>
            <label class="field">物流公司控制<input id="f_logistics" value="${esc(v.logistics_control || '')}" ${d}></label>
            <label class="field">效期管理<select id="f_expiry" ${d}>${opts(['是', '否'], v.expiry_mgmt || '否')}</select></label>
            <label class="field">合作状态<select id="f_coop" ${d}>${opts(COOP, v.coop_status || '合作中')}</select></label>

            ${sortSectionHtml}

            <label class="field full">备注<textarea id="f_remark" ${d}>${esc(v.remark || '')}</textarea></label>
            <div id="f_err" class="err full"></div>
          </div>
          <div class="modal-foot">
            ${isView
              ? '<button class="close" type="button">关闭</button>'
              : '<button id="saveBtn" class="primary" type="button">保存</button><button class="close" type="button">取消</button>'}
          </div>
        </div>`;
      document.body.appendChild(modal);
      // 记录原全局排序号：withWarehouse 客户未显式设置某仓排序时，仍以它作为回退值
      modal.dataset.globalSort = String(v.sort_order != null && v.sort_order !== '' ? v.sort_order : 9999);
      modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));

      // ★ 仓库 checkbox 联动 sort_order 输入框启用/禁用
      if (cfg.withWarehouse && !isView) {
        const whBoxes = modal.querySelectorAll('#f_wh input[type="checkbox"]');
        whBoxes.forEach((cb) => {
          cb.addEventListener('change', () => {
            const soInput = modal.querySelector(`[id="f_sort_${cb.value}"]`);
            if (soInput) soInput.disabled = !cb.checked;
          });
        });
      }

      if (!isView) modal.querySelector('#saveBtn').onclick = () => save(mode, v.customer_id, modal);
    }

    function collect(modal) {
      const val = (id) => {
        const el = modal.querySelector('#' + id);
        return el ? String(el.value || '').trim() : '';
      };
      const wh = cfg.withWarehouse
        ? Array.from(modal.querySelectorAll('#f_wh input[type="checkbox"]:checked')).map((x) => x.value)
        : [];
      const p = {
        customer_type: cfg.type,
        customer_code: val('f_code') || null,
        company_name: val('f_company'),
        short_name: val('f_short'),
        warehouse: wh,
        contact_person: val('f_contact'),
        phone: val('f_phone'),
        address: val('f_address'),
        erp_version: val('f_erp'),
        product_type: val('f_product'),
        ecommerce_platform: val('f_platform'),
        product_count: val('f_count') || 0,
        payment_account: val('f_account'),
        prepaid_price: val('f_price') || 0,
        cutoff_time: val('f_cutoff') || null,
        logistics_control: val('f_logistics'),
        expiry_mgmt: val('f_expiry'),
        coop_status: val('f_coop'),
        remark: val('f_remark'),
      };

      // ★ 分仓独立 sort_order 收集（withWarehouse 客户）
      if (cfg.withWarehouse && wh.length) {
        const ws = {};
        for (const checkedWh of wh) {
          const soVal = val('f_sort_' + checkedWh);
          if (soVal !== '' && soVal !== null && soVal !== undefined) {
            const so = Number(soVal);
            if (Number.isInteger(so) && so > 0) ws[checkedWh] = so;
          }
        }
        if (Object.keys(ws).length) p.warehouse_sorts = ws;
        // 保留客户原有全局排序号（未单独设置排序的仓库仍以它为回退值），不要清成 9999
        const keep = Number(modal.dataset.globalSort);
        p.sort_order = Number.isFinite(keep) && keep > 0 ? keep : 9999;
      } else {
        // 非 withWarehouse 或未选任何仓：走全局 sort_order
        const soVal = val('f_sort_order');
        p.sort_order = soVal === '' ? 9999 : Number(soVal);
      }
      return p;
    }

    async function save(mode, id, modal) {
      const p = collect(modal);
      const errEl = modal.querySelector('#f_err');
      if (!p.company_name) { errEl.textContent = '公司全称必填'; return; }
      if (cfg.withWarehouse && !p.warehouse.length) { errEl.textContent = '所在仓库至少选择一项'; return; }

      // ★ 分仓独立排序号校验
      if (p.warehouse_sorts) {
        for (const [wh, soVal] of Object.entries(p.warehouse_sorts)) {
          if (!Number.isInteger(soVal) || soVal <= 0) {
            errEl.textContent = `${wh}排序号必须为正整数`;
            return;
          }
        }
      }
      // 全局 sort_order 校验（非 withWarehouse 路径）
      if (!cfg.withWarehouse && p.sort_order !== 9999) {
        if (!Number.isInteger(p.sort_order) || p.sort_order <= 0) {
          errEl.textContent = '排序号必须为正整数（留空则排最后）';
          return;
        }
      }

      const saveBtn = modal.querySelector('#saveBtn');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
      try {
        if (mode === 'create') await API.post('/customers', p);
        else await API.put('/customers/' + id, p);
        modal.remove();
        load();
      } catch (ex) {
        errEl.textContent = ex.message;
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
      }
    }

    async function toggle(row) {
      if (!confirm(`确认将「${row.company_name}」${row.coop_status === '合作中' ? '暂停合作' : '恢复合作'}？`)) return;
      try {
        await API.post('/customers/' + row.customer_id + '/toggle-status', {});
        load();
      } catch (ex) { alert(ex.message); }
    }

    // ---------- Excel 导入与结果弹窗 ----------
    async function doImport(file) {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('customer_type', cfg.type);
      try {
        const r = await API.upload('/customers/import', fd);
        showImportResult(r);
        load();
      } catch (ex) {
        alert('导入失败：' + ex.message);
      }
    }

    function showImportResult(r) {
      const failures = r.failures || [];
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal wide">
          <div class="modal-head"><span>导入结果</span><button class="close" type="button">×</button></div>
          <div class="modal-body import-result">
            <div class="result-ok">导入成功 ${r.success} 条（新增 ${r.created} / 更新 ${r.updated}）${failures.length ? `，失败 ${failures.length} 条` : ''}</div>
            ${failures.length ? `
            <div class="result-title">导入失败清单（已跳过，可修正后重新导入）</div>
            <table class="grid fail-grid">
              <thead><tr><th>Excel 行号</th><th>错误原因</th></tr></thead>
              <tbody>${failures.map((f) => `<tr><td>第 ${f.row} 行</td><td>${esc(f.reason)}</td></tr>`).join('')}</tbody>
            </table>` : ''}
          </div>
          <div class="modal-foot"><button class="close primary" type="button">关闭</button></div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
    }

    return function mount(pageHost) {
      host = pageHost;
      load();
    };
  }

  window.ERP_PAGES = window.ERP_PAGES || {};
  Object.keys(CONFIG).forEach((k) => { window.ERP_PAGES[k] = createPage(CONFIG[k]); });
  // 兼容旧持久化 Tab：独立实例，避免与其他页共享 host
  window.ERP_PAGES.customers = createPage(CONFIG.cust_wh);
})();
