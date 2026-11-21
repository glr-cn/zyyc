// ============================================================================
//  发货单量整数化 —— 幂等启动迁移
//  ----------------------------------------------------------------------------
//  业务规则：发货单量单位为「单」，必须为整数（1 ~ 1,000,000），不得有小数。
//  历史数据若存在小数（早期导入/手工改库），本迁移统一按「四舍五入」取整，
//  并同步重算受影响行的派生字段（时效 efficiency / 单均成本 unit_cost）。
//
//  铁律：不 DROP / 不重建 / 不删行；只做 UPDATE，且迁移前后校验行数不变。
//  幂等：无小数行时直接跳过（changed=false）。
//  被 src/db/index.js 启动时调用。
// ============================================================================

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function run(db, { verbose = false } = {}) {
  const log = (...a) => { if (verbose) console.log('[wh-ship-int-migrate]', ...a); };
  if (!tableExists(db, 'work_hours')) {
    log('work_hours 不存在，跳过');
    return { changed: false, rounded: 0 };
  }

  const countBefore = db.prepare('SELECT COUNT(*) c FROM work_hours').get().c;
  const targets = db.prepare(
    `SELECT work_id FROM work_hours
      WHERE ship_orders IS NOT NULL AND ship_orders <> CAST(ROUND(ship_orders) AS INTEGER)`
  ).all().map((r) => r.work_id);

  if (!targets.length) {
    log('发货单量已全部为整数，跳过');
    return { changed: false, rounded: 0, workHours: countBefore };
  }

  db.exec('BEGIN');
  try {
    // 1) 四舍五入取整（SQLite ROUND 对正数为四舍五入）
    db.prepare(
      `UPDATE work_hours SET ship_orders = CAST(ROUND(ship_orders) AS INTEGER)
        WHERE ship_orders IS NOT NULL AND ship_orders <> CAST(ROUND(ship_orders) AS INTEGER)`
    ).run();
    // 2) 受影响行重算派生字段（与 services/workhours.js calc 口径一致，保留 3 位）
    const upd = db.prepare(
      `UPDATE work_hours SET
         efficiency = CASE WHEN main_hours > 0 THEN ROUND(ship_orders / main_hours, 3) ELSE 0 END,
         unit_cost  = CASE WHEN ship_orders > 0 THEN ROUND(total_hours / ship_orders, 3) ELSE 0 END
       WHERE work_id = ?`
    );
    for (const id of targets) upd.run(id);

    // 3) 校验：行数不变
    const countAfter = db.prepare('SELECT COUNT(*) c FROM work_hours').get().c;
    if (countAfter !== countBefore)
      throw new Error(`迁移前行数 ${countBefore} ≠ 迁移后 ${countAfter}`);

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw new Error('发货单量整数化迁移失败并已回滚：' + e.message);
  }

  const report = { changed: true, rounded: targets.length, workHours: countBefore, ids: targets.slice(0, 20) };
  log('完成：', JSON.stringify({ rounded: report.rounded, workHours: report.workHours }));
  return report;
}

module.exports = { run };
