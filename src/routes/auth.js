// 认证路由：登录（返回菜单树+权限白名单）+ 首个管理员自助注册（仅当无用户时）
const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { auth, SECRET } = require('../middleware/auth');
const menuService = require('../services/menuService');

// JWT 只带身份标识，不带菜单列表（避免 token 膨胀、改权限需重登）；
// role 字段仅作旧客户端兼容显示，鉴权以 auth 中间件按 role_id 查库刷新为准。
function signToken(u) {
  return jwt.sign(
    { user_id: u.user_id, username: u.username, display_name: u.display_name, role: u.role_name, role_id: u.role_id },
    SECRET,
    { expiresIn: '12h' }
  );
}

// 组装登录/me 的统一返回体
function authPayload(u) {
  const role = { role_id: u.role_id, role_code: u.role_code, role_name: u.role_name };
  return {
    token: signToken(u),
    user: {
      user_id: u.user_id,
      username: u.username,
      display_name: u.display_name,
      role: u.role_name,
      role_id: u.role_id,
      role_code: u.role_code,
      data_scope: u.data_scope,
      is_readonly: u.is_readonly,
    },
    role_id: u.role_id,
    menus: menuService.getMenuTree(role),
    permissions: menuService.permissionsOf(role),
    menu_version: 7,   // 与 public/js/menu.js 的 ERP.MENU_SCHEMA_VERSION 保持一致
  };
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  const u = db
    .prepare(`SELECT u.*, r.role_name, r.role_code, r.data_scope, r.is_readonly
              FROM users u JOIN roles r ON r.role_id=u.role_id WHERE u.username=?`)
    .get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  res.json(authPayload(u));
});

// 仅当系统中尚无任何用户时允许注册首个超管；发布阶段已关闭
router.post('/register', (req, res) => {
  const cnt = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (cnt > 0) return res.status(403).json({ error: '系统已初始化，禁止自助注册' });
  const { username, password, display_name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  const hash = bcrypt.hashSync(password, 10);
  const roleId = db.prepare("SELECT role_id FROM roles WHERE role_code='super_admin'").get().role_id;
  const info = db
    .prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,?)')
    .run(username, hash, display_name || username, roleId);
  const u = db
    .prepare(`SELECT u.*, r.role_name, r.role_code, r.data_scope, r.is_readonly
              FROM users u JOIN roles r ON r.role_id=u.role_id WHERE u.user_id=?`)
    .get(info.lastInsertRowid);
  // 首个超管账号创建也是一次业务写入，纳入「系统/权限」日志（此时尚无登录态，显式传 user）
  require('../services/auditLog').writeLog(req, {
    table: 'users', module: '系统/权限', action: 'create', targetId: info.lastInsertRowid,
    user: { user_id: info.lastInsertRowid, username, display_name: display_name || username },
    after: { user_id: Number(info.lastInsertRowid), username, display_name: display_name || username, role: '超级管理员' },
  });
  res.json(authPayload(u));
});

router.get('/me', auth, (req, res) => {
  // 角色/菜单变更必须即时生效，禁止任何中间层缓存旧响应
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  // 以库内最新角色字段为准（权限/角色变更即时生效）
  const u = db
    .prepare(`SELECT u.user_id, u.username, u.display_name, u.role_id,
                     r.role_name, r.role_code, r.data_scope, r.is_readonly
              FROM users u JOIN roles r ON r.role_id=u.role_id WHERE u.user_id=?`)
    .get(req.user.user_id);
  if (!u) return res.status(401).json({ error: '用户不存在' });
  res.json(authPayload(u));
});

module.exports = router;
