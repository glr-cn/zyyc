// ============================================================================
// 移除出库/入库/库存菜单（2026-11-19）
// ----------------------------------------------------------------------------
// 背景：系统主菜单中的「出库」「入库」「库存」三个模块已从前端 UI、后端路由、
//       菜单种子文件中彻底删除。但线上数据库 menus / role_menus 仍存量数据
//       （menu_id 2/3/4 父菜单 + 101-111/201-207/301-303 共 21 个子菜单），
//       若不清理：
//         ① 左侧主菜单仍会显示这三项（前端 menu.js 是从 /api/menus 拉的）
//         ② 角色权限页还能看到「出库/入库/库存」复选框
//         ③ inventory_transactions 表本身不动——orders.js 自动 sale 出库流
//            水、audit_logs 审计映射、dbBackup 备份统计都还依赖这张表。
// ============================================================================

const FINGERPRINT_NAME = 'remove_stock_menus_20261119';

// 要删的菜单 ID 全集：3 父 + 21 子 = 24 个
const REMOVE_MENU_IDS = new Set([
  // 父菜单
  2, 3, 4,
  // 出库子菜单
  101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
  // 入库子菜单
  201, 202, 203, 204, 205, 206, 207,
  // 库存子菜单
  301, 302, 303,
]);

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function ensureFingerprintTable(db) {
  if (!tableExists(db, '_erp_migrations')) {
    db.exec(`CREATE TABLE _erp_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
  }
}

function isApplied(db) {
  ensureFingerprintTable(db);
  return !!db.prepare('SELECT 1 FROM _erp_migrations WHERE name=?').get(FINGERPRINT_NAME);
}

function markApplied(db) {
  ensureFingerprintTable(db);
  db.prepare("INSERT OR IGNORE INTO _erp_migrations (name, applied_at) VALUES (?, datetime('now','localtime'))")
    .run(FINGERPRINT_NAME);
}

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[remove-stock-menus]', ...args); };

  if (isApplied(db)) {
    log('已迁移过，跳过');
    return { skipped: true, reason: 'fingerprint' };
  }

  if (!tableExists(db, 'menus') || !tableExists(db, 'role_menus')) {
    log('menus/role_menus 表不存在，跳过（新库首次启动时 menu_seed.sql 本身不带这三个菜单）');
    markApplied(db);
    return { skipped: true, reason: 'no_tables' };
  }

  // 前置防御：如果 menus 表里已经没这三个父菜单了（上次已清，只是 fingerprint 没写），
  // 直接标记已应用
  const parentExists = db.prepare('SELECT COUNT(*) c FROM menus WHERE menu_id IN (?,?,?)').get(2, 3, 4).c;
  if (parentExists === 0) {
    log('父菜单已不存在，直接标记');
    markApplied(db);
    return { skipped: true, reason: 'already_removed' };
  }

  log('前置校验通过：父菜单仍存量，开始清理');

  const placeholders = Array(REMOVE_MENU_IDS.size).fill('?').join(',');
  const beforeCount = db.prepare('SELECT COUNT(*) c FROM menus WHERE menu_id IN (' + placeholders + ')')
    .get(...[...REMOVE_MENU_IDS]).c;
  log('迁移前存量菜单数:', beforeCount);

  // 也看一眼 role_menus 里有多少关联行
  let beforeRM = -1;
  try {
    beforeRM = db.prepare('SELECT COUNT(*) c FROM role_menus WHERE menu_id IN (' + placeholders + ')')
      .get(...[...REMOVE_MENU_IDS]).c;
    log('迁移前 role_menus 关联数:', beforeRM);
  } catch (e) { log('role_menus 查不了:', e.message); }

  db.exec('BEGIN');
  try {
    // ① 先删 role_menus 关联（有 FK 就先清，没有 FK 顺序无关）
    try {
      db.prepare('DELETE FROM role_menus WHERE menu_id IN (' + placeholders + ')').run(...[...REMOVE_MENU_IDS]);
    } catch (e) {
      log('删 role_menus 异常（可能表不存在或列名不对），忽略继续:', e.message);
    }

    // ② 再删 menus
    const info = db.prepare('DELETE FROM menus WHERE menu_id IN (' + placeholders + ')').run(...[...REMOVE_MENU_IDS]);
    log('DELETE 影响行数:', info.changes);

    // ③ 验证：父菜单应该全部消失
    const afterParent = db.prepare('SELECT COUNT(*) c FROM menus WHERE menu_id IN (?,?,?)').get(2, 3, 4).c;
    if (afterParent !== 0) {
      throw new Error('父菜单仍残留 ' + afterParent + ' 条');
    }
    const afterAll = db.prepare('SELECT COUNT(*) c FROM menus WHERE menu_id IN (' + placeholders + ')')
      .get(...[...REMOVE_MENU_IDS]).c;
    if (afterAll !== 0) {
      throw new Error('目标菜单仍残留 ' + afterAll + ' 条');
    }

    // ④ 验证：剩下的菜单 sort 顺序还是对的（不影响其他模块）
    const remainingMenus = db.prepare('SELECT menu_id, menu_code, parent_id, sort FROM menus ORDER BY parent_id IS NULL, sort').all();
    const parentMenus = remainingMenus.filter((m) => m.parent_id === null);
    log('清理后父菜单列表:', parentMenus.map((m) => m.menu_code + '(' + m.sort + ')').join(', '));

    markApplied(db);
    db.exec('COMMIT');
    log('迁移完成');
    return { skipped: false, beforeCount, removed: info.changes, beforeRM };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    log('ROLLBACK 原因:', err.message);
    throw err;
  }
}

module.exports = { run, isApplied };
