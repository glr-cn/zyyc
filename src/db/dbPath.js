// ============================================================================
//  数据库路径解析 + 空库自动恢复（数据安全铁律的代码级落地）
// ----------------------------------------------------------------------------
//  铁律背景（2026-11-16 线上事故）：
//    线上业务数据在一次发布后全部消失，根因是——
//      ① 本地 data/erp.db 被测试脚本截断成 0 字节；
//      ② 发布包把「包内 data/erp.db」一起带上；
//      ③ 线上进程按包内路径打开库 → 拿到 0 字节文件 → 建成全新空库。
//    即：发布包内的任何数据库文件都可能覆盖线上真实数据。
//
//  本模块的三条硬约束：
//    A. 路径唯一：resolveDbPath() 是全项目唯一的数据库路径来源，
//       src/db/index.js 与 src/middleware/auth.js 都从这里取，杜绝两处各写一份。
//    B. 包外优先：部署环境的库一律落在「代码包之外」的持久目录
//       （os.homedir()/.wbapp-erp-data/erp.db），发布包内不得含任何 .db。
//    C. 空库自愈：启动时若检测到「库文件存在但业务表全空」，
//       自动从备份目录/历史快照中挑选最新的有效备份恢复，而不是直接建空表。
// ============================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');

// 业务表（用于「空库」判定与「备份有效性」判定）
const BUSINESS_TABLES = [
  'customers', 'orders', 'inventory_transactions', 'work_hours',
  'logistics_quotes', 'smart_quote_batches', 'smart_quote_records',
];

// 备份文件命名约定（发布前自检脚本与启动自愈共用）
const BACKUP_SUFFIXES = ['.bak-', '.backup-', '.pre-drop-', '.snapshot-', '.restore-'];

