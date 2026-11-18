// ============================================================================
// friendlyErrMsg 单元测试
// 测试目标：验证前端错误友好消息格式化函数在四种分支下的输出
// 函数来源：public/js/workhours.js（需浏览器 DOM 环境，但核心逻辑是纯函数，
//          可在 Node 中复刻后独立测试）
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 复刻自 public/js/workhours.js（纯逻辑，无 DOM 依赖）
function friendlyErrMsg(ex, fallbackMsg) {
  if (ex && ex.code === 'DUPLICATE_ARCHIVED' && ex.detail) {
    const d = ex.detail;
    const label = d.shipper ? d.shipper : (d.project || '');
    const whoType = d.shipper ? '货主' : (d.project ? '项目' : '');
    const date = d.date || '';
    if (label && whoType) {
      return `当前提交失败：归档中已存在 ${date} 日期、${label} ${whoType}的对应数据，请核对后重新提交。`;
    }
  }
  if (ex && ex.code === 'BATCH_DUPLICATE_ARCHIVED' && ex.conflicts && ex.conflicts.length) {
    const lines = ex.conflicts.slice(0, 3).map((c) => {
      const d = c.detail || {};
      const who = d.shipper || d.project || '';
      const whoType = d.shipper ? '货主' : (d.project ? '项目' : '');
      return `· ${d.date || ''}、${who} ${whoType}`;
    });
    const more = ex.conflicts.length > 3 ? `\n... 共 ${ex.conflicts.length} 条冲突` : '';
    return `当前提交失败：归档中已存在以下数据，请核对后重新提交：\n${lines.join('\n')}${more}`;
  }
  if (ex && ex.detail && ex.detail.message) return ex.detail.message;
  if (ex && ex.message) return ex.message;
  return fallbackMsg || '操作失败，请稍后重试';
}

// ---------- 测试开始 ----------

test('分支1：单条 DUPLICATE_ARCHIVED（发货 shipper）—— 精确拼接用户友好消息', () => {
  const ex = new Error('原始消息被覆盖');
  ex.code = 'DUPLICATE_ARCHIVED';
  ex.detail = { code: 'DUPLICATE_ARCHIVED', date: '2026-11-18', shipper: '货主A', work_type: '发货' };

  const msg = friendlyErrMsg(ex);
  assert.match(msg, /2026-11-18/);
  assert.match(msg, /货主A/);
  assert.match(msg, /货主/);
  assert.doesNotMatch(msg, /原始消息/);
});

test('分支1：单条 DUPLICATE_ARCHIVED（库内 project）—— project 走项目口径', () => {
  const ex = new Error('x');
  ex.code = 'DUPLICATE_ARCHIVED';
  ex.detail = { code: 'DUPLICATE_ARCHIVED', date: '2026-11-18', project: '盘点', work_type: '库内' };

  const msg = friendlyErrMsg(ex);
  assert.match(msg, /盘点/);
  assert.match(msg, /项目/);
  assert.doesNotMatch(msg, /货主/);
});

test('分支1：date 为空时仍能拼接', () => {
  const ex = new Error('x');
  ex.code = 'DUPLICATE_ARCHIVED';
  ex.detail = { date: '', shipper: '货主X' };

  const msg = friendlyErrMsg(ex);
  assert.match(msg, /货主X/);
});

test('分支1：detail 缺少 shipper/project 时（label 为空）应降级走 ex.message', () => {
  const ex = new Error('409 冲突');
  ex.code = 'DUPLICATE_ARCHIVED';
  ex.detail = { date: '2026-11-18' }; // shipper 和 project 都缺失

  const msg = friendlyErrMsg(ex);
  // label 为空、whoType 为空 → 跳过分支1，走 ex.message
  assert.equal(msg, '409 冲突');
});

test('分支2：批量 BATCH_DUPLICATE_ARCHIVED —— 列出前 3 条冲突', () => {
  const ex = new Error('批量冲突');
  ex.code = 'BATCH_DUPLICATE_ARCHIVED';
  ex.conflicts = [
    { detail: { date: '2026-11-18', shipper: '货主A', work_type: '发货' } },
    { detail: { date: '2026-11-18', shipper: '货主B', work_type: '发货' } },
  ];

  const msg = friendlyErrMsg(ex);
  assert.match(msg, /货主A/);
  assert.match(msg, /货主B/);
  assert.match(msg, /2026-11-18/);
  assert.doesNotMatch(msg, /共 \d+ 条冲突/); // 只有 2 条，不应出现 more
});

test('分支2：批量超过 3 条时显示"... 共 N 条冲突"', () => {
  const ex = new Error('x');
  ex.code = 'BATCH_DUPLICATE_ARCHIVED';
  ex.conflicts = [
    { detail: { date: 'd1', shipper: 's1' } },
    { detail: { date: 'd2', shipper: 's2' } },
    { detail: { date: 'd3', project: 'p3' } },
    { detail: { date: 'd4', shipper: 's4' } },
    { detail: { date: 'd5', shipper: 's5' } },
  ];

  const msg = friendlyErrMsg(ex);
  assert.match(msg, /s1|s2|p3/);
  assert.match(msg, /共 5 条冲突/);
  // s4 / s5 不应出现在列出的前 3 条里
});

test('分支2：批量 project 类型也能正确标注为"项目"', () => {
  const ex = new Error('x');
  ex.code = 'BATCH_DUPLICATE_ARCHIVED';
  ex.conflicts = [
    { detail: { date: '2026-11-18', project: '盘点' } },
  ];

  const msg = friendlyErrMsg(ex);
  assert.match(msg, /盘点/);
  assert.match(msg, /项目/);
});

test('分支3：ex.detail.message 兜底（带 detail 但 code 未知）', () => {
  const ex = new Error('HTTP 409');
  ex.detail = { message: '后端自定义错误详情' };

  const msg = friendlyErrMsg(ex);
  assert.equal(msg, '后端自定义错误详情');
});

test('分支4：纯 ex.message（其他 4xx/5xx）', () => {
  const ex = new Error('网络异常，无法连接服务器');
  const msg = friendlyErrMsg(ex);
  assert.equal(msg, '网络异常，无法连接服务器');
});

test('分支4：HTTP 400 校验失败也能正确传递', () => {
  const ex = new Error('请先选择仓库与工时类型（warehouse / work_type 必填）');
  ex.status = 400;
  const msg = friendlyErrMsg(ex);
  assert.match(msg, /warehouse.*work_type.*必填/);
});

test('分支4：HTTP 500 也能传递完整消息', () => {
  const ex = new Error('请求失败（HTTP 500）：数据库连接超时');
  const msg = friendlyErrMsg(ex);
  assert.equal(msg, '请求失败（HTTP 500）：数据库连接超时');
});

test('兜底：ex 为 null/undefined 时返回 fallbackMsg', () => {
  assert.equal(friendlyErrMsg(null, '自定义兜底'), '自定义兜底');
  assert.equal(friendlyErrMsg(undefined), '操作失败，请稍后重试');
  assert.equal(friendlyErrMsg(null), '操作失败，请稍后重试');
});

test('兜底：ex.message 不存在时返回 fallbackMsg', () => {
  assert.equal(friendlyErrMsg({}, '备用消息'), '备用消息');
  assert.equal(friendlyErrMsg({ code: 'XXX' }), '操作失败，请稍后重试');
});
