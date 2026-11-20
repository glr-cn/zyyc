// ============================================================================
// ordersImport.js · 订单导入后端核心服务
// ----------------------------------------------------------------------------
// 职责：
//   1. 8 平台 WMS 列名 → 统一 schema 映射（PLATFORM_COL_MAP 常量表）
//   2. 收件省市解析 → 申通地区分类计算（classifyRegion）
//   3. 统一校验（客户/货主/发货量/单位/日期 + 地区分类）
//   4. 批量事务写入 orders + 自动 sale 出库流水 + 审计日志
//
// 复用：src/utils/excel.js readRows / pick / parseDate 已在 orders.js 用过，
//       这里直接 require。模板字段 TEMPLATE_FIELDS 也复用 orders.js 里那份。
// ============================================================================

const round3 = require('../utils/round');
const { readRows, pick, parseDate } = require('../utils/excel');
const auditLog = require('./auditLog');

// ★ 本地今天（不受时区影响）—— 替代 new Date().toISOString().slice(0,10) 取 UTC 日期
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ----------------------------------------------------------------------------
// 1. 统一 Schema · 8 平台列名映射表
// ----------------------------------------------------------------------------
// 统一 schema key → 中文标准列名（对外暴露）
const UNIFIED_COLUMNS = {
  order_no:       '订单号',
  customer_name:  '客户名称',
  owner_name:     '货主名称',
  ship_quantity:  '发货量',
  unit:           '单位',
  order_date:     '订单日期',
  payment_status: '付款状态',
  // 收件地址（地区分类依据）
  receiver_name:  '收件人',
  receiver_phone: '收件电话',
  to_province:    '收件省',
  to_city:        '收件市',
  to_district:    '收件区县',
  to_address:     '收件详细地址',
};

// 8 平台列名映射：统一 schema key → 该平台对应的表头列名（支持多候选，首命中）
// 设计说明：不同 WMS/打单系统 给的"省"列名差异大，这里把所有见过的别名都列出来，
// 运行时按顺序 pick() 取第一个有值的。
// ★★★ 2026-11-20 根因修复：快递单号类列名（快递单号/运单号/物流单号）必须优先于
//   「订单编号/订单号」——申通/中通等派件导出同时有这两列，订单查询模块按快递单号检索，
//   若 order_no 存了内部订单号则永远查不到（用户 23322 条导入全部命中此坑）。
//   TRACKING_NO_ALIASES 在 normalizeRow 中前置拼进 order_no 候选。
const TRACKING_NO_ALIASES = ['快递单号', '运单号', '物流单号', '快递编号', '快递单号 '];

