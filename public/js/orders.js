// 订单导入页（阶段 2）：订单 Excel 导入 + 期初库存导入 + 失败清单 + 模板下载
window.ERP_PAGES = window.ERP_PAGES || {};
window.ERP_PAGES.orders = function (host) {
  const c = host;
  const $ = (id) => c.querySelector("#" + id);
  c.innerHTML = `
    <h3>订单 Excel 导入</h3>
    <div class="card">
      <p class="hint">模板字段（首行表头）：<b>订单号、客户名称、货主名称、发货量、单位、订单日期</b>。校验失败的行进入下方失败清单，不会静默丢弃。</p>
      <button id="dlOrderTpl" class="primary">下载订单模板</button>
      <div class="upload-row">
        <input type="file" id="orderFile" accept=".xlsx,.xls">
        <button id="upOrder" class="primary">上传并导入</button>
      </div>
      <div id="orderResult"></div>
    </div>

    <h3 style="margin-top:24px">期初库存导入</h3>
    <div class="card">
      <p class="hint">模板字段（首行表头）：<b>货主名称、数量、业务日期、备注（选填）</b>。导入后生成 initial 入库流水。</p>
      <button id="dlInitTpl" class="primary">下载期初模板</button>
      <div class="upload-row">
        <input type="file" id="initFile" accept=".xlsx,.xls">
        <button id="upInit" class="primary">上传并导入</button>
      </div>
      <div id="initResult"></div>
    </div>`;

  $('dlOrderTpl').onclick = () =>
    downloadCSV('订单导入模板.csv', ['订单号', '客户名称', '货主名称', '发货量', '单位', '订单日期'], []);
  $('dlInitTpl').onclick = () =>
    downloadCSV('期初库存模板.csv', ['货主名称', '数量', '业务日期', '备注'], []);
  $('upOrder').onclick = () =>
    uploadExcel('/orders/import', 'orderFile', 'orderResult', c);
  $('upInit').onclick = () =>
    uploadExcel('/inventory/import-initial', 'initFile', 'initResult', c);
};

// host：当前页签的视图容器（keep-alive 下按容器作用域查找元素，避免跨页 ID 冲突）
function uploadExcel(url, fileId, resultId, host) {
  const file = host.querySelector('#' + fileId).files[0];
  const box = host.querySelector('#' + resultId);
  if (!file) {
    box.innerHTML = '<div class="err">请先选择 Excel 文件</div>';
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  box.innerHTML = '<div class="hint">导入中…</div>';
  fetch('/api' + url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + API.token },
    body: fd,
  })
    .then((r) => r.json().then((d) => ({ r, d })))
    .then(({ r, d }) => {
      if (!r.ok) {
        box.innerHTML = '<div class="err">' + escapeHtml(d.error || '导入失败') + '</div>';
        return;
      }
      let html = `<div class="ok">成功导入 <b>${d.success}</b> 条；失败 <b>${d.failed}</b> 条。</div>`;
      if (d.failures && d.failures.length) {
        html +=
          '<table class="grid"><thead><tr><th>原始行号</th><th>失败原因</th><th>原始数据</th></tr></thead><tbody>';
        d.failures.forEach((f) => {
          html += `<tr><td>${f.row}</td><td>${escapeHtml(f.reason)}</td><td class="num">${escapeHtml(
            JSON.stringify(f.data)
          )}</td></tr>`;
        });
        html += '</tbody></table>';
      }
      box.innerHTML = html;
    })
    .catch((e) => {
      box.innerHTML = '<div class="err">' + escapeHtml(e.message) + '</div>';
    });
}

function downloadCSV(name, headers, rows) {
  let csv = '﻿' + headers.join(',') + '\n';
  rows.forEach((r) => (csv += r.join(',') + '\n'));
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
