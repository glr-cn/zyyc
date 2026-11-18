// ============================================================
//  Mega Menu（左侧导航栏）：数据驱动 + 悬浮飞出面板
//  - 数据结构 ERP.MENU 定义一级菜单 / 分组 / 子项
//  - direct 字段：直达菜单项（无二级子菜单，点击直接进入页面）
//  - renderMenu / openMenu / closeMenu / setActiveMenu 控制交互与高亮
// ============================================================
window.ERP = window.ERP || {};

// ---------- 菜单数据结构（JSON） ----------
// 每项：id 一级标识；label 一级标题；icon 图标；direct 直达页面（可选）；groups 分组数组
// 分组：title 分组标题；icon 图标；items 子菜单（label + page：page 为 null 表示功能建设中）
ERP.MENU = [
  {
    // 看板：置于最顶部，取消二级子菜单，点击直接进入经营看板
    id: 'dashboard', label: '看板', icon: '📉', direct: 'dashboard', groups: [],
  },
  {
    id: 'outbound', label: '出库', icon: '📦',
    groups: [
      { title: '单据', icon: '📄', items: [
        { label: '订单导入', page: 'orders' },
        { label: '出库单', page: null },
      ]},
      { title: '打单', icon: '🖨️', items: [
        { label: '面单打印', page: null },
        { label: '批次打单', page: null },
      ]},
      { title: '拣货', icon: '🛒', items: [
        { label: '拣货任务', page: null },
        { label: '拣货确认', page: null },
      ]},
      { title: '验货', icon: '🔍', items: [
        { label: '验货复核', page: null },
      ]},
      { title: '发货', icon: '🚚', items: [
        { label: '发货交接', page: null },
        { label: '物流跟踪', page: null },
      ]},
      { title: '异常处理', icon: '⚠️', items: [
        { label: '错发漏发', page: null },
        { label: '退货登记', page: null },
      ]},
    ],
  },
  {
    id: 'inbound', label: '入库', icon: '📥',
    groups: [
      { title: '到货', icon: '🚛', items: [
        { label: '到货预报', page: null },
        { label: '到货登记', page: null },
      ]},
      { title: '收货', icon: '📦', items: [
        { label: '收货确认', page: null },
      ]},
      { title: '上架', icon: '🗄️', items: [
        { label: '上架任务', page: null },
        { label: '库位调整', page: null },
      ]},
      { title: '质检', icon: '🔬', items: [
        { label: '入库质检', page: null },
      ]},
      { title: '异常处理', icon: '⚠️', items: [
        { label: '破损登记', page: null },
      ]},
    ],
  },
  {
    id: 'inventory', label: '库存', icon: '📊',
    groups: [
      { title: '库存查询', icon: '🔎', items: [
        { label: '库存台账', page: 'inventory' },
      ]},
      { title: '库存调整', icon: '⚙️', items: [
        { label: '期初导入', page: null },
        { label: '库存盘点', page: null },
      ]},
    ],
  },
  {
    id: 'master', label: '基础资料', icon: '📁',
    groups: [
      { title: '客户', icon: '🏢', items: [
        { label: '仓储客户', page: 'cust_wh' },
        { label: '共享单号', page: 'cust_shared' },
        { label: '快运物流', page: 'cust_express' },
      ]},
      { title: '权限', icon: '🔐', items: [
        { label: '用户管理', page: 'users' },
      ]},
    ],
  },
  {
    id: 'work', label: '工时', icon: '⏱️',
    groups: [
      { title: '录入', icon: '✍️', items: [
        { label: '龙湖仓工时管理', page: 'wh_lh' },
        { label: '佳新仓工时管理', page: 'wh_jx' },
        { label: '速远仓工时管理', page: 'wh_sy' },
        { label: '开元仓工时管理', page: 'wh_ky' },
      ]},
      { title: '汇总', icon: '📈', items: [
        { label: '工时汇总', page: 'analytics' },
      ]},
    ],
  },
  {
    id: 'tools', label: '快捷工具', icon: '🧰',
    groups: [
      { title: '工具', icon: '🧰', items: [
        { label: '分列单号', page: 'tool_split_no' },
        { label: '条码设计', page: 'tool_barcode' },
        { label: '图片转文件', page: null },
      ]},
    ],
  },
];

