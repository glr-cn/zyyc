// 开发用：创建首个管理员账号（发布阶段 6 会改为安全的默认管理员创建流程）
// 用法：node scripts/seed.js [用户名] [密码]
const db = require('../src/db');
const bcrypt = require('bcryptjs');

const username = process.argv[2] || 'admin';
const password = process.argv[3] || 'admin123';

const cnt = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (cnt > 0) {
  console.log('[seed] 已存在用户，跳过创建。');
  process.exit(0);
}
const hash = bcrypt.hashSync(password, 10);
const roleId = db.prepare("SELECT role_id FROM roles WHERE role_name=?").get('管理员').role_id;
db.prepare('INSERT INTO users (username,password_hash,display_name,role_id) VALUES (?,?,?,?)').run(
  username,
  hash,
  username,
  roleId
);
console.log(`[seed] 已创建管理员账号：${username} / ${password}（开发用，发布前请修改）`);
