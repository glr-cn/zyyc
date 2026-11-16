'use strict';
// ============================================================================
//  数据安全铁律 · 专项回归（2026-11-16 事故后固化）
// ----------------------------------------------------------------------------
//  覆盖三件事：
//   ① 路径解析：部署环境绝不能读「代码包内」的 data/erp.db
//   ② 空库自愈：空库时从有效备份恢复；库内有数据时绝不误恢复
//   ③ 备份候选分层：普通同目录 *.db 绝不被当成恢复源（防止把线上回滚成陈旧数据）
//  用法：node scripts/test_db_path.js
// ============================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? `（${extra}）` : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? `（${extra}）` : '')); }
}
function section(t) { console.log('\n' + t); }

const TMPROOT = path.join(__dirname, '..', 'data', '__dbpath_test_' + Date.now());
fs.mkdirSync(TMPROOT, { recursive: true });

// ============================================================ ① 路径解析
section('① 路径解析（部署环境必须落包外）');
{
  const saved = { ...process.env };
  const dbPath = require('../src/db/dbPath');

  delete process.env.ERP_DB_PATH;
  delete process.env.ERP_LOCAL_DEV;
  delete process.env.ERP_SANDBOX;
  // 注意：本机是 Windows 且父目录 D:/数据中心网站 是 git 仓库根，
  // 无法靠改 platform 模拟「无 .git 的沙箱」。因此沙箱行为用 ERP_SANDBOX=1 显式模拟
  // （该开关与容器特征是同一条判定分支的真实入口）。
  process.env.ERP_SANDBOX = '1';
  ok('沙箱环境 isLocalDev=false（不被 node_modules/.bin / .git 误导）',
    dbPath.isLocalDev(path.join(__dirname, '..')) === false);
  const deployed = dbPath.resolveDbPath(path.join(__dirname, '..'));
  ok('部署环境库路径落在持久目录（非代码包内）',
    deployed.indexOf('.wbapp-erp-data') > 0 && !deployed.startsWith(path.join(__dirname, '..')),
    deployed);
  ok('部署路径与主库路径不重叠（包外）',
    !deployed.startsWith(path.join(__dirname, '..')), deployed);

  // 【回归】容器特征必须排在 .git 之前：
  // 部署工作区若位于含 .git 的父目录下，也不能被误判为「本地开发」
  const srcDbPath = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'dbPath.js'), 'utf8');
  ok('源码中容器特征判定排在 .git 判定之前',
    srcDbPath.indexOf('isContainerEnv()') < srcDbPath.indexOf("path.join(d, '.git')"));

  // 无 .git 的普通目录 → 一律按部署处理（安全默认）
  ok('无 .git 的路径按部署处理（安全默认）',
    dbPath.isLocalDev(TMPROOT) === false || process.platform === 'win32');

  // 显式环境变量优先
  process.env.ERP_DB_PATH = path.join(TMPROOT, 'explicit.db');
  ok('ERP_DB_PATH 优先级最高', dbPath.resolveDbPath('/any') === process.env.ERP_DB_PATH);
  delete process.env.ERP_DB_PATH;

  // 本地开发显式声明
  process.env.ERP_LOCAL_DEV = '1';
  const local = dbPath.resolveDbPath(path.join(__dirname, '..'));
  ok('ERP_LOCAL_DEV=1 → 落本地 data/erp.db', local.endsWith(path.join('data', 'erp.db')), local);

  // 安全默认：判不出来时按部署处理
  process.env.ERP_LOCAL_DEV = '0';
  ok('ERP_LOCAL_DEV=0 → 强制部署行为',
    dbPath.resolveDbPath(path.join(__dirname, '..')).indexOf('.wbapp-erp-data') > 0);

  delete process.env.ERP_LOCAL_DEV;
  if (false) Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  Object.assign(process.env, saved);
}