// ---------- 运行时状态 ----------
ERP._openId = null;       // 当前打开的一级菜单 id
ERP._closeTimer = null;   // 关闭延时定时器
ERP._toastTimer = null;
ERP._MENU_RUNTIME = null; // 登录后由后端权限菜单树驱动（RBAC 动态渲染）

// ---------- 菜单结构版本 / 缓存治理 ----------
// 每次改菜单种子或渲染结构必须 +1；版本变化会清掉历史菜单缓存 + 强制刷新 /auth/me，
// 避免「后端已加菜单、前端仍拿旧数据」导致主菜单静默消失。
ERP.MENU_SCHEMA_VERSION = 7;   // v7 = 「条码设计」页上线（is_built=1）
ERP.MENU_CACHE_PREFIX = /^erp_menu/i;

ERP.clearMenuCache = function () {
  ['localStorage', 'sessionStorage'].forEach((name) => {
    try {
      const store = window[name];
      if (!store) return;
      for (let i = store.length - 1; i >= 0; i--) {
        const key = store.key(i);
        if (key && ERP.MENU_CACHE_PREFIX.test(key)) store.removeItem(key);
      }
    } catch (e) { /* 隐私模式 / 无 storage：忽略 */ }
  });
};

ERP.ensureMenuVersion = function (serverVersion) {
  let store = null;
  try { store = window.localStorage; } catch (e) { /* ignore */ }
  // 无持久化能力（隐私模式 / 测试桩）时直接跳过，避免每次渲染重复输出版本日志
  if (!store) return false;
  const target = String(serverVersion || ERP.MENU_SCHEMA_VERSION);
  let current = null;
  try { current = store.getItem('erp_menu_version'); } catch (e) { /* ignore */ }
  if (current === target) return false;
  ERP.clearMenuCache();
  try { store.setItem('erp_menu_version', target); } catch (e) { /* ignore */ }
  console.info('[menu] 菜单结构版本 ' + (current || '无') + ' → ' + target + '，已清理菜单缓存并强制刷新');
  return true;
};

// 后端 /auth/me 的 menus 必须规范成数组；兼容 {data:[...]}、null 等异常形态，
// 避免 forEach 报错导致整个左侧菜单渲染中断（控制台红色报错即来自此类情况）。
const LOG_CHILDREN = [
  { path: 'log_customer', title: '客户资料日志', group: '业务日志' },
  { path: 'log_workhours', title: '工时管理日志', group: '业务日志' },
  { path: 'log_logistics', title: '物流报价日志', group: '业务日志' },
  { path: 'log_smartquote', title: '智能测单日志', group: '业务日志' },
  { path: 'log_system', title: '系统/权限日志', group: '系统日志' },
  { path: 'log_all', title: '全部日志', group: '汇总' },
];

ERP.normalizeMenuTree = function (menus, permissions) {
  const raw = Array.isArray(menus) ? menus
    : (menus && Array.isArray(menus.data) ? menus.data : []);
  const list = raw.filter((c) => c && typeof c === 'object').map((c) => ({
    menu_code: c.menu_code || c.code || c.id || '',
    menu_name: c.menu_name || c.name || c.label || '',
    path: c.path || null,
    icon: c.icon || '📄',
    sort: Number(c.sort) || 0,
    children: Array.isArray(c.children) ? c.children : [],
  }));

  // 兜底（不绕过 RBAC）：后端 menus 缺「日志中心」，但 permissions 已授权日志子菜单，
  // 说明该实例连的库没跑 menu_seed.sql / 返回了旧缓存 —— 仅按已授权 path 补出容器。
  const perms = new Set(Array.isArray(permissions) ? permissions : []);
  const hasLogs = list.some((c) => c.menu_code === 'logs' || c.menu_name === '日志中心');
  const granted = LOG_CHILDREN.filter((x) => perms.has(x.path));
  if (!hasLogs && granted.length) {
    console.warn('[menu] 后端 menus 未返回「日志中心」，但 permissions 已授权 ' +
      granted.length + ' 个日志页面；已按权限白名单补渲染。请确认服务实例连接的数据库执行过 menu_seed.sql。');
    list.push({
      menu_code: 'logs', menu_name: '日志中心', path: null, icon: '📜', sort: 80,
      children: granted.map((x) => ({
        menu_name: x.title, path: x.path, group_name: x.group, is_built: 1,
      })),
    });
  }
  // 排序稳定：后端已按 sort 排好，这里兜底保证新增父菜单位置确定
  return list.sort((a, b) => a.sort - b.sort);
};

