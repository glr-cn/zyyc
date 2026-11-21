// ============================================================================
// settings.js · 系统设置路由（2026-11-20）
// ----------------------------------------------------------------------------
// 1) 物流映射设置：快递公司编码（表格编码）↔ 名称的可视化维护。
//   GET    /api/settings/express-map            读取映射 + 默认值（供页面渲染）
//   POST   /api/settings/express-map            新增一条 {code,name}
//   PUT    /api/settings/express-map/:code      编辑（允许改编码与名称）
//   DELETE /api/settings/express-map/:code      删除一条
//   POST   /api/settings/express-map/reset      恢复内置默认映射
// 2) 偏远地区设置：以快递公司为维度配置 大偏远 / 小偏远 / 正常 区域。
//   GET    /api/settings/region-rules/carriers  快递公司列表（含配置条数）
//   GET    /api/settings/region-rules/:carrier  某快递公司的区域配置
//   PUT    /api/settings/region-rules/:carrier  全量保存 {大偏远:[],小偏远:[],正常:[]}
//   DELETE /api/settings/region-rules/:carrier  清空某快递公司配置
//   GET    /api/settings/region-tree            省/市/区级联数据源
// 读：菜单权限 settings；写：管理员/超级管理员（roleGate 二次校验，防绕过前端）
// 配置实时生效：导入与统计每次请求都重新读取，无缓存；保存规则后重算历史订单分类。
// ============================================================================

const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { roleGate } = require('../middleware/rbac');
const expressMap = require('../services/expressMap');
const expressRegion = require('../services/expressRegion');
const auditLog = require('../services/auditLog');

router.use(auth);
// ★ 修复 S4：'settings' 菜单由迁移动态插入，部分库未授权会导致整页 403。
//   改为与写操作一致的 roleGate 口径（系统设置页仅管理员/超管可访问）。
const readGate = roleGate('管理员', '超级管理员');
router.use(readGate);

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

// ============================================================================
// 偏远地区设置
// ============================================================================

// 快递公司下拉：物流映射中的公司 + 已配置规则的公司
router.get('/region-rules/carriers', (req, res) => {
  try {
    const names = expressMap.getItems(db).map((x) => x.name);
    res.json({ carriers: expressRegion.carriers(db, names) });
  } catch (e) {
    fail(res, e);
  }
});

// 省/市/区级联数据源
router.get('/region-tree', (req, res) => {
  try {
    res.json({ provinces: expressRegion.regionTree(db) });
  } catch (e) {
    fail(res, e);
  }
});

// 某快递公司的区域配置
router.get('/region-rules/:carrier', (req, res) => {
  try {
    res.json(expressRegion.listRules(db, req.params.carrier));
  } catch (e) {
    fail(res, e);
  }
});

// 保存（全量替换），实时生效
router.put('/region-rules/:carrier', writeGate, (req, res) => {
  try {
    const carrier = req.params.carrier;
    const body = req.body || {};
    const result = expressRegion.saveRules(db, carrier, {
      '大偏远': body['大偏远'],
      '小偏远': body['小偏远'],
      '正常': body['正常'],
    });
    auditLog.writeLog(req, {
      table: 'express_region_rules', module: '系统设置', action: 'update',
      targetId: carrier,
      content: {
        op: 'region_rules_save', carrier,
        count: result.count,
        counts: {
          '大偏远': result.groups['大偏远'].length,
          '小偏远': result.groups['小偏远'].length,
          '正常': result.groups['正常'].length,
        },
        recalced: result.recalced,
      },
    });
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

// 清空某快递公司配置（清空后回退系统内置规则）
router.delete('/region-rules/:carrier', writeGate, (req, res) => {
  try {
    const result = expressRegion.clearRules(db, req.params.carrier);
    auditLog.writeLog(req, {
      table: 'express_region_rules', module: '系统设置', action: 'delete',
      targetId: req.params.carrier,
      content: { op: 'region_rules_clear', carrier: req.params.carrier, recalced: result.recalced },
    });
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
