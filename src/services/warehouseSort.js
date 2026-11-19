// 分仓独立排序：位置式重排
// ----------------------------------------------------------------------------
// 规则（对应用户需求）：
//   1) 每个仓库的排序序号完全独立，跨仓互不影响
//   2) 改到已占用的序号位置 → 原占用该位置及之后的货品依次顺延 1 位
//   3) 改到空缺序号位置 → 自动填充中间空缺，保证 1..n 连续无中断
//   4) 序号超出合理范围（大于仓库货品数）→ 自动落到末尾
//   5) 只允许正整数，非数字/负数/0 一律拒绝
//
// 实现：把"目标序号"视为"第 N 位"，取出该仓其余货品按当前排序排好，
//       在 N-1 处插入目标货品，然后整体重编号为 1..n 写入 warehouse_sort_config。
//       由于整体重编号，顺延与空缺填充是同一套逻辑的自然结果。
const { WAREHOUSES } = require('./customerImport');
const { warehouseExactLikeValue } = require('../utils/likeEscape');

/**
 * 把客户放到指定仓库的指定排序位置，并保证该仓序号连续 1..n。
 * @param {object} db   数据库连接（driver 封装，需支持 prepare/run/all/get）
 * @param {string} warehouse 仓库名
 * @param {number|string} customerId 客户 id
 * @param {number|string} position 目标排序位置（1-based 正整数）
 * @returns {{ok:boolean, error?:string, position?:number, total?:number}}
 */
function setWarehouseSortPosition(db, warehouse, customerId, position) {
  if (!WAREHOUSES.includes(warehouse)) return { ok: false, error: '仓库参数非法' };

  const pos = Number(position);
  if (!Number.isInteger(pos) || pos <= 0) return { ok: false, error: '排序号必须为正整数' };

  const cid = Number(customerId);
  if (!Number.isInteger(cid) || cid <= 0) return { ok: false, error: '客户 id 非法' };

  const owner = db.prepare('SELECT customer_id, warehouse, is_deleted FROM customers WHERE customer_id=?').get(cid);
  if (!owner || Number(owner.is_deleted) === 1) return { ok: false, error: '客户不存在或已删除' };

  const whList = String(owner.warehouse || '')
    .split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  if (!whList.includes(warehouse)) return { ok: false, error: `客户不属于${warehouse}` };

  // 该仓其余活跃货品：按当前实际排序（wsc 优先，回退 customers.sort_order，再回退 9999）
  const others = db.prepare(`
    SELECT c.customer_id
      FROM customers c
      LEFT JOIN warehouse_sort_config wsc
             ON wsc.customer_id = c.customer_id AND wsc.warehouse = ?
     WHERE ',' || c.warehouse || ',' LIKE ? ESCAPE '\\' AND c.is_deleted = 0 AND c.customer_id != ?
     ORDER BY COALESCE(wsc.sort_order, c.sort_order, 9999) ASC, c.customer_id ASC
  `).all(warehouse, warehouseExactLikeValue(warehouse), cid).map((r) => r.customer_id);

  // 目标位置夹到 [1, 总数]：超出范围自动落到末尾
  const insertAt = Math.min(pos, others.length + 1) - 1;
  const ordered = others.slice(0, insertAt);
  ordered.push(cid);
  ordered.push(...others.slice(insertAt));

  const upsert = db.prepare(`INSERT INTO warehouse_sort_config (warehouse, customer_id, sort_order, updated_at)
    VALUES (?,?,?,datetime('now','localtime'))
    ON CONFLICT(warehouse, customer_id) DO UPDATE SET
      sort_order = excluded.sort_order,
      updated_at = datetime('now','localtime')`);
  ordered.forEach((id, idx) => upsert.run(warehouse, id, idx + 1));

  return { ok: true, position: ordered.indexOf(cid) + 1, total: ordered.length };
}

module.exports = { setWarehouseSortPosition };
