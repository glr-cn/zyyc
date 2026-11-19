// 复现：新增库内工时 → 检查其他分类是否被联动插入
const http = require('http');
const app = require('../../src/server');
const db = require('../../src/db');
const srv = http.createServer(app);
srv.listen(0, async () => {
  const port = srv.address().port;
  const base = 'http://127.0.0.1:' + port;
  const login = await fetch(base + '/api/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({username:'admin',password:'admin123'}) });
  const token = (await login.json()).token;
  const hdrs = { authorization: 'Bearer ' + token, 'content-type':'application/json' };

  console.log('=== 新增前各分类 pending 数量 ===');
  for (const wt of ['发货','收货','库内','后勤']) {
    const res = await fetch(base + '/api/workhours?warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent(wt), { headers: hdrs });
    const j = await res.json();
    console.log(`  ${wt}: ${j.total} 条`);
  }

  const before = db.prepare("SELECT work_id, work_type, project FROM work_hours WHERE remark='BUG_REPRO_2026'").all();
  console.log('\nremark=BUG_REPRO_2026 现有记录:', before.length);

  // 新增一条库内工时
  const payload = {
    warehouse: '龙湖仓', work_type: '库内', project: '上架',
    date: '2026-11-19', unit: '单', workload: 100, main_hours: 8, other_hours: 2, remark: 'BUG_REPRO_2026'
  };
  const r = await fetch(base + '/api/workhours', { method:'POST', headers: hdrs, body: JSON.stringify(payload) });
  const rj = await r.json();
  console.log('\nPOST 库内 → work_id=' + rj.data?.work_id + ' work_type=' + rj.data?.work_type);

  // 再查一次 remark=BUG_REPRO_2026 有几条、分别是什么类型
  const all = db.prepare("SELECT work_id, work_type, project, remark FROM work_hours WHERE remark='BUG_REPRO_2026'").all();
  console.log('\n新增后 remark=BUG_REPRO_2026 共 ' + all.length + ' 条:');
  all.forEach(r => console.log(`  work_id=${r.work_id} work_type=${r.work_type} project=${r.project}`));

  // 也查一下新增后各分类数量有没有意外变化
  console.log('\n=== 新增后各分类 pending 数量 ===');
  for (const wt of ['发货','收货','库内','后勤']) {
    const res = await fetch(base + '/api/workhours?warehouse=' + encodeURIComponent('龙湖仓') + '&work_type=' + encodeURIComponent(wt), { headers: hdrs });
    const j = await res.json();
    console.log(`  ${wt}: ${j.total} 条`);
  }

  // 清理
  const ids = all.map(r => r.work_id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM work_hours WHERE work_id IN (${ph})`).run(...ids);
    console.log('\n已清理测试数据 work_id:', ids.join(','));
  }
  srv.close();
  process.exit(0);
});
