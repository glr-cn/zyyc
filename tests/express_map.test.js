// ============================================================================
// 物流映射服务单元测试（services/expressMap.js）
// 覆盖：默认映射自举 / 编码解析（大小写、未知原样）/ 新增 / 编辑 / 删除 /
//       重复校验 / 恢复默认 / 边界（空编码、非法字符、超长名称）
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db/driver');
const expressMap = require('../src/services/expressMap');

function setup() {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  return db;
}

test('getItems: 空库首次读取自动写入 6 条默认映射', () => {
  const db = setup();
  const items = expressMap.getItems(db);
  assert.equal(items.length, 6);
  const codes = items.map((x) => x.code);
  assert.deepEqual(codes, ['STO', 'ZTO', 'YTO4', 'YTO5', 'SF', 'DBKD']);
  assert.equal(items.find((x) => x.code === 'STO').name, '申通快递');
  // 再次读取走库内配置，不重复写入
  const again = expressMap.getItems(db);
  assert.equal(again.length, 6);
  db.close();
});

test('createResolver: 编码忽略大小写转名称，名称原样，未知保留，空返回空串', () => {
  const db = setup();
  const resolve = expressMap.createResolver(db);
  assert.equal(resolve('STO'), '申通快递');
  assert.equal(resolve('sto'), '申通快递');
  assert.equal(resolve(' yto4 '), '圆通快递4');
  assert.equal(resolve('申通快递'), '申通快递');
  assert.equal(resolve('JTSD'), 'JTSD');
  assert.equal(resolve(''), '');
  assert.equal(resolve(null), '');
  db.close();
});

test('addItem: 新增后立即生效（无需缓存刷新）', () => {
  const db = setup();
  const items = expressMap.addItem(db, { code: 'jtsd', name: '极兔速递' });
  assert.equal(items.length, 7);
  assert.equal(items.find((x) => x.code === 'JTSD').name, '极兔速递');
  const resolve = expressMap.createResolver(db);
  assert.equal(resolve('JTSD'), '极兔速递');
  db.close();
});

test('addItem: 编码重复 / 名称重复 / 空值 / 非法字符 → 抛业务错误', () => {
  const db = setup();
  assert.throws(() => expressMap.addItem(db, { code: 'sto', name: '另一个申通' }), /编码已存在/);
  assert.throws(() => expressMap.addItem(db, { code: 'NEW1', name: '申通快递' }), /名称已存在/);
  assert.throws(() => expressMap.addItem(db, { code: '', name: '空编码' }), /编码不能为空/);
  assert.throws(() => expressMap.addItem(db, { code: 'A B', name: '带空格' }), /只能包含/);
  assert.throws(() => expressMap.addItem(db, { code: 'OK1', name: '   ' }), /名称不能为空/);
  assert.throws(() => expressMap.addItem(db, { code: 'OK2', name: 'x'.repeat(41) }), /不能超过/);
  db.close();
});

test('updateItem: 可同时改编码与名称；不存在 → 抛错', () => {
  const db = setup();
  const items = expressMap.updateItem(db, 'SF', { code: 'SFEX', name: '顺丰速运' });
  const hit = items.find((x) => x.code === 'SFEX');
  assert.ok(hit);
  assert.equal(hit.name, '顺丰速运');
  assert.throws(() => expressMap.updateItem(db, 'NOPE', { code: 'X1', name: 'x' }), /映射不存在/);
  db.close();
});

test('removeItem: 删除后解析回退原样；删除不存在 → 抛错', () => {
  const db = setup();
  const items = expressMap.removeItem(db, 'zto');
  assert.equal(items.length, 5);
  assert.ok(!items.some((x) => x.code === 'ZTO'));
  assert.equal(expressMap.createResolver(db)('ZTO'), 'ZTO');
  assert.throws(() => expressMap.removeItem(db, 'ZTO'), /映射不存在/);
  db.close();
});

test('resetDefaults: 清空自定义配置并恢复 6 条默认', () => {
  const db = setup();
  expressMap.addItem(db, { code: 'JTSD', name: '极兔速递' });
  expressMap.removeItem(db, 'SF');
  const items = expressMap.resetDefaults(db);
  assert.equal(items.length, 6);
  assert.deepEqual(items.map((x) => x.code), ['STO', 'ZTO', 'YTO4', 'YTO5', 'SF', 'DBKD']);
  db.close();
});

test('getItems: 库内存量配置优先于默认值（不覆盖用户配置）', () => {
  const db = setup();
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('express_map',?)")
    .run(JSON.stringify([{ code: 'ONLY', name: '唯一配置' }]));
  const items = expressMap.getItems(db);
  assert.equal(items.length, 1);
  assert.equal(items[0].code, 'ONLY');
  db.close();
});