// ★ 2026-11-20 发货时间修复：申通/百世等派件导出的日期列叫「发货时间」（含时分秒），
//   旧映射表缺少该别名 → 日期匹配不到，全部回退为导入当天。
//   现为缺失的平台补入「发货时间」候选；parseDate 解析时仅保留 YYYY-MM-DD，时分秒自动丢弃。
const PLATFORM_COL_MAP = {
  '百世WMS': {
    order_no:       ['订单编号', '订单号', '单号', '出库单号'],
    customer_name:  ['客户', '客户名称', '店铺', '货主', '货主名称'],
    owner_name:     ['货主名称', '货主', '客户'],
    ship_quantity:  ['发货件数', '发货量', '数量', '出库数量', '包裹数'],
    unit:           ['单位'],
    order_date:     ['出库日期', '发货时间', '订单日期', '发货日期', '创建时间'],
    to_province:    ['收货省份', '省', '收货省', '收件省份'],
    to_city:        ['收货城市', '市', '收货市', '收件城市'],
    to_district:    ['收件区县', '收货区', '收件区', '区县', '县', '镇', '区'],
    to_address:     ['收货地址', '详细地址', '收货详细地址', '收件地址'],
    receiver_name:  ['收货人', '收件人', '收货客户'],
    receiver_phone: ['收货电话', '收件电话', '电话', '联系电话'],
  },
  '旺店通WMS': {
    order_no:       ['订单编号', '订单号', '单号'],
    customer_name:  ['客户', '使用方公司名称', '客户店铺名称', '货主', '货主名称'],
    owner_name:     ['货主名称', '货主', '客户'],
    ship_quantity:  ['发货件数', '发货量', '数量', '出库数量'],
    unit:           ['单位'],
    order_date:     ['出库日期', '发货时间', '订单日期', '发货日期'],
    to_province:    ['收货省份', '省', '收货省', '收件省份'],
    to_city:        ['收货城市', '市', '收货市', '收件城市'],
    to_district:    ['收件区县', '收货区', '收件区', '区县', '县', '镇', '区'],
    to_address:     ['收货地址', '详细地址', '收货详细地址', '收件地址'],
    receiver_name:  ['收货人', '收件人', '收货客户'],
    receiver_phone: ['收货电话', '收件电话', '电话', '联系电话'],
  },
  '吉客云ERP': {
    order_no:       ['订单编号', '订单号', '单号', '销售单号'],
    customer_name:  ['客户', '客户名称', '店铺名称', '货主', '店铺'],
    owner_name:     ['货主', '客户'],
    ship_quantity:  ['发货数量', '出库数量', '数量', '发货件数'],
    unit:           ['单位'],
    order_date:     ['发货日期', '发货时间', '出库日期', '订单日期', '下单日期'],
    to_province:    ['收件省份', '省', '收货省份'],
    to_city:        ['收件城市', '市', '收货城市'],
    to_district:    ['收件区县', '收货区', '收件区', '区县', '县', '镇', '区'],
    to_address:     ['收件地址', '详细地址', '收货地址'],
    receiver_name:  ['收件人', '收货人'],
    receiver_phone: ['收件电话', '收货电话', '联系电话'],
  },
  '快麦ERP': {
    order_no:       ['订单号', '订单编号', '单号', '销售单号'],
    customer_name:  ['店铺', '店铺名称', '客户', '客户店铺'],
    owner_name:     ['货主', '客户'],
    ship_quantity:  ['出库数量', '发货数量', '数量', '发货件数'],
    unit:           ['单位'],
    order_date:     ['发货日期', '发货时间', '出库日期', '订单日期', '打印时间'],
    to_province:    ['收件省份', '省', '省份', '收货省份'],
    to_city:        ['收件城市', '市', '城市', '收货城市'],
    to_district:    ['收件区县', '收货区', '收件区', '区县', '县', '镇', '区'],
    to_address:     ['收件地址', '详细地址', '收货地址', '地址'],
    receiver_name:  ['收件人', '收货人'],
    receiver_phone: ['收件电话', '收货电话', '联系电话', '电话'],
  },
  '聚水潭ERP': {
    order_no:       ['销售单号', '订单号', '单号'],
    customer_name:  ['店铺名称', '客户店铺', '客户', '店铺'],
    owner_name:     ['货主', '客户'],
    ship_quantity:  ['出库数量', '发货数量', '数量', '发货件数'],
    unit:           ['单位'],
    order_date:     ['发货日期', '发货时间', '出库日期', '订单日期'],
    to_province:    ['收件省份', '省', '收货省份'],
    to_city:        ['收件城市', '市', '收货城市'],
    to_district:    ['收件区县', '收货区', '收件区', '区县', '县', '镇', '区'],
    to_address:     ['收件地址', '详细地址', '收货地址'],
    receiver_name:  ['收件人', '收货人'],
    receiver_phone: ['收件电话', '收货电话', '联系电话'],
  },
  '店管家ERP': {
    order_no:       ['订单号', '订单编号', '单号'],
    customer_name:  ['店铺名称', '店铺', '客户', '客户店铺'],
    owner_name:     ['货主', '客户'],
    ship_quantity:  ['发货数量', '出库数量', '数量', '发货件数'],
    unit:           ['单位'],
    order_date:     ['发货日期', '发货时间', '出库日期', '订单日期', '打印时间'],
    to_province:    ['省', '省份', '收件省', '收货省份'],
    to_city:        ['市', '城市', '收件市', '收货城市'],
    to_district:    ['收件区县', '收货区', '收件区', '区县', '县', '镇', '区'],
    to_address:     ['详细地址', '地址', '收件地址', '收货地址'],
    receiver_name:  ['收件人', '收货人'],
    receiver_phone: ['收件电话', '收货电话', '联系电话'],
  },
  '多多打单': {
    order_no:       ['订单号', '订单编号', '单号', '电子面单号'],
    customer_name:  ['店铺名称', '店铺', '客户', '取号店铺名称', '使用单号店铺'],
    owner_name:     ['货主', '客户'],
    ship_quantity:  ['数量', '发货件数', '包裹数', '商品数量'],
    unit:           ['单位'],
    order_date:     ['打印时间', '发货时间', '下单时间', '订单日期', '获取时间'],
    to_province:    ['省', '省份', '收件省'],
    to_city:        ['市', '城市', '收件市'],
    to_district:    ['收件区县', '收货区', '收件区', '区县', '县', '镇', '区'],
    to_address:     ['详细地址', '地址', '收件地址'],
    receiver_name:  ['收件人', '收货人'],
    receiver_phone: ['收件电话', '收货电话', '联系电话'],
  },
  '风速打单': {
    order_no:       ['订单号', '订单编号', '单号', '电子面单号'],
    customer_name:  ['店铺名称', '店铺', '客户', '取号店铺名称'],
    owner_name:     ['货主', '客户'],
    ship_quantity:  ['数量', '发货件数', '包裹数', '商品数量'],
    unit:           ['单位'],
    order_date:     ['打印时间', '发货时间', '下单时间', '订单日期', '获取时间'],
    to_province:    ['省', '省份', '收件省'],
    to_city:        ['市', '城市', '收件市'],
    to_district:    ['收件区县', '收货区', '收件区', '区县', '县', '镇', '区'],
    to_address:     ['详细地址', '地址', '收件地址'],
    receiver_name:  ['收件人', '收货人'],
    receiver_phone: ['收件电话', '收货电话', '联系电话'],
  },
};

