// 智能测单路由（单据 → 智能测单 / 历史测算）：单笔测算 + Excel 导入测算 + 模板下载
// + 管理员高级配置（起步重量 / 面单类型白名单）+ 历史测算批次
// 权限：auth + menuGate('smart_quote')（仅菜单授权角色可见可用）
//       PUT /config 额外 roleGate（管理员 / 超级管理员）才可调
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { menuGate, roleGate } = require('../middleware/rbac');
const { calcBestQuotes, calcBestQuote } = require('../services/quoteCalc');
const xlsx = require('xlsx');
const multer = require('multer');

router.use(auth);
router.use(menuGate('smart_quote'));

// 电子面单类型全集（前端与后端共用同一套，避免漂移）
const WAYBILL_TYPES = ['菜鸟', '得物', '抖音', '京东快递', '京东无界', '快手', '拼多多', '微信视频号', '唯品会加密', '新版小红书', '有赞', '其他'];
const CONFIG_KEY = 'smart_quote_config';

// 取全量报价网点（比价用，含区域字段用于省市区匹配 + network_name 用于界面展示）
function loadQuotes() {
  return db.prepare('SELECT express_code, network_name, province, city, district, volume_ratio, price_rules FROM logistics_quotes').all();
}

// 把一行原始录入归一化为测算输入
function normalizeRow(r) {
  return {
    soNo: String(r.soNo != null ? r.soNo : '').trim(),
    ownerName: String(r.ownerName != null ? r.ownerName : '').trim(),
    waybillType: String(r.waybillType != null ? r.waybillType : '').trim(),
    province: String(r.province != null ? r.province : '').trim(),
    city: String(r.city != null ? r.city : '').trim(),
    district: String(r.district != null ? r.district : '').trim(),
    estimatedWeight: Number(r.estimatedWeight != null ? r.estimatedWeight : 0) || 0,
    totalVolume: Number(r.totalVolume != null ? r.totalVolume : 0) || 0,
  };
}

// ---------- 配置（起步重量 + 面单类型白名单） ----------
function defaultConfig() {
  return { startWeight: 0, startMode: 'estimated', waybillTypes: ['菜鸟', '拼多多', '抖音'] };
}
function loadConfig() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(CONFIG_KEY);
  if (!row) return defaultConfig();
  try {
    const c = JSON.parse(row.value);
    const def = defaultConfig();
    return {
      startWeight: Number(c.startWeight) >= 0 ? Number(c.startWeight) : def.startWeight,
      startMode: c.startMode === 'billing' ? 'billing' : 'estimated',
      waybillTypes: Array.isArray(c.waybillTypes) ? c.waybillTypes.filter((x) => WAYBILL_TYPES.includes(x)) : def.waybillTypes,
    };
  } catch (e) {
    return defaultConfig();
  }
}
// GET /config：任意授权角色可读取（业务员可看不能改）
router.get('/config', (req, res) => {
  res.json({ data: loadConfig(), waybillTypes: WAYBILL_TYPES });
});
// PUT /config：仅管理员 / 超级管理员可写
router.put('/config', roleGate('管理员', '超级管理员'), (req, res) => {
  const b = req.body || {};
  const startWeight = Number(b.startWeight);
  if (isNaN(startWeight) || startWeight < 0) return res.status(400).json({ error: '起步重量必须是 ≥0 的数字' });
  const startMode = b.startMode === 'billing' ? 'billing' : 'estimated';
  const wt = Array.isArray(b.waybillTypes) ? b.waybillTypes.filter((x) => WAYBILL_TYPES.includes(x)) : defaultConfig().waybillTypes;
  if (!wt.length) return res.status(400).json({ error: '至少勾选一种电子面单类型' });
  const cfg = { startWeight, startMode, waybillTypes: wt };
  const beforeCfg = loadConfig();
  db.prepare(
    `INSERT INTO app_settings(key, value, updated_at) VALUES(?,?,datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`
  ).run(CONFIG_KEY, JSON.stringify(cfg));
  // 测算配置变更审计（原先遗漏）
  require('../services/auditLog').writeLog(req, {
    table: 'app_settings', module: '智能测单', action: 'update',
    targetId: CONFIG_KEY, before: beforeCfg, after: cfg,
  });
  res.json({ data: cfg });
});

// ---------- 单笔 / 批量测算 ----------
router.post('/calculate', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '缺少测算数据 rows' });
  const quotes = loadQuotes();
  const results = calcBestQuotes(rows.map(normalizeRow), quotes);
  res.json({ data: results });
});

