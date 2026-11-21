// ============================================================================
// routes/order-import-hub.js · 独立「订单导入」模块 API
// ----------------------------------------------------------------------------
// 所有数据只写 oih_batches / oih_rows，与 orders / customers / work_hours
// 等既有业务表完全无关联（用户需求：仅做导入 + 对这批数据的分析）。
// 挂载点：/api/order-import-hub，菜单权限 path = oih_import。
// ============================================================================
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { menuGate } = require('../middleware/rbac');
const hub = require('../services/orderImportHub');
const expressRegion = require('../services/expressRegion');

const router = express.Router();
const crypto = require('crypto');
// 分片上传：单片上限 8MB（远低于常见网关 10~20MB 限制）
const CHUNK_LIMIT = 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CHUNK_LIMIT } });
const gate = menuGate('oih_import');

// 内置申通规则查询（一次性预编译，供导入批量判定复用）
function makeLegacy() {
  let exact = null, prov = null;
  try {
    exact = db.prepare('SELECT region_class FROM shentong_region_class WHERE province=? AND city=?');
    prov = db.prepare('SELECT region_class FROM shentong_region_class WHERE province=? AND city IS NULL');
  } catch (e) { /* 表不存在时忽略 */ }
  return (p, c) => {
    if (!p) return null;
    try {
      if (c && exact) { const r = exact.get(p, c); if (r) return r.region_class; }
      if (prov) { const r = prov.get(p); if (r) return r.region_class; }
    } catch (e) { /* ignore */ }
    return null;
  };
}

// 查询/分析参数解析（日期、平台、快递公司、地区、货主、单号）
function parseFilters(q) {
  const f = {
    start: String(q.start || ''), end: String(q.end || ''),
    platform: String(q.platform || ''), carrier: String(q.carrier || ''),
    region: String(q.region || ''), owner: String(q.owner || ''),
    q: String(q.q || '').trim(), shentongOnly: String(q.shentongOnly || '1') !== '0',
  };
  const where = [], args = [];
  if (f.shentongOnly) { where.push('is_shentong=1'); }
  if (f.start) { where.push('order_date>=?'); args.push(f.start); }
  if (f.end) { where.push('order_date<=?'); args.push(f.end); }
  if (f.platform && f.platform !== '全部') { where.push('platform=?'); args.push(f.platform); }
  if (f.carrier && f.carrier !== '全部') { where.push('carrier=?'); args.push(f.carrier); }
  if (f.region && f.region !== '全部') { where.push('region_class=?'); args.push(f.region); }
  if (f.owner && f.owner !== '全部') { where.push('owner_name LIKE ?'); args.push('%' + f.owner + '%'); }
  if (f.q) {
    // 单号优先（支持多个：逗号/空格分隔），忽略日期条件
    const nos = f.q.split(/[,，、\s;；]+/).filter(Boolean).slice(0, 500);
    if (nos.length > 1) { where.push(`waybill_no IN (${nos.map(() => '?').join(',')})`); args.push(...nos); }
    else { where.push('waybill_no LIKE ?'); args.push('%' + f.q + '%'); }
  }
  return { f, where, args, sqlWhere: where.length ? 'WHERE ' + where.join(' AND ') : '' };
}

