// ============================================================================
// migrateExpressWaybill.js · 快递公司映射 + 电子面单类型（2026-11-20）
// ----------------------------------------------------------------------------
// 1. orders 表幂等新增 waybill_type（电子面单类型）—— 仅 ALTER TABLE ADD COLUMN，
//    绝不 DROP / 重建（永久数据安全规则）
// 2. 建 idx_orders_waybill 查询索引
// 3. app_settings 种子 express_map（STO/ZTO/YTO4/YTO5/SF/DBKD），已有配置不覆盖
// 4. 新增 menus「系统设置」(path=settings, 基础资料子菜单) 并授权超管/管理员
// 幂等：_erp_migrations fingerprint + INSERT OR IGNORE。
// ============================================================================

const FINGERPRINT_NAME = 'express_map_waybill_20261120';

const DEFAULT_EXPRESS_MAP = [
  { code: 'STO',  name: '申通快递' },
  { code: 'ZTO',  name: '中通快递' },
  { code: 'YTO4', name: '圆通快递4' },
  { code: 'YTO5', name: '圆通快递5' },
  { code: 'SF',   name: '顺丰' },
  { code: 'DBKD', name: '德邦快递' },
];

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
  const log = (...args) => { if (verbose) console.log('[express-waybill]', ...args); };
  if (isApplied(db)) { log('已迁移过，跳过'); return { skipped: true }; }

  // --- 1. orders.waybill_type 加列（幂等，只加不删）---
  const addedCols = [];
  if (tableExists(db, 'orders')) {
    const cols = db.prepare('PRAGMA table_info(orders)').all().map((r) => r.name);
    if (!cols.includes('waybill_type')) {
      db.exec('ALTER TABLE orders ADD COLUMN waybill_type TEXT');
      addedCols.push('waybill_type');
      log('orders 新增列: waybill_type');
    }
    // --- 2. 索引 ---
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_waybill ON orders(waybill_type, order_date)');
      log('索引 idx_orders_waybill 已就绪');
    } catch (e) { /* 忽略 */ }
  }

  // --- 3. app_settings 种子快递公司映射（已有配置不覆盖）---
  if (tableExists(db, 'app_settings')) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='express_map'").get();
    if (!row) {
      db.prepare("INSERT INTO app_settings (key,value) VALUES ('express_map',?)")
        .run(JSON.stringify(DEFAULT_EXPRESS_MAP));
      log('express_map 默认映射已写入（6 条）');
    } else {
      log('express_map 已存在，保持用户配置');
    }
  }

  // --- 4. 系统设置菜单（基础资料 → 系统）---
  if (tableExists(db, 'menus')) {
    const parent = db.prepare("SELECT menu_id FROM menus WHERE menu_code='master'").get();
    if (parent) {
      const exists = db.prepare("SELECT menu_id FROM menus WHERE menu_code='settings'").get();
      if (!exists) {
        // menu_id 取当前最大值 +1，避免与历史固定 id 冲突
        const maxId = db.prepare('SELECT COALESCE(MAX(menu_id),0) m FROM menus').get().m;
        const newId = Math.max(maxId + 1, 409);
        db.prepare(
          `INSERT OR IGNORE INTO menus (menu_id, menu_code, parent_id, menu_name, path, icon, group_name, sort, is_built, is_enabled)
           VALUES (?,?,?,?,?,?,?,?,1,1)`
        ).run(newId, 'settings', parent.menu_id, '系统设置', 'settings', '⚙️', '系统', 90);
        log(`menus 新增「系统设置」 menu_id=${newId}`);

        // 授权：超管 + 管理员角色
        if (tableExists(db, 'role_menus') && tableExists(db, 'roles')) {
          const roles = db.prepare(
            "SELECT role_id FROM roles WHERE role_code IN ('super_admin','admin') OR role_name IN ('超级管理员','管理员')"
          ).all();
          const rmIns = db.prepare('INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?,?)');
          roles.forEach((r) => rmIns.run(r.role_id, newId));
          log(`role_menus 授权 ${roles.length} 个角色`);
        }
      } else {
        log('「系统设置」菜单已存在，跳过');
      }
    }
  }

  markApplied(db);
  return { skipped: false, addedCols };
}

module.exports = { run, isApplied, DEFAULT_EXPRESS_MAP };
