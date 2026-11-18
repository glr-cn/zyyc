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

module.exports = router;
