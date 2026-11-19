// 数据库连接与初始化（阶段 0 骨架）
// 开发期：Node 22 内置 node:sqlite；部署期（Node 20）自动退到 node-sqlite3-wasm。
// 差异全部收敛在 src/db/driver.js，本文件与业务 SQL 无需区分运行时。
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('./driver');
const { resolveDbPath, isEmptyBusinessDb, findRestoreCandidate } = require('./dbPath');

const DB_PATH = resolveDbPath(path.join(__dirname, '..', '..'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function snapshotDb(reason) {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const st = fs.statSync(DB_PATH);
    if (st.size <= 0) return null;
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bakDir = path.join(path.dirname(DB_PATH), 'backups');
    fs.mkdirSync(bakDir, { recursive: true });
    const base = path.basename(DB_PATH).replace(/\.(db|sqlite3?)$/i, '');
    const bak = path.join(bakDir, `${base}-${ts}-${reason}.db`);
    fs.copyFileSync(DB_PATH, bak);
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
try {
  const chk = _raw.prepare('PRAGMA integrity_check').get();
  const ok = chk && (chk.integrity_check === 'ok' || chk['integrity_check'] === 'ok');
  if (!ok) console.warn('[db] ⚠️ integrity_check 未通过：', chk);
  else console.log('[db] integrity_check: ok');
} catch (e) { console.warn('[db] integrity_check 异常：', e.message); }
console.log('[db] 驱动：' + _raw.driver + '（库：' + DB_PATH + '）');

function openConnection() {
  const conn = openDatabase(DB_PATH);
  conn.exec('PRAGMA foreign_keys = ON;');
  try {
    const chk = conn.prepare('PRAGMA integrity_check').get();
    if (chk && chk.integrity_check !== 'ok' && chk['integrity_check'] !== 'ok') {
      console.warn('[db-selfheal] ⚠️ integrity_check 未通过：', chk);
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

// 启动快照（在任何建表/迁移之前留档）
try {
  const st = isEmptyBusinessDb(DB_PATH, _conn);
  if (!st.empty) snapshotDb('pre-migrate');
} catch (e) { /* ignore */ }

// ============================================================================
//  schema.sql 必须同步执行（< 1 秒）——业务路由的 SQL 依赖这些基本表结构
// ============================================================================
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
_conn.exec(schema);

// ============================================================================
//  迁移脚本（15+ 个，WASM 驱动下 10-25 秒）
//  ★ 异步执行：server.listen() 之后再跑，避免超过 TraeSite 30 秒启动超时
// ============================================================================
function runMigrations() {
  const c = _conn;
  try {
    require('./migrateAuditLogs').run(c);
    require('./migrateCustomerLink').run(c);
    require('./migrateWorkhoursStatus').run(c);
    require('./migrateWorkhoursSubmitter').run(c);
    require('./migrateWorkhoursWorkload').run(c);
    require('./migrateCustomersSortOrder').run(c);
    require('./migrateCustomersDefaultUnit').run(c);
    require('./migrateCustomersRemoveUnique').run(c, { verbose: true });
    require('./migrateWscRemoveFk').run(c, { verbose: true });
    require('./migrateRemoveStockMenus').run(c, { verbose: true });
    require('./migrateOrdersRegion').run(c, { verbose: true });
    require('./migrateOrdersRemoveFk').run(c, { verbose: true });
    require('./migrateInvRemoveFk').run(c, { verbose: true });
    c.exec(`CREATE INDEX IF NOT EXISTS idx_wh_lookup ON work_hours(warehouse, work_type, customer_id, date, status)`);
    console.log('[db-migrate] 覆盖索引 idx_wh_lookup 已就绪');

    // 角色种子（仅首次）
    const roleCount = c.prepare('SELECT COUNT(*) AS c FROM roles').get().c;
    if (roleCount === 0) {
      const insert = c.prepare('INSERT INTO roles (role_code, role_name, description, data_scope, is_readonly, is_system, sort) VALUES (?,?,?,?,?,?,?)');
      insert.run('admin', '管理员', '系统管理', 'all', 0, 1, 1);
      insert.run('operator', '业务员', '仅本人数据', 'self', 0, 1, 2);
      insert.run('viewer', '查看者', '只读角色', 'all', 1, 1, 3);
    }

    // 自举种子 + 菜单迁移
    require('./seed').runSeed(c);
    require('./migrateDashboardSubmenus').run(c, { verbose: true });
    require('./migrateAddOrderMenus').run(c, { verbose: true });

    // customers 异常预警
    try {
      const custCount = c.prepare('SELECT COUNT(*) c FROM customers').get().c;
      const whCount = c.prepare('SELECT COUNT(*) c FROM work_hours').get().c;
      const ordCount = c.prepare('SELECT COUNT(*) c FROM orders').get().c;
      if (custCount === 0 && (whCount > 0 || ordCount > 0)) {
        console.warn(`[db-warn] ⚠️⚠️⚠️  customers 表为空，但 work_hours(${whCount})/orders(${ordCount}) 有数据！`);
      }
    } catch (e) { /* ignore */ }

    require('./migrateRolesCleanup').run(c);
    console.log('[db-migrate] ✅ 全部迁移完成');
  } catch (e) {
    console.error('[db-migrate] ❌ 迁移失败：', e.message);
    console.error(e.stack);
  }
}

const db = {
  exec: (sql) => _conn.exec(sql),
  prepare: (sql) => {
    const stmt = _conn.prepare(sql);
    return { all: (...args) => stmt.all(...args), get: (...args) => stmt.get(...args), run: (...args) => stmt.run(...args) };
  },
  runMigrations,
  _raw: _conn,
  _path: DB_PATH,
  driver: _conn.driver,
  DB_PATH,
};

module.exports = db;
