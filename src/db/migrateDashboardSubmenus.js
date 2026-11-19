// ============================================================================
// 看板（menu_id=1）新增 2 个子菜单，自动从直达变容器菜单
//   - 工时汇总 (menu_id=101, path=dash_wh_summary) —— 复用 dashboard.js 渲染逻辑
//   - 快递分析 (menu_id=102, path=dash_express) —— 占位（is_built=0）
// ----------------------------------------------------------------------------
// 设计：menu_id=1 保持 path='dashboard'（旧路由可用 + PERMS 白名单保留），
//       追加子菜单后前端 renderMenu 因有 children 自动渲染为容器（悬浮面板）。
//       原 #/dashboard 和 #/dash_wh_summary 两个入口均指向同一 dashboardPage 函数，
//       确保数据/计算/渲染 100% 一致。
// ============================================================================

const FINGERPRINT_NAME = 'dashboard_submenus_20261119';

function ensureFingerprint(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_erp_migrations'").get()) {
    db.exec(`CREATE TABLE _erp_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
  }
}
function isApplied(db) {
  ensureFingerprint(db);
  return !!db.prepare('SELECT 1 FROM _erp_migrations WHERE name=?').get(FINGERPRINT_NAME);
}

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[migrateDashboardSubmenus]', ...args); };

  if (isApplied(db)) {
    log('已迁移过，跳过');
    return { skipped: true };
  }

  // --- 1. menu_id=1 看板：保持 path='dashboard'，追加子菜单后自然变为容器 ---
  // 前端 renderMenu 逻辑：只要有 children（子菜单），就渲染为容器菜单（悬浮面板）。
  // 所以 menu_id=1 可以同时有 path='dashboard'（PERMS 白名单保留 'dashboard'）+ 子菜单。
  const kanban = db.prepare('SELECT * FROM menus WHERE menu_id=1').get();
  if (!kanban) {
    log('⚠ menu_id=1 不存在，跳过 parent 改动');
  } else if (kanban.path === 'dashboard') {
    log('menu_id=1 已是 path=dashboard，追加子菜单后自动变容器');
  } else if (kanban.path === null) {
    // 回滚：把 path 改回 dashboard，保持旧路由可用
    db.prepare("UPDATE menus SET path='dashboard' WHERE menu_id=1").run();
    log('menu_id=1 path NULL → dashboard（恢复旧路由）');
  } else {
    log(`menu_id=1 path='${kanban.path}'，保留不动`);
  }

  // --- 2. 插入子菜单（幂等 INSERT OR IGNORE）---
  const ins = db.prepare(
    'INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES (?,?,?,?,?,?,?,?,?)'
  );

  const childRows = [
    [101, 'dash_wh_summary', 1, '工时汇总', 'dash_wh_summary', '📈', '看板', 10, 1],
    [102, 'dash_express',    1, '快递分析', 'dash_express',    '📦', '看板', 20, 0],
  ];

  let added = 0;
  for (const row of childRows) {
    const info = ins.run(...row);
    if (info.changes > 0) added++;
    log(`菜单 (${row[0]}) ${row[3]} ${info.changes ? '新增' : '已存在'}`);
  }

  // --- 3. 自动授权：把新菜单挂到所有现有角色的 role_menus ---
  // 超级管理员（role_code=admin）必须有；其他角色有看板权限的也给
  const roles = db.prepare('SELECT role_id FROM roles').all();
  const roleMenuIns = db.prepare('INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?,?)');
  for (const r of roles) {
    for (const row of childRows) {
      roleMenuIns.run(r.role_id, row[0]);
    }
  }
  log(`已为 ${roles.length} 个角色挂载新菜单权限`);

  // --- 4. 标记迁移完成 ---
  ensureFingerprint(db);
  db.prepare("INSERT OR IGNORE INTO _erp_migrations (name, applied_at) VALUES (?, datetime('now','localtime'))")
    .run(FINGERPRINT_NAME);

  log(`迁移完成：看板子菜单新增 ${added}/${childRows.length} 条`);
  return { skipped: false, added };
}

module.exports = { run, isApplied };
