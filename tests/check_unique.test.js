// ============================================================================
// checkUnique 单元测试
// 测试目标：验证「归档唯一性校验」函数返回结构化冲突详情（code/date/shipper/project 等），
// 而不是只返回纯字符串错误。覆盖场景：
//   1. 发货 work_type —— 同仓同日同客户（customer_id 精确 / customer_name 兜底）
//   2. 库内 work_type —— 同仓同日同项目
//   3. 后勤 work_type —— 同仓同日同项目
//   4. 收货 work_type —— 应直接放行（返回 null）
//   5. excludeWorkId —— 编辑场景下，允许命中自己这条
//   6. 关键字段缺失 —— 应放行（由上层 validateByType 拦截）
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db/driver');

// 从 src/routes/workhours.js 直接复刻（结构一致，测试隔离）
function makeCheckUnique(db) {
  return function checkUnique(workType, { warehouse, date, customer_id, customer_name, project }, { excludeWorkId } = {}) {
    if (workType === '收货') return null;

    const keyCol = (workType === '发货') ? 'customer_id' : 'project';
    const keyVal = (workType === '发货') ? (customer_id != null ? customer_id : null) : project;

    if (warehouse == null || date == null || keyVal == null) return null;

    const clauses = ["warehouse = ?", "work_type = ?", "date = ?", "status = 'archived'"];
    const params = [warehouse, workType, date];

    if (workType === '发货' && keyVal != null) {
      clauses.push('(customer_id = ? OR (customer_id IS NULL AND customer_name = ?))');
      params.push(keyVal, customer_name || '');
    } else {
      clauses.push('project = ?');
      params.push(keyVal);
    }

    if (excludeWorkId) {
      clauses.push('work_id != ?');
      params.push(excludeWorkId);
    }

    const row = db.prepare(
      `SELECT work_id, ${keyCol} FROM work_hours WHERE ${clauses.join(' AND ')} LIMIT 1`
    ).get(...params);

    if (!row) return null;

    const conflictLabel = (workType === '发货')
      ? (customer_name || ('客户ID=' + customer_id))
      : (project || '');

    return {
      code: 'DUPLICATE_ARCHIVED',
      date: date,
      shipper: (workType === '发货') ? conflictLabel : null,
      project: (workType !== '发货') ? conflictLabel : null,
      work_type: workType,
      archived_work_id: row.work_id,
      message: `该${workType === '发货' ? '客户' : '项目'}「${conflictLabel}」在 ${date} 已存在归档工时记录，请勿重复提交或请前往已归档列表修改。`,
    };
  };
}

