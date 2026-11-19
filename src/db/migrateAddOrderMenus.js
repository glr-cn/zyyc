// ============================================================================
// migrateAddOrderMenus.js · 新增订单导入 + 数据看板菜单（2026-11-19）
// ----------------------------------------------------------------------------
// 新增 menus:
//   702 order_import  单据(7) 子菜单 · 导入 分组 · path=order_import
//   703 order_dashboard 单据(7) 子菜单 · 分析 分组 · path=order_dashboard
// 同时给超级管理员自动授予 role_menus 权限（新菜单上线后超管立即可见）。
// 幂等：INSERT OR IGNORE + _erp_migrations fingerprint。
// ============================================================================

const FINGERPRINT_NAME = 'add_order_menus_20261119';

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
  const log = (...args) => { if (verbose) console.log('[order-menus]', ...args); };
  if (isApplied(db)) { log('已迁移过，跳过'); return { skipped: true }; }

  if (!tableExists(db, 'menus')) { markApplied(db); return { skipped: true, reason: 'no_menus' }; }

  db.exec('BEGIN');
  try {
    // 1. 新增两个菜单（INSERT OR IGNORE 幂等）
    const menuIns = db.prepare(
      `INSERT OR IGNORE INTO menus (menu_id, menu_code, parent_id, menu_name, path, icon, group_name, sort, is_built)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    const m1 = menuIns.run(702, 'order_import', 7, '订单导入', 'order_import',
      '📤', '导入', 20, 1);
    const m2 = menuIns.run(703, 'order_dashboard', 7, '数据看板', 'order_dashboard',
      '📊', '分析', 30, 1);
    log(`menus: 702=${m1.changes}, 703=${m2.changes}`);

    // 2. 给超级管理员角色自动授权 role_menus（若该表存在）
    if (tableExists(db, 'role_menus') && tableExists(db, 'roles')) {
      const superRole = db.prepare(
        "SELECT role_id FROM roles WHERE role_code='super_admin' OR role_name='超级管理员'"
      ).get();
      if (superRole) {
        const rmIns = db.prepare('INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?,?)');
        const r1 = rmIns.run(superRole.role_id, 702);
        const r2 = rmIns.run(superRole.role_id, 703);
        log(`role_menus: 702=${r1.changes}, 703=${r2.changes} (role_id=${superRole.role_id})`);
      } else {
        log('⚠️ 未找到超级管理员角色，role_menus 跳过（角色数据初始化后再补）');
      }
    }

    db.exec('COMMIT');
    markApplied(db);
    log('完成');
    return { skipped: false, m1: m1.changes, m2: m2.changes };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

module.exports = { run, isApplied };
