const XLSX = require('xlsx');
const { WAREHOUSES, UNITS, validateByType, calcRow } = require('./workhours');

const fields = {
  date: '日期*', customer_name: '客户名称*', unit: '单位', cartons: '箱数*', tons: '吨数',
  cubic: '方数', pallets: '托盘数', main_hours: '主工时*', other_hours: '其他工时',
  remark: '备注', project: '项目*', workload: '作业量',
};
const schemas = {
  收货: ['date', 'customer_name', 'unit', 'cartons', 'tons', 'cubic', 'pallets', 'main_hours', 'other_hours', 'remark'],
  库内: ['date', 'project', 'unit', 'workload', 'main_hours', 'other_hours', 'remark'],
  后勤: ['date', 'project', 'main_hours', 'other_hours', 'remark'],
};
const numeric = new Set(['cartons', 'tons', 'cubic', 'pallets', 'main_hours', 'other_hours', 'workload']);
const headers = Object.fromEntries(Object.entries(schemas).map(([type, keys]) => [type + '工时', keys.map(k => fields[k])]));
function fail(message, sheet, line) {
  throw Object.assign(new Error(message), { code: 'THREE_HOURS_INPUT', sheet, line });
}
function dateValue(value, date1904) {
  let text = value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = XLSX.SSF.parse_date_code(Math.floor(value), { date1904 });
    if (d) text = [String(d.y).padStart(4, '0'), String(d.m).padStart(2, '0'), String(d.d).padStart(2, '0')].join('-');
  }
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text) || text.startsWith('0000')) fail('日期：应为真实日期（YYYY-MM-DD）');
  const d = new Date(text + 'T00:00:00Z');
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== text) fail('日期：不存在的日期');
  return text;
}
function valueOf(k, cell, date1904) {
  const label = fields[k];
  if (cell && (cell.f || cell.F || !['s', 'str', 'n', 'z'].includes(cell.t))) fail(label + '：不支持公式或该单元格类型');
  const v = typeof cell?.v === 'string' ? cell.v.trim() : cell?.v;
  if (v == null || v === '') {
    if (label.endsWith('*')) fail(label + '：必填');
    return k === 'other_hours' ? 0 : null;
  }
  if (k === 'date') return dateValue(v, date1904);
  if (numeric.has(k)) {
    const n = Number(v);
    if ((typeof v !== 'number' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) || !Number.isFinite(n) || n < 0) fail(label + '：必须为有限非负数');
    if (label.endsWith('*') && n <= 0) fail(label + '：必须大于零');
    return n;
  }
  if (typeof v !== 'string') fail(label + '：应为文本');
  if (k === 'unit' && !UNITS.includes(v)) fail('单位：应为' + UNITS.join('/'));
  return v;
}
function sheetRows(ws, sheet, keys) {
  const rows = new Map();
  for (const [address, cell] of Object.entries(ws)) {
    if (address.startsWith('!') || (!cell.f && !cell.F && cell.t !== 'e' && (cell.v == null || String(cell.v).trim() === ''))) continue;
    const { r, c } = XLSX.utils.decode_cell(address);
    if (c >= keys.length) fail(`${sheet} 第${r + 1}行 ${address}：超出模板列范围`, sheet, r + 1);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)[c] = cell;
  }
  keys.forEach((k, i) => {
    const cell = rows.get(0)?.[i];
    if (!cell || cell.f || cell.v !== fields[k]) fail(`${sheet} 第1行 ${XLSX.utils.encode_col(i)}列表头应为「${fields[k]}」`, sheet, 1);
  });
  rows.delete(0);
  return [...rows].sort(([a], [b]) => a - b);
}
function inspect(db, warehouse, buffer) {
  if (!WAREHOUSES.includes(warehouse)) fail('仓库非法');
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) fail('文件格式应为 .xlsx');
  if (buffer.length > 10 * 1024 * 1024) fail('文件大小不能超过 10 MB');
  let book;
  try { book = XLSX.read(buffer, { type: 'buffer', bookFiles: true }); }
  catch (_) { fail('无法读取工作簿，请上传未损坏的 .xlsx 文件'); }
  const contentTypes = book.files?.['[Content_Types].xml']?.content;
  if (!contentTypes || !Buffer.from(contentTypes).toString().includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')) fail('文件格式应为 .xlsx');
  const expected = ['填写说明', ...Object.keys(headers)];
  if (book.SheetNames.length !== expected.length || expected.some(s => !book.SheetNames.includes(s))) fail('工作表名称应为：' + expected.join('、'));
  const customers = new Map();
  for (const c of db.prepare("SELECT customer_id,company_name,short_name,warehouse FROM customers WHERE is_deleted=0 AND coop_status='合作中'").all()) {
    if (!String(c.warehouse || '').split(/[,，、]/).some(w => w.trim() === warehouse)) continue;
    for (const name of new Set([c.short_name, c.company_name].filter(Boolean))) customers.set(name, customers.has(name) ? null : c);
  }
  const seen = new Map();
  function identity(r) {
    const type = r.work_type;
    const signature = JSON.stringify([...schemas[type].map(k => {
      if (k === 'customer_name') return r.customer_id ?? customers.get(r.customer_name)?.customer_id ?? r.customer_name;
      if (k === 'other_hours') return r[k] ?? 0;
      return r[k] === '' ? null : r[k] ?? null;
    }), r.shared_hours ?? 0]);
    const key = type === '收货' ? signature : JSON.stringify([r.date, r.project]);
    return [type + ':' + key, signature];
  }
  function remember(key, sig) {
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(sig);
  }
  for (const r of db.prepare("SELECT * FROM work_hours WHERE warehouse=? AND work_type IN ('收货','库内','后勤')").all(warehouse)) remember(...identity(r));
  const rows = [];
  for (const [type, keys] of Object.entries(schemas)) {
    const sheet = type + '工时';
    for (const [r, cells] of sheetRows(book.Sheets[sheet], sheet, keys)) {
      const meta = { sheet, line: r + 1 };
      try {
        const data = { warehouse, work_type: type, shared_hours: 0 };
        keys.forEach((k, i) => { data[k] = valueOf(k, cells[i], !!book.Workbook?.WBProps?.date1904); });
        if (type === '收货') {
          const c = customers.get(data.customer_name);
          if (!c) fail(c === null ? '客户名称：本仓存在重名客户，请使用唯一全称或简称' : '客户名称：未找到本仓合作中的客户');
          data.customer_id = c.customer_id;
          data.customer_name = c.short_name || c.company_name;
        }
        const err = validateByType(type, data, db);
        if (err) fail(err);
        calcRow(type, data);
        if (data.main_hours <= 0) fail('主工时：按三位小数入库后必须大于零');
        if (Object.values(data).some(v => typeof v === 'number' && !Number.isFinite(v))) fail('主工时或数量：派生值超出数值范围');
        const [key, sig] = identity(data);
        const existing = seen.get(key);
        if (existing && (existing.size > 1 || !existing.has(sig))) fail('项目：同仓同类型同日同项目的业务内容冲突');
        if (existing) rows.push({ ...meta, action: 'skip', reason: '业务字段完全相同' });
        else {
          remember(key, sig);
          rows.push({ ...meta, action: 'create', data });
        }
      } catch (err) {
        if (err.code !== 'THREE_HOURS_INPUT') throw err;
        rows.push({ ...meta, action: 'error', reason: err.message });
      }
    }
  }
  if (!rows.length) fail('三张工时表均为空，请至少填写一笔业务数据');
  const counts = { create: 0, skip: 0, error: 0 };
  for (const row of rows) counts[row.action]++;
  return { rows, total: rows.length, ...counts };
}
module.exports = { inspect, headers };
