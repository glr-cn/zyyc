// 全局日期范围选择组件单元测试（纯 Node，无浏览器依赖）
// 验证：日期工具计算、三种模式产出、容错（只点开始→结束=开始）、参数映射契约
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name, extra != null ? '=> ' + JSON.stringify(extra) : ''); } }

// ---- 在最小 DOM stub 中加载组件脚本，拿到 window.DateRangePicker ----
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'date-range-picker.js'), 'utf8');
function fakeEl() {
  const el = {
    _html: '', className: '', value: '', dataset: {}, textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
    setAttribute() {}, appendChild() {}, remove() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, contains() { return false; },
  };
  return el;
}
const sandbox = {
  window: {},
  document: { addEventListener() {} },
  Date, Math, String, Number, Set, console,
};
vm.createContext(sandbox);
vm.runInContext('(function(){const window=this.window,document=this.document;' + src + '}).call(this)', sandbox);
const DP = sandbox.window.DateRangePicker;
ok('组件挂载到 window.DateRangePicker', !!DP);

// ---- 日期工具 ----
const u = DP.util;
ok('iso 格式化', u.iso(new Date(2026, 10, 1)) === '2026-11-01', u.iso(new Date(2026, 10, 1)));
ok('parse 解析', u.iso(u.parse('2026-11-30')) === '2026-11-30');
// 2026-11-16 是周一
const mon = u.parse('2026-11-16');
ok('startOfWeek：周一输入不变', u.iso(u.startOfWeek(mon)) === '2026-11-16', u.iso(u.startOfWeek(mon)));
ok('endOfWeek：周日', u.iso(u.endOfWeek(mon)) === '2026-11-22', u.iso(u.endOfWeek(mon)));
// 2026-11-19 周四 → 所在周仍 11/16~11/22
const thu = u.parse('2026-11-19');
ok('startOfWeek：周中回溯到周一', u.iso(u.startOfWeek(thu)) === '2026-11-16', u.iso(u.startOfWeek(thu)));
// 月末（含闰年）
ok('endOfMonth 11月30天', u.iso(u.endOfMonth(u.parse('2026-11-05'))) === '2026-11-30');
ok('endOfMonth 2月平年28天', u.iso(u.endOfMonth(u.parse('2026-02-10'))) === '2026-02-28');
ok('endOfMonth 2月闰年29天', u.iso(u.endOfMonth(u.parse('2024-02-10'))) === '2024-02-29');
ok('startOfMonth 归到1号', u.iso(u.startOfMonth(u.parse('2026-11-19'))) === '2026-11-01');
// ISO 周数：2026-11-16 应为第47周
ok('isoWeekNum 周数', JSON.stringify(u.isoWeekNum(mon)) === JSON.stringify({ year: 2026, week: 47 }), u.isoWeekNum(mon));

// ---- 实例化 + API 契约 ----
const mount = fakeEl();
const inst = new DP({ mount, mode: 'day', startDate: '2026-11-01', endDate: '2026-11-30' });
ok('getValue 结构完整', JSON.stringify(inst.getValue()) === JSON.stringify({ startDate: '2026-11-01', endDate: '2026-11-30', mode: 'day' }), inst.getValue());
ok('getRange 只含日期', JSON.stringify(inst.getRange()) === JSON.stringify({ startDate: '2026-11-01', endDate: '2026-11-30' }), inst.getRange());

// ---- 容错：只点开始日期就关闭 → end=start ----
const inst2 = new DP({ mount: fakeEl(), mode: 'day' });
inst2.draft = { start: '2026-11-16', end: '' };
inst2.open = true;
inst2._outside(); // 模拟点击外部关闭
ok('容错：只选开始→结束=开始', JSON.stringify(inst2.getRange()) === JSON.stringify({ startDate: '2026-11-16', endDate: '2026-11-16' }), inst2.getRange());

// ---- 容错：未做任何选择就关闭 → 保留原值（不误清空） ----
const inst3 = new DP({ mount: fakeEl(), mode: 'day', startDate: '2026-10-01', endDate: '2026-10-31' });
inst3.open = true;
inst3._outside();
ok('空操作关闭：保留原范围', JSON.stringify(inst3.getRange()) === JSON.stringify({ startDate: '2026-10-01', endDate: '2026-10-31' }), inst3.getRange());

// ---- 点选第二天：自动提交并排序 ----
const inst4 = new DP({ mount: fakeEl(), mode: 'day' });
inst4.open = true;
inst4.draft = { start: '2026-11-20', end: '' };
inst4._pickDay('2026-11-16'); // 点较早日期 → 应交换
ok('点选第二天自动提交并排序', JSON.stringify(inst4.getRange()) === JSON.stringify({ startDate: '2026-11-16', endDate: '2026-11-20' }), inst4.getRange());

// ---- 切换维度：日→周→月 自动换算范围 ----
const inst5 = new DP({ mount: fakeEl(), mode: 'day', startDate: '2026-11-16', endDate: '2026-11-16' });
inst5._setMode('week');
ok('切到按周→周一至周日', JSON.stringify(inst5.getRange()) === JSON.stringify({ startDate: '2026-11-16', endDate: '2026-11-22' }), inst5.getRange());
inst5._setMode('month');
ok('切到按月→月初至月末', JSON.stringify(inst5.getRange()) === JSON.stringify({ startDate: '2026-11-01', endDate: '2026-11-30' }), inst5.getRange());

// ---- 产出格式：全部 yyyy-MM-dd，无时分秒 ----
const allDates = [inst.getValue(), inst2.getValue(), inst4.getValue(), inst5.getValue()].flatMap((v) => [v.startDate, v.endDate]);
ok('产出全为 yyyy-MM-dd（无时分秒）', allDates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), allDates);

// ---- 静态契约：三个页面已挂载组件，且后端参数名保持 ----
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
const wh = read('public/js/workhours.js');
const lg = read('public/js/log-center.js');
const an = read('public/js/analytics.js');
ok('workhours 挂载 drpSlot 且不再有原生 date input', wh.includes('id="drpSlot"') && !wh.includes('id="dateFrom" type="date"'));
ok('workhours 仍用 dateFrom/dateTo 作为后端参数', wh.includes("params.set('dateFrom'") && wh.includes("params.set('dateTo'"));
ok('log-center 挂载 dateRangeSlot', lg.includes('id="dateRangeSlot"') && !lg.includes('id="dateFrom" type="date"'));
ok('log-center 仍用 state.dateFrom/dateTo 查询', lg.includes("p.set('dateFrom'") && lg.includes("p.set('dateTo'"));
ok('analytics 挂载 drpSlot 且移除旧 from/to/mode 下拉', an.includes('id="drpSlot"') && !an.includes('id="from" type="date"') && !an.includes('id="mode"'));
ok('analytics 仍用 from/to 作为后端参数', an.includes("params.set('from'") && an.includes("params.set('to'"));
ok('analytics 组件 mode 作为后端聚合参数', an.includes('new URLSearchParams({ mode: v.mode })'));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