// ----------------------------------------------------------------------------
// GET /api/order-import-hub/meta — 平台/快递公司/货主等筛选项
// ----------------------------------------------------------------------------
router.get('/meta', auth, gate, (req, res) => {
  try {
    const platforms = db.prepare('SELECT DISTINCT platform FROM oih_rows WHERE platform IS NOT NULL ORDER BY platform').all().map((r) => r.platform);
    const carriers = db.prepare('SELECT DISTINCT carrier FROM oih_rows WHERE carrier IS NOT NULL ORDER BY carrier').all().map((r) => r.carrier);
    const owners = db.prepare('SELECT DISTINCT owner_name FROM oih_rows WHERE owner_name IS NOT NULL AND owner_name!=\'\' ORDER BY owner_name LIMIT 2000').all().map((r) => r.owner_name);
    const batches = db.prepare(`
      SELECT b.*,
        (SELECT COUNT(*) FROM oih_rejects r WHERE r.batch_id=b.batch_id AND r.reason_type='duplicate') AS reject_duplicate,
        (SELECT COUNT(*) FROM oih_rejects r WHERE r.batch_id=b.batch_id AND r.reason_type!='duplicate') AS reject_failed
      FROM oih_batches b ORDER BY b.batch_id DESC LIMIT 50
    `).all();
    res.json({ platforms, carriers, owners, batches, allPlatforms: hub.PLATFORM_KEYS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// 导入核心：把一份 Excel buffer 解析 + 分流 + 批量写入（直传与分片合并共用）
// 返回 { ok, result | error, status }
// ----------------------------------------------------------------------------
function importBuffer(buf, fileName, operator, t0) {
  let sheets;
  try { sheets = hub.readWorkbook(buf); }
  catch (e) { return { ok: false, status: 400, error: e.message }; }
  const withData = sheets.filter((s) => s.headers.length && s.rows.length);
  if (!withData.length) return { ok: false, status: 400, error: '工作簿中没有可导入的数据行（请保留首行表头）' };

  const batchInfo = db.prepare(
    'INSERT INTO oih_batches (file_name, platform_count, total_rows, operator, status) VALUES (?,?,?,?,?)'
  ).run(fileName, withData.length, withData.reduce((s, x) => s + x.rows.length, 0), operator, 'processing');
  const batchId = Number(batchInfo.lastInsertRowid);

  const resolveRule = expressRegion.createResolver(db);
  const legacy = makeLegacy();
  let inserted = 0, skipped = 0, failed = 0, filtered = 0;
  const sheetStats = [];
  // seen: dedupKey → 首次出现的 {sheet,row,waybill}，用于生成精确的重复原因
  const seen = new Map();

  const ins = db.prepare(`
    INSERT INTO oih_rows (batch_id,platform,sheet_name,waybill_no,owner_name,shop_name,
      express_company,carrier,is_shentong,order_date,to_province,to_city,to_district,
      region_class,quantity,receiver_name,receiver_address,raw_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insReject = db.prepare(`
    INSERT INTO oih_rejects (batch_id,platform,sheet_name,excel_row,reason_type,reason,waybill_no,owner_name,raw_json)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  function reject(platform, sheetName, rowNo, type, reason, waybill, owner, rawJson) {
    try { insReject.run(batchId, platform, sheetName, rowNo, type, reason, waybill || null, owner || null, rawJson); } catch (e) {}
  }

  try {
    db.exec('BEGIN');
    for (const sheet of withData) {
      const platform = hub.detectPlatform(sheet.sheetName, sheet.headers) || sheet.sheetName || '未知';
      const col = hub.buildColumnMap(sheet.headers, platform);
      const rule = hub.PLATFORM_RULES[platform] || {};
      let sIns = 0, sSkip = 0, sFail = 0, sFilter = 0;
      for (let rowIdx = 0; rowIdx < sheet.rows.length; rowIdx++) {
        const arr = sheet.rows[rowIdx];
        const excelRow = rowIdx + 2; // 表头占第 1 行
        const get = (field) => hub.getField(col, arr, field);
        const waybill = get('waybill_no');
        const ownerName = get('owner_name');
        const rawCarrier = get('express_company');
        const carrier = hub.normalizeCarrier(rawCarrier || platform);
        const region = hub.resolveRegion(get('to_province'), get('to_city'), get('to_district'), get('receiver_address'));
        const cls = hub.classify(region, carrier, resolveRule, legacy);
        const sample = {};
        sheet.headers.forEach((h, i) => {
          if (i < 30 && arr[i] != null && String(arr[i]).trim()) sample[h] = String(arr[i]).slice(0, 120);
        });
        let rawJson = '';
        try { rawJson = JSON.stringify(sample); } catch (e) { rawJson = ''; }

        // ① 平台状态过滤（风速类型/吉客云状态/快麦·聚水潭单号状态）
        if (rule.filter) {
          const f = rule.filter;
          const val = hub.rawByHeader(sheet.headers, arr, f.field);
          if (!f.allow.includes(val)) {
            sFilter++; filtered++;
            reject(platform, sheet.sheetName, excelRow, 'filtered',
              `${f.field}为「${val || '空'}」，仅统计 ${f.allow.join('/')}`, waybill, ownerName, rawJson);
            continue;
          }
        }

        if (!waybill && !ownerName) {
          sFail++; failed++;
          reject(platform, sheet.sheetName, excelRow, 'empty',
            '快递单号与货主名称均为空，无法定位订单', waybill, ownerName, rawJson);
          continue;
        }
        // ② 去重 key：百世附加「订单号」(SO单号)——同单号不同订单号视为新订单
        const extra = rule.dedupKeyExtra ? hub.rawByHeader(sheet.headers, arr, rule.dedupKeyExtra) : '';
        const dedupKey = waybill ? 'W:' + waybill + '|' + extra
          : `R:${platform}|${ownerName}|${get('receiver_address')}|${get('order_date')}`;
        if (seen.has(dedupKey)) {
          sSkip++; skipped++;
          const first = seen.get(dedupKey);
          const reason = waybill
            ? `快递单号「${waybill}」${extra ? `（${rule.dedupKeyExtra}=${extra}）` : ''}在本批次重复，首次出现于 ${first.sheet} 第 ${first.row} 行`
            : `同平台/货主/地址/日期组合重复，首次出现于 ${first.sheet} 第 ${first.row} 行`;
          reject(platform, sheet.sheetName, excelRow, 'duplicate', reason, waybill, ownerName, rawJson);
          continue;
        }
        seen.set(dedupKey, { sheet: sheet.sheetName, row: excelRow, waybill });

        try {
          ins.run(
            batchId, platform, sheet.sheetName, waybill || null,
            ownerName || null, get('shop_name') || null,
            rawCarrier || null, carrier || null, hub.isShentong(carrier) ? 1 : 0,
            hub.cellDate(get('order_date')) || null,
            region.province || null, region.city || null, region.district || null,
            cls, hub.cellNumber(get('quantity')),
            get('receiver_name') || null, get('receiver_address') || null, rawJson,
          );
          sIns++; inserted++;
        } catch (e) {
          sFail++; failed++;
          reject(platform, sheet.sheetName, excelRow, 'write_error',
            '写入失败：' + e.message, waybill, ownerName, rawJson);
        }
      }
      sheetStats.push({
        sheet: sheet.sheetName, platform,
        detectedColumns: Object.keys(col).length,
        total: sheet.rows.length, inserted: sIns, skipped: sSkip, failed: sFail, filtered: sFilter,
      });
    }
    db.prepare('UPDATE oih_batches SET inserted_rows=?,skipped_rows=?,failed_rows=?,status=?,finished_at=datetime(\'now\',\'localtime\') WHERE batch_id=?')
      .run(inserted, skipped, failed, 'done', batchId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    db.prepare('UPDATE oih_batches SET status=?,message=?,finished_at=datetime(\'now\',\'localtime\') WHERE batch_id=?')
      .run('failed', e.message, batchId);
    return { ok: false, status: 500, error: '导入失败（已回滚）：' + e.message, batchId };
  }

  return {
    ok: true,
    result: {
      batchId, fileName, platformCount: withData.length,
      total: inserted + skipped + failed + filtered, inserted, skipped, failed, filtered,
      elapsedMs: Date.now() - t0, sheets: sheetStats,
    },
  };
}

// ----------------------------------------------------------------------------
// POST /api/order-import-hub/import — 直传（小文件 < 网关限制时走这里）
// ----------------------------------------------------------------------------
router.post('/import', auth, gate, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  const r = importBuffer(req.file.buffer, req.file.originalname || 'upload.xlsx',
    req.user?.display_name || req.user?.username || '未知', Date.now());
  if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.batchId ? { batchId: r.batchId } : {}) });
  res.json(r.result);
});

// ----------------------------------------------------------------------------
// 分片上传（大文件，绕过网关单请求体大小限制）
//   POST /upload/init   {fileName,fileSize,totalChunks} → {uploadId}
//   POST /upload/chunk  multipart: uploadId, idx, chunk → {received,total}
//   POST /upload/finish {uploadId} → 合并分片 + 调用 importBuffer
//   POST /upload/abort  {uploadId} → 清理会话
// ----------------------------------------------------------------------------
router.post('/upload/init', auth, gate, (req, res) => {
  try {
    const fileName = String(req.body.fileName || '').slice(0, 255) || 'upload.xlsx';
    const fileSize = Number(req.body.fileSize) || 0;
    const totalChunks = Number(req.body.totalChunks) || 0;
    if (!totalChunks || totalChunks > 1000) return res.status(400).json({ error: '分片数量无效' });
    const uploadId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO oih_upload_sessions (upload_id,file_name,file_size,total_chunks) VALUES (?,?,?,?)')
      .run(uploadId, fileName, fileSize, totalChunks);
    res.json({ uploadId, chunkSize: CHUNK_LIMIT });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/upload/chunk', auth, gate, chunkUpload.single('chunk'), (req, res) => {
  try {
    const uploadId = String(req.body.uploadId || '');
    const idx = Number(req.body.idx);
    if (!uploadId || !Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: '分片参数无效' });
    const sess = db.prepare('SELECT * FROM oih_upload_sessions WHERE upload_id=?').get(uploadId);
    if (!sess || sess.status !== 'uploading') return res.status(400).json({ error: '上传会话不存在或已结束，请重新上传' });
    if (!req.file) return res.status(400).json({ error: '缺少分片数据' });
    db.prepare('INSERT OR REPLACE INTO oih_upload_chunks (upload_id,idx,data) VALUES (?,?,?)')
      .run(uploadId, idx, req.file.buffer);
    const received = db.prepare('SELECT COUNT(*) c FROM oih_upload_chunks WHERE upload_id=?').get(uploadId).c;
    db.prepare('UPDATE oih_upload_sessions SET received=? WHERE upload_id=?').run(received, uploadId);
    res.json({ received, total: sess.total_chunks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function cleanupUpload(uploadId) {
  db.prepare('DELETE FROM oih_upload_chunks WHERE upload_id=?').run(uploadId);
  db.prepare('DELETE FROM oih_upload_sessions WHERE upload_id=?').run(uploadId);
}

router.post('/upload/finish', auth, gate, (req, res) => {
  const uploadId = String(req.body.uploadId || '');
  if (!uploadId) return res.status(400).json({ error: '缺少 uploadId' });
  const sess = db.prepare('SELECT * FROM oih_upload_sessions WHERE upload_id=?').get(uploadId);
  if (!sess) return res.status(400).json({ error: '上传会话不存在，请重新上传' });
  if (sess.status === 'merging' || sess.status === 'done') return res.status(409).json({ error: '该会话正在合并或已完成，请勿重复提交' });
  const chunks = db.prepare('SELECT idx,data FROM oih_upload_chunks WHERE upload_id=? ORDER BY idx').all(uploadId);
  if (chunks.length !== sess.total_chunks) {
    return res.status(400).json({ error: `分片不完整：已收到 ${chunks.length}/${sess.total_chunks}，请重新上传` });
  }
  db.prepare('UPDATE oih_upload_sessions SET status=\'merging\' WHERE upload_id=?').run(uploadId);
  const t0 = Date.now();
  try {
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.data)));
    cleanupUpload(uploadId); // 合并后先释放暂存，再执行耗时导入
    const r = importBuffer(buf, sess.file_name, req.user?.display_name || req.user?.username || '未知', t0);
    if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.batchId ? { batchId: r.batchId } : {}) });
    res.json(r.result);
  } catch (e) {
    try { cleanupUpload(uploadId); } catch (e2) {}
    res.status(500).json({ error: '合并/导入失败：' + e.message });
  }
});

router.post('/upload/abort', auth, gate, (req, res) => {
  const uploadId = String(req.body.uploadId || '');
  if (!uploadId) return res.status(400).json({ error: '缺少 uploadId' });
  cleanupUpload(uploadId);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// GET /api/order-import-hub/query — 快递单号/货主查询（单号优先忽略日期）
// ----------------------------------------------------------------------------
router.get('/query', auth, gate, (req, res) => {
  try {
    const { f, sqlWhere, args } = parseFilters(req.query);
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize || '50', 10) || 50));
    const total = db.prepare(`SELECT COUNT(*) c FROM oih_rows ${sqlWhere}`).get(...args).c;
    const rows = db.prepare(`
      SELECT row_id,batch_id,platform,sheet_name,waybill_no,owner_name,shop_name,
        carrier,order_date,to_province,to_city,to_district,region_class,quantity,receiver_name,receiver_address
      FROM oih_rows ${sqlWhere}
      ORDER BY order_date DESC, row_id DESC LIMIT ? OFFSET ?
    `).all(...args, pageSize, (page - 1) * pageSize);
    res.json({ total, page, pageSize, dateIgnored: !!f.q, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/order-import-hub/dashboard — 地区分析（保持原【各地区累计分布】数据契约）
// ----------------------------------------------------------------------------
router.get('/dashboard', auth, gate, (req, res) => {
  try {
    const { sqlWhere, args } = parseFilters(req.query);
    const total = db.prepare(`SELECT COUNT(*) c FROM oih_rows ${sqlWhere}`).get(...args).c;
    const byClassRows = db.prepare(`
      SELECT region_class, COUNT(*) c FROM oih_rows ${sqlWhere} GROUP BY region_class
    `).all(...args);
    const byClass = { '大偏远': 0, '小偏远': 0, '正常': 0, '其他': 0 };
    byClassRows.forEach((r) => { byClass[r.region_class] = r.c; });

    const provRows = db.prepare(`
      SELECT region_class, to_province AS province, COUNT(*) c
      FROM oih_rows ${sqlWhere}
      GROUP BY region_class, to_province ORDER BY c DESC
    `).all(...args);
    const byClassProvince = { '大偏远': [], '小偏远': [], '正常': [] };
    provRows.forEach((r) => {
      if (!byClassProvince[r.region_class] || !r.province) return;
      byClassProvince[r.region_class].push({
        province: r.province, count: r.c,
        pct: total ? +(r.c * 100 / total).toFixed(2) : 0,
      });
    });

    const platforms = db.prepare(`SELECT DISTINCT platform FROM oih_rows ${sqlWhere} ORDER BY platform`).all(...args).map((r) => r.platform);
    // carrier 过滤单独拼条件，避免 sqlWhere 为空时出现 "WHERE ... AND" 语法错误
    const carrierWhere = sqlWhere ? sqlWhere + ' AND carrier IS NOT NULL' : 'WHERE carrier IS NOT NULL';
    const carriers = db.prepare(`SELECT DISTINCT carrier FROM oih_rows ${carrierWhere} ORDER BY carrier`).all(...args).map((r) => r.carrier);

    const details = db.prepare(`
      SELECT waybill_no,platform,owner_name,shop_name,carrier,order_date,
        to_province,to_city,to_district,region_class,quantity
      FROM oih_rows ${sqlWhere}
      ORDER BY order_date DESC, row_id DESC LIMIT 500
    `).all(...args);

    res.json({
      total,
      remote_total: (byClass['大偏远'] || 0) + (byClass['小偏远'] || 0),
      by_class: byClass,
      by_class_province: byClassProvince,
      platform_list: platforms,
      carrier_list: carriers,
      details,
      carrier_scope: { filtered: false, carriers: [] },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/order-import-hub/export — 导出查询结果（服务端 xlsx，上限 10 万行）
// ----------------------------------------------------------------------------
router.get('/export', auth, gate, (req, res) => {
  try {
    const { sqlWhere, args } = parseFilters(req.query);
    const rows = db.prepare(`
      SELECT waybill_no,platform,sheet_name,owner_name,shop_name,carrier,order_date,
        to_province,to_city,to_district,region_class,receiver_address
      FROM oih_rows ${sqlWhere} ORDER BY order_date DESC, row_id DESC LIMIT 100000
    `).all(...args);
    const xlsx = require('xlsx');
    const aoa = [['快递单号', '平台', '来源Sheet', '货主', '店铺', '快递公司', '日期', '省', '市', '区县', '地区分类', '收件地址']];
    rows.forEach((r) => aoa.push([
      r.waybill_no, r.platform, r.sheet_name, r.owner_name, r.shop_name, r.carrier,
      r.order_date, r.to_province, r.to_city, r.to_district, r.region_class, r.receiver_address,
    ]));
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    ws['!cols'] = aoa[0].map(() => ({ wch: 16 }));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, '订单明细');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment;filename*=UTF-8\'\'' + encodeURIComponent('订单导入查询.xlsx'));
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/order-import-hub/rejects — 查看导入异常明细（跳过/失败行）
//   参数：batchId（可选）、type（可选：duplicate/empty/write_error）、page/pageSize
// ----------------------------------------------------------------------------
router.get('/rejects', auth, gate, (req, res) => {
  try {
    const where = [], args = [];
    const batchId = Number(req.query.batchId);
    if (batchId) { where.push('batch_id=?'); args.push(batchId); }
    const type = String(req.query.type || '');
    if (type && type !== '全部') { where.push('reason_type=?'); args.push(type); }
    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize || '50', 10) || 50));
    const total = db.prepare(`SELECT COUNT(*) c FROM oih_rejects ${sqlWhere}`).get(...args).c;
    const rows = db.prepare(`
      SELECT reject_id,batch_id,platform,sheet_name,excel_row,reason_type,reason,waybill_no,owner_name,raw_json,created_at
      FROM oih_rejects ${sqlWhere} ORDER BY reject_id DESC LIMIT ? OFFSET ?
    `).all(...args, pageSize, (page - 1) * pageSize);
    // 按原因类型汇总
    const summary = db.prepare(`SELECT reason_type, COUNT(*) c FROM oih_rejects ${sqlWhere} GROUP BY reason_type`).all(...args);
    res.json({ total, page, pageSize, summary, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/order-import-hub/rejects/export — 导出异常明细为 Excel
router.get('/rejects/export', auth, gate, (req, res) => {
  try {
    const where = [], args = [];
    const batchId = Number(req.query.batchId);
    if (batchId) { where.push('batch_id=?'); args.push(batchId); }
    const type = String(req.query.type || '');
    if (type && type !== '全部') { where.push('reason_type=?'); args.push(type); }
    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT batch_id,platform,sheet_name,excel_row,reason_type,reason,waybill_no,owner_name,raw_json
      FROM oih_rejects ${sqlWhere} ORDER BY batch_id DESC, reject_id ASC LIMIT 100000
    `).all(...args);
    const xlsx = require('xlsx');
    const TYPE_LABEL = { duplicate: '重复跳过', filtered: '条件过滤', empty: '空数据失败', write_error: '写入失败' };
    const aoa = [['批次ID', '平台', '来源Sheet', 'Excel行号', '异常类型', '原因', '快递单号', '货主', '原始行数据']];
    rows.forEach((r) => aoa.push([
      r.batch_id, r.platform, r.sheet_name, r.excel_row, TYPE_LABEL[r.reason_type] || r.reason_type,
      r.reason, r.waybill_no, r.owner_name, r.raw_json,
    ]));
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 50 }, { wch: 20 }, { wch: 18 }, { wch: 80 }];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, '异常明细');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment;filename*=UTF-8\'\'' + encodeURIComponent('导入异常明细.xlsx'));
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------------------------------
// DELETE /api/order-import-hub/batch/:id — 清空某个批次（数据可全部推翻重做）
// ----------------------------------------------------------------------------
router.delete('/batch/:id', auth, gate, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: '批次 ID 无效' });
    db.exec('BEGIN');
    const r1 = db.prepare('DELETE FROM oih_rows WHERE batch_id=?').run(id);
    const r3 = db.prepare('DELETE FROM oih_rejects WHERE batch_id=?').run(id);
    const r2 = db.prepare('DELETE FROM oih_batches WHERE batch_id=?').run(id);
    db.exec('COMMIT');
    res.json({ ok: true, deletedRows: r1.changes, deletedRejects: r3.changes, deletedBatches: r2.changes });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    res.status(500).json({ error: e.message });
  }
});

// 危险操作：清空全部导入数据（用户要求「数据可全部推翻重做」）
router.delete('/all', auth, gate, (req, res) => {
  try {
    db.exec('BEGIN');
    const r1 = db.prepare('DELETE FROM oih_rows').run();
    const r3 = db.prepare('DELETE FROM oih_rejects').run();
    const r2 = db.prepare('DELETE FROM oih_batches').run();
    db.exec('COMMIT');
    res.json({ ok: true, deletedRows: r1.changes, deletedRejects: r3.changes, deletedBatches: r2.changes });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
