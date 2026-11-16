// 智能测算（单据 → 智能测算）：三个 Tab 合一
//   Tab1 批量测算（Excel）：模板下载 / 上传 / 管理员高级配置 / 结果表 / 复制 SO（复用原有逻辑）
//   Tab2 单笔测算：表单录入 → 调 /smart-quote/compare → 展示该区域全部可用快递比价，绿色高亮最低价
//   Tab3 历史测算：内嵌原「历史测算」页面（ERP_PAGES.smart_quote_history）
// 核心测算仍在后端完成（/calculate / /compare 读取 logistics_quotes 全量报价做比价），
// 本文件只负责 UI 容器、Tab 切换与渲染。
// 注意：本项目是原生 JS SPA（无 Vue/React），事件用 onclick/onchange 绑定，不使用 @click。
(function () {
  const PAGE = 'smart_quote';
  // 电子面单类型全集（与后端 WAYBILL_TYPES 保持一致）
  const WAYBILL_TYPES = ['菜鸟', '得物', '抖音', '京东快递', '京东无界', '快手', '拼多多', '微信视频号', '唯品会加密', '新版小红书', '有赞', '其他'];
  const DEFAULT_SELECTED = ['菜鸟', '拼多多', '抖音'];
  const TPL_FILENAME = '智能测单导入模板.xlsx';
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 与后端 multer 限制一致

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const num = (x, d = 3) => {
    const n = Number(x);
    if (isNaN(n)) return '—';
    return d === 0 ? n.toFixed(0) : n.toFixed(d);
  };
  // 管理员 / 超级管理员 可修改配置；其余角色只能看
  function isAdmin() {
    const u = window.ERP_USER || {};
    return u.role === '管理员' || u.role === '超级管理员' || u.role_code === 'admin' || u.role_code === 'super_admin';
  }
  // 剪贴板复制（优先 Clipboard API，降级 textarea+execCommand）
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  function createPage() {
    const state = {
      results: [],
      config: { startWeight: 0, startMode: 'estimated', waybillTypes: DEFAULT_SELECTED },
      configLoaded: false, page: 1, pages: 1, pageSize: 20,
      msg: { text: '', kind: 'info' }, // 工具条提示，跨 render 保留
      activeTab: 'batch',
    };
    let host = null;
    let panelBatch = null, panelSingle = null, panelHistory = null, historyHost = null, historyMounted = false;

    // host 作用域：Tab 按钮 id 唯一，无冲突
    const h$ = (id) => (host ? host.querySelector('#' + id) : null);
    // 面板作用域：batch / single / history 三个面板 ID 互不串（避免 prevBtn 等通用 id 串到历史测算）
    function q$(panel, id) { return panel ? panel.querySelector('#' + id) : null; }
    function qon(panel, id, evt, fn) { const el = q$(panel, id); if (el) { el[evt] = fn; return true; } return false; }
    const onB = (id, evt, fn) => qon(panelBatch, id, evt, fn);
    const b$ = (id) => q$(panelBatch, id);
    const onS = (id, evt, fn) => qon(panelSingle, id, evt, fn);
    const s$ = (id) => q$(panelSingle, id);
    // 兼容：旧 batch 内部函数直接引用 $ / on，统一指向 batch 面板（单笔测算走 s$ / onS）
    const $ = b$;
    function on(id, evt, fn) { return onB(id, evt, fn); }

    // 配置筛选：重量门槛（预估/计费）+ 面单类型白名单（仅导入行受面单限制，单笔始终展示）
    function passes(r) {
      const c = state.config;
      const w = (c.startMode === 'billing' ? r.billingWeight : r.estimatedWeight);
      if (Number(w) < Number(c.startWeight || 0)) return false;
      if (r.source === 'single') return true;            // 单笔为显式试算，不受面单白名单限制
      if (!r.waybillType) return false;                   // 导入行：必须填了面单类型
      return c.waybillTypes.indexOf(r.waybillType) >= 0;  // 且类型在勾选白名单内
    }
    function filtered() { return state.results.filter(passes); }

    // ---------- 顶部工具条（模板 / 导入） ----------
    function toolbarHtml() {
      return `
        <div class="toolbar">
          <button id="tplBtn" class="ghost" type="button">⬇ 下载 Excel 模板</button>
          <button id="xlsBtn" class="ghost" type="button">⬆ 上传 Excel 测算</button>
          <input id="xlsInput" type="file" accept=".xlsx,.xls" style="display:none">
          <span id="sqMsg" class="sq-msg ${esc(state.msg.kind)}">${esc(state.msg.text)}</span>
        </div>`;
    }

    // 统一状态提示（不触发 render，避免重绘时丢失按钮引用）
    function setMsg(text, kind) {
      state.msg = { text: text || '', kind: kind || 'info' };
      const el = b$('sqMsg');
      if (el) { el.textContent = state.msg.text; el.className = 'sq-msg ' + state.msg.kind; }
    }

    // ---------- 管理员高级配置栏（权限：管理员可见可改，业务员可见不可改） ----------
    function configBarHtml() {
      const admin = isAdmin();
      const c = state.config;
      const typeBoxes = WAYBILL_TYPES.map((t) => {
        const checked = c.waybillTypes.indexOf(t) >= 0 ? 'checked' : '';
        const dis = admin ? '' : 'disabled';
        return `<label class="wb-type"><input type="checkbox" class="wb-cb" value="${esc(t)}" ${checked} ${dis}> ${esc(t)}</label>`;
      }).join('');
      const modeEst = (c.startMode === 'estimated') ? 'selected' : '';
      const modeBill = (c.startMode === 'billing') ? 'selected' : '';
      const ctrl = admin
        ? `<button id="saveCfgBtn" class="primary" type="button">保存配置</button><span id="cfgMsg" class="ok"></span>`
        : `<span class="muted">（仅管理员可修改）</span>`;
      const dis = admin ? '' : 'disabled';
      return `
        <div class="cfg-bar">
          <div class="cfg-title">⚙ 测算配置${admin ? '' : '（只读）'}</div>
          <div class="cfg-row">
            <span class="cfg-label">测算起步重量：</span>
            <input id="cfgStartWeight" type="number" min="0" step="0.01" value="${esc(c.startWeight)}" ${dis} style="width:90px"> kg，
            <select id="cfgStartMode" ${dis}>
              <option value="estimated" ${modeEst}>按预估重量起步</option>
              <option value="billing" ${modeBill}>按计费重量起步</option>
            </select>
            <span class="muted">（达到该重量的数据才展示 / 参与测算）</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-label">电子面单类型：</span>
            <button id="wbAll" class="ghost mini" type="button" ${dis}>全选</button>
            <button id="wbClear" class="ghost mini" type="button" ${dis}>清空</button>
            <div class="wb-types">${typeBoxes}</div>
          </div>
          <div class="cfg-row cfg-actions">${ctrl}</div>
        </div>`;
    }

    // ---------- 分批复制栏（表格上方） ----------
    function soNumbers() { return filtered().map((r) => r.soNo).filter((s) => s); }
    function copyBarHtml() {
      const sos = soNumbers();
      const n = sos.length;
      if (n === 0) return `<div class="copy-bar muted">当前筛选结果中没有可复制的 SO 单号</div>`;
      let batchHtml = '';
      if (n > 1000) {
        const size = 1000, batches = Math.ceil(n / size);
        const arr = [];
        for (let i = 0; i < batches; i++) {
          const s = i * size, e = Math.min(n, s + size);
          arr.push(`<button class="ghost copyBatch" type="button" data-s="${s}" data-e="${e}">复制第${i + 1}批（${e - s}个）</button>`);
        }
        batchHtml = `<div class="batch-copy">${arr.join('')}</div>`;
      }
      return `<div class="copy-bar">
          <button id="copyAllBtn" class="ghost" type="button">📋 复制筛选后的 SO 单号（${n} 个）</button>
          ${batchHtml}
          <span id="copyMsg" class="ok"></span>
        </div>`;
    }

    // ---------- 结果行（批量表：每行只展示该笔的推荐结果） ----------
    function resultRowHtml(r) {
      return `<tr>
        <td>${esc(r.soNo || '')}</td>
        <td>${esc(r.ownerName || '')}</td>
        <td>${esc(r.waybillType || '')}</td>
        <td>${esc(r.province || '')}</td>
        <td>${esc(r.city || '')}</td>
        <td>${esc(r.district || '')}</td>
        <td class="num">${num(r.estimatedWeight, 3)}</td>
        <td class="num">${num(r.totalVolume, 4)}</td>
        <td class="num">${num(r.volumetricWeight, 3)}</td>
        <td class="num">${num(r.billingWeight, 0)}</td>
        <td title="${esc(r.matchLabel || '')}"><b>${esc(r.recommendedCode || '—')}</b>${r.matchLabel ? `<span class="muted"> ${esc(r.matchLabel)}</span>` : ''}</td>
        <td class="num price">${r.recommendedPrice == null ? '—' : '¥' + num(r.recommendedPrice, 3)}</td>
      </tr>`;
    }

    function tableHtml() {
      const fr = filtered();
      const start = (state.page - 1) * state.pageSize;
      const pageRows = fr.slice(start, start + state.pageSize);
      const filteredN = fr.length, totalN = state.results.length;
      const filterNote = (filteredN !== totalN)
        ? `<span class="muted">（按配置筛选：${filteredN}/${totalN} 条符合，其余未计入复制）</span>`
        : '';
      return `
        ${copyBarHtml()}
        <table class="grid smart-quote">
          <thead><tr>
            <th>SO单号</th><th>货主名称</th><th>电子面单类型</th><th>省份</th><th>城市</th><th>县区</th>
            <th>预估重量(kg)</th><th>总体积(m³)</th><th>抛比重量</th><th>计费重量</th><th>推荐快递编码</th><th>推荐总价</th>
          </tr></thead>
          <tbody>
            ${pageRows.length ? pageRows.map(resultRowHtml).join('') : `<tr><td colspan="12" class="empty">暂无测算结果，上传 Excel 后自动生成；单笔试算请切换到「单笔测算」Tab</td></tr>`}
          </tbody>
        </table>
        <div class="pager">
          <button id="prevBtn" type="button" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${state.page} / ${state.pages} 页（符合 ${filteredN} 条）${filterNote}</span>
          <button id="nextBtn" type="button" ${state.page >= state.pages ? 'disabled' : ''}>下一页</button>
        </div>`;
    }

    function renderBatch() {
      if (!panelBatch) return;
      panelBatch.innerHTML = configBarHtml() + toolbarHtml() + tableHtml();
      bindBatch();
    }

    function bindBatch() {
      // 配置栏（管理员）——全部走 onB()，单个元素缺失不中断后续绑定
      if (isAdmin()) {
        onB('saveCfgBtn', 'onclick', onSaveConfig);
        onB('wbAll', 'onclick', () => { panelBatch.querySelectorAll('.wb-cb').forEach((c) => { c.checked = true; }); });
        onB('wbClear', 'onclick', () => { panelBatch.querySelectorAll('.wb-cb').forEach((c) => { c.checked = false; }); });
      }
      // 模板下载 / 上传：显式绑定，任一缺失都不影响另一个
      onB('tplBtn', 'onclick', onDownloadTemplate);
      onB('xlsBtn', 'onclick', onPickFile);
      onB('xlsInput', 'onchange', onUpload);
      // 分页
      onB('prevBtn', 'onclick', () => { if (state.page > 1) { state.page--; renderBatch(); } });
      onB('nextBtn', 'onclick', () => { if (state.page < state.pages) { state.page++; renderBatch(); } });
      // 分批复制
      onB('copyAllBtn', 'onclick', () => doCopy(soNumbers().join('\n'), '已复制全部 ' + soNumbers().length + ' 个 SO 单号'));
      panelBatch.querySelectorAll('.copyBatch').forEach((b) => {
        b.onclick = () => {
          const s = Number(b.dataset.s), e = Number(b.dataset.e);
          doCopy(soNumbers().slice(s, e).join('\n'), '已复制第' + (Math.floor(s / 1000) + 1) + '批（' + (e - s) + '个）');
        };
      });
    }

    // ---------- 复制 ----------
    function doCopy(text, okMsg) {
      if (!text) return;
      copyText(text).then(() => {
        const m = b$('copyMsg'); if (m) m.textContent = okMsg + ' ✓';
      }).catch(() => alert('复制失败，请手动选择复制'));
    }

    // ---------- 配置保存（管理员） ----------
    function onSaveConfig() {
      const startWeight = Number(b$('cfgStartWeight') && b$('cfgStartWeight').value);
      if (isNaN(startWeight) || startWeight < 0) { alert('起步重量必须是 ≥0 的数字'); return; }
      const modeEl = b$('cfgStartMode');
      const startMode = modeEl && modeEl.value === 'billing' ? 'billing' : 'estimated';
      const waybillTypes = Array.from(panelBatch.querySelectorAll('.wb-cb:checked')).map((c) => c.value);
      if (!waybillTypes.length) { alert('至少勾选一种电子面单类型'); return; }
      const msg = b$('cfgMsg'); if (msg) msg.textContent = '保存中…';
      API.put('/smart-quote/config', { startWeight, startMode, waybillTypes })
        .then((r) => {
          state.config = (r && r.data) || state.config;
          if (msg) msg.textContent = '已保存 ✓';
          renderBatch();
        })
        .catch((e) => { if (msg) msg.textContent = '保存失败：' + e.message; });
    }

    // ---------- ① 下载 Excel 模板 ----------
    function onDownloadTemplate() {
      const btn = b$('tplBtn');
      setMsg('正在生成模板…', 'info');
      if (btn) btn.disabled = true;
      API.download('/smart-quote/template', TPL_FILENAME)
        .then(() => setMsg('模板已下载：' + TPL_FILENAME + ' ✓', 'ok'))
        .catch((e) => {
          const m = '模板下载失败：' + (e && e.message ? e.message : '未知错误');
          setMsg(m, 'err');
          alert(m);
        })
        .finally(() => { if (btn) btn.disabled = false; });
    }

    // ---------- ② 点击「上传 Excel 测算」→ 显式触发隐藏文件框 ----------
    function onPickFile() {
      const input = b$('xlsInput');
      if (!input) { alert('上传控件未就绪，请刷新页面后重试'); return; }
      input.value = '';   // 清空，保证连续选择同一个文件也会触发 onchange
      input.click();      // 关键：不再依赖 <label for> 的浏览器原生转发
    }

    // ---------- ② 选择文件后：校验 → 上传后端测算 → 刷新结果表 ----------
    function onUpload(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reset = () => { try { e.target.value = ''; } catch (err) { /* ignore */ } };

      // 文件格式校验（弹窗提示）
      if (!/\.(xlsx|xls)$/i.test(file.name)) {
        alert('文件格式不对：请选择 .xlsx 或 .xls 的 Excel 文件。\n当前选择：' + file.name);
        reset(); return;
      }
      if (file.size > MAX_FILE_SIZE) {
        alert('文件过大（超过 10MB），请拆分后再上传。');
        reset(); return;
      }

      const btn = b$('xlsBtn');
      if (btn) btn.disabled = true;
      setMsg('正在测算 ' + file.name + ' …', 'info');
      const fd = new FormData();
      fd.append('file', file);

      API.upload('/smart-quote/import', fd)
        .then((r) => {
          const list = (r && r.data) || [];
          if (!list.length) {
            const m = '未读取到有效数据行，请检查表头是否与模板一致、且至少有一行数据。';
            setMsg(m, 'err'); alert(m); return;
          }
          const tagged = list.map((x) => Object.assign({}, x, { source: 'import' }));
          state.results = tagged.concat(state.results);
          state.page = 1;
          // 明确告知「导入 N 行 / 按当前配置展示 M 行」，避免被配置白名单过滤后
          // 表格无变化、被误判成「上传没反应」。
          const shown = filtered().length;
          const hiddenN = state.results.length - shown;
          const tail = hiddenN > 0
            ? `；其中 ${hiddenN} 行未显示（起步重量 / 电子面单类型被当前配置过滤，可在上方调整）`
            : '';
          setMsg(`导入成功 ${list.length} 行，当前显示 ${shown} 行${tail}`, hiddenN > 0 ? 'info' : 'ok');
          renderBatch();
        })
        .catch((ex) => {
          const m = '导入失败：' + (ex && ex.message ? ex.message : '未知错误');
          setMsg(m, 'err'); alert(m);
        })
        .finally(() => {
          const b = b$('xlsBtn'); if (b) b.disabled = false;
          reset();
        });
    }

    // ============================================================
    //  Tab2 单笔测算（比价）
    // ============================================================
    function singleFormHtml() {
      return `
        <div class="sq-single">
          <div class="sq-single-form">
            <div class="sq-form-grid">
              <label>SO单号<input id="s_so" placeholder="选填，便于记录"></label>
              <label>货主名称<input id="s_owner" placeholder="选填"></label>
              <label>电子面单类型（仅记录）
                <select id="s_wb">
                  <option value="">不指定</option>
                  ${WAYBILL_TYPES.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
                </select>
              </label>
              <label>省份<input id="s_prov" placeholder="如 浙江省"></label>
              <label>城市<input id="s_city" placeholder="如 杭州市"></label>
              <label>县区<input id="s_dist" placeholder="如 西湖区（选填）"></label>
              <label>预估重量(kg)<input id="s_wt" type="number" min="0" step="0.01" placeholder="如 3.2"></label>
              <label>总体积(m³)<input id="s_vol" type="number" min="0" step="0.0001" placeholder="如 0.012"></label>
            </div>
            <div class="sq-form-actions">
              <button id="s_calc" class="primary" type="button">开始测算</button>
              <span id="s_msg" class="sq-msg"></span>
            </div>
          </div>
          <div id="sResult"></div>
        </div>`;
    }

    function bindSingle() {
      onS('s_calc', 'onclick', onSingleCalc);
    }

    function onSingleCalc() {
      const v = (id) => { const el = s$(id); return el ? String(el.value || '').trim() : ''; };
      const row = {
        soNo: v('s_so'), ownerName: v('s_owner'), waybillType: v('s_wb'),
        province: v('s_prov'), city: v('s_city'), district: v('s_dist'),
        estimatedWeight: v('s_wt'), totalVolume: v('s_vol'),
      };
      const wt = Number(row.estimatedWeight), vol = Number(row.totalVolume);
      if (isNaN(wt) || wt < 0) { alert('预估重量必须是数字'); return; }
      if (isNaN(vol) || vol < 0) { alert('总体积必须是数字'); return; }
      const btn = s$('s_calc'); if (btn) btn.disabled = true;
      const resultEl = s$('sResult');
      const msgEl = s$('s_msg');
      if (msgEl) { msgEl.textContent = '测算中…'; msgEl.className = 'sq-msg info'; }
      if (resultEl) resultEl.innerHTML = '';
      // 单笔比价：不按面单类型过滤，看该区域全部可用快递底价
      API.post('/smart-quote/compare', { row })
        .then((r) => { renderCompare((r && r.data) || [], r && r.best, r && r.bestPrice, row.waybillType); })
        .catch((e) => {
          if (msgEl) { msgEl.textContent = '测算失败：' + (e.message || e); msgEl.className = 'sq-msg err'; }
        })
        .finally(() => { if (btn) btn.disabled = false; });
    }

    function renderCompare(list, best, bestPrice, waybillType) {
      const el = s$('sResult');
      const msgEl = s$('s_msg');
      if (!el) return;
      if (!list.length) {
        if (msgEl) { msgEl.textContent = ''; msgEl.className = 'sq-msg'; }
        el.innerHTML = `<div class="sq-msg err">该区域未匹配到任何报价网点，请先在「基础资料 → 物流报价」维护对应省市区报价。</div>`;
        return;
      }
      if (msgEl) { msgEl.textContent = '比价完成 ✓'; msgEl.className = 'sq-msg ok'; }
      const bestName = (list.find((x) => x.express_code === best) || {}).network_name || '';
      const banner = `<div class="best-banner">推荐使用：<b>${esc(best || '—')}</b>${bestName ? `（${esc(bestName)}）` : ''}，最低报价：<b class="price">¥${num(bestPrice, 3)}</b></div>`;
      const rows = list.map((x, i) => {
        const isBest = x.express_code === best;
        return `<tr class="${isBest ? 'best' : ''}">
          <td>${i + 1}</td>
          <td><b>${esc(x.express_code)}</b>${x.network_name ? `<span class="muted"> ${esc(x.network_name)}</span>` : ''}</td>
          <td class="num">${num(x.volume_ratio, 0)}</td>
          <td class="num">${num(x.volumetricWeight, 3)}</td>
          <td class="num">${num(x.billingWeight, 0)}</td>
          <td class="num price">¥${num(x.price, 3)}</td>
          <td class="muted">${esc(x.matchLabel || '')}</td>
          <td class="rec">${isBest ? '✅ 推荐' : ''}</td>
        </tr>`;
      }).join('');
      const note = waybillType
        ? `<div class="muted sq-note">（本次试算面单类型：${esc(waybillType)}，仅作记录，不参与比价）</div>`
        : '';
      el.innerHTML = banner + note + `
        <table class="grid sq-compare">
          <thead><tr>
            <th>#</th><th>快递编码</th><th>抛比</th><th>抛比重量(kg)</th><th>计费重量(kg)</th><th>运费(元)</th><th>匹配级别</th><th>推荐</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    // ============================================================
    //  Tab3 历史测算（内嵌原「历史测算」页面）
    // ============================================================
    function mountHistory() {
      if (historyMounted || !historyHost) return;
      const fn = window.ERP_PAGES && window.ERP_PAGES.smart_quote_history;
      if (typeof fn === 'function') {
        try { fn(historyHost); } catch (e) { console.error('[smart_quote] 历史测算挂载失败：', e); }
      }
      historyMounted = true;
    }

    // ============================================================
    //  「已维护快递公司」标签（读 /smart-quote/carriers）
    // ============================================================
    function loadTags() {
      const el = h$('coTags');
      if (!el) return;
      API.get('/smart-quote/carriers')
        .then((r) => {
          const list = (r && r.data) || [];
          if (!list.length) {
            el.innerHTML = '<span class="co-label">已维护快递公司：</span><span class="muted">暂无（请到「基础资料 → 物流报价」维护）</span>';
            return;
          }
          el.innerHTML = '<span class="co-label">已维护快递公司：</span>' +
            list.map((c) => `<span class="co-tag" title="${esc(c.network_name || '')}">${esc(c.express_code)}</span>`).join('');
        })
        .catch(() => {
          el.innerHTML = '<span class="co-label">已维护快递公司：</span><span class="muted">加载失败</span>';
        });
    }

    // ============================================================
    //  Tab 切换
    // ============================================================
    function switchTab(key) {
      state.activeTab = key;
      host.querySelectorAll('.sq-tab').forEach((b) => { b.classList.toggle('active', b.dataset.tab === key); });
      if (panelBatch) panelBatch.style.display = key === 'batch' ? 'block' : 'none';
      if (panelSingle) panelSingle.style.display = key === 'single' ? 'block' : 'none';
      if (panelHistory) panelHistory.style.display = key === 'history' ? 'block' : 'none';
      if (key === 'batch') renderBatch();
      else if (key === 'history') mountHistory();
      // single 面板表单已构建一次，无需重绘（保留已输入内容）
    }

    function render() {
      const fr = filtered();
      state.pages = Math.ceil(fr.length / state.pageSize) || 1;
      if (state.page > state.pages) state.page = state.pages;
      host.innerHTML = `
        <div class="sq-head">
          <div class="sq-tabs">
            <button class="sq-tab active" data-tab="batch">批量测算（Excel）</button>
            <button class="sq-tab" data-tab="single">单笔测算</button>
            <button class="sq-tab" data-tab="history">历史测算</button>
          </div>
          <div class="co-tags" id="coTags"><span class="co-label">已维护快递公司：</span><span class="muted">加载中…</span></div>
        </div>
        <div id="panelBatch" class="sq-panel"></div>
        <div id="panelSingle" class="sq-panel" style="display:none"></div>
        <div id="panelHistory" class="sq-panel" style="display:none"><div id="sqHistoryHost"></div></div>`;
      panelBatch = host.querySelector('#panelBatch');
      panelSingle = host.querySelector('#panelSingle');
      panelHistory = host.querySelector('#panelHistory');
      historyHost = host.querySelector('#sqHistoryHost');
      // Tab 按钮绑定（host 作用域，按钮 id 唯一）
      host.querySelectorAll('.sq-tab').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
      // 三个面板内容
      renderBatch();
      panelSingle.innerHTML = singleFormHtml();
      bindSingle();
      loadTags();
    }

    return function mount(pageHost) {
      host = pageHost;
      // 拉取配置（起步重量 + 面单白名单）；业务员也能读（只读）
      API.get('/smart-quote/config')
        .then((r) => { if (r && r.data) state.config = r.data; })
        .catch(() => {})
        .finally(() => { state.configLoaded = true; render(); });
    };
  }

  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES[PAGE] = createPage();
})();
