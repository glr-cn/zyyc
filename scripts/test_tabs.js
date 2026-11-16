// 多标签页（Tab）导航机制验证：纯前端状态机 + DOM 桩（无需浏览器）
// 覆盖：打开/关闭/固定/持久化/刷新恢复/重新登录重置/账号隔离/keep-alive
// 用法：node scripts/test_tabs.js
'use strict';

// ---------------- 极简 DOM 桩（仅覆盖 tabs.js 所需 API） ----------------
function makeEl(tag) {
  const el = {
    tagName: tag,
    className: '',
    _cls: new Set(),
    dataset: {},
    style: {},
    children: [],
    parent: null,
    textContent: '',
    _html: '',
    listeners: {},
    offsetWidth: 160,
    offsetHeight: 120,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; this.children = []; },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    remove() { if (this.parent) this.parent.removeChild(this); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) {
      const e = Object.assign({ stopPropagation() {}, preventDefault() {}, target: null }, ev || {});
      (this.listeners[t] || []).forEach((fn) => fn(e));
    },
    scrollIntoView() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    contains: (c) => el._cls.has(c),
    toggle: (c, f) => {
      if (f === undefined) { el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c); }
      else { f ? el._cls.add(c) : el._cls.delete(c); }
    },
  };
  return el;
}

const registry = {};
registry.content = makeEl('div');
registry.tabbar = makeEl('div');

