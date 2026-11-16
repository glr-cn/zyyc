// 左侧菜单结构调整验证：看板置顶 + 取消二级子菜单（直达）+ 其他菜单不受影响
// 用法：node scripts/test_menu.js
'use strict';

// ---------------- 极简 DOM 桩（支持 class / [attr="val"] 选择器） ----------------
function makeEl(tag) {
  const el = {
    tagName: tag, className: '', dataset: {}, style: {}, children: [], parent: null,
    textContent: '', _html: '', listeners: {}, offsetWidth: 160, offsetHeight: 120,
    _cls: new Set(),
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = v;
      this.children = [];
      parseHTML(v, this);
    },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parent = null; return c;
    },
    remove() { if (this.parent) this.parent.removeChild(this); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) {
      const e = Object.assign({ stopPropagation() {}, preventDefault() {}, target: null }, ev || {});
      (this.listeners[t] || []).forEach((fn) => fn(e));
    },
    scrollIntoView() {},
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 800, width: 200, height: 800 }; },
  };
  // classList 与 className 联动（与浏览器行为一致）
  const clsOf = (e) => (e.className || '').split(/\s+/).filter(Boolean);
  const setCls = (e, arr) => { e.className = arr.join(' '); };
  el.classList = {
    add: (c) => { const a = clsOf(el); if (!a.includes(c)) { a.push(c); setCls(el, a); } },
    remove: (c) => { setCls(el, clsOf(el).filter((x) => x !== c)); },
    contains: (c) => clsOf(el).includes(c),
    toggle: (c, f) => {
      const has = clsOf(el).includes(c);
      if (f === undefined) { has ? el.classList.remove(c) : el.classList.add(c); }
      else { f ? el.classList.add(c) : el.classList.remove(c); }
    },
  };
  return el;
}

// 极简 HTML 解析：支持 <tag class="x">文本</tag>（菜单项/面板标题够用）
function parseHTML(html, into) {
  const re = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    const el = makeEl(m[1]);
    const cm = /class="([^"]*)"/.exec(m[2]);
    if (cm) el.className = cm[1];
    el.textContent = m[3].replace(/<[^>]*>/g, '');
    into.appendChild(el);
  }
  return into;
}

