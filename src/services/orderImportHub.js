// ============================================================================
// orderImportHub.js · 独立「订单导入」模块核心服务
// ----------------------------------------------------------------------------
// 约束：本模块数据与其他业务表**完全无关联**，只写 oih_batches / oih_rows。
// 能力：
//   1. 一个工作簿多 Sheet → 按 Sheet 名识别平台并分流；
//   2. 8 平台模板样式各异 → 自适应表头识别（别名字典 + 评分兜底）；
//   3. 收件省市（含「省 市 区」合并列）→ 规范化 → 申通偏远分类；
//   4. 大行数（10 万+）→ 流式解析 + 内存查重 + 单事务预编译批量写入。
// 依赖：xlsx / regionNormalize / expressRegion（仅读规则，不写其他表）。
// ============================================================================

const xlsx = require('xlsx');
const regionNormalize = require('./regionNormalize');

// ----------------------------------------------------------------------------
// 1. 平台识别
// ----------------------------------------------------------------------------
// 样例工作簿的 8 个 Sheet 名：百世wms / 旺店通wms / 吉客云 / 快麦 /
// 多多打单 / 聚水潭 / 店管家 / 风速。这里既匹配完整 Sheet 名，也匹配 Excel
// 里的「来源平台 / 平台」列值，便于单 Sheet 混合文件识别。
const PLATFORM_KEYS = ['百世', '旺店通', '吉客云', '快麦', '多多打单', '聚水潭', '店管家', '风速'];
const PLATFORM_ALIASES = {
  '百世': ['百世', '百世wms', '百世WMS', '百世物流'],
  '旺店通': ['旺店通', '旺店通wms', '旺店通WMS', '旺店通erp'],
  '吉客云': ['吉客云', '吉客云erp', '吉客云ERP'],
  '快麦': ['快麦', '快麦erp', '快麦ERP'],
  '多多打单': ['多多打单', '多多', '拼多多打单'],
  '聚水潭': ['聚水潭', '聚水潭erp', '聚水潭ERP', '聚水潭WMS'],
  '店管家': ['店管家', '店管家erp'],
  '风速': ['风速', '风速打单'],
};

function detectPlatform(sheetName, headers) {
  const sources = [String(sheetName || '')].concat((headers || []).map((h) => String(h || '')));
  for (const key of PLATFORM_KEYS) {
    for (const alias of PLATFORM_ALIASES[key]) {
      if (sources.some((s) => s.trim().toLowerCase() === alias.toLowerCase())) return key;
    }
  }
  // 表头特征兜底：某些工作表名称不含平台，但列名组合唯一
  const joined = (headers || []).map((h) => String(h || '').trim()).join('|');
  if (/原始单号|分拣序号|货品数量/.test(joined)) return '旺店通';
  if (/快递公司编码|取号店铺|充值维度/.test(joined)) return '聚水潭';
  if (/使用单号店铺|使用状态/.test(joined) && /运单号/.test(joined)) return '店管家';
  if (/子账号|电子面单账号|发件人地址/.test(joined)) return '风速';
  if (/外部单号|仓库实称重量|派送状态/.test(joined)) return '百世';
  if (/预约时间|物流接口|网点编码/.test(joined)) return '吉客云';
  if (/单号账户|网点名称|客户备注/.test(joined)) return '快麦';
  if (/平台订单号|模板名称|赠品信息/.test(joined)) return '多多打单';
  return null;
}

// ----------------------------------------------------------------------------
// 2. 自适应表头识别：统一字段 key → 别名列表（按样例真实表头扩充）
// ----------------------------------------------------------------------------
// 识别分三级：
//   ① 平台专属列映射（PLATFORM_FIELD_MAP，按真实样例表头逐一指定，最精确）；
//   ② 通用精确匹配（表头 === 别名）；
//   ③ 通用后缀匹配（带白名单，防止「收件人地址」被当成「收件人」、「无权限」被当成城市）。
const FIELD_ALIASES = {
  waybill_no: [
    '快递单号', '运单号', '物流单号', '快递编号', '电子面单号', '运单编号',
    '物流运单号', '单号',
  ],
  owner_name: [
    '货主', '货主名称', '客户名称', '客户', '客户店铺', '使用方公司名称',
    '取号店铺名称', '订单店铺名称', '客户名', '使用店铺', '店铺', '客户名称',
  ],
  shop_name: [
    '店铺', '店铺名称', '客户店铺', '订单所在店铺', '取号店铺名称',
    '订单店铺名称', '使用单号店铺', '销售渠道', '平台', '店铺名称',
  ],
  express_company: [
    '快递公司', '快递公司名称', '物流公司', '承运商', '物流类型',
    '快递公司编码', '快递类型', '电子面单类型', '快递编码', '物流代码',
  ],
  order_date: [
    '发货时间', '出库日期', '订单日期', '下单日期', '平台下单时间',
    '预约时间', '单号申请时间', '获取时间', '创建时间', '申请时间',
    '操作时间', '付款时间', '下单时间', '打印时间', '更新时间',
  ],
  to_province: ['收件人省', '收件省', '收货省份', '收件省份', '省', '省份', '省市区'],
  to_city: ['收件人市', '收件市', '收货城市', '收件城市', '市', '城市'],
  to_district: ['收件人区', '收件区县', '收货区', '收件区', '区县', '县', '区'],
  receiver_address: ['收件人地址', '收件地址', '收货地址', '详细地址', '地址', '目的地'],
  receiver_name: ['收件人', '收货人', '收件人姓名'],
  quantity: ['货品数量', '包裹数', '发货件数', '发货数量', '出库数量', '数量', '商品数量'],
};

