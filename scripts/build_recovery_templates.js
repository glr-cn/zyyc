'use strict';
// ============================================================================
//  生成「线上可直接导入」的恢复模板（Excel）
// ----------------------------------------------------------------------------
//  用法：node scripts/build_recovery_templates.js
//  输出（到 scripts/out/ 目录）：
//    1) 客户资料_恢复模板.xlsx    —— 18 列表头，符合 /api/customers/import 严格校验
//    2) 发货工时_恢复模板.xlsx    —— 龙湖仓发货工时，符合 /api/workhours/import 表头
//    3) 物流报价_恢复模板.xlsx    —— 网点名称/编码/抛比/省/市/区 + 1kg…40kg
//
//  背景：线上数据库在一次发布后被重建成空库（2026-11-16 事故）。
//  本脚本把用户机器上的真实业务 Excel 转换成 ERP「自带导入格式」的模板，
//  使其可以在【线上系统】通过现有的「导入」按钮一键恢复数据，无需改库、无需连库。
// ============================================================================
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUT = path.join(__dirname, 'out');
const SRC = {
  owner: 'C:/Users/顾力瑞/Desktop/旺店通货主.xlsx',
  assign: 'C:/Users/顾力瑞/Desktop/客服负责客户表.xlsx',
  hours: 'C:/Users/顾力瑞/Desktop/龙湖仓_发货工时_导入模板_2026-11-08 (2)(1).xlsx',
  quote: 'C:/Users/顾力瑞/Downloads/物流公司报价_2026-11-15.xlsx',
};
const WAREHOUSES = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];

// 客户导入严格表头（与 src/services/customerImport.js HEADERS 保持一致）
const CUST_HEADERS = [
  '货主代码', '公司全称', '客户简称', '所在仓库', '客户联系人', '联系电话', '客户地址',
  'ERP版本名称', '产品类型', '电商平台', '商品种类数', '打款账户', '预充单价', '截单时间',
  '物流公司控制', '效期管理', '合作状态', '备注',
];

// 工时导入表头（与 src/routes/workhours.js IMPORT_HEADER 保持一致）
const WH_HEADERS = ['日期', '客户名称', '单位', '发货单量', '主工时', '其他工时', '备注'];

function readRows(file, sheet) {
  if (!fs.existsSync(file)) return null;
  const wb = XLSX.readFile(file);
  const sn = sheet || wb.SheetNames[0];
  if (!wb.Sheets[sn]) return null;
  return XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
}
function excelDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : s;
}

// ---- 客户 → 仓库 → 负责人 ----
function buildAssignMap() {
  const rows = readRows(SRC.assign, 'Sheet1');
  const map = new Map();
  if (!rows) return map;
  const header = rows[0] || [];
  for (let c = 0; c < header.length; c += 2) {
    const label = String(header[c] || '').trim();
    const wh = WAREHOUSES.find((w) => label.includes(w)) || '';
    if (!wh) continue;
    const owner = String((rows[1] || [])[c] || '').trim();
    for (let r = 3; r < rows.length; r++) {
      const name = String((rows[r] || [])[c] || '').trim();
      if (name && !map.has(name)) map.set(name, { warehouse: wh, owner });
    }
  }
  return map;
}

// 仓名关键词 → 地址推断（客服表未覆盖时使用）
const WH_BY_ADDRESS = [
  { kw: /速远/, wh: '速远仓' },
  { kw: /龙湖/, wh: '龙湖仓' },
  { kw: /佳新/, wh: '佳新仓' },
  { kw: /开元/, wh: '开元仓' },
];

/** 从地址推断仓库；无法推断返回 '' */
function inferWarehouse(addr) {
  const a = String(addr || '');
  for (const r of WH_BY_ADDRESS) if (r.kw.test(a)) return r.wh;
  return '';
}

function buildCustomerTemplate() {
  const assign = buildAssignMap();
  const own = readRows(SRC.owner, 'Sheet1');
  const head = (own[0] || []).map((x) => String(x || '').trim());
  const idx = (n) => head.indexOf(n);
  const iCode = idx('货主编号'), iShort = idx('简称'), iFull = idx('全称');
  const iContact = idx('联系人'), iLand = idx('联系人固话'), iPhone = idx('联系人手机号');
  const iAddr = idx('货主地址'), iStatus = idx('启用状态'), iExpiry = idx('有效期管理');

  const aoa = [CUST_HEADERS];
  const seen = new Set();
  const unknown = [];
  // ① 客服负责客户表（含仓库）优先
  for (const [name, info] of assign) {
    if (seen.has(name)) continue;
    seen.add(name);
    aoa.push([
      '', name, '', info.warehouse, '', '', '',
      '', '', '', 0, '', 0, '', '', '否', '合作中',
      info.owner ? `负责人：${info.owner}` : '',
    ]);
  }
  // ② 旺店通货主补充（详细联系方式），命中同名的合并
  const codeSeen = new Set();
  for (let r = 1; r < own.length; r++) {
    const c = own[r] || [];
    const full = String(c[iFull] || '').trim();
    const short = String(c[iShort] || '').trim();
    const name = full || short;
    if (!name) continue;
    const code = String(c[iCode] || '').trim();
    if (code && codeSeen.has(code)) continue;   // 货主代码 UNIQUE，重复则跳过
    if (code) codeSeen.add(code);
    const phone = [String(c[iLand] || '').trim(), String(c[iPhone] || '').trim()].filter(Boolean).join(' / ');
    const addr = String(c[iAddr] || '').trim();
    const info = assign.get(name);
    // 仓库优先级：客服表 > 地址推断
    const warehouse = info ? info.warehouse : inferWarehouse(addr);
    if (!warehouse) unknown.push(name);
    const row = [
      code || '', name, short || '', warehouse,
      String(c[iContact] || '').trim(), phone, addr,
      '', '', '', 0, '', 0, '', '',
      String(c[iExpiry] || '').trim() === '是' ? '是' : '否',
      String(c[iStatus] || '').trim() === '停用' ? '暂停' : '合作中',
      '',
    ];
    const idxRow = aoa.findIndex((x, ri) => ri > 0 && x[1] === name);
    if (idxRow > 0) aoa[idxRow] = row; else aoa.push(row);
  }
  if (unknown.length) {
    console.log(`[tpl] ⚠️ ${unknown.length} 个客户无法确定仓库（导入时会被拒），需人工补「所在仓库」：`);
    console.log('      ' + unknown.join('、'));
  }
  // 无法确定仓库的行拆到单独文件，并预填候选仓库，供用户快速确认
  const okRows = [aoa[0]];
  const pending = [CUST_HEADERS];
  for (let i = 1; i < aoa.length; i++) {
    if (String(aoa[i][3] || '').trim()) okRows.push(aoa[i]);
    else pending.push(aoa[i]);
  }
  return { aoa: okRows, pending: pending.length > 1 ? pending : null };
}

