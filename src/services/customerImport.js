// 仓储客户 Excel 导入：表头严格校验 / 行级校验 / 值归一化
// 纯逻辑模块，不依赖数据库与表结构，可独立单测（见 scripts/test_customer_import.js）
const xlsx = require('xlsx');
const round3 = require('../utils/round');

// 严格 21 列表头（「序号」「排序号」「默认单位」为可选列；其余 18 列必填）
//   * 模板下载：首列自带「序号」+ 连续递增示例值 1,2,3...（用户可手动填，也可留空）
//     新增「排序号」列：可选正整数，空=排最后；导入后写入 customers.sort_order
//     新增「默认单位」列：可选，值=单/件/箱；空=兜底 '单'；导入后写入 customers.default_unit
//   * 导入时：表头若含「序号」列则忽略其值；若表头不含「序号」列也通过（兼容旧模板）
//   * 错误定位：始终用真实 Excel 行号（从 2 开始，表头=1），与是否有序号列无关
const DEFAULT_UNITS = ['单', '件', '箱'];
const OPTIONAL_HEADERS = new Set(['序号', '排序号', '默认单位']);
const HEADERS = [
  '序号', '排序号',
  '货主代码', '公司全称', '客户简称', '所在仓库', '客户联系人', '联系电话', '客户地址',
  'ERP版本名称', '产品类型', '电商平台', '商品种类数', '打款账户', '预充单价', '截单时间',
  '物流公司控制', '效期管理', '合作状态', '默认单位', '备注',
];

const WAREHOUSES = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];
const COOP = ['合作中', '暂停', '终止'];
const CUTOFF_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 解析工作表：返回 [{ excelRow, raw }]，excelRow 为真实 Excel 行号（表头=1）
function readSheet(buffer) {
  // xlsx=ZIP(PK\x03\x04) / xls=OLE2(D0CF11E0)；xlsx.read 会把纯文本当 CSV 静默解析，先挡掉
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new Error('文件解析失败，请确认是 xlsx/xls 格式');
  }
  const sig = buffer.subarray(0, 4).toString('hex');
  if (sig !== '504b0304' && sig !== 'd0cf11e0') {
    throw new Error('文件解析失败，请确认是 xlsx/xls 格式（不支持 CSV/文本文件）');
  }
  let wb;
  try {
    wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    throw new Error('文件解析失败，请确认是 xlsx/xls 格式');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('文件中没有工作表');

  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const head = (aoa[0] || []).map((x) => String(x == null ? '' : x).trim());
  const dup = head.filter((h, i) => h && head.indexOf(h) !== i);
  if (dup.length) throw new Error('表头存在重复列：' + [...new Set(dup)].join('、'));

  // 必填列（HEADERS 去掉可选列）
  const REQUIRED_HEADERS = HEADERS.filter((h) => !OPTIONAL_HEADERS.has(h));
  const missing = REQUIRED_HEADERS.filter((h) => !head.includes(h));
  // 未知列：不在 HEADERS 全集里的才算（可选列也算合法）
  const extra = head.filter((h) => h && !HEADERS.includes(h));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push('缺少[' + missing.join('、') + ']');
    if (extra.length) parts.push('未知列[' + extra.join('、') + ']');
    throw new Error('表头不匹配：' + parts.join(' '));
  }

  const out = [];
  for (let i = 1; i < aoa.length; i++) {
    const cells = aoa[i] || [];
    if (!cells.some((v) => String(v == null ? '' : v).trim() !== '')) continue; // 跳空行，保留真实行号
    const raw = {};
    head.forEach((h, j) => { if (h) raw[h] = cells[j] == null ? '' : cells[j]; });
    out.push({ excelRow: i + 1, raw });
  }
  return out;
}

