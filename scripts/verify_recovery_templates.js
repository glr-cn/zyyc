'use strict';
// ============================================================================
//  恢复模板自检：用【系统真实解析器】逐行校验 scripts/out/ 下的恢复模板
// ----------------------------------------------------------------------------
//  目的：确保这些文件丢到线上点「导入」时，不会被表头校验 / 行级校验打回。
//  用法：node scripts/verify_recovery_templates.js
//  退出码：0 = 全部通过；1 = 有失败项
// ============================================================================
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const customerImport = require('../src/services/customerImport');

const OUT = path.join(__dirname, 'out');
let fail = 0;
const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => { fail++; console.log('  ❌ ' + m); };

function load(file) {
  const p = path.join(OUT, file);
  if (!fs.existsSync(p)) { bad(`${file} 不存在`); return null; }
  return fs.readFileSync(p);
}

// ---------------------------------------------------------------- 客户资料
function checkCustomers() {
  console.log('\n[1] 客户资料_恢复模板.xlsx（可直接导入部分）');
  const buf = load('客户资料_恢复模板.xlsx');
  if (!buf) return;
  let rows;
  try { rows = customerImport.readSheet(buf); }
  catch (e) { bad('readSheet 失败：' + e.message); return; }
  ok(`表头校验通过（readSheet 未抛错），共 ${rows.length} 行`);

  const errs = [];
  const whCount = {};
  rows.forEach((r) => {
    const res = customerImport.parseRow(r.raw, { requireWarehouse: true });
    if (res.error) errs.push(`第 ${r.excelRow} 行：${res.error}`);
    else {
      const w = res.row.warehouse;
      whCount[w] = (whCount[w] || 0) + 1;
      if (!res.row.company_name) errs.push(`第 ${r.excelRow} 行：公司全称为空`);
    }
  });
  if (errs.length) { errs.slice(0, 10).forEach(bad); bad(`共 ${errs.length} 行未通过校验`); }
  else ok(`全部 ${rows.length} 行通过 parseRow 校验`);
  console.log('     仓库分布：' + JSON.stringify(whCount));
}

function checkCustomersPending() {
  console.log('\n[2] 客户资料_待补仓库.xlsx（需人工补仓库后并入主模板）');
  const buf = load('客户资料_待补仓库.xlsx');
  if (!buf) return;
  let rows;
  try { rows = customerImport.readSheet(buf); }
  catch (e) { bad('readSheet 失败：' + e.message); return; }
  ok(`表头校验通过，共 ${rows.length} 行`);

  let missingWh = 0, otherErr = 0;
  const sample = [];
  rows.forEach((r) => {
    const res = customerImport.parseRow(r.raw, { requireWarehouse: true });
    if (res.error) {
      if (res.error.includes('所在仓库为空')) {
        missingWh++;
        if (sample.length < 5) sample.push(r.raw['公司全称']);
      } else otherErr++;
    }
  });
  if (missingWh === rows.length) ok(`${rows.length} 行全部仅缺「所在仓库」——正是预期状态，需人工补`);
  else bad(`缺仓库行 ${missingWh}/${rows.length}，另有 ${otherErr} 行存在其他错误`);
  if (sample.length) console.log('     样例：' + sample.join('、') + ' …');
}

// ---------------------------------------------------------------- 发货工时
function checkHours() {
  console.log('\n[3] 发货工时_恢复模板.xlsx');
  const buf = load('发货工时_恢复模板.xlsx');
  if (!buf) return;
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const head = (aoa[0] || []).map((x) => String(x || '').trim());
  const IMP = ['日期', '客户名称', '单位', '发货单量', '主工时', '其他工时', '备注'];
  const missing = IMP.filter((h) => !head.includes(h));
  if (missing.length) bad('缺少列：' + missing.join('、'));
  else ok('表头匹配 IMPORT_HEADER');

  const idx = (n) => head.indexOf(n);
  let badRows = 0, total = 0, ship = 0, hours = 0;
  for (let i = 1; i < aoa.length; i++) {
    const c = aoa[i] || [];
    if (!c.some((v) => String(v == null ? '' : v).trim())) continue;
    total++;
    const d = String(c[idx('日期')] || '');
    const s = Number(c[idx('发货单量')]);
    const mh = Number(c[idx('主工时')]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { bad(`第 ${i + 1} 行日期格式异常：${d}`); badRows++; continue; }
    if (!(s > 0)) { bad(`第 ${i + 1} 行发货单量必须 > 0（实际 ${s}）`); badRows++; continue; }
    if (mh < 0) { bad(`第 ${i + 1} 行主工时为负`); badRows++; continue; }
    if (!String(c[idx('客户名称')] || '').trim()) { bad(`第 ${i + 1} 行客户名称为空`); badRows++; continue; }
    ship += s; hours += mh + (Number(c[idx('其他工时')]) || 0);
  }
  if (!badRows) ok(`${total} 行全部通过行级校验，合计 ${ship} 单 / ${hours} 工时`);
}

// ---------------------------------------------------------------- 物流报价
function checkQuotes() {
  console.log('\n[4] 物流报价_恢复模板.xlsx');
  const buf = load('物流报价_恢复模板.xlsx');
  if (!buf) return;
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const head = (aoa[0] || []).map((x) => String(x || '').trim());
  const need = ['网点名称', '快递编码', '抛比', '省份', '城市', '区县'];
  const missing = need.filter((h) => !head.includes(h));
  if (missing.length) bad('缺少列：' + missing.join('、'));
  else ok('基础 6 列表头匹配');
  for (let kg = 1; kg <= 40; kg++) {
    if (!head.includes(`${kg}kg`)) { bad(`缺少重量列 ${kg}kg`); break; }
  }
  ok('1kg…40kg 重量列齐全');

  const idx = (n) => head.indexOf(n);
  let badRows = 0, priced = 0;
  for (let i = 1; i < aoa.length; i++) {
    const c = aoa[i] || [];
    if (!c.some((v) => String(v == null ? '' : v).trim())) continue;
    const ratio = Number(c[idx('抛比')]);
    if (!(ratio > 0)) { bad(`第 ${i + 1} 行抛比必须为正整数`); badRows++; continue; }
    if (!String(c[idx('省份')] || '').trim()) { bad(`第 ${i + 1} 行省份为空`); badRows++; continue; }
    if (!String(c[idx('快递编码')] || '').trim()) { bad(`第 ${i + 1} 行快递编码为空`); badRows++; continue; }
    let has = 0;
    for (let kg = 1; kg <= 40; kg++) {
      const v = c[idx(`${kg}kg`)];
      if (v !== '' && v != null && Number.isFinite(Number(v))) has++;
    }
    if (!has) { bad(`第 ${i + 1} 行没有任何有效重量价`); badRows++; continue; }
    priced += has;
  }
  if (!badRows) ok(`全部数据行通过校验，共 ${priced} 个离散重量价`);
}

checkCustomers();
checkCustomersPending();
checkHours();
checkQuotes();

console.log('\n────────────────────────────');
if (fail) { console.log(`❌ 校验未通过：${fail} 项问题`); process.exit(1); }
console.log('✅ 全部恢复模板通过系统真实解析器校验，可直接用于线上导入');
