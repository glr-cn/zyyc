const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { SECRET } = require('../middleware/auth');
const { WAREHOUSES } = require('../services/workhours');
const { writeLog } = require('../services/auditLog');
const { inspect, headers } = require('../services/threeHours');

const router = express.Router();
const template = path.resolve(__dirname, '../../templates/三类工时导入模板.xlsx');
const signingKey = crypto.createHmac('sha256', SECRET).update('workhours/three/preview/v1').digest();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', fileFilter(req, file, cb) {
  req.uploadName = path.win32.basename(file.originalname).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255);
  cb(null, true);
}, limits: {
  fileSize: 10 * 1024 * 1024, files: 1, fields: 1, parts: 3, fieldSize: 2048, fieldNameSize: 32,
} }).single('file');

function audit(req, batchId, outcome, details, rows = []) {
  const bySheet = Object.fromEntries(Object.keys(headers).map(sheet => [sheet, { total: 0, plannedCreate: 0, plannedSkip: 0, created: 0, skipped: 0, failed: 0, notWritten: 0 }]));
  const entries = rows.map(({ sheet, line, action, reason, work_id }) => {
    const preview = req.path.toLowerCase().startsWith('/preview');
    const result = action === 'create' ? (preview ? 'plannedCreate' : 'created') : action === 'skip' ? (preview ? 'plannedSkip' : 'skipped') : action === 'error' ? 'failed' : 'notWritten';
    bySheet[sheet].total++;
    bySheet[sheet][result]++;
    return { sheet, line, result, ...(reason ? { reason } : {}), ...(work_id != null ? { work_id } : {}) };
  });
  writeLog(req, { strict: true, table: 'work_hours', action: 'import', targetId: batchId,
    content: { source: 'threeHours', stage: req.path.split('/')[1].toLowerCase(), warehouse: WAREHOUSES.includes(req.query.warehouse) ? req.query.warehouse : null,
      batchId, outcome, filename: req.uploadName || (req.path === '/template' ? path.basename(template) : null), bySheet, rows: entries, ...details } });
}

function reject(req, res, status, error, rows = []) {
  const batchId = req.batchId;
  rows = rows.map(({ sheet, line, action, reason }) => action === 'error' ? { sheet, line, action, reason }
    : { sheet, line, action: 'notWritten', reason: error });
  const result = { batchId, created: 0, skipped: 0, failed: rows.filter(r => r.action === 'error').length || 1, rows };
  try { audit(req, batchId, 'failed', { error, created: 0, skipped: 0, failed: result.failed, total: rows.length }, rows); }
  catch (e) {
    console.error('[three-hours] 失败批次审计写入失败：', e.message);
    return res.status(500).json({ ...result, error: '导入未完成；失败日志写入异常，请联系管理员' });
  }
  return res.status(status).json({ ...result, error });
}

router.use((req, res, next) => {
  req.batchId = crypto.randomUUID();
  res.set('Cache-Control', 'no-store');
  const current = db.prepare(`SELECT u.username, u.display_name, r.role_code, r.is_readonly FROM users u
    JOIN roles r ON r.role_id=u.role_id WHERE u.user_id=?`).get(req.user.user_id);
  if (!current || current.username !== req.user.username || current.role_code !== 'super_admin' ||
      (req.method !== 'GET' && current.is_readonly)) return reject(req, res, 403, '仅超级管理员可操作三类工时导入');
  if (!WAREHOUSES.includes(req.query.warehouse)) return reject(req, res, 400, '仓库参数非法');
  req.user.display_name = current.display_name;
  next();
});

router.get('/template', (req, res) => res.download(template, err => {
  if (err && !res.headersSent) {
    if (err.status === 404 || err.code === 'ENOENT') return reject(req, res, 500, '模板文件不可用，请联系管理员');
    return res.status(500).json({ error: '模板下载失败，请稍后重试' });
  }
}));

function receive(req, res, next) {
  if (!req.is('multipart/form-data')) return reject(req, res, 400, '请使用 multipart 上传 Excel 文件');
  upload(req, res, err => {
    if (err) return reject(req, res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      err.code === 'LIMIT_FILE_SIZE' ? '上传文件不得超过 10 MB' : '上传格式错误或超出限制');
    if (!req.file || !/\.xlsx$/i.test(req.file.originalname) || req.file.size < 4 ||
        req.file.buffer.readUInt32LE(0) !== 0x04034b50) return reject(req, res, 400, '请上传有效的 .xlsx 文件');
    next();
  });
}