// 按真实样例表头逐一指定的平台专属列映射（字段 → 精确表头名，优先级最高）
const PLATFORM_FIELD_MAP = {
  '百世': {
    waybill_no: '快递单号', owner_name: '客户', shop_name: '店铺',
    express_company: '快递公司', order_date: '发货时间',
    to_province: '省', to_city: '市', to_district: '区',
    receiver_address: '最新详情',
  },
  '旺店通': {
    waybill_no: '物流单号', owner_name: '货主', shop_name: '店铺',
    express_company: '物流公司', order_date: '发货时间',
    to_province: '省市区', receiver_address: '收件人地址',
    quantity: '货品数量',
  },
  '吉客云': {
    waybill_no: '物流单号', shop_name: '销售渠道',
    express_company: '物流公司', order_date: '预约时间',
    receiver_address: '地址',
  },
  '快麦': {
    waybill_no: '运单号', owner_name: '客户店铺', shop_name: '订单所在店铺',
    express_company: '快递公司', order_date: '单号申请时间',
    to_province: '目的地', receiver_address: '目的地',
  },
  '多多打单': {
    waybill_no: '快递单号', owner_name: '店铺', shop_name: '平台订单号',
    express_company: '快递公司', order_date: '发货时间',
    receiver_address: '收件人地址', quantity: '数量',
  },
  '聚水潭': {
    waybill_no: '快递单号', owner_name: '使用方公司名称', shop_name: '取号店铺名称',
    express_company: '快递公司名称', order_date: '创建时间',
  },
  '店管家': {
    waybill_no: '运单号', owner_name: '使用单号店铺', shop_name: '平台',
    order_date: '获取时间', to_province: '省市区', receiver_name: '收件人',
  },
  '风速': {
    waybill_no: '单号', owner_name: '客户名称', shop_name: '使用店铺',
    express_company: '快递公司', order_date: '操作时间',
    to_province: '收件人省', to_city: '收件人市', to_district: '收件人区',
    receiver_address: '发件人地址',
  },
};

// 后缀匹配白名单：只有这些表头允许被当作对应字段的后缀命中
const SUFFIX_WHITELIST = {
  to_province: ['省', '市', '区'],
  to_city: ['市'],
  to_district: ['区', '县'],
  receiver_address: ['地址', '详情'],
};

// 快递公司规范化：编码 STO→申通快递；名称含「申通」统一为申通快递
function normalizeCarrier(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (/^STO$/i.test(s)) return '申通快递';
  if (/申通/.test(s)) return '申通快递';
  if (/中通/.test(s)) return '中通快递';
  if (/圆通/.test(s)) return '圆通快递';
  if (/韵达/.test(s)) return '韵达快递';
  if (/顺丰|^SF$/i.test(s)) return '顺丰速运';
  if (/极兔/.test(s)) return '极兔速递';
  if (/邮政|EMS/i.test(s)) return '中国邮政';
  return s;
}

function isShentong(carrier) { return carrier === '申通快递'; }

// 表头 → 字段索引映射（列名规范化：去空格）
function normHeader(h) {
  return String(h == null ? '' : h).trim().replace(/\s+/g, '');
}

/**
 * 自适应表头识别。
 * @param {string[]} headers 表头数组
 * @param {string} [platform] 已识别的平台（有专属映射时优先用专属列）
 */
function buildColumnMap(headers, platform) {
  const normed = headers.map(normHeader);
  const used = new Set();
  const map = {};

  // ① 平台专属精确映射（最高优先级）
  const specific = platform ? PLATFORM_FIELD_MAP[platform] : null;
  if (specific) {
    for (const [field, header] of Object.entries(specific)) {
      const idx = normed.indexOf(normHeader(header));
      if (idx >= 0) { map[field] = idx; used.add(idx); }
    }
  }

  // ② 通用精确匹配
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (map[field] != null) continue;
    for (const alias of aliases) {
      const idx = normed.indexOf(normHeader(alias));
      if (idx >= 0 && !used.has(idx)) { map[field] = idx; used.add(idx); break; }
    }
  }

  // ③ 后缀匹配（仅白名单字段，避免把「收件人」「无权限」误判为省市区）
  for (const [field, suffixes] of Object.entries(SUFFIX_WHITELIST)) {
    if (map[field] != null) continue;
    for (const suffix of suffixes) {
      const idx = normed.findIndex((h, i) => !used.has(i) && h.length > suffix.length && h.endsWith(suffix));
      if (idx >= 0) { map[field] = idx; used.add(idx); break; }
    }
  }

  return map;
}