global.window = global;
global.document = {
  body: makeEl('body'),
  createElement: makeEl,
  getElementById: (id) => registry[id] || null,
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
global.localStorage = {
  _s: {},
  getItem(k) { return k in this._s ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
global.innerWidth = 1400;
global.innerHeight = 900;

// 页面桩：记录渲染次数与容器，用于验证 keep-alive
const renderCalls = {};
const renderHost = {};
['dashboard', 'customers', 'wh_lh', 'wh_jx', 'wh_sy', 'wh_ky', 'analytics', 'inventory', 'orders', 'users'].forEach((p) => {
  global.ERP_PAGES = global.ERP_PAGES || {};
  global.ERP_PAGES[p] = function (host) {
    renderCalls[p] = (renderCalls[p] || 0) + 1;
    renderHost[p] = host;
  };
});

require('../public/js/tabs.js');

const T = global.ERP.tabs;
let failed = 0;
function assert(c, m) {
  if (!c) { console.error('FAIL: ' + m); failed++; } else console.log('PASS: ' + m);
}
function session(stamp) { global.localStorage.setItem('erp_login_stamp', stamp); }
function tabbarEls() { return registry.tabbar.children; }
function tabByPage(page) { return tabbarEls().find((e) => e.dataset.page === page); }
function childByClass(el, cls) { return el.children.find((c) => c.className === cls); }

// ============ 1. 初始化：默认只打开「看板」 ============
session('S1');
T.init({ user_id: 1 });
assert(T.list.length === 1 && T.list[0] === 'dashboard', '首次初始化：仅默认打开「看板」');
assert(T.active === 'dashboard', '默认激活页为 dashboard');
assert(tabbarEls().length === 1, '标签栏渲染 1 个标签');
assert(tabByPage('dashboard').className.indexOf('active') >= 0, '默认标签带激活高亮样式');
assert(T.isPinned('dashboard'), '默认「经营看板」处于固定（Pin）状态');
assert(tabByPage('dashboard').className.indexOf('pinned') >= 0, '默认标签带 pinned 样式');
assert(global.document.title === '经营看板 · 佐雍云仓数据中心', '初始化时标题写入 document.title（顶部标题行已移除）');

// ============ 2. 打开页签 + 路由联动 ============
T.open('wh_lh');
assert(T.list.indexOf('wh_lh') >= 0 && T.active === 'wh_lh', '打开龙湖仓工时 → 生成标签并激活');
assert(tabbarEls().length === 2, '标签栏渲染 2 个标签');
assert(global.document.title === '龙湖仓-工时 · 佐雍云仓数据中心', '切换标签时同步更新页面标题');
T.open('customers');
assert(T.list.length === 3, '打开客户资料 → 共 3 个标签');

// ============ 3. keep-alive：切换不重绘，容器复用 ============
assert(renderCalls.dashboard === 1 && renderCalls.wh_lh === 1, '各页首次渲染各 1 次');
const hostWH = renderHost.wh_lh;
T.open('dashboard');
T.open('wh_lh');
assert(renderCalls.wh_lh === 1, '切走再切回：龙湖仓工时未重复渲染（keep-alive）');
assert(renderHost.wh_lh === hostWH, '切走再切回：复用同一视图容器');
assert(hostWH.style.display === 'block', '激活页容器显示');
assert(renderHost.dashboard.style.display === 'none', '非激活页容器隐藏（数据不丢）');

// ============ 4. 关闭页签（释放 keep-alive 缓存） ============
const before = registry.content.children.length;
T.close('customers');
assert(T.list.indexOf('customers') < 0, '关闭客户资料 → 标签移除');
assert(registry.content.children.length === before - 1, '关闭后释放该页视图容器');
assert(T.active === 'wh_lh', '关闭非激活页不改变激活项');
T.close('wh_lh');
assert(T.active === 'dashboard', '关闭激活页 → 自动激活相邻页');

// ============ 5. 固定（Pin） ============
T.open('wh_lh');
T.togglePin('wh_lh');
assert(T.isPinned('wh_lh'), '固定工时管理成功');
assert(T.list[0] === 'dashboard' && T.list[1] === 'wh_lh',
  '固定标签排在非固定标签之前（看板为默认固定，工时其次）');
const pinnedTab = tabByPage('wh_lh');
assert(pinnedTab.className.indexOf('pinned') >= 0, '固定标签带 pinned 样式');
assert(!childByClass(pinnedTab, 'tab-close'), '固定标签隐藏「关闭」按钮');
assert(T.close('wh_lh') === false, '固定标签拒绝关闭');
assert(T.list.indexOf('wh_lh') >= 0, '固定标签仍保留在列表中');
T.togglePin('wh_lh');
assert(!T.isPinned('wh_lh'), '再次点击可取消固定');
assert(childByClass(tabByPage('wh_lh'), 'tab-close'), '取消固定后恢复「关闭」按钮');

// ============ 6. 持久化：刷新（同一会话）恢复 ============
T.open('inventory');
T.open('orders');
T.save();
const saved = JSON.parse(global.localStorage.getItem('erp_tabs_1'));
assert(saved && saved.list.indexOf('inventory') >= 0 && saved.list.indexOf('orders') >= 0,
  '打开列表已写入 localStorage(erp_tabs_1)');
T.init({ user_id: 1 }); // 同一会话戳 = 刷新
assert(T.list.indexOf('inventory') >= 0 && T.list.indexOf('orders') >= 0, '刷新后恢复上次打开的标签');
assert(T.active === 'orders', '刷新后恢复激活项');

// ============ 7. 固定列表持久化 + 重新登录重置临时标签 ============
T.togglePin('wh_lh');
T.save();
const pinRaw = JSON.parse(global.localStorage.getItem('erp_pinned_tabs_1'));
assert(pinRaw && pinRaw.indexOf('wh_lh') >= 0, '固定列表写入 localStorage(erp_pinned_tabs_1)');

session('S2'); // 新的登录会话（重新登录）
T.init({ user_id: 1 });
assert(T.list.indexOf('inventory') < 0 && T.list.indexOf('orders') < 0,
  '重新登录：临时标签状态被重置');
assert(T.list.indexOf('wh_lh') >= 0, '重新登录：固定标签仍保留（固定状态持久化）');
assert(T.list[0] === 'dashboard' && T.list[1] === 'wh_lh', '重新登录：固定标签仍在非固定标签之前');
assert(T.active === 'dashboard', '重新登录：默认激活「看板」');
assert(T.isPinned('wh_lh'), '重新登录：固定标记保留');

// ============ 8. 账号隔离 ============
session('S3');
T.init({ user_id: 2 });
assert(T.list.indexOf('wh_lh') < 0, '其他账号不受本账号固定标签影响');
assert(T.active === 'dashboard', '其他账号默认只打开「看板」');
T.open('orders');
T.save();
assert(global.localStorage.getItem('erp_tabs_2'), '本账号状态写入 erp_tabs_2');
assert(JSON.parse(global.localStorage.getItem('erp_tabs_1')).list.indexOf('orders') < 0,
  '账号 2 的标签未写入账号 1 的存储键');
T.init({ user_id: 1 });
assert(T.list.indexOf('orders') < 0, '切回账号 1：看不到账号 2 的标签');

// ============ 9. 标签栏交互：点击标签切换 / 点击关闭按钮 ============
T.open('dashboard');
T.open('analytics');
const analyticsTab = tabByPage('analytics');
analyticsTab.dispatch('click', {});
assert(T.active === 'analytics', '点击标签 → 切换激活页');
const closeBtn = childByClass(tabByPage('analytics'), 'tab-close');
closeBtn.dispatch('click', {});
assert(T.list.indexOf('analytics') < 0, '点击「×」关闭标签');

// ============ 10. 版本控制：旧版本脏缓存直接覆盖重置 ============
session('S1');
// 模拟历史脏缓存：无版本号 v、含系统名伪标签 / 非法页面 / 脏固定列表
global.localStorage.setItem('erp_tabs_1', JSON.stringify({
  stamp: 'S1',
  list: ['佐雍云仓数据中心', 'home', 'dashboard', 'orders', 'ghost_page'],
  active: '佐雍云仓数据中心',
}));
global.localStorage.setItem('erp_pinned_tabs_1', JSON.stringify(['home', 'orders']));
T.init({ user_id: 1 });
assert(T.list.indexOf('佐雍云仓数据中心') < 0 && T.list.indexOf('home') < 0
  && T.list.indexOf('ghost_page') < 0 && T.list.indexOf('orders') < 0,
  '旧版本缓存中的脏标签（系统名伪标签 / 非法页面）全部被剔除');
assert(T.list.length === 1 && T.list[0] === 'dashboard' && T.active === 'dashboard',
  '缓存版本不匹配 → 存储被覆盖重置为仅「经营看板」');
assert(T.isPinned('dashboard'), '重置后「经营看板」恢复默认固定');
const savedV2 = JSON.parse(global.localStorage.getItem('erp_tabs_1'));
assert(savedV2.v === ERP.TABS_VERSION && savedV2.list.length === 1 && savedV2.list[0] === 'dashboard',
  '重置结果已按新版本号 v=' + ERP.TABS_VERSION + ' 回写 localStorage（旧脏数据被覆盖）');
const savedPin = JSON.parse(global.localStorage.getItem('erp_pinned_tabs_1'));
assert(JSON.stringify(savedPin) === JSON.stringify(['dashboard']),
  '旧的脏固定列表（home/orders）被覆盖为默认 [dashboard]');

// 同版本缓存：刷新正常恢复，不再触发重置
T.open('wh_lh');
T.save();
T.init({ user_id: 1 }); // 同一会话戳 S1 → 刷新
assert(T.list.indexOf('wh_lh') >= 0 && T.active === 'wh_lh',
  '同版本缓存刷新后正常恢复，不误伤用户状态');

console.log(failed === 0 ? '=== 全部通过 ===' : '=== 有 ' + failed + ' 项失败 ===');
process.exit(failed === 0 ? 0 : 1);
