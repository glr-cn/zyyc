// 页面渲染冒烟测试：真实加载 7 个页面模块并渲染，捕获“元素尚未渲染就被查询”一类错误
// 用法：node scripts/test_pages.js
'use strict';

// ---------------- DOM 桩（支持 HTML 解析 / #id / .class 查询 / 属性） ----------------
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toLowerCase(), className: '', id: '', dataset: {}, attrs: {},
    style: {}, children: [], parent: null, textContent: '', _html: '', listeners: {},
    value: '', files: [], disabled: false, checked: false, selected: false,
    offsetWidth: 160, offsetHeight: 120,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; this.children = []; parseHTML(v, this); },
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
    setAttribute(n, v) {
      this.attrs[n] = String(v);
      if (n.startsWith('data-')) {
        this.dataset[n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
      }
    },
    getAttribute(n) { return this.attrs[n]; },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
    contains() { return false; },
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 800, width: 200, height: 800 }; },
  };
  const clsOf = (e) => (e.className || '').split(/\s+/).filter(Boolean);
  el.classList = {
    add: (c) => { const a = clsOf(el); if (!a.includes(c)) { a.push(c); el.className = a.join(' '); } },
    remove: (c) => { el.className = clsOf(el).filter((x) => x !== c).join(' '); },
    contains: (c) => clsOf(el).includes(c),
    toggle: (c, f) => {
      const has = clsOf(el).includes(c);
      if (f === undefined) { has ? el.classList.remove(c) : el.classList.add(c); }
      else { f ? el.classList.add(c) : el.classList.remove(c); }
    },
  };
  return el;
}

function matchSel(el, sel) {
  const m = sel.match(/^(?:([\w-]+)|#([\w-]+))?((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/);
  if (!m) return false;
  const [, tag, id, classes, attr, val] = m;
  if (tag && el.tagName !== tag.toLowerCase()) return false;
  if (id && el.id !== id) return false;
  if (classes) {
    const own = (el.className || '').split(/\s+/);
    if (!classes.split('.').filter(Boolean).every((c) => own.includes(c))) return false;
  }
  if (attr) {
    const key = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (el.dataset[key] !== val) return false;
  }
  return true;
}
function walk(node, out) {
  node.children.forEach((c) => { out.push(c); walk(c, out); });
  return out;
}
function queryAll(root, sel) {
  const sels = String(sel).split(',').map((s) => s.trim());
  return walk(root, []).filter((e) => sels.some((s) => matchSel(e, s)));
}

// 极简 HTML 解析器
function parseHTML(html, into) {
  const stack = [into];
  const re = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)(\/?)>/g;
  let last = 0, m;
  const VOID = ['input', 'br', 'img', 'hr', 'meta', 'link'];
  while ((m = re.exec(html))) {
    const raw = html.slice(last, m.index);
    if (raw.trim()) {
      const t = stack[stack.length - 1];
      t.textContent = (t.textContent || '') + raw.trim();
    }
    last = re.lastIndex;
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (m[0].charAt(1) === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = makeEl(tag);
    const ar = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = ar.exec(attrs))) {
      const name = a[1];
      const val = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''));
      if (name === 'class') el.className = val;
      else if (name === 'id') { el.id = val; el.setAttribute('id', val); }
      else if (name === 'value') { el.value = val; el.setAttribute('value', val); }
      else if (name === 'disabled') { el.disabled = true; el.setAttribute('disabled', ''); }
      else if (name === 'checked') { el.checked = true; el.setAttribute('checked', ''); }
      else if (name === 'selected') { el.selected = true; el.setAttribute('selected', ''); }
      else el.setAttribute(name, val);
    }
    stack[stack.length - 1].appendChild(el);
    if (!VOID.includes(tag) && m[3] !== '/') stack.push(el);
  }
  return into;
}

const root = makeEl('html');
const body = makeEl('body');
root.appendChild(body);
const registry = { content: makeEl('div') };
body.appendChild(registry.content);

global.window = global;
global.innerWidth = 1400;
global.innerHeight = 900;
global.document = {
  body,
  createElement: makeEl,
  getElementById: (id) => queryAll(root, '#' + id)[0] || null,
  querySelector: (sel) => queryAll(root, sel)[0] || null,
  querySelectorAll: (sel) => queryAll(root, sel),
  addEventListener: () => {},
  removeEventListener: () => {},
};
global.requestAnimationFrame = (fn) => fn();
global.confirm = () => false;
global.alert = () => {};
global.prompt = () => null;
global.FormData = class { append() {} };
global.Blob = class {};
global.URL.createObjectURL = () => 'blob:x';
global.URL.revokeObjectURL = () => {};

// API 桩：返回各页面所需的最小数据结构
const CARGO = {
  'customers': { data: [
    { customer_id: 1, customer_code: 'C0001', customer_name: '甲公司', owner_name: '甲货主', status: '启用', safety_stock: 0 },
  ], total: 1 },
  'workhours': { data: [
    { work_id: 1, date: '2026-11-10', customer_name: '甲货主', unit: '件', ship_orders: 100, main_hours: 10, other_hours: 2, shared_hours: 3, total_hours: 15, efficiency: 10, unit_cost: 0.15 },
  ], total: 1, page: 1, pageSize: 20 },
  'analytics/summary': { mode: 'month', table: [], periods: [], chart1: { type: 'unit_cost', labels: [], values: [] }, chart2: { labels: [], main: [], other: [], shared: [] } },
  'analytics/dashboard': { month: '2026-11', month_ship_qty: 100, avg_unit_cost: 0.15, shared_ratio: 0.2, owner_rank: { top3: [], bottom3: [] } },
  'inventory/warnings': { data: [], count: 0 },
  'inventory/ledger': { data: [], total: 0 },
  'users': { data: [], total: 0 },
  'customers/active': { data: [{ owner_name: '甲货主' }] },
};
global.API = {
  token: 'test-token',
  get: async (url) => {
    global.__lastApiUrl = String(url);
    const key = Object.keys(CARGO).find((k) => String(url).indexOf(k) >= 0);
    return CARGO[key] || { data: [], total: 0 };
  },
  post: async () => ({ data: {} }),
  put: async () => ({ data: {} }),
  req: async () => ({ data: {} }),
};
global.ERP_USER = { user_id: 1, username: 'admin', role: '管理员' };

