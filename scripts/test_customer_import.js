// 仓储客户 Excel 导入纯逻辑单测（无需数据库 / 无需启动服务）
// 覆盖：严格表头、乱序表头、空行行号、18 字段映射、必填校验、多仓归一化、时间/布尔/精度转换、模板回读
const assert = require('assert');
const xlsx = require('xlsx');
const S = require('../src/services/customerImport');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fails.push({ name, msg: e.message }); console.log('FAIL ' + name + ' -> ' + e.message); }
}
function buf(headers, rows) {
  const ws = xlsx.utils.aoa_to_sheet([headers, ...rows]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function goodRow(overrides = {}) {
  const base = {
    货主代码: 'C0001', 公司全称: '示例客户有限公司', 客户简称: '示例', 所在仓库: '龙湖仓,佳新仓',
    客户联系人: '张三', 联系电话: '13800000000', 客户地址: '上海市浦东新区',
    ERP版本名称: '旺店通', 产品类型: '日用百货', 电商平台: '淘宝,抖音', 商品种类数: 120,
    打款账户: '6222****1234', 预充单价: 0.35, 截单时间: '16:00', 物流公司控制: '申通',
    效期管理: '是', 合作状态: '合作中', 备注: '测试',
  };
  return Object.assign(base, overrides);
}
function sheetFrom(rows) {
  return buf(S.HEADERS, rows.map((r) => S.HEADERS.map((h) => (r[h] == null ? '' : r[h]))));
}
function firstParsed(rows) {
  const items = S.readSheet(sheetFrom(rows));
  return { items, result: S.parseRow(items[0].raw) };
}

// ---------- 1. 表头严格校验 ----------
t('HEADERS 恰为 18 列且无重复', () => {
  assert.strictEqual(S.HEADERS.length, 18);
  assert.strictEqual(new Set(S.HEADERS).size, 18);
});
t('合法表头 → 1 行数据，excelRow=2', () => {
  const items = S.readSheet(sheetFrom([goodRow()]));
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].excelRow, 2);
  assert.strictEqual(items[0].raw['公司全称'], '示例客户有限公司');
});
t('表头允许乱序，按表头名映射', () => {
  const shuffled = S.HEADERS.slice().reverse();
  const b = buf(shuffled, [shuffled.map((h) => goodRow()[h] || '')]);
  const items = S.readSheet(b);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(S.parseRow(items[0].raw).row.customer_code, 'C0001');
});
t('缺列 → 抛错且列出缺失列名', () => {
  const h = S.HEADERS.filter((x) => x !== '预充单价');
  assert.throws(() => S.readSheet(buf(h, [])), /表头不匹配.*缺少.*预充单价/);
});
t('多余未知列 → 抛错且列出列名', () => {
  assert.throws(() => S.readSheet(buf([...S.HEADERS, '多余列'], [])), /未知列.*多余列/);
});
t('重复表头列 → 抛错', () => {
  assert.throws(() => S.readSheet(buf([...S.HEADERS, '备注'], [])), /重复列/);
});
t('空表 / 仅表头 → 返回空数组', () => {
  assert.deepStrictEqual(S.readSheet(sheetFrom([])), []);
});
t('空行被跳过且保留真实 Excel 行号', () => {
  const rows = [goodRow(), {}, goodRow({ 货主代码: 'C0002' })];
  const b = buf(S.HEADERS, [
    S.HEADERS.map((h) => rows[0][h] ?? ''),
    S.HEADERS.map(() => ''),
    S.HEADERS.map((h) => rows[2][h] ?? ''),
  ]);
  const items = S.readSheet(b);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].excelRow, 2);
  assert.strictEqual(items[1].excelRow, 4);
  assert.strictEqual(items[1].raw['货主代码'], 'C0002');
});
t('非 Excel 内容 → 抛「文件解析失败」', () => {
  assert.throws(() => S.readSheet(Buffer.from('not an excel')), /文件解析失败/);
});

// ---------- 2. 合法行完整映射 ----------
t('合法行 → row 含 18 个字段且值正确', () => {
  const { result } = firstParsed([goodRow()]);
  assert.ok(!result.error, result.error);
  const r = result.row;
  assert.strictEqual(Object.keys(r).length, 18);
  assert.strictEqual(r.customer_code, 'C0001');
  assert.strictEqual(r.company_name, '示例客户有限公司');
  assert.strictEqual(r.warehouse, '龙湖仓,佳新仓');
  assert.strictEqual(r.product_count, 120);
  assert.strictEqual(r.prepaid_price, 0.35);
  assert.strictEqual(r.cutoff_time, '16:00');
  assert.strictEqual(r.expiry_mgmt, '是');
  assert.strictEqual(r.coop_status, '合作中');
});
t('预充单价按 round3 归一（0.12345 → 0.123）', () => {
  const { result } = firstParsed([goodRow({ 预充单价: 0.12345 })]);
  assert.strictEqual(result.row.prepaid_price, 0.123);
});
t('选填项留空 → 空串/0/否/默认合作中', () => {
  const { result } = firstParsed([goodRow({
    客户简称: '', 客户联系人: '', 联系电话: '', 客户地址: '', ERP版本名称: '', 产品类型: '',
    电商平台: '', 商品种类数: '', 打款账户: '', 预充单价: '', 截单时间: '',
    物流公司控制: '', 效期管理: '', 合作状态: '', 备注: '',
  })]);
  assert.ok(!result.error, result.error);
  assert.strictEqual(result.row.product_count, 0);
  assert.strictEqual(result.row.prepaid_price, 0);
  assert.strictEqual(result.row.cutoff_time, null);
  assert.strictEqual(result.row.expiry_mgmt, '否');
  assert.strictEqual(result.row.coop_status, '合作中');
});

