// ============================================================
//  条码设计（快捷工具）单元测试
//  用法：node scripts/test_barcode.js
//  覆盖：纸张尺寸 / 元素模型 / 画布边界 / 对齐 / 图层 / 复制 /
//        批量解析 / 序号生成 / 条码内容校验 / 模板序列化 / 单位换算
// ============================================================
'use strict';

global.window = global.window || {};
require('../public/js/tools-barcode.js');
const M = global.window.ERP_BC_MODEL;

let failed = 0;
let passed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('PASS: ' + msg); }
  else { failed++; console.error('FAIL: ' + msg + '\n  期望 ' + e + '\n  实际 ' + a); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

// ============ 0. 模块与页面暴露 ============
ok(M && typeof M.createElement === 'function', '模块已挂载 window.ERP_BC_MODEL');
ok(typeof global.window.ERP_PAGES.tool_barcode === 'function', '页面已注册 ERP_PAGES.tool_barcode');

// ============ 1. 纸张 ============
const def = M.createLabel();
eq([def.widthMm, def.heightMm], [60, 40], '默认纸张 60 × 40 mm');
eq(def.elements, [], '默认画布无元素');
eq(M.sanitizeSize(50), 50, '合法宽度 50 保持');
eq(M.sanitizeSize(5), 10, '过小尺寸（5）→ 下限 10');
eq(M.sanitizeSize(500), 300, '过大尺寸（500）→ 上限 300');
eq(M.sanitizeSize('abc', 60), 60, '非法尺寸 → 兜底值');
eq(M.sanitizeSize(33.33), 33.3, '尺寸保留 1 位小数');
eq(M.LABEL_PRESETS.length >= 6, true, '内置纸张预设不少于 6 种');

// ============ 2. 元素创建 ============
['text', 'barcode', 'qrcode', 'pdf417', 'datamatrix', 'rect', 'ellipse', 'line', 'image'].forEach((type) => {
  const el = M.createElement(type);
  eq(el.type, type, '可创建元素类型：' + type);
  ok(typeof el.id === 'string' && el.id.length > 0, type + ' 自带唯一 id');
});
const e1 = M.createElement('text');
const e2 = M.createElement('text');
ok(e1.id !== e2.id, '两次创建 id 不重复');
eq([e1.fontSize, e1.align, e1.letterSpacing, e1.lineHeight], [10, 'center', 0, 1.2], '文字默认属性');
eq([e1.rotation, e1.locked, e1.isVar], [0, false, false], '元素默认未旋转/未锁定/非变量');
const bc = M.createElement('barcode');
eq([bc.symbology, bc.includetext, bc.color], ['code128', true, '#000000'], '条形码默认 Code128 + 显示文字 + 黑色');
eq(M.createElement('qrcode').symbology, 'qrcode', '二维码默认码制');
eq(M.createElement('datamatrix').symbology, 'datamatrix', 'DataMatrix 默认码制');
eq(M.createElement('pdf417').symbology, 'pdf417', 'PDF417 默认码制');
eq(M.createElement('text', { text: 'B01', x: 5 }).text, 'B01', 'patch 覆盖默认值');

// ============ 3. 边界约束 ============
const label = M.createLabel({ widthMm: 60, heightMm: 40 });
eq(M.clampElement({ x: -5, y: -8, w: 20, h: 10 }, label), { x: 0, y: 0 }, '负坐标拉回 0');
eq(M.clampElement({ x: 100, y: 100, w: 20, h: 10 }, label), { x: 40, y: 30 }, '超出右下边界拉回纸内');
eq(M.clampElement({ x: 10.126, y: 20.238, w: 20, h: 10 }, label), { x: 10.13, y: 20.24 }, '坐标保留 2 位小数');
eq(M.clampElement({ x: 70, y: 5, w: 40, h: 5 }, label), { x: 20, y: 5 }, '超宽元素自动贴右边');

// ============ 4. 对齐 ============
const el = { x: 7, y: 7, w: 20, h: 10 };
eq(M.alignTo(el, label, 'left'), { x: 0, y: 7 }, '左对齐 → x=0');
eq(M.alignTo(el, label, 'hcenter'), { x: 20, y: 7 }, '水平居中 → x=20');
eq(M.alignTo(el, label, 'right'), { x: 40, y: 7 }, '右对齐 → x=40');
eq(M.alignTo(el, label, 'top'), { x: 7, y: 0 }, '顶对齐 → y=0');
eq(M.alignTo(el, label, 'vcenter'), { x: 7, y: 15 }, '垂直居中 → y=15');
eq(M.alignTo(el, label, 'bottom'), { x: 7, y: 30 }, '底对齐 → y=30');

// ============ 5. 图层顺序 ============
const layers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
eq(M.moveLayer(layers, 'a', 'up').map((x) => x.id), ['b', 'a', 'c'], '上移一层');
eq(M.moveLayer(layers, 'c', 'down').map((x) => x.id), ['a', 'c', 'b'], '下移一层');
eq(M.moveLayer(layers, 'c', 'up').map((x) => x.id), ['a', 'b', 'c'], '已在最上层，上移无效');
eq(M.moveLayer(layers, 'a', 'down').map((x) => x.id), ['a', 'b', 'c'], '已在最下层，下移无效');
eq(layers.map((x) => x.id), ['a', 'b', 'c'], 'moveLayer 不修改原数组');
eq(M.moveLayer(layers, 'zzz', 'up').map((x) => x.id), ['a', 'b', 'c'], '不存在的 id 不报错');

// ============ 6. 复制元素 ============
const src = [{ id: 'x', x: 5, y: 5, w: 10, h: 10, type: 'text' }];
const dup = M.duplicateElement(src, 'x');
eq(dup.length, 2, '复制后元素数 +1');
ok(dup[1].id !== 'x', '复制体使用新 id');
eq([dup[1].x, dup[1].y], [7, 7], '复制体偏移 2mm');
eq(src.length, 1, '复制不修改原数组');

// ============ 7. 批量数据解析 ============
eq(M.parseBatch(null), [], 'null → 空');
eq(M.parseBatch(''), [], '空串 → 空');
eq(M.parseBatch('A\nB\nC'), [['A'], ['B'], ['C']], '每行一条');
eq(M.parseBatch('A\r\nB'), [['A'], ['B']], '兼容 CRLF');
eq(M.parseBatch('A\n\n\nB'), [['A'], ['B']], '空行忽略');
eq(M.parseBatch('A\tB\nC\tD'), [['A', 'B'], ['C', 'D']], 'Tab 分列（Excel 整列）');
eq(M.parseBatch('A,B\nC，D'), [['A', 'B'], ['C', 'D']], '中英文逗号分列');
eq(M.parseBatch('A;B\nC；D'), [['A', 'B'], ['C', 'D']], '中英文分号分列');
eq(M.parseBatch('  A  ,  B  '), [['A', 'B']], '列内容去首尾空格');

// ============ 8. 序号 ============
eq(M.buildSeries({ prefix: 'B', start: 1, step: 1, pad: 3, count: 3 }), ['B001', 'B002', 'B003'], '前缀 + 补零序号');
eq(M.buildSeries({ prefix: '', start: 98, step: 2, pad: 0, count: 3 }), ['98', '100', '102'], '步长 2、不补零');
eq(M.buildSeries({ prefix: 'N-', start: 1, step: 0, count: 2 }), ['N-1', 'N-2'], '步长 0 回退为 1');
eq(M.buildSeries({ count: 0 }), [], '数量 0 → 空');
eq(M.buildSeries({ prefix: 'X', start: 1, count: 99999 }).length, 5000, '数量上限 5000');
eq(M.buildSeries({ prefix: '', start: 1, pad: 99, count: 1 }), ['000000000001'], '补零位数上限 12（超出按 12 位补零）');
eq(M.buildSeries({ prefix: '', start: -2, step: 1, count: 2 }), ['-2', '-1'], '负数序号');

// ============ 9. 条码内容校验 ============
eq(M.validateContent('code128', 'B01-01'), null, 'Code128 字母数字合法');
eq(M.validateContent('code128', ''), '内容不能为空', '空内容报错');
eq(M.validateContent('code128', '中文内容'), 'Code 128 仅支持可见 ASCII 字符', 'Code128 拒绝中文');
eq(M.validateContent('ean13', '690123456789'), null, 'EAN-13 12 位合法');
eq(M.validateContent('ean13', '6901234567892'), null, 'EAN-13 13 位合法');
eq(M.validateContent('ean13', '69012345'), 'EAN-13 需 12 位（自动补校验位）或 13 位数字', 'EAN-13 位数不足报错');
eq(M.validateContent('ean13', '69012345678A'), 'EAN-13 需 12 位（自动补校验位）或 13 位数字', 'EAN-13 非数字报错');
eq(M.validateContent('ean8', '1234567'), null, 'EAN-8 7 位合法');
eq(M.validateContent('ean8', '123456'), 'EAN-8 需 7 位或 8 位数字', 'EAN-8 位数不足报错');
eq(M.validateContent('upca', '01234567890'), null, 'UPC-A 11 位合法');
eq(M.validateContent('itf14', '1234567890123'), null, 'ITF-14 13 位合法');
eq(M.validateContent('itf14', '123456789012'), 'ITF-14 需 13 位或 14 位数字', 'ITF-14 位数不足报错');
eq(M.validateContent('code39', 'ABC-123'), null, 'Code39 支持大写字母与连字符');
eq(M.validateContent('code39', 'abc'), 'Code 39 仅支持 0-9 A-Z - . 空格 $ / + %', 'Code39 拒绝小写');
eq(M.validateContent('qrcode', '任意中文内容'), null, '二维码允许任意内容');
eq(M.validateContent('datamatrix', 'DM-001'), null, 'DataMatrix 允许字母数字');
eq(M.validateContent('pdf417', 'PDF417-TEST'), null, 'PDF417 允许字母数字');

// ============ 10. 模板序列化 ============
const tpl = M.createLabel({ widthMm: 50, heightMm: 30 });
tpl.elements.push(M.createElement('barcode', { x: 3, y: 3 }));
const json = M.serializeLabel(tpl);
const back = M.parseLabel(json);
eq([back.widthMm, back.heightMm], [50, 30], '模板往返：纸张尺寸保持');
eq(back.elements.length, 1, '模板往返：元素数量保持');
eq([back.elements[0].symbology, back.elements[0].x], ['code128', 3], '模板往返：元素属性保持');
eq(M.parseLabel('not-json'), null, '非法 JSON → null');
eq(M.parseLabel('{}'), null, '缺 elements → null');
eq(M.parseLabel('{"elements":[{"id":"a"},{"type":"text"}]}').elements.length, 1, '过滤缺 type 的脏元素');
eq(M.parseLabel({ elements: [] }).widthMm, 60, '缺纸张尺寸 → 默认 60');

// ============ 11. 单位换算 ============
ok(Math.abs(M.PX_PER_MM - 3.7795275590551185) < 0.0001, 'PX_PER_MM = 96 / 25.4');
eq(M.r2(M.mmToPx(10, 1)), 37.8, '10mm @100% ≈ 37.8px');
eq(M.r2(M.pxToMm(37.8, 1)), 10, '37.8px → 10mm');
eq(M.r2(M.mmToPx(10, 2)), 75.59, '10mm @200% 翻倍');
eq(M.r1(10.049), 10, 'r1 四舍五入到 1 位');
eq(M.r2(10.005), 10.01, 'r2 四舍五入到 2 位');

// ============ 结果 ============
console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed) process.exit(1);
console.log('=== 全部通过 ===');
