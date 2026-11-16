// 菜单路由（RBAC）：全量菜单树（角色权限页的权限树数据源）
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { menuGate } = require('../middleware/rbac');

router.use(auth);

// 全量两级菜单树（含功能建设中项，供权限树展示/预授权）
router.get('/tree', menuGate('roles'), (req, res) => {
  const all = db.prepare('SELECT * FROM menus WHERE is_enabled=1 ORDER BY sort, menu_id').all();
  const kids = (id) => all.filter((m) => m.parent_id === id);
  const tree = all
    .filter((m) => m.parent_id === null)
    .map((p) => ({
      menu_id: p.menu_id,
      menu_code: p.menu_code,
      menu_name: p.menu_name,
      icon: p.icon,
      path: p.path,
      children: kids(p.menu_id).map((c) => ({
        menu_id: c.menu_id,
        menu_code: c.menu_code,
        menu_name: c.menu_name,
        path: c.path,
        group_name: c.group_name,
        is_built: c.is_built,
      })),
    }));
  res.json({ data: tree });
});

module.exports = router;
