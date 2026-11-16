// 【已停用】客户编号自动生成器：新客户表的 customer_code 是业务「货主代码」（选填、UNIQUE），
// 不再自动生成 C0001。保留文件仅为兼容旧脚本引用，新代码请勿调用。
const db = require('../db');

function nextCustomerCode() {
  const rows = db.prepare("SELECT customer_code FROM customers WHERE customer_code LIKE 'C%'").all();
  let max = 0;
  rows.forEach((r) => {
    const n = parseInt(String(r.customer_code).replace(/^C/, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return 'C' + String(max + 1).padStart(4, '0');
}

module.exports = { nextCustomerCode };
