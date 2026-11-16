// 智能测单：核心测算逻辑（公共函数）
// 纯计算、不触碰数据库，便于后端路由与批量/Excel 导入复用，也方便单测。
// 依赖：../utils/round（3 位小数四舍五入，与全系统金额口径一致）
const round3 = require('../utils/round');

const VOLUME_UNIT_FACTOR = 1000000; // 立方米 → 立方厘米，与 cm³/kg 抛比系数配套
const S = (v) => String(v == null ? '' : v).trim();
const LEVEL_LABEL = { 1: '区级精确', 2: '市级', 3: '省级' };

// price_rules 在 DB 中是 JSON 文本，也可能已是数组，统一成数组
function parseRules(priceRules) {
  if (Array.isArray(priceRules)) return priceRules;
  if (typeof priceRules === 'string' && priceRules) {
    try { return JSON.parse(priceRules); } catch (e) { return []; }
  }
  return [];
}

// 旧版区间格式公斤段匹配：给定计费重量，返回对应区间价格
// rules: [{ min, max(null/'':不限), price }]
function matchSegment(weight, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const w = Number(weight) || 0;
  const sorted = rules.slice().sort((a, b) => (Number(a.min) || 0) - (Number(b.min) || 0));
  if (w < (Number(sorted[0].min) || 0)) return Number(sorted[0].price) || 0;
  for (const r of sorted) {
    const max = (r.max == null || r.max === '') ? Infinity : Number(r.max);
    if (w <= max) return Number(r.price) || 0;
  }
  return Number(sorted[sorted.length - 1].price) || 0;
}

// 按计费重量取价：
//   - 离散格式 [{weight, price}]（Excel 导入）：找到对应 weight 节点 → 价格；无该段 → null（不参与比价）
//   - 兼容旧区间格式 [{min,max,price}]：走 matchSegment
function matchWeight(weight, rules) {
  if (!Array.isArray(rules) || !rules.length) return null;
  if (rules[0].weight != null) {
    const node = rules.find((r) => Number(r.weight) === Number(weight));
    return node ? Number(node.price) : null; // 该重量段为空 → 不参与比价
  }
  return matchSegment(weight, rules);
}

// ============ 地址降级匹配（区 → 市 → 省） ============
// 返回 1/2/3 表示命中的优先级，0 表示不命中该订单。
//   ① 区级精确：省份 = 输入省份 且 城市 = 输入城市 且 区县 = 输入区县
//   ② 市级匹配：省份 = 输入省份 且 城市 = 输入城市 且 区县为空
//   ③ 省级匹配：省份 = 输入省份 且 城市为空 且 区县为空
// 说明：
//   * 三级都不命中 → 该快递不参与本次比价；省份为空的「全国通用」行按本规则不参与。
//   * 输入未填区县时，跳过 ① 直接按 市级 → 省级 匹配；输入未填城市时直接按 省级 匹配。
//   * 指定给别的区县的报价行（district 非空且不相等）不能用来给本订单报价。
function matchRegionLevel(q, prov, city, dist) {
  const p = S(q && q.province), c = S(q && q.city), d = S(q && q.district);
  if (!p || p !== prov) return 0;                       // 省份必须相等
  if (dist && c === city && d === dist) return 1;       // ① 区级精确
  if (city && c === city && !d) return 2;               // ② 市级（区县为空）
  if (!c && !d) return 3;                               // ③ 省级（城市/区县为空）
  return 0;
}

// 逐快递挑出「命中的最高优先级」报价行：
// 同一 express_code 下，只保留最小 level（1 最高）的行；同级多行都保留（取其中最低价）。
// 返回 { [express_code]: { level: 1|2|3, rows: [...] } }
function pickRegionQuotes(quotes, prov, city, dist) {
  const best = Object.create(null);
  for (const q of (quotes || [])) {
    const code = S(q && q.express_code);
    if (!code) continue;
    const level = matchRegionLevel(q, prov, city, dist);
    if (!level) continue;                               // 三级都没命中 → 该行/该快递不参与
    const cur = best[code];
    if (!cur || level < cur.level) best[code] = { level, rows: [q] };
    else if (level === cur.level) cur.rows.push(q);
  }
  return best;
}