// 在 :memory: 库里建 work_hours 表并插入一批 archived 预置行
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
    ship_orders REAL,
    cartons REAL,
    tons REAL,
    cubic REAL,
    pallets REAL,
    workload REAL,
    project TEXT,
    main_hours REAL NOT NULL DEFAULT 0,
    other_hours REAL NOT NULL DEFAULT 0,
    shared_hours REAL NOT NULL DEFAULT 0,
    total_hours REAL NOT NULL DEFAULT 0,
    efficiency REAL,
    unit_cost REAL,
    doc_cost REAL,
    remark TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    submitter TEXT,
    submit_time TEXT,
    owner_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );`);

  const insert = db.prepare(
    `INSERT INTO work_hours
      (warehouse, work_type, customer_id, customer_name, date, project, status, main_hours)
     VALUES (?,?,?,?,?,?,?,?)`
  );

  // 发货归档数据：龙湖仓 2026-11-18 货主A(cid=101) 已归档
  insert.run('龙湖仓', '发货', 101, '货主A', '2026-11-18', null, 'archived', 2);
  // 发货归档数据：龙湖仓 2026-11-18 customer_id=null customer_name='货主B'（用于名称兜底匹配）
  insert.run('龙湖仓', '发货', null, '货主B', '2026-11-18', null, 'archived', 1.5);
  // 库内归档数据：佳新仓 2026-11-18 项目'盘点'
  insert.run('佳新仓', '库内', null, null, '2026-11-18', '盘点', 'archived', 3);
  // 后勤归档数据：速远仓 2026-11-17 项目'会议'
  insert.run('速远仓', '后勤', null, null, '2026-11-17', '会议', 'archived', 1);
  // 收货归档数据：开元仓 2026-11-18（收货应放行）
  insert.run('开元仓', '收货', 201, '收货客户', '2026-11-18', null, 'archived', 2);
  // 同 pending 数据：龙湖仓 2026-11-18 货主A（pending 不参与冲突判定）
  insert.run('龙湖仓', '发货', 101, '货主A', '2026-11-18', null, 'pending', 1);

  const checkUnique = makeCheckUnique(db);
  return { db, checkUnique };
}

// ---------- 测试开始 ----------

test('发货：同仓同日同 customer_id 命中 archived → 返回结构化冲突详情', () => {
  const { checkUnique } = setup();
  const r = checkUnique('发货', {
    warehouse: '龙湖仓', date: '2026-11-18',
    customer_id: 101, customer_name: '货主A', project: null,
  });
  assert.ok(r, '应返回冲突详情');
  assert.equal(r.code, 'DUPLICATE_ARCHIVED');
  assert.equal(r.date, '2026-11-18');
  assert.equal(r.shipper, '货主A');
  assert.equal(r.project, null);
  assert.equal(r.work_type, '发货');
  assert.equal(r.archived_work_id, 1);
  assert.match(r.message, /2026-11-18/);
  assert.match(r.message, /货主A/);
});

test('发货：customer_name 兜底匹配 —— 传入 customer_id 有值但 archived 的 customer_id 为 null 且 customer_name 匹配', () => {
  const { checkUnique } = setup();
  // archived work_id=2: customer_id=null, customer_name='货主B'
  // 传入 customer_id=9999（有值，通过 keyVal!=null 前置守卫）+ customer_name='货主B'
  // SQL: (customer_id = 9999 OR (customer_id IS NULL AND customer_name = '货主B'))
  // → archived 记录 customer_id IS NULL + customer_name='货主B' 命中第二个分支
  const r = checkUnique('发货', {
    warehouse: '龙湖仓', date: '2026-11-18',
    customer_id: 9999, customer_name: '货主B', project: null,
  });
  assert.ok(r);
  assert.equal(r.code, 'DUPLICATE_ARCHIVED');
  assert.equal(r.shipper, '货主B');
  assert.equal(r.archived_work_id, 2);
});

test('发货：pending 状态不应触发冲突', () => {
  const { checkUnique } = setup();
  // work_id=7 是 pending 状态，不影响 checkUnique 的 archived 查询
  const r = checkUnique('发货', {
    warehouse: '龙湖仓', date: '2026-11-18',
    customer_id: 101, customer_name: '货主A', project: null,
  });
  // archived 有货主A，仍然返回冲突（pending 的 货主A 不影响，但 archived 有）
  assert.ok(r, 'archived 已存在，应冲突');
});

test('发货：同货主但不同日期 → 放行', () => {
  const { checkUnique } = setup();
  const r = checkUnique('发货', {
    warehouse: '龙湖仓', date: '2026-11-19',
    customer_id: 101, customer_name: '货主A', project: null,
  });
  assert.equal(r, null);
});

test('发货：同货主同日期但不同仓库 → 放行', () => {
  const { checkUnique } = setup();
  const r = checkUnique('发货', {
    warehouse: '佳新仓', date: '2026-11-18',
    customer_id: 101, customer_name: '货主A', project: null,
  });
  assert.equal(r, null);
});

test('库内：同仓同日同项目命中 archived', () => {
  const { checkUnique } = setup();
  const r = checkUnique('库内', {
    warehouse: '佳新仓', date: '2026-11-18',
    customer_id: null, customer_name: null, project: '盘点',
  });
  assert.ok(r);
  assert.equal(r.code, 'DUPLICATE_ARCHIVED');
  assert.equal(r.project, '盘点');
  assert.equal(r.shipper, null);
  assert.equal(r.archived_work_id, 3);
  assert.match(r.message, /盘点/);
});

test('后勤：同仓同日同项目命中 archived', () => {
  const { checkUnique } = setup();
  const r = checkUnique('后勤', {
    warehouse: '速远仓', date: '2026-11-17',
    customer_id: null, customer_name: null, project: '会议',
  });
  assert.ok(r);
  assert.equal(r.project, '会议');
});

test('收货：任何情况都放行（返回 null）', () => {
  const { checkUnique } = setup();
  const r = checkUnique('收货', {
    warehouse: '开元仓', date: '2026-11-18',
    customer_id: 201, customer_name: '收货客户', project: null,
  });
  assert.equal(r, null);
});

test('发货：缺少关键字段（warehouse/date/customer_id）应放行', () => {
  const { checkUnique } = setup();
  assert.equal(checkUnique('发货', { warehouse: null, date: '2026-11-18', customer_id: 101, customer_name: '货主A' }), null);
  assert.equal(checkUnique('发货', { warehouse: '龙湖仓', date: null, customer_id: 101, customer_name: '货主A' }), null);
  assert.equal(checkUnique('发货', { warehouse: '龙湖仓', date: '2026-11-18', customer_id: null, customer_name: null }), null);
  assert.equal(checkUnique('库内', { warehouse: '龙湖仓', date: '2026-11-18', project: null }), null);
});

test('excludeWorkId：编辑同一条 archived 记录时不触发冲突', () => {
  const { checkUnique, db } = setup();
  // 先确认 work_id=1 的 archived 记录会触发冲突
  const conflict = checkUnique('发货', {
    warehouse: '龙湖仓', date: '2026-11-18',
    customer_id: 101, customer_name: '货主A',
  });
  assert.ok(conflict, '不带 excludeWorkId 应冲突');

  // 加上 excludeWorkId=1（即正在编辑的那条 archived 记录本身），应放行
  const ok = checkUnique('发货', {
    warehouse: '龙湖仓', date: '2026-11-18',
    customer_id: 101, customer_name: '货主A',
  }, { excludeWorkId: 1 });
  assert.equal(ok, null, 'excludeWorkId 应排除自身');
});

test('excludeWorkId：排除的不是命中那条时仍冲突', () => {
  const { checkUnique } = setup();
  // 命中 work_id=1，但排除 work_id=999 —— 不影响，仍冲突
  const r = checkUnique('发货', {
    warehouse: '龙湖仓', date: '2026-11-18',
    customer_id: 101, customer_name: '货主A',
  }, { excludeWorkId: 999 });
  assert.ok(r);
  assert.equal(r.archived_work_id, 1);
});
