// 物流报价路由（基础资料 → 物流报价）：维护各快递网点计费规则
// 权限：menuGate('logi_quotes') 把关访问；写操作（增/改/删）再加 roleGate（管理员/超管）
const express = require('express');
const router = express.Router();
const db = require('../db');
const xlsx = require('xlsx');
const multer = require('multer');
const { auth } = require('../middleware/auth');
const { menuGate, roleGate } = require('../middleware/rbac');
const { parseQuoteExcel, buildTemplateAOA } = require('../services/quoteImport');
const { normalizeRegion } = require('../services/regionNormalize');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(auth);
router.use(menuGate('logi_quotes')); // 仅菜单授权角色（管理员/超管）可访问

// ---------- 公斤段报价：归一化 + 强制按 min 升序 + 重叠校验 ----------
// 入参：price_rules 数组 [{min,max,price}]；max 空/'' → null（不限上限）
// 返回：{ ok, out?(已排序), error? }
function normalizeRules(rules) {
  if (!Array.isArray(rules)) return { ok: false, error: '公斤段报价格式错误（应为数组）' };
  const out = rules
    .map((r) => ({
      min: Number(r.min != null ? r.min : 0),
      max: (r.max === '' || r.max == null) ? null : Number(r.max),
      price: Number(r.price != null ? r.price : 0),
    }))
    .filter((r) => !isNaN(r.min) && !isNaN(r.price) && (r.max === null || !isNaN(r.max)))
    .sort((a, b) => a.min - b.min); // 强制按起始重量升序入库

  // 重叠/包含校验：排序后相邻区间，下一区间起始 < 当前区间上限（含无限 null）即重叠
  for (let i = 0; i < out.length - 1; i++) {
    const curMax = out[i].max == null ? Infinity : out[i].max;
    if (out[i + 1].min < curMax) {
      return { ok: false, error: '公斤段报价区间存在重叠（如0-3kg与2-5kg），请检查修改！' };
    }
  }
  return { ok: true, out };
}

// 离散公斤段价格（导入/按编码维护使用 [{weight,price}]，weight∈[1,40]）
function normalizeDiscrete(rules) {
  if (!Array.isArray(rules)) return { ok: false, error: '价格格式错误（应为数组）' };
  const out = [];
  const seen = new Set();
  for (const r of rules) {
    const w = Number(r.weight);
    const p = Number(r.price);
    if (!Number.isInteger(w) || w < 1 || w > 40) return { ok: false, error: '重量必须为 1-40 的整数（kg）' };
    if (isNaN(p) || p < 0) return { ok: false, error: '价格必须为非负数字' };
    if (seen.has(w)) return { ok: false, error: '同一重量存在重复价格' };
    seen.add(w);
    out.push({ weight: w, price: p });
  }
  out.sort((a, b) => a.weight - b.weight);
  return { ok: true, out };
}

function validateBody(b) {
  const errs = [];
  const network = (b.network_name == null ? '' : String(b.network_name)).trim();
  const code = (b.express_code == null ? '' : String(b.express_code)).trim();
  const ratio = b.volume_ratio === '' || b.volume_ratio == null ? 6000 : Number(b.volume_ratio);
  if (!network) errs.push('网点名称必填');
  if (!code) errs.push('快递编码必填');
  if (isNaN(ratio) || !Number.isInteger(ratio) || ratio <= 0) errs.push('抛比必须为正整数');
  const nr = normalizeRules(b.price_rules);
  if (!nr.ok) errs.push(nr.error);
  return {
    errs,
    network, code, ratio,
    rules: nr.out,
    remark: (b.remark == null ? '' : String(b.remark)).trim(),
  };
}

