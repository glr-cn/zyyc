// ============================================================================
// settings.js · 系统设置路由（2026-11-20）
// ----------------------------------------------------------------------------
// 目前承载「物流映射配置」：快递公司编码 ↔ 名称的可视化维护。
//   GET    /api/settings/express-map            读取映射 + 默认值（供页面渲染）
//   POST   /api/settings/express-map            新增一条 {code,name}
//   PUT    /api/settings/express-map/:code      编辑（允许改编码与名称）
//   DELETE /api/settings/express-map/:code      删除一条
//   POST   /api/settings/express-map/reset      恢复内置默认映射
// 读：菜单权限 settings；写：管理员/超级管理员（roleGate 二次校验，防绕过前端）
// 配置实时生效：导入与统计每次请求都重新读取，无缓存。
// ============================================================================

const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { menuGate, roleGate } = require('../middleware/rbac');
const expressMap = require('../services/expressMap');
const auditLog = require('../services/auditLog');

router.use(auth);
router.use(menuGate('settings'));

const writeGate = roleGate('管理员', '超级管理员');

// 统一异常出口：业务校验错误 → 400；其余 → 500
function fail(res, e) {
  const msg = e && e.message ? e.message : '操作失败';
  const isBiz = /不能为空|已存在|不存在|只能包含|不能超过|最多只能/.test(msg);
  if (isBiz) return res.status(400).json({ error: msg });
  console.error('[settings/express-map] 异常:', e);
  return res.status(500).json({ error: msg });
}

function payload(res, items) {
  res.json({
    items,
    defaults: expressMap.DEFAULT_EXPRESS_MAP,
    count: items.length,
  });
}

// GET 映射列表
router.get('/express-map', (req, res) => {
  try {
    payload(res, expressMap.getItems(db));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST 新增
router.post('/express-map', writeGate, (req, res) => {
  try {
    const items = expressMap.addItem(db, req.body || {});
    auditLog.writeLog(req, {
      table: 'app_settings', module: '系统设置', action: 'create',
      targetId: 'express_map',
      content: { op: 'express_map_add', code: req.body && req.body.code, name: req.body && req.body.name },
    });
    payload(res, items);
  } catch (e) {
    fail(res, e);
  }
});

// PUT 编辑（:code 为原编码，body 可同时修改 code/name）
router.put('/express-map/:code', writeGate, (req, res) => {
  try {
    const items = expressMap.updateItem(db, req.params.code, req.body || {});
    auditLog.writeLog(req, {
      table: 'app_settings', module: '系统设置', action: 'update',
      targetId: 'express_map',
      content: { op: 'express_map_update', from: req.params.code, to: req.body || {} },
    });
    payload(res, items);
  } catch (e) {
    fail(res, e);
  }
});

// DELETE 删除
router.delete('/express-map/:code', writeGate, (req, res) => {
  try {
    const items = expressMap.removeItem(db, req.params.code);
    auditLog.writeLog(req, {
      table: 'app_settings', module: '系统设置', action: 'delete',
      targetId: 'express_map',
      content: { op: 'express_map_delete', code: req.params.code },
    });
    payload(res, items);
  } catch (e) {
    fail(res, e);
  }
});

// POST 恢复默认
router.post('/express-map/reset', writeGate, (req, res) => {
  try {
    const items = expressMap.resetDefaults(db);
    auditLog.writeLog(req, {
      table: 'app_settings', module: '系统设置', action: 'update',
      targetId: 'express_map', content: { op: 'express_map_reset' },
    });
    payload(res, items);
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
