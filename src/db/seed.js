// ============================================================
//  启动自举种子（幂等，仅 INSERT OR IGNORE，绝不改/删任何业务数据）
//  目的：
//   1) 让"全新库"在首次启动时自动补齐菜单 + 角色 + 超管授权，
//      这样即便未来把 data/ 移出部署包（避免发布覆盖线上库），线上也能自举可用；
//   2) 对已有数据的库完全无害（所有写都是 INSERT OR IGNORE / 条件 UPDATE）。
//  业务数据（customers / orders / logistics_quotes / work_hours …）一行都不动。
// ============================================================
const path = require('path');
const fs = require('fs');

function runSeed(db) {
  // ---- 菜单（INSERT OR IGNORE，幂等）----
  const seedSql = fs.readFileSync(path.join(__dirname, 'menu_seed.sql'), 'utf8');
  db.exec(seedSql);

  // ---- 角色（INSERT OR IGNORE）----
  db.exec(`
    INSERT OR IGNORE INTO roles (role_code, role_name, description, data_scope, is_readonly, is_system, sort)
    VALUES ('admin','管理员','系统管理角色（全部数据）','all',0,1,10),
           ('operator','业务员','仅本人负责的数据（行级隔离）','self',0,1,20),
           ('viewer','查看者','全局只读','all',1,1,30),
           ('super_admin','超级管理员','内置最高权限，默认拥有全部菜单','all',0,1,0);
  `);
  const superRole = db.prepare("SELECT role_id FROM roles WHERE role_code='super_admin'").get();
  if (!superRole) return; // 极端情况：角色表异常，交由 migrate_rbac 处理

  // ---- 超管 / 管理员 全量授权（INSERT OR IGNORE，新增菜单后自动补授权）----
  db.prepare(`INSERT OR IGNORE INTO role_menus (role_id, menu_id) SELECT ?, menu_id FROM menus`).run(superRole.role_id);
  const adminRole = db.prepare("SELECT role_id FROM roles WHERE role_code='admin'").get();
  if (adminRole) {
    db.prepare(`INSERT OR IGNORE INTO role_menus (role_id, menu_id) SELECT ?, menu_id FROM menus`).run(adminRole.role_id);
  }
  // 业务员：默认可访问「智能测算」（只读；历史测算已合并进该页，不再单独授权）
  const operatorRole = db.prepare("SELECT role_id FROM roles WHERE role_code='operator'").get();
  if (operatorRole) {
    db.prepare(`INSERT OR IGNORE INTO role_menus (role_id, menu_id)
      SELECT ?, menu_id FROM menus WHERE menu_code IN ('smart_quote')`).run(operatorRole.role_id);
  }

  // ---- 菜单重命名 / 清理（幂等，仅作用于配置行，绝不触碰业务数据） ----
  // 把「智能测单」重命名为「智能测算」，并删除已合并进该页的「历史测算」独立菜单项。
  // 之所以放在启动自举里：发布不覆盖线上库，线上菜单变更必须靠每次启动重跑这段来生效。
  db.exec(`UPDATE menus SET menu_name='智能测算', icon='🧮', group_name='测算' WHERE menu_code='smart_quote';`);
  db.exec(`DELETE FROM menus WHERE menu_code='smart_quote_history';`);
  // 「分列单号」页已上线：把历史库里 is_built=0 的占位行升级为可点击（幂等）
  db.exec(`UPDATE menus SET is_built=1, path='tool_split_no' WHERE menu_code='tool_split_no';`);
  db.exec(`UPDATE menus SET is_built=1, path='tool_barcode' WHERE menu_code='tool_barcode';`);

  // ---- 首个管理员账号（仅当无任何用户时自举；线上库自带 admin 不受影响）----
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
    try {
      const bcrypt = require('bcryptjs');
      db.prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,?)')
        .run('admin', bcrypt.hashSync('admin123', 10), 'admin', superRole.role_id);
    } catch (e) {
      console.warn('[seed] 创建首个管理员失败（bcryptjs 未安装？）：', e.message);
    }
  }
  // admin 账号若存在且非超管，迁移为超管（幂等，不改动其他字段）
  const admin = db.prepare("SELECT user_id, role_id FROM users WHERE username='admin'").get();
  if (admin && admin.role_id !== superRole.role_id) {
    db.prepare('UPDATE users SET role_id=? WHERE user_id=?').run(superRole.role_id, admin.user_id);
  }

  // 数据迁移菜单（data_migration）仅对 super_admin 可见，普通 admin 角色撤销授权
  // 安全理由：迁移涉及批量更新 + 回滚能力，仅限最高权限角色
  db.exec(`DELETE FROM role_menus WHERE role_id=(SELECT role_id FROM roles WHERE role_code='admin')
           AND menu_id=(SELECT menu_id FROM menus WHERE menu_code='data_migration')`);
}

module.exports = { runSeed };
