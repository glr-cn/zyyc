// ============================================================
//  RBAC 迁移脚本（幂等，可重复执行）
//  用法：node scripts/migrate_rbac.js   （ERP_DB_PATH 可指定库文件）
//  步骤：
//   1) roles 缺 role_code 列时重建：数据副本 → DROP → 新结构 → 回迁
//      （旧「管理员/业务员/查看者」保留为可配置角色，业务员 self / 查看者只读语义入字段）
//   2) 创建 menus / role_menus（IF NOT EXISTS）
//   3) 执行 menu_seed.sql（INSERT OR IGNORE，幂等）
//   4) 确保 super_admin 角色存在；admin 账号迁移挂 super_admin；超管全量授权
//  说明：不走 src/db（避免旧库缺列时 schema.sql 其他索引报错），直接开库。
// ============================================================
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { guardDestructive } = require('../src/db/safety');

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
if (!fs.existsSync(DB_PATH)) {
  // 全新库：先建文件并执行完整 schema.sql（customers/orders/work_hours 等业务表）
  console.log('[migrate] 数据库不存在，新建并执行 schema.sql：' + DB_PATH);
  const fresh = new DatabaseSync(DB_PATH);
  fresh.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  fresh.close();
}

const db = new DatabaseSync(DB_PATH);

// ---------- 1) roles 重建（仅当缺 role_code 列） ----------
const roleCols = db.prepare("PRAGMA table_info(roles)").all().map((c) => c.name);
if (!roleCols.includes('role_code')) {
  // 铁律护栏：重建前必须先整库备份 + ALLOW_DB_DROP=1 显式确认
  guardDestructive(DB_PATH, 'rebuild roles（DROP 旧表）');
  console.log('[migrate] roles 缺 role_code，开始重建…');
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE roles_legacy AS SELECT role_id, role_name FROM roles;
    DROP TABLE roles;
    CREATE TABLE roles (
      role_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      role_code   TEXT NOT NULL UNIQUE,
      role_name   TEXT NOT NULL UNIQUE,
      description TEXT,
      data_scope  TEXT NOT NULL DEFAULT 'all',
      is_readonly INTEGER NOT NULL DEFAULT 0,
      is_system   INTEGER NOT NULL DEFAULT 0,
      sort        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO roles (role_id, role_code, role_name, description, data_scope, is_readonly, is_system, sort)
    SELECT role_id,
           CASE role_name WHEN '管理员' THEN 'admin' WHEN '业务员' THEN 'operator' ELSE 'viewer' END,
           role_name, '由旧版角色迁移',
           CASE role_name WHEN '业务员' THEN 'self' ELSE 'all' END,
           CASE role_name WHEN '查看者' THEN 1 ELSE 0 END,
           1, role_id * 10
    FROM roles_legacy;
    DROP TABLE roles_legacy;
    COMMIT;
  `);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length) {
    console.error('[migrate] 外键校验失败：', JSON.stringify(fk));
    process.exit(1);
  }
  console.log('[migrate] roles 重建完成，旧角色已保留');
} else {
  console.log('[migrate] roles 结构已是新版，跳过重建');
}

// ---------- 2) menus / role_menus ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS menus (
    menu_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_code  TEXT NOT NULL UNIQUE,
    parent_id  INTEGER REFERENCES menus(menu_id) ON DELETE CASCADE,
    menu_name  TEXT NOT NULL,
    path       TEXT UNIQUE,
    icon       TEXT,
    group_name TEXT,
    sort       INTEGER NOT NULL DEFAULT 0,
    is_built   INTEGER NOT NULL DEFAULT 1,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS role_menus (
    role_id INTEGER NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    menu_id INTEGER NOT NULL REFERENCES menus(menu_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, menu_id)
  );
  CREATE INDEX IF NOT EXISTS idx_menu_par ON menus(parent_id, sort);
  CREATE INDEX IF NOT EXISTS idx_rm_menu  ON role_menus(menu_id);
`);
console.log('[migrate] menus / role_menus 就绪');

// ---------- 3) 菜单种子（幂等） ----------
const seedSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'menu_seed.sql'), 'utf8');
db.exec(seedSql);
console.log('[migrate] 菜单种子已应用：'
  + db.prepare('SELECT COUNT(*) c FROM menus').get().c + ' 条菜单');