function buildHoursTemplate() {
  const rows = readRows(SRC.hours, '工时数据');
  if (!rows) return null;
  const head = (rows[0] || []).map((x) => String(x || '').trim());
  const idx = (n) => head.indexOf(n);
  const iCust = idx('客户'), iUnit = idx('单位'), iDate = idx('日期');
  const iShip = idx('单量'), iMain = idx('发货工时'), iOther = idx('其他工时'), iRemark = idx('备注');
  const aoa = [WH_HEADERS];
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r] || [];
    const ship = Number(c[iShip]);
    if (!(ship > 0)) continue;
    const main = Number(c[iMain]);
    aoa.push([
      excelDate(c[iDate]) || excelDate(46336),
      String(c[iCust] || '').trim(),
      String(c[iUnit] || '').trim() || '单',
      ship,
      Number.isFinite(main) ? main : 0,
      Number(c[iOther]) || 0,
      String(c[iRemark] || '').trim(),
    ]);
  }
  return aoa;
}

function buildQuoteTemplate() {
  const rows = readRows(SRC.quote, '物流公司报价');
  if (!rows) return null;
  const head = (rows[0] || []).map((x) => String(x || '').trim());
  const idx = (n) => head.indexOf(n);
  const iNet = idx('物流公司'), iCode = idx('网点'), iProv = idx('省份');
  const iCity = idx('城市'), iKg = idx('公斤(kg)'), iPrice = idx('运费(元)');
  const groups = new Map();
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r] || [];
    const code = String(c[iCode] || '').trim();
    if (!code) continue;
    const province = String(c[iProv] || '').trim();
    const city = String(c[iCity] || '').trim();
    const key = [code, province, city, ''].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        network_name: String(c[iNet] || '').trim() || code,
        express_code: code, province, city, district: '',
        volume_ratio: 6000, prices: {},
      });
    }
    const kg = Math.round(Number(c[iKg]));
    const price = Number(c[iPrice]);
    if (kg >= 1 && kg <= 40 && Number.isFinite(price)) groups.get(key).prices[kg] = price;
  }
  const aoa = [['网点名称', '快递编码', '抛比', '省份', '城市', '区县']];
  for (let kg = 1; kg <= 40; kg++) aoa[0].push(`${kg}kg`);
  for (const g of groups.values()) {
    const row = [g.network_name, g.express_code, g.volume_ratio, g.province, g.city, g.district];
    for (let kg = 1; kg <= 40; kg++) row.push(g.prices[kg] != null ? g.prices[kg] : '');
    aoa.push(row);
  }
  return aoa;
}

function writeXlsx(filename, aoa, note) {
  if (!aoa) { console.log(`[tpl] 跳过 ${filename}（源文件不存在）`); return null; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0].map((h, i) => ({ wch: i < 6 ? 18 : 10 }));
  XLSX.utils.book_append_sheet(wb, ws, aoa.length > 1 ? '数据' : 'Sheet1');
  const ws2 = XLSX.utils.aoa_to_sheet([[note]]);
  XLSX.utils.book_append_sheet(wb, ws2, '说明');
  const out = path.join(OUT, filename);
  XLSX.writeFile(wb, out);
  console.log(`[tpl] 已生成 ${out}（数据行 ${aoa.length - 1}）`);
  return out;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cust = buildCustomerTemplate();
  writeXlsx('客户资料_恢复模板.xlsx', cust.aoa,
    '本模板用于「基础资料 → 客户资料」的 Excel 导入。表头与系统导出模板完全一致；空列可留空；所在仓库仅可为 龙湖仓/佳新仓/速远仓/开元仓。');
  if (cust.pending) {
    writeXlsx('客户资料_待补仓库.xlsx', cust.pending,
      '这些客户无法从源数据推断「所在仓库」，导入会被拒绝。请在「所在仓库」列填入 龙湖仓/佳新仓/速远仓/开元仓 之一，保存后并入「客户资料_恢复模板.xlsx」一起导入。');
  }
  writeXlsx('发货工时_恢复模板.xlsx', buildHoursTemplate(),
    '本模板用于「工时 → 龙湖仓 · 发货工时」的 Excel 导入。发货单量必须 > 0；日期格式 YYYY-MM-DD。');
  writeXlsx('物流报价_恢复模板.xlsx', buildQuoteTemplate(),
    '本模板用于「基础资料 → 物流报价」的 Excel 导入。抛比必须为正整数且同一编码内一致；省份必填；重量列为 1kg…40kg 离散价，空格表示该重量段不参与比价。');
}

main();
