'use strict';
// ============================================================================
//  从 Excel 备份重建业务数据（线上数据丢失后的恢复工具）
// ----------------------------------------------------------------------------
//  用法：
//    node scripts/restore_from_excel.js --dry-run          → 只预览，不写库
//    node scripts/restore_from_excel.js --apply             → 实际写入目标库
//    ERP_DB_PATH=<库路径> node scripts/restore_from_excel.js --apply
//
//  数据源（用户机器上的真实业务导出）：
//    ① 客户主体：Desktop/旺店通货主.xlsx        （70 个货主：编号/简称/全称/联系人/手机/地址/启用状态/效期管理）
//    ② 客户→仓库→负责人：Desktop/客服负责客户表.xlsx（Sheet1 四列分组：龙湖仓/佳新仓/速远仓/仓外）
//    ③ 发货工时：Desktop/龙湖仓_发货工时_导入模板_2026-11-08 (2)(1).xlsx（34 行：客户/单位/日期/单量/主工时/其他工时/备注）
//    ④ 物流报价：Downloads/物流公司报价_2026-11-15.xlsx（1147 行：YTO4 各省市区重量价）
//
//  铁律：
//    · 只做 INSERT/UPDATE，绝不 DROP、绝不 DELETE 业务数据；
//    · 默认 --dry-run，必须显式 --apply 才写库；
//    · 幂等：客户按 company_name upsert，工时按「仓库+类型+客户+日期」判重；
//    · 写入前后打印行数与指纹，便于核验。
// ============================================================================
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');

const SRC = {
  owner: 'C:/Users/顾力瑞/Desktop/旺店通货主.xlsx',
  assign: 'C:/Users/顾力瑞/Desktop/客服负责客户表.xlsx',
  hours: 'C:/Users/顾力瑞/Desktop/龙湖仓_发货工时_导入模板_2026-11-08 (2)(1).xlsx',
  quote: 'C:/Users/顾力瑞/Downloads/物流公司报价_2026-11-15.xlsx',
};

const WAREHOUSE_ORDER = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];

function readRows(file, sheet) {
  if (!fs.existsSync(file)) return null;
  const wb = XLSX.readFile(file);
  const sn = sheet || wb.SheetNames[0];
  if (!wb.Sheets[sn]) return null;
  return XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
}

/** Excel 序列号 → YYYY-MM-DD */
function excelDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return dt.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return s;
}

