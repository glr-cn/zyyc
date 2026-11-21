// JWT 鉴权中间件（RBAC：每次请求按 role_id 查库刷新角色字段，权限变更即时生效）
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 仅鉴权时按 role_id 补全角色字段（role_name/role_code/data_scope/is_readonly）。
//
// 【重要】数据库路径必须与 src/db/index.js 完全一致，否则会出现「鉴权读 A 库、业务读 B 库」
// 的数据分裂（线上曾因此查不到角色）。这里直接复用主业务连接：
//   - 单一连接：避免同一库文件另开连接（wasm 驱动下多连接互不可见，会读到旧角色）；
//   - 每次请求实时查询，角色/权限变更立即生效。
const db = require('../db');
function roleOf(roleId) {
  try {
    return db.prepare('SELECT role_id, role_code, role_name, data_scope, is_readonly FROM roles WHERE role_id=?').get(roleId) || null;
  } catch (e) {
    return null;
  }
}

// 兼容旧调用（测试脚本会在收尾时调用）：角色读取已复用主连接，无需单独释放
function closeRoleDb() { /* no-op */ }

// 安全加固（公网发布前置）：
//   1) 优先读环境变量 ERP_JWT_SECRET（发布/运维可显式注入）；
//   2) 否则读随源码一起发布的根目录 jwt.secret（不在 public/ 下，HTTP 不可访问）。
//      必须随包预置：沙箱可能按请求解压源码，若运行时才随机生成，多实例密钥不一致，
//      会出现「登录成功但后续所有请求 401」。
//   3) 【新增·2026-11-16】包内 jwt.secret 缺失或读不到时，改用「代码包之外的持久目录」
//      ~/.wbapp-erp-data/jwt.secret —— 与数据库同思路：落包外才能跨实例、跨发布保持一致。
//      线上实测症状：登录接口能签发 token，但后续业务请求一律 401「登录已过期」，
//      即签发与校验用了不同密钥（每实例随机）。持久目录可消除该分裂。
//   4) 全部不可用时才退回进程内随机值（极端只读文件系统）。
const SECRET_FILE = path.join(__dirname, '..', '..', 'jwt.secret');
function persistSecretFile() {
  // 与 dbPath.persistDir() 保持一致：包外持久目录
  const dir = path.join(require('os').homedir(), '.wbapp-erp-data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  return path.join(dir, 'jwt.secret');
}
let SECRET_SOURCE = 'random';
function resolveSecret() {
  if (process.env.ERP_JWT_SECRET) { SECRET_SOURCE = 'env'; return process.env.ERP_JWT_SECRET; }
  // 2) 包内预置密钥
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s) { SECRET_SOURCE = 'package'; return s; }
    }
  } catch (e) { /* 落到持久目录 */ }
  // 3) 包外持久目录（跨实例/跨发布一致）
  try {
    const pf = persistSecretFile();
    if (fs.existsSync(pf)) {
      const s = fs.readFileSync(pf, 'utf8').trim();
      if (s) { SECRET_SOURCE = 'persist'; return s; }
    }
    const gen = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(pf, gen, { mode: 0o600 });
    SECRET_SOURCE = 'persist';
    return gen;
  } catch (e) { /* 落到随机值 */ }
  // 4) 兜底：进程内随机（重启即失效，多实例必然不一致）
  SECRET_SOURCE = 'random';
  return crypto.randomBytes(48).toString('hex');
}
const SECRET = resolveSecret();

function auth(req, res, next) {
  // 托管平台网关会覆盖 Authorization 头（注入自身内部令牌），
  // 因此业务令牌优先走自定义头 X-ERP-Token；同时兼容本地开发与旧客户端。
  const custom = req.headers['x-erp-token'];
  const legacy = req.headers.authorization || '';
  let token = null;
  if (custom) {
    const c = String(custom);
    token = c.startsWith('Bearer ') ? c.slice(7) : c;
  } else if (legacy.startsWith('Bearer ')) {
    token = legacy.slice(7);
  }
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, SECRET);
    // 按 role_id 实时刷新角色字段：管理员改权限/改角色后无需用户重登
    const role = roleOf(payload.role_id);
    // ★ 修复 S10：角色被删/查库异常时原逻辑降级为 data_scope='all'+非只读，等于越权提权。
    //   改为直接拒绝令牌，要求重新登录，杜绝无角色令牌获得全局数据权限。
    if (!role) return res.status(401).json({ error: '角色不存在或已失效，请重新登录' });
    req.user = {
      user_id: payload.user_id,
      username: payload.username,
      display_name: payload.display_name,
      role_id: payload.role_id,
      role: role.role_name,
      role_code: role.role_code,
      data_scope: role.data_scope,
      is_readonly: role.is_readonly,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

module.exports = { auth, SECRET, closeRoleDb, secretSource: () => SECRET_SOURCE };