// 渲染侧边栏 + 绑定交互（RBAC：menus 为后端返回的该角色权限菜单树，
// 无权限的主菜单/子菜单后端已不返回，前端只渲染拿到的数据）
ERP.renderMenu = function (menus, options) {
  const opts = options || {};
  if (ERP.ensureMenuVersion) ERP.ensureMenuVersion(opts.version);
  ERP._MENU_RUNTIME = ERP.normalizeMenuTree(menus, opts.permissions);
  const nav = document.getElementById('nav');
  const mega = document.getElementById('mega');
  if (!nav || !mega) {
    console.error('[menu] 未找到 #nav / #mega 容器，左侧菜单无法渲染');
    return;
  }
  nav.innerHTML = '';
  mega.innerHTML = '';
  const rendered = [];

  ERP._MENU_RUNTIME.forEach((cat) => {
    const kids = cat.children || [];

    // 直达菜单项（如「看板」：无子菜单且自身带 path）→ 点击直接进入页面
    if (!kids.length && cat.path) {
      const item = document.createElement('div');
      item.className = 'nav-item nav-direct';
      item.dataset.cat = cat.menu_code;
      item.dataset.page = cat.path;
      item.innerHTML =
        '<span class="nav-ico">' + (cat.icon || '📄') + '</span>' +
        '<span class="nav-lbl">' + cat.menu_name + '</span>';
      nav.appendChild(item);
      rendered.push(cat.menu_name);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ERP._go) ERP._go(cat.path);
        ERP.closeMenu();
      });
      return;
    }

    // 无任何可见子菜单 → 整个主菜单不渲染（后端树已过滤，这里兜底）
    if (!kids.length) return;

    // 按 group_name 还原飞出面板分组（纯 UI 分组，不参与授权）
    const groups = [];
    kids.forEach((k) => {
      const g = k.group_name || '功能';
      let grp = groups.find((x) => x.title === g);
      if (!grp) { grp = { title: g, items: [] }; groups.push(grp); }
      grp.items.push(k);
    });

    // 一级菜单项
    const item = document.createElement('div');
    item.className = 'nav-item';
    item.dataset.cat = cat.menu_code;
    item.innerHTML =
      '<span class="nav-ico">' + (cat.icon || '📄') + '</span>' +
      '<span class="nav-lbl">' + cat.menu_name + '</span>' +
      '<span class="nav-caret">›</span>';
    nav.appendChild(item);
    rendered.push(cat.menu_name);

    // 预构建该分类的悬浮面板（分组网格）
    const panel = document.createElement('div');
    panel.className = 'mega-groups';
    groups.forEach((g) => {
      const gd = document.createElement('div');
      gd.className = 'mega-group';
      gd.innerHTML = '<div class="mega-group-title"><span class="mega-ico">📄</span>' + g.title + '</div>';
      const list = document.createElement('div');
      list.className = 'mega-list';
      g.items.forEach((it) => {
        const li = document.createElement('div');
        // is_built=0 → 功能建设中（置灰），已授权可预点（提示建设中）
        li.className = 'mega-item' + (it.path && it.is_built !== 0 ? '' : ' disabled');
        li.textContent = it.menu_name;
        if (it.path && it.is_built !== 0) {
          li.dataset.page = it.path;
          li.addEventListener('click', (e) => {
            e.stopPropagation();
            if (ERP._go) ERP._go(it.path);
            ERP.closeMenu();
          });
        } else {
          li.addEventListener('click', (e) => {
            e.stopPropagation();
            ERP.toast('「' + it.menu_name + '」功能建设中');
          });
        }
        list.appendChild(li);
      });
      gd.appendChild(list);
      panel.appendChild(gd);
    });

    // 交互：悬停打开；点击切换；移出延时关闭
    item.addEventListener('mouseenter', () => ERP.openMenu(cat.menu_code, item, panel));
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ERP._openId === cat.menu_code) ERP.closeMenu();
      else ERP.openMenu(cat.menu_code, item, panel);
    });
    item.addEventListener('mouseleave', () => ERP.scheduleClose());
  });

  // 全局事件只绑一次：renderMenu 可能被重复调用（权限刷新/版本刷新），
  // 重复绑定会累积监听器并引发难以定位的交互异常
  if (!ERP._menuGlobalBound) {
    // 面板自身：进入取消关闭，移出延时关闭
    mega.addEventListener('mouseenter', () => ERP.cancelClose());
    mega.addEventListener('mouseleave', () => ERP.scheduleClose());

    // 点击空白处 / ESC 关闭
    document.addEventListener('click', (e) => {
      if (ERP._openId && !e.target.closest('.nav-item') && !e.target.closest('#mega')) {
        ERP.closeMenu();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ERP.closeMenu(); });
    window.addEventListener('resize', () => { if (ERP._openId) ERP.closeMenu(); });
    ERP._menuGlobalBound = true;
  }

  // 可观测诊断：控制台直接看到本次实际渲染了哪些主菜单
  console.info('[menu] 已渲染 ' + rendered.length + ' 个主菜单：' + rendered.join('、'));
  if (!rendered.includes('日志中心') && (opts.permissions || []).some((p) => /^log_/.test(p))) {
    console.warn('[menu] 权限含日志页面但「日志中心」未渲染，请检查 /api/auth/me 返回的 menus 数据');
  }
};

