#!/usr/bin/env node
// ============================================================================
//  deploy.js · Light-ERP 一键发布编排（数据保护闸门式发布）
// ----------------------------------------------------------------------------
//  背景（2026-11-20 v21 发布事故）：平台每次发布都是全新临时存储，数据唯一
//  跨发布通道是 data/erp.restore-from-local.db。旧流程靠人工记得先跑
//  prepublish-export —— v21 忘了跑，工时/订单数据全部丢失。
//
//  本脚本把「导出→校验→打包→部署→验证」固化成一条命令，任一闸门失败
//  立即中止，绝不裸部署：
//    G1  npm test 全绿（--skip-tests 可跳过）
//    G2  记录发布前线上指纹（登录 → db-export → 逐表行数 + _build_version）
//    G3  强制执行 prepublish-export（失败即中止）
//    G4  恢复包完整性校验（逐表行数与 G2 指纹完全一致）
//    G5  打包（robocopy 排除清单 + 恢复包拷入 + md5 前后一致校验）
//        —— --dry-run 执行到 G5 完成即停，不发起真实部署
//    G6  部署（trae-deploy create + wait，status=9 才继续）
//    G7  上线确认（轮询首页可达 + _build_version 变化 = 新实例已接管）
//    G8  发布后一致性校验（线上逐表行数 ≥ 发布前指纹）
//    G9  发布报告落盘 data/deploy-reports/deploy-<ts>.json
//
//  用法：
//    node scripts/deploy.js --title "Light-ERP v23: xxx"
//    node scripts/deploy.js --title "..." --dry-run        # 只走 G1-G5 验证打包
//    node scripts/deploy.js --title "..." --skip-tests     # 跳过 G1（不推荐）
//
//  回滚预案：数据回滚 = 直接重跑本脚本（恢复包始终是最近一份完整快照）；
//  代码回滚 = git revert 后重跑本脚本。
// ============================================================================
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SITE_ID = '37k87749he11bnutz2k';
const BASE = (process.env.ERP_BASE_URL || 'https://zyyc26.traesite.cn').replace(/\/$/, '');
const EXEC_CONFIG = process.env.ERP_EXEC_CONFIG || path.join(ROOT, '..', 'exec_config.json');
const BUNDLE = path.join(ROOT, 'data', 'erp.restore-from-local.db');
const REPORT_DIR = path.join(ROOT, 'data', 'deploy-reports');

// 业务比对表：与 src/db/restoreGuard.js BIZ_TABLES 保持一致
const BIZ_TABLES = [
  'customers', 'orders', 'inventory_transactions', 'work_hours',
  'logistics_quotes', 'smart_quote_batches', 'smart_quote_records',
  'warehouse_sort_config',
];

