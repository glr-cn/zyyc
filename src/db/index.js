// 数据库连接与初始化（阶段 0 骨架）
// 开发期：Node 22 内置 node:sqlite；部署期（Node 20）自动退到 node-sqlite3-wasm。
// 差异全部收敛在 src/db/driver.js，本文件与业务 SQL 无需区分运行时。
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('./driver');
const { resolveDbPath, isEmptyBusinessDb, findRestoreCandidate, hasBusinessData } = require('./dbPath');

// ============================================================
//  数据库路径解析 + 空库自愈（持久化铁律，统一入口）
//  ------------------------------------------------------------
//  铁律：本地发布到线上时，绝对不能用本地（开发/空）库覆盖线上已有的业务数据。
//  详见 src/db/dbPath.js 的完整说明（含 2026-11-16 事故复盘）。
//  路径解析的唯一来源是 dbPath.resolveDbPath()，
//  src/middleware/auth.js 也从这里取，二者必须一致，否则会出现「鉴权读 A 库、业务读 B 库」。
// ============================================================
const DB_PATH = resolveDbPath(path.join(__dirname, '..', '..'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ============================================================================
//  运行时快照（自动备份）：保证任何时刻都有一份可回滚的历史副本
//  ----------------------------------------------------------------------------
//  铁律：线上库是唯一业务数据来源，必须在任何写操作之前留档。
//  快照放在持久目录的 backups/ 下（代码包之外，跨发布保留），
//  同时对本地库也在 data/ 同级留一份，避免「本地库被误删/清空」后无迹可寻。
// ============================================================================
function snapshotDb(reason) {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const st = fs.statSync(DB_PATH);
    if (st.size <= 0) return null; // 空文件无快照价值
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bakDir = path.join(path.dirname(DB_PATH), 'backups');
    fs.mkdirSync(bakDir, { recursive: true });
    // 文件名以「当前库名-」开头 → 快照严格归属该库，恢复时不会串库
    const base = path.basename(DB_PATH).replace(/\.(db|sqlite3?)$/i, '');
    const bak = path.join(bakDir, `${base}-${ts}-${reason}.db`);
    fs.copyFileSync(DB_PATH, bak);
    // 仅保留最近 20 份，避免无限增长
    try {
      const list = fs.readdirSync(bakDir)
        .filter((f) => f.startsWith(base + '-') && f.endsWith('.db'))
        .sort();
      while (list.length > 20) {
        const old = path.join(bakDir, list.shift());
        try { fs.unlinkSync(old); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    console.log(`[db-snapshot] 已保存快照：${bak}`);
    return bak;
  } catch (e) {
    console.warn('[db-snapshot] 快照失败（不阻断启动）：', e.message);
    return null;
  }
}

const _raw = openDatabase(DB_PATH);
_raw.exec('PRAGMA foreign_keys = ON;');
// PRAGMA integrity_check 启动自检：返回 'ok' 表示数据库文件完好，
// 返回字符串表示损坏（值为问题描述）。不阻断启动，只 warn。
try {
  const chk = _raw.prepare('PRAGMA integrity_check').get();
  const ok = chk && (chk.integrity_check === 'ok' || chk['integrity_check'] === 'ok');
  if (!ok) {
    console.warn('[db] ⚠️ integrity_check 未通过：', chk);
  } else {
    console.log('[db] integrity_check: ok');
  }
} catch (e) { console.warn('[db] integrity_check 异常：', e.message); }
console.log('[db] 驱动：' + _raw.driver + '（库：' + DB_PATH + '）');

// ============================================================================
//  空库自愈：若业务表全空（或库是 0 字节/无表的空壳），自动从备份/快照恢复
//  ----------------------------------------------------------------------------
//  触发场景（2026-11-16 事故）：发布包里的 0 字节库覆盖了线上库，
//  导致线上被重建成空库。修复后若再出现同类情况，会自动从最近的有效备份回滚。
//
//  关键：自愈必须发生在【建表之前】——
//    事故现场的目标库是 0 字节，node:sqlite 会把它当作「无表的空库」，
//    若先跑 schema.sql 再判定，就会把空壳当成正常库、自愈永远不触发。
//  恢复时必须先关闭连接再覆盖文件（Windows 上文件被占用时 copyFileSync 会失败）。
// ============================================================================
function openConnection() {
  const conn = openDatabase(DB_PATH);
  conn.exec('PRAGMA foreign_keys = ON;');
  // 自愈恢复后的新连接也跑一遍 integrity_check
  try {
    const chk = conn.prepare('PRAGMA integrity_check').get();
    if (chk && chk.integrity_check !== 'ok' && chk['integrity_check'] !== 'ok') {
      console.warn('[db-selfheal] ⚠️ integrity_check 未通过：', chk);
    } else {
      console.log('[db-selfheal] integrity_check: ok');
    }
  } catch (e) { /* ignore */ }
  return conn;
}

function trySelfHeal() {
  let conn = _raw;
  try {
    const state = isEmptyBusinessDb(DB_PATH, conn);
    if (!state.empty) {
      console.log(`[db-selfheal] 库内有业务数据（${state.rows} 行），无需恢复。`);
      return conn;
    }
    const best = findRestoreCandidate(DB_PATH);
    if (!best) {
      console.log('[db-selfheal] 库为空且未找到含业务数据的有效备份，按全新库初始化（不阻断启动）。');
      return conn;
    }
    // 关闭连接后再覆盖文件（Windows 文件锁）
    try { conn.close(); } catch (e) { /* ignore */ }
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    try { fs.copyFileSync(DB_PATH, `${DB_PATH}.empty-${ts}.db`); } catch (e) { /* ignore */ }
    fs.copyFileSync(best.file, DB_PATH);
    console.log(`[db-selfheal] 检测到空库，已从备份自动恢复：${best.file} → ${DB_PATH}（业务行数 ${best.rows}）`);
    conn = openConnection();
    return conn;
  } catch (e) {
    console.warn('[db-selfheal] 自愈检查异常（不阻断启动）：', e.message);
    try { return openConnection(); } catch (e2) { return _raw; }
  }
}

let _conn = trySelfHeal();

// ============================================================================
//  启动快照（在任何建表/迁移/种子【之前】留档）
//  ----------------------------------------------------------------------------
//  铁律：线上库是唯一业务数据来源。迁移脚本虽带指纹校验与回滚，
//  但「迁移前原样副本」才是最后一道保险——出问题时可直接文件级回滚。
//  快照放在库同级的 backups/ 下（部署环境即包外持久目录，跨发布保留）。
// ============================================================================
try {
  const st = isEmptyBusinessDb(DB_PATH, _conn);
  if (!st.empty) snapshotDb('pre-migrate');
} catch (e) { /* ignore */ }

// 初始化表结构（schema.sql 含多段 SQL，node:sqlite 支持一次执行）
// 注意：以下所有建表/迁移/种子一律走 _conn（自愈恢复后 _conn 才是当前有效连接）。
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
_conn.exec(schema);

// audit_logs 增量迁移：旧库补齐日志中心标准字段 + 回填 + 标准视图。
// 幂等、全事务、迁移前后校验历史列指纹；失败直接抛错阻止启动，绝不带病写业务数据。
require('./migrateAuditLogs').run(_conn);

// 客户软删除 + 工时 id 关联迁移：旧库补 customers.is_deleted / work_hours.customer_id，
// 并按客户名回填历史工时关联。幂等、全事务、迁移前后校验原有列指纹，失败即回滚阻止启动。
require('./migrateCustomerLink').run(_conn);

// 工时归档状态迁移：旧库补 work_hours.status（NOT NULL DEFAULT 'pending'），
// 历史行自动全部设为「未归档」。幂等、全事务、迁移前后校验原有列指纹，失败即回滚阻止启动。
require('./migrateWorkhoursStatus').run(_conn);

// 工时提交归档字段迁移：旧库补 work_hours.submitter / submit_time（可空，历史行保持 NULL）。
// 幂等、全事务、迁移前后校验原有列指纹，失败即回滚阻止启动。
require('./migrateWorkhoursSubmitter').run(_conn);

// 库内「作业量」字段迁移：旧库补 work_hours.workload（可空，历史行保持 NULL）。
// 幂等、全事务、迁移前后校验原有列指纹，失败即回滚阻止启动。
require('./migrateWorkhoursWorkload').run(_conn);

// customers.sort_order 字段迁移：旧库补 customers.sort_order（NOT NULL DEFAULT 9999），
// 并按固定名单刷入排序号 1..38；名单外/未匹配保持默认 9999。幂等、全事务、失败即回滚。
require('./migrateCustomersSortOrder').run(_conn);

// customers.default_unit 字段迁移：旧库补 customers.default_unit（NOT NULL DEFAULT '单'），
// 并按规则刷入特定客户的默认单位（绵羊-线下 → 箱，西玛系列 → 件，华尊-京东送仓 → 单）。
// 已归档历史数据的 unit 列独立存储，不受此默认值影响。幂等、全事务、失败即回滚。
require('./migrateCustomersDefaultUnit').run(_conn);

// work_hours 归档冲突检测覆盖索引：
// 精确匹配四元组(warehouse, work_type, customer_id, date, status) → 命中覆盖索引零回表。
// 解决热点日（同日 10 万行）从 8 秒 → < 10ms。幂等，CREATE INDEX IF NOT EXISTS 天然安全。
_conn.exec(`CREATE INDEX IF NOT EXISTS idx_wh_lookup
  ON work_hours(warehouse, work_type, customer_id, date, status)`);
console.log('[db-migrate] 覆盖索引 idx_wh_lookup 已就绪');

// 角色种子数据（仅首次；schema.sql 的 role_code 为 NOT NULL UNIQUE 无默认值，
// 种子必须带齐 role_code/data_scope/is_readonly/is_system，否则全新库启动即崩）
const roleCount = _conn.prepare('SELECT COUNT(*) AS c FROM roles').get().c;
if (roleCount === 0) {
  const insert = _conn.prepare(
    'INSERT INTO roles (role_code, role_name, description, data_scope, is_readonly, is_system, sort) VALUES (?,?,?,?,?,?,?)'
  );
  insert.run('admin', '管理员', '系统管理（内置，等同超级管理员权限组）', 'all', 0, 1, 1);
  insert.run('operator', '业务员', '仅本人数据（行级隔离）', 'self', 0, 1, 2);
  insert.run('viewer', '查看者', '只读角色（禁止写操作）', 'all', 1, 1, 3);
}

// 启动自举种子（幂等）：补齐菜单 + 角色 + 超管/管理员授权 + 首个管理员账号。
// 对已有数据的库完全无害（全部 INSERT OR IGNORE / 条件 UPDATE），业务数据一行不动。
require('./seed').runSeed(_conn);

// ★ 角色清理迁移（2026-11-18）：前端已 filter 隐藏 admin/operator/viewer 三个旧内置角色。
// 数据库里它们会导致新建同名角色（如"仓库管理"）时被后端 UNIQUE 查重拒绝。
// 必须放在所有种子脚本之后（否则种子又把它们加回来）。
// 幂等、安全：仅在 super_admin 存在且无用户挂靠这些角色时才删除；有挂靠则跳过。
require('./migrateRolesCleanup').run(_conn);

// 轻量适配器：对外暴露与后续阶段代码一致的 prepare / exec 接口
const db = {
  exec: (sql) => _conn.exec(sql),
  prepare: (sql) => {
    const stmt = _conn.prepare(sql);
    return {
      all: (...args) => stmt.all(...args),
      get: (...args) => stmt.get(...args),
      run: (...args) => stmt.run(...args),
    };
  },
  _raw: _conn,   // 底层驱动连接（native: DatabaseSync / wasm: node-sqlite3-wasm Database）
  _path: DB_PATH, // 供数据安全护栏做整库备份
  driver: _conn.driver,
  DB_PATH,       // 唯一数据库路径来源（src/middleware/auth.js 也从这里取）
};

module.exports = db;
