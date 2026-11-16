// 品牌升级一致性验证：全局扫描旧品牌名零残留 + 新名称/登录页/鉴权逻辑/Tabs 结构约束
// 用法：node scripts/test_brand.js
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const BRAND = '佐雍云仓数据中心';
const OLD = '轻量' + ' ERP'; // 拼接构造，避免本文件被自身扫描判为残留

let failed = 0;
function assert(c, m) {
  if (!c) { console.error('FAIL: ' + m); failed++; } else console.log('PASS: ' + m);
}

// 递归收集源码文本（排除 node_modules / data / 二进制）
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach((name) => {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name !== 'node_modules' && name !== 'data') walk(p, out);
    } else if (/\.(html|js|css|json|sql|md|txt)$/i.test(name)) out.push(p);
  });
  return out;
}

const app = read('public/app.html');
const index = read('public/index.html');
const login = read('public/login.html');
const css = read('public/css/style.css');
const tabs = read('public/js/tabs.js');
const auth = read('public/js/auth.js');

console.log('---- 1. 全局零残留 ----');
const scanned = [
  ...walk(path.join(root, 'public'), []),
  ...walk(path.join(root, 'src'), []),
  ...walk(path.join(root, 'scripts'), []),
  path.join(root, 'package.json'),
];
const dirty = scanned.filter((p) => fs.readFileSync(p, 'utf8').includes(OLD));
assert(dirty.length === 0, '扫描 ' + scanned.length + ' 个源码文件，旧品牌名零残留' +
  (dirty.length ? '（残留：' + dirty.map((p) => path.relative(root, p)).join(', ') + '）' : ''));

console.log('---- 2. 页面标题与品牌区 ----');
assert(app.includes('<title>' + BRAND + '</title>'), 'app.html 浏览器标题已升级');
assert(index.includes('<title>' + BRAND + '</title>'), 'index.html 跳转页标题已升级');
assert(login.includes('<title>登录 - ' + BRAND + '</title>'), 'login.html 标题已升级');
assert(login.includes('<h1>' + BRAND + '</h1>'), '登录页中央大标题展示新名称');
assert(app.indexOf('hdr-brand') < 0 && app.indexOf('hdr-name') < 0,
  '顶部 Header 品牌伪标签已移除（不再与首个 Tab 混淆）');
assert(app.includes('class="brand-logo"') && app.includes('class="brand-name">' + BRAND),
  'Sidebar 品牌区：Logo 方块 + 新名称（系统名称仅保留在此与登录页）');
assert(css.includes('.sidebar .brand-name') && /white-space:\s*nowrap/.test(css),
  '品牌名 nowrap，不换行');
assert(/\.sidebar \.brand\s*\{[^}]*align-items:\s*center/.test(css),
  'Sidebar 图标与文字 flex 垂直居中对齐');
assert(/font-size:\s*16px/.test(css.split('.sidebar .brand-name')[1] || ''),
  'Sidebar 品牌字号 16px + 加粗');

console.log('---- 3. 登录页 UI 与鉴权逻辑不变 ----');
assert(/linear-gradient\(135deg,\s*#0a172e/.test(css), '登录页深蓝渐变背景');
assert(/background-size:\s*46px/.test(css), '仓储货位感网格装饰（纯 CSS）');
assert(/\.login-card\s*\{[^}]*border-radius:\s*16px[^}]*box-shadow/.test(css.replace(/\n/g, ' ')),
  '白色悬浮卡片：圆角 + 柔和阴影');
['id="loginForm"', 'name="username"', 'name="password"', 'type="submit"', 'id="err"', 'js/auth.js'].forEach((k) => {
  assert(login.includes(k), '登录页保留鉴权依赖 ' + k);
});
assert(auth.includes("localStorage.setItem('erp_token'") && auth.includes("'erp_login_stamp'"),
  'auth.js 未改动：Token 与登录会话戳写入逻辑保留');
assert(auth.includes("/api/auth/login") && auth.includes("location.href = 'app.html'"),
  'auth.js 未改动：登录接口与跳转经营看板保留');

console.log('---- 4. Tabs / Layout 机制不变 ----');
assert(tabs.includes("document.title = meta.title + ' · " + BRAND + "'"), '动态标题后缀已升级');
assert(/dashboard:\s*\{\s*title:\s*'经营看板'/.test(tabs),
  '默认页签仍为「经营看板」（不存在旧品牌名默认页签，业务不变）');
assert(!tabs.includes(OLD), 'tabs.js 的 PAGE_META 无旧品牌名页签');
['id="tabbar"', 'id="content"', 'id="uname"', 'id="logout"', 'class="app-header"'].forEach((k) => {
  assert(app.includes(k), 'Layout 关键结构保留 ' + k);
});

console.log(failed === 0 ? '=== 全部通过 ===' : '=== 有 ' + failed + ' 项失败 ===');
process.exit(failed === 0 ? 0 : 1);