// ---------- 4) super_admin + admin 迁移 + 全量授权 ----------
// 种子角色：旧三角色保留为可配置角色（业务员行级隔离 / 查看者只读语义入字段）
db.exec(`
  INSERT OR IGNORE INTO roles (role_code, role_name, description, data_scope, is_readonly, is_system, sort)
  VALUES ('admin','管理员','系统管理角色（全部数据）','all',0,1,10),
         ('operator','业务员','仅本人负责的数据（行级隔离）','self',0,1,20),
         ('viewer','查看者','全局只读','all',1,1,30),
         ('super_admin','超级管理员','内置最高权限，默认拥有全部菜单','all',0,1,0);
`);
const superRole = db.prepare("SELECT role_id FROM roles WHERE role_code='super_admin'").get();
// 全新库无用户：创建首个 admin（开发自举；线上库自带 admin 不受影响）
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const bcrypt = require('bcryptjs');
  // ★ 修复 M16（保守）：自举密码优先取环境变量 ERP_BOOTSTRAP_PASS，
  //   未设置时仍用 admin123 保证可启动，并打印改密警告。
  const bootstrapPass = process.env.ERP_BOOTSTRAP_PASS || 'admin123';
  db.prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,?)')
    .run('admin', bcrypt.hashSync(bootstrapPass, 10), 'admin', superRole.role_id);
  if (bootstrapPass === 'admin123') {
    console.warn('[migrate] ⚠️ 安全警告：首个管理员使用默认口令 admin123，请登录后立即改密；');
    console.warn('[migrate]    或设置环境变量 ERP_BOOTSTRAP_PASS 指定强口令。');
  } else {
    console.log('[migrate] 全新库：已创建首个管理员 admin（口令取自 ERP_BOOTSTRAP_PASS）');
  }
}
// admin 账号迁移到 super_admin（仅当当前不是超管）
const admin = db.prepare("SELECT user_id, role_id FROM users WHERE username='admin'").get();
if (admin && admin.role_id !== superRole.role_id) {
  db.prepare('UPDATE users SET role_id=? WHERE user_id=?').run(superRole.role_id, admin.user_id);
  console.log('[migrate] admin 账号已迁移为超级管理员');
}
// 超管全量授权（INSERT OR IGNORE：新增菜单后重跑即可补授权）
const n = db.prepare(`
  INSERT OR IGNORE INTO role_menus (role_id, menu_id)
  SELECT ?, menu_id FROM menus
`).run(superRole.role_id);
console.log('[migrate] 超管授权增量：' + (n.changes || 0) + ' 条');

// 管理员角色等同超管权限组：全量授权（与 roles 角色定义一致），使其左侧可见全部菜单
const adminRole = db.prepare("SELECT role_id FROM roles WHERE role_code='admin'").get();
if (adminRole) {
  const a = db.prepare(`INSERT OR IGNORE INTO role_menus (role_id, menu_id) SELECT ?, menu_id FROM menus`).run(adminRole.role_id);
  console.log('[migrate] 管理员角色授权增量：' + (a.changes || 0) + ' 条');
}

// 业务员：默认可访问「智能测算」（可查看配置与历史明细；
//   配置写操作由后端 roleGate 限制为管理员/超管，业务员仅只读）
const operatorRole = db.prepare("SELECT role_id FROM roles WHERE role_code='operator'").get();
if (operatorRole) {
  const o = db.prepare(`INSERT OR IGNORE INTO role_menus (role_id, menu_id)
    SELECT ?, menu_id FROM menus WHERE menu_code IN ('smart_quote')`).run(operatorRole.role_id);
  console.log('[migrate] 业务员授权增量（智能测算）：' + (o.changes || 0) + ' 条');
}

// 菜单重命名 / 清理（幂等，配置行非业务数据）：
// 把「智能测单」重命名为「智能测算」，并删除已合并进该页的「历史测算」独立菜单项。
db.exec(`UPDATE menus SET menu_name='智能测算', icon='🧮', group_name='测算' WHERE menu_code='smart_quote';`);
db.exec(`DELETE FROM menus WHERE menu_code='smart_quote_history';`);
console.log('[migrate] 菜单重命名/清理：智能测单→智能测算，删除历史测算独立项');

// ---------- 汇总 ----------
const roles = db.prepare('SELECT role_id, role_code, role_name, data_scope, is_readonly, is_system FROM roles ORDER BY sort').all();
console.log('角色：', JSON.stringify(roles));
console.log('菜单：', db.prepare('SELECT COUNT(*) c FROM menus').get().c,
  '条；授权关系：', db.prepare('SELECT COUNT(*) c FROM role_menus').get().c, '条');
db.close();
console.log('=== RBAC 迁移完成 ===');
