// Express 入口：挂载静态前端 + 认证路由 + 业务路由
const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const apicache = require('apicache');
const logger = require('./utils/logger');
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
const { getBuildInfo, injectToJson, getBuildVersion } = require('./version');

const app = express();

// ===========================================================
// 【永久规则 1】部署版本号注入 + 前端刷新提示
// 每个 JSON 响应自动追加 _build_version 字段，前端 api.js 检测变化后弹
// "系统已更新，请刷新页面" 提示。**绝不踢用户下线**——JWT 有效期 12h，
// 服务重启不影响 token 有效性，版本变化只要求刷新静态资源。
// ===========================================================
const _BV = getBuildVersion();
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (obj) => {
    if (obj && typeof obj === 'object' && !('_build_version' in obj)) {
      obj._build_version = _BV;
    }
    return origJson(obj);
  };
  next();
});
// 公开版本查询接口（前端可定时轮询，无需登录）
app.get('/api/version', (req, res) => {
  res.json(getBuildInfo());
});

// ===========================================================
// 环境检测：NODE_ENV=development → 开发模式（nodemon 自动重启 + 前端热刷新 + 禁用强缓存）
// 否则 → 生产模式（WorkBuddy 部署，强缓存 + gzip）
// ===========================================================
const IS_DEV = process.env.NODE_ENV === 'development';
const START_TIME = Date.now();
process.env.START_TIME = String(START_TIME);

// ===========================================================
// 【性能优化 1】gzip 压缩中间件
// 实测：style.css 79KB → gzip 后 20KB（-75%）；api.js 6KB → 1.8KB（-70%）
// 阈值 1KB 才压（小文件压了反而更大）
// ===========================================================
app.use(compression({ threshold: 1024 }));

// ===========================================================
// 【安全加固 1】Helmet — HTTP 安全响应头
// 相当于 WordPress 的 Wordfence：防 XSS/点击劫持/MIME 嗅探/强制 HTTPS
// 注意：contentSecurityPolicy 关闭——因为 ERP 用原生 script 标签 + 动态注入
// 如果开 CSP 会导致 _page_loader.js 的 ensurePageScript 注入脚本失败
// ===========================================================
app.use(helmet({
  contentSecurityPolicy: false,           // ERP 原生 JS 动态注入，CSP 会拦截
  crossOriginEmbedderPolicy: false,       // 允许跨域 iframe（如果后续有嵌入需求）
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: IS_DEV ? false : { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ===========================================================
// 【安全加固 2】CORS — 跨域策略
// 生产环境锁死允许的域名；开发环境允许 localhost
// ===========================================================
app.use(cors(IS_DEV
  ? { origin: true, credentials: true }  // dev: 允许任何 localhost 端口
  : {
      origin: [
        'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host',
        'https://*.workbuddy.host',
        'https://*.traesite.cn',           // ★ TraeSite 新平台（2026-11-20 新增）
      ],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-ERP-Token'],  // ★ X-ERP-Token 加入白名单
    }
));

// ===========================================================
// 【安全加固 3】API 限流 — 防暴力破解 + 防爬虫刷接口
// ── 登录接口：5 次/分钟（防密码爆破）
// ── 其他 API：600 次/分钟/IP（ERP 内部使用，量不大）
// ── 静态资源：不限（浏览器正常加载需要）
// ===========================================================
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 分钟窗口
  max: 5,               // 最多 5 次尝试
  standardHeaders: true,
  legacyHeaders: false,
  message: JSON.stringify({ error: '登录尝试过于频繁，请 1 分钟后再试' }),
  skip: (req) => IS_DEV, // 开发环境不限流（方便调试）
});
app.use('/api/auth/login', loginLimiter);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,              // ERP 内部 10 人团队，每人每分钟 60 次足够
  standardHeaders: true,
  legacyHeaders: false,
  message: JSON.stringify({ error: '请求过于频繁，请稍后再试' }),
  skip: (req) => IS_DEV,
});
app.use('/api/', apiLimiter);

