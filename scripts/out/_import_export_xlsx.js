// 临时脚本：WorkBuddy 导出的客户 Excel -> traesite 客户资料同步
// 用法：
//   node scripts/out/_import_export_xlsx.js --inspect <xlsx...>   仅解析并打印结构
//   node scripts/out/_import_export_xlsx.js --apply  <xlsx...>   解析并推送到 traesite
// 兼容 WorkBuddy「导出」格式（23 列、多 Sheet）与「导入模板」格式（19 列、单 Sheet）
const fs = require('fs');
const https = require('https');
const XLSX = require('xlsx');

const DST_BASE = 'https://37k87749he11bnutz2k.traesite.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WAREHOUSES = ['龙湖仓', '佳新仓', '速远仓', '开元仓'];
const TYPES = ['仓储客户', '共享单号', '快运物流'];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('请提供至少一个 xlsx 文件路径');
  process.exit(1);
}

// 表头 -> 标准字段（同时兼容导出格式与导入模板格式）
const HEADER_MAP = {
  '排序号（分仓）': '_sort',
  '序号': '_sort',
  '货主代码': 'customer_code',
  '公司全称': 'company_name',
  '客户简称': 'short_name',
  '所在仓库': 'warehouse',
  '客户联系人': 'contact_person',
  '联系人': 'contact_person',
  '联系电话': 'phone',
  '客户地址': 'address',
  '地址': 'address',
  'ERP版本名称': 'erp_version',
  'ERP 版本': 'erp_version',
  '产品类型': 'product_type',
  '商品类型': 'product_type',
  '电商平台': 'ecommerce_platform',
  '商品种类数': 'product_count',
  '默认单位': 'default_unit',
  '打款账户': 'payment_account',
  '支付账号': 'payment_account',
  '预充单价': 'prepaid_price',
  '截单时间': 'cutoff_time',
  '物流公司控制': 'logistics_control',
  '物流管控': 'logistics_control',
  '效期管理': 'expiry_mgmt',
  '合作状态': 'coop_status',
  '备注': 'remark',
  '客户分类': 'customer_type',
};

function clean(v) {
  return v == null ? '' : String(v).trim();
}

// 解析单个文件 -> [{ type, wh, row }]
function parseFile(file) {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: true });
  const out = [];
  console.log(`\n=== ${file} ===`);
  console.log('Sheets:', wb.SheetNames.join(' | '));

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (aoa.length < 2) { console.log(`  [${sheetName}] 空表，跳过`); continue; }
    const head = (aoa[0] || []).map(clean);
    const idx = {};
    head.forEach((h, i) => { if (HEADER_MAP[h] && idx[HEADER_MAP[h]] == null) idx[HEADER_MAP[h]] = i; });

    const unknown = head.filter((h) => h && !HEADER_MAP[h]);
    console.log(`  [${sheetName}] 行=${aoa.length - 1} 列=${head.length} 未知列=[${unknown.join('、')}]`);

    // Sheet 名推断分类与所属仓
    const isWarehouseSheet = WAREHOUSES.includes(sheetName);
    const typeFromSheet = TYPES.includes(sheetName) ? sheetName : (sheetName === '未分配仓库' ? '仓储客户' : '');

    let parsed = 0;
    for (let i = 1; i < aoa.length; i++) {
      const cells = aoa[i] || [];
      if (!cells.some((v) => clean(v) !== '')) continue;
      const row = {};
      for (const [field, j] of Object.entries(idx)) row[field] = cells[j];
      const company = clean(row.company_name);
      if (!company) continue;

      // 分类：优先行内「客户分类」列，其次 Sheet 名，最后默认仓储客户
      const type = clean(row.customer_type) || typeFromSheet || '仓储客户';
      if (!TYPES.includes(type)) continue;
      // 所属仓：仓储客户 Sheet 用 Sheet 名；否则用行内 warehouse 列
      let wh = isWarehouseSheet ? sheetName : clean(row.warehouse);
      if (sheetName === '未分配仓库') wh = '';

      out.push({ type, wh: isWarehouseSheet ? sheetName : '', row });
      parsed++;
    }
    console.log(`  [${sheetName}] 有效行=${parsed}`);
  }
  return out;
}

