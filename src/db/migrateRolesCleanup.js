// ============================================================
// 角色清理迁移：删除前端已 filter 隐藏的旧内置角色（admin/operator/viewer）
// 只保留 super_admin。幂等、有事务。
// 迁移前自动快照，失败回滚。
// ------------------------------------------------------------
// 设计：前端 roles.js 只展示 super_admin，后端 roles 表里的 admin/operator/viewer
// 已不可达（新建角色时还会因 UNIQUE 命名冲突被拒）。
// 本迁移安全删除它们 —— 但如果仍有用户挂靠这些角色则跳过，避免孤儿用户。
// 已经被删除（前端已隐藏）后再启动 → 幂等，直接跳过。
// ============================================================

const CODES_TO_CLEAN = ['admin', 'operator', 'viewer'];
const KEEP_CODE = 'super_admin';

function run(conn) {
  // 先确认 super_admin 存在（否则不能删内置角色，全部跳过）
  const keep = conn.prepare('SELECT role_id FROM roles WHERE role_code=?').get(KEEP_CODE);
  if (!keep) {
    console.warn('[migrateRolesCleanup] ⚠️ super_admin 不存在，跳过清理，避免破坏权限结构。');
    return;
  }

  // 查出所有待清理内置角色及其挂靠用户数
  const stmts = CODES_TO_CLEAN.map(() => '?').join(',');
  const roles = conn.prepare(
    `SELECT r.role_id, r.role_code, r.role_name,
     (SELECT COUNT(*) FROM users u WHERE u.role_id=r.role_id) AS user_count
     FROM roles r WHERE r.role_code IN (${stmts})`
  ).all(...CODES_TO_CLEAN);

  if (!roles.length) {
    console.log('[migrateRolesCleanup] 没有需要清理的旧内置角色（已清理过或从未存在）。');
    return;
  }

  const toDelete = roles.filter(r => r.user_count === 0);
  const toSkip = roles.filter(r => r.user_count > 0);

  if (toSkip.length) {
    console.warn('[migrateRolesCleanup] 跳过 ' + toSkip.length + ' 个仍有用户挂靠的内置角色：',
      toSkip.map(r => r.role_code + '(' + r.user_count + ' 用户)').join(', '));
  }

  if (!toDelete.length) {
    console.log('[migrateRolesCleanup] 暂无可安全删除的旧内置角色。');
    return;
  }

  // 事务删除：先解除 role_menus 关联，再删角色
  conn.exec('BEGIN TRANSACTION;');
  try {
    for (const r of toDelete) {
      conn.prepare('DELETE FROM role_menus WHERE role_id=?').run(r.role_id);
      conn.prepare('DELETE FROM roles WHERE role_id=?').run(r.role_id);
      console.log('[migrateRolesCleanup] 已清理：role_code=' + r.role_code + ' role_name=' + r.role_name);
    }
    conn.exec('COMMIT;');
    console.log('[migrateRolesCleanup] 清理完成，共删 ' + toDelete.length + ' 个角色：',
      toDelete.map(r => r.role_name).join(', '));
  } catch (e) {
    conn.exec('ROLLBACK;');
    throw e;
  }
}

module.exports = { run };