// ---------- 单笔比价（智能测算 Tab2）：返回该区域全部可用快递的报价明细 ----------
// 复用核心算法 calcBestQuote（地址三级降级 + 抛比 + 进一法 + 跨快递取最低），
// 把内部已算好的 details（每个快递一行）全部返回并按运费升序排列，前端用绿色高亮最低价。
// 注意：不按面单类型过滤——单笔比价的目的是看该区域所有可用渠道的底价，过滤会导致漏选最便宜的。
router.post('/compare', (req, res) => {
  const row = req.body && req.body.row;
  if (!row) return res.status(400).json({ error: '缺少测算数据 row' });
  const quotes = loadQuotes();
  const result = calcBestQuote(normalizeRow(row), quotes);
  if (!result.details.length) return res.json({ data: [], best: null, bestPrice: null });
  // 按运费升序：第一行即最低价（推荐），与 best 一致
  const data = result.details.slice().sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
  res.json({ data, best: result.recommendedCode, bestPrice: result.recommendedPrice, matchLevel: result.matchLevel, matchLabel: result.matchLabel });
});

// ---------- 已维护快递公司（智能测算页「已维护快递公司」标签用） ----------
// 仅读 express_code + network_name，权限沿用 smart_quote（业务员也能看，不暴露物流报价维护页）。
router.get('/carriers', (req, res) => {
  const rows = db.prepare(
    `SELECT DISTINCT express_code, network_name FROM logistics_quotes
     WHERE express_code IS NOT NULL AND express_code <> '' ORDER BY express_code`
  ).all();
  res.json({ data: rows });
});