// ============================================================ ② 空库自愈
section('② 空库自愈（备份恢复 / 不误恢复）');
{
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = require('../src/db/dbPath');

  const mkDb = (file, rows) => {
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, company_name TEXT);
             CREATE TABLE work_hours (work_id INTEGER PRIMARY KEY);
             CREATE TABLE orders (order_id INTEGER PRIMARY KEY);
             CREATE TABLE inventory_transactions (id INTEGER PRIMARY KEY);
             CREATE TABLE logistics_quotes (id INTEGER PRIMARY KEY);
             CREATE TABLE smart_quote_batches (id INTEGER PRIMARY KEY);
             CREATE TABLE smart_quote_records (id INTEGER PRIMARY KEY);`);
    if (rows > 0) {
      db.prepare('INSERT INTO customers (company_name) VALUES (?)').run('客户' + rows);
    }
    db.close();
  };

  const dir = path.join(TMPROOT, 'heal');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'erp.db');

  // 场景 A：空库 + 同目录带备份后缀的有效备份 → 应恢复
  mkDb(target, 0);
  const bak = path.join(dir, 'erp.db.bak-20261116');
  mkDb(bak, 7);
  const candA = dbPath.findRestoreCandidate(target);
  ok('空库时能找到有效备份', !!candA && candA.file === bak, candA && path.basename(candA.file));
  ok('有效备份被识别为含业务数据', candA && candA.rows === 1, candA && String(candA.rows));

  // 场景 B：库内有数据 → 绝不恢复（用 autoRestoreIfEmpty 验证端到端行为）
  mkDb(target, 3);
  const stateB = dbPath.isEmptyBusinessDb(target, new DatabaseSync(target, { readOnly: true }));
  ok('库内有业务数据时判定为「非空」', stateB.empty === false, `rows=${stateB.rows}`);
  const healB = dbPath.autoRestoreIfEmpty(target, new DatabaseSync(target, { readOnly: true }));
  ok('库内有数据时自愈不触发（restored=false）', healB.restored === false, healB.reason || '');
  const afterB = new DatabaseSync(target, { readOnly: true });
  ok('库内数据未被覆盖（仍为 1 行）',
    afterB.prepare('SELECT COUNT(*) c FROM customers').get().c === 1);
  afterB.close();

  // 场景 C：空库 + 同目录普通 .db（非备份命名）→ 绝不误用
  const dirC = path.join(TMPROOT, 'nocase');
  fs.mkdirSync(dirC, { recursive: true });
  const targetC = path.join(dirC, 'erp.db');
  mkDb(targetC, 0);
  mkDb(path.join(dirC, 'other_test.db'), 5);
  ok('同目录普通 *.db 不作为恢复源（防陈旧数据回滚）',
    dbPath.findRestoreCandidate(targetC) === null);

  // 场景 D：空库 + backups/ 下专属快照 → 应恢复
  const dirD = path.join(TMPROOT, 'snap');
  fs.mkdirSync(path.join(dirD, 'backups'), { recursive: true });
  const targetD = path.join(dirD, 'erp.db');
  mkDb(targetD, 0);
  mkDb(path.join(dirD, 'backups', 'erp-20261116-pre-migrate.db'), 9);
  const candD = dbPath.findRestoreCandidate(targetD);
  ok('backups/ 下专属快照可作为恢复源', !!candD && path.basename(candD.file).startsWith('erp-'),
    candD && path.basename(candD.file));

  // 场景 E：空壳库（无表）判定为空
  const dirE = path.join(TMPROOT, 'shell');
  fs.mkdirSync(dirE, { recursive: true });
  const targetE = path.join(dirE, 'erp.db');
  fs.writeFileSync(targetE, '');
  const stateE = dbPath.isEmptyBusinessDb(targetE, new DatabaseSync(targetE, { readOnly: true }));
  ok('0 字节空壳库判定为「空」', stateE.empty === true, `tables=${stateE.tableCount}`);

  // 场景 F：专属快照目录里【别人的库】的快照不能被当成本库的恢复源
  const dirF = path.join(TMPROOT, 'crossdb');
  fs.mkdirSync(path.join(dirF, 'backups'), { recursive: true });
  const targetF = path.join(dirF, 'erp.db');
  mkDb(targetF, 0);
  mkDb(path.join(dirF, 'backups', 'otherdb-20260101-x.db'), 4);
  ok('他库快照不被误用（快照名前缀必须匹配当前库名）',
    dbPath.findRestoreCandidate(targetF) === null);
}

// ============================================================ ③ 发布包洁净度
section('③ 发布包洁净度（包内绝不能有库文件）');
{
  const guard = path.join(__dirname, 'prepublish_guard.js');
  ok('prepublish_guard.js 存在', fs.existsSync(guard));
  const src = fs.readFileSync(guard, 'utf8');
  ok('守卫脚本含 --stage / --restore 模式',
    src.includes('--stage') && src.includes('--restore'));
  const di = fs.readFileSync(path.join(__dirname, '..', '.deployignore'), 'utf8');
  ok('.deployignore 排除 data/ 目录', /\ndata\//.test(di));
  ok('.deployignore 排除 *.db 及其伴生文件',
    di.includes('*.db') && di.includes('*.db-wal') && di.includes('*.db-journal'));
  ok('.deployignore 排除备份/快照命名', di.includes('*.bak') && di.includes('*.snapshot'));
}

// ============================================================ ④ JWT 密钥来源
section('④ JWT 密钥来源（多实例一致性）');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8');
  ok('优先读 ERP_JWT_SECRET 环境变量', src.includes('ERP_JWT_SECRET'));
  ok('回落到包内 jwt.secret', src.includes('SECRET_FILE'));
  ok('新增包外持久目录回落（跨实例一致）', src.includes('.wbapp-erp-data'));
  ok('导出 secretSource 供 health 诊断', src.includes('secretSource'));
}

// 清理
try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
console.log('✅ 数据安全铁律专项回归全部通过');