// 打开指定分类的悬浮面板
ERP.openMenu = function (id, itemEl, panel) {
  ERP.cancelClose();
  const mega = document.getElementById('mega');
  ERP._openId = id;
  mega.innerHTML = '';
  mega.appendChild(panel);
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('open', n.dataset.cat === id));

  // 定位到侧边栏右侧、一级菜单项顶部，并防止超出视口底部
  const sb = document.querySelector('.sidebar').getBoundingClientRect();
  const ir = itemEl.getBoundingClientRect();
  mega.style.left = sb.right + 'px';
  let top = ir.top;
  mega.style.display = 'block';
  const ph = mega.offsetHeight;
  const wh = window.innerHeight;
  if (top + ph > wh - 8) top = Math.max(8, wh - ph - 8);
  mega.style.top = top + 'px';
  requestAnimationFrame(() => mega.classList.add('show'));
};

ERP.scheduleClose = function () {
  ERP.cancelClose();
  ERP._closeTimer = setTimeout(() => ERP.closeMenu(), 200);
};
ERP.cancelClose = function () {
  if (ERP._closeTimer) { clearTimeout(ERP._closeTimer); ERP._closeTimer = null; }
};
ERP.closeMenu = function () {
  ERP.cancelClose();
  ERP._openId = null;
  const mega = document.getElementById('mega');
  mega.classList.remove('show');
  setTimeout(() => { if (!ERP._openId) mega.style.display = 'none'; }, 160);
  document.querySelectorAll('.nav-item.open').forEach((n) => n.classList.remove('open'));
};

// 设置选中态：高亮一级菜单 + 对应子项（高亮背景 + 左侧边框）
ERP.setActiveMenu = function (page) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.querySelectorAll('.mega-item').forEach((m) => m.classList.remove('active'));
  document.querySelectorAll('.mega-item[data-page="' + page + '"]').forEach((m) => m.classList.add('active'));
  (ERP._MENU_RUNTIME || []).forEach((cat) => {
    // 直达项（看板）自身命中，或其子项命中
    const found = cat.path === page
      || (cat.children || []).some((it) => it.path === page);
    if (found) {
      const el = document.querySelector('.nav-item[data-cat="' + cat.menu_code + '"]');
      if (el) el.classList.add('active');
    }
  });
};

// 轻提示（功能建设中）
ERP.toast = function (msg, kind) {
  let t = document.getElementById('erp-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'erp-toast';
    t.className = 'erp-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  // kind='error' → 红色警示提示（如客户名校验失败）
  t.classList.toggle('erp-toast-error', kind === 'error');
  t.classList.add('show');
  clearTimeout(ERP._toastTimer);
  ERP._toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
};
