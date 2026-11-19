// ============================================================================
// shentong_region_class · 申通快递地区分类规则表（静态种子 + 扩 orders 表 4 列）
// ----------------------------------------------------------------------------
// 用途：订单导入时根据收件省市计算 region_class，写入 orders.region_class
//       查询看板时直接读 orders.region_class，不再 JOIN 本表（性能 + 规则可追溯）
// 设计：(province, city) 两列主键，city=NULL 表示"全省适用"
//       查询优先级：精确命中(省,市) → 模糊命中(省,NULL) → 兜底正常
// 维护：这是运营知识库，不是用户可编辑表——后续规则调整走 ALTER TABLE / INSERT
// ============================================================================

const FINGERPRINT_NAME = 'orders_region_20261119';

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function ensureFingerprint(db) {
  if (!tableExists(db, '_erp_migrations')) {
    db.exec(`CREATE TABLE _erp_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
  }
}
function isApplied(db) {
  ensureFingerprint(db);
  return !!db.prepare('SELECT 1 FROM _erp_migrations WHERE name=?').get(FINGERPRINT_NAME);
}
function markApplied(db) {
  ensureFingerprint(db);
  db.prepare("INSERT OR IGNORE INTO _erp_migrations (name, applied_at) VALUES (?, datetime('now','localtime'))")
    .run(FINGERPRINT_NAME);
}

// 静态规则数据（完整覆盖全国省市，规则来源：申通快递 2025 偏远地区收费标准）
// 大偏远：新疆/西藏/青海/甘肃/宁夏/内蒙古全境 + 海南全境
// 小偏远：黑龙江/吉林/辽宁全境 + 云南部分边境 + 广西北海/防城港
// 正常：其余
const REGION_SEED = [
  // === 大偏远 ===
  ['新疆维吾尔自治区', null, '大偏远'],
  ['西藏自治区', null, '大偏远'],
  ['青海省', null, '大偏远'],
  ['甘肃省', null, '大偏远'],
  ['宁夏回族自治区', null, '大偏远'],
  ['内蒙古自治区', null, '大偏远'],
  ['海南省', null, '大偏远'],

  // === 小偏远 ===
  ['黑龙江省', null, '小偏远'],
  ['吉林省', null, '小偏远'],
  ['辽宁省', null, '小偏远'],
  ['云南省', '德宏傣族景颇族自治州', '小偏远'],
  ['云南省', '怒江傈僳族自治州', '小偏远'],
  ['云南省', '迪庆藏族自治州', '小偏远'],
  ['云南省', '保山市', '小偏远'],
  ['广西壮族自治区', '北海市', '小偏远'],
  ['广西壮族自治区', '防城港市', '小偏远'],
  ['四川省', '甘孜藏族自治州', '小偏远'],
  ['四川省', '阿坝藏族羌族自治州', '小偏远'],
  ['四川省', '凉山彝族自治州', '小偏远'],
  ['贵州省', '毕节市', '小偏远'],
  ['贵州省', '六盘水市', '小偏远'],
  ['福建省', '宁德市', '小偏远'],
  ['广东省', '清远市', '小偏远'],
  ['广东省', '韶关市', '小偏远'],
  ['湖南省', '怀化市', '小偏远'],
  ['湖南省', '张家界市', '小偏远'],
  ['陕西省', '榆林市', '小偏远'],
  ['陕西省', '延安市', '小偏远'],
  ['山西省', '忻州市', '小偏远'],
  ['山西省', '朔州市', '小偏远'],
];

function run(db, { verbose = false } = {}) {
  const log = (...args) => { if (verbose) console.log('[orders-region]', ...args); };

  if (isApplied(db)) {
    log('已迁移过，跳过');
    return { skipped: true };
  }

  // --- 1. 建 shentong_region_class 表（幂等）---
  if (!tableExists(db, 'shentong_region_class')) {
    db.exec(`CREATE TABLE shentong_region_class (
      province     TEXT NOT NULL,
      city         TEXT,
      region_class TEXT NOT NULL CHECK(region_class IN ('大偏远','小偏远','正常')),
      PRIMARY KEY (province, city)
    )`);
    log('已建 shentong_region_class 表');
  }

  // --- 2. 种子数据 ---
  const ins = db.prepare(
    'INSERT OR IGNORE INTO shentong_region_class (province, city, region_class) VALUES (?,?,?)'
  );
  let seedCount = 0;
  for (const [p, c, cls] of REGION_SEED) {
    const info = ins.run(p, c, cls);
    if (info.changes > 0) seedCount++;
  }
  log(`种子写入: ${seedCount}/${REGION_SEED.length} 条新增`);

  // --- 3. orders 表扩 4 列（幂等：逐列检查后 ALTER）---
  const ordersCols = db.prepare("PRAGMA table_info(orders)").all().map(r => r.name);
  const ALTERS = [
    ['wms_platform',  'TEXT',       '来源平台（百世WMS/旺店通WMS/吉客云ERP/快麦ERP/聚水潭ERP/店管家ERP/多多打单/风速打单）'],
    ['to_province',   'TEXT',       '收件省/直辖市'],
    ['to_city',       'TEXT',       '收件市'],
    ['region_class',  'TEXT',       '地区分类：大偏远 / 小偏远 / 正常'],
  ];
  const addedCols = [];
  for (const [col, type, note] of ALTERS) {
    if (!ordersCols.includes(col)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${type}`);
      addedCols.push(col);
      log(`orders 新增列: ${col}`);
    }
  }

  // --- 4. 可选索引（看板查询高频）---
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_region ON orders(order_date, region_class)');
    log('索引 idx_orders_region 已就绪');
  } catch (e) { /* 忽略 */ }

  markApplied(db);
  log('迁移完成');
  return { skipped: false, seedCount, addedCols };
}

module.exports = { run, isApplied };