// 兼容旧调用名：返回特异度分值 区=3 / 市=2 / 省=1 / 不命中=0
function coversRegion(q, prov, city, dist) {
  const lv = matchRegionLevel(q, prov, city, dist);
  return lv ? 4 - lv : 0;
}

// ============ 核心：单笔测算 ============
// row:    { estimatedWeight(预估重量kg), totalVolume(总体积m³), province, city, district, ... }
// quotes: [{ express_code, province, city, district, volume_ratio, price_rules }]（logistics_quotes 全量）
// 返回：  { volumetricWeight, billingWeight, recommendedCode, recommendedPrice, matchLevel, matchLabel, details }
//   - 抛比重量 = 总体积(m³) × 1,000,000 ÷ volume_ratio
//   - 计费重量 = Math.ceil( Math.max(预估重量, 抛比重量) )
//   - 地址：逐快递按 区 → 市 → 省 降级取最特异行；三级都不命中则该快递不参与
//   - 价格：该行在计费重量对应段无价 → 该快递不参与；最后跨快递取最低价
const EMPTY = {
  volumetricWeight: 0, billingWeight: 0, recommendedCode: null, recommendedPrice: null,
  matchLevel: 0, matchLabel: '', details: [],
};
function calcBestQuote(row, quotes) {
  const est = Number(row.estimatedWeight) || 0;
  const vol = Number(row.totalVolume) || 0;
  const prov = S(row.province), city = S(row.city), dist = S(row.district);

  const byCode = pickRegionQuotes(quotes, prov, city, dist);
  const candidates = [];
  for (const code of Object.keys(byCode)) {
    const { level, rows } = byCode[code];
    let picked = null;
    for (const q of rows) {
      const ratio = Number(q.volume_ratio) || 0;
      if (!ratio) continue;                                    // 抛比无效 → 跳过该行
      const volumetricPrecise = (vol * VOLUME_UNIT_FACTOR) / ratio; // 抛比重量（原始精度）
      const billing = Math.ceil(Math.max(est, volumetricPrecise));   // 计费重量（向上取整）
      const price = matchWeight(billing, parseRules(q.price_rules));
      if (price == null || !isFinite(price)) continue;          // 该重量段无价 → 不参与比价
      if (!picked || price < picked.price) {
        picked = {
          express_code: code,
          volume_ratio: ratio,
          volumetricWeight: round3(volumetricPrecise),
          billingWeight: billing,
          price,
          matchLevel: level,
          matchLabel: LEVEL_LABEL[level],
        };
      }
    }
    if (picked) candidates.push(picked);                       // 三级/价格都没命中 → 该快递不参与
  }
  if (!candidates.length) return EMPTY;

  // 跨快递选最低价；同价取先出现者（DB 顺序，稳定）
  let best = candidates[0];
  for (const c of candidates) if (c.price < best.price) best = c;
  return {
    volumetricWeight: best.volumetricWeight,
    billingWeight: best.billingWeight,
    recommendedCode: best.express_code,
    recommendedPrice: best.price,
    matchLevel: best.matchLevel,
    matchLabel: best.matchLabel,
    details: candidates,
  };
}

// 批量：输入多行，返回每行带测算结果（保持顺序，原字段透传）
function calcBestQuotes(rows, quotes) {
  return (rows || []).map((row) => {
    const r = calcBestQuote(row, quotes);
    return Object.assign({}, row, {
      volumetricWeight: r.volumetricWeight,
      billingWeight: r.billingWeight,
      recommendedCode: r.recommendedCode,
      recommendedPrice: r.recommendedPrice,
      matchLevel: r.matchLevel,
      matchLabel: r.matchLabel,
    });
  });
}

