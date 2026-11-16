// ============================================================================
//  日志中心查询路由（只读）
//  - 统一从 v_audit_logs 标准视图读取，字段名与需求完全对齐；
//  - 子菜单按 scope（menus.path）在服务端强制锁定 module，前端无法越权跨模块查询；
//  - 每个接口都做菜单级鉴权（menuGate 同源的 hasMenuPerm）。
// ============================================================================
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const { hasMenuPerm } = require('../middleware/rbac');

router.use(auth);

// scope（子菜单 path）→ 业务模块；null 表示跨模块汇总页「全部日志」
// 与 src/db/menu_seed.sql、public/js/tabs.js、public/js/log-center.js 完全一致
const MODULE_BY_SCOPE = {
  log_customer: '客户资料',
  log_workhours: '工时管理',
  log_logistics: '物流报价',
  log_smartquote: '智能测单',
  log_system: '系统/权限',
  log_all: null,
};
const ACTIONS = ['新增', '修改', '删除', '导入', '历史未知操作'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function scopeGuard(req, res) {
  const scope = String(req.query.scope || '');
  if (!Object.prototype.hasOwnProperty.call(MODULE_BY_SCOPE, scope)) {
    res.status(400).json({ error: 'scope 参数非法（须为日志中心子菜单 path）' });
    return null;
  }
  if (!hasMenuPerm(req.user, scope)) {
    res.status(403).json({ error: '无该日志菜单权限' });
    return null;
  }
  return { scope, module: MODULE_BY_SCOPE[scope] };
}

// ---------- 参数清洗（根治 node:sqlite 绑定错误） ----------
// 现象：Provided value cannot be bound to SQLite parameter N —— 源于传入了
// undefined / 布尔 / 对象 等 SQLite 不接受的值。统一在落库前清洗：
//   undefined / null → NULL
//   布尔 true/false   → 1 / 0（SQLite 无布尔类型，唯一可行映射）
//   非有限数字        → NULL；Date → ISO 字符串；对象/数组 → JSON 字符串
function cleanParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return null; } }
  return v;
}
function cleanParams(arr) {
  return (arr || []).map(cleanParam);
}

// ---------- 操作人下拉选项 ----------
router.get('/operators', (req, res) => {
  const g = scopeGuard(req, res);
  if (!g) return;
  const rows = db.prepare(`
    SELECT user_name, MIN(user_id) AS user_id, COUNT(*) AS c
    FROM v_audit_logs GROUP BY user_name ORDER BY c DESC, user_name
  `).all();
  res.json({ data: rows });
});

// ---------- 日志列表：综合查询 + 分页 ----------
router.get('/', (req, res) => {
  const g = scopeGuard(req, res);
  if (!g) return;

  const operator = String(req.query.operator || '').trim();
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || '').trim();
  const action = String(req.query.action || '').trim();
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10) || 20));

  if (dateFrom && !DATE_RE.test(dateFrom)) return res.status(400).json({ error: '开始日期格式应为 YYYY-MM-DD' });
  if (dateTo && !DATE_RE.test(dateTo)) return res.status(400).json({ error: '结束日期格式应为 YYYY-MM-DD' });
  if (action && !ACTIONS.includes(action)) return res.status(400).json({ error: '操作类型参数非法' });

  const where = [];
  const params = [];
  // 子菜单强制按模块过滤（核心需求）；log_all 才不加此条件
  if (g.module) { where.push('module = ?'); params.push(g.module); }
  if (operator) { where.push('user_name = ?'); params.push(operator); }
  if (dateFrom) { where.push('date(created_at) >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('date(created_at) <= ?'); params.push(dateTo); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (q) {
    where.push(`(user_name LIKE ? OR target_id LIKE ? OR CAST(content AS TEXT) LIKE ?
                 OR ip_address LIKE ? OR module LIKE ? OR table_name LIKE ?)`);
    const like = '%' + q + '%';
    for (let i = 0; i < 6; i++) params.push(like);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM v_audit_logs ${w}`).get(...cleanParams(params)).c;
  const rows = db.prepare(`
    SELECT id, created_at, user_name, user_id, module, action, action_raw,
           target_id, ip_address, table_name,
           CASE WHEN content IS NULL THEN 0 ELSE 1 END AS has_detail
    FROM v_audit_logs ${w}
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(...cleanParams(params), cleanParam(pageSize), cleanParam((page - 1) * pageSize));
  res.json({ data: rows, total, page, pageSize, pages: Math.ceil(total / pageSize) || 1 });
});

// ---------- 日志详情：修改前后对比 JSON ----------
router.get('/:id', (req, res) => {
  const g = scopeGuard(req, res);
  if (!g) return;
  // v_audit_logs.id 是 COALESCE 表达式（无列亲和性），必须绑定整数，
  // 否则字符串 '5' 与整数 5 比较不命中，会误报 404
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '日志 ID 非法' });
  const row = db.prepare('SELECT * FROM v_audit_logs WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '日志不存在' });
  // 二次隔离：子菜单只能看本模块日志
  if (g.module && row.module !== g.module) {
    return res.status(403).json({ error: '该日志不属于当前子菜单模块' });
  }
  res.json({ data: row });
});

module.exports = router;