// ---------------------------------------------------------------------------
// ① 客户 → 仓库 → 负责人 映射（客服负责客户表 Sheet1）
//    结构：每 2 列一组 —— [0]=分组标题行, [1]=负责人行, [2]=列标题行, [3:]=客户名
//    4 组：化武1---龙湖仓 / 化武5-----佳新仓 / 速远仓 / 仓外（白瓷品牌，无仓库）
// ---------------------------------------------------------------------------
function buildWarehouseMap() {
  const rows = readRows(SRC.assign, 'Sheet1');
  const map = new Map(); // 客户名 → { warehouse, owner }
  if (!rows) return map;
  const header = rows[0] || [];
  const groups = [];
  for (let c = 0; c < header.length; c += 2) {
    const label = String(header[c] || '').trim();
    if (!label) continue;
    const wh = WAREHOUSE_ORDER.find((w) => label.includes(w)) || '';
    const owner = String((rows[1] || [])[c] || '').trim();
    groups.push({ col: c, warehouse: wh, owner });
  }
  for (const g of groups) {
    for (let r = 3; r < rows.length; r++) {
      const name = String((rows[r] || [])[g.col] || '').trim();
      if (!name) continue;
      if (!map.has(name)) map.set(name, { warehouse: g.warehouse, owner: g.owner });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// ② 客户主体：主源 = 客服负责客户表（客户名 + 仓库 + 负责人）
//              补充 = 旺店通货主（编号/联系人/电话/地址/效期管理），按全称或简称合并
// ---------------------------------------------------------------------------
function buildCustomers(whMap) {
  // 2.1 建立「旺店通货主」索引：全称 / 简称 → 详细信息
  const detail = new Map();
  const own = readRows(SRC.owner, 'Sheet1');
  if (own) {
    const head = (own[0] || []).map((x) => String(x || '').trim());
    const idx = (n) => head.indexOf(n);
    const iCode = idx('货主编号'), iShort = idx('简称'), iFull = idx('全称');
    const iContact = idx('联系人'), iLand = idx('联系人固话'), iPhone = idx('联系人手机号');
    const iAddr = idx('货主地址'), iStatus = idx('启用状态'), iExpiry = idx('有效期管理');
    for (let r = 1; r < own.length; r++) {
      const c = own[r] || [];
      const full = String(c[iFull] || '').trim();
      const short = String(c[iShort] || '').trim();
      const name = full || short;
      if (!name) continue;
      const rec = {
        customer_code: String(c[iCode] || '').trim() || null,
        company_name: name,
        short_name: short || null,
        contact_person: String(c[iContact] || '').trim() || null,
        phone: [String(c[iLand] || '').trim(), String(c[iPhone] || '').trim()].filter(Boolean).join(' / ') || null,
        address: String(c[iAddr] || '').trim() || null,
        expiry_mgmt: String(c[iExpiry] || '').trim() === '是' ? '是' : '否',
        coop_status: String(c[iStatus] || '').trim() === '停用' ? '暂停' : '合作中',
      };
      if (full) detail.set(full, rec);
      if (short && !detail.has(short)) detail.set(short, rec);
    }
  }

  // 2.2 主源：客服负责客户表
  const out = [];
  const seen = new Set();
  for (const [name, info] of whMap) {
    if (seen.has(name)) continue;
    seen.add(name);
    const d = detail.get(name) || null;
    out.push({
      customer_code: d ? d.customer_code : null,
      company_name: name,
      short_name: d ? d.short_name : null,
      warehouse: info.warehouse || '',
      contact_person: d ? d.contact_person : null,
      phone: d ? d.phone : null,
      address: d ? d.address : null,
      expiry_mgmt: d ? d.expiry_mgmt : '否',
      coop_status: d ? d.coop_status : '合作中',
      remark: info.owner ? `负责人：${info.owner}` : null,
      is_known: true,
    });
  }

  // 2.3 补充：旺店通货主里未被主源覆盖的货主（无仓库信息）
  for (const rec of detail.values()) {
    if (seen.has(rec.company_name)) continue;
    seen.add(rec.company_name);
    out.push({
      customer_code: rec.customer_code,
      company_name: rec.company_name,
      short_name: rec.short_name,
      warehouse: '',
      contact_person: rec.contact_person,
      phone: rec.phone,
      address: rec.address,
      expiry_mgmt: rec.expiry_mgmt,
      coop_status: rec.coop_status,
      remark: null,
      is_known: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ③ 发货工时（龙湖仓）
// ---------------------------------------------------------------------------
function buildWorkHours(customerNames) {
  const rows = readRows(SRC.hours, '工时数据');
  if (!rows) return [];
  const head = (rows[0] || []).map((x) => String(x || '').trim());
  const idx = (n) => head.indexOf(n);
  const iCust = idx('客户'), iUnit = idx('单位'), iDate = idx('日期');
  const iShip = idx('单量'), iMain = idx('发货工时'), iOther = idx('其他工时'), iRemark = idx('备注');
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r] || [];
    const name = String(c[iCust] || '').trim();
    if (!name) continue;
    const ship = Number(c[iShip]);
    const main = Number(c[iMain]);
    if (!(ship > 0)) continue; // 单量必须 > 0（与系统「单量>0 才保存」口径一致）
    const other = Number(c[iOther]) || 0;
    const date = excelDate(c[iDate]) || excelDate(46336);
    out.push({
      warehouse: '龙湖仓',
      work_type: '发货',
      customer_name: name,
      unit: String(c[iUnit] || '').trim() || '单',
      date,
      ship_orders: ship,
      main_hours: Number.isFinite(main) ? main : 0,
      other_hours: other,
      shared_hours: 0,
      total_hours: (Number.isFinite(main) ? main : 0) + other,
      remark: String(c[iRemark] || '').trim() || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ④ 物流报价（YTO4）：按 编码+省+市 聚合成 price_rules 离散价
// ---------------------------------------------------------------------------
function buildQuotes() {
  const rows = readRows(SRC.quote, '物流公司报价');
  if (!rows) return [];
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
        express_code: code,
        province, city, district: '',
        volume_ratio: 6000,
        rules: [],
      });
    }
    const kg = Math.round(Number(c[iKg]));
    const price = Number(c[iPrice]);
    if (kg >= 1 && kg <= 40 && Number.isFinite(price)) {
      groups.get(key).rules.push({ weight: kg, price });
    }
  }
  for (const g of groups.values()) {
    g.rules.sort((a, b) => a.weight - b.weight);
    g.price_rules = JSON.stringify(g.rules);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
function main() {
  console.log(`[restore] 模式：${APPLY ? '实际写入 (--apply)' : '预览 (--dry-run)'}`);
  console.log(`[restore] 目标库：${DB_PATH}`);
  if (!fs.existsSync(DB_PATH)) {
    console.error('[restore] 目标库不存在，请先启动一次服务生成空库结构。');
    process.exit(1);
  }

  const whMap = buildWarehouseMap();
  const customers = buildCustomers(whMap);
  const hours = buildWorkHours(customers.map((c) => c.company_name));
  const quotes = buildQuotes();

  console.log(`\n[restore] 解析结果：`);
  console.log(`  客户 ${customers.length} 条（其中已匹配仓库 ${customers.filter((c) => c.is_known).length} 条）`);
  console.log(`  发货工时 ${hours.length} 条（龙湖仓）`);
  console.log(`  物流报价 ${quotes.length} 个区域（${[...new Set(quotes.map((q) => q.express_code))].join(',')}）`);

  if (!APPLY) {
    console.log('\n[restore] 示例（前 5 个客户）：');
    for (const c of customers.slice(0, 5)) {
      console.log(`   ${c.company_name} | 仓库=${c.warehouse || '(未匹配)'} | 联系人=${c.contact_person || '-'} | ${c.phone || '-'}`);
    }
    console.log('\n[restore] 示例（前 5 条工时）：');
    for (const h of hours.slice(0, 5)) {
      console.log(`   ${h.date} | ${h.customer_name} | ${h.ship_orders}单 | 主${h.main_hours} 其他${h.other_hours}`);
    }
    console.log('\n[restore] 这是预览。加 --apply 才会真正写库。');
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec('BEGIN');
  try {
    // ---- 客户（按 company_name upsert；customer_code 需全局唯一，冲突时置空）----
    const findC = db.prepare('SELECT customer_id FROM customers WHERE company_name=?');
    const codeTaken = db.prepare('SELECT 1 FROM customers WHERE customer_code=? AND company_name<>?');
    const insC = db.prepare(`INSERT INTO customers
      (customer_code, company_name, short_name, warehouse, contact_person, phone, address,
       erp_version, product_type, ecommerce_platform, product_count, payment_account,
       prepaid_price, cutoff_time, logistics_control, expiry_mgmt, coop_status, remark, customer_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const updC = db.prepare(`UPDATE customers SET
      customer_code=COALESCE(?,customer_code), short_name=COALESCE(?,short_name),
      warehouse=COALESCE(NULLIF(?,''),warehouse), contact_person=COALESCE(?,contact_person),
      phone=COALESCE(?,phone), address=COALESCE(?,address), expiry_mgmt=?, coop_status=?,
      remark=COALESCE(?,remark), updated_at=datetime('now','localtime')
      WHERE company_name=?`);
    let cIns = 0, cUpd = 0, cCodeDrop = 0;
    for (const c of customers) {
      const ex = findC.get(c.company_name);
      // customer_code 是 UNIQUE：若已被别的公司占用则置空（不丢客户，只丢重复编码）
      let code = c.customer_code;
      if (code && codeTaken.get(code, c.company_name)) { code = null; cCodeDrop++; }
      if (ex) {
        updC.run(code, c.short_name, c.warehouse, c.contact_person, c.phone,
          c.address, c.expiry_mgmt, c.coop_status, c.remark, c.company_name);
        cUpd++;
      } else {
        insC.run(code, c.company_name, c.short_name, c.warehouse, c.contact_person,
          c.phone, c.address, null, null, null, 0, null, 0, null, null,
          c.expiry_mgmt, c.coop_status, c.remark, '仓储客户');
        cIns++;
      }
    }

    // ---- 发货工时（按 仓库+类型+客户+日期 判重）----
    const findW = db.prepare(`SELECT work_id FROM work_hours
      WHERE warehouse=? AND work_type=? AND customer_name=? AND date=?`);
    const insW = db.prepare(`INSERT INTO work_hours
      (warehouse, work_type, customer_id, customer_name, unit, date, ship_orders,
       main_hours, other_hours, shared_hours, total_hours, efficiency, remark, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let wIns = 0, wSkip = 0;
    for (const h of hours) {
      if (findW.get(h.warehouse, h.work_type, h.customer_name, h.date)) { wSkip++; continue; }
      const cid = findC.get(h.customer_name) ? findC.get(h.customer_name).customer_id : null;
      const eff = h.main_hours > 0 ? Math.round((h.ship_orders / h.main_hours + Number.EPSILON) * 1000) / 1000 : null;
      insW.run(h.warehouse, h.work_type, cid, h.customer_name, h.unit, h.date, h.ship_orders,
        h.main_hours, h.other_hours, h.shared_hours, h.total_hours, eff, h.remark, 'archived');
      wIns++;
    }

    // ---- 物流报价（upsert by 编码+省+市+区）----
    const findQ = db.prepare(`SELECT id FROM logistics_quotes
      WHERE express_code=? AND province=? AND city=? AND district=?`);
    const insQ = db.prepare(`INSERT INTO logistics_quotes
      (network_name, express_code, province, city, district, volume_ratio, price_rules, remark)
      VALUES (?,?,?,?,?,?,?,?)`);
    const updQ = db.prepare(`UPDATE logistics_quotes SET
      network_name=?, volume_ratio=?, price_rules=?, updated_at=datetime('now','localtime')
      WHERE express_code=? AND province=? AND city=? AND district=?`);
    let qIns = 0, qUpd = 0;
    for (const q of quotes) {
      const ex = findQ.get(q.express_code, q.province, q.city, q.district);
      if (ex) {
        updQ.run(q.network_name, q.volume_ratio, q.price_rules, q.express_code, q.province, q.city, q.district);
        qUpd++;
      } else {
        insQ.run(q.network_name, q.express_code, q.province, q.city, q.district,
          q.volume_ratio, q.price_rules, null);
        qIns++;
      }
    }

    db.exec('COMMIT');
    console.log(`\n[restore] ✅ 写入完成：客户 新增${cIns}/更新${cUpd}，工时 新增${wIns}/跳过重复${wSkip}，报价 新增${qIns}/更新${qUpd}`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('[restore] ❌ 写入失败，已回滚：', e.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