// ============================================================================
//  路径解析
// ============================================================================
// 容器 / 沙箱特征检测（独立函数，便于单测与后续扩展）
function isContainerEnv() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    if (fs.existsSync('/run/.containerenv')) return true;
    if (fs.existsSync('/proc/1/cgroup')) {
      const s = fs.readFileSync('/proc/1/cgroup', 'utf8');
      if (/docker|kubepods|containerd|podman|lxc/i.test(s)) return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

function isLocalDev(projectRoot) {
  // 【重要·事故教训】判据必须能区分「本地开发」与「部署沙箱」，
  // 且绝不能被「沙箱里也会 npm install 出 node_modules/.bin」误导。
  //
  //  2026-11-16 事故根因：旧判据是「存在 .git 或 node_modules/.bin 即本地开发」，
  //  沙箱 npm install 后 node_modules/.bin 必然存在 → 线上被判成「本地开发」
  //  → 库路径落回【代码包内】data/erp.db → 发布包里的 0 字节库被线上直接打开
  //  → 线上被重建成空库，真实数据（.wbapp-erp-data/erp.db）虽然还在，却不再被读取。
  //
  //  安全默认原则：判不出来时，一律按【部署环境】处理（库落包外持久目录）。
  //  宁可本地开发多设一个环境变量，也不能让线上再读包内文件。
  //
  //  判据（按可靠性排序）：
  //    1) ERP_LOCAL_DEV 环境变量显式指定（1=本地 / 0=部署），最高优先；
  //    2) ERP_SANDBOX=1 显式声明「当前是沙箱/部署环境」；
  //    3) 容器特征（/.dockerenv / /run/.containerenv / docker 系 cgroup）→ 部署环境；
  //       【必须排在 .git 之前】——部署工作区可能位于某个含 .git 的父目录下，
  //       若先命中 .git 就会把线上误判成本地开发，与事故属同类风险；
  //    4) 项目根或其上级存在 .git（本地仓库标记；部署工具明确排除 .git，不会带上去）；
  //    5) Windows / macOS 桌面开发机 → 本地开发；
  //    6) 其余（典型 Linux 沙箱）→ 部署环境。
  if (process.env.ERP_LOCAL_DEV === '1') return true;
  if (process.env.ERP_LOCAL_DEV === '0') return false;
  if (process.env.ERP_SANDBOX === '1') return false;

  // 3) 容器 / 沙箱特征（优先于 .git）
  if (isContainerEnv()) return false;

  // 4) 向上最多 3 层找 .git（本地仓库可能不在项目根，如 D:/数据中心网站/.git）
  let d = projectRoot;
  for (let i = 0; i < 3; i++) {
    try {
      if (fs.existsSync(path.join(d, '.git'))) return true;
    } catch (e) { /* ignore */ }
    const up = path.dirname(d);
    if (!up || up === d) break;
    d = up;
  }

  // 5) 桌面开发机
  if (process.platform === 'win32' || process.platform === 'darwin') return true;

  // 6) 安全默认：按部署环境处理
  return false;
}

function persistDir() {
  return path.join(os.homedir(), '.wbapp-erp-data');
}

/**
 * 解析数据库绝对路径。
 * 优先级：
 *   1) ERP_DB_PATH 环境变量（平台持久卷 / 运维显式指定）
 *   2) 本地开发（有 .git）→ <projectRoot>/data/erp.db
 *   3) 部署环境 → <homedir>/.wbapp-erp-data/erp.db（代码包之外，跨发布持久）
 */
function resolveDbPath(projectRoot) {
  if (process.env.ERP_DB_PATH) return process.env.ERP_DB_PATH;
  const root = projectRoot || path.join(__dirname, '..', '..');
  if (isLocalDev(root)) return path.join(root, 'data', 'erp.db');
  return path.join(persistDir(), 'erp.db');
}

/**
 * 列出「可用于恢复」的候选备份文件。
 *
 * ⚠️ 安全约束（极其重要）：
 *   自动恢复绝不能「随手挑一个同目录的 .db 覆盖线上」——
 *   那会把新数据回滚成旧数据，比空库更危险。
 *   因此候选来源严格分层：
 *     ① ERP_RESTORE_FROM 显式指定（人工确认，最高优先）
 *     ② 【专属快照目录】<库目录>/backups/ 下、且文件名前缀与当前库名一致的快照
 *        （这是本系统自己生成的、专属于该库的快照，不会串库）
 *     ③ 同目录带明确备份后缀的文件（*.bak-* / *.backup-* / *.snapshot-* / *.pre-drop-* / *.restore-*）
 *        —— 必须是「显式备份命名」，普通的 *.db 一律不算
 *   绝不扫描同目录下的任意 *.db 文件。
 *
 * 来源：
 *   - 持久目录及其 backups/ 子目录（线上运行期自动快照）
 *   - 持久目录同级的带后缀备份
 *   - 当前库同目录 + 其 backups/ 子目录
 */
function listRestoreCandidates(dbPath) {
  const out = [];
  const dbBase = path.basename(dbPath).replace(/\.(db|sqlite3?)$/i, '');

  const addFrom = (dir, opts = {}) => {
    if (!dir || !fs.existsSync(dir)) return;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (path.resolve(full) === path.resolve(dbPath)) continue;

      if (opts.snapshotOnly) {
        // 专属快照：文件名必须以「当前库名-」开头（例：erp-2026...db 对应 erp.db）
        if (!name.startsWith(dbBase + '-')) continue;
        if (!/\.(db|sqlite3?)$/i.test(name)) continue;
      } else if (opts.backupSuffixOnly) {
        // 仅接受「显式备份命名」的文件，普通 *.db 不算
        // 注意：备份文件名常带时间戳后缀（如 erp.db.bak-20261116），
        // 不能用「结尾扩展名」来判断，只需命中备份后缀即可。
        if (!BACKUP_SUFFIXES.some((s) => name.includes(s))) continue;
      } else {
        if (!/\.(db|sqlite3?)$/i.test(name)) continue;
      }
      out.push({ file: full, mtime: st.mtimeMs, size: st.size });
    }
  };

  // ① 显式指定（人工确认，最高优先）
  if (process.env.ERP_RESTORE_FROM) {
    const p = process.env.ERP_RESTORE_FROM;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) addFrom(p, { backupSuffixOnly: true });
      else out.push({ file: p, mtime: st.mtimeMs, size: st.size, explicit: true });
    } catch (e) { /* 指定路径不存在则忽略 */ }
  }

  // ② 持久目录（线上）：目录本身只认带备份后缀的文件；其 backups/ 只认专属快照
  const pd = persistDir();
  addFrom(pd, { backupSuffixOnly: true });
  addFrom(path.join(pd, 'backups'), { snapshotOnly: true });

  // ③ 当前库同目录：普通文件只认显式备份后缀；backups/ 只认专属快照
  const dbDir = path.dirname(dbPath);
  addFrom(dbDir, { backupSuffixOnly: true });
  addFrom(path.join(dbDir, 'backups'), { snapshotOnly: true });

  out.sort((a, b) => (b.explicit ? 1 : 0) - (a.explicit ? 1 : 0) || b.mtime - a.mtime);
  return out;
}

