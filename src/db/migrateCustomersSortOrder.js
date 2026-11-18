// ============================================================================
//  customers.sort_order 字段迁移（被 CLI 与服务启动时共用）
// ----------------------------------------------------------------------------
//  策略：
//    1) 先查 customers 表是否有 sort_order 列，没有就 ALTER TABLE ADD COLUMN
//       sort_order INTEGER NOT NULL DEFAULT 9999
//    2) 按用户提供的名单精确匹配 company_name（严格等于，LIKE 都不用）
//       刷入 1..N；重名的（名单里出现两次）按 customer_id 全部刷入
//    3) 名单里匹配不到的：跳过 + 控制台 WARN，绝不 INSERT 新客户
//    4) 迁移前后做完整性校验（行数不变 + sort_order 列存在）
// ============================================================================

// 用户提供的排序名单（38 条，按顺序 1..38；注意第 8/9 条公司全称相同，名单明确"两个都更新"）
const SORT_LIST = [
  '杭州绵绵的羊网络科技有限公司',           // 1
  '海洋演义食品爆款',                       // 2
  '绵羊-线下',                             // 3
  '西玛-百世快运',                         // 4
  '西玛-京东送仓',                         // 5
  '西玛-物流专线',                         // 6
  '华尊-京东送仓',                         // 7
  '佐雍西玛直销厂直渠道',                   // 8
  '佐雍西玛直销厂直渠道',                   // 9  ← 重名，按名单口径两个都 update（同值覆盖）
  '爱颜猫科技（江苏）有限公司',             // 10
  '沃谷（山东）健康科技有限公司',           // 11
  '尼克宝(山东)文化创意有限公司',           // 12
  '王后旗舰店',                             // 13
  '北京父母家科技',                         // 14
  '莓小萌',                                 // 15
  '关谷庄',                                 // 16
  '杭州吉野物语食品有限公司',               // 17
  '杭州八目网络科技有限公司',               // 18
  '洁保生物',                               // 19
  '杭州益普思生物科技有限公司',             // 20
  '杭州喵之谷生活科技有限公司',             // 21
  '杭州味乐商贸有限公司',                   // 22
  '子元宠食（烟台）网络科技有限公司',       // 23
  '华尊（临沂）电子商务有限公司',           // 24
  '青岛爱淘者电子商务有限公司',             // 25
  '青岛鑫盛向荣商贸有限公司',               // 26
  '健宠公司',                               // 27
  '金丝雀影视文化传媒',                     // 28
  '文多多文化传媒（临沂）有限公司',         // 29
  '北京橙月寰创科技有限公司',               // 30
  '临沂甜宠维宠物用品有限公司',             // 31
  '沂蒙人食品',                             // 32
  '青岛陆天生物科技有限公司',               // 33
  '中阅凡星（山东）教育科技有限公司',       // 34
  '山东哎上课教育科技有限公司',             // 35
  '北京京拍档科技股份有限公司',             // 36
  '铭晟云仓',                               // 37
  '西子电商',                               // 38
];

// 名单指纹（用于判断"数据已刷过"，避免每次启动都跑 UPDATE）
const FINGERPRINT = 'customers-sort-order-v1';
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
 * @param {any} db  已打开的 SQLite 句柄（node:sqlite DatabaseSync / 或 wasm Database，两者 prepared().get/run 口径一致）
 * @param {{verbose?:boolean, dryRun?:boolean, force?:boolean}} opts
 *   - force=true：绕过指纹标记，每次都执行（超管手动刷新场景；服务启动自动迁移传 false 或不传）
 * @returns {{addedColumns:string[], matched:number, unmatched:string[], touchedCustomers:string[], skippedDuplicates:string[]}}
 */
function run(db, opts = {}) {
  const addedColumns = [];

  // 1) 确保列存在
  const cols = db.prepare("PRAGMA table_info(customers)").all().map((c) => c.name);
  if (!cols.includes('sort_order')) {
    // 迁移前快照
    const before = db.prepare('SELECT COUNT(*) c FROM customers').get().c;

    // SQLite 不支持一次多列 ADD COLUMN；但 sort_order 只有一列，一次搞定
    db.exec("ALTER TABLE customers ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 9999");
    addedColumns.push('sort_order');

    // 完整性校验：ALTER 后行数应不变
    const after = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
    if (after !== before) {
      throw new Error(`ALTER TABLE 前后 customers 行数不一致：before=${before} after=${after}，已 ROLLBACK（由外层事务回滚）`);
    }
  } else {
    if (opts.verbose) console.log('[customers.sort_order] 列已存在，跳过 ALTER');
  }

  // 2) 如果指纹已标记（数据刷过）且非强制模式，直接返回
  if (isApplied(db) && !opts.force) {
    if (opts.verbose) console.log('[customers.sort_order] 指纹已标记，跳过名单刷入（force=true 可强制重刷）');
    return { addedColumns, matched: 0, unmatched: [], touchedCustomers: [], skippedDuplicates: [] };
  }
  if (opts.force && isApplied(db)) {
    if (opts.verbose) console.log('[customers.sort_order] force=true 模式，忽略指纹，强制执行名单刷入');
  }

  // 3) 按名单刷入（严格等值匹配；重名全部刷入同值）
  const all = db.prepare('SELECT customer_id, company_name, sort_order FROM customers ORDER BY customer_id').all();
  const nameMap = new Map();
  for (const row of all) {
    if (!nameMap.has(row.company_name)) nameMap.set(row.company_name, []);
    nameMap.get(row.company_name).push(row);
  }

  let matched = 0;
  const unmatched = [];
  const touchedCustomerNames = new Set();
  const touchedCustomerIds = [];
  const upd = db.prepare('UPDATE customers SET sort_order=? WHERE customer_id=?');

  db.exec('BEGIN');
  try {
    for (let i = 0; i < SORT_LIST.length; i++) {
      const name = SORT_LIST[i];
      const seq = i + 1;
      const rows = nameMap.get(name);
      if (!rows || !rows.length) {
        unmatched.push(`#${seq} ${name}`);
        if (opts.verbose) console.warn(`  [WARN] 名单 #${seq} "${name}" 未匹配到任何客户行，跳过`);
        continue;
      }
      for (const row of rows) {
        upd.run(seq, row.customer_id);
        matched++;
        touchedCustomerNames.add(name);
        touchedCustomerIds.push(row.customer_id);
      }
    }
    // 4) 完整性校验：确保 UPDATE 后总行数不变
    const finalCount = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
    const expected = all.length;
    if (finalCount !== expected) {
      throw new Error(`UPDATE 后 customers 行数 ${finalCount} != 迁移前 ${expected}，ROLLBACK`);
    }
    db.exec('COMMIT');
    markApplied(db);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }

  return {
    addedColumns,
    matched,
    unmatched,
    touchedCustomers: [...touchedCustomerNames],
  };
}

module.exports = { run, SORT_LIST, FINGERPRINT };