// ----------------------------------------------------------------------------
// 3. 单行的地区解析与分类
// ----------------------------------------------------------------------------
// 处理「山东省 临沂市 兰陵县」「北京 北京市 海淀区」「四川省攀枝花市东区****」
// 这类合并写法：先用 regionNormalize.splitCombined，再对省市区分别补全后缀。
function resolveRegion(provRaw, cityRaw, distRaw, address) {
  let p = String(provRaw == null ? '' : provRaw).trim();
  let c = String(cityRaw == null ? '' : cityRaw).trim();
  let d = String(distRaw == null ? '' : distRaw).trim();

  // 隐私脱敏值（无权限/刘**/****）不作为地区
  const isMasked = (s) => !s || /无权限|\*\*|^null$/.test(s);
  if (isMasked(p)) p = '';
  if (isMasked(c)) c = '';
  if (isMasked(d)) d = '';

  // 省市区全在一列（如「福建省南平市浦城县」「北京 北京市 海淀区」）
  if (p && !c && !d) {
    const parts = p.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      // 空格分隔：逐段识别（省 / 市 / 区）
      let idx = 0;
      const pm = parts[0].match(/(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|宁夏|新疆|西藏)/);
      if (pm) { p = pm[1]; idx = 1; }
      if (parts[idx]) c = parts[idx];
      if (parts[idx + 1]) d = parts[idx + 1];
    } else {
      const t = regionNormalize.splitCombined(p, '', '');
      p = t.p; c = t.c; d = t.d;
    }
  }
  // 详细地址里含省市区、而专列为空时兜底（如吉客云「地址」、多多打单「收件人地址」）
  // 注意：地址里的 ** 只是脱敏的门牌号，不影响省/市提取，故此处不用 isMasked 整串判废。
  if (!p && address) {
    const parsed = parseAddressRegion(String(address));
    p = parsed.province; c = c || parsed.city; d = d || parsed.district;
  }
  const norm = regionNormalize.normalizeRegion(p, c, d);
  return norm;
}

// 从完整地址文本中提取省 / 市（如「山东省 临沂市 兰陵县 卞庄街道」「四川省攀枝花市东区****」）
function parseAddressRegion(address) {
  const PROV = '(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|宁夏|新疆|西藏)';
  const m = address.match(new RegExp(PROV));
  if (!m) return { province: '', city: '', district: '' };
  const province = m[1];
  const rest = address.slice(m.index + m[1].length).replace(/^[省市区\s]+/, '');
  // 市：优先「XX市 / XX自治州 / XX地区」，否则用语名词典最长前缀
  let city = '';
  const cm = rest.match(/^([\u4e00-\u9fa5]{2,8}?)(?:市|自治州|地区|盟)/);
  if (cm) city = cm[0];
  else {
    const CITY_BASE = regionNormalize.CITY_BASE || [];
    const hit = CITY_BASE.slice().sort((a, b) => b.length - a.length).find((n) => rest.startsWith(n));
    if (hit) city = hit + '市';
  }
  return { province, city, district: '' };
}

// 申通偏远分类：优先按快递公司的可配置规则（expressRegion），未配置则内置种子。
// 传入 resolveRegionRule(carrier, province, city, district) 函数（返回 null 表示回退）。
function classify(region, carrier, resolveRegionRule, legacyLookup) {
  if (!region.province) return '正常';
  if (carrier && resolveRegionRule) {
    const cls = resolveRegionRule(carrier, region.province, region.city, region.district);
    if (cls) return cls;
  }
  if (legacyLookup) {
    const cls = legacyLookup(region.province, region.city);
    if (cls) return cls;
  }
  return '正常';
}

// ----------------------------------------------------------------------------
// 4. 工作簿解析：逐 Sheet 读取表头 + 流式行迭代
// ----------------------------------------------------------------------------
function readWorkbook(fileBuf) {
  let wb;
  try {
    wb = xlsx.read(fileBuf, { type: 'buffer', cellDates: true, dense: true });
  } catch (e) {
    throw new Error('文件解析失败，请确认是 xlsx/xls 格式：' + e.message);
  }
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: true });
    if (!aoa.length) return { sheetName: name, headers: [], rows: [] };
    return { sheetName: name, headers: aoa[0].map((h) => String(h == null ? '' : h)), rows: aoa.slice(1) };
  });
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    const d = v;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(v).trim();
}

function cellDate(v) {
  const s = cellText(v);
  if (!s) return '';
  // 2026/11/19 8:18:17 / 2026-11-19 08:25:53 / 2026/11/19
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return s.length <= 20 ? s : '';
}

function cellNumber(v) {
  const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

module.exports = {
  PLATFORM_KEYS, PLATFORM_ALIASES, FIELD_ALIASES,
  detectPlatform, buildColumnMap, normalizeCarrier, isShentong,
  resolveRegion, classify, readWorkbook, cellText, cellDate, cellNumber, normHeader,
  PLATFORM_FIELD_MAP, parseAddressRegion,
};
