#!/usr/bin/env node
/**
 * 发布前「线上数据安全导出」脚本 —— 防止再次出现「发布后客户资料丢失」。
 *
 * 背景（2026-11-20 事故根因）：
 *   部署平台每次发布都使用**全新的临时存储**（见 src/routes/admin.js 的 db-export 注释）。
 *   $HOME/.wbapp-erp-data/erp.db 不会跨发布保留。数据能跨发布活下来的唯一通道是：
 *     发布前导出线上库 → 放进发布包的 data/erp.restore-from-local.db
 *     → run.sh 在新实例首次启动（持久库不存在或为空）时注入。
 *   如果发布包里没有这份文件，新实例就是空库 → 客户资料/工时等业务数据全部"消失"。
 *
 * 本脚本做的事：登录线上 → 调 /api/admin/db-export 拉一份一致快照
 *   → 校验业务行数 → 覆盖 data/erp.restore-from-local.db。
 *
 * 安全阀：
 *   - 线上业务表全空（0 行）时**拒绝覆盖**已有非空恢复包（否则会把好数据替换成空库）。
 *   - 线上数据行数比现有恢复包少时给出明显告警（不阻断，但需要人工确认）。
 *
 * 用法：
 *   node scripts/prepublish-export.js
 *   node scripts/prepublish-export.js --base https://zyyc26.traesite.cn --user admin --pass admin123
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const BIZ_TABLES = ['customers', 'warehouse_sort_config', 'work_hours', 'orders',
  'inventory_transactions', 'logistics_quotes', 'smart_quote_batches', 'smart_quote_records'];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const BASE = (arg('base', process.env.ERP_BASE_URL || 'https://zyyc26.traesite.cn')).replace(/\/$/, '');
const USER = arg('user', process.env.ERP_USER || 'admin');
const PASS = arg('pass', process.env.ERP_PASS || 'admin123');

const root = path.join(__dirname, '..');
const bundle = path.join(root, 'data', 'erp.restore-from-local.db');

function countBiz(file) {
  const out = {};
  let total = 0;
  const db = new Database(file, { readonly: true });
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  for (const t of BIZ_TABLES) {
    if (!tables.has(t)) continue;
    try {
      const c = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
      out[t] = c;
      total += c;
    } catch (e) { /* ignore */ }
  }
  db.close();
  return { rows: out, total };
}

(async () => {
  console.log(`[export] 目标：${BASE}`);
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
  const login = await loginRes.json();
  const token = login.token;
  if (!token) throw new Error('登录响应中没有 token');

  const tmp = path.join(os.tmpdir(), `erp-online-${Date.now()}.db`);
  const res = await fetch(`${BASE}/api/admin/db-export`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`导出失败 HTTP ${res.status}`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

  const online = countBiz(tmp);
  console.log('[export] 线上业务行数：', JSON.stringify(online.rows), '总计', online.total);

  let local = { rows: {}, total: 0 };
  if (fs.existsSync(bundle)) {
    local = countBiz(bundle);
    console.log('[export] 现有恢复包：', JSON.stringify(local.rows), '总计', local.total);
  } else {
    console.log('[export] 现有恢复包：不存在');
  }

  if (online.total === 0) {
    if (local.total > 0) {
      fs.unlinkSync(tmp);
      console.error('[export] ❌ 线上业务数据为 0，但现有恢复包有数据 —— 拒绝用空库覆盖！');
      console.error('[export]    请先确认为什么线上是空的（是否上一次发布没带恢复包）。');
      process.exit(1);
    }
    console.log('[export] ⚠️ 线上与恢复包都是空库，仍写入（保持空状态一致）');
  } else if (online.total < local.total) {
    console.warn(`[export] ⚠️ 线上业务行数(${online.total}) 少于现有恢复包(${local.total})，请人工确认是否继续`);
  }

  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.copyFileSync(tmp, bundle);
  fs.unlinkSync(tmp);
  console.log('[export] ✅ 已更新恢复包：', bundle);
  console.log('[export]    发布时该文件必须随包上传到 data/erp.restore-from-local.db');
})().catch((e) => {
  console.error('[export] 失败：', e.message);
  process.exit(1);
});
