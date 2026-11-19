// 统一日志工具：winston 结构化分级输出
// ──────────────────────────────────────────────────────────
// 开发环境：彩色控制台 + debug 级别（方便调试）
// 生产环境：info 级别 + 写文件（logs/app-%DATE%.log，按天轮转）
// 业务代码里这样用：
//   const logger = require('../utils/logger');
//   logger.info('用户登录', { userId: 5, ip: '1.2.3.4' });
//   logger.error('数据库查询失败', { error: err.message, sql: sql });
// ──────────────────────────────────────────────────────────
const winston = require('winston');
const path = require('path');
const fs = require('fs');

const IS_DEV = process.env.NODE_ENV === 'development';
// 部署沙箱中 __dirname 回溯两级会落到 /opt/bytefaas/logs（不可写），
// 统一用 TMPDIR 或 /tmp，既兼容本地（os.tmpdir 可用）又兼容云端。
const FALLBACK_TMP = process.env.TMPDIR || process.env.TMP || process.env.TEMP || require('os').tmpdir();
let LOG_DIR = path.join(FALLBACK_TMP, 'light-erp-logs');

// 生产环境才写文件（避免开发时产生一堆 log 文件）
if (!IS_DEV) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    // 再退一步：用系统临时目录兜底
    try {
      LOG_DIR = path.join(require('os').tmpdir(), 'light-erp-logs');
      fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (_) {
      // 实在写不了就算了，winston 文件 transport 会自动初始化失败并警告
    }
  }
}

const logger = winston.createLogger({
  level: IS_DEV ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'light-erp', env: IS_DEV ? 'dev' : 'prod' },
  transports: [
    // 所有级别 ≥ error 的始终写 error.log
    ...(!IS_DEV ? [new winston.transports.File({ filename: path.join(LOG_DIR, 'error.log'), level: 'error', maxsize: 5 * 1024 * 1024, maxFiles: 3 })] : []),
    // 所有级别 ≥ info 的写 combined.log
    ...(!IS_DEV ? [new winston.transports.File({ filename: path.join(LOG_DIR, 'combined.log'), maxsize: 5 * 1024 * 1024, maxFiles: 5 })] : []),
  ],
});

// 开发环境：带颜色的控制台输出
if (IS_DEV) {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `[${timestamp}] ${level}: ${message}${metaStr}`;
      })
    ),
  }));
}

module.exports = logger;
