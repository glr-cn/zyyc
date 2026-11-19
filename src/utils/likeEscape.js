// LIKE 模式安全转义 + 多仓精确边界匹配工具
//
// 背景: customers.warehouse 字段是逗号分隔的多仓字符串 (如 "龙湖仓,佳新仓")。
// 用 LIKE '%仓名%' 模糊匹配有三宗罪:
//   1) 子串误命中: 有 "龙湖仓" 和 "龙湖仓A" 两个仓名时，LIKE '%龙湖仓%' 同时命中两者
//   2) 空仓漏出: warehouse='' 时 LIKE '%%' 匹配所有客户，数据泄露
//   3) 通配符注入: % _ 被 LIKE 当作通配符解释 (虽然仓库名是中文，但仍是安全隐患)
//
// 解决方案:
//   - 精确边界匹配: ',' || warehouse || ',' LIKE ?   把字段前后包逗号
//   - 参数值:   '%,' || escLike(warehouseName) || ',%'  + ESCAPE '\\'
//   - escLike:  把参数中所有 % 和 _ 前置 \ 转义，避免被 LIKE 解释为通配符

/**
 * 把字符串中的 LIKE 通配符 % _ \ 前置反斜杠转义
 * @param {string} str
 * @returns {string} 已转义
 */
function escLike(str) {
  if (str == null) return '';
  return String(str).replace(/[%_\\]/g, '\\$&');
}

/**
 * 生成 "warehouse 精确边界匹配" 的 LIKE 参数值
 * 返回值直接用于参数占位符，SQL 里写:
 *   ',' || warehouse || ',' LIKE ? ESCAPE '\\'
 *
 * @param {string} warehouseName 如 '龙湖仓'
 * @returns {string} 如 '%,龙湖仓,%'
 */
function warehouseExactLikeValue(warehouseName) {
  return '%,' + escLike(warehouseName) + ',%';
}

module.exports = { escLike, warehouseExactLikeValue };
