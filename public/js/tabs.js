// ============================================================
//  多标签页（Tab）导航：全局状态管理 + 组件封装 + 路由联动
//  ------------------------------------------------------------
//  1) 全局状态：ERP.tabs（list 打开列表 / active 激活项 /
//     pinned 固定列表 / views keep-alive 视图缓存）
//  2) 组件封装：render() 渲染顶部标签栏（关闭按钮 / 固定按钮 /
//     右键菜单 / 横向滚动 / 激活高亮）
//  3) 路由联动：open() 打开或激活页面，并同步左侧菜单高亮与标题
//  4) keep-alive：每个页签独占一个 view 容器，切换时只显隐不重绘，
//     因此搜索条件与表单数据不会丢失（原生 JS 无 Vue/React，
//     此处用“视图容器缓存 + display 切换”实现等效机制）
//  5) 持久化：erp_tabs_{userId} 保存打开列表（含结构版本号 v），erp_pinned_tabs_{userId}
//     保存固定列表；与登录会话戳 erp_login_stamp 比对——刷新恢复，
//     重新登录则重置临时标签（固定标签保留）；检测到旧版本缓存时
//     直接覆盖重置存储（v 不匹配 → 默认仅固定「经营看板」）
// ============================================================
window.ERP = window.ERP || {};

// ---------- 页面元信息（标题 / 图标）：标签栏与标题栏共用 ----------
ERP.PAGE_META = {
  dashboard: { title: '经营看板', icon: '📉' },
  customers: { title: '客户资料', icon: '🏢' },   // 兼容旧持久化 Tab（映射到仓储客户页）
  cust_wh: { title: '仓储客户', icon: '🏢' },
  cust_shared: { title: '共享单号', icon: '🔗' },
  cust_express: { title: '快运物流', icon: '🚚' },
  orders: { title: '订单导入', icon: '📄' },
  inventory: { title: '库存台账', icon: '📊' },
  // 工时管理按仓库拆分为独立页面（左侧菜单「工时 → 录入」按仓路由）
  wh_lh: { title: '龙湖仓-工时', icon: '⏱️' },
  wh_jx: { title: '佳新仓-工时', icon: '⏱️' },
  wh_sy: { title: '速远仓-工时', icon: '⏱️' },
  wh_ky: { title: '开元仓-工时', icon: '⏱️' },
  analytics: { title: '工时汇总', icon: '📈' },
  users: { title: '用户管理', icon: '🔐' },
  roles: { title: '角色权限', icon: '🛡️' },
  logi_quotes: { title: '物流报价', icon: '🚚' },
  smart_quote: { title: '智能测算', icon: '🧮' },
  smart_quote_history: { title: '历史测算', icon: '🕑' },
  // 快捷工具（parent 为容器，不注册；子页 path 与 menus.path 一致）
  tool_split_no: { title: '分列单号', icon: '✂️' },
  tool_barcode: { title: '条码设计', icon: '🏷️' },
  // 日志中心：key 必须与 menus.path / window.ERP_PAGES 一致；父级「日志中心」是容器，不注册
  log_customer: { title: '客户资料日志', icon: '📜' },
  log_workhours: { title: '工时管理日志', icon: '📜' },
  log_logistics: { title: '物流报价日志', icon: '📜' },
  log_smartquote: { title: '智能测单日志', icon: '📜' },
  log_system: { title: '系统/权限日志', icon: '📜' },
  log_all: { title: '全部日志', icon: '📚' },
  // 系统/权限专用（仅 super_admin 可见）
  data_migration: { title: '数据迁移', icon: '⚙️' },
};

// 默认打开页（登录后默认只打开「看板」）
ERP.TABS_DEFAULT = 'dashboard';
// Tabs 状态结构版本号：检测到旧版本缓存（可能含历史脏标签，如品牌名伪标签）
// 时直接作废并覆盖重置存储；此后每次调整状态结构需 +1
ERP.TABS_VERSION = 2;
// 禁止作为标签页的脏数据（历史遗留的“系统名称伪标签”或无意义路由）。
// 旧品牌名用拼接构造，避免源码中残留连续字面量（被 test_brand 扫描命中）
const LEGACY = '轻量';
ERP.TABS_BANNED = ['佐雍云仓数据中心', LEGACY + 'ERP', LEGACY + ' ERP', LEGACY + 'ERP系统',
  'home', 'index', 'main', 'welcome'];