// ---------- 3. 必填校验 / 失败清单素材 ----------
t('公司全称/所在仓库同时为空 → 两条原因（货主代码已改为选填）', () => {
  const { result } = firstParsed([goodRow({ 公司全称: '', 所在仓库: '' })]);
  assert.ok(result.error);
  assert.ok(result.error.includes('公司全称为空'));
  assert.ok(result.error.includes('所在仓库为空'));
  assert.ok(!result.error.includes('货主代码'));
});
t('货主代码为空仍可通过（按公司全称 Upsert），且存 NULL', () => {
  const { result } = firstParsed([goodRow({ 货主代码: '' })]);
  assert.ok(!result.error, result.error);
  assert.strictEqual(result.row.customer_code, null);
  assert.strictEqual(result.row.company_name, '示例客户有限公司');
});
t('requireWarehouse=false（共享单号/快运物流）允许仓库为空', () => {
  const b = buf(S.HEADERS, [S.HEADERS.map((h) => (h === '所在仓库' ? '' : goodRow()[h] ?? ''))]);
  const items = S.readSheet(b);
  const r = S.parseRow(items[0].raw, { requireWarehouse: false });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.row.warehouse, '');
});
t('公司全称为空 → 报错', () => {
  assert.ok(firstParsed([goodRow({ 公司全称: '   ' })]).result.error.includes('公司全称为空'));
});
t('非法仓名 → 报错并列出仓名', () => {
  assert.ok(firstParsed([goodRow({ 所在仓库: '龙湖仓,火星仓' })]).result.error.includes('火星仓'));
});
t('商品种类数为小数/负数/文本 → 报错', () => {
  [1.5, -1, 'abc'].forEach((v) => {
    assert.ok(firstParsed([goodRow({ 商品种类数: v })]).result.error.includes('商品种类数必须为非负整数'));
  });
});
t('预充单价为负/文本 → 报错', () => {
  [-1, 'abc'].forEach((v) => {
    assert.ok(firstParsed([goodRow({ 预充单价: v })]).result.error.includes('预充单价必须为非负数字'));
  });
});
t('截单时间非法 → 报错', () => {
  ['25:00', '16点', '1660'].forEach((v) => {
    assert.ok(firstParsed([goodRow({ 截单时间: v })]).result.error.includes('截单时间格式'));
  });
});
t('效期管理非法值 → 报错', () => {
  assert.ok(firstParsed([goodRow({ 效期管理: '也许' })]).result.error.includes('效期管理应为 是/否'));
});
t('合作状态非法 → 报错', () => {
  assert.ok(firstParsed([goodRow({ 合作状态: '已跑路' })]).result.error.includes('合作状态非法'));
});

// ---------- 4. 归一化函数 ----------
t('多仓分隔符归一化：中文顿号/逗号/分号/空白 → 英文逗号', () => {
  assert.strictEqual(S.normalizeWarehouse('龙湖仓、佳新仓，速远仓；开元仓').value, '龙湖仓,佳新仓,速远仓,开元仓');
  assert.strictEqual(S.normalizeWarehouse('龙湖仓 / 佳新仓').value, '龙湖仓,佳新仓');
});
t('多仓重复值去重', () => {
  assert.strictEqual(S.normalizeWarehouse('龙湖仓,龙湖仓').value, '龙湖仓');
});
t('截单时间：中文冒号 / 数字时间 / Date', () => {
  assert.strictEqual(S.parseCutoff('16：00'), '16:00');
  assert.strictEqual(S.parseCutoff(16 / 24), '16:00');
  assert.strictEqual(S.parseCutoff(new Date(2026, 0, 1, 9, 5)), '09:05');
  assert.strictEqual(S.parseCutoff(''), null);
});
t('效期管理：多种等价写法归一为 是/否', () => {
  ['是', '√', 'Y', 'TRUE', '1', '有'].forEach((v) => assert.strictEqual(S.parseYesNo(v), '是'));
  ['否', '×', 'N', 'FALSE', '0', '无', ''].forEach((v) => assert.strictEqual(S.parseYesNo(v), '否'));
  assert.strictEqual(S.parseYesNo('未知'), null);
});

// ---------- 5. 模板可回读 ----------
t('buildTemplate 生成的表头与 HEADERS 一致且可回读', () => {
  const b = S.buildTemplate(true);
  assert.ok(Buffer.isBuffer(b) && b.length > 1000);
  const items = S.readSheet(b);
  assert.strictEqual(items.length, 1);
  const r = S.parseRow(items[0].raw);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.row.customer_code, 'C0001');
  assert.strictEqual(r.row.warehouse, '龙湖仓,佳新仓');
});
t('buildTemplate(false) 仅表头无数据行', () => {
  assert.deepStrictEqual(S.readSheet(S.buildTemplate(false)), []);
});

console.log('\n' + '='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  fails.forEach((f) => console.log('  - ' + f.name + ': ' + f.msg));
  process.exit(1);
}