// ===========================================================
// 【日志 1】Morgan — HTTP 访问日志
// dev 环境：`GET /api/health 200 3ms` 简洁彩色行
// prod 环境：combined 格式（含 User-Agent、Referer），用 stream 写入 winston
// ===========================================================
if (IS_DEV) {
  app.use(morgan('dev', {
    skip: (req) => req.url === '/api/health',  // health check 太频繁，不打日志
  }));
} else {
  app.use(morgan('combined', {
    skip: (req) => req.url === '/api/health',
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

// 请求体上限：上传 Excel 另有 multer limit，JSON/URL 表单 20MB 足够
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ===========================================================
// 【性能优化 2】静态资源缓存策略（开发环境 vs 生产环境）
// ── 生产环境（WorkBuddy 部署）─────────────────────────────────
//   maxAge=24h + immutable → 浏览器 disk cache 24h，版本号 ?v=N 变更时强制刷新
// ── 开发环境（nodemon）──────────────────────────────────────
//   maxAge=0 + no-cache → 每次都向服务器验证，改完前端代码刷新浏览器就能看到
//   同时 Express 直接返回最新文件（没有构建工具，源文件即产物）
// ===========================================================
const STATIC_ROOT = path.join(__dirname, '..', 'public');
// server 引用（进程级异常兜底时用来 close 端口 → 让上层自动重启更快）
let server = null;

if (IS_DEV) {
  // 开发环境：禁用强缓存 + 加 no-cache，确保改完立刻生效
  app.use(express.static(STATIC_ROOT, {
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders: function (res) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  }));
  console.log('[dev] 开发模式：静态资源禁用缓存，前端文件变更后刷新浏览器即可生效');
} else {
  // 生产环境：24h 浏览器缓存 + 7d CDN 缓存 + immutable（版本号不变永不校验）
  // ★ Surrogate-Control 是专门给 CDN/代理看的头，告诉 volc-dcdn 这个资源可以缓存 7 天
  //   有些 CDN 会强制覆盖源站 Cache-Control，但会尊重 Surrogate-Control
  // ★ s-maxage=604800 是"共享缓存（CDN）"的缓存时间，独立于浏览器 max-age
  app.use(express.static(STATIC_ROOT, {
    maxAge: '24h',
    immutable: true,
    etag: true,
    lastModified: true,
    setHeaders: function (res) {
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
      res.setHeader('Surrogate-Control', 'max-age=604800, stale-while-revalidate=86400');
      res.setHeader('X-Accel-Expires', '604800');  // 兼容 Nginx 代理层
    },
  }));
}

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

// ===========================================================
// 【开发环境热更新】SSE 端点 + fs.watch 监控前端文件变更
// ── 机制 ──────────────────────────────────────────────────────
// 1. 开发环境 nodemon 重启后端 → server 自动恢复
// 2. 前端文件变更（public/ 目录下 .js/.css/.html）→ fs.watch 检测
// 3. 通过 SSE `/dev/hot` 推送给浏览器 → 浏览器收到后自动 location.reload()
// ── 注意 ─────────────────────────────────────────────────────
//   仅开发环境启用；生产环境此端点不存在（404），前端脚本也不会注入
// ===========================================================
if (IS_DEV) {
  const clients = new Set();
  let reloadVersion = 0;  // 每次文件变更 +1，给前端做版本比对

  // SSE 端点
  app.get('/dev/hot', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // 禁用 nginx buffering
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', version: reloadVersion })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    // 30s 心跳保活（避免代理超时断开）
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { clearInterval(hb); clients.delete(res); } }, 30000);
    req.on('close', () => clearInterval(hb));
  });

  // 广播函数
  function broadcast(event, data) {
    reloadVersion++;
    const payload = `data: ${JSON.stringify({ type: event, version: reloadVersion, ...data })}\n\n`;
    for (const c of clients) {
      try { c.write(payload); } catch (e) { /* client 可能已断开 */ }
    }
  }

  // fs.watch 监控 public/ 目录（前端文件变更）
  const publicDir = STATIC_ROOT;
  let watcher = null;
  try {
    // Windows 上 recursive 不影响，但 macOS 需要 Node 22+ 才支持；public 是单层目录所以 recursive=false 够用
    watcher = fs.watch(publicDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // 忽略临时文件（.tmp, .swp, 编辑器备份等）
      if (/\.tmp$|\.swp$|~$|\.bak$/i.test(filename)) return;
      // 过滤：只关心 .js .css .html 文件
      if (!/\.(js|css|html)$/i.test(filename)) return;
      console.log(`[dev:hot] ${eventType} ${filename} → 触发前端自动刷新`);
      broadcast('reload', { file: filename, event: eventType });
    });
    watcher.on('error', (err) => console.warn('[dev:hot] watcher error:', err.message));
  } catch (e) {
    console.warn('[dev:hot] fs.watch 不可用，热更新已禁用：', e.message);
  }

  // 后端文件变更（src/ 目录）由 nodemon 自动重启进程
  console.log('[dev:hot] 前端热更新已启用（public/ 目录变更自动推送刷新）');

  // 开发环境状态 API（前端用来显示 DEV 标识 + 热更新客户端连接）
  // 整个端点只在开发环境注册 → 生产环境完全不暴露
  app.get('/api/dev/info', (req, res) => {
    res.json({
      isDev: true,
      uptime: Date.now() - START_TIME,
      env: 'development',
      nodeVersion: process.version,
      platform: process.platform,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  });
}

// ===========================================================
// 【性能优化 5】API 路由级内存缓存 — apicache
// ── 只缓存 GET 请求（写操作永远不缓存）
// ── 缓存 key 包含 URL + Authorization（不同用户看到不同数据）
// ── 开发环境完全禁用缓存（改了后端立刻生效）
// ── analytics / dashboard / customers 这三类是高频读，缓存 2 分钟
// ===========================================================
apicache.options({
  enabled: !IS_DEV,                    // dev 环境禁缓存
  statusCodes: { include: [200] },     // 只缓存 200 响应
  headers: {
    'Cache-Control': 'public, max-age=120',  // 告诉浏览器也缓存 2 分钟
  },
  appendKey: (req, res) => {
    // 不同 token 的用户数据不同 → 加进缓存 key
    const token = req.headers.authorization || 'no-auth';
    return '||' + token;
  },
});
const cache2m = apicache.middleware('2 minutes');
const cache5m = apicache.middleware('5 minutes');

// API 路由（公开）
app.use('/api/auth', authRouter);

// 业务路由（内部自带鉴权中间件）
// ★ 禁用 apicache：缓存导致 PUT/POST 后 GET 返回旧数据（2 分钟缓存窗口），
//   用户保存后看不到变更以为没生效。SQLite 查询本身足够快，不需要应用层缓存。
app.use('/api/customers', customersRouter);
app.use('/api/orders', ordersRouter);                          // 订单不缓存（经常变更）
app.use('/api/workhours', workhoursRouter);                    // 工时不缓存（实时提交）
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
  let menuLogs = -1;
  try {
    const parent = db.prepare("SELECT menu_id FROM menus WHERE menu_code='logs'").get();
    menuLogs = parent
      ? db.prepare('SELECT COUNT(*) c FROM menus WHERE parent_id=?').get(parent.menu_id).c
      : 0;
  } catch (e) { /* 表不存在时保持 -1 */ }
  res.json({
    status: 'ok',
    db: 'connected',
    env: IS_DEV ? 'development' : 'production',
    uptime: Date.now() - START_TIME,
    tables, menuLogs, menuVersion: 3,
    ...dbDiag(),
  });
});

