// ============================================================
//  快捷工具 → 条码设计（内置 ZPLab）
//  ------------------------------------------------------------
//  2026-11 起，自研 tools-barcode.js 已由 vendored ZPLab 取代：
//    - 构建产物：public/zplab/（Vite base = /zplab/）
//    - 上游项目：https://github.com/u8array/ZPLab（MIT）
//  本文件只负责在 ERP 页面容器内挂载全屏 iframe；
//  菜单、权限、Tab 标题与路由仍由 menus / tabs.js 管理，保持不变。
// ============================================================
(function () {
  const PAGE = 'tool_barcode';
  const SRC = 'zplab/index.html';

  function mount(host) {
    host.innerHTML =
      '<div class="zplab-wrap">' +
        '<iframe class="zplab-frame" src="' + SRC + '" title="条码设计 · ZPLab" ' +
        'allow="clipboard-read; clipboard-write"></iframe>' +
      '</div>';
  }

  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES[PAGE] = mount;
})();
