// 订单导入页：Excel 模板下载（带必填标红 + 填写说明 sheet）+ 拖拽上传 + 分批校验 + 失败清单
window.ERP_PAGES = window.ERP_PAGES || {};

const TPL_FIELDS_META = [
  { name: '订单号',   required: false },
  { name: '客户名称', required: true },
  { name: '货主名称', required: true },
  { name: '发货量',   required: true },
  { name: '单位',     required: true },
  { name: '订单日期', required: true },
  { name: '付款状态', required: false },
];
const IMPORT_BATCH_LIMIT = 500;

ERP_PAGES.orders = function (host) {
  host.innerHTML = '';
  host.style.cssText = 'padding:20px;background:#f5f7fa;min-height:100%';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:900px;margin:0 auto;';

  // 卡片通用样式
  const card = (title, bodyHTML) => {
    const el = document.createElement('div');
    el.style.cssText = 'background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06);';
    el.innerHTML = `<h3 style="margin:0 0 12px;font-size:16px;color:#303133;">${title}</h3>${bodyHTML}`;
    return el;
  };

  // ---------- 模板下载卡片 ----------
  const tplCard = card(
    '📊 第一步：下载标准导入模板',
    `
    <p style="color:#606266;font-size:13px;margin:0 0 14px;line-height:1.7;">
      模板含 2 个 Sheet：<b>订单导入模板</b>（必填列已用红色加粗表头标注）、<b>填写说明</b>（字段含义/示例/校验规则逐条说明）。
      模板仅保留表头和 1 行示例数据，填写时请覆盖示例行（从第 2 行起填）。
    </p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
      <button id="dlTpl" style="background:#409eff;color:#fff;border:none;padding:8px 20px;border-radius:4px;font-size:13px;cursor:pointer;">⬇️ 下载 orders_import_template.xlsx</button>
      <span style="color:#909399;font-size:12px;">
        必填字段：${TPL_FIELDS_META.filter((f) => f.required).map((f) => `<b style="color:#e74c3c;">${f.name}</b>`).join(' / ')}
        ；可选字段：${TPL_FIELDS_META.filter((f) => !f.required).map((f) => f.name).join(' / ')}
      </span>
    </div>
    `
  );
  wrap.appendChild(tplCard);

  // ---------- 拖拽上传卡片 ----------
  const uploadCard = card(
    '📤 第二步：上传填写好的 Excel 文件',
    `
    <p style="color:#606266;font-size:13px;margin:0 0 12px;line-height:1.7;">
      支持 .xlsx / .xls 格式，单次最多 <b>${IMPORT_BATCH_LIMIT}</b> 行。超过请分批导入或联系管理员。
    </p>
    <div id="dropzone" style="
      border:2px dashed #dcdfe6;border-radius:8px;padding:40px 20px;text-align:center;
      transition:all .2s;background:#fafbfc;cursor:pointer;
      font-size:13px;color:#909399;">
      <div style="font-size:42px;color:#c0c4cc;margin-bottom:8px;">📁</div>
      <div style="font-size:15px;color:#606266;margin-bottom:6px;">拖 Excel 文件到这里，或点击选择文件</div>
      <div>支持 .xlsx / .xls，单次 ≤ ${IMPORT_BATCH_LIMIT} 行</div>
      <input type="file" id="fileInput" accept=".xlsx,.xls" style="display:none;">
    </div>
    <div id="fileInfo" style="display:none;margin-top:12px;padding:10px 14px;background:#f0f9eb;border-radius:4px;font-size:13px;color:#67c23a;"></div>
    <div style="display:flex;gap:10px;margin-top:12px;align-items:center;">
      <button id="btnImport" style="background:#409eff;color:#fff;border:none;padding:8px 22px;border-radius:4px;font-size:13px;cursor:pointer;">🚀 开始导入</button>
      <button id="btnClear" style="background:#fff;border:1px solid #dcdfe6;color:#909399;padding:8px 18px;border-radius:4px;font-size:13px;cursor:pointer;">清除</button>
      <span id="importProgress" style="color:#409eff;font-size:13px;display:none;"></span>
    </div>
    `
  );
  wrap.appendChild(uploadCard);

  // ---------- 结果区 ----------
  const resultCard = card(
    '📋 第三步：导入结果 / 错误清单',
    `<div id="resultArea" style="color:#909399;font-size:13px;padding:20px;text-align:center;">导入完成后结果在此展示</div>`
  );
  wrap.appendChild(resultCard);

  host.appendChild(wrap);

  // ---------- 交互逻辑 ----------
  const $ = (sel, root) => (root || host).querySelector(sel);
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const fileInfo = $('#fileInfo');
  const btnImport = $('#btnImport');
  const btnClear = $('#btnClear');
  const importProgress = $('#importProgress');
  const resultArea = $('#resultArea');

  let selectedFile = null;

  // 模板下载
  $('#dlTpl').onclick = () => {
    window.open('/api/orders/template', '_blank');
  };

  // 点击打开文件选择
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#409eff';
    dropzone.style.background = '#ecf5ff';
    dropzone.querySelector('div:first-child').style.color = '#409eff';
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = '#dcdfe6';
    dropzone.style.background = '#fafbfc';
    dropzone.querySelector('div:first-child').style.color = '#c0c4cc';
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.dispatchEvent(new Event('dragleave'));
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFile(e.dataTransfer.files[0]);
    }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) handleFile(e.target.files[0]);
  });

  function handleFile(file) {
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      alert('仅支持 .xlsx / .xls 文件');
      return;
    }
    selectedFile = file;
    const kb = (file.size / 1024).toFixed(1);
    const mb = (file.size / 1024 / 1024).toFixed(2);
    fileInfo.innerHTML = `✅ 已选择：<b>${escape(file.name)}</b> （${mb > 1 ? mb + ' MB' : kb + ' KB'}）`;
    fileInfo.style.display = '';
  }

  btnClear.onclick = () => {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.style.display = 'none';
    resultArea.innerHTML = '<div style="color:#909399;font-size:13px;padding:20px;text-align:center;">导入完成后结果在此展示</div>';
    importProgress.style.display = 'none';
  };

  btnImport.onclick = async () => {
    if (!selectedFile) {
      alert('请先选择或拖入 Excel 文件');
      return;
    }
    btnImport.disabled = true;
    btnImport.style.opacity = '0.6';
    importProgress.textContent = '⏳ 正在导入…';
    importProgress.style.display = '';

    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      const res = await fetch('/api/orders/import', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (window.API?.token || '') },
        body: fd,
      });
      const data = await res.json();
      renderResult(data);
    } catch (e) {
      resultArea.innerHTML = `<div style="color:#c23a1b;padding:10px;">网络请求失败：${escape(e.message)}</div>`;
    } finally {
      btnImport.disabled = false;
      btnImport.style.opacity = '1';
      importProgress.style.display = 'none';
    }
  };

  function renderResult(data) {
    if (!data || !('success' in data)) {
      resultArea.innerHTML = `<div style="color:#c23a1b;padding:10px;">响应格式异常</div>`;
      return;
    }
    const allOk = data.success > 0 && data.failed === 0;
    const html = [];
    // 汇总卡
    html.push(`
      <div style="display:flex;gap:12px;margin-bottom:14px;">
        <div style="flex:1;background:${allOk ? '#f0f9eb' : '#fdf6ec'};padding:12px;border-radius:4px;text-align:center;">
          <div style="color:#909399;font-size:12px;">成功导入</div>
          <div style="color:${allOk ? '#67c23a' : '#e6a23c'};font-size:22px;font-weight:600;">${data.success}</div>
          <div style="font-size:12px;color:#909399;">条</div>
        </div>
        <div style="flex:1;background:${data.failed > 0 ? '#fef0f0' : '#f0f9eb'};padding:12px;border-radius:4px;text-align:center;">
          <div style="color:#909399;font-size:12px;">校验失败</div>
          <div style="color:${data.failed > 0 ? '#f56c6c' : '#67c23a'};font-size:22px;font-weight:600;">${data.failed}</div>
          <div style="font-size:12px;color:#909399;">条（未入库）</div>
        </div>
        <div style="flex:1;background:#ecf5ff;padding:12px;border-radius:4px;text-align:center;">
          <div style="color:#909399;font-size:12px;">总处理</div>
          <div style="color:#409eff;font-size:22px;font-weight:600;">${data.success + data.failed}</div>
          <div style="font-size:12px;color:#909399;">行</div>
        </div>
      </div>
    `);

    // 错误清单
    if (data.failures && data.failures.length) {
      html.push(`
        <div style="color:#c23a1b;font-size:13px;margin-bottom:8px;">⚠️ 以下 ${data.failures.length} 行校验失败，请对照"原始数据"修正后重新导入：</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="background:#fafafa;color:#606266;">
            <th style="border:1px solid #ebeef5;padding:6px;">行号</th>
            <th style="border:1px solid #ebeef5;padding:6px;">失败原因</th>
            <th style="border:1px solid #ebeef5;padding:6px;">原始数据</th>
          </tr></thead>
          <tbody>
            ${data.failures.map((f) => `
              <tr style="color:#606266;">
                <td style="border:1px solid #ebeef5;padding:6px;text-align:center;color:#f56c6c;font-weight:600;">${f.row}</td>
                <td style="border:1px solid #ebeef5;padding:6px;color:#e6a23c;">${escape(f.reason)}</td>
                <td style="border:1px solid #ebeef5;padding:6px;color:#909399;word-break:break-all;">${escape(JSON.stringify(f.data))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      `);
    } else if (data.success === 0) {
      // 400 + {error, limit, totalRows} 的超上限场景
      if (data.limit) {
        html.push(`<div style="color:#c23a1b;padding:14px;border:1px solid #fbc4c4;border-radius:4px;">${escape(data.error)}<br><br>
          💡 解决办法：用 Excel 分成每批 ≤ ${data.limit} 行的多个文件，分别导入。</div>`);
      } else {
        html.push(`<div style="color:#c23a1b;padding:10px;">${escape(data.error || '导入失败')}</div>`);
      }
    }

    resultArea.innerHTML = html.join('');
  }

  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
};