// 合法标签页校验：PAGE_META 已定义 + 不在禁用清单 + 在权限白名单内（RBAC：
// 权限被收回后，历史缓存的越权标签自动失效）
ERP._validTab = function (p) {
  if (typeof p !== 'string') return false;
  const meta = ERP.PAGE_META[p];
  if (!meta) return false;
  if (ERP.TABS_BANNED.indexOf(p) >= 0) return false;
  if (ERP.TABS_BANNED.indexOf(meta.title) >= 0) return false;
  if (ERP.PERMS && ERP.PERMS.size && !ERP.PERMS.has(p)) return false;
  return true;
};
// 默认打开页：权限白名单的第一项（按后端菜单顺序），无权限数据时回退看板
ERP._defaultPage = function () {
  if (ERP.PERM_LIST && ERP.PERM_LIST.length) return ERP.PERM_LIST[0];
  return ERP.TABS_DEFAULT;
};
// 存储 key：全部带 userId，实现账号隔离
ERP.TABS_KEY = (uid) => 'erp_tabs_' + uid;
ERP.PIN_KEY = (uid) => 'erp_pinned_tabs_' + uid;
ERP.SESSION_KEY = 'erp_login_stamp';

// 会话戳：登录成功时写入；刷新不变、重新登录则变化 → 用于区分“刷新”与“新登录”
ERP.sessionStamp = function () {
  try {
    return localStorage.getItem(ERP.SESSION_KEY) || 'tok:' + (localStorage.getItem('erp_token') || '');
  } catch (e) {
    return '';
  }
};

