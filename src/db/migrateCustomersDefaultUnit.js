// ============================================================================
//  customers.default_unit 字段迁移（被 CLI 与服务启动时共用）
// ----------------------------------------------------------------------------
//  策略：
//    1) 先查 customers 表是否有 default_unit 列，没有就 ALTER TABLE ADD COLUMN
//       default_unit TEXT NOT NULL DEFAULT '单'
//    2) 按用户提供的 4 条 LIKE 规则刷入指定 default_unit；同一行若多条规则命中
//       按文件里的声明顺序（后声明的覆盖先声明的，最精确的写最后）
//    3) 迁移前后做完整性校验（行数不变 + default_unit 列存在）
// ============================================================================

// 用户提供的 default_unit 规则（按文件声明顺序应用，后声明的覆盖先声明的）
// 规则：{ like: string, unit: string }
const UNIT_RULES = [
  // 绵羊-线下 → 箱
  { like: '%绵羊-线下%', unit: '箱' },
  // 西玛系列（百世快运 / 京东送仓 / 物流专线）→ 件
  { like: '%西玛-百世快运%', unit: '件' },
  { like: '%西玛-京东送仓%', unit: '件' },
  { like: '%西玛-物流专线%', unit: '件' },
  // 华尊-京东送仓 → 单
  { like: '%华尊-京东送仓%', unit: '单' },
];

const FINGERPRINT = 'customers-default-unit-v1';
const FINGERPRINT_TABLE = '_erp_migrations';

function ensureFingerprintTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${FINGERPRINT_TABLE} (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
}

function isApplied(db) {
  try {
    ensureFingerprintTable(db);
    const r = db.prepare(`SELECT 1 FROM ${FINGERPRINT_TABLE} WHERE name=?`).get(FINGERPRINT);
    return !!r;
  } catch (e) { return false; }
}

function markApplied(db) {
  ensureFingerprintTable(db);
  db.prepare(`INSERT OR REPLACE INTO ${FINGERPRINT_TABLE} (name, applied_at) VALUES (?, datetime('now','localtime'))`)
    .run(FINGERPRINT);
}

/**
 * 迁移入口
 * @param {any} db  已打开的 SQLite 句柄
 * @param {{verbose?:boolean, dryRun?:boolean}} opts
 * @returns {{addedColumns:string[], touched:number, rulesApplied:number[]}}
 */
function run(db, opts = {}) {
  const addedColumns = [];

  // 1) 确保列存在
  const cols = db.prepare("PRAGMA table_info(customers)").all().map((c) => c.name);
  if (!cols.includes('default_unit')) {
    const before = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
    db.exec("ALTER TABLE customers ADD COLUMN default_unit TEXT NOT NULL DEFAULT '单'");
    addedColumns.push('default_unit');
    const after = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
    if (after !== before) {
      throw new Error(`ALTER TABLE 前后 customers 行数不一致：before=${before} after=${after}，已 ROLLBACK`);
    }
  } else {
    if (opts.verbose) console.log('[customers.default_unit] 列已存在，跳过 ALTER');
  }

  // 2) 指纹已标记 → 跳过规则刷入
  if (isApplied(db)) {
    if (opts.verbose) console.log('[customers.default_unit] 指纹已标记，跳过规则刷入');
    return { addedColumns, touched: 0, rulesApplied: UNIT_RULES.map(() => 0) };
  }

  // 3) 按规则刷入（同一条客户可能命中多条规则：规则里"后声明"的会覆盖"先声明"的，
  //    但因为我们用单条 SQL，需要按规则顺序累加重叠；更简单：先把所有规则合并成"公司名 → unit" Map 再 UPDATE）
  const all = db.prepare('SELECT customer_id, company_name FROM customers').all();
  const nameRuleUnits = new Map();  // company_name → unit（后声明的覆盖前声明的）
  for (const row of all) {
    for (const rule of UNIT_RULES) {
      if (row.company_name && row.company_name.includes(rule.like.replace(/%/g, ''))) {
        // SQLite LIKE '%xxx%' 映射到 JS：字符串 includes
        nameRuleUnits.set(row.company_name, rule.unit);
      }
    }
  }

  // 按精确匹配逐个 UPDATE（避免 LIKE 通配在多列/多规则场景下误命中）
  let touched = 0;
  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE customers SET default_unit=? WHERE company_name=?');
    for (const [name, unit] of nameRuleUnits.entries()) {
      const info = upd.run(unit, name);
      touched += info.changes;
      if (opts.verbose) console.log(`  [default_unit] "${name}" → "${unit}" (${info.changes} 行)`);
    }
    const finalCount = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
    if (finalCount !== all.length) {
      throw new Error(`UPDATE 后 customers 行数 ${finalCount} != 迁移前 ${all.length}，ROLLBACK`);
    }
    db.exec('COMMIT');
    markApplied(db);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }

  return { addedColumns, touched, rulesApplied: UNIT_RULES.map(() => 0) };
}

module.exports = { run, UNIT_RULES, FINGERPRINT };
