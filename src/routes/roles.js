// 角色管理路由（RBAC）：角色 CRUD + 权限分配（父子收敛）
// 权限门槛：角色管理操作需「角色权限」菜单授权；/options 供用户管理下拉（需「用户管理」或「角色权限」授权）
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { menuGate } = require('../middleware/rbac');
const menuService = require('../services/menuService');

router.use(auth);

// 写审计日志：统一走全局日志服务（新旧字段双写，模块=系统/权限）
function writeAudit(req, action, recordId, before, after) {
  require('../services/auditLog').writeLog(req, {
    table: 'roles', module: '系统/权限', action,
    targetId: recordId, before, after,
  });
}

// 角色下拉选项（用户管理页用）：超管角色仅超管可见
router.get('/options', (req, res) => {
  const isSuper = req.user.role_code === 'super_admin';
  const rows = db
    .prepare(isSuper
      ? 'SELECT role_id, role_name, role_code FROM roles ORDER BY sort, role_id'
      : "SELECT role_id, role_name, role_code FROM roles WHERE role_code!='super_admin' ORDER BY sort, role_id")
    .all();
  res.json({ data: rows });
});

// 角色列表（含用户数与已授权菜单数）
router.get('/', menuGate('roles'), (req, res) => {
  const rows = db
    .prepare(`SELECT r.role_id, r.role_code, r.role_name, r.description, r.data_scope,
                     r.is_readonly, r.is_system, r.sort,
                     (SELECT COUNT(*) FROM users u WHERE u.role_id=r.role_id) AS user_count,
                     (SELECT COUNT(*) FROM role_menus rm WHERE rm.role_id=r.role_id) AS menu_count
              FROM roles r ORDER BY r.sort, r.role_id`)
    .all();
  res.json({ data: rows });
});

// 新增角色（角色名称 / 角色描述 / 可选数据范围与只读标记）
router.post('/', menuGate('roles'), (req, res) => {
  try {
    const b = req.body || {};
    const role_name = String(b.role_name || '').trim();
    if (!role_name) return res.status(400).json({ error: '角色名称必填', message: '角色名称必填' });
    if (db.prepare('SELECT 1 FROM roles WHERE role_name=?').get(role_name)) {
      return res.status(409).json({ error: '角色名称已存在', message: '角色名称已存在' });
    }
    // role_code 由后端自动生成（表单无需填写），保证 NOT NULL UNIQUE 约束始终满足
    const role_code = 'custom_' + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
    const info = db
      .prepare(`INSERT INTO roles (role_code, role_name, description, data_scope, is_readonly, is_system)
                VALUES (?,?,?,?,?,0)`)
      .run(role_code, role_name, String(b.description || '').trim() || null,
        b.data_scope === 'self' ? 'self' : 'all', b.is_readonly ? 1 : 0);
    const row = db.prepare('SELECT * FROM roles WHERE role_id=?').get(info.lastInsertRowid);
    writeAudit(req, 'create', row.role_id, null, { role_code: row.role_code, role_name: row.role_name });
    res.status(201).json({ data: row });
  } catch (error) {
    // 打印后端真实报错并返回 JSON（而非 Express 默认 HTML 页），前端可直接展示具体原因
    console.error('新增角色失败:', error);
    res.status(500).json({ error: '新增角色失败：' + error.message, message: error.message });
  }
});

// 编辑角色：内置角色仅允许改描述（角色名被前端权限判断/行级隔离语义引用，禁止改动）
router.put('/:id', menuGate('roles'), (req, res) => {
  const old = db.prepare('SELECT * FROM roles WHERE role_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '角色不存在' });
  const b = req.body || {};
  if (old.is_system) {
    const description = String(b.description == null ? old.description : b.description).trim() || null;
    if (b.role_name && b.role_name !== old.role_name) {
      return res.status(403).json({ error: '内置角色不可修改角色名称' });
    }
    db.prepare("UPDATE roles SET description=?, updated_at=datetime('now','localtime') WHERE role_id=?")
      .run(description, old.role_id);
  } else {
    const role_name = String(b.role_name || old.role_name).trim();
    if (!role_name) return res.status(400).json({ error: '角色名称必填' });
    const dup = db.prepare('SELECT 1 FROM roles WHERE role_name=? AND role_id!=?').get(role_name, old.role_id);
    if (dup) return res.status(409).json({ error: '角色名称已存在' });
    db.prepare(`UPDATE roles SET role_name=?, description=?, data_scope=?, is_readonly=?,
                updated_at=datetime('now','localtime') WHERE role_id=?`)
      .run(role_name, String(b.description || '').trim() || null,
        b.data_scope === 'self' ? 'self' : 'all', b.is_readonly ? 1 : 0, old.role_id);
  }
  const row = db.prepare('SELECT * FROM roles WHERE role_id=?').get(old.role_id);
  writeAudit(req, 'update', old.role_id, old, row);
  res.json({ data: row });
});

// 删除角色：内置禁删；有用户挂靠禁删
router.delete('/:id', menuGate('roles'), (req, res) => {
  const old = db.prepare('SELECT * FROM roles WHERE role_id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '角色不存在' });
  if (old.is_system) return res.status(403).json({ error: '内置角色不可删除' });
  const used = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id=?').get(old.role_id).c;
  if (used > 0) return res.status(409).json({ error: `该角色下仍有 ${used} 个用户，请先调整用户角色` });
  db.prepare('DELETE FROM roles WHERE role_id=?').run(old.role_id);
  writeAudit(req, 'delete', old.role_id, old, null);
  res.json({ ok: true });
});

// 已授权菜单 id（编辑回填）
router.get('/:id/menus', menuGate('roles'), (req, res) => {
  const r = db.prepare('SELECT 1 FROM roles WHERE role_id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '角色不存在' });
  res.json({ data: menuService.grantedMenuIds(Number(req.params.id)) });
});

// 保存权限：前端提交全部勾选节点 id（含主菜单），后端二次收敛后落库
router.put('/:id/menus', menuGate('roles'), (req, res) => {
  const roleId = Number(req.params.id);
  const r = db.prepare('SELECT * FROM roles WHERE role_id=?').get(roleId);
  if (!r) return res.status(404).json({ error: '角色不存在' });
  if (r.is_system && r.role_code === 'super_admin') {
    return res.status(403).json({ error: '超级管理员默认拥有全部菜单，无需配置' });
  }
  const submitted = Array.isArray((req.body || {}).menuIds) ? req.body.menuIds : null;
  if (!submitted) return res.status(400).json({ error: 'menuIds 必须为数组' });
  const before = menuService.grantedMenuIds(roleId);
  const eff = menuService.normalize(submitted);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM role_menus WHERE role_id=?').run(roleId);
    const ins = db.prepare('INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?,?)');
    eff.forEach((id) => ins.run(roleId, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '保存失败：' + e.message });
  }
  writeAudit(req, 'update', roleId,
    { menus: before }, { menus: eff, submitted: submitted.length });
  res.json({ ok: true, granted: eff.length, submitted: submitted.length });
});

module.exports = router;
