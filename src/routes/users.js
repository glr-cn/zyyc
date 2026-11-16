// 用户管理路由（阶段 5，仅管理员）
// 列表 / 新增 / 重置密码 / 删除；角色来自 roles 表（管理员/业务员/查看者）
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { roleGate } = require('../middleware/rbac');
const bcrypt = require('bcryptjs');

router.use(auth);
router.use(roleGate('管理员', '超级管理员')); // 仅管理员/超级管理员可访问用户管理

// 列表（不含密码）
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT u.user_id,u.username,u.display_name,r.role_name,u.created_at FROM users u JOIN roles r ON r.role_id=u.role_id ORDER BY u.user_id')
    .all();
  res.json({ data: rows });
});

// 新增用户
router.post('/', (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const display_name = String(b.display_name || '').trim() || username;
  const role_name = String(b.role_name || '');
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  // 角色来自 roles 表（RBAC：可配置角色）；超管角色仅超管可分配
  const role = db.prepare('SELECT role_id, role_code FROM roles WHERE role_name=?').get(role_name);
  if (!role) return res.status(400).json({ error: '角色非法' });
  if (role.role_code === 'super_admin' && req.user.role_code !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可创建超级管理员账号' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
    return res.status(409).json({ error: '用户名已存在' });
  }
  const roleId = role.role_id;
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,?)')
    .run(username, hash, display_name, roleId);
  // 用户管理审计（原先遗漏）：不记录密码/哈希
  require('../services/auditLog').writeLog(req, {
    table: 'users', module: '系统/权限', action: 'create', targetId: info.lastInsertRowid,
    after: { user_id: Number(info.lastInsertRowid), username, display_name, role_name },
  });
  res.status(201).json({ user_id: info.lastInsertRowid });
});

// 重置密码
router.put('/:id/password', (req, res) => {
  const id = req.params.id;
  const password = String((req.body || {}).password || '');
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const u = db.prepare('SELECT 1 FROM users WHERE user_id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  db.prepare('UPDATE users SET password_hash=? WHERE user_id=?').run(bcrypt.hashSync(password, 10), id);
  require('../services/auditLog').writeLog(req, {
    table: 'users', module: '系统/权限', action: 'update', targetId: id,
    content: { before: { password_hash: '***' }, after: { password_hash: '***' }, note: '重置密码（不记录明文与哈希）' },
  });
  res.json({ ok: true });
});

// 删除用户（不能删除自己）
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.user_id) return res.status(400).json({ error: '不能删除当前登录账号' });
  const before = db.prepare('SELECT user_id, username, display_name, role_id FROM users WHERE user_id=?').get(id);
  if (!before) return res.status(404).json({ error: '用户不存在' });
  db.prepare('DELETE FROM users WHERE user_id=?').run(id);
  require('../services/auditLog').writeLog(req, {
    table: 'users', module: '系统/权限', action: 'delete', targetId: id,
    before, after: { deleted: true },
  });
  res.json({ ok: true });
});

module.exports = router;
