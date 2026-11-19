// ============================================================================
// 订单导入 + 地区看板 v2 — 支持方案管理 + 省占比三区 + 订单查询
// ----------------------------------------------------------------------------
// - order_import      path=order_import      默认落在「导入」Tab
// - order_dashboard   path=order_dashboard   默认落在「看板」Tab
// ============================================================================
(function () {
  const API = window.API;
  const BTN_PRIMARY = 'background:#409eff;color:#fff;border:none;border-radius:4px;padding:8px 20px;font-size:14px;cursor:pointer;';
  const BTN_PRIMARY_DISABLED = BTN_PRIMARY + ';opacity:.5;cursor:not-allowed;';
  const BTN_GHOST = 'background:#fff;color:#409eff;border:1px solid #409eff;border-radius:4px;padding:7px 16px;font-size:14px;cursor:pointer;';
  const CARD_CSS = 'background:#fff;border-radius:8px;padding:18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06);';

  // ---------- 页面工厂 ----------
  function createPage(host, pageId) {
    host.innerHTML = '';
    host.style.cssText = 'padding:16px;background:#f5f7fa;min-height:100%;box-sizing:border-box;';
    const defaultTab = pageId === 'order_dashboard' ? 'dashboard' : 'import';

    const wrap = document.createElement('div');
    wrap.style.maxWidth = '1280px'; wrap.style.margin = '0 auto';
    wrap.innerHTML = `
      <div class="od-tabs" style="display:flex;gap:4px;margin-bottom:16px;">
        <button class="od-tab" data-tab="import"  style="padding:10px 24px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:14px;">📤 批量导入</button>
        <button class="od-tab" data-tab="dashboard" style="padding:10px 24px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:14px;">📊 地区看板</button>
      </div>
      <div class="od-panels">
        <div class="od-panel" data-panel="import"    style="display:none;"></div>
        <div class="od-panel" data-panel="dashboard" style="display:none;"></div>
      </div>
    `;
    host.appendChild(wrap);

    const tabs = wrap.querySelectorAll('.od-tab');
    const panels = wrap.querySelectorAll('.od-panel');
    let p_import_mounted = false, p_dash_mounted = false;
    let currentPlanId = null;

    function switchTab(tabName) {
      tabs.forEach((t) => {
        t.style.background = t.dataset.tab === tabName ? '#409eff' : '#e4e7ed';
        t.style.color = t.dataset.tab === tabName ? '#fff' : '#606266';
        t.style.fontWeight = t.dataset.tab === tabName ? '600' : '400';
      });
      panels.forEach((p) => { p.style.display = p.dataset.panel === tabName ? 'block' : 'none'; });

      if (tabName === 'import' && !p_import_mounted) { mountImport(wrap.querySelector('[data-panel="import"]')); p_import_mounted = true; }
      if (tabName === 'dashboard' && !p_dash_mounted) { mountDashboard(wrap.querySelector('[data-panel="dashboard"]')); p_dash_mounted = true; }
      if (tabName === 'dashboard') refreshDashboard();
    }
    tabs.forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
    switchTab(defaultTab);

    // 暴露切换接口给配置面板的新建方案回调
    wrap._refreshDashboard = () => refreshDashboard();
    wrap._getPlanId = () => currentPlanId;
    wrap._setPlanId = (v) => { currentPlanId = v; };
  }

  // =========================================================================
  // Tab 1: 批量导入（保留 Ctrl+V + 导入记录）
  // =========================================================================
  let _platforms = null;
  let _pasteCleanup = null;   // 单例：页面重复打开时先解绑旧监听，避免监听器叠加

  // 文件列表 / 删除按钮样式（用 CSS 类实现 hover / active / focus / disabled，
  // 避免内联 style 覆盖伪类状态，也便于键盘操作时给出焦点反馈）
  function injectOdStyles() {
    if (document.getElementById('odStyles')) return;
    const style = document.createElement('style');
    style.id = 'odStyles';
    style.textContent = `
      .od-file-row{display:flex;align-items:center;gap:12px;padding:10px 12px;
        background:#f4f8ff;border:1px solid #e2edff;border-left:3px solid #409eff;border-radius:8px;
        transition:background .18s ease,border-color .18s ease,box-shadow .18s ease;}
      .od-file-row:hover{background:#eaf3ff;border-color:#c6dcff;box-shadow:0 2px 8px rgba(64,158,255,.08);}
      .od-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-size:13px;color:#303133;font-weight:600;}
      .od-file-size{flex-shrink:0;font-size:12px;color:#909399;font-variant-numeric:tabular-nums;}
      .od-file-del{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;
        width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:50%;
        background:linear-gradient(180deg,#f76a6a 0%,#f05656 100%);color:#fff;cursor:pointer;
        box-shadow:0 1px 3px rgba(240,86,86,.28);user-select:none;-webkit-tap-highlight-color:transparent;
        transition:transform .16s cubic-bezier(.4,0,.2,1),box-shadow .16s ease,
                   background .16s ease,opacity .16s ease;}
      .od-file-del:hover{background:linear-gradient(180deg,#ff5f5f 0%,#e84040 100%);
        box-shadow:0 4px 12px rgba(232,64,64,.4);transform:scale(1.1);}
      .od-file-del:active{background:#d93a3a;box-shadow:inset 0 1px 3px rgba(0,0,0,.25);transform:scale(.92);}
      .od-file-del:focus{outline:none;}
      .od-file-del:focus-visible{box-shadow:0 0 0 3px rgba(245,108,108,.35),0 2px 6px rgba(240,86,86,.3);}
      .od-file-del:disabled{background:#f0f2f5;color:#c0c4cc;border-color:#e4e7ed;
        box-shadow:none;cursor:not-allowed;transform:none;}
      @media (prefers-reduced-motion:reduce){
        .od-file-row,.od-file-del{transition:none;}
        .od-file-del:hover,.od-file-del:active{transform:none;}
      }
    `;
    document.head.appendChild(style);
  }

  function mountImport(panel) {
    injectOdStyles();
    panel.innerHTML = '';
    const card = document.createElement('div');
    card.style.cssText = CARD_CSS;
    card.innerHTML = `
      <h3 style="margin:0 0 16px;font-size:16px;color:#303133;">📤 批量导入订单</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
        <div>
          <label style="display:block;font-size:13px;color:#606266;margin-bottom:6px;">① 下载导入模板</label>
          <a href="/api/orders/template" style="display:inline-block;padding:8px 20px;background:#67c23a;color:#fff;border-radius:4px;text-decoration:none;font-size:14px;">⬇ 下载 xlsx 模板</a>
          <span style="color:#909399;font-size:12px;margin-left:8px;">（7 列标准字段，含示例行）</span>
        </div>
        <div>
          <label style="display:block;font-size:13px;color:#606266;margin-bottom:6px;">② 选择来源平台（WMS/打单系统）</label>
          <select id="odPlatform" style="width:100%;padding:8px 12px;border:1px solid #dcdfe6;border-radius:4px;font-size:14px;">
            <option value="">—— 正在加载平台列表 ——</option>
          </select>
        </div>
      </div>
      <div id="odDropZone" style="border:2px dashed #c0ccda;border-radius:8px;padding:40px;text-align:center;cursor:pointer;background:#fafafa;margin-bottom:16px;">
        <div style="font-size:48px;color:#909399;margin-bottom:8px;">📁</div>
        <div style="color:#606266;font-size:15px;margin-bottom:4px;">点击或拖拽 Excel / CSV 文件到此处</div>
        <div style="color:#909399;font-size:12px;">支持 .xlsx / .xls / .csv · 无行数/文件大小硬性限制</div>
        <div style="color:#409eff;font-size:12px;margin-top:6px;">💡 也可以按 <kbd style="padding:1px 6px;background:#fff;border:1px solid #dcdfe6;border-radius:3px;">Ctrl+V</kbd> 粘贴 Excel 表格或文件</div>
        <input type="file" id="odFile" accept=".xlsx,.xls,.csv" style="display:none;" />
      </div>
      <div id="odPreview" style="display:none;margin-bottom:16px;"></div>
      <div id="odProgress" style="display:none;margin-bottom:16px;"></div>
      <div id="odResult" style="display:none;"></div>
      <div style="display:flex;gap:12px;">
        <button id="odSubmit" style="${BTN_PRIMARY_DISABLED}" disabled>🚀 开始导入</button>
        <button id="odReset" style="${BTN_GHOST}">🔄 重新选择</button>
      </div>
    `;
    panel.appendChild(card);

    // --- 导入记录列表（固定 20 条） ---
    const historyCard = document.createElement('div');
    historyCard.style.cssText = CARD_CSS;
    historyCard.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;font-size:16px;color:#303133;">📋 导入记录</h3>
        <div style="display:flex;gap:8px;">
          <span style="color:#909399;font-size:12px;">固定保留最近 20 条</span>
          <button id="odHistoryRefresh" style="${BTN_GHOST};padding:4px 12px;font-size:12px;">🔄 刷新</button>
        </div>
      </div>
      <div id="odHistoryList" style="min-height:60px;"></div>
    `;
    panel.appendChild(historyCard);

    // --- 平台列表 ---
    API.get('/orders/platforms').then((r) => {
      _platforms = r?.platforms || ['百世WMS'];
      const sel = card.querySelector('#odPlatform'); sel.innerHTML = '';
      _platforms.forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); });
      sel.onchange = () => updateSubmitEnabled();
    }).catch(() => { card.querySelector('#odPlatform').innerHTML = '<option value="百世WMS">百世WMS</option>'; });

    const historyWrap = historyCard.querySelector('#odHistoryList');
    historyCard.querySelector('#odHistoryRefresh').onclick = () => refreshImportHistory(historyWrap);
    refreshImportHistory(historyWrap);

    // --- 上传 ---
    const dropZone = card.querySelector('#odDropZone');
    const fileInput = card.querySelector('#odFile');
    const previewBox = card.querySelector('#odPreview');
    let _selectedFiles = [];   // 多文件列表
    let _busy = false;         // 导入中：禁用删除/提交，避免中途改列表
    dropZone.onclick = () => fileInput.click();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = '#409eff'; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = '#c0ccda'; };
    dropZone.ondrop = (e) => {
      e.preventDefault(); dropZone.style.borderColor = '#c0ccda';
      if (e.dataTransfer.files.length) {
        // 支持一次拖入多个文件
        Array.from(e.dataTransfer.files).forEach((f) => onFile(f));
      }
    };
    fileInput.onchange = () => {
      if (fileInput.files.length) {
        Array.from(fileInput.files).forEach((f) => onFile(f));
      }
      fileInput.value = ''; // 清空以便再次选择同名文件
    };

    // Ctrl+V / Cmd+V 粘贴导入
    // ⚠️ 关键：Chrome / Edge / Safari 的 paste 事件里 ctrlKey / metaKey 恒为 false
    //    （只有 Firefox 会带修饰键），所以不能靠 e.ctrlKey 判断，否则这些浏览器里
    //    按 Ctrl+V 会被直接 return 掉 → 表现为「粘贴完全没反应」。
    //    能收到 paste 事件本身就代表用户执行了粘贴（快捷键或右键菜单）。
    function onPaste(e) {
      // 只在当前页面可见时响应（切到其它 Tab / 页面不响应）
      if (!panel.isConnected || !panel.getClientRects().length) return;
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT' || target.isContentEditable)) return;

      const cd = e.clipboardData;
      if (!cd) return;

      // ① 优先识别「复制的文件」
      let file = null;
      if (cd.files && cd.files.length) file = cd.files[0];
      if (!file && cd.items) {
        for (let i = 0; i < cd.items.length; i++) {
          if (cd.items[i].kind === 'file') { file = cd.items[i].getAsFile(); break; }
        }
      }
      if (file) { e.preventDefault(); onFile(file); return; }

      // ② 其次识别「Excel 表格 / TSV 文本」
      try {
        let html = cd.getData('text/html');
        let text = cd.getData('text/plain');
        let csv = null, label = '';
        if (html && /<table/i.test(html)) { csv = htmlTableToCSV(html); label = '粘贴的 Excel 表格'; }
        else if (text && looksLikeTSV(text)) { csv = tsvToCSV(text); label = '粘贴的表格数据'; }
        if (csv) {
          e.preventDefault();
          const ts = new Date(); const pad = (n) => String(n).padStart(2, '0');
          const fname = `粘贴导入_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.csv`;
          const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
          onFile(new File([blob], fname, { type: 'text/csv' }));
          flashDropZone(dropZone, '已粘贴 ' + label + '，自动转为 CSV 导入');
        }
      } catch (_) {}
    }
    // 先解绑上一次 mountImport 挂的监听，避免页面重复打开后监听器叠加
    if (_pasteCleanup) _pasteCleanup();
    document.addEventListener('paste', onPaste);
    _pasteCleanup = () => document.removeEventListener('paste', onPaste);

    function flashDropZone(zone, msg, color) {
      zone.style.borderColor = color || '#67c23a';
      const tip = document.createElement('div');
      tip.style.cssText = 'margin-top:8px;font-size:13px;color:'+(color||'#67c23a')+';';
      tip.textContent = msg; zone.appendChild(tip);
      setTimeout(() => { zone.style.borderColor = '#c0ccda'; if (tip.parentNode) tip.remove(); }, 2500);
    }

    function onFile(file) {
      // 校验文件类型
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
        flashDropZone(dropZone, `❌ 已跳过不支持的文件格式：${file.name}（仅支持 .xlsx / .xls / .csv）`, '#f56c6c');
        return;
      }
      _selectedFiles.push(file);
      renderFileList();
    }

    // 渲染已上传文件列表（每项右侧带红色圆形删除按钮）
    function renderFileList() {
      if (!_selectedFiles.length) {
        previewBox.style.display = 'none';
        previewBox.innerHTML = '';
        updateSubmitEnabled();
        return;
      }
      previewBox.style.display = 'block';
      previewBox.innerHTML = `
        <div style="margin-bottom:6px;font-size:13px;color:#606266;">
          📄 已上传 <b style="color:#409eff;">${_selectedFiles.length}</b> 个文件：
        </div>
        <div id="odFileList" style="display:flex;flex-direction:column;gap:6px;"></div>
      `;
      const list = previewBox.querySelector('#odFileList');
      _selectedFiles.forEach((f, idx) => {
        const kb = (f.size / 1024).toFixed(1);
        const row = document.createElement('div');
        row.className = 'od-file-row';
        row.dataset.idx = idx;
        row.innerHTML = `
          <span style="font-size:16px;flex-shrink:0;">📄</span>
          <span class="od-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          <span class="od-file-size">${kb} KB</span>
          <button type="button" class="od-file-del" data-idx="${idx}" ${_busy ? 'disabled' : ''}
            title="移除此文件" aria-label="移除文件 ${escapeHtml(f.name)}">
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
              <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        `;
        // hover / active / focus / disabled 全部由 .od-file-del 的 CSS 控制，
        // 这里只保留点击行为
        row.querySelector('.od-file-del').onclick = (e) => {
          e.stopPropagation();
          removeFile(idx);
        };
        list.appendChild(row);
      });
      updateSubmitEnabled();
    }

    // 移除指定文件项（同时清空关联的临时数据）
    function removeFile(idx) {
      if (_busy) return;
      if (idx < 0 || idx >= _selectedFiles.length) return;
      const removed = _selectedFiles.splice(idx, 1)[0];
      // 如果文件有临时解析缓存，这里清理（当前暂无额外缓存，预留接口）
      // 释放可能的 ObjectURL
      if (removed && removed._tempUrl) { URL.revokeObjectURL(removed._tempUrl); }
      renderFileList();
    }

    const submitBtn = card.querySelector('#odSubmit');
    const resetBtn = card.querySelector('#odReset');
    function updateSubmitEnabled() {
      const platform = card.querySelector('#odPlatform').value;
      if (_selectedFiles.length > 0 && platform) { submitBtn.style.cssText = BTN_PRIMARY; submitBtn.disabled = false; }
      else { submitBtn.style.cssText = BTN_PRIMARY_DISABLED; submitBtn.disabled = true; }
    }

    submitBtn.onclick = async () => {
      const platform = card.querySelector('#odPlatform').value;
      if (!_selectedFiles.length || !platform) return;
      const prog = card.querySelector('#odProgress'); prog.style.display = 'block';
      const result = card.querySelector('#odResult'); result.style.display = 'none';
      submitBtn.disabled = true; submitBtn.style.cssText = BTN_PRIMARY_DISABLED;
      _busy = true; renderFileList();   // 导入期间删除按钮进入 disabled 态

      // 逐个提交，汇总结果
      const total = _selectedFiles.length;
      let doneCount = 0;
      let allSuccess = 0, allFailed = 0;
      const allFailures = [];
      const perFileResults = [];

      prog.innerHTML = `<div style="padding:14px;background:#fdf6ec;border-radius:4px;border-left:3px solid #e6a23c;color:#e6a23c;font-size:14px;">⏳ 开始导入，共 <b>${total}</b> 个文件（平台: ${platform}）</div>`;

      // 用 for...of 顺序提交，便于显示进度
      for (let i = 0; i < _selectedFiles.length; i++) {
        const f = _selectedFiles[i];
        prog.innerHTML = `<div style="padding:14px;background:#fdf6ec;border-radius:4px;border-left:3px solid #e6a23c;color:#e6a23c;font-size:14px;">⏳ 正在导入（${i + 1}/${total}）<b>${f.name}</b>（平台: ${platform}）</div>`;
        try {
          const fd = new FormData(); fd.append('file', f); fd.append('platform', platform);
          const data = await API.upload('/orders/import', fd);
          allSuccess += (data.success || 0);
          allFailed += (data.failed || 0);
          (data.failures || []).forEach((ff) => allFailures.push({ ...ff, _file: f.name }));
          perFileResults.push({ file: f.name, ok: true, success: data.success || 0, failed: data.failed || 0 });
        } catch (e) {
          allFailures.push({ row: '-', reason: e.message, data: '', _file: f.name });
          perFileResults.push({ file: f.name, ok: false, error: e.message });
        }
        doneCount++;
      }

      // 清空已上传列表并刷新
      _busy = false;
      _selectedFiles = [];
      renderFileList();

      prog.style.display = 'none';
      result.style.display = 'block';
      const hasErr = perFileResults.some((r) => !r.ok);
      result.innerHTML = `
        <div style="padding:14px;border-radius:4px;border-left:3px solid ${hasErr || allFailed ? '#e6a23c' : '#67c23a'};background:${hasErr || allFailed ? '#fdf6ec' : '#f0f9eb'};">
          <b style="color:${hasErr || allFailed ? '#e6a23c' : '#67c23a'};font-size:15px;">导入完成</b>
          <div style="margin-top:8px;font-size:14px;color:#606266;">✅ 成功 <b style="color:#67c23a;">${allSuccess}</b> 行${allFailed ? ` · ❌ 校验失败 <b style="color:#f56c6c;">${allFailed}</b> 行` : ''}${hasErr ? ` · ⚠️ 请求失败 <b style="color:#f56c6c;">${perFileResults.filter(r=>!r.ok).length}</b> 个文件` : ''}</div>
          <details style="margin-top:10px;"><summary style="cursor:pointer;color:#409eff;font-size:13px;">查看各文件导入结果</summary>
            <div style="margin-top:8px;max-height:200px;overflow:auto;font-size:13px;">
              ${perFileResults.map((r) => r.ok
                ? `<div>📄 ${escapeHtml(r.file)} — ✅ ${r.success} 行${r.failed ? ` / ❌ ${r.failed} 行` : ''}</div>`
                : `<div>📄 ${escapeHtml(r.file)} — ❌ ${escapeHtml(r.error)}</div>`
              ).join('')}
            </div>
          </details>
          ${allFailures.length ? `<details style="margin-top:10px;"><summary style="cursor:pointer;color:#409eff;font-size:13px;">查看失败清单（共 ${allFailures.length} 条）</summary><div style="margin-top:8px;max-height:240px;overflow:auto;font-size:13px;">${allFailures.slice(0,50).map(f=>`<div>📄${escapeHtml(f._file)} · 第${f.row}行: ${escapeHtml(f.reason||f.error||'')}</div>`).join('')}</div></details>` : ''}
        </div>`;
      refreshImportHistory(historyWrap);
    };

    resetBtn.onclick = () => {
      // 释放所有可能的临时 ObjectURL
      _busy = false;
      _selectedFiles.forEach((f) => { if (f && f._tempUrl) URL.revokeObjectURL(f._tempUrl); });
      _selectedFiles = [];
      fileInput.value = '';
      renderFileList();
      panel.querySelector('#odProgress').style.display = 'none';
      panel.querySelector('#odResult').style.display = 'none';
      updateSubmitEnabled();
    };
  }

  // ---------- 粘贴解析工具 ----------
  function htmlTableToCSV(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = []; doc.querySelectorAll('tr').forEach((tr) => {
      const cells = []; tr.querySelectorAll('td,th').forEach((c) => {
        let t = (c.textContent || '').replace(/\s+/g, ' ').trim();
        if (/[,"\n]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
        cells.push(t);
      });
      if (cells.length) rows.push(cells.join(','));
    });
    return rows.join('\n');
  }
  function looksLikeTSV(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return false;
    const first = lines[0];
    return (first.match(/\t/g) || []).length >= 1 || (first.match(/,/g) || []).length >= 1;
  }
  function tsvToCSV(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.map((l) => {
      if (l.includes('\t')) {
        return l.split('\t').map((c) => c.replace(/\s+/g,' ').trim()).join(',');
      }
      return l.split(',').map((c) => c.replace(/\s+/g,' ').trim()).join(',');
    }).join('\n');
  }

  // ---------- 导入记录 ----------
  function refreshImportHistory(container) {
    container.innerHTML = '<div style="color:#909399;padding:20px;text-align:center;">⏳ 加载中...</div>';
    API.get('/orders/import-history').then((data) => {
      renderImportHistory(container, data);
    }).catch((e) => {
      container.innerHTML = `<div style="color:#f56c6c;padding:20px;text-align:center;">❌ 加载失败: ${e.message}</div>`;
    });
  }
  function renderImportHistory(container, data) {
    const { list = [], limit = 20 } = data;
    if (!list.length) {
      container.innerHTML = `<div style="color:#909399;padding:20px;text-align:center;border:1px dashed #dcdfe6;border-radius:6px;">📭 暂无导入记录。</div>`; return;
    }
    const rows = list.map((h) => {
      const total = (h.success || 0) + (h.failed || 0);
      const rate = total ? (((h.success || 0) * 100) / total).toFixed(1) + '%' : '-';
      return `<tr style="border-bottom:1px solid #ebeef5;">
        <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;color:#909399;text-align:center;">#${h.log_id}</td>
        <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(h.filename || '')}">${escapeHtml(h.filename || '(未知)')}</td>
        <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;text-align:center;">${escapeHtml(h.platform || '-')}</td>
        <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;text-align:center;">${escapeHtml(h.operator || '-')}</td>
        <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;text-align:center;"><span style="color:#67c23a;">+${h.success||0}</span>${h.failed?` <span style="color:#f56c6c;">-${h.failed}</span>`:''}</td>
        <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;text-align:center;">${rate}</td>
        <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;">${escapeHtml((h.operated_at||'').replace('T',' ').slice(0,19))}</td>
      </tr>`;
    }).join('');
    container.innerHTML = `
      <div style="max-height:360px;overflow:auto;border:1px solid #ebeef5;border-radius:6px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:#f5f7fa;"><tr>
            <th style="padding:6px 8px;border:1px solid #ebeef5;width:50px;">#</th>
            <th style="padding:6px 8px;border:1px solid #ebeef5;">原始文件名</th>
            <th style="padding:6px 8px;border:1px solid #ebeef5;width:120px;">目标平台</th>
            <th style="padding:6px 8px;border:1px solid #ebeef5;width:80px;">操作人</th>
            <th style="padding:6px 8px;border:1px solid #ebeef5;width:100px;">成功/失败</th>
            <th style="padding:6px 8px;border:1px solid #ebeef5;width:80px;">成功率</th>
            <th style="padding:6px 8px;border:1px solid #ebeef5;width:160px;">导入时间</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:8px;font-size:12px;color:#909399;text-align:right;">共 ${list.length} 条（固定保留最近 ${limit} 条，超出自动覆盖）</div>
    `;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // =========================================================================
  // Tab 2: 地区看板 v2
  // =========================================================================
  let _dashCache = null;
  let _plansCache = [];
  let _currentPlanId = null;

  function mountDashboard(panel) {
    panel.innerHTML = '';
    const today = new Date();
    const ym = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const thisMonth = ym(today);

    const card = document.createElement('div');
    card.style.cssText = CARD_CSS;
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;font-size:16px;color:#303133;">📊 申通地区分类看板</h3>
        <button id="dashConfigBtn" style="${BTN_PRIMARY};padding:6px 16px;font-size:13px;">⚙️ 偏远地区配置</button>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;align-items:center;">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">
          月份 <input id="dashMonth" type="month" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;" value="${thisMonth}">
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">
          平台 <select id="dashPlatform" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;"><option value="全部">全部</option></select>
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">
          方案 <select id="dashPlan" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;min-width:200px;"></select>
        </label>
        <button id="dashQuery" style="${BTN_PRIMARY}">🔍 查询</button>
        <button id="dashReset" style="${BTN_GHOST}">🔄 重置</button>
        <button id="dashExport" style="${BTN_GHOST}">⬇ 导出</button>
      </div>

      <div id="dashCards"></div>
      <div id="dashProvinceBlocks" style="margin-top:24px;"></div>
    `;
    panel.appendChild(card);

    // 订单查询面板（独立模块迁入）
    const orderQueryCard = document.createElement('div');
    orderQueryCard.style.cssText = CARD_CSS;
    orderQueryCard.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;font-size:16px;color:#303133;">🔎 订单查询</h3>
        <span style="color:#909399;font-size:12px;">按当前筛选条件查询</span>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <input id="oqOrderNo" placeholder="订单号" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;width:160px;font-size:13px;">
        <input id="oqCustomer" placeholder="货主/客户名" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;width:180px;font-size:13px;">
        <button id="oqQuery" style="${BTN_PRIMARY};padding:6px 16px;font-size:13px;">查询明细</button>
        <button id="oqClear" style="${BTN_GHOST};padding:5px 14px;font-size:13px;">清空</button>
      </div>
      <div id="oqList"></div>
    `;
    panel.appendChild(orderQueryCard);

    // --- 平台下拉 ---
    API.get('/orders/platforms').then((r) => {
      const sel = card.querySelector('#dashPlatform');
      (r?.platforms || []).forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); });
    }).catch(() => {});

    // --- 方案下拉 ---
    loadPlansIntoSelect(card.querySelector('#dashPlan'), () => refreshDashboard());

    card.querySelector('#dashQuery').onclick = refreshDashboard;
    card.querySelector('#dashReset').onclick = () => {
      card.querySelector('#dashMonth').value = thisMonth;
      card.querySelector('#dashPlatform').value = '全部';
      refreshDashboard();
    };
    card.querySelector('#dashConfigBtn').onclick = () => openPlanConfigModal({
      onSaved: () => {
        loadPlansIntoSelect(card.querySelector('#dashPlan'), () => refreshDashboard());
        refreshDashboard();
      }
    });
    card.querySelector('#dashExport').onclick = () => exportDashboard();

    // 方案切换立即触发查询
    card.querySelector('#dashPlan').onchange = refreshDashboard;

    // 订单查询
    const oqNo = orderQueryCard.querySelector('#oqOrderNo');
    const oqCust = orderQueryCard.querySelector('#oqCustomer');
    orderQueryCard.querySelector('#oqQuery').onclick = () => refreshDashboard();
    orderQueryCard.querySelector('#oqClear').onclick = () => { oqNo.value = ''; oqCust.value = ''; refreshDashboard(); };

    refreshDashboard();
  }

  function loadPlansIntoSelect(selectEl, onChangeCb) {
    API.get('/orders/region-plans').then((data) => {
      _plansCache = data.plans || [];
      selectEl.innerHTML = '';
      _plansCache.forEach((p) => {
        const o = document.createElement('option'); o.value = p.id;
        o.textContent = (p.is_default ? '★ ' : '') + p.name + (p.override_count ? `（${p.override_count}条覆盖）` : '');
        selectEl.appendChild(o);
      });
      // 默认选中默认方案
      const def = _plansCache.find((p) => p.is_default);
      if (def) selectEl.value = def.id;
      _currentPlanId = selectEl.value;
      if (onChangeCb) onChangeCb();
    }).catch(() => {});
  }

  function refreshDashboard() {
    const panel = document.querySelector('.od-panel[data-panel="dashboard"]');
    if (!panel) return;
    const card = panel.children[0];
    const qs = (sel) => card.querySelector(sel);

    const month = qs('#dashMonth')?.value || ''; // YYYY-MM
    const platform = qs('#dashPlatform')?.value || '全部';
    const planId = qs('#dashPlan')?.value || '';
    _currentPlanId = planId;

    let start = '', end = '';
    if (month) {
      start = month + '-01';
      const [y, m] = month.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      end = month + '-' + String(lastDay).padStart(2, '0');
    }

    const params = new URLSearchParams();
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    if (platform && platform !== '全部') params.set('platform', platform);
    if (planId) params.set('plan', planId);

    qs('#dashCards').innerHTML = '<div style="color:#909399;padding:20px;text-align:center;">⏳ 加载中...</div>';
    qs('#dashProvinceBlocks').innerHTML = '';

    API.get('/orders/dashboard?' + params.toString()).then((data) => {
      _dashCache = data;
      renderDashboard(data);
      renderOrderQueryResults(data);
    }).catch((e) => {
      qs('#dashCards').innerHTML = `<div style="color:#f56c6c;padding:20px;text-align:center;">❌ 加载失败: ${e.message}</div>`;
    });
  }

  function renderDashboard(data) {
    const panel = document.querySelector('.od-panel[data-panel="dashboard"]');
    const card = panel.children[0];
    const cardsWrap = card.querySelector('#dashCards');
    const provinceWrap = card.querySelector('#dashProvinceBlocks');

    const { by_class, total, remote_total, by_class_province } = data;
    const pct = (n) => total ? ((n * 100) / total).toFixed(1) + '%' : '0%';
    const CLASS_COLOR = {
      '大偏远': { bg: '#fef0f0', text: '#f56c6c', border: '#f56c6c', bar: '#f56c6c', label: '🔴 大偏远' },
      '小偏远': { bg: '#fdf6ec', text: '#e6a23c', border: '#e6a23c', bar: '#e6a23c', label: '🟠 小偏远' },
      '正常':   { bg: '#f0f9eb', text: '#67c23a', border: '#67c23a', bar: '#409eff', label: '🔵 正常' },
    };

    // --- 顶部 KPI 卡片 ---
    const classCards = ['大偏远', '小偏远', '正常'].map((c) => {
      const color = CLASS_COLOR[c];
      return `<div style="flex:1;min-width:180px;padding:16px;border-radius:8px;background:${color.bg};border-left:4px solid ${color.border};">
        <div style="color:${color.text};font-size:13px;font-weight:600;margin-bottom:6px;">${color.label}</div>
        <div style="font-size:22px;font-weight:700;color:#303133;">${(by_class[c]||0).toLocaleString()}</div>
        <div style="font-size:12px;color:#909399;margin-top:4px;">占比 ${pct(by_class[c]||0)}</div>
      </div>`;
    }).join('');

    cardsWrap.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;">${classCards}</div>
      <div style="margin-top:12px;padding:12px 16px;background:#ecf5ff;border-radius:6px;border-left:4px solid #409eff;">
        📦 <b>偏远地区合计</b>（大偏远 + 小偏远）：${(remote_total||0).toLocaleString()} 单 · 占比 <b style="color:#e6a23c;">${pct(remote_total||0)}</b> · 总订单：<b>${(total||0).toLocaleString()}</b> 单
      </div>`;

    // --- 3 个省占比区块（参考图2）---
    provinceWrap.innerHTML = '';
    ['大偏远', '小偏远', '正常'].forEach((clsName) => {
      const color = CLASS_COLOR[clsName];
      const list = (by_class_province && by_class_province[clsName]) || [];
      const clsTotal = list.reduce((s, x) => s + x.count, 0);
      const items = list.map((p, idx) => {
        const barWidth = total ? ((p.count / total) * 100).toFixed(2) : 0;
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px;">
            <div style="width:32px;color:#909399;text-align:center;">${idx+1}</div>
            <div style="flex:0 0 160px;color:#606266;">${escapeHtml(p.province)}</div>
            <div style="flex:1;height:14px;background:#f2f6fc;border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${Math.max(barWidth*10,3)}%;background:${color.bar};border-radius:3px;transition:width .3s;"></div>
            </div>
            <div style="flex:0 0 100px;text-align:right;font-family:monospace;color:#303133;">${p.count.toLocaleString()}</div>
            <div style="flex:0 0 70px;text-align:right;color:#909399;">${p.pct}%</div>
          </div>`;
      }).join('') || `<div style="color:#909399;padding:20px;text-align:center;font-size:13px;">${clsName}地区暂无订单</div>`;

      const block = document.createElement('div');
      block.style.cssText = 'margin-bottom:16px;padding:16px;background:#fff;border:1px solid #ebeef5;border-radius:8px;';
      block.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h4 style="margin:0;font-size:14px;color:${color.text};font-weight:600;">${color.label}地区</h4>
          <span style="font-size:12px;color:#909399;">${list.length} 个省 · 合计 ${clsTotal.toLocaleString()} 单</span>
        </div>
        ${items}
        ${list.length ? `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;margin-top:8px;border-top:1px solid #ebeef5;font-weight:600;color:${color.text};">
          <div style="width:32px;text-align:center;">合计</div>
          <div style="flex:0 0 160px;">——</div>
          <div style="flex:1;"></div>
          <div style="flex:0 0 100px;text-align:right;font-family:monospace;">${clsTotal.toLocaleString()}</div>
          <div style="flex:0 0 70px;text-align:right;">${pct(clsTotal)}</div>
        </div>` : ''}
      `;
      provinceWrap.appendChild(block);
    });
  }

  function renderOrderQueryResults(data) {
    const panel = document.querySelector('.od-panel[data-panel="dashboard"]');
    if (!panel) return;
    const qs = (sel) => panel.querySelector(sel);
    const details = data.details || [];

    if (!details.length) {
      qs('#oqList').innerHTML = `<div style="color:#909399;padding:20px;text-align:center;border:1px dashed #dcdfe6;border-radius:6px;">📭 当前筛选条件下无订单数据</div>`;
      return;
    }

    const rows = details.map((d) => {
      const clsColor = CLASS_COLOR_MAP(d.effective_class);
      return `<tr style="border-bottom:1px solid #ebeef5;">
        <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;color:#909399;text-align:center;">#${d.order_id}</td>
        <td style="padding:6px;border:1px solid #ebeef5;font-family:monospace;font-size:12px;">${d.order_no}</td>
        <td style="padding:6px;border:1px solid #ebeef5;font-size:13px;">${d.owner_name||''}</td>
        <td style="padding:6px;border:1px solid #ebeef5;font-size:13px;">${d.customer_name||'-'}</td>
        <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;">${d.to_province||'-'} / ${d.to_city||'-'}</td>
        <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;text-align:center;">
          <span style="padding:2px 8px;border-radius:3px;background:${clsColor.bg};color:${clsColor.text};border:1px solid ${clsColor.border};font-size:12px;">${d.effective_class||'正常'}</span>
        </td>
        <td style="padding:6px;border:1px solid #ebeef5;font-size:13px;text-align:right;">${d.ship_quantity} ${d.unit||''}</td>
        <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;">${d.wms_platform||'-'}</td>
        <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;">${d.order_date}</td>
      </tr>`;
    }).join('');

    qs('#oqList').innerHTML = `
      <div style="max-height:420px;overflow:auto;border:1px solid #ebeef5;border-radius:6px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:#f5f7fa;z-index:1;"><tr>
            <th style="padding:6px;border:1px solid #ebeef5;">#</th>
            <th style="padding:6px;border:1px solid #ebeef5;">订单号</th>
            <th style="padding:6px;border:1px solid #ebeef5;">货主</th>
            <th style="padding:6px;border:1px solid #ebeef5;">客户</th>
            <th style="padding:6px;border:1px solid #ebeef5;">收件省/市</th>
            <th style="padding:6px;border:1px solid #ebeef5;">地区分类</th>
            <th style="padding:6px;border:1px solid #ebeef5;">件数</th>
            <th style="padding:6px;border:1px solid #ebeef5;">来源平台</th>
            <th style="padding:6px;border:1px solid #ebeef5;">订单日期</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:6px;font-size:12px;color:#909399;text-align:right;">共 ${details.length} 条（limit 500）</div>`;
  }

  function CLASS_COLOR_MAP(cls) {
    return ({
      '大偏远': { bg:'#fef0f0', text:'#f56c6c', border:'#f56c6c' },
      '小偏远': { bg:'#fdf6ec', text:'#e6a23c', border:'#e6a23c' },
      '正常':   { bg:'#f0f9eb', text:'#67c23a', border:'#67c23a' },
    })[cls] || { bg:'#f0f9eb', text:'#67c23a', border:'#67c23a' };
  }

  function exportDashboard() {
    if (!_dashCache) return;
    const xlsx = window.XLSX; if (!xlsx) { alert('导出组件未加载'); return; }
    const d = _dashCache;
    const summary = [
      ['总订单数', d.total||0], ['偏远合计', d.remote_total||0],
      ['大偏远', d.by_class['大偏远']||0], ['小偏远', d.by_class['小偏远']||0], ['正常', d.by_class['正常']||0],
      ['查询月份', document.querySelector('#dashMonth')?.value || ''],
    ];
    const provAoA = [['地区分类','省份','订单数','占比'], [], ['大偏远'], [], ['小偏远'], [], ['正常']];
    let idx = 1;
    ['大偏远','小偏远','正常'].forEach((cls) => {
      provAoA[idx] = [cls, '', '', '']; idx++;
      (d.by_class_province[cls] || []).forEach((p) => {
        provAoA[idx] = ['', p.province, p.count, p.pct + '%']; idx++;
      });
    });
    const detailAoA = [['订单ID','订单号','货主','客户','收件省','收件市','地区分类','件数','来源平台','订单日期']];
    (d.details || []).forEach((x) => {
      detailAoA.push([x.order_id, x.order_no, x.owner_name, x.customer_name, x.to_province, x.to_city, x.effective_class, x.ship_quantity, x.wms_platform, x.order_date]);
    });
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(summary), '汇总');
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(provAoA), '省份分布');
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(detailAoA), '订单明细');
    const buf = xlsx.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `地区看板-${document.querySelector('#dashMonth')?.value || ''}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // 偏远地区方案配置弹层
  // =========================================================================
  function openPlanConfigModal({ onSaved }) {
    API.get('/orders/region-plans').then((data) => {
      showPlanModal(data.plans || [], onSaved);
    }).catch((e) => alert('加载方案失败: ' + e.message));
  }

  function showPlanModal(plans, onSaved) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:960px;max-width:95vw;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 4px 24px rgba(0,0,0,.15);">
        <div style="padding:16px 20px;border-bottom:1px solid #ebeef5;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:16px;color:#303133;">⚙️ 偏远地区方案配置</h3>
          <button id="pmClose" style="border:none;background:transparent;font-size:22px;cursor:pointer;color:#909399;">×</button>
        </div>
        <div style="padding:16px 20px;display:flex;gap:16px;flex:1;overflow:hidden;">
          <!-- 左侧：方案列表 -->
          <div style="flex:0 0 240px;border-right:1px solid #ebeef5;padding-right:16px;display:flex;flex-direction:column;">
            <button id="pmNew" style="${BTN_PRIMARY};margin-bottom:12px;font-size:13px;">➕ 新建方案</button>
            <div id="pmPlanList" style="flex:1;overflow:auto;"></div>
          </div>
          <!-- 右侧：编辑区 -->
          <div id="pmEditor" style="flex:1;overflow:auto;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#pmClose').onclick = () => { overlay.remove(); };

    const listEl = overlay.querySelector('#pmPlanList');
    const editorEl = overlay.querySelector('#pmEditor');
    let selectedPlanId = null;

    function renderPlanList() {
      listEl.innerHTML = plans.map((p) => `
        <div data-id="${p.id}" class="pm-plan-item" style="padding:10px;border-radius:6px;cursor:pointer;margin-bottom:6px;border:1px solid transparent;font-size:13px;${selectedPlanId === p.id ? 'border-color:#409eff;background:#ecf5ff;' : 'border-color:#ebeef5;'}">
          <div style="font-weight:600;color:#303133;">${p.is_default ? '★ ' : ''}${escapeHtml(p.name)}</div>
          <div style="color:#909399;font-size:12px;margin-top:2px;">覆盖 ${p.override_count||0} 条规则</div>
        </div>
      `).join('') || '<div style="color:#909399;font-size:13px;text-align:center;padding:20px;">暂无方案</div>';
      listEl.querySelectorAll('.pm-plan-item').forEach((el) => {
        el.onclick = () => { selectedPlanId = parseInt(el.dataset.id, 10); renderPlanList(); loadEditor(selectedPlanId); };
      });
    }

    function loadEditor(id) {
      const plan = plans.find((p) => p.id === id);
      if (!plan) { editorEl.innerHTML = `<div style="color:#909399;padding:20px;text-align:center;font-size:13px;">从左侧选择一个方案，或新建方案开始编辑</div>`; return; }

      API.get(`/orders/region-plans/${id}/overrides`).then((data) => {
        renderEditor(data.plan, data.overrides || []);
      }).catch((e) => { editorEl.innerHTML = `❌ ${e.message}`; });
    }

    function renderEditor(plan, overrides) {
      const overridesList = [...overrides];
      const saveableCls = ['大偏远', '小偏远', '正常'];

      const html = `
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:13px;color:#606266;margin-bottom:4px;">方案名称</label>
          <input id="pmEdName" value="${escapeHtml(plan.name)}" style="width:100%;padding:8px;border:1px solid #dcdfe6;border-radius:4px;font-size:14px;">
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:13px;color:#606266;margin-bottom:4px;">方案描述（选填）</label>
          <textarea id="pmEdDesc" rows="2" style="width:100%;padding:8px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;">${escapeHtml(plan.description || '')}</textarea>
        </div>
        <div style="display:flex;gap:10px;margin-bottom:16px;">
          ${plan.is_default
            ? '<span style="color:#e6a23c;font-size:12px;padding:3px 10px;background:#fdf6ec;border-radius:3px;">★ 默认方案</span>'
            : `<button id="pmSetDef" style="${BTN_GHOST};padding:4px 12px;font-size:12px;">设为默认</button>
               <button id="pmDelete" style="background:#fff;color:#f56c6c;border:1px solid #f56c6c;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer;">删除方案</button>`}
        </div>

        <div style="margin-top:16px;border-top:1px solid #ebeef5;padding-top:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:600;color:#303133;">📍 省份覆盖规则</div>
            <button id="pmAddRow" style="${BTN_GHOST};padding:4px 12px;font-size:12px;">➕ 新增规则</button>
          </div>
          <div style="color:#909399;font-size:12px;margin-bottom:10px;">
            💡 为方案添加的覆盖规则会优先于系统内置的 shentong_region_class。未覆盖的省份/城市继续使用默认判定。
          </div>
          <div id="pmOverridesWrap"></div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid #ebeef5;">
          <button id="pmCancel" style="${BTN_GHOST}">取消</button>
          <button id="pmSave" style="${BTN_PRIMARY}">💾 保存方案</button>
        </div>
      `;
      editorEl.innerHTML = html;

      function renderOverrideRows() {
        const wrap = editorEl.querySelector('#pmOverridesWrap');
        if (!overridesList.length) {
          wrap.innerHTML = `<div style="color:#909399;padding:16px;text-align:center;border:1px dashed #dcdfe6;border-radius:6px;font-size:13px;">暂无覆盖规则，点击「➕ 新增规则」添加</div>`; return;
        }
        wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="background:#f5f7fa;"><tr>
            <th style="padding:6px;border:1px solid #ebeef5;text-align:left;">省份</th>
            <th style="padding:6px;border:1px solid #ebeef5;text-align:left;">城市（可空=全省）</th>
            <th style="padding:6px;border:1px solid #ebeef5;text-align:left;">分类</th>
            <th style="padding:6px;border:1px solid #ebeef5;width:60px;"></th>
          </tr></thead>
          <tbody>${overridesList.map((o, idx) => `
            <tr data-idx="${idx}">
              <td style="padding:4px;border:1px solid #ebeef5;"><input class="ov-prov" value="${escapeHtml(o.province)}" style="width:100%;padding:4px;border:1px solid #dcdfe6;border-radius:3px;font-size:13px;"></td>
              <td style="padding:4px;border:1px solid #ebeef5;"><input class="ov-city" value="${escapeHtml(o.city||'')}" placeholder="不填=全省" style="width:100%;padding:4px;border:1px solid #dcdfe6;border-radius:3px;font-size:13px;"></td>
              <td style="padding:4px;border:1px solid #ebeef5;">
                <select class="ov-cls" style="width:100%;padding:4px;border:1px solid #dcdfe6;border-radius:3px;font-size:13px;">
                  ${saveableCls.map((c) => `<option value="${c}" ${o.region_class===c?'selected':''}>${c}</option>`).join('')}
                </select>
              </td>
              <td style="padding:4px;border:1px solid #ebeef5;text-align:center;">
                <button class="ov-del" data-idx="${idx}" style="border:none;background:transparent;color:#f56c6c;cursor:pointer;font-size:13px;">🗑️</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>`;
        wrap.querySelectorAll('.ov-del').forEach((b) => {
          b.onclick = () => { overridesList.splice(parseInt(b.dataset.idx,10),1); renderOverrideRows(); };
        });
      }
      renderOverrideRows();

      editorEl.querySelector('#pmAddRow').onclick = () => {
        overridesList.push({ province: '', city: '', region_class: '正常' });
        renderOverrideRows();
      };
      editorEl.querySelector('#pmCancel').onclick = () => { overlay.remove(); };
      editorEl.querySelector('#pmSetDef')?.addEventListener('click', () => {
        API.post(`/orders/region-plans/${plan.id}/default`).then(() => {
          plans.forEach((p) => p.is_default = p.id === plan.id);
          renderPlanList(); loadEditor(plan.id);
        }).catch((e) => alert(e.message));
      });
      editorEl.querySelector('#pmDelete')?.addEventListener('click', () => {
        if (!confirm(`确认删除方案「${plan.name}」？（默认方案不可删除）`)) return;
        API.del(`/orders/region-plans/${plan.id}`).then(() => {
          plans = plans.filter((p) => p.id !== plan.id);
          selectedPlanId = null;
          renderPlanList();
          editorEl.innerHTML = `<div style="color:#909399;padding:20px;text-align:center;font-size:13px;">方案已删除</div>`;
          if (onSaved) onSaved();
        }).catch((e) => alert(e.message));
      });

      editorEl.querySelector('#pmSave').onclick = () => {
        const name = editorEl.querySelector('#pmEdName').value.trim();
        const description = editorEl.querySelector('#pmEdDesc').value.trim();
        const rows = editorEl.querySelectorAll('#pmOverridesWrap tbody tr');
        const newOverrides = [];
        rows.forEach((tr) => {
          const prov = tr.querySelector('.ov-prov').value.trim();
          const city = tr.querySelector('.ov-city').value.trim() || null;
          const cls = tr.querySelector('.ov-cls').value;
          if (prov) newOverrides.push({ province: prov, city, region_class: cls });
        });
        if (!name) { alert('方案名称不能为空'); return; }
        API.put(`/orders/region-plans/${plan.id}`, { name, description, overrides: newOverrides }).then(() => {
          // 刷新本地 plans
          const defCnt = newOverrides.length;
          const inList = plans.find((p) => p.id === plan.id);
          if (inList) { inList.name = name; inList.description = description; inList.override_count = defCnt; }
          renderPlanList();
          alert('✅ 保存成功');
          if (onSaved) onSaved();
        }).catch((e) => alert('保存失败: ' + e.message));
      };
    }

    overlay.querySelector('#pmNew').onclick = () => {
      const name = prompt('请输入新方案名称：');
      if (!name) return;
      API.post('/orders/region-plans', { name, description: '' }).then((data) => {
        plans.push({ id: data.id, name, is_default: 0, description: '', override_count: 0 });
        selectedPlanId = data.id; renderPlanList(); loadEditor(data.id);
      }).catch((e) => alert(e.message));
    };

    // 默认选中第一个
    const def = plans.find((p) => p.is_default) || plans[0];
    if (def) { selectedPlanId = def.id; renderPlanList(); loadEditor(def.id); }
    else renderPlanList();
  }

  // ---------- 注册 ----------
  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES['order_import']   = (h) => createPage(h, 'order_import');
  window.ERP_PAGES['order_dashboard'] = (h) => createPage(h, 'order_dashboard');
})();
