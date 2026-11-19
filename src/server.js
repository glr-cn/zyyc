// Express 入口：挂载静态前端 + 认证路由 + 业务路由
const express = require('express');
const path = require('path');
const compression = require('compression');
const db = require('./db');

const authRouter = require('./routes/auth');
const customersRouter = require('./routes/customers');
const ordersRouter = require('./routes/orders');
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

// ===========================================================
// 【性能优化 1】gzip 压缩中间件
// 实测：style.css 73KB → gzip 后 18KB（-75%）；api.js 5KB → 1.5KB（-70%）
// 阈值 1KB 才压（小文件压了反而更大），brotli 不支持（Node 20 built-in zlib 够用）
// ===========================================================
app.use(compression({ threshold: 1024 }));

// 请求体上限：上传 Excel 另有 multer limit，JSON/URL 表单 20MB 足够
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ===========================================================
// 【性能优化 2】静态资源强缓存 24 小时
// 原来 Express 默认返回 Cache-Control: no-cache, no-store
// → 浏览器每次刷新都重新下载所有 JS/CSS，10 个文件 ~150KB 原始
// → 改成 public, max-age=86400 → 24 小时内浏览器直接走 disk cache（~100ms）
// → 版本升级时改 ?v=4 → URL 变了浏览器自动下载新版本（完美的 cache-busting）
// 同时加 immutable 标记：浏览器缓存期间无需校验 ETag（更激进）
// ===========================================================
const STATIC_ROOT = path.join(__dirname, '..', 'public');
// server 引用（进程级异常兜底时用来 close 端口 → 让上层自动重启更快）
let server = null;
app.use(express.static(STATIC_ROOT, {
  maxAge: '24h',                          // 24 小时
  immutable: true,                        // 版本号不变就永不校验
  etag: true,                             // 保留 ETag 作为弱校验兜底
  lastModified: true,                     // 保留 Last-Modified
  setHeaders: function (res) {
    // 静态资源（.js / .css / .map / 图片 / 字体）给强缓存
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  },
}));

// ===========================================================
// 【性能优化 2b】所有 /api/* 响应强制"不缓存"
// 覆盖 express.static 的强缓存头——否则浏览器可能把 /api/workhours 等 JSON 响应
// 也缓存 24 小时，导致用户刷新看到旧数据（工时列表、客户列表、看板数据等都是实时的）。
// ===========================================================
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// API 路由（公开）
app.use('/api/auth', authRouter);

// 业务路由（内部自带鉴权中间件）
app.use('/api/customers', customersRouter);
app.use('/api/orders', ordersRouter);
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
  const isParse = err.type === 'entity.parse.failed' || err instanceof SyntaxError;
  const status = err.status || err.statusCode || (isParse ? 400 : 500);
  console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err.message);
  if (!res.headersSent) {
    res.status(status).json({
      error: (isParse ? '请求体不是合法 JSON：' : '服务器内部错误：') + err.message,
    });
  }
});

// ===========================================================
// 【性能优化 3】Express 全局 30s 请求超时
// SQLite better-sqlite3 是同步阻塞驱动——某个 analytics 大查询如果卡住，
// 会阻塞整个 Node.js 事件循环 → 所有新请求排队等待 = "页面无响应"
// 加超时让 Express 主动断连并返回 503（不是假死），前端能感知并重试
// ===========================================================
const REQ_TIMEOUT_MS = 30_000;  // 30s
app.use((req, res, next) => {
  res.setTimeout(REQ_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      console.error(`[timeout] ${req.method} ${req.originalUrl} 超过 ${REQ_TIMEOUT_MS}ms，强制断开`);
      res.status(503).json({ error: '服务暂时不可用（请求超时），请稍后重试' });
    }
    try { req.destroy(); } catch (e) { /* socket 可能已关闭 */ }
  });
  next();
});

// ===========================================================
// 【性能优化 4】进程级异常兜底（修复"偶发不可用"）
// SQLite / bcrypt / multer native 模块偶发 SIGSEGV 或 uncaughtException 会直接 kill 进程
// → 浏览器看起来"页面打不开、服务挂了"。
// 加兜底：uncaughtException / unhandledRejection 先打日志 + 尝试关 server 让端口释放，
// 然后 process.exit(1) 让上层（PM2 / WorkBuddy / systemd）自动重启。
// 生产环境建议：pm2 start src/server.js --watch 或 systemd auto-restart
// ===========================================================
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err.message);
  console.error(err.stack);
  try { server && server.close(() => process.exit(1)); } catch (e) { process.exit(1); }
  setTimeout(() => process.exit(1), 1000).unref();
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason?.message || reason);
  try { server && server.close(() => process.exit(1)); } catch (e) { process.exit(1); }
  setTimeout(() => process.exit(1), 1000).unref();
});

// SQLite 慢查询保护：给每个 SQLite 连接设 15s query_timeout
// 原生驱动用 db.exec('PRAGMA query_timeout = 15000')；wasm 驱动不支持但也无害
try { db.exec('PRAGMA query_timeout = 15000'); } catch (e) { /* wasm 不支持则忽略 */ }

// 仅当作为入口直接运行（node src/server.js）时才监听端口；
// 被 require 时仅导出 app（供测试/挂载复用，避免重复 listen）
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[light-erp] running on http://0.0.0.0:${PORT}`);
    console.log(`[perf] compression=on staticCache=24h+immutable apiCache=no-store reqTimeout=30s sqliteQueryTimeout=15s`);
    require('./services/backupScheduler').startBackupScheduler(db._path);
  });
}

module.exports = app;
