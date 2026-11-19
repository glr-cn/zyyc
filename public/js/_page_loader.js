// ---------- 重页面 JS 懒加载（性能优化）----------
// 原理：28 个 <script> 同步阻塞首屏 → 改为核心脚本加 defer + 重页面脚本在 tabs.open() 首次调用时才注入
// 覆盖：cloud, signoff, customers, orders, inventory, workhours(4仓),
//       charts, analytics, dashboard, users, roles, logistics-quotes,
//       smart-quote, smart-quote-history, tools-*, permission-tree,
//       log-center(6页), data-migration, menu-sort
// 用法：tabs.js open() 里 await ERP.ensurePageScript(pageId)
(function () {
  // pageId → JS 文件（相对路径，挂在 head）
  // 同一文件可能注册多个 pageId（如 customers.js 同时注册 customers/cust_wh/cust_shared/cust_express）
  const MAP = {
    // 看板 + 图表
    dashboard:      'js/dashboard.js',
    // 看板子菜单（工时汇总复用 dashboard.js，快递分析独立文件）
    dash_wh_summary:'js/dashboard.js',
    dash_express:   'js/express-analysis.js',
    // 出库（2026-11-19 已移除：orders/inventory 菜单已删）
    // orders:         'js/orders.js',
    // inventory:      'js/inventory.js',
    // 订单导入 + 数据看板（2026-11-19 新增 · docs/单据 子菜单，共用 orders-module.js）
    order_import:     'js/orders-module.js',
    order_dashboard:  'js/orders-module.js',
    // 工时（4 个仓 pageId 共用同一 workhours.js）
    wh_lh:          'js/workhours.js',
    wh_jx:          'js/workhours.js',
    wh_sy:          'js/workhours.js',
    wh_ky:          'js/workhours.js',
    // 基础资料子页
    customers:      'js/customers.js',
    cust_wh:        'js/customers.js',
    cust_shared:    'js/customers.js',
    cust_express:   'js/customers.js',
    // 工时汇总（用 charts.js 里的图表）
    analytics:      'js/analytics.js',
    // 用户/角色/权限树
    users:          'js/users.js',
    roles:          'js/roles.js',
    // 物流报价
    logi_quotes:    'js/logistics-quotes.js',
    // 智能测算（依赖 smart-quote-history.js）
    smart_quote:    'js/smart-quote.js',
    smart_quote_history: 'js/smart-quote-history.js',
    // 快捷工具
    tool_split_no:  'js/tools-split-no.js',
    tool_barcode:   'js/tools-barcode-embed.js',
    // 日志中心（6 个 pageId 共用 log-center.js）
    log_customer:   'js/log-center.js',
    log_workhours:  'js/log-center.js',
    log_logistics:  'js/log-center.js',
    log_smartquote: 'js/log-center.js',
    log_system:     'js/log-center.js',
    log_all:        'js/log-center.js',
    // 系统专用（仅 super_admin）
    data_migration: 'js/data-migration.js',
    menu_sort:      'js/menu-sort.js',
  };

  // 已加载的脚本文件集合（按文件路径去重，同一文件多 pageId 只加载一次）
  const _loaded = new Set();
  // 加载中的 Promise（避免并发点同一文件时发两次请求）
  const _promises = {};

  window.ERP = window.ERP || {};
  ERP._PAGE_SCRIPT_MAP = MAP;

  // 版本号：配合 Express 静态资源 Cache-Control: public, max-age=86400, immutable
  // 版本不变 → 浏览器 24h disk cache；版本变 → URL 变浏览器自动下载
  const BUILD_VERSION = 'v=6';

  // 返回 Promise：该 page 对应的 JS 文件已注入并执行完毕
  ERP.ensurePageScript = function (pageId) {
    const src = MAP[pageId];
    if (!src) return Promise.resolve();        // 核心脚本（tabs/app/menu/api/auth/drp）不走这里
    if (_loaded.has(src)) return Promise.resolve();
    if (_promises[src]) return _promises[src];  // 加载中，直接复用 Promise

    _promises[src] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src + '?' + BUILD_VERSION;       // ★ 固定版本号 → 浏览器缓存 24h
      el.dataset.pageSrc = src;
      el.async = true;  // 异步注入
      el.onload = () => { _loaded.add(src); resolve(); };
      el.onerror = () => reject(new Error('页面脚本加载失败：' + src));
      document.head.appendChild(el);
    }).finally(() => { delete _promises[src]; });

    return _promises[src];
  };
})();
