// ============================================================================
// 订单导入（独立模块）· oih_import
// ----------------------------------------------------------------------------
// 数据与其他业务完全隔离：所有数据来自 /api/order-import-hub/*。
// 三个 Tab：导入 / 查询 / 地区分析。地区分析中的【各地区累计分布】
// 严格复用原 orders-module.js 的双栏进度条布局与 CSS（.od-region-*）。
// ============================================================================
(function () {
  const API = window.API;
  const PAGES = (window.ERP_PAGES = window.ERP_PAGES || {});
  const BTN_PRIMARY = 'background:#409eff;color:#fff;border:none;border-radius:4px;padding:8px 20px;font-size:14px;cursor:pointer;';
  const BTN_GHOST = 'background:#fff;color:#409eff;border:1px solid #409eff;border-radius:4px;padding:7px 16px;font-size:14px;cursor:pointer;';
  const CARD_CSS = 'background:#fff;border-radius:8px;padding:18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06);';
  const API_BASE = '/order-import-hub';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg, type) {
    if (window.ERP && ERP.toast) ERP.toast(msg, type || 'info');
    else alert(msg);
  }

  // --------------------------------------------------------------------------
  // 导入异常明细弹窗（跳过/失败行）：可筛选、查看原始行、下载 Excel
  // --------------------------------------------------------------------------
  function openRejectsModal(batchId) {
    const old = document.getElementById('__oihRejectsModal');
    if (old) old.remove();
    const TYPE_LABEL = { duplicate: '重复跳过', filtered: '条件过滤', empty: '空数据失败', write_error: '写入失败' };
    const TYPE_COLOR = { duplicate: '#e6a23c', filtered: '#909399', empty: '#f56c6c', write_error: '#c0c4cc' };
    const mask = document.createElement('div');
    mask.id = '__oihRejectsModal';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;';
    mask.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:min(1100px,96vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.25);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #ebeef5;">
          <div>
            <h3 style="margin:0;font-size:16px;color:#303133;">⚠️ 未导入数据明细 ${batchId ? `<span style="font-size:13px;color:#909399;font-weight:400;">（批次 #${batchId}）</span>` : '（全部批次）'}</h3>
            <div style="font-size:12px;color:#909399;margin-top:4px;">这些行未被导入，下面列出具体原因与原始数据，可下载后逐行核对</div>
          </div>
          <button id="__oihRejClose" style="background:none;border:none;font-size:22px;color:#909399;cursor:pointer;line-height:1;">×</button>
        </div>
        <div style="padding:12px 20px;border-bottom:1px solid #f0f2f5;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <select id="__oihRejType" style="padding:6px 10px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;">
            <option value="全部">全部原因</option>
            <option value="filtered">条件过滤</option>
            <option value="duplicate">重复跳过</option>
            <option value="empty">空数据失败</option>
            <option value="write_error">写入失败</option>
          </select>
          <span id="__oihRejSummary" style="font-size:12px;color:#606266;"></span>
          <div style="flex:1;"></div>
          <button id="__oihRejDownload" style="${BTN_GHOST}">⬇ 下载明细 Excel</button>
        </div>
        <div id="__oihRejBody" style="flex:1;overflow:auto;padding:0 20px;"></div>
        <div id="__oihRejPager" style="padding:12px 20px;border-top:1px solid #ebeef5;display:flex;gap:10px;align-items:center;justify-content:flex-end;font-size:13px;color:#606266;"></div>
      </div>`;
    document.body.appendChild(mask);
    const $ = (s) => mask.querySelector(s);
    let page = 1, pageSize = 50, curType = '全部';

    function load() {
      const p = new URLSearchParams({ page, pageSize });
      if (batchId) p.set('batchId', batchId);
      if (curType !== '全部') p.set('type', curType);
      $('#__oihRejBody').innerHTML = '<div style="padding:30px;text-align:center;color:#909399;">⏳ 加载中…</div>';
      API.get(API_BASE + '/rejects?' + p.toString()).then((data) => {
        const summary = (data.summary || []).map((s) => `${TYPE_LABEL[s.reason_type] || s.reason_type}: ${s.c}`).join(' · ') || '无异常';
        $('#__oihRejSummary').textContent = `共 ${data.total.toLocaleString()} 条 ｜ ${summary}`;
        const rows = data.rows || [];
        if (!rows.length) {
          $('#__oihRejBody').innerHTML = '<div style="padding:40px;text-align:center;color:#909399;">✅ 该条件下没有未导入的数据</div>';
          $('#__oihRejPager').innerHTML = '';
          return;
        }
        const body = rows.map((r) => {
          let raw = '';
          try { const o = JSON.parse(r.raw_json || '{}'); raw = Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n'); } catch (e) { raw = r.raw_json || ''; }
          return `
            <tr style="border-bottom:1px solid #ebeef5;vertical-align:top;">
              <td style="padding:7px 8px;border:1px solid #ebeef5;white-space:nowrap;">${r.excel_row || '-'}</td>
              <td style="padding:7px 8px;border:1px solid #ebeef5;white-space:nowrap;">${esc(r.platform || '-')}</td>
              <td style="padding:7px 8px;border:1px solid #ebeef5;white-space:nowrap;">${esc(r.sheet_name || '-')}</td>
              <td style="padding:7px 8px;border:1px solid #ebeef5;">
                <span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${TYPE_COLOR[r.reason_type] || '#909399'};color:#fff;font-size:12px;">${TYPE_LABEL[r.reason_type] || r.reason_type}</span>
                <div style="font-size:12px;color:#606266;margin-top:5px;max-width:460px;">${esc(r.reason)}</div>
              </td>
              <td style="padding:7px 8px;border:1px solid #ebeef5;white-space:nowrap;font-family:monospace;font-size:12px;">${esc(r.waybill_no || '-')}</td>
              <td style="padding:7px 8px;border:1px solid #ebeef5;white-space:nowrap;">${esc(r.owner_name || '-')}</td>
              <td style="padding:7px 8px;border:1px solid #ebeef5;">
                <button class="__oihRejRaw" data-raw="${encodeURIComponent(raw)}" style="background:#ecf5ff;color:#409eff;border:1px solid #b3d8ff;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:12px;">查看原行</button>
              </td>
            </tr>`;
        }).join('');
        $('#__oihRejBody').innerHTML = `
          <div style="overflow:auto;border:1px solid #ebeef5;border-radius:6px;margin-top:10px;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="position:sticky;top:0;background:#f5f7fa;z-index:1;">
              <th style="padding:7px 8px;border:1px solid #ebeef5;">Excel行</th><th style="padding:7px 8px;border:1px solid #ebeef5;">平台</th>
              <th style="padding:7px 8px;border:1px solid #ebeef5;">Sheet</th><th style="padding:7px 8px;border:1px solid #ebeef5;">原因</th>
              <th style="padding:7px 8px;border:1px solid #ebeef5;">快递单号</th><th style="padding:7px 8px;border:1px solid #ebeef5;">货主</th>
              <th style="padding:7px 8px;border:1px solid #ebeef5;">原始数据</th>
            </tr></thead><tbody>${body}</tbody></table>
          </div>`;
        mask.querySelectorAll('.__oihRejRaw').forEach((btn) => {
          btn.onclick = () => {
            const raw = decodeURIComponent(btn.dataset.raw || '');
            alert('原始行数据：\n\n' + (raw || '（无数据）'));
          };
        });
        const pages = Math.max(1, Math.ceil(data.total / pageSize));
        $('#__oihRejPager').innerHTML = `
          <span>共 ${data.total.toLocaleString()} 条</span>
          <select id="__oihRejSize" style="padding:4px 6px;border:1px solid #dcdfe6;border-radius:4px;">
            ${[50, 100, 200].map((n) => `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n} 条/页</option>`).join('')}
          </select>
          <button id="__oihRejPrev" style="padding:4px 12px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;cursor:pointer;" ${page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${page} / ${pages} 页</span>
          <button id="__oihRejNext" style="padding:4px 12px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;cursor:pointer;" ${page >= pages ? 'disabled' : ''}>下一页</button>`;
        $('#__oihRejSize').onchange = (e) => { pageSize = Number(e.target.value); page = 1; load(); };
        $('#__oihRejPrev').onclick = () => { if (page > 1) { page--; load(); } };
        $('#__oihRejNext').onclick = () => { if (page < pages) { page++; load(); } };
      }).catch((e) => {
        $('#__oihRejBody').innerHTML = `<div style="padding:30px;text-align:center;color:#f56c6c;">❌ 加载失败：${esc(e.message)}</div>`;
      });
    }
    $('#__oihRejType').onchange = (e) => { curType = e.target.value; page = 1; load(); };
    $('#__oihRejClose').onclick = () => mask.remove();
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    $('#__oihRejDownload').onclick = () => {
      const p = new URLSearchParams();
      if (batchId) p.set('batchId', batchId);
      if (curType !== '全部') p.set('type', curType);
      API.download(API_BASE + '/rejects/export' + (p.toString() ? '?' + p.toString() : ''), '导入异常明细.xlsx')
        .catch((e) => toast('下载失败：' + e.message, 'error'));
    };
    load();
  }

  // 与原地区看板完全相同的颜色映射（保留样式）
  const CLASS_COLOR = {
    '大偏远': { bg: '#fef0f0', text: '#f56c6c', border: '#f56c6c', bar: '#f56c6c', label: '🔴 大偏远' },
    '小偏远': { bg: '#fdf6ec', text: '#e6a23c', border: '#e6a23c', bar: '#e6a23c', label: '🟠 小偏远' },
    '正常': { bg: '#f0f9eb', text: '#67c23a', border: '#67c23a', bar: '#409eff', label: '🔵 正常' },
    '其他': { bg: '#f4f4f5', text: '#909399', border: '#909399', bar: '#909399', label: '⚪ 其他' },
  };

  PAGES.oih_import = function (host) {
    host.innerHTML = '';
    host.style.cssText = 'padding:16px;background:#f5f7fa;min-height:100%;box-sizing:border-box;';
    const wrap = document.createElement('div');
    wrap.style.maxWidth = '1400px'; wrap.style.margin = '0 auto';
    wrap.innerHTML = `
      <div style="display:flex;gap:4px;margin-bottom:16px;">
        <button class="oih-tab" data-tab="import"   style="padding:10px 24px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:14px;">📤 数据导入</button>
        <button class="oih-tab" data-tab="query"    style="padding:10px 24px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:14px;">🔎 集成查询</button>
        <button class="oih-tab" data-tab="dashboard" style="padding:10px 24px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:14px;">📊 地区分析</button>
      </div>
      <div>
        <div class="oih-panel" data-panel="import"    style="display:none;"></div>
        <div class="oih-panel" data-panel="query"     style="display:none;"></div>
        <div class="oih-panel" data-panel="dashboard" style="display:none;"></div>
      </div>`;
    host.appendChild(wrap);

    const tabs = wrap.querySelectorAll('.oih-tab');
    const panels = wrap.querySelectorAll('.oih-panel');
    const mounted = {};
    function switchTab(name) {
      tabs.forEach((t) => {
        const on = t.dataset.tab === name;
        t.style.background = on ? '#409eff' : '#e4e7ed';
        t.style.color = on ? '#fff' : '#606266';
        t.style.fontWeight = on ? '600' : '400';
      });
      panels.forEach((p) => { p.style.display = p.dataset.panel === name ? 'block' : 'none'; });
      if (!mounted[name]) {
        const fn = { import: mountImport, query: mountQuery, dashboard: mountDashboard }[name];
        if (fn) { fn(wrap.querySelector(`[data-panel="${name}"]`)); mounted[name] = true; }
      }
    }
    tabs.forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
    switchTab('import');
  };

  // =========================================================================
  // Tab 1: 数据导入（多 Sheet 工作簿，自适应分流）
  // =========================================================================
  function mountImport(panel) {
    panel.innerHTML = `
      <div style="${CARD_CSS}">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
          <div>
            <h3 style="margin:0;font-size:16px;color:#303133;">📤 上传订单数据表</h3>
            <div style="font-size:12px;color:#909399;margin-top:4px;">支持一个工作簿多个 Sheet（每个 Sheet 一个平台），自动识别表头并分流；数据仅用于本模块分析，与其他业务数据无关。</div>
          </div>
          <button id="oihClearAll" style="${BTN_GHOST};border-color:#f56c6c;color:#f56c6c;">🗑 清空全部导入数据</button>
        </div>
        <div id="oihDrop" style="border:2px dashed #c0ccda;border-radius:8px;padding:36px;text-align:center;cursor:pointer;background:#fafafa;transition:border-color .15s,background .15s;">
          <div style="font-size:44px;color:#909399;margin-bottom:8px;">📁</div>
          <div style="font-size:15px;color:#606266;">点击选择 Excel 文件，或将文件拖拽到此处</div>
          <div style="font-size:12px;color:#909399;margin-top:6px;">支持 .xlsx / .xls，单文件最大 200MB；大文件请耐心等待</div>
          <input type="file" id="oihFile" accept=".xlsx,.xls" style="display:none;">
        </div>
        <div id="oihImportResult" style="margin-top:14px;"></div>
      </div>
      <div style="${CARD_CSS}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="margin:0;font-size:16px;color:#303133;">📋 导入批次记录</h3>
          <button id="oihRefreshBatches" style="${BTN_GHOST}">🔄 刷新</button>
        </div>
        <div id="oihBatches" style="overflow:auto;"></div>
        <div style="font-size:12px;color:#909399;margin-top:8px;">每个批次可单独删除；也可一键清空全部数据。删除只影响本模块，不影响系统其他业务数据。</div>
      </div>`;

    const $ = (s) => panel.querySelector(s);
    const fileInput = $('#oihFile');
    const drop = $('#oihDrop');
    drop.onclick = () => fileInput.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = '#409eff'; drop.style.background = '#f4f8ff'; };
    drop.ondragleave = () => { drop.style.borderColor = '#c0ccda'; drop.style.background = '#fafafa'; };
    drop.ondrop = (e) => {
      e.preventDefault(); drop.style.borderColor = '#c0ccda'; drop.style.background = '#fafafa';
      if (e.dataTransfer.files && e.dataTransfer.files[0]) doUpload(e.dataTransfer.files[0]);
    };
    fileInput.onchange = () => { if (fileInput.files && fileInput.files[0]) doUpload(fileInput.files[0]); };

    const CHUNK_SIZE = 6 * 1024 * 1024;  // 每片 6MB（低于后端 8MB 上限，且远低于网关限制）

    function renderImportResult(r) {
      const result = $('#oihImportResult');
      const sheets = (r.sheets || []).map((s) => `
        <tr>
          <td style="padding:6px 8px;border:1px solid #ebeef5;">${esc(s.sheet)}</td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;">${esc(s.platform)}</td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:center;">${s.detectedColumns}</td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:right;">${s.total.toLocaleString()}</td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:right;color:#67c23a;">${s.inserted.toLocaleString()}</td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:right;color:#909399;">${(s.filtered || 0).toLocaleString()}</td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:right;color:#e6a23c;">${s.skipped.toLocaleString()}</td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:right;color:#f56c6c;">${s.failed.toLocaleString()}</td>
        </tr>`).join('');
      const notImported = (r.skipped || 0) + (r.failed || 0) + (r.filtered || 0);
      result.innerHTML = `
        <div style="padding:12px 16px;background:#f0f9eb;border-left:4px solid #67c23a;border-radius:6px;margin-bottom:12px;">
          ✅ 导入完成：共 <b>${r.total.toLocaleString()}</b> 行，成功 <b style="color:#67c23a;">${r.inserted.toLocaleString()}</b>，
          过滤(不符合统计条件) <b style="color:#909399;">${r.filtered || 0}</b>，
          跳过(重复) <b style="color:#e6a23c;">${r.skipped.toLocaleString()}</b>，失败 <b style="color:#f56c6c;">${r.failed.toLocaleString()}</b>，
          耗时 ${(r.elapsedMs / 1000).toFixed(1)}s
          ${notImported > 0 ? `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #c0c4cc;">
            ⚠️ 有 ${notImported.toLocaleString()} 行未导入，
            <a href="javascript:;" id="oihViewRejects" style="color:#409eff;font-weight:600;text-decoration:underline;">点击查看未导入原因（可下载明细）</a>
          </div>` : ''}
        </div>
        <div style="overflow:auto;border:1px solid #ebeef5;border-radius:6px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#f5f7fa;">
          <th style="padding:7px 8px;border:1px solid #ebeef5;">Sheet</th><th style="padding:7px 8px;border:1px solid #ebeef5;">识别平台</th>
          <th style="padding:7px 8px;border:1px solid #ebeef5;">识别字段数</th><th style="padding:7px 8px;border:1px solid #ebeef5;">总行</th>
          <th style="padding:7px 8px;border:1px solid #ebeef5;">成功</th><th style="padding:7px 8px;border:1px solid #ebeef5;">过滤</th>
          <th style="padding:7px 8px;border:1px solid #ebeef5;">跳过</th><th style="padding:7px 8px;border:1px solid #ebeef5;">失败</th>
        </tr></thead><tbody>${sheets}</tbody></table></div>`;
      const viewLink = result.querySelector('#oihViewRejects');
      if (viewLink) viewLink.onclick = () => openRejectsModal(r.batchId);
      loadBatches();
      toast('导入完成：成功 ' + r.inserted + ' 行', 'success');
    }

    function showProgress(pct, text) {
      $('#oihImportResult').innerHTML = `
        <div style="padding:16px 18px;background:#f4f8ff;border-radius:8px;border:1px solid #d9e8ff;">
          <div style="font-size:13px;color:#409eff;margin-bottom:8px;">${text}</div>
          <div style="height:10px;background:#e4ecfa;border-radius:5px;overflow:hidden;">
            <div style="height:100%;width:${pct.toFixed(1)}%;background:linear-gradient(90deg,#409eff,#67c23a);border-radius:5px;transition:width .2s;"></div>
          </div>
          <div style="font-size:12px;color:#909399;margin-top:6px;text-align:right;">${pct.toFixed(0)}%</div>
        </div>`;
    }

    // 分片上传：每片单独请求，绕过网关请求体大小限制
    async function uploadChunked(file) {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const init = await API.post(API_BASE + '/upload/init', {
        fileName: file.name, fileSize: file.size, totalChunks: totalChunks,
      });
      const uploadId = init.uploadId;
      let uploaded = 0;
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const blob = file.slice(start, end);
        const fd = new FormData();
        fd.append('uploadId', uploadId);
        fd.append('idx', String(i));
        fd.append('chunk', blob, 'chunk-' + i);
        // 单片上传失败时重试 2 次（网络抖动/网关瞬断）
        let ok = false, lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await API.upload(API_BASE + '/upload/chunk', fd); ok = true; break; }
          catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); }
        }
        if (!ok) throw new Error(`第 ${i + 1}/${totalChunks} 片上传失败：${lastErr.message}`);
        uploaded++;
        showProgress((uploaded / totalChunks) * 90,
          `📤 已上传 ${uploaded}/${totalChunks} 片（${(end / 1048576).toFixed(1)}/${(file.size / 1048576).toFixed(1)}MB）`);
      }
      showProgress(92, '⏳ 分片已全部上传，服务端正在合并并解析导入…');
      const r = await API.post(API_BASE + '/upload/finish', { uploadId: uploadId });
      return r;
    }

    function doUpload(file) {
      if (!/\.(xlsx|xls)$/i.test(file.name)) { toast('请选择 .xlsx 或 .xls 文件', 'error'); return; }
      const isLarge = file.size > CHUNK_SIZE;
      showProgress(2, isLarge
        ? `📦 文件 ${(file.size / 1048576).toFixed(1)}MB 较大，启用分片上传以保护连接…`
        : `⏳ 正在上传并解析 ${esc(file.name)}…`);

      // ★ 进入关键操作保护期：导入期间禁止 401 强制跳登录 / 版本更新强制刷新，
      //   避免点页面其他位置误触确认框导致强制退出、导入中断。
      API.setBusy(true);
      const task = isLarge ? uploadChunked(file)
        : API.upload(API_BASE + '/import', (() => { const fd = new FormData(); fd.append('file', file); return fd; })());

      task.then((r) => { renderImportResult(r); })
        .catch((e) => {
          $('#oihImportResult').innerHTML = `<div style="padding:16px;color:#f56c6c;background:#fef0f0;border-radius:6px;">❌ 导入失败：${esc(e.message)}<br><span style="font-size:12px;color:#909399;">大文件走分片上传；若仍失败，请检查网络或把文件拆成多个小文件重试。</span></div>`;
        })
        .finally(() => { API.setBusy(false); });
    }

    function loadBatches() {
      API.get(API_BASE + '/meta').then((data) => {
        const list = data.batches || [];
        if (!list.length) { $('#oihBatches').innerHTML = '<div style="padding:28px;text-align:center;color:#909399;">📭 暂无导入记录，请先上传数据表</div>'; return; }
        $('#oihBatches').innerHTML = `
          <div style="overflow:auto;border:1px solid #ebeef5;border-radius:6px;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#f5f7fa;">
            <th style="padding:7px 8px;border:1px solid #ebeef5;">批次</th><th style="padding:7px 8px;border:1px solid #ebeef5;">文件</th>
            <th style="padding:7px 8px;border:1px solid #ebeef5;">平台数</th><th style="padding:7px 8px;border:1px solid #ebeef5;">总行</th>
            <th style="padding:7px 8px;border:1px solid #ebeef5;">成功</th><th style="padding:7px 8px;border:1px solid #ebeef5;">跳过/失败</th>
            <th style="padding:7px 8px;border:1px solid #ebeef5;">状态</th><th style="padding:7px 8px;border:1px solid #ebeef5;">操作人</th>
            <th style="padding:7px 8px;border:1px solid #ebeef5;">时间</th><th style="padding:7px 8px;border:1px solid #ebeef5;">操作</th>
          </tr></thead><tbody>${list.map((b) => {
            const rejectTotal = (b.reject_duplicate || 0) + (b.reject_failed || 0);
            return `
            <tr style="border-bottom:1px solid #ebeef5;">
              <td style="padding:6px 8px;border:1px solid #ebeef5;">#${b.batch_id}</td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(b.file_name)}">${esc(b.file_name)}</td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:center;">${b.platform_count}</td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:right;">${b.total_rows.toLocaleString()}</td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:right;color:#67c23a;">${b.inserted_rows.toLocaleString()}</td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:right;color:${rejectTotal ? '#e6a23c' : '#909399'};">
                ${rejectTotal ? `<a href="javascript:;" class="oih-view-rejects" data-id="${b.batch_id}" style="color:#e6a23c;font-weight:600;text-decoration:underline;">${rejectTotal.toLocaleString()} 条 ▸</a>` : '0'}
              </td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:center;">${b.status === 'done' ? '✅ 完成' : esc(b.status)}</td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;">${esc(b.operator || '')}</td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;font-size:12px;">${esc(b.created_at)}</td>
              <td style="padding:6px 8px;border:1px solid #ebeef5;white-space:nowrap;">
                ${rejectTotal ? `<button class="oih-view-rejects" data-id="${b.batch_id}" style="background:#e6a23c;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;">异常</button> ` : ''}
                <button class="oih-del-batch" data-id="${b.batch_id}" style="background:#f56c6c;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;">删除</button>
              </td>
            </tr>`;
          }).join('')}</tbody></table></div>`;
        panel.querySelectorAll('.oih-del-batch').forEach((btn) => {
          btn.onclick = () => {
            if (!confirm('确定删除该批次的所有导入数据吗？（含异常明细）')) return;
            API.del(API_BASE + '/batch/' + btn.dataset.id).then(() => { toast('批次已删除', 'success'); loadBatches(); })
              .catch((e) => toast('删除失败：' + e.message, 'error'));
          };
        });
        panel.querySelectorAll('.oih-view-rejects').forEach((btn) => {
          btn.onclick = () => openRejectsModal(btn.dataset.id);
        });
      }).catch(() => {});
    }
    $('#oihRefreshBatches').onclick = loadBatches;
    $('#oihClearAll').onclick = () => {
      if (!confirm('⚠️ 确定清空全部导入数据吗？此操作只影响本模块，不可恢复！')) return;
      API.del(API_BASE + '/all').then((r) => {
        toast(`已清空 ${r.deletedRows.toLocaleString()} 行数据`, 'success');
        loadBatches();
        $('#oihImportResult').innerHTML = '';
      }).catch((e) => toast('清空失败：' + e.message, 'error'));
    };
    loadBatches();
  }

  // =========================================================================
  // Tab 2: 集成查询（按快递单号快速定位货主及订单信息）
  // =========================================================================
  function mountQuery(panel) {
    panel.innerHTML = `
      <div style="${CARD_CSS}">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
          <h3 style="margin:0;font-size:16px;color:#303133;">🔎 订单集成查询</h3>
          <span style="color:#909399;font-size:12px;">填写快递单号时自动忽略日期；支持多个单号（逗号/空格分隔）</span>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">
          <input id="oihQ" placeholder="快递单号（多个用逗号/空格分隔）" style="padding:7px 10px;border:1px solid #dcdfe6;border-radius:4px;width:280px;font-size:13px;font-family:monospace;">
          <select id="oihQOwner" style="padding:6px 8px;border:1px solid #dcdfe6;border-radius:4px;min-width:130px;font-size:13px;"><option value="">货主 - 全部</option></select>
          <select id="oihQPlatform" style="padding:6px 8px;border:1px solid #dcdfe6;border-radius:4px;min-width:110px;font-size:13px;"><option value="">平台 - 全部</option></select>
          <select id="oihQCarrier" style="padding:6px 8px;border:1px solid #dcdfe6;border-radius:4px;min-width:120px;font-size:13px;"><option value="">快递公司 - 全部</option></select>
          <select id="oihQRegion" style="padding:6px 8px;border:1px solid #dcdfe6;border-radius:4px;min-width:110px;font-size:13px;">
            <option value="">地区分类 - 全部</option><option value="大偏远">大偏远</option><option value="小偏远">小偏远</option><option value="正常">正常</option><option value="其他">其他</option>
          </select>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;color:#606266;"><input id="oihQShentong" type="checkbox" checked> 仅申通</label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">日期 <input id="oihQStart" type="date" style="padding:5px;border:1px solid #dcdfe6;border-radius:4px;"> ~ <input id="oihQEnd" type="date" style="padding:5px;border:1px solid #dcdfe6;border-radius:4px;"></label>
          <button id="oihQBtn" style="${BTN_PRIMARY}">🔍 查询</button>
          <button id="oihQExport" style="${BTN_GHOST}">⬇ 导出</button>
        </div>
        <div id="oihQResult"></div>
      </div>`;
    const $ = (s) => panel.querySelector(s);
    let page = 1, pageSize = 50, total = 0;

    API.get(API_BASE + '/meta').then((d) => {
      const fill = (sel, list) => {
        const el = $(sel);
        (list || []).forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o); });
      };
      fill('#oihQOwner', d.owners); fill('#oihQPlatform', d.platforms); fill('#oihQCarrier', d.carriers);
    }).catch(() => {});

    function params() {
      const p = new URLSearchParams();
      const put = (k, v) => { if (v && v !== '全部') p.set(k, v); };
      put('q', $('#oihQ').value.trim());
      put('owner', $('#oihQOwner').value);
      put('platform', $('#oihQPlatform').value);
      put('carrier', $('#oihQCarrier').value);
      put('region', $('#oihQRegion').value);
      p.set('shentongOnly', $('#oihQShentong').checked ? '1' : '0');
      // 单号非空时不带日期（后端也会忽略）
      if (!$('#oihQ').value.trim()) { put('start', $('#oihQStart').value); put('end', $('#oihQEnd').value); }
      return p;
    }
    function doQuery() {
      const p = params(); p.set('page', page); p.set('pageSize', pageSize);
      $('#oihQResult').innerHTML = '<div style="padding:24px;text-align:center;color:#909399;">⏳ 查询中…</div>';
      API.get(API_BASE + '/query?' + p.toString()).then((data) => {
        total = data.total;
        const rows = data.rows || [];
        if (!rows.length) {
          $('#oihQResult').innerHTML = '<div style="padding:32px;text-align:center;color:#909399;border:1px dashed #dcdfe6;border-radius:6px;">📭 没有符合条件的订单数据</div>';
          return;
        }
        const body = rows.map((r) => {
          const c = CLASS_COLOR[r.region_class] || CLASS_COLOR['其他'];
          return `<tr style="border-bottom:1px solid #ebeef5;">
            <td style="padding:6px;border:1px solid #ebeef5;font-family:monospace;font-size:12px;">${esc(r.waybill_no || '-')}</td>
            <td style="padding:6px;border:1px solid #ebeef5;font-size:13px;font-weight:600;color:#409eff;">${esc(r.owner_name || '-')}</td>
            <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;">${esc(r.shop_name || '-')}</td>
            <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;">${esc(r.platform || '-')}</td>
            <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;">${esc(r.carrier || '-')}</td>
            <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;">${esc(r.order_date || '-')}</td>
            <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;">${esc([r.to_province, r.to_city, r.to_district].filter(Boolean).join(' ') || '-')}</td>
            <td style="padding:6px;border:1px solid #ebeef5;font-size:12px;text-align:center;">
              <span style="padding:2px 8px;border-radius:3px;background:${c.bg};color:${c.text};border:1px solid ${c.border};font-size:12px;">${esc(r.region_class || '其他')}</span>
            </td>
          </tr>`;
        }).join('');
        const pages = Math.max(1, Math.ceil(total / pageSize));
        $('#oihQResult').innerHTML = `
          ${data.dateIgnored ? '<div style="margin-bottom:8px;padding:8px 12px;background:#fdf6ec;border-left:3px solid #e6a23c;border-radius:4px;font-size:12px;color:#e6a23c;">⚡ 已按快递单号检索，日期条件已自动忽略</div>' : ''}
          <div style="max-height:560px;overflow:auto;border:1px solid #ebeef5;border-radius:6px;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="position:sticky;top:0;background:#f5f7fa;z-index:1;">
              <th style="padding:7px;border:1px solid #ebeef5;">快递单号</th><th style="padding:7px;border:1px solid #ebeef5;">货主</th>
              <th style="padding:7px;border:1px solid #ebeef5;">店铺</th><th style="padding:7px;border:1px solid #ebeef5;">平台</th>
              <th style="padding:7px;border:1px solid #ebeef5;">快递公司</th><th style="padding:7px;border:1px solid #ebeef5;">日期</th>
              <th style="padding:7px;border:1px solid #ebeef5;">收件地区</th><th style="padding:7px;border:1px solid #ebeef5;">分类</th>
            </tr></thead><tbody>${body}</tbody></table>
          </div>
          <div style="margin-top:10px;display:flex;align-items:center;gap:10px;font-size:13px;color:#606266;justify-content:flex-end;">
            <span>共 <b>${total.toLocaleString()}</b> 条</span>
            <select id="oihPageSize" style="padding:4px 6px;border:1px solid #dcdfe6;border-radius:4px;">
              ${[20, 50, 100, 200].map((n) => `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n} 条/页</option>`).join('')}
            </select>
            <button id="oihPrev" style="padding:4px 12px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;cursor:pointer;" ${page <= 1 ? 'disabled' : ''}>上一页</button>
            <span>第 ${page} / ${pages} 页</span>
            <button id="oihNext" style="padding:4px 12px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;cursor:pointer;" ${page >= pages ? 'disabled' : ''}>下一页</button>
            <span style="margin-left:6px;">跳至</span>
            <input id="oihJumpPage" type="number" min="1" max="${pages}" value="${page}" style="width:60px;padding:4px 6px;border:1px solid #dcdfe6;border-radius:4px;text-align:center;">
            <span>页</span>
            <button id="oihJumpBtn" style="padding:4px 12px;border:1px solid #409eff;border-radius:4px;background:#409eff;color:#fff;cursor:pointer;">确定</button>
          </div>`;
        $('#oihPageSize').onchange = (e) => { pageSize = Number(e.target.value); page = 1; doQuery(); };
        $('#oihPrev').onclick = () => { if (page > 1) { page--; doQuery(); } };
        $('#oihNext').onclick = () => { if (page < pages) { page++; doQuery(); } };
        function jumpPage() {
          const target = Number($('#oihJumpPage').value);
          if (!Number.isInteger(target) || target < 1 || target > pages) {
            toast(`请输入 1 到 ${pages} 之间的页码`, 'error'); return;
          }
          if (target !== page) { page = target; doQuery(); }
        }
        $('#oihJumpBtn').onclick = jumpPage;
        $('#oihJumpPage').onkeydown = (e) => { if (e.key === 'Enter') jumpPage(); };
      }).catch((e) => {
        $('#oihQResult').innerHTML = `<div style="padding:24px;text-align:center;color:#f56c6c;">❌ 查询失败：${esc(e.message)}</div>`;
      });
    }
    $('#oihQBtn').onclick = () => { page = 1; doQuery(); };
    $('#oihQ').onkeydown = (e) => { if (e.key === 'Enter') { page = 1; doQuery(); } };
    $('#oihQExport').onclick = () => {
      API.download(API_BASE + '/export?' + params().toString(), '订单导入查询.xlsx')
        .catch((e) => toast('导出失败：' + e.message, 'error'));
    };
    doQuery();
  }

  // =========================================================================
  // Tab 3: 地区分析（保留【各地区累计分布】样式）
  // =========================================================================
  let dashCache = null;
  function mountDashboard(panel) {
    const today = new Date();
    const thisMonth = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
    panel.innerHTML = `
      <div style="${CARD_CSS}">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
          <div>
            <h3 style="margin:0;font-size:16px;color:#303133;">📊 申通地区分类分析</h3>
            <div style="font-size:12px;color:#909399;margin-top:4px;">仅统计导入数据中申通快递的订单（大偏远 / 小偏远 / 正常）</div>
          </div>
          <button id="oihDashExport" style="${BTN_GHOST}">⬇ 导出明细</button>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:16px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">月份 <input id="oihDashMonth" type="month" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;" value="${thisMonth}"></label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;">平台 <select id="oihDashPlatform" style="padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;"><option value="全部">全部</option></select></label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#606266;"><input id="oihDashShentong" type="checkbox" checked> 仅申通</label>
          <button id="oihDashQuery" style="${BTN_PRIMARY}">🔍 查询</button>
          <button id="oihDashReset" style="${BTN_GHOST}">↺ 重置</button>
        </div>
        <div id="oihDashCards"></div>
        <div id="oihDashProvince"></div>
      </div>`;

    const $ = (s) => panel.querySelector(s);
    API.get(API_BASE + '/meta').then((d) => {
      const sel = $('#oihDashPlatform');
      (d.platforms || []).forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
    }).catch(() => {});

    function params() {
      const month = $('#oihDashMonth').value || '';
      const p = new URLSearchParams();
      if (month) {
        p.set('start', month + '-01');
        const [y, m] = month.split('-').map(Number);
        p.set('end', month + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0'));
      }
      const platform = $('#oihDashPlatform').value;
      if (platform && platform !== '全部') p.set('platform', platform);
      p.set('shentongOnly', $('#oihDashShentong').checked ? '1' : '0');
      return p;
    }
    function load() {
      $('#oihDashCards').innerHTML = '<div style="padding:20px;text-align:center;color:#909399;">⏳ 加载中…</div>';
      $('#oihDashProvince').innerHTML = '';
      API.get(API_BASE + '/dashboard?' + params().toString()).then((data) => {
        dashCache = data; render(data);
      }).catch((e) => {
        $('#oihDashCards').innerHTML = `<div style="padding:20px;text-align:center;color:#f56c6c;">❌ 加载失败：${esc(e.message)}</div>`;
      });
    }
    function render(data) {
      const { by_class, total, remote_total, by_class_province } = data;
      const pct = (n) => total ? ((n * 100) / total).toFixed(1) + '%' : '0%';
      const classList = ['大偏远', '小偏远', '正常'];
      if ((by_class['其他'] || 0) > 0) classList.push('其他');
      $('#oihDashCards').innerHTML = `
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          ${classList.map((c) => {
            const col = CLASS_COLOR[c];
            return `<div style="flex:1;min-width:180px;padding:16px;border-radius:8px;background:${col.bg};border-left:4px solid ${col.border};">
              <div style="color:${col.text};font-size:13px;font-weight:600;margin-bottom:6px;">${col.label}</div>
              <div style="font-size:22px;font-weight:700;color:#303133;">${(by_class[c] || 0).toLocaleString()}</div>
              <div style="font-size:12px;color:#909399;margin-top:4px;">占比 ${pct(by_class[c] || 0)}</div>
            </div>`;
          }).join('')}
        </div>
        <div style="margin-top:12px;padding:12px 16px;background:#ecf5ff;border-radius:6px;border-left:4px solid #409eff;">
          📦 <b>偏远地区合计</b>（大偏远 + 小偏远）：${(remote_total || 0).toLocaleString()} 单 · 占比 <b style="color:#e6a23c;">${pct(remote_total || 0)}</b> · 总订单：<b>${(total || 0).toLocaleString()}</b> 单
        </div>`;

      // ★ 以下结构与原 orders-module.js:954–1013 完全一致（保留【各地区累计分布】样式）
      const groupTitle = { '大偏远': '大偏远', '小偏远': '小偏远', '正常': '正常地区' };
      const buildGroup = (clsName) => {
        const color = CLASS_COLOR[clsName];
        const list = (by_class_province && by_class_province[clsName]) || [];
        const groupTotal = list.reduce((s, x) => s + x.count, 0);
        const max = list.length ? Math.max(...list.map((x) => x.count)) : 0;
        const rows = list.map((p, idx) => {
          const w = max ? (p.count / max) * 100 : 0;
          return `<div class="od-region-row">
            <div class="od-region-rank">${idx + 1}</div>
            <span class="od-region-dot" style="background:${color.bar};"></span>
            <div class="od-region-name" title="${esc(p.province)}">${esc(p.province)}</div>
            <div class="od-region-track"><div class="od-region-fill" style="width:${Math.max(w, 1).toFixed(1)}%;background:${color.bar};"></div></div>
            <div class="od-region-val">${p.count.toLocaleString()}</div>
            <div class="od-region-pct">${(p.pct || 0).toFixed(2)}%</div>
          </div>`;
        }).join('');
        const totalPct = total ? ((groupTotal * 100) / total).toFixed(2) : '0.00';
        return `<div>
          <div class="od-region-group-title" style="color:${color.text};">${groupTitle[clsName]}</div>
          ${list.length ? rows : '<div class="od-region-empty">暂无订单</div>'}
          <div class="od-region-row total">
            <div class="od-region-rank"></div>
            <span class="od-region-dot" style="background:${color.bar};"></span>
            <div class="od-region-name">合计</div>
            <div class="od-region-track"><div class="od-region-fill" style="width:100%;background:${color.bar};"></div></div>
            <div class="od-region-val">${groupTotal.toLocaleString()}</div>
            <div class="od-region-pct">${totalPct}%</div>
          </div>
        </div>`;
      };
      const legend = ['大偏远', '小偏远', '正常'].map((c) =>
        `<span class="od-region-legend-item"><span class="od-region-legend-dot" style="background:${CLASS_COLOR[c].bar};"></span>${groupTitle[c]}</span>`
      ).join('');
      $('#oihDashProvince').innerHTML = `
        <div class="od-region-dist">
          <div class="od-region-dist-head">
            <h4 class="od-region-dist-title">各地区累计分布</h4>
            <div class="od-region-legend">${legend}</div>
          </div>
          <div class="od-region-grid">
            <div class="od-region-col left">${buildGroup('小偏远')}${buildGroup('大偏远')}</div>
            <div class="od-region-col right">${buildGroup('正常')}</div>
          </div>
        </div>`;
    }
    $('#oihDashQuery').onclick = load;
    $('#oihDashReset').onclick = () => {
      $('#oihDashMonth').value = thisMonth; $('#oihDashPlatform').value = '全部'; $('#oihDashShentong').checked = true; load();
    };
    $('#oihDashExport').onclick = () => {
      API.download(API_BASE + '/export?' + params().toString(), '地区分析明细.xlsx')
        .catch((e) => toast('导出失败：' + e.message, 'error'));
    };
    load();
  }
})();
