// Excel 读取助手：首个工作表 → 对象数组；表头容错匹配；日期解析
const xlsx = require('xlsx');

// 字段别名（表头容错：中英文、大小写）
const ALIASES = {
  order_no: ['订单号', '订单', 'orderno', 'order_no'],
  customer_name: ['客户名称', '客户', 'customername', 'customer'],
  owner_name: ['货主名称', '货主', 'ownername', 'owner_name', 'owner'],
  ship_quantity: ['发货量', '数量', 'qty', 'ship_quantity'],
  quantity: ['数量', '期初数量', 'qty', 'quantity'],
  unit: ['单位', 'unit'],
  order_date: ['订单日期', '日期', 'date', 'order_date'],
  business_date: ['业务日期', '日期', 'date', '期初日期', 'business_date'],
  remark: ['备注', 'remark'],
};

function readRows(buffer) {
  let wb;
  try {
    wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    throw new Error('文件解析失败，请确认是 xlsx/xls 格式');
  }
  const name = wb.SheetNames[0];
  if (!name) throw new Error('文件中没有工作表');
  return xlsx.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
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