/**
 * 判断某个库文件是否「含有业务数据」（用于挑选有效备份）。
 * 只读打开；无法打开或业务表全空 → 视为无效备份。
 * 驱动走 src/db/driver.js，Node 20 下自动使用 wasm 版。
 */
function hasBusinessData(dbFile) {
  let db = null;
  try {
    const { openDatabase } = require('./driver');
    db = openDatabase(dbFile, { readOnly: true, fileMustExist: true });
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    let total = 0;
    for (const t of BUSINESS_TABLES) {
      if (!tables.has(t)) continue;
      try { total += db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { /* ignore */ }
    }
    return total;
  } catch (e) {
    return 0;
  } finally {
    try { if (db) db.close(); } catch (e) { /* ignore */ }
  }
}

/**
 * 判定「当前库是否为空库」（业务表全空 或 尚无任何表）。
 * 注意：事故现场的 0 字节文件属于「无表」情形，必须一并识别为待恢复状态。
 */
function isEmptyBusinessDb(dbPath, db) {
  let businessRows = 0;
  let tableCount = 0;
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    tableCount = tables.size;
    for (const t of BUSINESS_TABLES) {
      if (!tables.has(t)) continue;
      try { businessRows += db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { /* ignore */ }
    }
  } catch (e) {
    return { empty: true, rows: 0, tableCount: 0, error: e.message };
  }
  // 0 字节文件：node:sqlite 会把它当作空库，tableCount=0
  return { empty: businessRows === 0, rows: businessRows, tableCount };
}

/**
 * 查找「最佳恢复来源」：在候选备份中挑最新的、且确实含业务数据的那一个。
 * 只做判断与选择，不做任何文件写入（写操作由调用方在关闭连接后执行）。
 *
 * @returns {{file:string, rows:number, mtime:number}|null}
 */
function findRestoreCandidate(dbPath) {
  const candidates = listRestoreCandidates(dbPath);
  for (const c of candidates) {
    if (c.size <= 0) continue;
    const rows = hasBusinessData(c.file);
    if (rows <= 0) continue;
    return { file: c.file, rows, mtime: c.mtime };
  }
  return null;
}

/**
 * 空库自愈：若目标库「业务表全空」且找到了有效备份，则自动恢复。
 *
 * @param {string} dbPath   目标数据库路径
 * @param {object} db       已打开的数据库句柄（用于探测业务表行数）
 * @returns {{restored:boolean, from?:string, rows?:number, reason?:string}}
 */
function autoRestoreIfEmpty(dbPath, db) {
  const state = isEmptyBusinessDb(dbPath, db);
  if (!state.empty) return { restored: false, reason: `业务数据存在（${state.rows} 行），无需恢复` };

  const best = findRestoreCandidate(dbPath);
  if (!best) return { restored: false, reason: '未找到含业务数据的有效备份' };

  try {
    // 先把「当前空库」另存为 .empty-<ts>.db（不删除，留证据）
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const emptyCopy = `${dbPath}.empty-${ts}.db`;
    try { fs.copyFileSync(dbPath, emptyCopy); } catch (e) { /* ignore */ }

    // 用备份覆盖目标库
    fs.copyFileSync(best.file, dbPath);
    console.log(`[db-selfheal] 检测到空库，已从备份自动恢复：${best.file} → ${dbPath}（业务行数 ${best.rows}）`);
    return { restored: true, from: best.file, rows: best.rows };
  } catch (e) {
    console.warn('[db-selfheal] 从备份恢复失败：', best.file, e.message);
    return { restored: false, reason: '恢复写入失败：' + e.message };
  }
}

module.exports = {
  BUSINESS_TABLES,
  BACKUP_SUFFIXES,
  resolveDbPath,
  isLocalDev,
  isContainerEnv,
  persistDir,
  listRestoreCandidates,
  hasBusinessData,
  isEmptyBusinessDb,
  findRestoreCandidate,
  autoRestoreIfEmpty,
};