// 加载页面模块
// 说明：charts.js 用顶层 const 声明 Charts，浏览器经典脚本共享全局词法环境故可见，
//      Node 的 CommonJS 包装不可见 → 用 vm 在全局上下文执行以还原浏览器行为。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
['customers', 'orders', 'inventory', 'workhours', 'analytics', 'dashboard', 'users', 'roles', 'log-center'].forEach((f) => {
  require('../public/js/' + f + '.js');
});
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'charts.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'permission-tree.js'), 'utf8'));

const PAGES = [
  { page: 'customers', expect: ['searchInput', 'searchBtn', 'addBtn'] },
  { page: 'orders', expect: ['dlOrderTpl', 'upOrder', 'orderResult'] },
  { page: 'inventory', expect: ['ownerFilter', 'qryBtn', 'refreshBtn', 'warnBox', 'ledgerBody'] },
  { page: 'wh_lh', wh: '龙湖仓', expect: ['typeTabs', 'q', 'dateFrom', 'dateTo', 'trend', 'qryBtn', 'resetBtn', 'addBtn', 'whHead', 'whBody', 'pager'] },
  { page: 'wh_jx', wh: '佳新仓', expect: ['typeTabs', 'q', 'dateFrom', 'dateTo', 'trend', 'qryBtn', 'resetBtn', 'addBtn', 'whHead', 'whBody', 'pager'] },
  { page: 'wh_sy', wh: '速远仓', expect: ['typeTabs', 'q', 'dateFrom', 'dateTo', 'trend', 'qryBtn', 'resetBtn', 'addBtn', 'whHead', 'whBody', 'pager'] },
  { page: 'wh_ky', wh: '开元仓', expect: ['typeTabs', 'q', 'dateFrom', 'dateTo', 'trend', 'qryBtn', 'resetBtn', 'addBtn', 'whHead', 'whBody', 'pager'] },
  { page: 'analytics', expect: ['mode', 'warehouse', 'work_type', 'from', 'to', 'qryBtn', 'resetBtn', 'sumBody', 'chart1', 'chart2'] },
  { page: 'dashboard', expect: ['dashMonth', 'refreshBtn', 'kpiRow', 'kpiShip', 'kpiCost', 'kpiShare', 'topBody', 'bottomBody'] },
  { page: 'users', expect: ['addBtn', 'userBody'] },
  { page: 'roles', expect: ['roleAddBtn', 'roleBody', 'permRoleName', 'permTree', 'permAllBtn', 'permClearBtn', 'permSaveBtn'] },
  // 日志中心 6 个子页面共用同一工厂，逐个渲染校验查询条件与分页元素
  ...['log_customer', 'log_workhours', 'log_logistics', 'log_smartquote', 'log_system', 'log_all'].map((page) => ({
    page, expect: ['opSel', 'dateFrom', 'dateTo', 'actSel', 'logQ', 'qryBtn', 'resetBtn', 'prevBtn', 'nextBtn'],
  })),
];

let failed = 0;
function assert(c, m) {
  if (!c) { console.error('FAIL: ' + m); failed++; } else console.log('PASS: ' + m);
}

(async function () {
  for (const p of PAGES) {
    const host = makeEl('div');
    host.className = 'page-view';
    registry.content.appendChild(host);
    let err = null;
    try {
      global.ERP_PAGES[p.page](host);
    } catch (e) {
      err = e;
    }
    assert(!err, p.page + '：页面渲染未抛异常' + (err ? ' → ' + err.message : ''));
    if (err) continue;
    // 等待异步渲染完成后再校验元素
    await new Promise((r) => setTimeout(r, 20));
    const missing = p.expect.filter((id) => !host.querySelector('#' + id));
    assert(missing.length === 0, p.page + '：关键元素齐全' + (missing.length ? '（缺 ' + missing.join(',') + '）' : ''));
    if (p.page.indexOf('wh_') === 0) {
      assert(!host.querySelector('#whTabs'), p.page + '：页内仓库切换 Tabs 已删除');
      const title = host.querySelector('.wh-page-title');
      const tag = host.querySelector('.wh-title-tag');
      assert(title && tag && tag.textContent === p.wh && title.textContent.indexOf('工时管理') >= 0,
        p.page + '：页面大标题显示仓库名「' + p.wh + ' - 工时管理」');
      assert((global.__lastApiUrl || '').includes('warehouse=' + encodeURIComponent(p.wh)),
        p.page + '：查询严格按锁定仓库（' + p.wh + '）过滤');
    }
  }
  console.log(failed === 0 ? '=== 全部通过 ===' : '=== 有 ' + failed + ' 项失败 ===');
  process.exit(failed === 0 ? 0 : 1);
})();
