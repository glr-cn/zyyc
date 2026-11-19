// ---------- 第三方库懒加载 ----------
// SheetJS (xlsx) / html-to-image：430KB / 60KB，首屏不需要
// 只有用户触发"下载 Excel 模板 / 导入 Excel / 导出看板为图片"时才加载
// 用法示例：await ERP.ensureXlsx(); const XLSX = window.XLSX;
(function () {
  const _promises = {};  // 已加载 / 加载中 Promise，避免重复注入

  function _loadScript(src, exportName) {
    if (_promises[src]) return _promises[src];  // 幂等
    _promises[src] = new Promise((resolve, reject) => {
      // 已经在 DOM 里了 → 直接 resolve
      const existing = document.querySelector(`script[data-src="${src}"]`);
      if (existing && window[exportName]) { resolve(window[exportName]); return; }
      const el = document.createElement('script');
      el.src = src;
      el.dataset.src = src;
      el.async = true;  // 异步注入，不阻塞后续脚本
      el.onload = () => resolve(window[exportName]);
      el.onerror = () => reject(new Error('加载失败：' + src));
      document.head.appendChild(el);
    });
    return _promises[src];
  }

  window.ERP = window.ERP || {};
  ERP.ensureXlsx = () => _loadScript(
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'XLSX');
  ERP.ensureHtmlToImage = () => _loadScript(
    'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js', 'htmlToImage');
})();
