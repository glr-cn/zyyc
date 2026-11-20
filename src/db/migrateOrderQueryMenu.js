// ============================================================================
// migrateOrderQueryMenu.js · 「数据看板」菜单更名「订单查询」（2026-11-20）
// ----------------------------------------------------------------------------
// 背景：地区看板模块正式重构为「订单查询」主模块（快递单号/省市区/日期多维检索），
//   地区看板降级为该页面内的辅助 Tab。侧边栏菜单名随之更新，让用户一眼看到主功能。
// 只 UPDATE menu_name / icon / group_name，不动 menu_id / menu_code / path / 权限
// （menu_code=order_dashboard 保持不变 → role_menus 授权零迁移、前端路由零变更）。
// 幂等：_erp_migrations fingerprint。
// ============================================================================

const FINGERPRINT_NAME = 'order_query_menu_rename_20261120';

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function ensureFingerprint(db) {
  if (!tableExists(db, '_erp_migrations')) {
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
function markApplied(db) {
  ensureFingerprint(db);
  db.prepare("INSERT OR IGNORE INTO _erp_migrations (name, applied_at) VALUES (?, datetime('now','localtime'))")
    .run(FINGERPRINT_NAME);
}

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[order-query-menu]', ...args); };
  if (isApplied(db)) { log('已迁移过，跳过'); return { skipped: true }; }

  if (!tableExists(db, 'menus')) { markApplied(db); return { skipped: true, reason: 'no_menus' }; }

  // 前置防御：菜单不存在（极旧库）→ 只打指纹跳过，避免报错阻断启动
  const exists = db.prepare("SELECT menu_id FROM menus WHERE menu_code='order_dashboard'").get();
  if (!exists) { markApplied(db); return { skipped: true, reason: 'menu_missing' }; }

  const info = db.prepare(
    "UPDATE menus SET menu_name='订单查询', icon='🔎', group_name='查询' WHERE menu_code='order_dashboard'"
  ).run();
  log(`menu_name 更新: ${info.changes} 行 (menu_id=${exists.menu_id})`);

  markApplied(db);
  return { skipped: false, updated: info.changes };
}

module.exports = { run, isApplied };
