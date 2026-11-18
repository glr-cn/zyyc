// Express 入口：挂载静态前端 + 认证路由 + 业务路由
const express = require('express');
const path = require('path');
const db = require('./db');

const authRouter = require('./routes/auth');
const customersRouter = require('./routes/customers');
const ordersRouter = require('./routes/orders');
const inventoryRouter = require('./routes/inventory');
const workhoursRouter = require('./routes/workhours');
const analyticsRouter = require('./routes/analytics');
const dashboardRouter = require('./routes/dashboard');
const usersRouter = require('./routes/users');
const rolesRouter = require('./routes/roles');
const menusRouter = require('./routes/menus');
const logisticsQuotesRouter = require('./routes/logistics-quotes');
const smartQuoteRouter = require('./routes/smart-quote');
const logsRouter = require('./routes/logs');
const adminRouter = require('./routes/admin');

const app = express();
// 请求体上限 2MB：上传 Excel 另有 multer limit，JSON/URL 表单不超过 2MB 足够
// 防止恶意用户传 100MB+ 卡死 EventLoop（2025-11-18 生产加固）
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// 静态前端（public/）
app.use(express.static(path.join(__dirname, '..', 'public')));

// 认证路由（公开）
app.use('/api/auth', authRouter);

// 业务路由（内部自带鉴权中间件）
app.use('/api/customers', customersRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/workhours', workhoursRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/users', usersRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/menus', menusRouter);
app.use('/api/logistics-quotes', logisticsQuotesRouter);
app.use('/api/smart-quote', smartQuoteRouter);
app.use('/api/logs', logsRouter);
app.use('/api/admin', adminRouter);

// 数据库运行诊断（供 /api/health 返回）
// 用途：一眼看出「当前实例连的是哪个库、有没有业务数据、有没有可回滚的快照」，
// 这三个字段是 2026-11-16 数据丢失事故后新增的自检位。
const { DB_PATH } = require('./db');
const fs = require('fs');
function dbDiag() {
  const out = { dbPath: DB_PATH };
  try {
    const st = fs.statSync(DB_PATH);
    out.dbSize = st.size;
  } catch (e) { out.dbSize = -1; }
  try {
    const counts = {};
    for (const t of ['customers', 'work_hours', 'orders', 'logistics_quotes', 'audit_logs']) {
      try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (e) { counts[t] = -1; }
    }
    out.counts = counts;
  } catch (e) { /* ignore */ }
  try {
    const bakDir = path.join(path.dirname(DB_PATH), 'backups');
    out.snapshots = fs.existsSync(bakDir) ? fs.readdirSync(bakDir).filter((f) => f.endsWith('.db')).length : 0;
  } catch (e) { out.snapshots = 0; }
  // JWT 密钥来源诊断：2026-11-16 线上实测「登录成功但后续请求一律 401」，
  // 根因是各实例密钥不一致（包内 jwt.secret 未生效 → 每进程随机生成）。
  // secretSource = env / package / persist / random，其中 random 意味着多实例必然 401。
  try {
    const auth = require('./middleware/auth');
    out.jwtSecretSource = auth.secretSource ? auth.secretSource() : 'unknown';
    out.jwtSecretConsistent = out.jwtSecretSource !== 'random';
  } catch (e) { out.jwtSecretSource = 'unknown'; }
  return out;
}

app.get('/api/health', (req, res) => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  // 菜单种子自检：直接访问 /api/health 即可判断「当前服务实例连的是哪个库」。
  // menuLogs=6 表示日志中心父菜单与 6 个子菜单齐全；0 表示该实例没跑 menu_seed.sql。
  let menuLogs = -1;
  try {
    const parent = db.prepare("SELECT menu_id FROM menus WHERE menu_code='logs'").get();
    menuLogs = parent
      ? db.prepare('SELECT COUNT(*) c FROM menus WHERE parent_id=?').get(parent.menu_id).c
      : 0;
  } catch (e) { /* 表不存在时保持 -1 */ }
  res.json({ status: 'ok', db: 'connected', tables, menuLogs, menuVersion: 3, ...dbDiag() });
});

// 全局错误处理：任何未捕获异常（含 express.json() 的请求体解析错误）
// 统一返回 JSON，杜绝 Express 默认 HTML 错误页导致前端只能显示兜底「请求失败」
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // JSON 请求体解析失败 → 400；其余未捕获异常 → 500
  const isParse = err.type === 'entity.parse.failed' || err instanceof SyntaxError;
  const status = err.status || err.statusCode || (isParse ? 400 : 500);
  console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err.message);
  res.status(status).json({
    error: (isParse ? '请求体不是合法 JSON：' : '服务器内部错误：') + err.message,
  });
});

// 仅当作为入口直接运行（node src/server.js）时才监听端口；
// 被 require 时仅导出 app（供测试/挂载复用，避免重复 listen）
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[light-erp] running on http://0.0.0.0:${PORT}`);
    // 托管环境没有 cron：由进程自己每天生成一次一致性快照（可用 ERP_BACKUP_ENABLED=0 关闭）
    require('./services/backupScheduler').startBackupScheduler(db._path);
  });
}

module.exports = app;