function walk(node, out) {
  node.children.forEach((c) => { out.push(c); walk(c, out); });
  return out;
}
function matchSel(el, sel) {
  const m = sel.match(/^(?:([\w-]+)|#([\w-]+))?((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/);
  if (!m) return false;
  const [, tag, id, classes, attr, val] = m;
  if (tag && el.tagName && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (id && el.id !== id) return false;
  if (classes) {
    const list = classes.split('.').filter(Boolean);
    const own = (el.className || '').split(/\s+/);
    if (!list.every((c) => own.includes(c))) return false;
  }
  if (attr) {
    const key = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (el.dataset[key] !== val) return false;
  }
  return true;
}

const root = makeEl('html');
const body = makeEl('body');
root.appendChild(body);
const registry = {};
['nav', 'mega', 'content', 'tabbar'].forEach((id) => {
  registry[id] = makeEl('div');
  body.appendChild(registry[id]);
});
registry.sidebar = makeEl('aside');
registry.sidebar.className = 'sidebar';
body.appendChild(registry.sidebar);

global.window = global;
global.innerWidth = 1400;
global.innerHeight = 900;
global.document = {
  body,
  createElement: makeEl,
  getElementById: (id) => registry[id] || null,
  querySelector: (sel) => walk(root, []).find((e) => matchSel(e, sel)) || null,
  querySelectorAll: (sel) => walk(root, []).filter((e) => matchSel(e, sel)),
  addEventListener: () => {},
  removeEventListener: () => {},
};
global.addEventListener = () => {};
global.requestAnimationFrame = (fn) => fn();

require('../public/js/menu.js');

const ERP = global.ERP;
let failed = 0;
function assert(c, m) {
  if (!c) { console.error('FAIL: ' + m); failed++; } else console.log('PASS: ' + m);
}

// ============ 1. 菜单结构 ============
assert(ERP.MENU[0].id === 'dashboard', '「看板」已调整到左侧菜单最顶部');
assert(ERP.MENU[0].direct === 'dashboard', '看板为直达菜单项（direct）');
assert(ERP.MENU[0].groups.length === 0, '看板已取消二级子菜单');
assert(!ERP.MENU.some((c) => c.id === 'dashboard' && c.groups.length > 0), '看板不存在任何二级分组');
const others = ERP.MENU.slice(1).map((c) => c.id);
assert(others.join(',') === 'outbound,inbound,inventory,master,work',
  '其余菜单顺序与内容未变：' + others.join(','));

// ============ 1b. 工时菜单按仓库拆分 ============
const workCat = ERP.MENU.find((c) => c.id === 'work');
assert(workCat.groups.length === 2, '工时菜单含「录入/汇总」两个分组');
const luru = workCat.groups[0], huizong = workCat.groups[1];
assert(luru.title === '录入' && huizong.title === '汇总', '分组标题为 录入/汇总');
const whPages = luru.items.map((it) => it.page);
assert(JSON.stringify(whPages) === JSON.stringify(['wh_lh', 'wh_jx', 'wh_sy', 'wh_ky']),
  '录入组按仓库拆分为 4 个子菜单（wh_lh/wh_jx/wh_sy/wh_ky）');
assert(luru.items[0].label === '龙湖仓工时管理' && luru.items[3].label === '开元仓工时管理',
  '子菜单标题带仓库名（如「龙湖仓工时管理」）');
assert(huizong.items.length === 1 && huizong.items[0].page === 'analytics', '汇总组保留「工时汇总」');
assert(!ERP.MENU.some((c) => c.groups.some((g) => g.items.some((it) => it.page === 'workhours'))),
  '旧的统一「工时管理」入口已从菜单移除');

// ============ 2. 渲染（RBAC：由后端权限菜单树驱动） ============
// 构造超管视角的全量菜单树（结构与 /api/auth/me 返回一致）
function node(id, code, name, path, group, built) {
  return { menu_id: id, menu_code: code, menu_name: name, path: path || null, group_name: group || null, is_built: built === undefined ? 1 : built, children: [] };
}
const TREE_FULL = [
  Object.assign(node(1, 'dashboard', '看板', 'dashboard'), { children: [] }),
  Object.assign(node(2, 'outbound', '出库'), { children: [
    node(101, 'ob_orders', '订单导入', 'orders', '单据'),
    node(102, 'ob_bill', '出库单', null, '单据', 0),
  ]}),
  Object.assign(node(3, 'inbound', '入库'), { children: [] }),
  Object.assign(node(4, 'inventory', '库存'), { children: [] }),
  Object.assign(node(5, 'master', '基础资料'), { children: [
    node(401, 'cust_wh', '仓储客户', 'cust_wh', '客户'),
    node(402, 'cust_shared', '共享单号', 'cust_shared', '客户'),
    node(403, 'cust_express', '快运物流', 'cust_express', '客户'),
    node(404, 'users', '用户管理', 'users', '权限'),
    node(405, 'roles', '角色权限', 'roles', '权限'),
  ]}),
  Object.assign(node(6, 'work', '工时'), { children: [
    node(501, 'wh_lh', '龙湖仓工时管理', 'wh_lh', '录入'),
    node(502, 'wh_jx', '佳新仓工时管理', 'wh_jx', '录入'),
    node(503, 'wh_sy', '速远仓工时管理', 'wh_sy', '录入'),
    node(504, 'wh_ky', '开元仓工时管理', 'wh_ky', '录入'),
    node(505, 'analytics', '工时汇总', 'analytics', '汇总'),
  ]}),
];
// 给每个节点补 children（node() 造的是叶子）
TREE_FULL.forEach((cat) => { cat.children.forEach((c) => { c.children = []; }); });

ERP.renderMenu(TREE_FULL);
const navItems = registry.nav.children;
// inbound/inventory 在测试树中无授权子菜单且无 path → 整体隐藏（RBAC 行为正确）
assert(navItems.length === 4, '侧边栏仅渲染有内容的 4 个一级菜单项（空容器隐藏）');
assert(navItems[0].dataset.cat === 'dashboard', '第一个渲染的是「看板」');
assert(navItems[0].className.indexOf('nav-direct') >= 0, '看板为直达样式（nav-direct）');
assert(!navItems[0].children.some((c) => c.className === 'nav-caret'), '看板不显示二级箭头（›）');
assert(navItems.slice(1).every((n) => n.children.some((c) => c.className === 'nav-caret')),
  '其余菜单仍保留二级箭头');

// ============ 3. 点击看板 → 直达跳转，不弹面板 ============
let navigated = null;
ERP._go = (page) => { navigated = page; };
navItems[0].dispatch('click', {});
assert(navigated === 'dashboard', '点击「看板」直接跳转经营看板页面');
assert(ERP._openId === null, '点击「看板」不弹出二级面板');

// ============ 4. 其他菜单的悬浮面板仍可用 ============
const outbound = navItems.find((n) => n.dataset.cat === 'outbound');
outbound.dispatch('click', {});
assert(ERP._openId === 'outbound', '点击「出库」仍弹出二级面板');
const megaKids = walk(root, []).filter((e) => e.className && e.className.indexOf('mega-item') >= 0);
const ordersItem = megaKids.find((m) => m.dataset.page === 'orders');
assert(!!ordersItem, '二级面板仍包含「订单导入」入口');
navigated = null;
ordersItem.dispatch('click', {});
assert(navigated === 'orders', '二级菜单项点击仍能跳转页面');
// 功能建设中项：置灰且点击不跳转
const builtItem = megaKids.find((m) => m.textContent === '出库单');
assert(builtItem && builtItem.className.indexOf('disabled') >= 0, '「功能建设中」子菜单呈置灰样式');
navigated = null;
builtItem.dispatch('click', {});
assert(navigated === null, '「功能建设中」子菜单点击不跳转');

// ============ 5. 高亮联动 ============
ERP.setActiveMenu('dashboard');
assert(navItems[0].className.indexOf('active') >= 0, '看板页激活时「看板」菜单高亮');
ERP.setActiveMenu('wh_lh');
assert(navItems[0].className.indexOf('active') < 0, '切到龙湖仓工时后看板不再高亮');
const workItem = navItems.find((n) => n.dataset.cat === 'work');
assert(workItem.className.indexOf('active') >= 0, '龙湖仓工时页激活时「工时」菜单高亮');

// ============ 6. RBAC 动态渲染：无权限子菜单不渲染 / 半选父容器 ============
// 6a. 移除未授权的「用户管理/角色权限」→ 基础资料面板中不再出现
const treePartial = JSON.parse(JSON.stringify(TREE_FULL));
treePartial.find((c) => c.menu_code === 'master').children =
  treePartial.find((c) => c.menu_code === 'master').children.filter((c) => c.menu_code !== 'users' && c.menu_code !== 'roles');
ERP.renderMenu(treePartial);
assert(walk(root, []).filter((e) => e.className === 'mega-item' && e.dataset.page === 'users').length === 0,
  '权限树不含「用户管理」时菜单不渲染该项');
assert(walk(root, []).filter((e) => e.className === 'mega-item' && e.dataset.page === 'roles').length === 0,
  '权限树不含「角色权限」时菜单不渲染该项');
// 6b. 仅授权「仓储客户」→ 基础资料主菜单仍渲染（半选容器），面板只有仓储客户
const treeHalf = JSON.parse(JSON.stringify(TREE_FULL));
treeHalf.find((c) => c.menu_code === 'master').children =
  treeHalf.find((c) => c.menu_code === 'master').children.filter((c) => c.menu_code === 'cust_wh');
ERP.renderMenu(treeHalf);
const navMaster = registry.nav.children.find((n) => n.dataset.cat === 'master');
assert(!!navMaster, '仅授权部分子菜单时主菜单仍渲染（容器）');
navMaster.dispatch('click', {});
const masterItems = walk(root, []).filter((e) => e.className === 'mega-item');
assert(masterItems.length === 1 && masterItems[0].dataset.page === 'cust_wh',
  '展开基础资料面板仅看到已授权的「仓储客户」');
assert(walk(root, []).filter((e) => e.className === 'mega-item' && e.dataset.page === 'shared').length === 0,
  '未授权子菜单完全不可见');
// 恢复全量树供后续使用
ERP.renderMenu(TREE_FULL);
assert(registry.nav.children.length === 4, '恢复全量树后菜单项数量正确');

console.log(failed === 0 ? '=== 全部通过 ===' : '=== 有 ' + failed + ' 项失败 ===');
process.exit(failed === 0 ? 0 : 1);