// ---------- 列表：按快递编码+网点聚合（解决重复行），搜索 + 分页 ----------
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
  const where = [];
  const params = [];
  if (q) {
    where.push('(network_name LIKE ? OR express_code LIKE ?)');
    const like = '%' + q + '%';
    params.push(like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // 分组总数
  const total = db.prepare(
    `SELECT COUNT(*) c FROM (SELECT 1 FROM logistics_quotes ${whereSql} GROUP BY express_code, network_name)`
  ).get(...params).c;
  // 聚合行：抛比取 MIN/MAX 并标记是否冲突（绝不用 MAX 掩盖不一致）
  const rows = db.prepare(
    `SELECT express_code,
            network_name,
            MIN(volume_ratio) AS volume_ratio,
            MAX(volume_ratio) AS volume_ratio_max,
            (CASE WHEN MIN(volume_ratio)=MAX(volume_ratio) THEN 0 ELSE 1 END) AS ratio_conflict,
            COUNT(*) AS region_count
       FROM logistics_quotes ${whereSql}
       GROUP BY express_code, network_name
       ORDER BY express_code
       LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ data: rows, total, page, pageSize });
});

// ---------- 只读：按快递编码取该网点下所有省市区明细（查看弹窗用，不删数据） ----------
// 仅「展示层」附加标准化省市区（复用既有清洗函数），绝不回写数据库原始值 —— 铁律
router.get('/by-code', (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: '缺少快递编码' });
  const rows = db.prepare(
    'SELECT * FROM logistics_quotes WHERE express_code=? ORDER BY province, city, district'
  ).all(code);
  const data = rows.map((r) => {
    const n = normalizeRegion(r.province, r.city, r.district);
    return {
      ...r,
      province_disp: n.province || '',
      city_disp: n.city || '',
      district_disp: n.district || '',
    };
  });
  res.json({ data });
});

// ---------- 单行更新（查看弹窗行内编辑专用）：按「网点编码 + 原省市区」精确匹配更新一行 ----------
// 只做 UPDATE 一行：不删、不插、不动表结构 —— 严守铁律
// 入参：{ express_code, old:{province,city,district}, province, city, district, volume_ratio, price_rules }
// 匹配键用 old（编辑前的原始省市区，避免用户改了地址后找不到原行）；新地址唯一键冲突时由 UNIQUE 约束兜底
router.put('/region', roleGate('管理员', '超级管理员'), (req, res) => {
  const b = req.body || {};
  const code = (b.express_code || '').trim();
  if (!code) return res.status(400).json({ error: '缺少快递编码' });
  const oldp = b.old || {};
  const op = (oldp.province || '').trim(), oc = (oldp.city || '').trim(), od = (oldp.district || '').trim();

  const province = (b.province || '').trim();
  const city = (b.city || '').trim();
  const district = (b.district || '').trim();
  const ratio = b.volume_ratio;
  if (!Number.isInteger(Number(ratio)) || Number(ratio) <= 0)
    return res.status(400).json({ error: '抛比必须为正整数' });
  const nr = normalizeDiscrete(b.price_rules);
  if (!nr.ok) return res.status(400).json({ error: nr.error });

  const before = db.prepare(
    'SELECT * FROM logistics_quotes WHERE express_code=? AND province=? AND city=? AND district=?'
  ).get(code, op, oc, od);
  if (!before) return res.status(404).json({ error: '未找到匹配的原报价行（编码+原省市区），请刷新后重试' });

  // 若改动了省市区，先自查目标唯一键是否与其他行冲突（给出友好提示，避免直接抛 SQLite 约束错）
  if (op !== province || oc !== city || od !== district) {
    const dup = db.prepare(
      'SELECT id FROM logistics_quotes WHERE express_code=? AND province=? AND city=? AND district=? AND id!=?'
    ).get(code, province, city, district, before.id);
    if (dup) return res.status(400).json({ error: '该网点下已存在相同「省/市/区」的报价行，请检查地址' });
  }

  try {
    db.prepare(
      `UPDATE logistics_quotes
          SET province=?, city=?, district=?, volume_ratio=?, price_rules=?,
              updated_at=datetime('now','localtime')
        WHERE id=?`
    ).run(province, city, district, Number(ratio), JSON.stringify(nr.out), before.id);
  } catch (e) {
    return res.status(500).json({ error: '保存失败：' + e.message });
  }
  const after = db.prepare('SELECT * FROM logistics_quotes WHERE id=?').get(before.id);
  writeAudit(req, 'update_region', before.id, before, after);
  res.json({ success: true, data: after });
});

// ---------- 编辑保存（按快递编码整编码替换，事务 + 审计；仅管理员/超管） ----------
// 入参：{ express_code, network_name, volume_ratio, regions:[{province,city,district,price_rules}] }
// 语义：用提交的全量区域覆盖该编码下所有明细（先 DELETE 整编码，再批量 INSERT），事务原子执行
router.put('/by-code', roleGate('管理员', '超级管理员'), (req, res) => {
  const b = req.body || {};
  const code = (b.express_code || '').trim();
  const network = (b.network_name || '').trim();
  const ratio = b.volume_ratio === '' || b.volume_ratio == null ? 6000 : Number(b.volume_ratio);
  if (!code) return res.status(400).json({ error: '快递编码必填' });
  if (!network) return res.status(400).json({ error: '网点名称必填' });
  if (!Number.isInteger(ratio) || ratio <= 0) return res.status(400).json({ error: '抛比必须为正整数' });
  const regions = Array.isArray(b.regions) ? b.regions : [];
  if (!regions.length) return res.status(400).json({ error: '至少需要一个区域报价' });
  const norm = regions.map((r) => {
    const nr = normalizeDiscrete(r.price_rules);
    const area = [r.province, r.city, r.district].filter(Boolean).join('/') || '全国/不限';
    return { ok: nr.ok, error: nr.error, area, region: r, rules: nr.out };
  });
  const bad = norm.find((x) => !x.ok);
  if (bad) return res.status(400).json({ error: `区域「${bad.area}」${bad.error}` });

  const before = db.prepare('SELECT * FROM logistics_quotes WHERE express_code=?').all(code);
  db.exec('BEGIN;');
  try {
    db.prepare('DELETE FROM logistics_quotes WHERE express_code=?').run(code);
    const ins = db.prepare(`INSERT INTO logistics_quotes
      (network_name, express_code, province, city, district, volume_ratio, price_rules, remark, created_at, updated_at)
      VALUES (@network_name,@express_code,@province,@city,@district,@volume_ratio,@price_rules,@remark,datetime('now','localtime'),datetime('now','localtime'))`);
    for (const x of norm) {
      const rr = x.region;
      ins.run({
        network_name: network, express_code: code,
        province: (rr.province || '').trim(), city: (rr.city || '').trim(), district: (rr.district || '').trim(),
        volume_ratio: ratio, price_rules: JSON.stringify(x.rules),
        remark: (rr.remark || '').trim(),
      });
    }
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    return res.status(500).json({ error: '保存失败：' + e.message });
  }
  const after = db.prepare('SELECT * FROM logistics_quotes WHERE express_code=?').all(code);
  writeAudit(req, 'update_batch', code, before, after);
  res.json({ success: true, count: after.length });
});

// ---------- 删除（按快递编码清空该编码下所有省市区明细；二次确认在弹窗做；仅管理员/超管） ----------
router.delete('/by-code', roleGate('管理员', '超级管理员'), (req, res) => {
  const code = ((req.body && req.body.express_code) || req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: '缺少快递编码' });
  const before = db.prepare('SELECT * FROM logistics_quotes WHERE express_code=?').all(code);
  if (!before.length) return res.status(404).json({ error: '该编码下无报价数据' });
  db.prepare('DELETE FROM logistics_quotes WHERE express_code=?').run(code);
  writeAudit(req, 'delete_batch', code, before, { deleted: before.length });
  res.json({ success: true, deleted: before.length });
});

// ---------- Excel 导入模板下载（须在 /:id 之前注册） ----------
router.get('/template', (req, res) => {
  const aoa = buildTemplateAOA();
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0].map((h) => ({ wch: Math.max(8, String(h).length * 2) }));
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, '物流报价');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="logistics_quote_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ---------- Excel 导出（纯只读）：按搜索条件导出全量省市区明细，表头与导入模板绝对一致 ----------
// 必须在 /:id 之前注册，否则 'export' 会被当作 id。
router.get('/export', (req, res) => {
  const q = (req.query.q || '').trim();
  const where = [], params = [];
  if (q) {
    where.push('(network_name LIKE ? OR express_code LIKE ?)');
    const like = '%' + q + '%';
    params.push(like, like); // 与列表搜索口径完全一致
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 表头直接复用导入模板首行 → 列数/顺序永远与模板一致，杜绝手写漂移
  const header = buildTemplateAOA()[0]; // 网点名称|快递编码|抛比|省份|城市|区县|1kg…40kg
  const aoa = [header];

  // 分批读取（每批 500 行）：node:sqlite 的 StatementSync 无 .iterate()，用 LIMIT/OFFSET 分批，
  // 避免一次性把全量结果集载入内存（几千行稳态，更大批量也不会因结果集堆积而爆内存）
  const stmt = db.prepare(
    `SELECT network_name, express_code, province, city, district, volume_ratio, price_rules
       FROM logistics_quotes ${whereSql}
      ORDER BY express_code, province, city, district
      LIMIT ? OFFSET ?`
  );
  const BATCH = 500;
  let offset = 0;
  while (true) {
    const batch = stmt.all(...params, BATCH, offset);
    if (!batch.length) break;
    for (const r of batch) {
      // 兼容两种历史存储：离散 [{weight,price}] 与旧区间 [{min,max,price}]
      const pm = {};
      let rules = [];
      try { rules = JSON.parse(r.price_rules || '[]'); } catch (e) { rules = []; }
      if (Array.isArray(rules)) for (const x of rules) {
        if (x.weight != null) {
          const w = Number(x.weight);
          if (w >= 1 && w <= 40) pm[w] = Number(x.price);
        } else if (x.min != null) {
          const lo = Math.max(1, Math.ceil(Number(x.min)));
          const hi = Math.min(40, Math.floor((x.max == null || x.max === '') ? 40 : Number(x.max)));
          for (let w = lo; w <= hi; w++) pm[w] = Number(x.price); // 区间展开到每个 kg 列
        }
      }

      // 地址：全国/不限(省为空或"全国"/"不限") → 省份填"全国"、市区县留空；其余走既有清洗
      const rp = String(r.province || '').trim();
      let prov, city, dist;
      if (!rp || rp === '全国' || rp === '不限') {
        prov = '全国'; city = ''; dist = '';
      } else {
        const n = normalizeRegion(rp, r.city, r.district);
        prov = n.province || rp;
        city = n.city || String(r.city || '');
        dist = n.district || String(r.district || '');
      }

      const row = [r.network_name || '', r.express_code || '', Number(r.volume_ratio), prov, city, dist];
      for (let w = 1; w <= 40; w++) row.push(pm[w] == null ? null : pm[w]); // 空段写 null → Excel 真·空单元格
      aoa.push(row);
    } // end for batch
    offset += batch.length;
  } // end while

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!cols'] = header.map((h) => ({ wch: Math.max(8, String(h).length * 2) }));
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, '物流报价');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });

  const fn = 'logistics_quotes_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.xlsx';
  res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf); // 一次性文件流响应，前端 API.download 直接 Blob 下载
});

// ---------- Excel 导入（按「编码+省市区」唯一键 upsert；仅管理员/超管） ----------
router.post('/import', roleGate('管理员', '超级管理员'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到 Excel 文件' });
  const { rows, failures } = parseQuoteExcel(req.file.buffer);
  // 全部行校验失败：仍返回结构化结果（含失败行号与原因），交由前端提示，避免整批崩溃
  if (failures.length && !rows.length) {
    return res.json({ success: false, created: 0, updated: 0, failed: failures.length, failures });
  }
  const upsert = db.prepare(`
    INSERT INTO logistics_quotes
      (network_name, express_code, province, city, district, volume_ratio, price_rules, remark, created_at, updated_at)
    VALUES (@network_name,@express_code,@province,@city,@district,@volume_ratio,@price_rules,@remark,datetime('now','localtime'),datetime('now','localtime'))
    ON CONFLICT(express_code, province, city, district) DO UPDATE SET
      network_name=excluded.network_name, volume_ratio=excluded.volume_ratio,
      price_rules=excluded.price_rules, remark=excluded.remark, updated_at=datetime('now','localtime')`);
  let created = 0, updated = 0;
  const diffs = [];
  const findRow = db.prepare(
    'SELECT * FROM logistics_quotes WHERE express_code=? AND province=? AND city=? AND district=?'
  );
  const keyOf = (r) => [r.express_code, r.province, r.city, r.district];
  db.exec('BEGIN;');
  try {
    for (const r of rows) {
      const before = findRow.get(...keyOf(r)) || null;
      upsert.run(r);
      const after = findRow.get(...keyOf(r)) || null;
      if (before) updated++; else created++;
      if (diffs.length < 100) diffs.push({ express_code: r.express_code, before, after });
    }
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    return res.status(500).json({ error: '导入写库失败：' + e.message });
  }
  // 报价 Excel 导入审计（原先遗漏）：一条批次日志，含逐行修改前后对比
  require('../services/auditLog').writeLog(req, {
    table: 'logistics_quotes', module: '物流报价', action: 'import',
    targetId: 'import:' + (req.file.originalname || 'quotes.xlsx'),
    content: {
      file: req.file.originalname || '', created, updated,
      failed: failures.length, failures: failures.slice(0, 50), diffs,
    },
  });
  res.json({ success: true, created, updated, failed: failures.length, failures });
});

router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM logistics_quotes WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '报价记录不存在' });
  res.json({ data: r });
});

// ---------- 新增（仅管理员/超管） ----------
router.post('/', roleGate('管理员', '超级管理员'), (req, res) => {
  const b = req.body || {};
  const { errs, network, code, ratio, rules, remark } = validateBody(b);
  if (errs.length) return res.status(400).json({ error: errs.join('；') });
  if (db.prepare('SELECT 1 FROM logistics_quotes WHERE express_code=?').get(code))
    return res.status(400).json({ error: '快递编码已存在（一网点一编码）' });
  const info = db.prepare(
    'INSERT INTO logistics_quotes (network_name, express_code, volume_ratio, price_rules, remark) VALUES (?,?,?,?,?)'
  ).run(network, code, ratio, JSON.stringify(rules), remark);
  const created = db.prepare('SELECT * FROM logistics_quotes WHERE id=?').get(info.lastInsertRowid);
  writeAudit(req, 'create', info.lastInsertRowid, null, created);
  res.status(201).json({ data: created });
});

// ---------- 编辑（仅管理员/超管） ----------
router.put('/:id', roleGate('管理员', '超级管理员'), (req, res) => {
  const b = req.body || {};
  const old = db.prepare('SELECT * FROM logistics_quotes WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '报价记录不存在' });
  const { errs, network, code, ratio, rules, remark } = validateBody(b);
  if (errs.length) return res.status(400).json({ error: errs.join('；') });
  if (code !== old.express_code &&
      db.prepare('SELECT 1 FROM logistics_quotes WHERE express_code=? AND id!=?').get(code, old.id))
    return res.status(400).json({ error: '快递编码已存在（一网点一编码）' });
  db.prepare(
    `UPDATE logistics_quotes
        SET network_name=?, express_code=?, volume_ratio=?, price_rules=?, remark=?,
            updated_at=datetime('now','localtime')
      WHERE id=?`
  ).run(network, code, ratio, JSON.stringify(rules), remark, old.id);
  const updated = db.prepare('SELECT * FROM logistics_quotes WHERE id=?').get(old.id);
  writeAudit(req, 'update', old.id, old, updated);
  res.json({ data: updated });
});

// ---------- 删除（仅管理员/超管） ----------
router.delete('/:id', roleGate('管理员', '超级管理员'), (req, res) => {
  const old = db.prepare('SELECT * FROM logistics_quotes WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: '报价记录不存在' });
  db.prepare('DELETE FROM logistics_quotes WHERE id=?').run(old.id);
  writeAudit(req, 'delete', old.id, old, { deleted: true });
  res.json({ data: { id: old.id, deleted: true } });
});

// 审计：统一走全局日志服务（新旧字段双写，模块=物流报价）
function writeAudit(req, action, recordId, before, after) {
  require('../services/auditLog').writeLog(req, {
    table: 'logistics_quotes', module: '物流报价', action,
    targetId: recordId, before, after,
  });
}

module.exports = router;