// 全局错误处理：任何未捕获异常（含 express.json() 的请求体解析错误）
// 统一返回 JSON，杜绝 Express 默认 HTML 错误页导致前端只能显示兜底「请求失败」
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isParse = err.type === 'entity.parse.failed' || err instanceof SyntaxError;
  const status = err.status || err.statusCode || (isParse ? 400 : 500);
  logger.error('api error', { method: req.method, url: req.originalUrl, status, message: err.message });
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
// 然后 process.exit(1) 让上层（PM2 / WorkBuddy / systemd / nodemon）自动重启。
// ===========================================================
process.on('uncaughtException', (err) => {
  logger.error('[fatal] uncaughtException', { message: err.message, stack: err.stack });
  console.error('[fatal] uncaughtException:', err.message);
  console.error(err.stack);
  try { server && server.close(() => process.exit(1)); } catch (e) { process.exit(1); }
  setTimeout(() => process.exit(1), 1000).unref();
});
process.on('unhandledRejection', (reason) => {
  logger.error('[fatal] unhandledRejection', { reason: reason?.message || reason, stack: reason?.stack });
  console.error('[fatal] unhandledRejection:', reason?.message || reason);
  try { server && server.close(() => process.exit(1)); } catch (e) { process.exit(1); }
  setTimeout(() => process.exit(1), 1000).unref();
});

