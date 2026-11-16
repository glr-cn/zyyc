// ============================================================================
//  左侧菜单渲染诊断（只读）：定位「日志中心」为何不显示
//  用法：node scripts/diagnose_menu.js   （ERP_DB_PATH 可指定库）
//  依次检查：菜单种子 → 角色绑定 → 菜单树/权限白名单 → 前端三处注册表一致性
// ============================================================================
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB = process.env.ERP_DB_PATH || path.join(ROOT, 'data', 'erp.db');
const LOG_CODES = ['logs', 'log_customer', 'log_workhours', 'log_logistics', 'log_smartquote', 'log_system', 'log_all'];
const LOG_PATHS = LOG_CODES.slice(1);

const db = new DatabaseSync(DB, { readOnly: true });
const line = (s) => console.log(s);

line('=== 1. menus 表中的日志中心 ===');
const menus = db.prepare("SELECT menu_id, menu_code, parent_id, menu_name, path, is_built, is_enabled, sort FROM menus WHERE menu_code IN (" + LOG_CODES.map(() => '?').join(',') + ") ORDER BY menu_id").all(...LOG_CODES);
line('  找到 ' + menus.length + ' / 7 条：' + JSON.stringify(menus));

line('\n=== 2. role_menus 绑定 ===');
const binds = db.prepare(`SELECT r.role_id, r.role_code, r.role_name, rm.menu_id
  FROM roles r LEFT JOIN role_menus rm ON rm.role_id=r.role_id AND rm.menu_id IN (8,801,802,803,804,805,806)
  ORDER BY r.role_id`).all();
const grouped = {};
binds.forEach((b) => { (grouped[b.role_code] = grouped[b.role_code] || []).push(b.menu_id); });
Object.keys(grouped).forEach((k) => line('  ' + k + ' → 已绑定日志菜单ID: ' + JSON.stringify(grouped[k])));

line('\n=== 3. 当前 admin 账号的角色 ===');
line('  ' + JSON.stringify(db.prepare(`SELECT u.user_id, u.username, u.role_id, r.role_code, r.role_name
  FROM users u JOIN roles r ON r.role_id=u.role_id WHERE u.username='admin'`).get()));

line('\n=== 4. 模拟 /auth/me 返回（menuService） ===');
db.close();
const menuService = require('../src/services/menuService');
const roles = require('../src/db')._raw.prepare('SELECT role_id, role_code, role_name FROM roles ORDER BY role_id').all();
roles.forEach((role) => {
  const tree = menuService.getMenuTree(role);
  const perms = menuService.permissionsOf(role);
  line('  ' + role.role_code + ' → 顶级菜单: ' + JSON.stringify(tree.map((x) => x.menu_name)));
  line('    含日志中心: ' + tree.some((x) => x.menu_code === 'logs')
    + '；其下子项: ' + JSON.stringify((tree.find((x) => x.menu_code === 'logs') || { children: [] }).children.map((c) => c.path)));
  line('    log_* 权限数: ' + perms.filter((p) => LOG_PATHS.includes(p)).length + '/' + LOG_PATHS.length);
});

line('\n=== 5. 前端三处注册一致性 ===');
const tabs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'tabs.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'public', 'js', 'log-center.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
LOG_PATHS.forEach((p) => {
  const inMeta = new RegExp('\\b' + p + '\\s*:\\s*\\{').test(tabs);
  const inPages = page.includes("page: '" + p + "'");
  line('  ' + p + ' → PAGE_META:' + inMeta + '  ERP_PAGES:' + inPages);
});
line('  app.html 引入 log-center.js: ' + html.includes('js/log-center.js'));
line('  app.html 引入顺序在 app.js 之前: ' + (html.indexOf('js/log-center.js') < html.indexOf('js/app.js')));
line('  前端菜单缓存(localStorage/sessionStorage 中的 menus): ' +
  (/(localStorage|sessionStorage).*(menu|menus)|(menu|menus).*(localStorage|sessionStorage)/i.test(
    fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public', 'js', 'menu.js'), 'utf8'))
    ? '存在' : '不存在（每次刷新都重新请求 /auth/me）'));

line('\n=== 诊断结束 ===');
process.exit(0);
