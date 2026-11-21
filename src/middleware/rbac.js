// ============================================================
//  RBAC 中间件（重构：数据库字段驱动，替换旧中文角色名硬编码）
//  - ownerScope / ensureOwn：行级隔离（roles.data_scope='self'，业务员语义保留）
//  - readonlyGate：只读角色（roles.is_readonly=1，查看者语义保留）
//  - roleGate：角色白名单（按 role_name 或 role_code 匹配）
//  - menuGate / hasMenuPerm：菜单级鉴权（role_menus ⋈ menus.path，
//    半选父节点绝不放行——鉴权只看子菜单 path，是整套设计的安全基石）
// ============================================================
const db = require('../db');

// 角色白名单：参数可传 role_name（管理员/业务员/查看者/超级管理员/自定义名）
// 或 role_code（admin/operator/viewer/super_admin）
// ★ 超级管理员（role_code='super_admin'）短路放行：绕过所有 roleGate 白名单判断
// 根因：roleGate 参数是硬编码字符串（如 ['管理员','超级管理员']），
// migrateRolesCleanup 清理旧 admin/operator/viewer 角色后，
// 实际 role_name/role_code 对不上 → 超管被自己的 gate 拦截。
function roleGate(...roles) {
  return (req, res, next) => {
    const u = req.user;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role_code === 'super_admin') return next();  // ★ 超管短路
    const ok = roles.some((r) => r === u.role || r === u.role_code);
    if (!ok) return res.status(403).json({ error: '当前角色无权限' });
    next();
  };
}

// 行级隔离：data_scope='self' 的角色只看自己负责的数据
function ownerScope(req) {
  if (req.user && req.user.data_scope === 'self') {
    return { sql: 'owner_user_id = ?', params: [req.user.user_id] };
  }
  return { sql: '', params: [] };
}

// 只读角色：仅安全方法放行（★ 修复 S-M5：HEAD/OPTIONS 也属只读，原 `!== 'GET'` 会误拒）
function readonlyGate(req, res, next) {
  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (req.user && req.user.is_readonly && !safe) {
    return res.status(403).json({ error: '只读角色仅可查看，无操作权限' });
  }
  next();
}

// 行级隔离的单条记录归属校验（get/put/delete 用）
// ★ 修复 S-L5：统一 Number 归一后比较，避免 int vs string 误判（SQL 占位符绑定不受影响，此处是 JS 层比较）。
//   保持原安全语义：owner 缺失（null/undefined）时归一后与真实 user_id 不等 → 仍拒绝。
function ensureOwn(req, row) {
  if (req.user && req.user.data_scope === 'self' && row && Number(row.owner_user_id) !== Number(req.user.user_id)) {
    return false;
  }
  return true;
}

// 单点菜单权限判断（超管短路；path 为被授权且可用的节点才放行）
function hasMenuPerm(role, ...paths) {
  if (!role) return false;
  if (role.role_code === 'super_admin') return true;
  const ok = db
    .prepare(`SELECT 1 FROM role_menus rm JOIN menus m ON m.menu_id=rm.menu_id
              WHERE rm.role_id=? AND m.path IN (${paths.map(() => '?').join(',')})
                AND m.is_built=1 AND m.is_enabled=1`)
    .get(role.role_id, ...paths);
  return !!ok;
}

// 菜单级路由守卫：按 path 精确校验（绝不因父菜单有权限而放行子菜单）
function menuGate(...paths) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!hasMenuPerm(req.user, ...paths)) {
      return res.status(403).json({ error: '无该菜单权限' });
    }
    next();
  };
}

module.exports = { ownerScope, readonlyGate, roleGate, ensureOwn, menuGate, hasMenuPerm };
