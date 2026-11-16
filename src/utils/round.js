// 统一 3 位小数四舍五入（成本/金额/工时口径一致）
function round3(x) {
  if (x == null || x === '' || isNaN(x)) return 0;
  return Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;
}
module.exports = round3;
