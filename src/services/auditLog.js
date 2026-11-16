// ============================================================================
//  全局统一审计日志写入（日志中心唯一写入口）
//  - 新旧字段「双写」：历史 8 列与日志中心标准 8 列同时落库，
//    任何一侧都不会变空，旧代码/旧测试仍读 action='create|update|delete'。
//  - 模块映射与 audit_logs_migration.sql / v_audit_logs 视图严格一致；
//    action 统一落受控英文枚举，中文「新增/修改/删除/导入」由视图输出。
//  - 日志写入失败只记录到控制台，不阻断业务请求（业务数据优先）。
// ============================================================================
const db = require('../db');

const UNKNOWN = '历史未知操作';

// 模块映射：与 src/db/audit_logs_migration.sql 中的 CASE 保持一一对应
const MODULE_BY_TABLE = {
  customers: '客户资料',
  work_hours: '工时管理',
  logistics_quotes: '物流报价',
  smart_quote_batches: '智能测单',
  smart_quote_records: '智能测单',
  smart_quote: '智能测单',
  app_settings: '智能测单',
  users: '系统/权限',
  roles: '系统/权限',
  role_menus: '系统/权限',
  menus: '系统/权限',
  orders: '其他业务',
  inventory_transactions: '其他业务',
};

const MODULES = ['客户资料', '工时管理', '物流报价', '智能测单', '系统/权限', '其他业务'];
const ACTION_LABELS = { create: '新增', update: '修改', delete: '删除', import: '导入' };

// 兼容中文/英文/历史别名，收敛为 4 个受控枚举值，杜绝脏 action
const ACTION_ENUM = {
  create: 'create', 新增: 'create', add: 'create',
  update: 'update', 修改: 'update', edit: 'update',
  delete: 'delete', 删除: 'delete', remove: 'delete',
  import: 'import', 导入: 'import',
};

function toEnum(action) {
  return ACTION_ENUM[String(action == null ? '' : action).toLowerCase()] || 'unknown';
}

function clientIp(req) {
  if (!req) return '';
  const h = req.headers || {};
  const xf = h['x-forwarded-for'];
  if (xf) return String(Array.isArray(xf) ? xf[0] : xf).split(',')[0].trim().slice(0, 64);
  const raw = (req.ip || (req.socket && req.socket.remoteAddress) || '').toString();
  return raw.replace(/^::ffff:/, '').slice(0, 64);
}

function stringify(v) {
  if (v === undefined || v === null) return null;
  try { return JSON.stringify(v); } catch (_) { return null; }
}

/**
 * 写一条审计日志。
 * @param {Object} req   Express 请求（取 req.user / IP）；无登录态时传 { headers:{} } 亦可
 * @param {Object} opts  { table, module, action, targetId, before, after, content, user }
 *   - before / after : 修改前后对象，自动组成 {"before":…,"after":…} 对比 JSON
 *   - content        : 自定义对比对象（如导入批次汇总），提供时优先使用
 */
function writeLog(req, opts = {}) {
  try {
    const u = opts.user || (req && req.user) || {};
    const username = u.username || '未知用户';
    const userId = u.user_id == null ? null : u.user_id;
    const table = opts.table || 'unknown';
    const module = opts.module || MODULE_BY_TABLE[table] || UNKNOWN;
    const action = toEnum(opts.action);
    const targetId = opts.targetId == null ? '' : String(opts.targetId);
    const before = opts.before === undefined ? null : opts.before;
    const after = opts.after === undefined ? null : opts.after;
    const contentObj = opts.content !== undefined ? opts.content : { before, after };
    const ip = clientIp(req);

    const info = db.prepare(`
      INSERT INTO audit_logs
        (operator, operated_at, table_name, record_id, action, before_summary, after_summary,
         user_id, user_name, module, target_id, content, ip_address, created_at)
      VALUES (?, datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    `).run(
      username, table, targetId, action,
      stringify(before), stringify(after),
      userId, username, module, targetId, stringify(contentObj), ip
    );
    // 双保险：即使触发器被外部移除，也保证 id 与 log_id 严格对齐
    if (info && info.lastInsertRowid != null) {
      db.prepare('UPDATE audit_logs SET id = log_id WHERE log_id = ? AND id IS NULL').run(info.lastInsertRowid);
    }
  } catch (e) {
    console.error('[audit] 日志写入失败（不影响业务）：', e.message);
  }
}

/**
 * 生成兼容旧签名的写入函数：writeAudit(req, action, recordId, before, after)
 * 各路由只需把本地 writeAudit 换成本工厂产物，调用点零改动。
 */
function createLogger({ table, module } = {}) {
  return function writeAudit(req, action, recordId, before, after, extra) {
    return writeLog(req, {
      table, module, action, targetId: recordId, before, after,
      ...(extra || {}),
    });
  };
}

module.exports = {
  writeLog, createLogger, clientIp, toEnum,
  MODULE_BY_TABLE, MODULES, ACTION_LABELS, UNKNOWN,
};
