// 首屏性能基线压测（简化版，修复中文 URL）
const http = require('http');
const app = require('../../src/server');

function req(port, path, token) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const opts = { host: '127.0.0.1', port, path, method: 'GET', headers: {} };
    if (token) opts.headers['authorization'] = 'Bearer ' + token;
    http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ ms: Date.now() - start, status: res.statusCode, len: buf.length }));
    }).on('error', reject).end();
  });
}

const srv = http.createServer(app);
srv.listen(0, async () => {
  const port = srv.address().port;
  console.log(`[bench] port=${port}`);

  // 登录拿 token
  const LOGIN_BODY = JSON.stringify({ username: 'admin', password: 'admin123' });
  const token = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/auth/login', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': LOGIN_BODY.length } }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => resolve(JSON.parse(buf).token));
    });
    r.write(LOGIN_BODY); r.end();
  });
  console.log(`① login token ok\n`);

  // 看板首屏 API（URL encode 处理中文）
  const encW = encodeURIComponent('龙湖仓');
  const API = [
    ['auth-me',       '/api/auth/me'],
    ['customers',     `/api/customers/options?warehouse=${encW}`],
    ['dash-overview', `/api/dashboard/overview?warehouse=${encW}`],
    ['dash-trend',    `/api/dashboard/trend?warehouse=${encW}&range=week`],
    ['wh-pending',    `/api/workhours?warehouse=${encW}&work_type=%E5%8F%91%E8%B4%A7&status=pending&pageSize=5`],
    ['orders-pending',`/api/orders?warehouse=${encW}&status=pending&pageSize=5`],
  ];

  // 串行
  console.log('=== 串行逐个 ===');
  let sumMs = 0;
  for (const [name, path] of API) {
    const r = await req(port, path, token);
    console.log(`  ${name.padEnd(18)} ${String(r.ms).padStart(4)}ms  ${r.status}  ${r.len}B`);
    sumMs += r.ms;
  }
  console.log(`  串行总计: ${sumMs}ms\n`);

  // 并发
  console.log('=== 全部并发 Promise.all ===');
  const start = Date.now();
  const results = await Promise.all(API.map(([name, path]) =>
    req(port, path, token).then((r) => ({ name, ...r }))
  ));
  const total = Date.now() - start;
  results.forEach((r) => console.log(`  ${r.name.padEnd(18)} ${String(r.ms).padStart(4)}ms  ${r.status}`));
  console.log(`  并发总计: ${total}ms`);

  srv.close();
  process.exit(0);
});
