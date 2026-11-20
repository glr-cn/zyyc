// ============================================================================
//  restoreGuard.js · 启动注入闸门（run.sh 在 Node 启动前调用）
// ----------------------------------------------------------------------------
//  背景（2026-11-20 v21 发布事故）：平台每次发布都是全新临时存储，持久库唯一
//  数据来源是包内恢复备份。旧 run.sh 只判「业务表全空」才注入——部分丢失
//  （某些表有数据、某些表空）不会触发恢复，数据会静默缺失。
//
//  本模块比较「持久库」与「包内恢复备份」的逐业务表行数，输出裁决：
//    MISSING    持久库文件不存在（首次启动）→ 应注入
//    NO_BUNDLE  包内恢复备份不存在 → 无法注入（保持现状，由外层告警）
//    EMPTY      持久库业务表全空 → 应注入（空库无需留档）
//    STALE      持久库任一业务表行数 < 包内备份对应行数 → 疑似部分丢失，
//               应注入（run.sh 注入前必须先把原库留档，绝不删除）
//    OK         持久库逐表行数 ≥ 备份 → 数据完整，跳过注入
//    ERROR      校验异常 → run.sh 保守跳过（不覆盖现有持久库）
//
//  设计约束：
//    A. 两个库都只读打开，本模块绝不写入任何文件；
//    B. 不变量：发布场景下「持久库行数 == 恢复备份行数」（恢复备份是发布前
//       一瞬间从线上导出的全量）。用户主动删除发生在导出之前 → 备份里同样
//       已删除 → 两者仍相等。因此「持久库 < 备份」只可能是异常，恢复是正确的；
//    C. 判不出来时保守（ERROR → 跳过注入），宁可少恢复也不误覆盖。
// ============================================================================
const fs = require('fs');

// 与 src/db/dbPath.js BUSINESS_TABLES 对齐，另含 warehouse_sort_config（发布指纹比对也用它）
const BIZ_TABLES = [
  'customers', 'orders', 'inventory_transactions', 'work_hours',
  'logistics_quotes', 'smart_quote_batches', 'smart_quote_records',
  'warehouse_sort_config',
];

/** 只读打开库文件，逐业务表统计行数；打不开/缺表按 0 计。 */
function tableCounts(dbFile) {
  const { openDatabase } = require('./driver');
  let db = null;
  try {
    db = openDatabase(dbFile, { readOnly: true, fileMustExist: true });
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    const counts = {};
    let total = 0;
    for (const t of BIZ_TABLES) {
      let c = 0;
      if (tables.has(t)) {
        try { c = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { c = 0; }
      }
      counts[t] = c;
      total += c;
    }
    return { rows: counts, total };
  } finally {
    try { if (db) db.close(); } catch (e) { /* ignore */ }
  }
}

/**
 * 注入裁决。纯只读，不产生任何文件写入。
 * @returns {{v:string, persist?:object, bundle?:object, deficient?:string[], msg?:string}}
 */
function verdict(persistDb, bundleBackup) {
  if (!bundleBackup || !fs.existsSync(bundleBackup)) return { v: 'NO_BUNDLE' };
  if (!persistDb || !fs.existsSync(persistDb)) {
    return { v: 'MISSING', bundle: tableCounts(bundleBackup) };
  }

  let p;
  try { p = tableCounts(persistDb); } catch (e) { return { v: 'ERROR', msg: '持久库打不开: ' + e.message }; }
  let b;
  try { b = tableCounts(bundleBackup); } catch (e) { return { v: 'ERROR', msg: '备份打不开: ' + e.message }; }

  if (p.total === 0) return { v: 'EMPTY', persist: p, bundle: b };

  const deficient = BIZ_TABLES.filter((t) => (p.rows[t] || 0) < (b.rows[t] || 0));
  if (deficient.length) {
    return { v: 'STALE', persist: p, bundle: b, deficient };
  }
  return { v: 'OK', persist: p, bundle: b };
}

// CLI 入口：node src/db/restoreGuard.js <persistDb> <bundleBackup>
// 只输出裁决单词（EMPTY/STALE/OK/...），供 run.sh case 分支使用
if (require.main === module) {
  const [persistDb, bundleBackup] = process.argv.slice(2);
  try {
    console.log(verdict(persistDb, bundleBackup).v);
  } catch (e) {
    console.log('ERROR:' + e.message);
  }
}

module.exports = { BIZ_TABLES, verdict };