// 合并同一客户（多仓 Sheet 会重复出现）
function mergeRecords(list) {
  const map = new Map();
  for (const { type, wh, row } of list) {
    const key = type + '|' + clean(row.company_name);
    if (!map.has(key)) {
      map.set(key, {
        type,
        fields: { ...row },
        warehouse_sorts: {},
        sortCandidates: [],
      });
    }
    const rec = map.get(key);
    // 补齐空字段
    for (const [k, v] of Object.entries(row)) {
      if (clean(rec.fields[k]) === '' && clean(v) !== '') rec.fields[k] = v;
    }
    const s = Number(clean(row._sort));
    if (wh && Number.isInteger(s) && s > 0) {
      rec.warehouse_sorts[wh] = Math.min(rec.warehouse_sorts[wh] || s, s);
    } else if (!wh && Number.isInteger(s) && s > 0) {
      rec.sortCandidates.push(s);
    }
  }
  return [...map.values()];
}

function toPayload(rec) {
  const f = rec.fields;
  const num = (v, d) => (clean(v) === '' ? d : Number(v));
  const payload = {
    customer_type: rec.type,
    customer_code: clean(f.customer_code) || '',
    company_name: clean(f.company_name),
    short_name: clean(f.short_name),
    warehouse: clean(f.warehouse),
    contact_person: clean(f.contact_person),
    phone: clean(f.phone),
    address: clean(f.address),
    erp_version: clean(f.erp_version),
    product_type: clean(f.product_type),
    ecommerce_platform: clean(f.ecommerce_platform),
    product_count: num(f.product_count, 0),
    payment_account: clean(f.payment_account),
    prepaid_price: num(f.prepaid_price, 0),
    cutoff_time: clean(f.cutoff_time),
    logistics_control: clean(f.logistics_control),
    expiry_mgmt: clean(f.expiry_mgmt) || '否',
    coop_status: clean(f.coop_status) || '合作中',
    sort_order: 9999,
    remark: clean(f.remark),
  };
  // 全局排序号：非仓储类型取导出值；仓储类型用分仓排序的最小值兜底
  // （目标站若不支持分仓排序，仍能按全局 sort_order 近似还原顺序）
  if (rec.type !== '仓储客户') {
    const nums = rec.sortCandidates.length ? rec.sortCandidates : [];
    payload.sort_order = nums.length ? Math.min(...nums) : 9999;
  } else {
    const wsVals = Object.values(rec.warehouse_sorts).filter((n) => n && n !== 9999);
    payload.sort_order = wsVals.length ? Math.min(...wsVals) : 9999;
  }
  // 分仓排序
  const whs = {};
  for (const [wh, v] of Object.entries(rec.warehouse_sorts)) {
    if (WAREHOUSES.includes(wh) && v && v !== 9999) whs[wh] = v;
  }
  if (Object.keys(whs).length) {
    payload.warehouse_sorts = whs;
    // 仓储客户库中 warehouse 字段需要包含这些仓（导出数据里通常已是逗号拼接）
    const whList = payload.warehouse.split(',').map((s) => s.trim()).filter(Boolean);
    for (const wh of Object.keys(whs)) if (!whList.includes(wh)) whList.push(wh);
    payload.warehouse = whList.join(',');
  }
  return payload;
}

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const u = new URL(DST_BASE + path);
    const data = body ? JSON.stringify(body) : '';
    const headers = {
      'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
      'Origin': u.origin, 'Referer': u.origin + '/',
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: buf.slice(0, 200) });
      });
    });
    r.on('error', (e) => resolve({ status: -1, body: e.message }));
    r.setTimeout(30000, () => { r.destroy(); resolve({ status: -2, body: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const all = [];
  for (const f of files) all.push(...parseFile(f));
  const records = mergeRecords(all);
  console.log('\n合并后客户数:', records.length);
  const byType = {};
  records.forEach((r) => { byType[r.type] = (byType[r.type] || 0) + 1; });
  console.log('分类统计:', byType);

  const payloads = records.map(toPayload);
  // 打印前 3 条样例
  console.log('\n样例（前 3 条）:');
  payloads.slice(0, 3).forEach((p) => console.log(JSON.stringify(p)));

  if (!APPLY) {
    // 预检：多仓客户、重复代码、各仓数量
    const multiWh = payloads.filter((p) => p.warehouse.includes(','));
    console.log('\n多仓客户数:', multiWh.length);
    multiWh.slice(0, 10).forEach((p) => console.log('  -', p.company_name, '=>', p.warehouse));

    const codeCount = {};
    payloads.forEach((p) => { if (p.customer_code) codeCount[p.customer_code] = (codeCount[p.customer_code] || 0) + 1; });
    const dupCodes = Object.entries(codeCount).filter(([, n]) => n > 1);
    console.log('重复货主代码:', dupCodes.length ? JSON.stringify(dupCodes) : '无');

    const perWh = {};
    payloads.forEach((p) => {
      if (p.warehouse_sorts) for (const [wh, v] of Object.entries(p.warehouse_sorts)) (perWh[wh] = perWh[wh] || []).push(v);
    });
    for (const [wh, arr] of Object.entries(perWh)) {
      const dupSort = arr.filter((v, i) => arr.indexOf(v) !== i);
      console.log(`  ${wh}: ${arr.length} 人, 序号范围 ${Math.min(...arr)}~${Math.max(...arr)}, 重复序号 ${dupSort.length ? [...new Set(dupSort)].join(',') : '无'}`);
    }

    console.log('\n[inspect 模式] 未写入目标站。确认无误后加 --apply 执行。');
    return;
  }

  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  if (!login.body || !login.body.token) {
    console.error('目标站登录失败:', login.status, JSON.stringify(login.body).slice(0, 200));
    process.exit(3);
  }
  const token = login.body.token;
  console.log('\n目标站登录成功');

  // 现有客户索引（幂等）
  const existing = new Map();
  for (const t of TYPES) {
    const r = await req('GET', `/api/customers?customer_type=${encodeURIComponent(t)}&page=1&pageSize=1000`, null, token);
    if (r.status === 200 && r.body.data) for (const row of r.body.data) existing.set(row.company_name, row);
  }
  console.log('目标站现有客户:', existing.size);

  // 排序：仓储客户按分仓序号升序（同仓内），非仓储按全局 sort_order 升序
  payloads.sort((a, b) => {
    if (a.customer_type !== b.customer_type) return TYPES.indexOf(a.customer_type) - TYPES.indexOf(b.customer_type);
    const sa = a.warehouse_sorts ? Math.min(...Object.values(a.warehouse_sorts)) : 0;
    const sb = b.warehouse_sorts ? Math.min(...Object.values(b.warehouse_sorts)) : 0;
    if (sa !== sb) return sa - sb;
    return (a.sort_order || 9999) - (b.sort_order || 9999);
  });

  let created = 0, updated = 0;
  const failures = [];
  for (const p of payloads) {
    const hit = existing.get(p.company_name);
    let r;
    if (hit) {
      r = await req('PUT', `/api/customers/${hit.customer_id}`, p, token);
      if (r.status === 200) updated++;
      else failures.push({ name: p.company_name, op: 'update', status: r.status, err: (r.body && r.body.error) || r.raw });
    } else {
      r = await req('POST', '/api/customers', p, token);
      if (r.status === 201) { created++; if (r.body.data) existing.set(p.company_name, r.body.data); }
      else failures.push({ name: p.company_name, op: 'create', status: r.status, err: (r.body && r.body.error) || r.raw });
    }
    const done = created + updated + failures.length;
    if (done % 20 === 0) console.log(`进度 ${done}/${payloads.length}  新增${created} 更新${updated} 失败${failures.length}`);
  }

  console.log('\n========== 同步结果 ==========');
  console.log('新增:', created, ' 更新:', updated, ' 失败:', failures.length);
  failures.slice(0, 30).forEach((f) => console.log(' -', f.name, f.op, f.status, f.err));

  for (const t of TYPES) {
    const r = await req('GET', `/api/customers?customer_type=${encodeURIComponent(t)}&page=1&pageSize=1`, null, token);
    console.log(`目标站 ${t}:`, r.body && r.body.total);
  }
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(9); });
