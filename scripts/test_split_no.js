// ============================================================
//  分列单号（快捷工具）单元测试
//  用法：node scripts/test_split_no.js
//  覆盖：正常粘贴 / Excel 整列 / 各类分隔符 / 引号 / 前导零 / 异常与空值 /
//        去重 / 每批上限归一化 / 切批边界（整除、末批、超上限、空列表）
// ============================================================
'use strict';

// ---------------- 极简 window 桩（页面模块只在 mount 时用 DOM，纯逻辑可直接 require） ----------------
global.window = global.window || {};
require('../public/js/tools-split-no.js');
const S = global.window.ERP_SPLIT_NO;

let failed = 0;
let passed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('PASS: ' + msg); }
  else { failed++; console.error('FAIL: ' + msg + '\n  期望 ' + e + '\n  实际 ' + a); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

// ============ 0. 模块暴露 ============
ok(S && typeof S.parseTokens === 'function', '模块已挂载 window.ERP_SPLIT_NO');
ok(typeof global.window.ERP_PAGES.tool_split_no === 'function', '页面已注册 ERP_PAGES.tool_split_no');

// ============ 1. 解析：空值与空白 ============
eq(S.parseTokens(null), [], 'null → 空数组');
eq(S.parseTokens(undefined), [], 'undefined → 空数组');
eq(S.parseTokens(''), [], '空串 → 空数组');
eq(S.parseTokens('   \n\t\r\n  '), [], '纯空白（含换行/制表符）→ 空数组');
eq(S.parseTokens('\n\n\n'), [], '多个空行 → 空数组');

// ============ 2. 解析：正常换行粘贴 ============
eq(S.parseTokens('770355929553619\n770355931016546'), ['770355929553619', '770355931016546'],
  '每行一个单号');
eq(S.parseTokens('770355929553619\r\n770355931016546\r\n'), ['770355929553619', '770355931016546'],
  'Windows CRLF 换行');

// ============ 3. 解析：Excel 整列 / 各类分隔符 ============
eq(S.parseTokens('7701\t7702\t7703'), ['7701', '7702', '7703'], '制表符（Excel 整列复制）');
eq(S.parseTokens('7701,7702,7703'), ['7701', '7702', '7703'], '英文逗号');
eq(S.parseTokens('7701，7702，7703'), ['7701', '7702', '7703'], '中文逗号');
eq(S.parseTokens('7701;7702；7703'), ['7701', '7702', '7703'], '中英文分号混用');
eq(S.parseTokens('7701、7702'), ['7701', '7702'], '顿号');
eq(S.parseTokens('7701 7702   7703'), ['7701', '7702', '7703'], '连续空格');
eq(S.parseTokens(' 7701 , 7702 \n\t 7703 '), ['7701', '7702', '7703'], '分隔符两侧带空白');

// ============ 4. 解析：引号包裹（Excel 复制常见） ============
eq(S.parseTokens('"7701"\n"7702"'), ['7701', '7702'], '英文双引号剔除');
eq(S.parseTokens("'7703'"), ['7703'], '英文单引号剔除');
eq(S.parseTokens('“7704”\n‘7705’'), ['7704', '7705'], '中文引号剔除');
eq(S.parseTokens('""'), [], '仅一对引号 → 空数组');

// ============ 5. 解析：原样保留（不补零 / 不改大小写 / 保留连字符） ============
eq(S.parseTokens('000123'), ['000123'], '前导零原样保留，不补零、不转数字');
eq(S.parseTokens('SF-1234567890'), ['SF-1234567890'], '字母 + 连字符单号原样保留');
eq(S.parseTokens('sf123'), ['sf123'], '小写字母原样保留（不改大小写）');
eq(S.parseTokens('7703559295536190000000000000001'), ['7703559295536190000000000000001'],
  '超长数字串不丢精度（不走 Number 转换）');

// ============ 6. 解析：异常格式与特殊字符（健壮性） ============
eq(S.parseTokens('---\n@@@\n*'), ['---', '@@@', '*'], '纯符号不崩溃、原样保留');
eq(S.parseTokens('7701\n\n7702'), ['7701', '7702'], '中间空行被忽略');
eq(S.parseTokens(7701), ['7701'], '非字符串入参（数字）也能处理');

// ============ 7. 去重（保留首次出现顺序） ============
eq(S.dedupeKeepOrder(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c'], '去重且保持首次出现顺序');
eq(S.dedupeKeepOrder([]), [], '空数组去重');
eq(S.dedupeKeepOrder(null), [], 'null 去重 → 空数组');
eq(S.dedupeKeepOrder(['7701', '7701']), ['7701'], '重复单号去重');

// ============ 8. 每批上限归一化 ============
eq(S.normalizeBatchSize(500), 500, '正常值 500');
eq(S.normalizeBatchSize('250'), 250, '字符串数字 250');
eq(S.normalizeBatchSize('250.9'), 250, '小数向下取整 250');
eq(S.normalizeBatchSize(0), 500, '0 → 默认 500');
eq(S.normalizeBatchSize(-10), 500, '负数 → 默认 500');
eq(S.normalizeBatchSize(''), 500, '空串 → 默认 500');
eq(S.normalizeBatchSize('abc'), 500, '非数字 → 默认 500');
eq(S.normalizeBatchSize(null), 500, 'null → 默认 500');
eq(S.normalizeBatchSize(20000), 10000, '超过上限 10000 → 截断到 10000');
eq(S.normalizeBatchSize(undefined, 300), 300, '自定义兜底值 300');

// ============ 9. 切批：参考截图的真实规模（11867 个 / 500 一批 = 24 批，末批 367） ============
const bigList = Array.from({ length: 11867 }, (_, i) => '77' + String(i + 1).padStart(13, '0'));
const bigBatches = S.buildBatches(bigList, 500);
eq(bigBatches.length, 24, '11867 个 / 每批 500 → 共 24 批');
eq(bigBatches[0].index, 1, '第 1 批批号为 1');
eq([bigBatches[0].from, bigBatches[0].to, bigBatches[0].count], [1, 500, 500],
  '第 1 批区间 1-500，数量 500');
eq([bigBatches[1].from, bigBatches[1].to], [501, 1000], '第 2 批区间 501-1000');
eq(bigBatches[23].index, 24, '末批批号 24');
eq([bigBatches[23].from, bigBatches[23].to, bigBatches[23].count], [11501, 11867, 367],
  '末批区间 11501-11867，数量 367（不满批）');

// 守恒校验：批内数量之和 = 总数；每批 from/to/count 自洽；拼接结果与源列表一致
eq(bigBatches.reduce((s, b) => s + b.count, 0), 11867, '各批数量之和 = 总单号数（不丢单）');
ok(bigBatches.every((b) => b.to - b.from + 1 === b.count), '每批 to-from+1 === count（区间与数量自洽）');
ok(bigBatches.every((b, i) => i === 0 || b.from === bigBatches[i - 1].to + 1), '批次之间首尾相接、无缝隙');
eq([].concat(...bigBatches.map((b) => b.items)), bigList, '所有批次拼接后与原列表完全一致（顺序/内容不丢）');

// ============ 10. 切批：边界 ============
eq(S.buildBatches([], 500), [], '空列表 → 0 批');
eq(S.buildBatches(null, 500), [], 'null 列表 → 0 批');
eq(S.buildBatches(['a'], 500).length, 1, '1 个单号 → 1 批');
eq(S.buildBatches(['a'], 500)[0].count, 1, '1 个单号 → 该批数量 1');
const exact = S.buildBatches(Array.from({ length: 1000 }, (_, i) => 'n' + i), 500);
eq(exact.length, 2, '1000 个 / 500 → 整除 2 批');
eq(exact[1].count, 500, '整除时末批为满批 500');
const small = S.buildBatches(['a', 'b', 'c'], 10000);
eq([small.length, small[0].from, small[0].to], [1, 1, 3], '上限大于总数 → 单批覆盖全部');
const oneEach = S.buildBatches(['a', 'b', 'c'], 1);
eq(oneEach.map((b) => b.count), [1, 1, 1], '每批上限 1 → 每个单号单独一批');
eq(oneEach.map((b) => b.from), [1, 2, 3], '每批上限 1 时序号区间为 1/2/3');

// ============ 11. 疑似异常单号预警 ============
ok(S.isSuspiciousToken('---'), '纯符号 → 疑似异常');
ok(!S.isSuspiciousToken('7701'), '纯数字 → 正常');
ok(!S.isSuspiciousToken('SF-123'), '字母数字混合 → 正常');
ok(!S.isSuspiciousToken('龙湖仓单号'), '中文单号 → 正常（不误判）');
eq(S.countSuspicious(['7701', '---', '@@@', 'SF-1']), 2, '疑似异常计数 = 2');

// ============ 12. 端到端：Excel 粘贴文本 → 拆号 → 去重 → 切批 ============
const pasted = [
  '"770355929553619"\t"770355931016546"',
  '770355949984264,770355953851307，7703559538551551',
  '',
  '7703559538551551',        // 与上面重复
  '770355960509520\r',
].join('\n');
const parsed = S.parseTokens(pasted);
eq(parsed, ['770355929553619', '770355931016546', '770355949984264',
  '770355953851307', '7703559538551551', '7703559538551551', '770355960509520'],
  '混合格式粘贴 → 7 个单号（含 1 个重复）');
const deduped = S.dedupeKeepOrder(parsed);
eq(deduped.length, 6, '去重后 6 个');
const e2e = S.buildBatches(deduped, 2);
eq(e2e.map((b) => b.count), [2, 2, 2], '6 个 / 每批 2 → 3 个满批');
eq(e2e.map((b) => b.from + '-' + b.to), ['1-2', '3-4', '5-6'], '端到端批次区间正确');

// ============ 结果 ============
console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed) process.exit(1);
console.log('=== 全部通过 ===');
