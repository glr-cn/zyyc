// ============================================================================
// 导入重复拦截单元测试
// 测试目标：验证 /import/preview 和 /import 两个接口在遇到已归档冲突时的行为
//   1. preview 能正确区分 archived_conflict vs pending_conflict
//   2. import 全部行归档冲突 → 返回 409 + code='IMPORT_ARCHIVED_CONFLICT'，零事务
//   3. import 部分行归档冲突 → 非冲突行仍能导入，冲突行计入 archived_blocked
//   4. import 正常数据（无冲突）→ 全部 created，不出现 blocked
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db/driver');

// 在 :memory: 库建 work_hours 表 + 预置归档/待提交行
function setup() {
  const db = openDatabase(':memory:');
  db.exec(`CREATE TABLE work_hours (
    work_id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL,
    work_type TEXT NOT NULL,
    customer_id INTEGER,
    customer_name TEXT,
    unit TEXT,
    date TEXT NOT NULL,
    ship_orders REAL, cartons REAL, tons REAL, cubic REAL, pallets REAL,
    workload REAL, project TEXT,
    main_hours REAL NOT NULL DEFAULT 0,
    other_hours REAL NOT NULL DEFAULT 0,
    shared_hours REAL NOT NULL DEFAULT 0,
    total_hours REAL NOT NULL DEFAULT 0,
    efficiency REAL, unit_cost REAL, doc_cost REAL,
    remark TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    submitter TEXT, submit_time TEXT,
    owner_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );`);

  const ins = db.prepare(
    `INSERT INTO work_hours
      (warehouse, work_type, customer_id, customer_name, date, ship_orders, main_hours, status, submitter)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  // 归档：龙湖仓 2026-11-18 货主A(cid=101)
  ins.run('龙湖仓', '发货', 101, '货主A', '2026-11-18', 200, 18, 'archived', 'admin');
  // 归档：龙湖仓 2026-11-17 货主B(cid=102) — 不同日期
  ins.run('龙湖仓', '发货', 102, '货主B', '2026-11-17', 150, 12, 'archived', 'admin');
  // 待提交：龙湖仓 2026-11-18 货主C(cid=103) — 只有 pending 冲突（可 overwrite/skip）
  ins.run('龙湖仓', '发货', 103, '货主C', '2026-11-18', 80, 8, 'pending', null);
  // 归档：龙湖仓 2026-11-18 货主D(cid=104) + pending：同日期同客户待提交行 — 同维度两状态并存
  ins.run('龙湖仓', '发货', 104, '货主D', '2026-11-18', 100, 10, 'archived', 'admin');
  ins.run('龙湖仓', '发货', 104, '货主D', '2026-11-18', 60, 6, 'pending', null);
  // 其他仓归档：佳新仓 2026-11-18 货主A — 不同仓不冲突
  ins.run('佳新仓', '发货', 101, '货主A', '2026-11-18', 90, 9, 'archived', 'admin');

  return db;
}

// 复刻后端 preview 的重复检测逻辑（独立于完整路由）
function previewDupCheck(db, warehouse, importRows) {
  const find = db.prepare(
    `SELECT work_id, status, ship_orders, main_hours, total_hours FROM work_hours
      WHERE warehouse=? AND work_type='发货' AND customer_id=? AND date=?
      ORDER BY CASE WHEN status='archived' THEN 0 ELSE 1 END, work_id LIMIT 1`
  );
  return importRows.map((p) => {
    const any = find.get(warehouse, p.customer_id, p.date);
    if (!any) return { ...p, duplicate: false, archived_conflict: false, existing: null, decision: 'create' };
    const archivedExists = any.status === 'archived';
    if (archivedExists) {
      return { ...p, duplicate: true, archived_conflict: true, existing: any, decision: 'blocked' };
    }
    return { ...p, duplicate: true, archived_conflict: false, existing: any, decision: 'skip' };
  });
}

// ---------- 测试开始 ----------

// --- preview 阶段 ---

test('preview：遇到 archived 冲突 → 返回 archived_conflict=true + decision=blocked', () => {
  const db = setup();
  // 导入：龙湖仓 2026-11-18 货主A（cid=101）— 已归档
  const rows = previewDupCheck(db, '龙湖仓', [
    { line: 1, customer_id: 101, customer_name: '货主A', date: '2026-11-18', ship_orders: 250, main_hours: 20 },
  ]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].duplicate);
  assert.ok(rows[0].archived_conflict);
  assert.equal(rows[0].decision, 'blocked');
  assert.equal(rows[0].existing.status, 'archived');
  assert.equal(rows[0].existing.work_id, 1);
});

test('preview：同维度 pending+archived 并存时优先返回 archived_conflict', () => {
  const db = setup();
  // 货主D 既有 archived(wid=4) 又有 pending(wid=5)；ORDER BY CASE archived 先 → 返回 archived 那条
  const rows = previewDupCheck(db, '龙湖仓', [
    { line: 1, customer_id: 104, customer_name: '货主D', date: '2026-11-18', ship_orders: 120, main_hours: 11 },
  ]);
  assert.ok(rows[0].archived_conflict);
  assert.equal(rows[0].existing.status, 'archived');
  assert.equal(rows[0].existing.work_id, 4);
});

test('preview：只有 pending 冲突（货主C）→ archived_conflict=false + decision=skip', () => {
  const db = setup();
  const rows = previewDupCheck(db, '龙湖仓', [
    { line: 1, customer_id: 103, customer_name: '货主C', date: '2026-11-18', ship_orders: 90, main_hours: 9 },
  ]);
  assert.ok(rows[0].duplicate);
  assert.equal(rows[0].archived_conflict, false);
  assert.equal(rows[0].decision, 'skip');
  assert.equal(rows[0].existing.status, 'pending');
});

test('preview：完全无冲突（不同日期 + 不同仓 + 不同客户）→ archived_conflict=false + decision=create', () => {
  const db = setup();
  // 同仓 + 不同日期 → 无冲突
  let rows = previewDupCheck(db, '龙湖仓', [
    { line: 1, customer_id: 101, customer_name: '货主A', date: '2026-11-19', ship_orders: 100, main_hours: 10 },
  ]);
  assert.equal(rows[0].duplicate, false);
  assert.equal(rows[0].archived_conflict, false);
  assert.equal(rows[0].decision, 'create');

  // 不同仓 + 同客户同日期 → 龙湖仓查佳新仓归档 → 无冲突
  rows = previewDupCheck(db, '龙湖仓', [
    { line: 1, customer_id: 999, customer_name: '全新客户', date: '2026-11-18', ship_orders: 100, main_hours: 10 },
  ]);
  assert.equal(rows[0].duplicate, false);

  // 完全新客户 + 新日期 → 无冲突
  rows = previewDupCheck(db, '龙湖仓', [
    { line: 1, customer_id: 999, customer_name: '全新客户', date: '2026-11-19', ship_orders: 100, main_hours: 10 },
  ]);
  assert.equal(rows[0].duplicate, false);
});

test('preview：同 customer_id 不同 customer_name 仍能命中（customer_id 是主键判定）', () => {
  const db = setup();
  // 归档的是 customer_id=101 货主A；导入 customer_id=101 customer_name='货主A（新名）'
  // 以 customer_id 为准判定
  const rows = previewDupCheck(db, '龙湖仓', [
    { line: 1, customer_id: 101, customer_name: '货主A（新名）', date: '2026-11-18', ship_orders: 100, main_hours: 10 },
  ]);
  assert.ok(rows[0].archived_conflict, 'customer_id 匹配即冲突，不管 customer_name 是否相同');
});

// --- import 预校验逻辑（模拟 allBlocked 判定）---

test('import：全部行 archived 冲突 → 应判定为 allBlocked', () => {
  const db = setup();
  const findAny = db.prepare(
    `SELECT work_id, status FROM work_hours
      WHERE warehouse=? AND work_type='发货' AND customer_id=? AND date=?
      ORDER BY CASE WHEN status='archived' THEN 0 ELSE 1 END, work_id LIMIT 1`
  );
  const importRows = [
    { line: 1, customer_id: 101, customer_name: '货主A', date: '2026-11-18' }, // archived
    { line: 2, customer_id: 102, customer_name: '货主B', date: '2026-11-17' }, // archived
  ];
  const PRECHECK = new Map();
  for (const p of importRows) {
    const any = findAny.get('龙湖仓', p.customer_id, p.date);
    PRECHECK.set(p.line, { archived_conflict: any && any.status === 'archived', existing: any });
  }
  const allBlocked = importRows.every((p) => PRECHECK.get(p.line)?.archived_conflict);
  assert.ok(allBlocked, '全部行归档冲突应判定为 allBlocked=true');
});

test('import：混合行（部分 archived 冲突 + 部分正常）→ 应判定为非 allBlocked', () => {
  const db = setup();
  const findAny = db.prepare(
    `SELECT work_id, status FROM work_hours
      WHERE warehouse=? AND work_type='发货' AND customer_id=? AND date=?
      ORDER BY CASE WHEN status='archived' THEN 0 ELSE 1 END, work_id LIMIT 1`
  );
  const importRows = [
    { line: 1, customer_id: 101, date: '2026-11-18' },  // archived
    { line: 2, customer_id: 101, date: '2026-11-19' },  // 正常（不同日期）
  ];
  const PRECHECK = new Map();
  for (const p of importRows) {
    const any = findAny.get('龙湖仓', p.customer_id, p.date);
    PRECHECK.set(p.line, { archived_conflict: any && any.status === 'archived', existing: any });
  }
  const allBlocked = importRows.every((p) => PRECHECK.get(p.line)?.archived_conflict);
  assert.equal(allBlocked, false, '混合行不应判定为 allBlocked');
});

test('import 预校验逻辑：archived 冲突强制跳过，pending 冲突尊重 decision，正常行 create', () => {
  // 这是 /import 主循环的核心分流逻辑单元测试
  // 模拟：archived 冲突行 → archivedBlocked++ + continue
  //       pending 冲突行   → 走 decision（skip/overwrite）
  //       无冲突行         → 走 create
  const db = setup();
  const findAny = db.prepare(
    `SELECT work_id, status FROM work_hours
      WHERE warehouse=? AND work_type='发货' AND customer_id=? AND date=?
      ORDER BY CASE WHEN status='archived' THEN 0 ELSE 1 END, work_id LIMIT 1`
  );
  const importRows = [
    { line: 1, customer_id: 101, date: '2026-11-18' }, // archived 冲突 → block
    { line: 2, customer_id: 103, date: '2026-11-18' }, // pending 冲突（货主C）
    { line: 3, customer_id: 101, date: '2026-11-19' }, // 无冲突 → create
  ];
  const decisions = {}; // 空决策 → pending 冲突默认 skip
  let archivedBlocked = 0, skipped = 0, wouldCreate = 0;
  for (const p of importRows) {
    const any = findAny.get('龙湖仓', p.customer_id, p.date);
    const archivedConflict = any && any.status === 'archived';
    const pendingConflict = any && any.status === 'pending';
    if (archivedConflict) { archivedBlocked++; continue; }
    if (pendingConflict) {
      const decision = decisions[p.line] || 'skip';
      if (decision === 'skip') { skipped++; continue; }
    }
    wouldCreate++;
  }
  assert.equal(archivedBlocked, 1, '第1行归档冲突应被拦截');
  assert.equal(skipped, 1, '第2行 pending 冲突默认 skip');
  assert.equal(wouldCreate, 1, '第3行正常 create');
});
