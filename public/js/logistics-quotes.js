// 物流报价（基础资料 → 物流报价）：维护各快递网点计费规则
// 列表 + 新增/编辑弹窗（含动态「公斤段报价」子表格：可增删行）
// 权限：仅 管理员 / 超级管理员 可写；菜单也只在这两个角色授权树中（后端 menuGate 二次校验）
(function () {
  const PAGE = 'logi_quotes';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const num = (x) => (x == null || x === '' ? '0' : Number(x)).toFixed(0);

  // 角色权限：仅 管理员 / 超级管理员 可新增、编辑、删除
  function canWrite() {
    const role = (window.ERP_USER || {}).role;
    return role === '管理员' || role === '超级管理员';
  }

  // 公斤段重叠校验（与后端规则一致，双重保险）：
  // 按 min 升序后，下一区间起始 < 当前区间上限（上限为 null 即不限）即视为重叠/包含
  function validateSegments(rules) {
    const sorted = rules.slice().sort((a, b) => (Number(a.min) || 0) - (Number(b.min) || 0));
    for (let i = 0; i < sorted.length - 1; i++) {
      const curMax = (sorted[i].max == null || sorted[i].max === '') ? Infinity : Number(sorted[i].max);
      if (Number(sorted[i + 1].min) < curMax) {
        return { ok: false, msg: '公斤段报价区间存在重叠（如0-3kg与2-5kg），请检查修改！' };
      }
    }
    return { ok: true };
  }

  function createPage() {
    const state = { page: 1, pages: 1, q: '', pageSize: 20 };
    let host = null;
    let editState = null; // 编辑弹窗的临时状态：{ code, network_name, volume_ratio, regions:[{province,city,district,price_rules,remark}] }
    const $ = (id) => host && host.querySelector('#' + id);

    function query() {
      return '/logistics-quotes?' + new URLSearchParams({ q: state.q, page: state.page, pageSize: state.pageSize });
    }
    async function load() {
      try {
        const r = await API.get(query());
        render(r);
      } catch (e) {
        host.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + ' <a href="#" id="retry">点击重试</a></div>';
        const rt = host.querySelector('#retry'); if (rt) rt.onclick = (ev) => { ev.preventDefault(); load(); };
      }
    }

    function render(r) {
      const rows = r.data || [];
      const total = r.total || 0;
      state.pages = Math.ceil(total / state.pageSize) || 1;
      host.innerHTML = `
        <div class="toolbar">
          <input id="searchInput" placeholder="搜索网点名称 / 快递编码" value="${esc(state.q)}">
          <button id="searchBtn">搜索</button>
          ${canWrite() ? '<button id="addBtn" class="primary">+ 新增报价</button>' : ''}
          ${canWrite() ? '<button id="tplBtn" class="ghost" type="button">⬇ 下载导入模板</button>' : ''}
          ${canWrite() ? '<button id="xlsBtn" class="ghost" type="button">⬆ 导入 Excel</button><input id="xlsInput" type="file" accept=".xlsx,.xls" style="display:none">' : ''}
          <button id="exportBtn" class="ghost" type="button">⬇ 导出 Excel</button>
          <span id="impMsg" class="sq-msg info"></span>
        </div>
        <table class="grid">
          <thead><tr><th>网点名称</th><th>快递编码</th><th>抛比</th><th>覆盖规则数</th><th>操作</th></tr></thead>
          <tbody>${rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="5" class="empty">暂无数据</td></tr>`}</tbody>
        </table>
        <div class="pager">
          <button id="prevBtn" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${state.page} / ${state.pages} 页（共 ${total} 条）</span>
          <button id="nextBtn" ${state.page >= state.pages ? 'disabled' : ''}>下一页</button>
        </div>`;
      bind();
      bindRows();
    }

    function rowHtml(g) {
      const code = g.express_code || '';
      const conflict = g.ratio_conflict
        ? ' <span class="warn" title="同一编码下抛比不一致，请检查数据">⚠️</span>' : '';
      const view = `<button data-code="${esc(code)}" data-act="view">查看</button>`;
      const ops = canWrite()
        ? view
          + `<button data-code="${esc(code)}" data-act="edit">编辑</button>`
          + `<button data-code="${esc(code)}" data-act="del" class="danger">删除</button>`
        : view;
      return `<tr>
        <td>${esc(g.network_name || '')}</td>
        <td>${esc(code)}</td>
        <td class="num">${num(g.volume_ratio)}${conflict}</td>
        <td>包含 ${g.region_count} 个区域</td>
        <td class="ops">${ops}</td></tr>`;
    }

    function bind() {
      $('searchBtn').onclick = () => { state.q = $('searchInput').value.trim(); state.page = 1; load(); };
      $('searchInput').onkeydown = (e) => { if (e.key === 'Enter') { state.q = e.target.value.trim(); state.page = 1; load(); } };
      if (canWrite()) $('addBtn').onclick = () => openModal('create', null);
      if (canWrite()) {
        $('tplBtn').onclick = onDownloadTemplate;
        $('xlsBtn').onclick = onPickFile;
        $('xlsInput').onchange = onUpload;
      }
      $('exportBtn').onclick = onExport; // 导出只读：所有可访问本页角色均可用
      $('prevBtn').onclick = () => { if (state.page > 1) { state.page--; load(); } };
      $('nextBtn').onclick = () => { if (state.page < state.pages) { state.page++; load(); } };
    }
    // 列表按钮统一按 data-code + data-act 委托绑定
    function bindRows() {
      host.querySelectorAll('.grid tbody button[data-code]').forEach((b) => {
        const code = b.getAttribute('data-code');
        const act = b.getAttribute('data-act');
        b.onclick = () => {
          if (act === 'view') openViewByCode(code);
          else if (act === 'edit') openEditByCode(code);
          else if (act === 'del') confirmDeleteByCode(code);
        };
      });
    }

    // ---------- 动态公斤段报价子表格 ----------
    function renderPriceRows(box, rows) {
      box.innerHTML = `
        <div class="sub-grid-head"><span>起始重量(kg)</span><span>结束重量(kg)</span><span>价格(元)</span><span></span></div>
        <div id="prRows">${rows.map((x) => priceRowHtml(x)).join('')}</div>
        <button type="button" id="addRowBtn" class="ghost">+ 添加一行</button>`;
      box.querySelector('#addRowBtn').onclick = () => {
        box.querySelector('#prRows').insertAdjacentHTML('beforeend', priceRowHtml({ min: '', max: '', price: '' }));
        bindRowDel(box);
      };
      bindRowDel(box);
    }
    function priceRowHtml(x) {
      return `<div class="sub-grid-row">
        <input class="pr-min" type="number" min="0" step="0.01" value="${x.min != null ? x.min : ''}" placeholder="0">
        <input class="pr-max" type="number" min="0" step="0.01" value="${x.max != null ? x.max : ''}" placeholder="不限">
        <input class="pr-price" type="number" min="0" step="0.001" value="${x.price != null ? x.price : ''}" placeholder="0.00">
        <button type="button" class="pr-del danger">删除</button></div>`;
    }
    function bindRowDel(box) {
      box.querySelectorAll('.pr-del').forEach((b) => { b.onclick = () => b.closest('.sub-grid-row').remove(); });
    }
    // 收集为 [{min,max,price}]；空行跳过；max 空 → null（不限上限）
    function collectPriceRows(modal) {
      const out = [];
      modal.querySelectorAll('#prRows .sub-grid-row').forEach((row) => {
        const min = row.querySelector('.pr-min').value.trim();
        const max = row.querySelector('.pr-max').value.trim();
        const price = row.querySelector('.pr-price').value.trim();
        if (min === '' && max === '' && price === '') return;
        out.push({
          min: min === '' ? 0 : Number(min),
          max: max === '' ? null : Number(max),
          price: price === '' ? 0 : Number(price),
        });
      });
      return out;
    }

    function openModal(mode, row) {
      const isEdit = mode === 'edit';
      const v = row || {};
      let rules = [];
      try { rules = v.price_rules ? JSON.parse(v.price_rules) : []; } catch (e) { rules = []; }
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal wide">
          <div class="modal-head"><span>${isEdit ? '编辑' : '新增'}物流报价</span><button class="close" type="button">×</button></div>
          <div class="modal-body">
            <div class="form-section">基础信息</div>
            <label class="field">网点名称*<input id="f_net" value="${esc(v.network_name || '')}"></label>
            <label class="field">快递编码*<input id="f_code" value="${esc(v.express_code || '')}" placeholder="如：中通-杭州网点"></label>
            <label class="field">抛比<input id="f_ratio" type="number" min="1" step="1" value="${v.volume_ratio != null ? v.volume_ratio : 6000}"></label>
            <label class="field full">备注<input id="f_remark" value="${esc(v.remark || '')}"></label>
            <div class="form-section">公斤段报价（可动态增删行）</div>
            <div id="priceBox"></div>
            <div id="f_err" class="err full"></div>
          </div>
          <div class="modal-foot">
            <button id="saveBtn" class="primary" type="button">保存</button>
            <button class="close" type="button">取消</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      renderPriceRows(modal.querySelector('#priceBox'), rules);
      modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
      modal.querySelector('#saveBtn').onclick = () => save(mode, v.id, modal);
    }

    function save(mode, id, modal) {
      const errEl = modal.querySelector('#f_err');
      const network = modal.querySelector('#f_net').value.trim();
      const code = modal.querySelector('#f_code').value.trim();
      if (!network) { errEl.textContent = '网点名称必填'; return; }
      if (!code) { errEl.textContent = '快递编码必填'; return; }
      const rules = collectPriceRows(modal);
      const v = validateSegments(rules);     // 前端即时红字警告并阻断
      if (!v.ok) { errEl.textContent = v.msg; return; }
      const payload = {
        network_name: network,
        express_code: code,
        volume_ratio: Number(modal.querySelector('#f_ratio').value),
        price_rules: rules,                  // 后端再排序 + 复核后入库
        remark: modal.querySelector('#f_remark').value.trim(),
      };
      const run = mode === 'create'
        ? API.post('/logistics-quotes', payload)
        : API.put('/logistics-quotes/' + id, payload);
      run.then(() => { modal.remove(); load(); })
         .catch((ex) => { errEl.textContent = ex.message; });
    }

    // ---------- 查看详情弹窗（Excel 二维表格 + 行内编辑） ----------
    // 表头/首列固定、1-40kg 横向滚动；地址用后端清洗后的 *_disp 展示；行内编辑只 UPDATE 目标行
    const WEIGHTS = Array.from({ length: 40 }, (_, i) => i + 1);
    // 列宽常量（与 style.css 中 --cw-* 完全一致）：table-layout:fixed 下靠 colgroup 锁宽
    const COLW = { addr: 112, ratio: 66, w: 64, op: 96 };
    const GRID_W = COLW.addr * 3 + COLW.ratio + COLW.w * WEIGHTS.length + COLW.op; // 表格总宽(px)
    // 冻结列左侧偏移（内联注入，与 colgroup 列宽同源，杜绝漂移）：省=0 / 市=112 / 区=224 / 抛比=336
    const FRZ = {
      prov: 'left:0',
      city: `left:${COLW.addr}px`,
      dist: `left:${COLW.addr * 2}px`,
      ratio: `left:${COLW.addr * 3}px`,
    };
    const frzStyle = (key) => ` style="${FRZ[key]}"`;
    function priceMapOf(row) {
      let rules = [];
      try { rules = JSON.parse(row.price_rules || '[]'); } catch (e) { rules = []; }
      const m = {};
      (Array.isArray(rules) ? rules : []).forEach((x) => { m[Number(x.weight)] = x.price; });
      return m;
    }
    // 展示优先用清洗后的值（后端 normalizeRegion）。
    // 省份为空显示「未知」并加样式标记（绝不让列看起来消失）；市/区县为空显示 '-'
    function dispAddr(row, key) {
      const disp = row[key + '_disp'];
      const v = disp != null && String(disp).trim() !== '' ? disp : row[key];
      const has = v != null && String(v).trim() !== '';
      if (has) return esc(String(v).trim());
      if (key === 'province') return '<span class="addr-unknown" title="该行省份为空">未知</span>';
      return '-';
    }

    async function openViewByCode(code) {
      try {
        const r = await API.get('/logistics-quotes/by-code?code=' + encodeURIComponent(code));
        let list = r.data || [];
        let editingIdx = null; // 同一网点仅允许一行处于编辑态
        const netName = list.length ? (list[0].network_name || '') : '';

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
          <div class="modal modal-xls">
            <div class="modal-head">
              <span>查看 / 编辑物流报价 · ${esc(code)}${netName ? '（' + esc(netName) + '）' : ''}
                <small class="xls-hint">表头与左侧省份/城市/区县列固定，横向滚动查看 1-40kg；空价格段显示 “-”，省份为空显示 “未知”</small>
              </span>
              <button class="close" type="button">×</button>
            </div>
            <div class="modal-body xls-body">
              <div id="xlsErr" class="xls-err"></div>
              <div id="xlsWrap" class="xls-wrap"></div>
            </div>
            <div class="modal-foot"><button id="xlsReload" class="ghost" type="button">刷新</button><button class="close" type="button">关闭</button></div>
          </div>`;
        document.body.appendChild(modal);
        modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        const wrap = modal.querySelector('#xlsWrap');
        const errEl = modal.querySelector('#xlsErr');

        function setErr(msg) { if (errEl) errEl.textContent = msg || ''; }

        function headHtml() {
          // <colgroup> 严格锁定每一列宽度：省/市/区/抛比 + 40 个重量列 + 操作
          const cols = [
            `<col style="width:${COLW.addr}px">`,
            `<col style="width:${COLW.addr}px">`,
            `<col style="width:${COLW.addr}px">`,
            `<col style="width:${COLW.ratio}px">`,
            ...WEIGHTS.map(() => `<col style="width:${COLW.w}px">`),
            `<col style="width:${COLW.op}px">`,
          ].join('');
          return `<table class="xls-tbl" style="width:${GRID_W}px">
            <colgroup>${cols}</colgroup>
            <thead><tr>
              <th class="stick c-prov"${frzStyle('prov')} title="省份（冻结列）">省份</th>
              <th class="stick c-city"${frzStyle('city')} title="城市（冻结列）">城市</th>
              <th class="stick c-dist"${frzStyle('dist')} title="区县（冻结列）">区县</th>
              <th class="stick c-ratio"${frzStyle('ratio')} title="抛比（冻结列）">抛比</th>
              ${WEIGHTS.map((w) => `<th class="num c-w">${w}kg</th>`).join('')}
              <th class="stick c-op" title="操作（冻结列）">操作</th>
            </tr></thead><tbody>${bodyHtml()}</tbody></table>`;
        }

        function bodyHtml() {
          if (!list.length) return `<tr><td class="empty" colspan="${4 + 40 + 1}">该编码下暂无区域明细</td></tr>`;
          return list.map((row, i) => (i === editingIdx ? editRowHtml(row, i) : viewRowHtml(row, i))).join('');
        }

        function viewRowHtml(row, i) {
          const pm = priceMapOf(row);
          const cells = WEIGHTS.map((w) => `<td class="num c-w">${pm[w] == null ? '-' : Number(pm[w]).toFixed(2)}</td>`).join('');
          const op = canWrite()
            ? `<button class="xls-edit" data-i="${i}" type="button">编辑</button>`
            : '<span class="ro">只读</span>';
          return `<tr data-i="${i}">
            <td class="stick c-prov"${frzStyle('prov')}>${dispAddr(row, 'province')}</td>
            <td class="stick c-city"${frzStyle('city')}>${dispAddr(row, 'city')}</td>
            <td class="stick c-dist"${frzStyle('dist')}>${dispAddr(row, 'district')}</td>
            <td class="stick c-ratio num"${frzStyle('ratio')}>${num(row.volume_ratio)}</td>
            ${cells}
            <td class="stick c-op">${op}</td></tr>`;
        }

        function editRowHtml(row, i) {
          const pm = priceMapOf(row);
          const inp = (key) => {
            const dv = row[key + '_disp'] != null && row[key + '_disp'] !== '' ? row[key + '_disp'] : (row[key] || '');
            return esc(dv);
          };
          const cells = WEIGHTS.map((w) =>
            `<td class="num c-w"><input class="ve-price" type="number" min="0" step="0.001" data-w="${w}" value="${pm[w] == null ? '' : pm[w]}" placeholder="-"></td>`
          ).join('');
          return `<tr class="editing" data-i="${i}">
            <td class="stick c-prov"${frzStyle('prov')}><input class="ve-prov" type="text" value="${inp('province')}" placeholder="省"></td>
            <td class="stick c-city"${frzStyle('city')}><input class="ve-city" type="text" value="${inp('city')}" placeholder="市"></td>
            <td class="stick c-dist"${frzStyle('dist')}><input class="ve-dist" type="text" value="${inp('district')}" placeholder="区县"></td>
            <td class="stick c-ratio"${frzStyle('ratio')}><input class="ve-ratio" type="number" min="1" step="1" value="${esc(row.volume_ratio)}"></td>
            ${cells}
            <td class="stick c-op">
              <button class="ve-save" data-i="${i}" type="button">保存</button>
              <button class="ve-cancel" type="button">取消</button></td></tr>`;
        }

        function render() { if (wrap) wrap.innerHTML = headHtml(); bindCells(); }

        function bindCells() {
          wrap.querySelectorAll('.xls-edit').forEach((b) => {
            b.onclick = () => {
              if (editingIdx != null && editingIdx !== Number(b.getAttribute('data-i'))) {
                setErr('请先保存或取消当前正在编辑的行'); return;
              }
              setErr('');
              editingIdx = Number(b.getAttribute('data-i'));
              render();
            };
          });
          const cancel = wrap.querySelector('.ve-cancel');
          if (cancel) cancel.onclick = () => { editingIdx = null; setErr(''); render(); };
          const save = wrap.querySelector('.ve-save');
          if (save) save.onclick = () => saveRow(Number(save.getAttribute('data-i')));
        }

        async function saveRow(i) {
          const tr = wrap.querySelector('tr.editing');
          if (!tr) return;
          const ratioRaw = tr.querySelector('.ve-ratio').value.trim();
          if (!/^\d+$/.test(ratioRaw) || Number(ratioRaw) <= 0) { setErr('抛比必须为正整数'); return; }
          const rules = [];
          let bad = false;
          tr.querySelectorAll('.ve-price').forEach((inp) => {
            const v = inp.value.trim();
            if (v === '') return;
            const n = Number(v);
            if (!isFinite(n) || n < 0) { bad = true; return; }
            rules.push({ weight: Number(inp.getAttribute('data-w')), price: n });
          });
          if (bad) { setErr('1-40kg 价格必须为非负数字'); return; }

          const row = list[i];
          const payload = {
            express_code: code,
            old: { province: row.province || '', city: row.city || '', district: row.district || '' },
            province: tr.querySelector('.ve-prov').value.trim(),
            city: tr.querySelector('.ve-city').value.trim(),
            district: tr.querySelector('.ve-dist').value.trim(),
            volume_ratio: Number(ratioRaw),
            price_rules: rules,
          };
          const btn = tr.querySelector('.ve-save');
          if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
          try {
            await API.put('/logistics-quotes/region', payload);
            const rr = await API.get('/logistics-quotes/by-code?code=' + encodeURIComponent(code));
            list = rr.data || [];
            editingIdx = null;
            setErr('已保存');
            render();
          } catch (ex) {
            setErr('保存失败：' + ex.message);
            if (btn) { btn.disabled = false; btn.textContent = '保存'; }
          }
        }

        modal.querySelector('#xlsReload').onclick = async () => {
          try {
            const rr = await API.get('/logistics-quotes/by-code?code=' + encodeURIComponent(code));
            list = rr.data || []; editingIdx = null; setErr(''); render();
          } catch (ex) { setErr('刷新失败：' + ex.message); }
        };

        render();
      } catch (e) {
        alert('查看失败：' + e.message);
      }
    }

    // ---------- 编辑弹窗（按快递编码取全部区域，逐条改/新增区域；不删原有数据，整编码事务覆盖） ----------
    async function openEditByCode(code) {
      try {
        const r = await API.get('/logistics-quotes/by-code?code=' + encodeURIComponent(code));
        const list = r.data || [];
        editState = {
          code,
          network_name: list.length ? (list[0].network_name || '') : '',
          volume_ratio: list.length ? Number(list[0].volume_ratio || 6000) : 6000,
          regions: list.map((row) => {
            let rules = [];
            try { rules = JSON.parse(row.price_rules || '[]'); } catch (e) { rules = []; }
            return {
              province: row.province || '', city: row.city || '', district: row.district || '',
              price_rules: rules, remark: row.remark || '',
            };
          }),
        };
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
          <div class="modal wide">
            <div class="modal-head"><span>编辑物流报价 · ${esc(code)}</span><button class="close" type="button">×</button></div>
            <div class="modal-body">
              <div class="form-section">网点信息</div>
              <label class="field">网点名称*<input id="ed_net" value="${esc(editState.network_name)}"></label>
              <label class="field">抛比*<input id="ed_ratio" type="number" min="1" step="1" value="${editState.volume_ratio}"></label>
              <div class="form-section">区域列表（逐条修改或新增；保存时按编码整批覆盖）</div>
              <div id="edRegions"></div>
              <button type="button" id="edAdd" class="ghost">+ 新增区域</button>
              <div id="ed_err" class="err full"></div>
            </div>
            <div class="modal-foot">
              <button id="edSave" class="primary" type="button">保存</button>
              <button class="close" type="button">取消</button>
            </div>
          </div>`;
        document.body.appendChild(modal);
        renderEditRegions(modal.querySelector('#edRegions'));
        modal.querySelector('#edAdd').onclick = () => {
          editState.regions.push({ province: '', city: '', district: '', price_rules: [], remark: '' });
          renderEditRegions(modal.querySelector('#edRegions'));
        };
        modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        modal.querySelector('#edSave').onclick = () => saveEditByCode(modal);
      } catch (e) {
        alert('打开编辑失败：' + e.message);
      }
    }

    // 渲染编辑弹窗里的区域编辑行
    function renderEditRegions(box) {
      if (!editState) return;
      box.innerHTML = `
        <div class="sub-grid-head region-head-edit"><span>省</span><span>市</span><span>区/县</span><span>已定价(kg)</span><span></span></div>
        <div id="edRows">${editState.regions.map((_, i) => regionEditRowHtml(i)).join('')}</div>`;
      box.querySelectorAll('.region-edit-row').forEach((row) => {
        const i = Number(row.getAttribute('data-i'));
        row.querySelector('.ed-prov').addEventListener('input', (e) => { editState.regions[i].province = e.target.value; });
        row.querySelector('.ed-city').addEventListener('input', (e) => { editState.regions[i].city = e.target.value; });
        row.querySelector('.ed-dist').addEventListener('input', (e) => { editState.regions[i].district = e.target.value; });
      });
      box.querySelectorAll('.ed-price').forEach((b) => {
        b.onclick = () => openPriceGrid(Number(b.getAttribute('data-i')));
      });
      box.querySelectorAll('.ed-del').forEach((b) => {
        b.onclick = () => {
          const i = Number(b.getAttribute('data-i'));
          editState.regions.splice(i, 1);
          renderEditRegions(box);
        };
      });
    }
    // 单行：省/市/区输入 + 编辑价格按钮（显示已定价重量数）+ 删除X
    function regionEditRowHtml(i) {
      const r = editState.regions[i];
      const priced = (r.price_rules || []).length;
      return `<div class="sub-grid-row region-edit-row" data-i="${i}">
        <input class="ed-prov" type="text" value="${esc(r.province)}" placeholder="省（空=全国）">
        <input class="ed-city" type="text" value="${esc(r.city)}" placeholder="市">
        <input class="ed-dist" type="text" value="${esc(r.district)}" placeholder="区/县">
        <button type="button" class="ed-price" data-i="${i}">价格(${priced})</button>
        <button type="button" class="ed-del danger" data-i="${i}">×</button></div>`;
    }

    // ---------- 价格网格子编辑器（离散 1-40kg；嵌套弹窗，保存到 editState.regions[i].price_rules） ----------
    function openPriceGrid(i) {
      if (!editState) return;
      const r = editState.regions[i];
      const map = {};
      (r.price_rules || []).forEach((x) => { map[Number(x.weight)] = x.price; });
      const cells = [];
      for (let w = 1; w <= 40; w++) {
        cells.push(`<label class="pg-cell"><span>${w}kg</span><input type="number" min="0" step="0.001" data-w="${w}" value="${map[w] != null ? map[w] : ''}" placeholder="-"></label>`);
      }
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      const area = [r.province, r.city, r.district].filter(Boolean).join('/') || '全国/不限';
      modal.innerHTML = `
        <div class="modal">
          <div class="modal-head"><span>编辑价格 · ${esc(area)}</span><button class="close" type="button">×</button></div>
          <div class="modal-body"><div class="pg-grid">${cells.join('')}</div></div>
          <div class="modal-foot">
            <button id="pgSave" class="primary" type="button">保存价格</button>
            <button class="close" type="button">取消</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('#pgSave').onclick = () => {
        const out = [];
        modal.querySelectorAll('.pg-cell input').forEach((inp) => {
          const w = Number(inp.getAttribute('data-w'));
          const v = inp.value.trim();
          if (v !== '') out.push({ weight: w, price: Number(v) });
        });
        editState.regions[i].price_rules = out;
        modal.remove();
        const box = document.querySelector('#edRegions');
        if (box) renderEditRegions(box); // 刷新"已定价"计数
      };
      modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    }

    function saveEditByCode(modal) {
      const errEl = modal.querySelector('#ed_err');
      errEl.textContent = '';
      const network = modal.querySelector('#ed_net').value.trim();
      const ratio = Number(modal.querySelector('#ed_ratio').value);
      if (!network) { errEl.textContent = '网点名称必填'; return; }
      if (!Number.isInteger(ratio) || ratio <= 0) { errEl.textContent = '抛比必须为正整数'; return; }
      // 回写省/市/区输入到 editState（价格已在各自子编辑器里）
      modal.querySelectorAll('#edRows .region-edit-row').forEach((row, idx) => {
        editState.regions[idx].province = row.querySelector('.ed-prov').value.trim();
        editState.regions[idx].city = row.querySelector('.ed-city').value.trim();
        editState.regions[idx].district = row.querySelector('.ed-dist').value.trim();
      });
      if (!editState.regions.length) { errEl.textContent = '至少需要一个区域报价'; return; }
      const payload = {
        express_code: editState.code,
        network_name: network,
        volume_ratio: ratio,
        regions: editState.regions.map((r) => ({
          province: r.province, city: r.city, district: r.district,
          price_rules: r.price_rules || [], remark: r.remark || '',
        })),
      };
      API.put('/logistics-quotes/by-code', payload)
        .then(() => { modal.remove(); load(); })
        .catch((ex) => { errEl.textContent = ex.message; });
    }

    // ---------- 删除（按编码清空该编码下所有明细；二次确认） ----------
    function confirmDeleteByCode(code) {
      const tip = `确认删除快递编码「${code}」下的全部省市区报价明细？此操作不可恢复。`;
      if (!confirm(tip)) return;
      if (!confirm(`再次确认：将永久删除「${code}」的所有区域报价（共一批），确定？`)) return;
      API.req('DELETE', '/logistics-quotes/by-code?code=' + encodeURIComponent(code))
        .then(() => load())
        .catch((ex) => alert('删除失败：' + ex.message));
    }

    // ---------- 导入模板下载 + Excel 批量导入 ----------
    function setImpMsg(text, kind) {
      const el = $('impMsg');
      if (el) { el.textContent = text || ''; el.className = 'sq-msg ' + (kind || 'info'); }
    }
    function onDownloadTemplate() {
      API.download('/logistics-quotes/template', '物流报价导入模板.xlsx')
        .then(() => setImpMsg('模板已下载 ✓', 'ok'))
        .catch((e) => { setImpMsg('模板下载失败：' + e.message, 'err'); alert('模板下载失败：' + e.message); });
    }
    // 导出 Excel：跟随当前搜索条件，全量明细（展开到省市区），纯只读
    async function onExport() {
      const btn = $('exportBtn');
      if (btn) btn.disabled = true;
      setImpMsg('正在生成 Excel…', 'info');
      try {
        const qs = new URLSearchParams({ q: state.q || '' });
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const tag = (state.q || '').replace(/[\\/:*?"<>|]/g, '_');
        const name = '物流报价_' + (tag ? tag + '_' : '') + stamp + '.xlsx';
        await API.download('/logistics-quotes/export?' + qs.toString(), name);
        setImpMsg('导出完成 ✓（' + (state.q ? '搜索：' + state.q : '全部网点') + '）', 'ok');
      } catch (e) {
        setImpMsg('导出失败：' + e.message, 'err');
        alert('导出失败：' + e.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    }
    function onPickFile() {
      const input = $('xlsInput');
      if (input) { input.value = ''; input.click(); } // 显式触发，避免依赖 <label for> 转发
    }
    function onUpload(e) {
      const input = e.target;
      const file = input.files && input.files[0];
      if (!file) return;
      const ext = (file.name || '').toLowerCase();
      if (!/\.(xlsx|xls)$/.test(ext)) {
        setImpMsg('仅支持 .xlsx / .xls 文件', 'err'); alert('文件格式不正确，请上传 .xlsx 或 .xls 文件'); input.value = ''; return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setImpMsg('文件超过 10MB 上限', 'err'); alert('文件过大（上限 10MB）'); input.value = ''; return;
      }
      const fd = new FormData();
      fd.append('file', file);
      const btn = $('xlsBtn'); if (btn) btn.disabled = true;
      setImpMsg('正在解析并导入「' + file.name + '」…', 'info');
      API.upload('/logistics-quotes/import', fd)
        .then((r) => {
          let msg = `导入完成：新增 ${r.created} 条，更新 ${r.updated} 条`;
          if (r.failed > 0) {
            const lines = (r.failures || []).slice(0, 10).map((f) => `第${f.row}行：${f.reason}`).join('；');
            msg += `；失败 ${r.failed} 行（${lines}${(r.failures || []).length > 10 ? ' 等' : ''}）`;
          }
          setImpMsg(msg, r.failed > 0 ? 'warn' : 'ok');
          load(); // 刷新列表
        })
        .catch((ex) => { setImpMsg('导入失败：' + ex.message, 'err'); alert('导入失败：' + ex.message); })
        .finally(() => { if (btn) btn.disabled = false; input.value = ''; });
    }

    return function mount(pageHost) { host = pageHost; load(); };
  }

  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES[PAGE] = createPage();
})();