// 对外暴露：平台列表 + 统一列名
const WMS_PLATFORMS = Object.keys(PLATFORM_COL_MAP);

// ----------------------------------------------------------------------------
// 2. 地区分类查询（import 时就算好写入 orders.region_class）
// ----------------------------------------------------------------------------
function classifyRegion(db, province, city) {
  if (!province) return '正常';
  // ① 精确命中 (省, 市)
  if (city) {
    const exact = db.prepare('SELECT region_class FROM shentong_region_class WHERE province=? AND city=?').get(province, city);
    if (exact) return exact.region_class;
  }
  // ② 模糊命中 (省, NULL)
  const fuzzy = db.prepare('SELECT region_class FROM shentong_region_class WHERE province=? AND city IS NULL').get(province);
  if (fuzzy) return fuzzy.region_class;
  // ③ 兜底
  return '正常';
}

// ----------------------------------------------------------------------------
// 3. 统一归一：platform + raw row → 统一 schema row
// ----------------------------------------------------------------------------
function normalizeRow(platform, rawRow) {
  const map = PLATFORM_COL_MAP[platform];
  if (!map) {
    // 未知平台：直接用原列名兜底
    return rawRow;
  }
  const normalized = {};
  for (const [schemaKey, aliases] of Object.entries(map)) {
    if (!aliases) continue;
    // ★ 兜底：平台别名 + 统一模板表头（保证「下载模板→填写→导入」对全部平台永远可用）
    const unifiedLabel = UNIFIED_COLUMNS[schemaKey];
    let all = unifiedLabel ? [...aliases, unifiedLabel] : aliases;
    // ★★★ 快递单号优先（2026-11-20 根因修复）：派件导出同时有快递单号与订单号时，
    //   order_no 必须存快递单号，否则订单查询按单号检索永远落空
    if (schemaKey === 'order_no') {
      all = [...TRACKING_NO_ALIASES, ...all];
    }
    for (const alias of all) {
      if (rawRow[alias] != null && String(rawRow[alias]).trim() !== '') {
        normalized[schemaKey] = rawRow[alias];
        break;
      }
    }
  }
  return normalized;
}