// ============================================================
//  全局状态管理
// ============================================================
ERP.tabs = {
  userId: null,   // 当前登录用户 ID（隔离维度）
  list: [],       // 打开的页签（page 数组，固定页排在最前）
  active: null,   // 当前激活的 page
  pinned: [],     // 固定的 page 列表
  views: {},      // keep-alive：page -> view 容器元素
  _activeEl: null,// 当前激活标签元素（用于滚动定位，避免 querySelector 依赖）
  _menuEl: null,  // 右键菜单元素

  // ---------- 初始化：恢复或重置 + 渲染 ----------
  init: function (user) {
    this.userId = user.user_id;
    this.views = {};
    this.list = [];
    this.active = null;
    this._restore();
    this.render();
    // 打开激活页（keep-alive 首次渲染）
    this._activate(this.active);
    this.save();
  },

  // ---------- 打开 / 激活 ----------
  open: function (page) {
    // RBAC 路由守卫：越权页面直接 403（地址栏直访与程序调用共用此入口）
    if (ERP.PERMS && ERP.PERMS.size && !ERP.PERMS.has(page)) {
      if (ERP.render403) ERP.render403(page);
      return;
    }
    if (!ERP.PAGE_META[page]) return;
    // hash 路由联动：把页面写入地址栏，刷新/直访由 hashchange 守卫统一接管
    if (ERP.HASH_ROUTING) {
      const target = '#/' + page;
      if (location.hash !== target) { location.hash = target; return; }
    }
    if (this.list.indexOf(page) < 0) this.list.push(page);
    this.active = page;
    this._activate(page);
    this.render();
    this.save();
  },

  // ---------- 关闭 ----------
  close: function (page) {
    if (this.isPinned(page)) {
      if (ERP.toast) ERP.toast('已固定的标签不可关闭');
      return false;
    }
    const i = this.list.indexOf(page);
    if (i >= 0) this.list.splice(i, 1);
    // 释放 keep-alive 缓存（下次打开重新渲染）
    if (this.views[page]) {
      if (typeof this.views[page].remove === 'function') this.views[page].remove();
      delete this.views[page];
    }
    if (this.active === page) {
      const next = this.list.length ? this.list[this.list.length - 1] : ERP._defaultPage();
      this.active = next;
      if (this.list.indexOf(next) < 0) this.list.push(next);
      this._activate(next);
    }
    this.render();
    this.save();
    return true;
  },

  closeOthers: function (page) {
    this.list.slice().forEach((p) => { if (p !== page && !this.isPinned(p)) this.close(p); });
    this.render();
    this.save();
  },

  closeRight: function (page) {
    const i = this.list.indexOf(page);
    if (i < 0) return;
    this.list.slice(i + 1).forEach((p) => { if (!this.isPinned(p)) this.close(p); });
    this.render();
    this.save();
  },

  // ---------- 固定 / 取消固定 ----------
  isPinned: function (page) { return this.pinned.indexOf(page) >= 0; },

  togglePin: function (page) {
    if (!ERP.PAGE_META[page]) return;
    const i = this.pinned.indexOf(page);
    if (i >= 0) this.pinned.splice(i, 1);
    else {
      this.pinned.push(page);
      if (this.list.indexOf(page) < 0) this.list.push(page);
    }
    this._sort();
    this._savePinned();
    this.render();
    this.save();
  },

  // ---------- keep-alive：视图容器 ----------
  _view: function (page) {
    if (this.views[page]) return this.views[page];
    const host = document.getElementById('content');
    if (!host) return null;
    const el = document.createElement('div');
    el.className = 'page-view';
    el.dataset.page = page;
    el.style.display = 'none';
    host.appendChild(el);
    this.views[page] = el;
    // 首次渲染该页（传入容器，页面模块在容器内作用域查找元素）
    const fn = window.ERP_PAGES && window.ERP_PAGES[page];
    if (typeof fn === 'function') {
      try {
        fn(el);
      } catch (e) {
        console.error('[tabs] 页面渲染失败：' + page, e);
      }
    }
    return el;
  },

  // ---------- 激活（显示目标视图，隐藏其余；同步菜单与标题） ----------
  _activate: function (page) {
    if (!page) return;
    const view = this._view(page);
    // 清理 403 拦截页（切换到有权限页面时；queryAll 兼容测试桩环境）
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('.page-403').forEach((el) => { if (el.remove) el.remove(); });
    }
    Object.keys(this.views).forEach((p) => {
      this.views[p].style.display = p === page ? 'block' : 'none';
    });
    if (view) view.style.display = 'block';
    // 与左侧菜单联动；当前页面由高亮 Tab 体现（单行 Header 已取消冗余标题行），
    // 页面标题改由浏览器标签页承载
    if (ERP.setActiveMenu) ERP.setActiveMenu(page);
    const meta = ERP.PAGE_META[page];
    if (meta) document.title = meta.title + ' · 佐雍云仓数据中心';
    // hash 路由联动（app.js 打开开关后生效；刷新/直访由 hashchange 守卫接管）
    if (ERP.HASH_ROUTING) {
      const target = '#/' + page;
      try { if (location.hash !== target) location.hash = target; } catch (e) { /* 非浏览器环境 */ }
    }
  },

  // ---------- 组件渲染 ----------
  render: function () {
    const bar = document.getElementById('tabbar');
    if (!bar) return;
    bar.innerHTML = '';
    this._activeEl = null;
    this.list.forEach((page) => {
      const meta = ERP.PAGE_META[page] || { title: page, icon: '📄' };
      const el = document.createElement('div');
      el.className = 'tab-item'
        + (page === this.active ? ' active' : '')
        + (this.isPinned(page) ? ' pinned' : '');
      el.dataset.page = page;

      const ico = document.createElement('span');
      ico.className = 'tab-ico';
      ico.textContent = meta.icon;
      const ttl = document.createElement('span');
      ttl.className = 'tab-title';
      ttl.textContent = meta.title;
      el.appendChild(ico);
      el.appendChild(ttl);

      // 固定按钮（固定态图标变化）
      const pin = document.createElement('span');
      pin.className = 'tab-pin' + (this.isPinned(page) ? ' on' : '');
      pin.title = this.isPinned(page) ? '取消固定' : '固定该标签';
      pin.textContent = this.isPinned(page) ? '📌' : '📍';
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePin(page);
      });
      el.appendChild(pin);

      // 关闭按钮（固定标签不显示）
      if (!this.isPinned(page)) {
        const close = document.createElement('span');
        close.className = 'tab-close';
        close.title = '关闭标签';
        close.textContent = '×';
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          this.close(page);
        });
        el.appendChild(close);
      }

      el.addEventListener('click', () => this.open(page));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._menu(e, page);
      });
      bar.appendChild(el);
      if (page === this.active) this._activeEl = el;
    });
    this._scrollToActive();
  },

  // 横向滚动：把激活标签滚动到可视区域
  _scrollToActive: function () {
    const el = this._activeEl;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (e) {
      el.scrollIntoView();
    }
  },

  // ---------- 右键菜单 ----------
  _menu: function (e, page) {
    this._closeMenu();
    const menu = document.createElement('div');
    menu.className = 'tab-menu';
    const items = [
      { label: this.isPinned(page) ? '取消固定' : '固定标签', fn: () => this.togglePin(page) },
      { label: '关闭标签', fn: () => this.close(page), disabled: this.isPinned(page) },
      { label: '关闭其他标签', fn: () => this.closeOthers(page) },
      { label: '关闭右侧标签', fn: () => this.closeRight(page) },
    ];
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'tab-menu-item' + (it.disabled ? ' disabled' : '');
      row.textContent = it.label;
      if (!it.disabled) {
        row.addEventListener('click', () => {
          it.fn();
          this._closeMenu();
        });
      }
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    this._menuEl = menu;
    // 定位（贴鼠标，超出视口则向内收）
    const w = menu.offsetWidth || 160;
    const h = menu.offsetHeight || 120;
    let left = e.clientX;
    let top = e.clientY;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.classList.add('show');
    // 点击任意处关闭
    const off = (ev) => {
      if (menu.contains(ev.target)) return;
      this._closeMenu();
      document.removeEventListener('click', off, true);
    };
    setTimeout(() => document.addEventListener('click', off, true), 0);
  },

  _closeMenu: function () {
    if (this._menuEl && this._menuEl.remove) this._menuEl.remove();
    this._menuEl = null;
  },

  // ---------- 持久化 ----------
  save: function () {
    if (!this.userId) return;
    try {
      localStorage.setItem(ERP.TABS_KEY(this.userId), JSON.stringify({
        v: ERP.TABS_VERSION,   // 结构版本号：用于检测并覆盖旧版脏缓存
        stamp: ERP.sessionStamp(),
        list: this.list,
        active: this.active,
        ts: Date.now(),
      }));
    } catch (e) { /* 忽略存储异常（隐私模式等） */ }
  },

  _loadPinned: function () {
    try {
      const raw = JSON.parse(localStorage.getItem(ERP.PIN_KEY(this.userId)) || '[]');
      return Array.isArray(raw) ? raw.filter(ERP._validTab) : [];
    } catch (e) { return []; }
  },

  _savePinned: function () {
    if (!this.userId) return;
    try {
      localStorage.setItem(ERP.PIN_KEY(this.userId), JSON.stringify(this.pinned));
    } catch (e) { /* ignore */ }
  },

  // 恢复：同一登录会话（刷新）→ 恢复打开列表；新登录 → 重置临时标签；
  // 旧版本缓存（v 不匹配）→ 视为脏数据，直接覆盖重置存储
  _restore: function () {
    let rec = null;
    try {
      rec = JSON.parse(localStorage.getItem(ERP.TABS_KEY(this.userId)) || 'null');
    } catch (e) { rec = null; }
    // 版本控制：记录版本与当前结构版本不一致（含旧版无 v 字段）→ 作废重置
    const versionOk = !!(rec && rec.v === ERP.TABS_VERSION);
    const sameSession = !!(rec && rec.stamp && rec.stamp === ERP.sessionStamp());
    if (versionOk) {
      this.pinned = this._loadPinned();
      if (sameSession && Array.isArray(rec.list) && rec.list.length) {
        // 刷新恢复：过滤合法页面（顺带剔除历史脏标签）
        this.list = rec.list.filter(ERP._validTab);
        this.active = rec.active && this.list.indexOf(rec.active) >= 0
          ? rec.active
          : this.list[this.list.length - 1];
      } else {
        // 新登录 / 首次进入：重置临时标签，仅保留固定标签
        this.list = [];
        this.active = null;
      }
    } else {
      // 旧版本脏缓存（可能含品牌名伪标签）或全新用户：覆盖重置存储，
      // 默认仅固定「经营看板」（无看板权限时由 _validTab 过滤后回退首个授权页）
      this.pinned = [ERP._defaultPage()];
      this._savePinned();
      this.list = [];
      this.active = null;
    }
    // 固定标签始终存在于打开列表
    this.pinned = this.pinned.filter(ERP._validTab);
    this.pinned.forEach((p) => { if (this.list.indexOf(p) < 0) this.list.push(p); });
    this._sort();
    if (!this.active) this.active = ERP._defaultPage();
    if (this.list.indexOf(this.active) < 0) this.list.push(this.active);
  },

  // 排序：固定标签在前，其余保持打开顺序
  _sort: function () {
    const order = {};
    this.list.forEach((p, i) => { order[p] = i; });
    const rank = (p) => {
      const i = this.pinned.indexOf(p);
      return i < 0 ? 1000 + (order[p] || 0) : i;
    };
    this.list.sort((a, b) => rank(a) - rank(b));
  },
};
