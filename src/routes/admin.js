// ============================================================================
//  系统管理路由（仅超级管理员可访问）
//  ----------------------------------------------------------------------------
//  路由挂载点：/api/admin
//  所有子路由先过 roleGate('super_admin')，非超管返回 403 + 明确提示。
//  当前包含：customers.sort_order 手动迁移（刷新 + 回滚 + 状态查询）
// ============================================================================
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { roleGate } = require('../middleware/rbac');
const audit = require('../services/auditLog');

// 统一先做登录 + 角色拦截（超管才能进这个路由组）
router.use(auth);
router.use(roleGate('super_admin'));

// 排序迁移快照表：迁移前保存 customers.sort_order，回滚时从此恢复
const SNAPSHOT_TABLE = '_sort_order_snapshot';
const SORT_MIGRATION = require('../db/migrateCustomersSortOrder');

function ensureSnapshotTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
    customer_id INTEGER PRIMARY KEY,
    company_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  )`);
}

// ---------- 快照：保存 / 恢复 当前排序号 ----------
function saveSnapshot() {
  ensureSnapshotTable();
  db.exec(`DELETE FROM ${SNAPSHOT_TABLE}`);
  db.exec(`INSERT INTO ${SNAPSHOT_TABLE} (customer_id, company_name, sort_order)
           SELECT customer_id, company_name, sort_order FROM customers`);
  const count = db.prepare(`SELECT COUNT(*) c FROM ${SNAPSHOT_TABLE}`).get().c;
  return count;
}

function restoreFromSnapshot() {
  ensureSnapshotTable();
  const snapCount = db.prepare(`SELECT COUNT(*) c FROM ${SNAPSHOT_TABLE}`).get().c;
  if (snapCount === 0) throw new Error('快照为空，无法回滚（未执行过迁移或快照已被清空）');

  db.exec('BEGIN');
  try {
    db.exec(`UPDATE customers SET sort_order=9999 WHERE sort_order IS NULL OR sort_order=9999`);
    const info = db.prepare(`
      UPDATE customers SET sort_order=(SELECT s.sort_order FROM ${SNAPSHOT_TABLE} s WHERE s.customer_id=customers.customer_id)
      WHERE customer_id IN (SELECT customer_id FROM ${SNAPSHOT_TABLE})
    `).run();
    db.exec('COMMIT');
    return info.changes || 0;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

function clearSnapshot() {
  ensureSnapshotTable();
  db.exec(`DELETE FROM ${SNAPSHOT_TABLE}`);
}

// ---------- GET /api/admin/migrate-sort/status ----------
// 当前状态：名单数量、已刷行数、未匹配列表、快照行数、指纹是否存在
router.get('/migrate-sort/status', (req, res) => {
  try {
    const all = db.prepare('SELECT customer_id, company_name, sort_order FROM customers ORDER BY customer_id').all();
    const sortList = SORT_MIGRATION.SORT_LIST;
    const fingerprintExists = !!db.prepare(
      `SELECT 1 FROM _erp_migrations WHERE name=?`
    ).get(SORT_MIGRATION.FINGERPRINT);

    const lowCount = db.prepare('SELECT COUNT(*) c FROM customers WHERE sort_order < 9999').get().c;

    let snapCount = 0;
    try {
      ensureSnapshotTable();
      snapCount = db.prepare(`SELECT COUNT(*) c FROM ${SNAPSHOT_TABLE}`).get().c;
    } catch (_) { /* 表不存在 */ }

    // 计算名单覆盖情况（不做实际写入，仅 dry-run 语义的统计）
    const nameMap = new Map();
    for (const row of all) {
      if (!nameMap.has(row.company_name)) nameMap.set(row.company_name, []);
      nameMap.get(row.company_name).push(row);
    }
    const unmatched = [];
    let expectedMatched = 0;
    for (let i = 0; i < sortList.length; i++) {
      const rows = nameMap.get(sortList[i]);
      if (!rows || !rows.length) unmatched.push({ seq: i + 1, name: sortList[i] });
      else expectedMatched += rows.length;
    }

    res.json({
      ok: true,
      fingerprintExists,
      totalCustomers: all.length,
      sortListSize: sortList.length,
      alreadyMatched: lowCount,
      expectedMatchedOnRun: expectedMatched,
      unmatched,
      snapshotRows: snapCount,
      sortList: sortList.map((name, idx) => ({ seq: idx + 1, name })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- POST /api/admin/migrate-sort ----------
// 执行手动刷新：保存快照 → 强制执行迁移 → 写审计日志 → 返回报告
router.post('/migrate-sort', (req, res) => {
  const operator = req.user;
  let snapshotBefore = 0;
  let report = null;

  try {
    // 1) 保存迁移前快照（供回滚）
    snapshotBefore = saveSnapshot();

    // 2) 强制执行迁移（force=true 跳过指纹检查，每次都刷）
    report = SORT_MIGRATION.run(db, { force: true, verbose: true });

    // 3) 写审计日志（完整的 content 包含报告详情，便于追溯）
    audit.writeLog(req, {
      table: 'customers',
      module: '系统/权限',
      action: 'import',
      targetId: 'sort_order_migration',
      content: {
        op: 'migrate_sort_order',
        operator: operator.username,
        timestamp: new Date().toISOString(),
        snapshotRows: snapshotBefore,
        sortListSize: SORT_MIGRATION.SORT_LIST.length,
        matched: report.matched,
        unmatched: report.unmatched,
        touchedCustomers: report.touchedCustomers,
        addedColumns: report.addedColumns,
      },
    });

    res.json({
      ok: true,
      report,
      snapshotRows: snapshotBefore,
      message: `排序迁移完成：名单 ${SORT_MIGRATION.SORT_LIST.length} 条，匹配 ${report.matched} 行，未匹配 ${report.unmatched.length} 条；快照已保存 ${snapshotBefore} 行`,
    });
  } catch (e) {
    // 迁移失败时自动回滚（如果迁移过程中已有部分写入）
    let rollbackResult = null;
    try {
      rollbackResult = restoreFromSnapshot();
    } catch (rb) {
      rollbackResult = { error: rb.message };
    }

    // 错误审计
    audit.writeLog(req, {
      table: 'customers',
      module: '系统/权限',
      action: 'delete',
      targetId: 'sort_order_migration_failed',
      content: {
        op: 'migrate_sort_order_failed',
        operator: operator.username,
        error: e.message,
        snapshotRows: snapshotBefore,
        autoRollback: rollbackResult,
      },
    });

    res.status(500).json({
      ok: false,
      error: e.message,
      snapshotRows: snapshotBefore,
      autoRollback: rollbackResult,
    });
  }
});

// ---------- POST /api/admin/migrate-sort/rollback ----------
// 从快照手动回滚（管理员主动触发回滚，或迁移失败后想手动恢复）
router.post('/migrate-sort/rollback', (req, res) => {
  const operator = req.user;
  try {
    const changes = restoreFromSnapshot();

    audit.writeLog(req, {
      table: 'customers',
      module: '系统/权限',
      action: 'update',
      targetId: 'sort_order_rollback',
      content: {
        op: 'rollback_sort_order',
        operator: operator.username,
        timestamp: new Date().toISOString(),
        restoredRows: changes,
      },
    });

    res.json({
      ok: true,
      restoredRows: changes,
      message: `已从快照回滚排序号，恢复 ${changes} 行`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- 导出整库（部署前数据快照） ----------
// GET /api/admin/db-export
// 用 VACUUM INTO 生成一致性快照后以附件返回，供发布前备份线上数据。
// 平台每次发布都是全新临时存储，靠「发布前导出 + 打包进新版本」实现数据不丢。
router.get('/db-export', (req, res) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = path.join(os.tmpdir(), `erp-export-${Date.now()}-${process.pid}.db`);
  try {
    db._raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    audit.writeLog(req, {
      table: 'system',
      module: '系统/权限',
      action: 'export',
      targetId: 'db_export',
      content: { op: 'db_export', operator: req.user && req.user.username, file: path.basename(tmp) },
    });
    res.download(tmp, 'erp.db', (err) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (err && !res.headersSent) res.status(500).end();
    });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    res.status(500).json({ ok: false, error: '导出失败：' + e.message });
  }
});

// ---------- DELETE /api/admin/migrate-sort/snapshot ----------
// 清除快照（迁移确认无误后管理员手动清理）
router.delete('/migrate-sort/snapshot', (req, res) => {
  try {
    clearSnapshot();
    audit.writeLog(req, {
      table: 'customers',
      module: '系统/权限',
      action: 'delete',
      targetId: 'sort_order_snapshot_cleared',
      content: { op: 'clear_sort_snapshot', operator: req.user.username },
    });
    res.json({ ok: true, message: '快照已清除' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//  菜单排序（父级 + 子级 sort 批量调整）
// ============================================================

// ---------- GET /api/admin/menus/tree ----------
// 返回完整两级菜单树（含 sort 值），供排序管理页面使用
router.get('/menus/tree', (req, res) => {
  try {
    const all = db.prepare(
      'SELECT menu_id, menu_code, parent_id, menu_name, path, icon, group_name, sort, is_built, is_enabled FROM menus ORDER BY sort, menu_id'
    ).all();
    const byParent = new Map();
    for (const m of all) {
      const k = m.parent_id ?? '__root__';
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(m);
    }
    const parents = (byParent.get('__root__') || []).map((p) => ({
      ...p,
      children: (byParent.get(p.menu_id) || []).sort((a, b) => a.sort - b.sort || a.menu_id - b.menu_id),
    }));
    res.json({ ok: true, data: parents });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- PUT /api/admin/menus/reorder ----------
// 批量更新菜单 sort 值。
// body 格式：{ items: [{ menu_id: number, sort: number }, ...] }
// 约束：menu_id 必须都存在于 menus 表；sort 为整数，负数允许。
router.put('/menus/reorder', (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: 'items 数组不能为空' });
  }
  if (items.length > 1000) {
    return res.status(400).json({ ok: false, error: 'items 超过单次最大 1000 条' });
  }

  // 校验：所有 menu_id 必须存在；sort 必须是整数
  const validMap = new Map();
  const allIds = db.prepare('SELECT menu_id, menu_code, parent_id, sort FROM menus').all();
  const byId = new Map(allIds.map((r) => [r.menu_id, r]));
  for (const it of items) {
    if (!byId.has(it.menu_id)) {
      return res.status(400).json({ ok: false, error: `menu_id=${it.menu_id} 不存在` });
    }
    const sort = Number(it.sort);
    if (!Number.isFinite(sort) || !Number.isInteger(sort)) {
      return res.status(400).json({ ok: false, error: `menu_id=${it.menu_id} 的 sort 不是整数` });
    }
    validMap.set(it.menu_id, sort);
  }

  // 校验通过 → 事务更新
  const stmt = db.prepare('UPDATE menus SET sort=? WHERE menu_id=?');
  db.exec('BEGIN');
  try {
    const before = db.prepare('SELECT menu_id, menu_name, sort FROM menus WHERE menu_id IN (' + items.map(() => '?').join(',') + ')')
      .all(...items.map((i) => i.menu_id));
    for (const [mid, sort] of validMap) {
      stmt.run(sort, mid);
    }
    db.exec('COMMIT');

    // 审计日志：记录每个菜单的 sort 变更
    const after = db.prepare('SELECT menu_id, menu_name, sort FROM menus WHERE menu_id IN (' + items.map(() => '?').join(',') + ')')
      .all(...items.map((i) => i.menu_id));
    const changes = before.map((b) => {
      const a = after.find((x) => x.menu_id === b.menu_id);
      return { menu_id: b.menu_id, menu_name: b.menu_name, before: b.sort, after: a ? a.sort : b.sort };
    }).filter((c) => c.before !== c.after);

    audit.writeLog(req, {
      table: 'menus',
      module: '系统/权限',
      action: 'update',
      targetId: 'menu_reorder',
      content: {
        op: 'reorder_menus',
        operator: req.user.username,
        changedCount: changes.length,
        changes,
      },
    });

    res.json({
      ok: true,
      message: `菜单排序已保存，${changes.length} 项变更，${items.length - changes.length} 项无变化`,
      changedCount: changes.length,
    });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- DELETE /api/admin/business-data ----------
// ⚠️ 批量删除业务数据（工时 + 客户 + 排序配置）。保留表结构 + 用户/角色/菜单。
// 仅限 super_admin，操作写审计日志。
// body: { confirm: 'YES' }
router.delete('/business-data', (req, res) => {
  if ((req.body || {}).confirm !== 'YES') {
    return res.status(400).json({ ok: false, error: '必须传 { confirm: "YES" }' });
  }
  const before = {
    customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
    work_hours: db.prepare('SELECT COUNT(*) c FROM work_hours').get().c,
    warehouse_sort_config: db.prepare('SELECT COUNT(*) c FROM warehouse_sort_config').get().c,
  };
  db._raw.exec('DELETE FROM work_hours');
  db._raw.exec('DELETE FROM warehouse_sort_config');
  db._raw.exec('DELETE FROM customers');
  const after = {
    customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
    work_hours: db.prepare('SELECT COUNT(*) c FROM work_hours').get().c,
  };
  audit.writeLog(req, { table: 'customers,work_hours', module: '系统/数据清理', operation: 'DELETE', details: JSON.stringify({ before, after }) });
  res.json({ ok: true, before, after });
});

// ---------- DELETE /api/admin/backups ----------
// ⚠️ 清空持久目录 backups/ 下所有快照文件。仅限 super_admin，需 confirm=YES。
router.delete('/backups', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  if ((req.body || {}).confirm !== 'YES') {
    return res.status(400).json({ ok: false, error: '必须传 { confirm: "YES" }' });
  }
  const bakDir = path.join(path.dirname(db.DB_PATH), 'backups');
  if (!fs.existsSync(bakDir)) {
    return res.json({ ok: true, cleared: 0, dir: bakDir, note: '目录不存在' });
  }
  const files = fs.readdirSync(bakDir).filter((f) => f.endsWith('.db'));
  let cleared = 0;
  for (const f of files) {
    try { fs.unlinkSync(path.join(bakDir, f)); cleared++; } catch (e) {}
  }
  audit.writeLog(req, { table: 'backups', module: '系统/数据清理', operation: 'DELETE', details: JSON.stringify({ cleared, dir: bakDir }) });
  res.json({ ok: true, cleared, dir: bakDir });
});

module.exports = router;
