// 物流报价「查看弹窗 Excel 表格 + 行内编辑」隔离库冒烟测试
// 验证：① GET /by-code 附加展示层清洗字段（不改原始值）② PUT /region 只更新目标行
//       ③ 校验（抛比/价格）④ 地址冲突拦截 ⑤ 业务数据零丢失
// 用法：node scripts/test_view_edit.js
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } }
const rules = (p) => JSON.stringify([{ weight: 1, price: p }, { weight: 2, price: p + 1 }, { weight: 40, price: p + 2 }]);

async function main() {
  const TMP = path.join(__dirname, '..', 'data', '__viewedit_' + Date.now() + '.db');
  process.env.ERP_DB_PATH = TMP;
  // 清空代理，避免 fetch 走本地代理
  delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy; delete process.env.https_proxy;

  execSync('node ' + JSON.stringify(path.join(__dirname, 'migrate_rbac.js')),
    { stdio: 'ignore', env: { ...process.env, ERP_DB_PATH: TMP } });

  // 直接写种子数据（含简称「山东」「杭州」，用于验证展示清洗）
  const d = new DatabaseSync(TMP);
  const ins = d.prepare('INSERT INTO logistics_quotes (network_name,express_code,province,city,district,volume_ratio,price_rules) VALUES (?,?,?,?,?,?,?)');
  ins.run('中通-山东', 'ZT-SD', '山东', '济南', '历下', 6000, rules(5));
  ins.run('中通-青岛', 'ZT-SD', '山东', '青岛', '市南', 6000, rules(7));
  d.close();

  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  const H = { 'Content-Type': 'application/json', 'X-ERP-Token': login.token };

  try {
    // ① 清洗字段：展示为全称，原始值不动
    const before = await (await fetch(base + '/api/logistics-quotes/by-code?code=ZT-SD', { headers: H })).json();
    ok('by-code 返回两行', (before.data || []).length === 2);
    const row0 = (before.data || []).find((r) => r.city === '济南');
    ok('展示层省份清洗 山东→山东省', row0 && row0.province_disp === '山东省');
    ok('展示层城市清洗 济南→济南市', row0 && row0.city_disp === '济南市');
    ok('展示层区县清洗 历下→历下区', row0 && row0.district_disp === '历下区');
    ok('原始 province 仍是「山东」（未回写）', row0 && row0.province === '山东');

    // ② 单行更新：改「济南/历下」行价格+抛比，青岛行不动
    const upd = await (await fetch(base + '/api/logistics-quotes/region', {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        express_code: 'ZT-SD',
        old: { province: '山东', city: '济南', district: '历下' },
        province: '山东', city: '济南', district: '历下',
        volume_ratio: 8000,
        price_rules: [{ weight: 1, price: 6.5 }, { weight: 2, price: 9 }],
      }),
    })).json();
    ok('单行更新成功', upd.success === true);
    const d2 = new DatabaseSync(TMP);
    const jinan = d2.prepare("SELECT * FROM logistics_quotes WHERE express_code='ZT-SD' AND city='济南'").get();
    const qingdao = d2.prepare("SELECT * FROM logistics_quotes WHERE express_code='ZT-SD' AND city='青岛'").get();
    ok('目标行抛比改为 8000', jinan && Number(jinan.volume_ratio) === 8000);
    ok('目标行价格已更新', jinan && JSON.parse(jinan.price_rules)[0].price === 6.5);
    ok('非目标行（青岛）完全未动', qingdao && Number(qingdao.volume_ratio) === 6000 && JSON.parse(qingdao.price_rules)[0].price === 7);
    ok('总行数仍为 2（未删未插）', d2.prepare("SELECT COUNT(*) c FROM logistics_quotes WHERE express_code='ZT-SD'").get().c === 2);
    d2.close();

    // ③ 校验：抛比非正整数被拒
    const bad1 = await (await fetch(base + '/api/logistics-quotes/region', {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        express_code: 'ZT-SD', old: { province: '山东', city: '济南', district: '历下' },
        province: '山东', city: '济南', district: '历下',
        volume_ratio: 0, price_rules: [{ weight: 1, price: 5 }],
      }),
    })).json();
    ok('抛比<=0 被拒', !!bad1.error && /抛比/.test(bad1.error));

    // ③b 校验：超范围重量被拒（价格格式严格一致）
    const bad2 = await (await fetch(base + '/api/logistics-quotes/region', {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        express_code: 'ZT-SD', old: { province: '山东', city: '济南', district: '历下' },
        province: '山东', city: '济南', district: '历下',
        volume_ratio: 6000, price_rules: [{ weight: 41, price: 5 }],
      }),
    })).json();
    ok('重量 41 被拒（严格 1-40）', !!bad2.error && /1-40/.test(bad2.error));

    // ④ 冲突拦截：把青岛行改成与济南行相同省市区 → 拒绝
    const conflict = await (await fetch(base + '/api/logistics-quotes/region', {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        express_code: 'ZT-SD', old: { province: '山东', city: '青岛', district: '市南' },
        province: '山东', city: '济南', district: '历下',
        volume_ratio: 6000, price_rules: [{ weight: 1, price: 1 }],
      }),
    })).json();
    ok('省市区重复被拒（友好提示）', !!conflict.error && /已存在/.test(conflict.error));

    // ⑤ 原匹配行找不到 → 404
    const miss = await (await fetch(base + '/api/logistics-quotes/region', {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        express_code: 'ZT-SD', old: { province: '不存在省', city: '', district: '' },
        province: '不存在省', city: '', district: '', volume_ratio: 6000, price_rules: [],
      }),
    })).json();
    ok('原行不存在被拒', !!miss.error && /未找到/.test(miss.error));

  } finally {
    server.close();
    try { fs.rmSync(TMP, { force: true }); } catch (e) { /* 安全删除钩子可能拦截，忽略 */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
