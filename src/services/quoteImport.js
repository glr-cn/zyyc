// 物流报价 Excel 导入解析（纯逻辑，可单测）：
// 模板列：网点名称、快递编码、抛比、省份、城市、区县、1kg、2kg … 40kg
// 容错：表头乱序/容错匹配；空行直接跳过；单元格为空 → 该重量段不入库；
//       非数字价格 → 该行进失败清单；必填缺失（网点/编码/抛比非法）→ 失败清单。
// 与 customerImport.js 同范式：返回 { rows:[可入库行], failures:[{row,reason}] }
const xlsx = require('xlsx');
const round3 = require('../utils/round');
const { normalizeRegion } = require('./regionNormalize');

const WEIGHT_COLS = Array.from({ length: 40 }, (_, i) => i + 1); // 1..40

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
const cellVal = (v) => (v == null ? '' : String(v).trim());

// 空 → null（跳过）；非数字 → undefined（非法）
function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

// 解析 Excel 缓冲 → { rows, failures }
function parseQuoteExcel(buffer) {
  let wb;
  try {
    wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    return { rows: [], failures: [{ row: 0, reason: '文件解析失败，请确认是 xlsx/xls 格式' }] };
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], failures: [{ row: 0, reason: '文件中没有工作表' }] };
  const raw = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  if (!raw.length) return { rows: [], failures: [] };

  // 表头容错：归一化映射（1kg / 1 kg / 1KG / 1公斤 都认）
  const hmap = {};
  Object.keys(raw[0]).forEach((k) => { hmap[norm(k)] = k; });
  const get = (r, ...names) => {
    for (const n of names) {
      const k = hmap[norm(n)];
      if (k != null && r[k] != null) return r[k];
    }
    return '';
  };

  const rows = [];
  const failures = [];
  raw.forEach((r, idx) => {
    const lineNo = idx + 2; // 含表头行
    // 空行：所有单元格皆空 → 直接跳过（容错）
    const vals = Object.values(r).map(cellVal);
    if (vals.every((v) => v === '')) return;

    const network = cellVal(get(r, '网点名称'));
    const code = cellVal(get(r, '快递编码'));
    const ratioRaw = cellVal(get(r, '抛比'));
    const province = cellVal(get(r, '省份'));
    const city = cellVal(get(r, '城市'));
    const district = cellVal(get(r, '区县', '县区'));

    if (!network) return failures.push({ row: lineNo, reason: '网点名称为空' });
    if (!code) return failures.push({ row: lineNo, reason: '快递编码为空' });
    if (ratioRaw === '') return failures.push({ row: lineNo, reason: '抛比为空' });
    if (!province) return failures.push({ row: lineNo, reason: '省份为空' });
    const ratio = Number(ratioRaw);
    if (isNaN(ratio) || !Number.isInteger(ratio) || ratio <= 0)
      return failures.push({ row: lineNo, reason: '抛比必须为正整数' });

    const price_rules = [];
    for (const w of WEIGHT_COLS) {
      const nv = numOrNull(cellVal(get(r, w + 'kg', w + '公斤')));
      if (nv === null) continue;                                 // 空单元格 → 不生成该重量段
      if (nv === undefined) return failures.push({ row: lineNo, reason: `${w}kg 价格不是有效数字` });
      price_rules.push({ weight: w, price: round3(nv) });
    }
    if (!price_rules.length) return failures.push({ row: lineNo, reason: '未填写任何 1-40kg 报价' });

    // 省/市/区 标准化清洗（仅作用于本次导入的新数据，不触碰已有数据）
    const clean = normalizeRegion(province, city, district);
    rows.push({
      network_name: network,
      express_code: code,
      province: clean.province,
      city: clean.city,
      district: clean.district,
      volume_ratio: ratio,
      price_rules: JSON.stringify(price_rules),
      remark: '',
    });
  });

  // 抛比一致性校验：同一快递编码下的抛比必须完全一致，否则阻断该编码入库并报错。
  // 绝不静默用 MAX() 掩盖 —— 否则会导致后续智能测单运费算错、严重亏损。
  const byCode = {};
  for (const r of rows) (byCode[r.express_code] ||= []).push(r);
  const badCodes = [];
  for (const code in byCode) {
    const ratios = new Set(byCode[code].map((r) => r.volume_ratio));
    if (ratios.size > 1) badCodes.push(code);
  }
  if (badCodes.length) {
    const bad = new Set(badCodes);
    const kept = [];
    for (const r of rows) {
      if (bad.has(r.express_code)) {
        failures.push({ row: 0, reason: `快递编码 [${r.express_code}] 存在多个不同的抛比，请检查 Excel 数据` });
      } else {
        kept.push(r);
      }
    }
    rows.length = 0;
    Array.prototype.push.apply(rows, kept);
  }

  return { rows, failures };
}

// 生成导入模板 AOA（首行表头，次行示例：仅 1-3kg 有价，其余留空演示"空不参与"）
function buildTemplateAOA() {
  const header = ['网点名称', '快递编码', '抛比', '省份', '城市', '区县', ...WEIGHT_COLS.map((w) => w + 'kg')];
  const ex = ['中通-杭州', 'ZT-HZ', 6000, '浙江省', '杭州市', '西湖区'];
  for (let w = 1; w <= 40; w++) ex.push(w <= 3 ? Number((3 + w * 0.5).toFixed(2)) : '');
  return [header, ex];
}

module.exports = { parseQuoteExcel, buildTemplateAOA, WEIGHT_COLS };
