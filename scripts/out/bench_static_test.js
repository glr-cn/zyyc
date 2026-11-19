// 最小 express.static 测试：验证 maxAge + immutable + setHeaders 到底返回什么 Cache-Control
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

// 在 temp 目录写一个测试 js 文件
const tmpDir = path.join(__dirname, '..', '..', 'data', '_perf_test');
fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'test.js'), 'console.log("test");');

const app = express();
app.use(compression({ threshold: 1024 }));

// 测试 1：express.static 用字符串 maxAge
app.use('/t1', express.static(tmpDir, { maxAge: '24h', immutable: true }));

// 测试 2：express.static 用数字 maxAge
app.use('/t2', express.static(tmpDir, { maxAge: 86400000, immutable: true }));

// 测试 3：express.static 用 setHeaders 手动设
app.use('/t3', express.static(tmpDir, {
  maxAge: '24h',
  immutable: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  }
}));

// API 不缓存
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.get('/api/health', (req, res) => res.json({ ok: true }));

const server = app.listen(0, async () => {
  const port = server.address().port;
  const http = require('http');
  const test = (p) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      console.log(`${p.padEnd(20)} Cache-Control: ${res.headers['cache-control']}`);
      console.log(`${p.padEnd(20)} Content-Encoding: ${res.headers['content-encoding'] || '(none)'}`);
      console.log(`${p.padEnd(20)} Content-Type:    ${res.headers['content-type']}`);
      res.destroy(); resolve();
    });
  });
  await test('/t1/test.js');
  await test('/t2/test.js');
  await test('/t3/test.js');
  await test('/api/health');
  server.close();
  process.exit(0);
});