// 多仓归一化：中文顿号/逗号/分号/斜杠/空白 → 英文逗号拼接；非法仓名单独返回
function normalizeWarehouse(v) {
  const parts = String(v == null ? '' : v)
    .split(/[,，、;；\/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const uniq = [...new Set(parts)];
  return {
    value: uniq.join(','),
    bad: uniq.filter((p) => !WAREHOUSES.includes(p)),
  };
}

// 截单时间：支持 '16:00' / '16：00' / Excel 时间数字 / Date 对象
function parseCutoff(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return String(v.getHours()).padStart(2, '0') + ':' + String(v.getMinutes()).padStart(2, '0');
  }
  if (typeof v === 'number') {
    const t = xlsx.SSF.parse_date_code(v);
    return t ? String(t.H).padStart(2, '0') + ':' + String(t.M).padStart(2, '0') : null;
  }
  const s = String(v).trim().replace(/：/g, ':');
  return CUTOFF_RE.test(s) ? s : null;
}

// 效期管理：Excel 中的「是/否」及常见等价写法 → 统一 '是'/'否'
function parseYesNo(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (['是', '√', 'Y', 'YES', 'TRUE', '1', '有', '需要'].includes(s)) return '是';
  if (['否', '×', 'N', 'NO', 'FALSE', '0', '无', '不需要', ''].includes(s)) return '否';
  return null;
}

// 单行校验 + 归一化：返回 { row } 或 { error }
// requireWarehouse：仓储客户必填；共享单号/快运物流页面隐藏仓库录入，允许为空
function parseRow(raw, { requireWarehouse = true } = {}) {
  const g = (h) => (raw[h] == null ? '' : String(raw[h]).trim());
  const errs = [];

  const code = g('货主代码');
  const company = g('公司全称');
  if (!company) errs.push('公司全称为空（Upsert 主键必填）');

  const wh = normalizeWarehouse(raw['所在仓库']);
  if (requireWarehouse && !wh.value) errs.push('所在仓库为空');
  if (wh.bad.length) errs.push('所在仓库含非法仓名：' + wh.bad.join('、'));

  const count = g('商品种类数') === '' ? 0 : Number(g('商品种类数'));
  if (!Number.isInteger(count) || count < 0) errs.push('商品种类数必须为非负整数');

  const price = g('预充单价') === '' ? 0 : Number(g('预充单价'));
  if (isNaN(price) || price < 0) errs.push('预充单价必须为非负数字');

  const cutoff = parseCutoff(raw['截单时间']);
  if (g('截单时间') && !cutoff) errs.push('截单时间格式应为 HH:mm（如 16:00）');

  const expiry = parseYesNo(raw['效期管理']);
  if (expiry === null) errs.push('效期管理应为 是/否');

  const coop = g('合作状态') || '合作中';
  if (!COOP.includes(coop)) errs.push('合作状态非法（应为 ' + COOP.join('/') + '）');

  // ★ 排序号：可选正整数；空值 = 排最后（9999）
  const sortRaw = g('排序号');
  let sortOrder = 9999;
  if (sortRaw !== '') {
    const s = Number(sortRaw);
    if (!Number.isInteger(s) || s <= 0) errs.push('排序号必须为正整数（留空则排最后）');
    else sortOrder = s;
  }

  // ★ 默认单位：可选，合法值 单/件/箱；空值兜底 '单'
  const duRaw = g('默认单位');
  let defaultUnit = '单';
  if (duRaw !== '') {
    if (!DEFAULT_UNITS.includes(duRaw)) errs.push('默认单位非法（应为 ' + DEFAULT_UNITS.join('/') + '）');
    else defaultUnit = duRaw;
  }

  if (errs.length) return { error: errs.join('；') };

  return {
    row: {
      customer_code: code || null,          // 选填；空串转 NULL 以利用 UNIQUE 允许多条 NULL
      company_name: company,               // Upsert 业务主键
      short_name: g('客户简称'),
      warehouse: wh.value,
      contact_person: g('客户联系人'),
      phone: g('联系电话'),
      address: g('客户地址'),
      erp_version: g('ERP版本名称'),
      product_type: g('产品类型'),
      ecommerce_platform: g('电商平台'),
      product_count: count,
      payment_account: g('打款账户'),
      prepaid_price: round3(price),
      cutoff_time: cutoff,
      logistics_control: g('物流公司控制'),
      expiry_mgmt: expiry,
      coop_status: coop,
      default_unit: defaultUnit,             // ★ 默认单位（写入 customers.default_unit）
      remark: g('备注'),
      sort_order: sortOrder,               // ★ 排序号（全局，导入统一写 customers.sort_order）
    },
  };
}

// 生成导入模板（含 3 行连续递增序号示例）
function buildTemplate(withSample = true) {
  const aoa = [HEADERS.slice()];
  if (withSample) {
    // 3 行示例：序号连续 1/2/3；排序号显式填 1/2/3 示范；默认单位显式填 单 示范
    aoa.push([
      1, 1, 'C0001', '示例客户有限公司', '示例', '龙湖仓,佳新仓', '张三', '13800000000', '上海市浦东新区',
      '旺店通', '日用百货', '淘宝,抖音', 120, '6222****1234', 0.35, '16:00', '申通', '是', '合作中', '单',
      '示例行，正式导入前请删除',
    ]);
    aoa.push([
      2, 2, 'C0002', '示例电商贸易', '电商示例', '速远仓', '李四', '13900000000', '广州市白云区',
      '聚水潭', '家居用品', '拼多多', 85, '6228****5678', 0.42, '15:30', '中通', '否', '合作中', '件',
      '',
    ]);
    aoa.push([
      3, 3, 'C0003', '示例供应链公司', '供应链示例', '开元仓,龙湖仓', '王五', '13700000000', '深圳市宝安区',
      '万里牛', '食品饮料', '京东', 200, '6217****9012', 0.28, '17:00', '顺丰', '是', '暂停', '箱',
      '暂停合作，待确认',
    ]);
  }
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  // 序号列宽 6，其他列宽 16
  ws['!cols'] = HEADERS.map((h, i) => ({ wch: i === 0 ? 6 : 16 }));
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, '仓储客户');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  HEADERS, WAREHOUSES, COOP, CUTOFF_RE,
  readSheet, normalizeWarehouse, parseCutoff, parseYesNo, parseRow, buildTemplate,
};