function inspectUpload(req) {
  return inspect(db, req.query.warehouse, req.file.buffer);
}

function rejectInput(req, res, err) {
  const rows = err.sheet ? [{ sheet: err.sheet, line: err.line, action: 'error', reason: err.message }] : [];
  return reject(req, res, 400, err.message, rows);
}

router.post('/preview', receive, (req, res) => {
  let result;
  try { result = inspectUpload(req); }
  catch (err) {
    if (err.code === 'THREE_HOURS_INPUT') return rejectInput(req, res, err);
    return reject(req, res, 500, '预览未完成，请稍后重试');
  }
  const { rows, total } = result;
  const previewToken = jwt.sign({ batch: req.batchId, user: req.user.user_id, warehouse: req.query.warehouse,
    file: digest(req.file.buffer), result: digest(JSON.stringify({ rows, total })) }, signingKey, { algorithm: 'HS256', expiresIn: '15m' });
  const errors = rows.filter(r => r.action === 'error').length;
  audit(req, req.batchId, errors ? 'failed' : 'preview', { total, failed: errors }, rows);
  res.json({ batchId: req.batchId, rows, total, previewToken });
});

const columns = ['work_type', 'customer_id', 'customer_name', 'unit', 'date', 'cartons', 'tons', 'cubic', 'pallets', 'workload', 'project',
  'main_hours', 'other_hours', 'shared_hours', 'total_hours', 'efficiency', 'unit_cost', 'doc_cost', 'remark'];
router.post('/import', receive, (req, res) => {
  let token;
  try { token = jwt.verify(req.body.previewToken, signingKey, { algorithms: ['HS256'] }); }
  catch (_) { return reject(req, res, 400, '预览凭证无效或已过期，请重新预览'); }
  if (token.user !== req.user.user_id || token.warehouse !== req.query.warehouse || token.file !== digest(req.file.buffer)) {
    return reject(req, res, 409, '上传文件、操作人或仓库与预览不一致');
  }
  req.batchId = token.batch;
  let inTransaction = false;
  let rows = [];
  try {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const result = inspectUpload(req);
    rows = result.rows;
    const completed = db.prepare(`SELECT 1 FROM audit_logs WHERE table_name='work_hours' AND action='import' AND target_id=?
      AND json_extract(content,'$.stage')='import' AND json_extract(content,'$.source')='threeHours'
      AND json_extract(content,'$.outcome') IN ('success','noop') LIMIT 1`).get(token.batch);
    if (completed) {
      rows = rows.map(({ sheet, line }) => ({ sheet, line, action: 'skip', reason: '该批次已提交' }));
    } else {
      const invalid = rows.some(r => !['create', 'skip'].includes(r.action));
      const stale = token.result !== digest(JSON.stringify({ rows, total: result.total }));
      if (invalid || stale) {
        db.exec('ROLLBACK'); inTransaction = false;
        return reject(req, res, stale ? 409 : 400, stale ? '预览结果已变化，请重新预览' : '存在违规行，整批未导入', rows);
      }
    }
    const insert = db.prepare(`INSERT INTO work_hours (warehouse,${columns.join(',')},owner_user_id,status,submitter,submit_time)
      VALUES (?,${columns.map(() => '?').join(',')},?,'archived',?,datetime('now','localtime'))`);
    let created = 0;
    for (const row of rows) {
      if (row.action !== 'create') continue;
      const data = row.data;
      if (!data || !['收货', '库内', '后勤'].includes(data.work_type) || (data.warehouse && data.warehouse !== req.query.warehouse)) throw new Error('invalid record');
      const info = insert.run(req.query.warehouse, ...columns.map(key => data[key] ?? null), req.user.user_id, req.user.display_name || req.user.username);
      if (info.changes !== 1) throw new Error('工时记录未写入');
      row.work_id = Number(info.lastInsertRowid);
      created++;
    }
    const skipped = rows.length - created;
    audit(req, token.batch, created ? 'success' : 'noop', { total: rows.length, created, skipped, failed: 0 }, rows);
    db.exec('COMMIT'); inTransaction = false;
    return res.json({ batchId: token.batch, created, skipped, failed: 0, rows });
  } catch (err) {
    if (inTransaction) db.exec('ROLLBACK');
    if (err.code === 'THREE_HOURS_INPUT') return rejectInput(req, res, err);
    return reject(req, res, 500, '导入未完成，整批未写入', rows);
  }
});

router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  return reject(req, res, 500, '三类工时操作未完成');
});

module.exports = router;