module.exports = {
  parseRules, matchSegment, matchWeight,
  matchRegionLevel, pickRegionQuotes, coversRegion,
  calcBestQuote, calcBestQuotes, LEVEL_LABEL,
};

// ============ 自测（node src/services/quoteCalc.js 直接运行） ============
if (require.main === module) {
  const rules = (p2) => JSON.stringify([{ weight: 1, price: p2 - 1 }, { weight: 2, price: p2 }, { weight: 3, price: p2 + 1 }]);
  const base = [
    { express_code: 'ZT-XH', province: '浙江省', city: '杭州市', district: '西湖区', volume_ratio: 6000, price_rules: rules(4.5) },
    { express_code: 'ZT-HZ', province: '浙江省', city: '杭州市', district: '', volume_ratio: 6000, price_rules: rules(5.0) },
    { express_code: 'ZT-QS', province: '浙江省', city: '', district: '', volume_ratio: 6000, price_rules: rules(6.0) },
    { express_code: 'BS-SH', province: '上海', city: '', district: '', volume_ratio: 6000, price_rules: rules(3.0) },
  ];
  const row = (o) => Object.assign({ estimatedWeight: 2, totalVolume: 0, province: '浙江省', city: '杭州市', district: '西湖区' }, o);
  const cases = [
    { name: '① 区级精确命中 ZT-XH(4.5)', quotes: base, row: row(), expect: 'ZT-XH' },
    { name: '② 无区县 → 跳过区级，市级 ZT-HZ(5.0)', quotes: base, row: row({ district: '' }), expect: 'ZT-HZ' },
    { name: '③ 无城市 → 省级 ZT-QS(6.0)', quotes: base, row: row({ city: '', district: '' }), expect: 'ZT-QS' },
    { name: '④ 别的区县行不得串用（滨江区 → ZT-HZ）', quotes: base, row: row({ district: '滨江区' }), expect: 'ZT-HZ' },
    { name: '⑤ 省份不符的低价行不参与（上海 → BS-SH）', quotes: base, row: row({ province: '上海', city: '', district: '' }), expect: 'BS-SH' },
    { name: '⑥ 区级行缺该重量段 → 该快递不参与，取市级 ZT-HZ',
      quotes: base.map((q) => q.express_code === 'ZT-XH' ? Object.assign({}, q, { price_rules: JSON.stringify([{ weight: 1, price: 1 }]) }) : q),
      row: row(), expect: 'ZT-HZ' },
    { name: '⑦ 省份为空的全国通用行不参与比价',
      quotes: base.concat([{ express_code: 'ALL', province: '', city: '', district: '', volume_ratio: 6000, price_rules: rules(0.1) }]),
      row: row(), expect: 'ZT-XH' },
    { name: '⑧ 同一快递有区+省两行时只认区级；跨快递仍比最低价',
      quotes: [
        { express_code: 'A', province: '浙江省', city: '杭州市', district: '西湖区', volume_ratio: 6000, price_rules: rules(9.9) },
        { express_code: 'A', province: '浙江省', city: '', district: '', volume_ratio: 6000, price_rules: rules(1.0) },
        { express_code: 'B', province: '浙江省', city: '杭州市', district: '西湖区', volume_ratio: 6000, price_rules: rules(2.0) },
      ],
      row: row(), expect: 'B' },
  ];
  let pass = 0, fail = 0;
  for (const c of cases) {
    const r = calcBestQuote(c.row, c.quotes);
    const ok = r.recommendedCode === c.expect;
    console.log(`[${ok ? '✓' : '✗'}] ${c.name} → ${r.recommendedCode}(${r.recommendedPrice}) / ${r.matchLabel}`);
    ok ? pass++ : fail++;
  }
  console.log(`\n自测：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
}