// ---------- 参数解析（风格与 prepublish-export.js 一致） ----------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (i >= 0) return true;
  return def;
}
const OPT = {
  title: arg('title', 'Light-ERP deploy ' + new Date().toISOString().slice(0, 16)),
  desc: arg('desc', ''),
  appTags: arg('app-tags', '123,134,289,301'),
  skipTests: process.argv.includes('--skip-tests'),
  dryRun: process.argv.includes('--dry-run'),
  user: arg('user', process.env.ERP_ADMIN_USER || 'admin'),
  // ★ M16 安全提示：默认 admin123 仅用于连接既有线上账号；请务必通过
  //   --pass 或环境变量 ERP_ADMIN_PASS 显式传入强口令，且确保线上 admin 已改密。
  pass: arg('pass', process.env.ERP_ADMIN_PASS || 'admin123'),
};

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}
function extractJson(output) {
  const lines = String(output || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try { return JSON.parse(line); } catch (e) { /* try next */ }
    }
  }
  return null;
}
function findTraeDeploy() {
  if (process.env.TRAE_DEPLOY_EXE && fs.existsSync(process.env.TRAE_DEPLOY_EXE)) {
    return process.env.TRAE_DEPLOY_EXE;
  }
  const pluginRoot = path.join(os.homedir(), '.trae-cn', 'plugins', 'trae-remote-official', 'deployment');
  if (fs.existsSync(pluginRoot)) {
    const versions = fs.readdirSync(pluginRoot).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort().reverse();
    for (const v of versions) {
      const p = path.join(pluginRoot, v, 'skills', 'deployment', 'bin', 'win32-x64', 'trae-deploy.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
function countTables(dbFile) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    const rows = {};
    let total = 0;
    for (const t of BIZ_TABLES) {
      let c = 0;
      if (tables.has(t)) { try { c = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { c = 0; } }
      rows[t] = c;
      total += c;
    }
    return { rows, total };
  } finally { db.close(); }
}
async function loginToken() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: OPT.user, password: OPT.pass }),
  });
  const j = await res.json();
  if (!j.token) throw new Error(`登录失败 HTTP ${res.status}`);
  return j.token;
}
async function onlineFingerprint(token) {
  const res = await fetch(`${BASE}/api/admin/db-export`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`db-export HTTP ${res.status}`);
  const tmp = path.join(os.tmpdir(), `erp-fp-${Date.now()}.db`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  const fp = countTables(tmp);
  fs.unlinkSync(tmp);
  // _build_version 用于确认新实例接管
  let buildVersion = null;
  try {
    const r2 = await fetch(`${BASE}/api/orders/query?pageSize=1`, { headers: { Authorization: `Bearer ${token}` } });
    buildVersion = (await r2.json())._build_version || null;
  } catch (e) { /* ignore */ }
  return { ...fp, buildVersion };
}
function fatal(msg) {
  console.error('\n❌ [deploy] ' + msg);
  console.error('❌ [deploy] 发布已中止，线上数据未受影响（尚未执行任何部署动作或已部署但数据校验失败见上）');
  process.exit(1);
}

// ============================================================================
(async () => {
  const t0 = Date.now();
  const report = { title: OPT.title, base: BASE, startedAt: new Date().toISOString(), gates: {} };

  console.log('='.repeat(72));
  console.log(`[deploy] ${OPT.title}`);
  console.log(`[deploy] 目标：${BASE}${OPT.dryRun ? '  （DRY-RUN：只到打包校验，不部署）' : ''}`);
  console.log('='.repeat(72));

  // ---------- G1 npm test ----------
  if (OPT.skipTests) {
    console.log('\n[G1] 跳过 npm test（--skip-tests）');
    report.gates.G1_tests = 'skipped';
  } else {
    console.log('\n[G1] 运行 npm test ...');
    // shell:true + 单字符串命令（避免 args 数组拼接的 DEP0190 警告；Windows 下 npm 是 .cmd 必须 shell 解析）
    const t = spawnSync('npm test', { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: true });
    const m = String(t.stdout).match(/ℹ pass (\d+)/);
    const fail = String(t.stdout).match(/ℹ fail (\d+)/);
    if (t.status !== 0 || !m || (fail && Number(fail[1]) > 0)) {
      fatal(`G1 测试未通过（exit=${t.status}，pass=${m && m[1]}，fail=${fail && fail[1]}）。先修复测试再发布。`);
    }
    console.log(`[G1] ✅ npm test ${m[1]}/${m[1]} 全部通过`);
    report.gates.G1_tests = `pass ${m[1]}`;
  }

  // ---------- G2 发布前线上指纹 ----------
  console.log('\n[G2] 记录发布前线上指纹 ...');
  const token = await loginToken();
  const before = await onlineFingerprint(token);
  console.log('[G2] 发布前行数：', JSON.stringify(before.rows), '总计', before.total, 'build_version=', before.buildVersion);
  report.before = before;

  // ---------- G3 强制导出（数据保护核心闸门） ----------
  console.log('\n[G3] 强制执行 prepublish-export（不跳过、不重试直通）...');
  const ex = spawnSync('node', ['scripts/prepublish-export.js'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  if (ex.status !== 0) {
    fatal(`G3 发布前数据导出失败（exit=${ex.status}）。为防数据丢失，拒绝继续发布。\n${String(ex.stdout)}${String(ex.stderr)}`);
  }
  console.log(String(ex.stdout).trim().split(/\r?\n/).map((l) => '  | ' + l).join('\n'));
  report.gates.G3_export = 'ok';

  // ---------- G4 恢复包完整性校验 ----------
  console.log('\n[G4] 恢复包完整性校验 ...');
  if (!fs.existsSync(BUNDLE)) fatal('G4 恢复包不存在：' + BUNDLE);
  const bundle = countTables(BUNDLE);
  const diffs = BIZ_TABLES.filter((t) => bundle.rows[t] !== before.rows[t]);
  if (diffs.length) {
    fatal(`G4 恢复包与线上指纹不一致：${diffs.map((t) => `${t}(包=${bundle.rows[t]} 线上=${before.rows[t]})`).join(', ')}。拒绝发布。`);
  }
  console.log(`[G4] ✅ 恢复包逐表与线上一致（总计 ${bundle.total} 行，${fs.statSync(BUNDLE).size} 字节）`);
  report.bundle = { total: bundle.total, size: fs.statSync(BUNDLE).size, md5: md5(BUNDLE) };

  // ---------- G5 打包 ----------
  console.log('\n[G5] 打包（robocopy 排除 node_modules/.git/dist/data/logs）...');
  const stage = path.join(os.tmpdir(), 'light-erp-deploy-' + Date.now());
  const rb = spawnSync('robocopy', [
    ROOT, stage, '/E', '/NFL', '/NDL', '/NJH', '/NJS',
    '/XD', 'node_modules', '.git', 'dist', 'data', 'logs', '.workbuddy',
    // ★ 修复 S12：排除密钥/数据库等敏感文件，避免打包进发布产物导致泄露。
    //   data/ 目录已被 /XD 排除，这里再排除散落在根目录的密钥与备份文件。
    '/XF', '.env', 'jwt.secret', '*.db', '*.db-wal', '*.db-shm', '*.db-journal', '*.bak', '*.snapshot',
  ], { encoding: 'utf8', timeout: 300000 });
  if (rb.status >= 8) fatal(`G5 robocopy 失败（exit=${rb.status}）`);
  fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
  fs.copyFileSync(BUNDLE, path.join(stage, 'data', 'erp.restore-from-local.db'));
  const stagedBundle = path.join(stage, 'data', 'erp.restore-from-local.db');
  if (md5(stagedBundle) !== report.bundle.md5) fatal('G5 恢复包拷贝后 md5 不一致（打包损坏），拒绝发布');
  if (OPT.dryRun) {
    console.log(`[G5] ✅ DRY-RUN 完成：暂存目录 ${stage}（含恢复包 ${fs.statSync(stagedBundle).size} 字节，md5 校验通过）`);
    console.log('[DRY-RUN] 未发起真实部署。如需发布，去掉 --dry-run 重新执行。');
    report.dryRun = true;
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, `deploy-${Date.now()}-dryrun.json`), JSON.stringify(report, null, 2));
    return;
  }
  console.log(`[G5] ✅ 暂存目录就绪：${stage}`);
  report.gates.G5_pack = 'ok';

  // ---------- G6 部署 ----------
  console.log('\n[G6] 发起部署（trae-deploy）...');
  const EXE = findTraeDeploy();
  if (!EXE) fatal('G6 未找到 trae-deploy.exe（设 TRAE_DEPLOY_EXE 环境变量指定）');
  const createArgs = [
    'deployments', 'create',
    '--site-id', SITE_ID,
    '--type', 'function-web',
    '--source-dir', stage,
    '--execution-config', EXEC_CONFIG,
    '--app-tags', OPT.appTags,
    '--title', OPT.title,
    '--description', OPT.desc || `${OPT.title} via deploy.js (gated pipeline, bundle ${bundle.total} rows)`,
  ];
  const cr = spawnSync(EXE, createArgs, { encoding: 'utf8', timeout: 600000 });
  const cj = extractJson((cr.stdout || '') + (cr.stderr || ''));
  const depId = cj && cj.data && cj.data.deployment_id;
  if (!depId) fatal(`G6 创建部署失败：${(cj && cj.error && cj.error.message) || String(cr.stderr).slice(0, 400)}`);
  console.log(`[G6] 部署已创建：${depId}，等待完成 ...`);
  let dep = null;
  for (let i = 0; i < 30; i++) {
    await sleep(20000);
    const wr = spawnSync(EXE, ['deployments', 'wait', '--deployment-id', depId], { encoding: 'utf8', timeout: 180000 });
    const wj = extractJson((wr.stdout || '') + (wr.stderr || ''));
    dep = wj && wj.data && wj.data.deployment;
    if (dep && dep.failure) fatal(`G6 部署失败：${JSON.stringify(dep.failure).slice(0, 400)}`);
    if (dep && dep.status === 9) break;
    console.log(`[G6] ... status=${dep && dep.status} progress=${dep && dep.progress_percent}%`);
  }
  if (!dep || dep.status !== 9) fatal(`G6 部署未在时限内完成（最后一次 status=${dep && dep.status}）`);
  console.log('[G6] ✅ 部署成功（status=9）');
  report.gates.G6_deploy = depId;

  // ---------- G7 上线确认 ----------
  console.log('\n[G7] 等待新实例上线并确认版本切换 ...');
  let online = false;
  for (let i = 0; i < 30; i++) {
    await sleep(10000);
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) { online = true; break; }
    } catch (e) { /* retry */ }
  }
  if (!online) fatal('G7 部署完成后 5 分钟内首页仍不可达，请检查部署日志');
  const after0 = await onlineFingerprint(await loginToken());
  if (before.buildVersion && after0.buildVersion && after0.buildVersion === before.buildVersion) {
    fatal(`G7 build_version 未变化（${after0.buildVersion}），新实例疑似未接管流量`);
  }
  console.log(`[G7] ✅ 线上可达，build_version ${before.buildVersion} → ${after0.buildVersion}`);
  report.gates.G7_online = { before: before.buildVersion, after: after0.buildVersion };

  // ---------- G8 发布后一致性校验 ----------
  console.log('\n[G8] 发布后数据一致性校验（逐表 ≥ 发布前）...');
  const token2 = await loginToken();
  const after = await onlineFingerprint(token2);
  report.after = after;
  const losses = BIZ_TABLES.filter((t) => (after.rows[t] || 0) < (before.rows[t] || 0));
  if (losses.length) {
    console.error('\n⚠️⚠️⚠️  [G8] CRITICAL：以下业务表行数少于发布前！');
    for (const t of losses) console.error(`    ${t}: 发布前=${before.rows[t]} 发布后=${after.rows[t]}`);
    console.error('⚠️  恢复预案：立即重跑 node scripts/deploy.js（恢复包含发布前完整数据，将自动重新注入）');
    fatal('G8 数据一致性校验失败');
  }
  const same = BIZ_TABLES.filter((t) => after.rows[t] === before.rows[t]);
  console.log(`[G8] ✅ 逐表行数 ≥ 发布前（${same.length}/${BIZ_TABLES.length} 表完全相等，其余为发布窗口内新增）`);
  report.gates.G8_consistency = 'ok';

  // ---------- G9 报告落盘 ----------
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - t0;
  report.verdict = 'SUCCESS';
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const rp = path.join(REPORT_DIR, `deploy-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.json`);
  fs.writeFileSync(rp, JSON.stringify(report, null, 2));

  console.log('\n' + '='.repeat(72));
  console.log(`[deploy] ✅ 发布完成：${OPT.title}`);
  console.log(`[deploy]    行数对比（前→后）：${BIZ_TABLES.map((t) => `${t} ${before.rows[t]}→${after.rows[t]}`).join(', ')}`);
  console.log(`[deploy]    耗时 ${Math.round(report.durationMs / 1000)}s，报告：${rp}`);
  console.log('='.repeat(72));
})().catch((e) => fatal(e && e.stack ? e.stack : e.message));
