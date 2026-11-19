// ============================================================================
// 订单导入 + 数据看板（docs/单据 子菜单 · 双页面共用同文件）
// ----------------------------------------------------------------------------
// - order_import      path=order_import      默认落在「导入」Tab
// - order_dashboard   path=order_dashboard   默认落在「看板」Tab
// 两个页面共用同一套 createPage 工厂，通过 defaultTab 参数决定初始 Tab。
// ============================================================================
(function () {
  const API = window.API;
  const PAGE_TITLE = { order_import: '订单导入', order_dashboard: '数据看板' };

  // ---------- 公共样式 ----------
  const HOST_CSS = 'padding:16px;background:#f5f7fa;min-height:100%;box-sizing:border-box;';
  const CARD_CSS = 'background:#fff;border-radius:8px;padding:18px;margin-bottom:16px;' +
                   'box-shadow:0 1px 3px rgba(0,0,0,.06);';
  const BTN_PRIMARY = 'background:#409eff;color:#fff;border:none;border-radius:4px;' +
                      'padding:8px 20px;font-size:14px;cursor:pointer;';
  const BTN_PRIMARY_DISABLED = BTN_PRIMARY + ';opacity:.5;cursor:not-allowed;';
  const BTN_GHOST = 'background:#fff;color:#409eff;border:1px solid #409eff;border-radius:4px;' +
                    'padding:7px 16px;font-size:14px;cursor:pointer;';

  // ---------- 页面工厂 ----------
  function createPage(host, pageId) {
    host.innerHTML = '';
    host.style.cssText = HOST_CSS;

    const defaultTab = pageId === 'order_dashboard' ? 'dashboard' : 'import';

    // 外层容器
    const wrap = document.createElement('div');
    wrap.style.maxWidth = '1280px';
    wrap.style.margin = '0 auto';
    wrap.innerHTML = `
      <div class="od-tabs" style="display:flex;gap:4px;margin-bottom:16px;">
        <button class="od-tab" data-tab="import"
                style="padding:10px 24px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:14px;">📤 批量导入</button>
        <button class="od-tab" data-tab="dashboard"
                style="padding:10px 24px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:14px;">📊 地区看板</button>
      </div>
      <div class="od-panels">
        <div class="od-panel" data-panel="import" style="display:none;"></div>
        <div class="od-panel" data-panel="dashboard" style="display:none;"></div>
      </div>
    `;
    host.appendChild(wrap);

    // Tab 切换样式 + 事件
    const tabs = wrap.querySelectorAll('.od-tab');
    const panels = wrap.querySelectorAll('.od-panel');
    let currentTab = null;

    function switchTab(tabName) {
      currentTab = tabName;
      tabs.forEach((t) => {
        t.style.background = t.dataset.tab === tabName ? '#409eff' : '#e4e7ed';
        t.style.color = t.dataset.tab === tabName ? '#fff' : '#606266';
        t.style.fontWeight = t.dataset.tab === tabName ? '600' : '400';
      });
      panels.forEach((p) => { p.style.display = p.dataset.panel === tabName ? 'block' : 'none'; });

      if (tabName === 'import' && !p_import_mounted) {
        mountImport(wrap.querySelector('[data-panel="import"]'));
        p_import_mounted = true;
      }
      if (tabName === 'dashboard' && !p_dash_mounted) {
        mountDashboard(wrap.querySelector('[data-panel="dashboard"]'));
        p_dash_mounted = true;
      }
      if (tabName === 'dashboard' && p_dash_mounted) {
        refreshDashboard();
      }
    }

    let p_import_mounted = false, p_dash_mounted = false;

    tabs.forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
    switchTab(defaultTab);
  }

  // =========================================================================
  // Tab 1: 批量导入
  // =========================================================================
  let _platforms = null;

  function mountImport(panel) {
    panel.innerHTML = '';

    // 卡片：模板下载 + 平台选择 + 文件上传
    const card = document.createElement('div');
    card.style.cssText = CARD_CSS;
    card.innerHTML = `
      <h3 style="margin:0 0 16px;font-size:16px;color:#303133;">📤 批量导入订单</h3>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
        <div>
          <label style="display:block;font-size:13px;color:#606266;margin-bottom:6px;">① 下载导入模板</label>
          <a href="/api/orders/template"
             style="display:inline-block;padding:8px 20px;background:#67c23a;color:#fff;border-radius:4px;text-decoration:none;font-size:14px;">
             ⬇ 下载 xlsx 模板
          </a>
          <span style="color:#909399;font-size:12px;margin-left:8px;">（7 列标准字段，含示例行）</span>
        </div>
        <div>
          <label style="display:block;font-size:13px;color:#606266;margin-bottom:6px;">② 选择来源平台（WMS/打单系统）</label>
          <select id="odPlatform"
                  style="width:100%;padding:8px 12px;border:1px solid #dcdfe6;border-radius:4px;font-size:14px;">
            <option value="">—— 正在加载平台列表 ——</option>
          </select>
        </div>
      </div>

      <div id="odDropZone"
           style="border:2px dashed #c0ccda;border-radius:8px;padding:40px;text-align:center;cursor:pointer;background:#fafafa;margin-bottom:16px;">
        <div style="font-size:48px;color:#909399;margin-bottom:8px;">📁</div>
        <div style="color:#606266;font-size:15px;margin-bottom:4px;">点击或拖拽 Excel / CSV 文件到此处</div>
        <div style="color:#909399;font-size:12px;">支持 .xlsx / .xls / .csv · 无行数/文件大小硬性限制</div>
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

    // --- 加载平台列表 ---
    API.get('/orders/platforms').then((r) => {
      _platforms = r?.platforms || ['百世WMS'];
      const sel = card.querySelector('#odPlatform');
      sel.innerHTML = '';
      _platforms.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        sel.appendChild(opt);
      });
      sel.onchange = () => updateSubmitEnabled();
    }).catch(() => {
      const sel = card.querySelector('#odPlatform');
      sel.innerHTML = '<option value="百世WMS">百世WMS</option>';
    });

    // --- 拖拽 + 点击上传 ---
    const dropZone = card.querySelector('#odDropZone');
    const fileInput = card.querySelector('#odFile');
    let _selectedFile = null;

    dropZone.onclick = () => fileInput.click();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = '#409eff'; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = '#c0ccda'; };
    dropZone.ondrop = (e) => {
      e.preventDefault(); dropZone.style.borderColor = '#c0ccda';
      if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
    };
    fileInput.onchange = () => { if (fileInput.files.length) onFile(fileInput.files[0]); };

    function onFile(file) {
      _selectedFile = file;
      // 预览区
      const prev = card.querySelector('#odPreview');
      prev.style.display = 'block';
      prev.innerHTML = `
        <div style="padding:12px 16px;background:#ecf5ff;border-radius:4px;border-left:3px solid #409eff;">
          📄 <b>${file.name}</b> · ${(file.size/1024).toFixed(1)} KB
        </div>
      `;
      updateSubmitEnabled();
    }

    // --- 提交 ---
    const submitBtn = card.querySelector('#odSubmit');
    const resetBtn = card.querySelector('#odReset');

    function updateSubmitEnabled() {
      const platform = card.querySelector('#odPlatform').value;
      if (_selectedFile && platform) {
        submitBtn.style.cssText = BTN_PRIMARY;
        submitBtn.disabled = false;
      } else {
        submitBtn.style.cssText = BTN_PRIMARY_DISABLED;
        submitBtn.disabled = true;
      }
    }

    submitBtn.onclick = () => {
      const platform = card.querySelector('#odPlatform').value;
      if (!_selectedFile || !platform) return;

      // 显示进度
      const prog = card.querySelector('#odProgress');
      prog.style.display = 'block';
      prog.innerHTML = `
        <div style="padding:14px;background:#fdf6ec;border-radius:4px;border-left:3px solid #e6a23c;color:#e6a23c;font-size:14px;">
          ⏳ 正在导入 <b>${_selectedFile.name}</b>（平台: ${platform}）... 请稍候
        </div>
      `;
      const result = card.querySelector('#odResult');
      result.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.style.cssText = BTN_PRIMARY_DISABLED;

      const fd = new FormData();
      fd.append('file', _selectedFile);
      fd.append('platform', platform);

      API.upload('/orders/import', fd).then((data) => {
        prog.style.display = 'none';

        const res = card.querySelector('#odResult');
        res.style.display = 'block';

        const { success = 0, failed = 0, failures = [] } = data;
        const html = [
          `<div style="padding:14px;border-radius:4px;border-left:3px solid ${failed ? '#e6a23c' : '#67c23a'};background:${failed ? '#fdf6ec' : '#f0f9eb'};">`,
          `<b style="color:${failed ? '#e6a23c' : '#67c23a'};font-size:15px;">导入完成</b>`,
          `<div style="margin-top:8px;font-size:14px;color:#606266;">`,
          `  ✅ 成功导入：<b style="color:#67c23a;">${success}</b> 行`,
          failed ? ` · ❌ 失败：<b style="color:#f56c6c;">${failed}</b> 行` : '',
          `</div>`,
        ];
        if (failures.length) {
          html.push(`
            <details style="margin-top:10px;">
              <summary style="cursor:pointer;color:#409eff;font-size:13px;">
                查看失败清单（前 ${failures.length > 50 ? 50 + ' 条，完整结果见审计日志' : failures.length + ' 条'}）
              </summary>
              <div style="margin-top:8px;max-height:240px;overflow:auto;font-size:13px;">
                <table style="width:100%;border-collapse:collapse;">
                  <thead><tr style="background:#f5f7fa;"><th style="padding:6px;border:1px solid #ebeef5;">Excel 行号</th>
                    <th style="padding:6px;border:1px solid #ebeef5;">失败原因</th></tr></thead>
                  <tbody>
                    ${failures.slice(0, 50).map((f) => `
                      <tr><td style="padding:6px;border:1px solid #ebeef5;text-align:center;">${f.row}</td>
                          <td style="padding:6px;border:1px solid #ebeef5;color:#f56c6c;">${f.reason}</td></tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </details>
          `);
        }
        html.push('</div>');
        res.innerHTML = html.join('');

        // 导入成功时自动跳到看板 Tab
        if (success > 0) {
          setTimeout(() => {
            const tabs = wrap.querySelectorAll('.od-tab');
            const panels = wrap.querySelectorAll('.od-panel');
            // 触发 click 事件（复用 switchTab）
            tabs.forEach((t) => { if (t.dataset.tab === 'dashboard') t.click(); });
          }, 1200);
        }
      }).catch((e) => {
        prog.style.display = 'none';
        const res = card.querySelector('#odResult');
        res.style.display = 'block';
        res.innerHTML = `<div style="padding:14px;background:#fef0f0;border-radius:4px;border-left:3px solid #f56c6c;color:#f56c6c;">
          ❌ 网络异常：${e.message}
        </div>`;
      });
    };

    submitBtn.onclick = submitBtn.onclick; // 避免 jshint 警告
    submitBtn.addEventListener('click', () => { /* 上面已定义 */ });

    resetBtn.onclick = () => {
      _selectedFile = null;
      fileInput.value = '';
      panel.querySelector('#odPreview').style.display = 'none';
      panel.querySelector('#odProgress').style.display = 'none';
      panel.querySelector('#odResult').style.display = 'none';
      updateSubmitEnabled();
    };
  }

  // =========================================================================
  // Tab 2: 地区看板
  // =========================================================================
  let _dashCache = null;

  function mountDashboard(panel) {
    panel.innerHTML = '';

    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const card = document.createElement('div');
    card.style.cssText = CARD_CSS;
    card.innerHTML = `
      <h3 style="margin:0 0 16px;font-size:16px;color:#303133;">📊 申通地区分类看板</h3>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">
          起 <input id="dashStart" type="date" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;" value="${fmt(startOfMonth)}">
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">
          止 <input id="dashEnd" type="date" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;" value="${fmt(today)}">
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">
          平台 <select id="dashPlatform" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;">
            <option value="全部">全部</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">
          分类 <select id="dashClass" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;">
            <option value="">全部</option>
            <option value="大偏远">大偏远</option>
            <option value="小偏远">小偏远</option>
            <option value="正常">正常</option>
          </select>
        </label>
        <button id="dashQuery" style="${BTN_PRIMARY}">🔍 查询</button>
        <button id="dashReset" style="${BTN_GHOST}">🔄 重置</button>
      </div>

      <div id="dashCards"></div>
      <div id="dashTableWrap" style="margin-top:20px;"></div>
    `;
    panel.appendChild(card);

    // 加载平台下拉
    API.get('/orders/platforms').then((r) => {
      const sel = card.querySelector('#dashPlatform');
      (r?.platforms || []).forEach((p) => {
        const o = document.createElement('option'); o.value = p; o.textContent = p;
        sel.appendChild(o);
      });
    }).catch(() => {});

    card.querySelector('#dashQuery').onclick = refreshDashboard;
    card.querySelector('#dashReset').onclick = () => {
      card.querySelector('#dashStart').value = fmt(startOfMonth);
      card.querySelector('#dashEnd').value = fmt(today);
      card.querySelector('#dashPlatform').value = '全部';
      card.querySelector('#dashClass').value = '';
      refreshDashboard();
    };

    refreshDashboard();
  }

  function refreshDashboard() {
    const panel = document.querySelector('.od-panel[data-panel="dashboard"]');
    if (!panel) return;
    const card = panel.querySelector('.od-card') || panel.children[0];
    const qs = (sel) => card.querySelector(sel);

    const start = qs('#dashStart')?.value || '';
    const end = qs('#dashEnd')?.value || '';
    const platform = qs('#dashPlatform')?.value || '全部';
    const cls = qs('#dashClass')?.value || '';

    const url = `/api/orders/dashboard?start=${start}&end=${end}&platform=${encodeURIComponent(platform)}${cls ? '&class=' + encodeURIComponent(cls) : ''}`;

    qs('#dashCards').innerHTML = '<div style="color:#909399;padding:20px;text-align:center;">⏳ 加载中...</div>';

    fetch(url, {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || '') },
    }).then(async (resp) => {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      _dashCache = data;
      renderDashboard(data);
    }).catch((e) => {
      qs('#dashCards').innerHTML = `<div style="color:#f56c6c;padding:20px;text-align:center;">❌ 加载失败: ${e.message}</div>`;
    });
  }

  function renderDashboard(data) {
    const panel = document.querySelector('.od-panel[data-panel="dashboard"]');
    const card = panel.children[0];
    const cardsWrap = card.querySelector('#dashCards');
    const tableWrap = card.querySelector('#dashTableWrap');

    const { by_class, total, remote_total, details, platform_breakdown } = data;

    // 统计卡片
    const pct = (n) => total ? ((n * 100) / total).toFixed(1) + '%' : '0%';
    const remotePct = total ? ((remote_total * 100) / total).toFixed(1) + '%' : '0%';

    const CLASS_COLOR = {
      '大偏远': { bg: '#fef0f0', text: '#f56c6c', border: '#f56c6c' },
      '小偏远': { bg: '#fdf6ec', text: '#e6a23c', border: '#e6a23c' },
      '正常':   { bg: '#f0f9eb', text: '#67c23a', border: '#67c23a' },
    };
    const labelOfClass = { '大偏远': '🔴 大偏远地区', '小偏远': '🟠 小偏远地区', '正常': '🟢 正常地区' };

    const classCards = ['大偏远', '小偏远', '正常'].map((c) => {
      const color = CLASS_COLOR[c];
      const cnt = by_class[c] || 0;
      return `
        <div style="flex:1;min-width:180px;padding:16px;border-radius:8px;background:${color.bg};border-left:4px solid ${color.border};">
          <div style="color:${color.text};font-size:13px;font-weight:600;margin-bottom:6px;">${labelOfClass[c]}</div>
          <div style="font-size:22px;font-weight:700;color:#303133;">${cnt.toLocaleString()}</div>
          <div style="font-size:12px;color:#909399;margin-top:4px;">占比 ${pct(cnt)}</div>
        </div>
      `;
    }).join('');

    cardsWrap.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;">${classCards}</div>
      <div style="margin-top:12px;padding:12px 16px;background:#ecf5ff;border-radius:6px;border-left:4px solid #409eff;">
        📦 <b>偏远地区合计（大偏远 + 小偏远）</b>：${remote_total.toLocaleString()} 单 · 占比 <b style="color:#e6a23c;">${remotePct}</b>
        · 总订单：<b>${total.toLocaleString()}</b> 单
      </div>
    `;

    // 明细表
    if (!details || !details.length) {
      tableWrap.innerHTML = `<div style="color:#909399;padding:20px;text-align:center;border:1px dashed #dcdfe6;border-radius:6px;">
        📭 当前筛选条件下无订单数据。先去「📤 批量导入」Tab 导入订单吧！
      </div>`;
      return;
    }

    const rows = details.map((d) => {
      const c = CLASS_COLOR[d.region_class || '正常'];
      return `
        <tr style="border-bottom:1px solid #ebeef5;">
          <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;color:#909399;">#${d.order_id}</td>
          <td style="padding:8px;border:1px solid #ebeef5;font-family:monospace;font-size:12px;">${d.order_no}</td>
          <td style="padding:8px;border:1px solid #ebeef5;font-size:13px;">${d.owner_name || ''}</td>
          <td style="padding:8px;border:1px solid #ebeef5;font-size:13px;">${d.company_name || '-'}</td>
          <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;">${d.to_province || '-'} / ${d.to_city || '-'}</td>
          <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;text-align:center;">
            <span style="padding:2px 8px;border-radius:3px;background:${c.bg};color:${c.text};border:1px solid ${c.border};font-size:12px;">${d.region_class || '正常'}</span>
          </td>
          <td style="padding:8px;border:1px solid #ebeef5;font-size:13px;text-align:right;">${d.ship_quantity} ${d.unit || ''}</td>
          <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;">${d.wms_platform || '-'}</td>
          <td style="padding:8px;border:1px solid #ebeef5;font-size:12px;">${d.order_date}</td>
        </tr>
      `;
    }).join('');

    tableWrap.innerHTML = `
      <div style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-size:13px;color:#606266;">
          共 <b>${details.length}</b> 条（limit 500，完整数据请用导出）
        </div>
        <button id="dashExport" style="${BTN_GHOST}">⬇ 导出 Excel</button>
      </div>
      <div style="max-height:480px;overflow:auto;border:1px solid #ebeef5;border-radius:6px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:#f5f7fa;z-index:1;">
            <tr>
              <th style="padding:8px;border:1px solid #ebeef5;">#</th>
              <th style="padding:8px;border:1px solid #ebeef5;">订单号</th>
              <th style="padding:8px;border:1px solid #ebeef5;">货主</th>
              <th style="padding:8px;border:1px solid #ebeef5;">客户</th>
              <th style="padding:8px;border:1px solid #ebeef5;">收件省/市</th>
              <th style="padding:8px;border:1px solid #ebeef5;">地区分类</th>
              <th style="padding:8px;border:1px solid #ebeef5;">件数</th>
              <th style="padding:8px;border:1px solid #ebeef5;">来源平台</th>
              <th style="padding:8px;border:1px solid #ebeef5;">订单日期</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    // 导出（浏览器端用 XLSX，_lib-lazy 已预加载）
    const xlsx = window.XLSX;
    if (xlsx) {
      card.querySelector('#dashExport').onclick = () => {
        const aoa = [
          ['订单ID', '订单号', '货主', '客户', '收件省', '收件市', '地区分类', '件数', '单位', '来源平台', '订单日期'],
          ...details.map((d) => [
            d.order_id, d.order_no, d.owner_name, d.company_name,
            d.to_province, d.to_city, d.region_class,
            d.ship_quantity, d.unit, d.wms_platform, d.order_date,
          ]),
        ];
        const ws = xlsx.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 6 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 6 }, { wch: 14 }, { wch: 12 }];
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, '地区看板');
        const buf = xlsx.write(wb, { type: 'array', bookType: 'xlsx' });
        const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `地区看板-${new Date().toISOString().slice(0, 10)}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
      };
    } else {
      card.querySelector('#dashExport').disabled = true;
      card.querySelector('#dashExport').style.opacity = '.5';
    }
  }

  // ---------- 注册到 ERP_PAGES ----------
  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES['order_import']     = (h) => createPage(h, 'order_import');
  window.ERP_PAGES['order_dashboard']   = (h) => createPage(h, 'order_dashboard');
})();
