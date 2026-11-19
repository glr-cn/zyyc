// ============================================================================
//  构建版本号（永久规则 1 的核心：登录持久化 + 部署后提示刷新）
// ----------------------------------------------------------------------------
//  设计原则：
//    A. 版本号是「当前运行代码的身份标识」，每次发布必须不同，前端据此判断
//       是否需要刷新（用户正在用旧版 JS，新后端可能返回不兼容的数据格式）。
//    B. 版本号**不用于踢用户下线**——JWT token 有效期 12h，服务重启不影响，
//       部署完成后只弹「系统已更新，请刷新页面」，不强制重登。
//    C. 优先级链：
//       ① 根目录 version.json（build.sh 构建时写入）——最可靠，含 git short SHA + timestamp
//       ② BUILD_VERSION 环境变量（运维显式注入）
//       ③ 启动时间戳（兜底，每次重启变）
//    D. 对外暴露 3 个接口：
//       getBuildVersion() — 当前版本号字符串（所有路由用）
//       getBuildInfo()    — 完整信息对象（/api/version 接口用）
//       injectToJson(obj) — 在 JSON 响应里追加 _build_version 字段
// ============================================================================
const fs = require('fs');
const path = require('path');

let _cachedVersion = null;
let _cachedInfo = null;

function load() {
  if (_cachedVersion) return _cachedVersion;

  // ① build.sh 构建产物（dist/version.json）
  //    开发时源码根也可能有（git 提交前的本地测试用）
  const candidates = [
    path.join(__dirname, '..', 'version.json'),
    path.join(__dirname, '..', 'dist', 'version.json'),
  ];
  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, 'utf8');
        const j = JSON.parse(raw);
        if (j && j.build_version) {
          _cachedVersion = String(j.build_version);
          _cachedInfo = { build_version: _cachedVersion, build_time: j.build_time || null };
          return _cachedVersion;
        }
      }
    } catch (e) { /* 格式不对就跳过 */ }
  }

  // ② 环境变量（运维/CI 可注入）
  if (process.env.BUILD_VERSION) {
    _cachedVersion = String(process.env.BUILD_VERSION);
    _cachedInfo = { build_version: _cachedVersion, build_time: null };
    return _cachedVersion;
  }

  // ③ 兜底：进程启动时间戳（每次重启变，足以触发前端刷新提示）
  //    注意：不能用 Date.now() —— 每次调用都不同。用 START_TIME 常量。
  _cachedVersion = 'dev-' + process.env.START_TIME || 'dev';
  if (!process.env.START_TIME) {
    // 还没启动时，用当前时间戳（Node 22+ 有 process.hrtime.bigint()）
    _cachedVersion = 'dev-' + Date.now();
  }
  _cachedInfo = { build_version: _cachedVersion, build_time: null };
  return _cachedVersion;
}

function getBuildVersion() { return load(); }

function getBuildInfo() {
  load();
  return {
    build_version: _cachedVersion,
    build_time: _cachedInfo?.build_time || null,
    server_start_time: process.env.START_TIME || null,
  };
}

// 在 JSON 响应里追加 _build_version 字段
// 用法：res.json(injectToJson(myData))
function injectToJson(obj) {
  if (obj && typeof obj === 'object') {
    obj._build_version = getBuildVersion();
  }
  return obj;
}

module.exports = { getBuildVersion, getBuildInfo, injectToJson };
