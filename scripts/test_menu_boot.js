// ============================================================================
//  左侧菜单「启动链路」冒烟测试：用真实 /auth/me 数据 + DOM 桩执行 menu.js
//  用法：node scripts/test_menu_boot.js
//  等价覆盖浏览器刷新时最关键的几件事：
//   - 真实后端菜单树能否渲染出「日志中心」（含 6 个子菜单）
//   - 渲染链路是否产生 console.error / 未捕获异常（浏览器 Console 红色报错）
//   - 菜单版本号与缓存清理机制是否生效
//   - 后端 menus 漏发日志中心、但 permissions 已授权时的兜底是否生效且不越权
//  全程在数据库副本上运行，结束自动清理。
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.ERP_DB_PATH || path.join(ROOT, 'data', 'erp.db');
const TMP = path.join(ROOT, 'data', '_menu_boot_test.db');
function cleanup(closeDb) {
  // 必须先关闭 src/db 的连接，Windows 下才能删除临时副本
  if (closeDb) { try { require('../src/db')._raw.close(); } catch (_) { /* ignore */ } }
  try { fs.rmSync(TMP, { force: true }); } catch (_) { /* ignore */ }
}
cleanup(false);
fs.copyFileSync(SRC, TMP);
process.env.ERP_DB_PATH = TMP;

const menuService = require('../src/services/menuService');
const role = { role_id: 7, role_code: 'super_admin', role_name: '超级管理员' };
const menus = menuService.getMenuTree(role);
const permissions = menuService.permissionsOf(role);

// ---------------- DOM / Storage / Console 桩 ----------------
function makeStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] || null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toLowerCase(), className: '', dataset: {}, style: {},
    children: [], textContent: '', _html: '', listeners: {}, offsetHeight: 120,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 200, bottom: 800, width: 200, height: 800 }),
  };
  el.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
  return el;
}
const nav = makeEl('nav'), mega = makeEl('div');
const errors = [], warns = [], infos = [];
const sandbox = {
  console: {
    log() {}, info: (...a) => infos.push(a.join(' ')),
    warn: (...a) => warns.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')),
  },
  document: {
    getElementById: (id) => (id === 'nav' ? nav : id === 'mega' ? mega : null),
    createElement: makeEl,
    querySelector: () => makeEl('aside'),
    querySelectorAll: () => [],
    addEventListener() {},
  },
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  innerHeight: 900,
  addEventListener() {},
  requestAnimationFrame: (fn) => fn(),
  setTimeout: (fn) => fn(),
  clearTimeout() {},
};
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'menu.js'), 'utf8'), sandbox,
  { filename: 'menu.js' });
const ERP = sandbox.ERP;

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('PASS: ' + name); }
  catch (e) { console.error('FAIL: ' + name + ' → ' + e.message); failed++; }
}
const labels = () => nav.children.map((el) => {
  const m = /<span class="nav-lbl">([^<]*)<\/span>/.exec(el.innerHTML || '');
  return m ? m[1] : '';
});

t('真实 /auth/me 菜单树渲染出「日志中心」主菜单', () => {
  ERP.renderMenu(menus, { permissions, version: 3 });
  assert.ok(labels().includes('日志中心'), '实际渲染：' + JSON.stringify(labels()));
});
t('日志中心父菜单下含 6 个已授权子页面', () => {
  const logs = ERP._MENU_RUNTIME.find((c) => c.menu_code === 'logs');
  assert.ok(logs, '缺少 logs 容器');
  const paths = (logs.children || []).map((c) => c.path);
  ['log_customer', 'log_workhours', 'log_logistics', 'log_smartquote', 'log_system', 'log_all']
    .forEach((p) => assert.ok(paths.includes(p), '缺子菜单 ' + p));
});
t('渲染链路无 console.error / 无红色报错', () => {
  assert.deepEqual(errors, [], '控制台错误：' + JSON.stringify(errors));
  assert.ok(infos.some((s) => s.includes('日志中心')), '缺少菜单渲染诊断日志');
});
t('菜单版本号写入 localStorage，旧菜单缓存被强制清理', () => {
  assert.equal(sandbox.localStorage.getItem('erp_menu_version'), '3');
  sandbox.localStorage.setItem('erp_menu_cache', '{"stale":true}');
  sandbox.localStorage.setItem('erp_menu_version', '2');
  ERP.renderMenu(menus, { permissions, version: 3 });
  assert.equal(sandbox.localStorage.getItem('erp_menu_cache'), null, '旧菜单缓存未清理');
  assert.equal(sandbox.localStorage.getItem('erp_menu_version'), '3', '版本号未回写');
});
t('重复 renderMenu 不重复绑定全局事件', () => {
  const before = Object.keys(mega.listeners).length;
  ERP.renderMenu(menus, { permissions, version: 3 });
  assert.equal(Object.keys(mega.listeners).length, before);
});
t('后端 menus 漏发日志中心时按 permissions 兜底渲染（不越权）', () => {
  nav.innerHTML = '';
  ERP.renderMenu(menus.filter((c) => c.menu_code !== 'logs'), { permissions, version: 3 });
  assert.ok(labels().includes('日志中心'), '兜底未生效：' + JSON.stringify(labels()));
  assert.ok(warns.some((s) => s.includes('未返回「日志中心」')), '缺少兜底告警');
});
t('无权限时不凭空造出日志中心（RBAC 不被绕过）', () => {
  nav.innerHTML = '';
  ERP.renderMenu(menus.filter((c) => c.menu_code !== 'logs'), { permissions: ['dashboard'], version: 3 });
  assert.ok(!labels().includes('日志中心'));
});
t('menus 为 null / 异常形态时不抛异常', () => {
  assert.doesNotThrow(() => ERP.renderMenu(null, { permissions: [], version: 3 }));
  assert.doesNotThrow(() => ERP.renderMenu({ data: [] }, { permissions: [], version: 3 }));
});

cleanup(true);
console.log('\n=== 菜单渲染冒烟测试：' + (failed ? `失败 ${failed} 项` : '全部通过') + ' ===');
process.exit(failed ? 1 : 0);
