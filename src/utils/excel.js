// Excel 读取助手：首个工作表 → 对象数组；表头容错匹配；日期解析
const xlsx = require('xlsx');

// 字段别名（表头容错：中英文、大小写、WMS/打单系统原始列名）
// ★ WMS/打单系统 8 家适配：百世wms/旺店通wms/吉客云/快麦/多多打单/聚水潭/店管家/风速
const ALIASES = {
  order_no: ['订单号', '订单', 'orderno', 'order_no',
    '外部单号', '客户单号', '原始单号', '平台订单号', '内部单号', '运单号', '快递单号',
    '发货单号', '物流单号', '单号', '使用单号'],
  customer_name: ['客户名称', '客户', 'customername', 'customer',
    '货主', '店铺', '使用方公司名称', '客户店铺', '使用单号店铺', '取号店铺名称',
    '订单店铺名称', '收件人'],
  owner_name: ['货主名称', '货主', 'ownername', 'owner_name', 'owner'],
  ship_quantity: ['发货量', '数量', 'qty', 'ship_quantity',
    '货品数量', '包裹数', '商品数量', '商品总数'],
  quantity: ['数量', '期初数量', 'qty', 'quantity'],
  unit: ['单位', 'unit'],
  order_date: ['订单日期', '日期', 'date', 'order_date',
    'OMS接单时间', '付款时间', '平台下单时间', '下单时间', '发货时间',
    '预约时间', '单号申请时间', '获取时间', '操作时间', '创建时间', '申请时间',
    '最新时间', 'WMS接单时间', '打印时间'],
  business_date: ['业务日期', '日期', 'date', '期初日期', 'business_date'],
  remark: ['备注', 'remark', '卖家备注', '客户备注', '便签'],
};

function readRows(buffer, opts) {
  opts = opts || {};
  let wb;
  try {
    wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    throw new Error('文件解析失败，请确认是 xlsx/xls 格式');
  }
  // 默认读所有 Sheet 合并（加 _sheet 字段标记来源）；
  // singleSheet=true 时只读第一个 Sheet（旧行为，供其他模块用）
  if (opts.singleSheet) {
    const name = wb.SheetNames[0];
    if (!name) throw new Error('文件中没有工作表');
    return xlsx.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
  }
  const all = [];
  wb.SheetNames.forEach(name => {
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
    for (const r of rows) { r._sheet = name; }
    all.push(...rows);
  });
  return all;
}

function pick(row, key) {
  const aliases = ALIASES[key] || [key];
  for (const a of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, a)) return row[a];
    const lower = String(a).toLowerCase();
    for (const k of Object.keys(row)) {
      if (String(k).toLowerCase() === lower) return row[k];
    }
  }
  return undefined;
}

// 返回 YYYY-MM-DD；无法解析返回 null
function parseDate(v) {
  if (v == null || v === '') return null;
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number') {
    const dt = xlsx.SSF.parse_date_code(v);
    if (!dt) return null;
    d = new Date(dt.y, dt.m - 1, dt.d);
  } else {
    const s = String(v).trim();
    if (!s) return null;
    const iso = s.includes('/') ? s.replace(/\//g, '-') : s;
    d = new Date(iso);
  }
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { ALIASES, readRows, pick, parseDate };