// ---------- Excel 模板下载 ----------
router.get('/template', (req, res) => {
  // 「县区」放在「城市」之后；旧模板写「区县」也能被导入解析识别（见下方 map 别名）。
  const header = ['SO单号', '货主名称', '电子面单类型', '省份', '城市', '县区', '预估重量(kg)', '总体积(立方米)'];
  const example = ['SO001', '示例货主', '菜鸟', '浙江省', '杭州市', '西湖区', 3.2, 0.012];
  const ws = xlsx.utils.aoa_to_sheet([header, example]);
  ws['!cols'] = header.map((h) => ({ wch: Math.max(10, h.length * 2) }));
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, '智能测单');
  // 说明放第二个工作表：导入只读取第一个工作表，不会被当作数据行
  const tips = xlsx.utils.aoa_to_sheet([
    ['填写说明'],
    ['1. 请在「智能测单」工作表按表头填写，不要修改表头文字与顺序。'],
    ['2. 电子面单类型需与页面「测算配置」中勾选的类型一致（默认：菜鸟 / 拼多多 / 抖音），否则该行不展示。'],
    ['3. 省份 / 城市 / 县区 用于按「区 → 市 → 省」降级匹配物流报价，填得越完整越容易命中区县级报价。'],
    ['4. 预估重量单位 kg；总体积单位立方米（m³）。'],
    ['5. 空行会自动跳过；表头必须保留；文件需为真正的 .xlsx / .xls。'],
  ]);
  tips['!cols'] = [{ wch: 96 }];
  xlsx.utils.book_append_sheet(wb, tips, '填写说明');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="smart_quote_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ---------- Excel 导入测算（并落库为历史批次） ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到 Excel 文件' });
  const buf = req.file.buffer;
  // 魔数校验：挡住「把 CSV/文本改成 .xlsx 后缀」的文件，给出可理解的提示
  const isZip = buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // xlsx (PK zip)
  const isOle = buf && buf.length > 4 && buf[0] === 0xd0 && buf[1] === 0xcf; // xls (OLE2)
  if (!isZip && !isOle) {
    return res.status(400).json({ error: '文件格式不对：请上传真正的 .xlsx / .xls Excel 文件（不能只改扩展名）' });
  }
  let wb;
  try {
    wb = xlsx.read(buf, { type: 'buffer', cellDates: true });
  } catch (e) {
    return res.status(400).json({ error: '文件解析失败，请确认是 xlsx/xls 格式' });
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return res.status(400).json({ error: '文件中没有工作表' });
  const raw = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  const map = (r, names) => {
    for (const n of names) if (r[n] != null && String(r[n]).trim() !== '') return r[n];
    return '';
  };
  // 空行直接跳过（增强容错）；县区列可缺省，兼容旧版 7 列模板与「区县」表头写法
  const rows = raw
    .filter((r) => Object.values(r).some((v) => String(v == null ? '' : v).trim() !== ''))
    .map((r) => normalizeRow({
      soNo: map(r, ['SO单号', 'so_no', 'SO']),
      ownerName: map(r, ['货主名称', 'owner_name', '货主']),
      waybillType: map(r, ['电子面单类型', 'waybill_type', '面单类型']),
      province: map(r, ['省份', 'province']),
      city: map(r, ['城市', 'city']),
      district: map(r, ['县区', '区县', '区/县', '县/区', '区', 'district', 'county']),
      estimatedWeight: map(r, ['预估重量(kg)', '预估重量', 'estimated_weight', '重量']),
      totalVolume: map(r, ['总体积(立方米)', '总体积', 'total_volume', '体积']),
    }));
  if (!rows.length) {
    return res.status(400).json({ error: '文件中没有有效数据行，请检查是否只保留了表头或全是空行' });
  }
  const quotes = loadQuotes();
  const results = calcBestQuotes(rows, quotes);

  // 落库为历史批次（每次上传生成一个批次，便于回溯）
  const fileName = req.file.originalname || 'import.xlsx';
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const batchName = (req.body && req.body.batchName && String(req.body.batchName).trim())
    ? String(req.body.batchName).trim()
    : (fileName + ' ' + ts);
  const insBatch = db.prepare(
    'INSERT INTO smart_quote_batches (batch_name, source_type, file_name, total_count, operator) VALUES (?,?,?,?,?)'
  );
  const info = insBatch.run(batchName, 'excel', fileName, results.length, req.user.username);
  const batchId = info.lastInsertRowid;
  const insRec = db.prepare(
    `INSERT INTO smart_quote_records
      (batch_id, so_no, owner_name, waybill_type, province, city, district, estimated_weight, total_volume,
       volumetric_weight, billing_weight, recommended_code, recommended_price)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of results) {
    insRec.run(batchId, r.soNo, r.ownerName, r.waybillType, r.province, r.city, r.district,
      r.estimatedWeight, r.totalVolume, r.volumetricWeight, r.billingWeight, r.recommendedCode, r.recommendedPrice == null ? 0 : r.recommendedPrice);
  }

  // Excel 导入测算审计（原先遗漏）：批次 ID 即被操作数据 ID
  require('../services/auditLog').writeLog(req, {
    table: 'smart_quote_batches', module: '智能测单', action: 'import',
    targetId: batchId,
    content: {
      before: null,
      after: { batch_id: Number(batchId), batch_name: batchName, file_name: fileName, total_count: results.length },
      records: results.slice(0, 50),
    },
  });

  res.json({ data: results, batchId });
});

// ---------- 历史测算：批次列表 ----------
router.get('/history', (req, res) => {
  const list = db.prepare(
    `SELECT id, batch_name, source_type, file_name, total_count, operator, created_at
     FROM smart_quote_batches ORDER BY id DESC`
  ).all();
  res.json({ data: list });
});

// ---------- 历史测算：批次明细（搜索 + 分页） ----------
router.get('/history/:id/records', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '缺少批次 id' });
  const q = (req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 20;
  const where = ['batch_id=?'];
  const params = [id];
  if (q) { where.push('so_no LIKE ?'); params.push('%' + q + '%'); }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const total = db.prepare('SELECT COUNT(*) c FROM smart_quote_records ' + whereSql).get(...params).c;
  const rows = db.prepare(
    `SELECT id, so_no, owner_name, waybill_type, province, city, district, estimated_weight, total_volume,
            volumetric_weight, billing_weight, recommended_code, recommended_price, created_at
     FROM smart_quote_records ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ data: rows, total, page, pages: Math.ceil(total / pageSize) || 1 });
});

// ---------- 历史测算：删除批次（仅管理员 / 超级管理员，级联删除明细） ----------
router.delete('/history/:id', roleGate('管理员', '超级管理员'), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '缺少批次 id' });
  const info = db.prepare('DELETE FROM smart_quote_batches WHERE id=?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: '批次不存在' });
  writeAudit(req, 'delete', id, null, { id });
  res.json({ ok: true });
});

// 审计：统一走全局日志服务（新旧字段双写，模块=智能测单）
function writeAudit(req, action, recordId, before, after) {
  require('../services/auditLog').writeLog(req, {
    table: 'smart_quote_batches', module: '智能测单', action,
    targetId: recordId, before, after,
  });
}

module.exports = router;
