// 一次性工具：把本地库导出为「发布恢复包」data/erp.restore-from-local.db
// 用途：平台每次发布都是全新临时存储，发布包里的这份 DB 会在首次启动时注入持久目录。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const src = path.join(root, 'data', 'erp.db');
const out = path.join(root, 'data', 'erp.restore-from-local.db');

if (fs.existsSync(out)) fs.unlinkSync(out);

const db = new Database(src, { readonly: true });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();

const v = new Database(out, { readonly: true });
const stats = {};
for (const t of ['customers', 'warehouse_sort_config', 'work_hours', 'orders', 'inventory_transactions', 'logistics_quotes', 'users', 'roles', 'menus']) {
  try { stats[t] = v.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (e) { stats[t] = 'ERR'; }
}
v.close();
console.log('[bundle] 已生成', out);
console.log('[bundle] 内容：', JSON.stringify(stats));
console.log('[bundle] 大小：', (fs.statSync(out).size / 1024).toFixed(0), 'KB');