// ----------------------------------------------------------------------------
// 4. 批量导入（复用 orders.js 现有逻辑 + 扩 4 列 + 地区分类）
// ----------------------------------------------------------------------------
function processImport({ db, req, fileBuf, platform, manualColumnMap }) {
  const rows = readRows(fileBuf);
  if (!rows.length) return { success: 0, failed: 0, failures: [{ row: 1, reason: '文件中没有数据行（请保留表头）' }] };

  // 自动创建客户缓存
  const autoCustCache = new Map();
  const failures = [];
  const successItems = [];

  // ★ 边界校验（2026-11-20）：导入查重——库内已有同号订单或本批次内重复 → 跳过不插入，
  //   防止同一文件重复导入造成数据翻倍（work_hours 有查重，orders 此前缺失）
  const existingNos = new Set(
    db.prepare('SELECT order_no FROM orders WHERE order_no IS NOT NULL').all().map((r) => r.order_no)
  );
  const batchNos = new Set();

  rows.forEach((rawRow, i) => {
    const excelRow = i + 2;
    const row = platform
      ? normalizeRow(platform, rawRow)
      : rawRow;

    const customerName = String(pick(row, 'customer_name') ?? '').trim();
    const ownerName = String(pick(row, 'owner_name') ?? '').trim();
    const orderNo = String(pick(row, 'order_no') ?? '').trim();
    let qtyRaw = pick(row, 'ship_quantity');
    const unit = String(pick(row, 'unit') ?? '').trim();
    const dateRaw = pick(row, 'order_date');
    const paymentStatus = String(pick(row, 'payment_status') ?? '未收').trim();

    // 收件地址（地区分类依据）
    const toProvince = String(pick(row, 'to_province') ?? '').trim();
    const toCity = String(pick(row, 'to_city') ?? '').trim();
    const toDistrict = String(pick(row, 'to_district') ?? '').trim();

    // ★ 导入查重：单号已在库 / 本批次已出现 → 跳过（在客户解析前拦截，避免无谓建客户）
    if (orderNo && (existingNos.has(orderNo) || batchNos.has(orderNo))) {
      return failures.push({ row: excelRow, orderNo, reason: '快递单号已存在，跳过（防重复导入）' });
    }
    if (orderNo) batchNos.add(orderNo);

    if (!customerName) return failures.push({ row: excelRow, reason: '客户名称为空' });

    // 客户查找 / 自动创建
    let customer = null;
    const findCust = db.prepare('SELECT * FROM customers WHERE company_name=? OR short_name=?');
    customer = findCust.get(customerName, customerName);
    if (!customer) {
      if (autoCustCache.has(customerName)) {
        const cached = autoCustCache.get(customerName);
        customer = { customer_id: cached.customer_id, owner_user_id: cached.owner_user_id };
      } else {
        try {
          const info = db.prepare(
            'INSERT INTO customers (company_name,short_name,coop_status,created_at) VALUES (?,?,?,?)'
          ).run(customerName, customerName, '合作中', localToday());
          customer = { customer_id: info.lastInsertRowid, owner_user_id: req.user.user_id };
          autoCustCache.set(customerName, { customer_id: info.lastInsertRowid, owner_user_id: req.user.user_id });
        } catch (e) {
          return failures.push({ row: excelRow, reason: '自动创建客户失败：' + e.message });
        }
      }
    }

    // 货主兜底 = 客户名
    const finalOwner = ownerName || customerName;

    // 发货量 / 单位 / 日期
    let qty = Number(qtyRaw);
    if (qtyRaw === '' || qtyRaw == null || isNaN(qty) || qty <= 0) { qty = 1; }
    const finalUnit = unit || '件';
    let date = parseDate(dateRaw);
    if (!date) date = localToday();

    // 地区分类（就写 orders.region_class，不上报给前端）
    const regionClass = classifyRegion(db, toProvince, toCity);

    successItems.push({
      excelRow, customerName, ownerName: finalOwner, orderNo,
      qty: round3(qty), unit: finalUnit, date, paymentStatus,
      toProvince: toProvince || null, toCity: toCity || null, toDistrict: toDistrict || null,
      regionClass, customer,
    });
  });

  // 批量事务
  let success = 0;
  const orderStmt = db.prepare(
    'INSERT INTO orders (order_no,customer_id,owner_name,ship_quantity,unit,order_date,payment_status,owner_user_id,wms_platform,to_province,to_city,to_district,region_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const invStmt = db.prepare(
    "INSERT INTO inventory_transactions (order_id,owner_name,quantity,direction,reference_type,business_date,remark) VALUES (?,?,?,'out','sale',?,?)"
  );
  db.exec('BEGIN');
  for (const it of successItems) {
    try {
      const info = orderStmt.run(
        it.orderNo || 'ORD' + Date.now() + Math.floor(Math.random() * 1000),
        it.customer.customer_id, it.ownerName, it.qty, it.unit, it.date,
        it.paymentStatus, it.customer.owner_user_id,
        platform || '未知', it.toProvince, it.toCity, it.toDistrict, it.regionClass,
      );
      invStmt.run(info.lastInsertRowid, it.ownerName, it.qty, it.date, '订单导入自动出库');
      success++;
    } catch (e) {
      failures.push({ row: it.excelRow, reason: '写入失败: ' + e.message });
    }
  }
  if (success > 0) db.exec('COMMIT'); else db.exec('ROLLBACK');

  // 批次审计
  auditLog.writeLog(req, {
    table: 'orders', module: '其他业务', action: 'import',
    targetId: 'import:' + (platform || '通用') + ':' + (req.file?.originalname || 'orders.xlsx'),
    content: {
      platform, file: req.file?.originalname || '',
      success, failed: failures.length, failures: failures.slice(0, 50),
    },
  });

  return { success, failed: failures.length, failures };
}

module.exports = {
  WMS_PLATFORMS, PLATFORM_COL_MAP, UNIFIED_COLUMNS,
  classifyRegion, normalizeRow, processImport,
};
