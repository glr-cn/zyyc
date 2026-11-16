// ============================================================
//  菜单/权限服务（RBAC 核心）
//  - getMenuTree(role)：登录后返回该角色可见的两级菜单树
//    （父节点可能不在 role_menus（半选），但其下任一子菜单被授权时
//     仍作为「容器」返回，保证只勾部分子菜单时父级可展开）
//  - permissionsOf(role)：路由白名单（只含被授权且带 path 的可用节点）
//  - normalize(submitted)：保存权限时父子收敛（后端不信任前端）
//  安全基石：role_menus 里的父节点只是「全选标记」，
//  鉴权永远只看子菜单 path —— 半选父节点绝不放行任何路由。
// ============================================================
const db = require('../db');

function isSuper(role) {
  return role && role.role_code === 'super_admin';
}

// 角色的授权 id 集合（超管短路 = 全部）
function grantIds(role) {
  if (isSuper(role)) {
    return new Set(db.prepare('SELECT menu_id FROM menus').all().map((r) => r.menu_id));
  }
  return new Set(
    db.prepare('SELECT menu_id FROM role_menus WHERE role_id=?').all(role.role_id).map((r) => r.menu_id)
  );
}

// 两级菜单树：主菜单（容器/直达）→ 已授权子菜单
function getMenuTree(role) {
  const all = db.prepare('SELECT * FROM menus WHERE is_enabled=1 ORDER BY sort, menu_id').all();
  const grant = grantIds(role);
  const kids = (id) => all.filter((m) => m.parent_id === id);
  return all
    .filter((m) => m.parent_id === null)
    .filter((p) => grant.has(p.menu_id) || kids(p.menu_id).some((c) => grant.has(c.menu_id)))
    .map((p) => ({
      menu_id: p.menu_id,
      menu_code: p.menu_code,
      menu_name: p.menu_name,
      icon: p.icon,
      path: p.path,
      virtual: !grant.has(p.menu_id),   // 仅作容器（半选），自身路由不放行
      children: kids(p.menu_id)
        .filter((c) => grant.has(c.menu_id))
        .map((c) => ({
          menu_id: c.menu_id,
          menu_code: c.menu_code,
          menu_name: c.menu_name,
          path: c.path,
          group_name: c.group_name,
          is_built: c.is_built,
        })),
    }));
}

// 路由白名单：只放行「被授权且带 path 且可用」的节点（天然实现半选只放行已勾部分）
function permissionsOf(role) {
  if (isSuper(role)) {
    return db
      .prepare('SELECT path FROM menus WHERE path IS NOT NULL AND is_built=1 AND is_enabled=1')
      .all()
      .map((r) => r.path);
  }
  return db
    .prepare(`SELECT m.path FROM role_menus rm JOIN menus m ON m.menu_id=rm.menu_id
              WHERE rm.role_id=? AND m.path IS NOT NULL AND m.is_built=1 AND m.is_enabled=1`)
    .all(role.role_id)
    .map((r) => r.path);
}

// 保存权限：父子收敛。
//  ① 叶子节点（含「看板」直达）直接保留；
//  ② 父节点仅当「所有子菜单都被提交」才落库（全选标记）；
//  ③ 半选（父未提交 / 提交但子不全）→ 剔除父，已勾子菜单权限照常保留；
//  ④ 恶意只提交父 → 父被剔除，零放行。
function normalize(submitted) {
  const all = db.prepare('SELECT menu_id, parent_id FROM menus').all();
  const byId = new Map(all.map((m) => [m.menu_id, m]));
  const kids = (id) => all.filter((m) => m.parent_id === id);
  const S = new Set(submitted.filter((id) => byId.has(id)));
  const eff = new Set();
  S.forEach((id) => {
    if (kids(id).length === 0) eff.add(id);
  });
  all.forEach((m) => {
    const cs = kids(m.menu_id);
    if (cs.length && S.has(m.menu_id) && cs.every((c) => S.has(c.menu_id))) eff.add(m.menu_id);
  });
  return [...eff];
}

// 角色 id → 已授权菜单 id（编辑回填用）
function grantedMenuIds(roleId) {
  return db.prepare('SELECT menu_id FROM role_menus WHERE role_id=?').all(roleId).map((r) => r.menu_id);
}

module.exports = { isSuper, getMenuTree, permissionsOf, normalize, grantedMenuIds };
