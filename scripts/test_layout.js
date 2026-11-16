// 全局布局（Layout）结构验证：单行 Header + 三段式 + 自适应 + 单滚动条
// 纯静态断言（读取 app.html / style.css / tabs.js），无需浏览器
// 用法：node scripts/test_layout.js
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
const tabs = fs.readFileSync(path.join(root, 'js', 'tabs.js'), 'utf8');

let failed = 0;
function assert(c, m) {
  if (!c) { console.error('FAIL: ' + m); failed++; } else console.log('PASS: ' + m);
}

// 提取某选择器的首个规则块内容（简单花括号配对，足够覆盖本项目单行/多行规则）
function block(text, selector) {
  const i = text.indexOf(selector + ' {');
  if (i < 0) return '';
  const start = text.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(start + 1, j); }
  }
  return '';
}

console.log('---- 1. HTML：移除冗余标题行、合并为单行 Header ----');
assert(!/class="topbar"/.test(html), '原 54px 标题横栏 .topbar 已移除');
assert(!/tabbar-wrap/.test(html), '独立 .tabbar-wrap 容器已移除');
assert(!/<div class="title">/.test(html), '不再有只显示当前页面标题的 .title 元素');
assert((html.match(/<header class="app-header">/g) || []).length === 1, '存在且仅存在一个单行 .app-header');

const iTabbar = html.indexOf('id="tabbar"');
const iUser = html.indexOf('class="user"');
const iHeader = html.indexOf('class="app-header"');
const iContent = html.indexOf('id="content"');
assert(html.indexOf('hdr-brand') < 0 && html.indexOf('hdr-name') < 0,
  'Header 品牌伪标签（蓝色“佐”字 Logo + 系统名）已彻底移除');
assert(iTabbar > 0, 'Tab 标签栏存在');
assert(iUser > iTabbar, '两段式顺序：用户信息 在 Tab 标签栏右侧');
assert(iHeader < iContent, 'Header 位于主内容区 #content 之上');
['tabbar', 'content', 'uname', 'logout'].forEach((id) => {
  assert(html.indexOf('id="' + id + '"') > 0, '保留关键元素 #' + id + '（交互/应用外壳依赖）');
});
assert(html.indexOf('js/tabs.js') > 0 && html.indexOf('js/tabs.js') < html.indexOf('js/app.js'),
  'tabs.js 仍先于 app.js 加载，路由联动顺序不变');

console.log('---- 2. CSS：视口锁定高度模型（避免双滚动条） ----');
assert(/html,\s*body\s*\{\s*height:\s*100%/.test(css), 'html/body 高度撑满视口');
const layout = block(css, '.layout');
assert(/height:\s*100vh/.test(layout), '.layout 锁定视口高度 100vh');
assert(/overflow:\s*hidden/.test(layout), '.layout overflow:hidden，杜绝页面级滚动');
assert(!/min-height:\s*100vh/.test(layout), '.layout 不再用 min-height:100vh 撑高页面');
const content = block(css, '.content');
assert(/flex:\s*1 1 auto/.test(content), '.content 自适应吃掉 Header 之外的剩余高度');
assert(/min-height:\s*0/.test(content), '.content min-height:0，允许在 flex 列内收缩');
assert(/overflow-y:\s*auto/.test(content), '.content 是唯一纵向滚动容器');
assert(!/body\s*\{[^}]*overflow-y:\s*(auto|scroll)/.test(css), 'body 未设置纵向滚动，不会出现双滚动条');
assert(/overflow-y:\s*auto/.test(block(css, '.sidebar')), '侧栏菜单过长时独立滚动，不撑破布局');

console.log('---- 3. CSS：单行 Header 三段式与自适应 ----');
const header = block(css, '.app-header');
assert(/flex:\s*0 0 auto/.test(header) && /height:\s*56px/.test(header), '.app-header 固定高度且不收缩');
const bar = block(css, '.tabbar');
assert(/flex:\s*1 1 auto/.test(bar), '中段 Tab 栏自适应剩余宽度');
assert(/min-width:\s*0/.test(bar), '中段 min-width:0，允许被压缩而不挤占两侧');
assert(/overflow-x:\s*auto/.test(bar), '中段标签过多时自身横向滚动');
assert(/overflow-y:\s*hidden/.test(bar), '中段无纵向滚动条');
assert(!/\.hdr-brand\s*\{/.test(css) && !/\.hdr-logo\s*\{/.test(css) && !/\.hdr-name\s*\{/.test(css),
  '品牌伪标签的 CSS 规则（.hdr-brand/.hdr-logo/.hdr-name）已全部清除');
assert(/flex:\s*0 0 auto/.test(block(css, '.app-header .user')), '右侧用户信息段不被挤压');
assert(!/hdr-name/.test(css), '窄屏媒体查询中不再引用已删除的 .hdr-name');
assert(!/\.topbar\s*\{/.test(css) && !/\.tabbar-wrap\s*\{/.test(css), '旧 .topbar / .tabbar-wrap 样式规则已清除');

console.log('---- 4. Tab 交互逻辑保持不变 ----');
assert(/\.tab-item\.active\s*\{/.test(css), '激活高亮样式保留');
assert(/\.tab-item\.pinned\s*\{/.test(css), '固定标签样式保留');
assert(/\.tab-close[^{]*\{/.test(css) && /\.tab-pin[^{]*\{/.test(css), '关闭 / 固定图标样式保留');
assert(/\.tab-menu\s*\{/.test(css), '右键菜单样式保留');
assert(/\.page-view\s*\{\s*display:\s*none/.test(css), 'keep-alive 视图容器样式保留');
assert(tabs.indexOf("getElementById('tabbar')") > 0 && tabs.indexOf("getElementById('content')") > 0,
  'tabs.js 仍绑定 #tabbar 与 #content');
assert(!/\.topbar \.title/.test(tabs), 'tabs.js 不再查询已移除的 .topbar .title');
assert(/document\.title\s*=/.test(tabs), '标题改由 document.title 承载');
['togglePin', 'closeOthers', 'closeRight', 'contextmenu', 'scrollIntoView', '_menu'].forEach((k) => {
  assert(tabs.indexOf(k) > 0, '交互方法 ' + k + ' 未被改动');
});

console.log(failed === 0 ? '=== 全部通过 ===' : '=== 有 ' + failed + ' 项失败 ===');
process.exit(failed === 0 ? 0 : 1);