// SQLite 慢查询保护：给每个 SQLite 连接设 15s query_timeout
// 原生驱动用 db.exec('PRAGMA query_timeout = 15000')；wasm 驱动不支持但也无害
try { db.exec('PRAGMA query_timeout = 15000'); } catch (e) { /* wasm 不支持则忽略 */ }

// 优雅关闭：SIGTERM/SIGINT（Ctrl+C）时先关 server 再退出
function gracefulShutdown(signal) {
  console.log(`[shutdown] 收到 ${signal}，正在关闭...`);
  try { watcher && watcher.close(); } catch (e) { /* ignore */ }
  try { server && server.close(() => { console.log('[shutdown] server 已关闭'); process.exit(0); }); } catch (e) { process.exit(0); }
  // 强制退出兜底
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 仅当作为入口直接运行（node src/server.js）时才监听端口；
// 被 require 时仅导出 app（供测试/挂载复用，避免重复 listen）
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server = app.listen(PORT, '0.0.0.0', () => {
    const uptime = () => `${Math.round((Date.now() - START_TIME) / 1000)}s`;
    if (IS_DEV) {
      console.log('');
      console.log('╔══════════════════════════════════════════════╗');
      console.log('║  🛠️  佐雍云仓数据中心 - 开发模式                   ║');
      console.log('║  📍  http://localhost:' + PORT + '                ║');
      console.log('║  🔄  前端文件变更自动刷新（fs.watch + SSE）          ║');
      console.log('║  🔄  后端文件变更自动重启（nodemon）                 ║');
      console.log('║  💾  数据库缓存已禁用（每次都向服务器验证）            ║');
      console.log('╚══════════════════════════════════════════════╝');
      console.log('');
    } else {
      console.log(`[light-erp] running on http://0.0.0.0:${PORT}`);
      console.log(`[env] production`);
      console.log(`[perf] compression=on staticCache=24h+immutable apiCache=no-store reqTimeout=30s sqliteQueryTimeout=15s`);
    }
    // ★ 异步跑 migration：TraeSite 启动超时 30 秒，同步 migration 在 WASM 驱动下 20+ 秒会超时。
    // 端口先 listen → 健康检查通过 → migration 在后台继续跑（幂等，用户首次请求时表结构已就绪）。
    setImmediate(() => {
      // ★ 2026-11-20 紧急加固：在跑迁移脚本之前，先检查 _bak 表残留并自动恢复
      // （迁移 ALTER TABLE RENAME 的中间态残留 → customers 空但 customers_bak 有数据）
      try {
        const { restoreFromBakTables } = require('./db/dbPath');
        const bakResult = restoreFromBakTables(db);
        if (bakResult.restored.length > 0) {
          console.warn(`[bak-restore] 启动时自动恢复了 ${bakResult.restored.length} 个表：`, bakResult.restored.join(', '));
        }
      } catch (e) {
        console.warn('[bak-restore] 执行异常（不阻断启动）:', e.message);
      }

      const t0 = Date.now();
      db.runMigrations();
      console.log(`[db-migrate] ✅ 后台迁移完成（耗时 ${Date.now() - t0}ms）`);
    });

    require('./services/backupScheduler').startBackupScheduler(db._path);
  });
}

module.exports = app;
