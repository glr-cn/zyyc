// 全局日期范围选择组件（原生 JS，无框架/无外部依赖）
// 挂载：window.DateRangePicker；同时尽力挂到 window.ERP.DateRangePicker（若 ERP 命名空间已存在）
// 用法：new DateRangePicker({ mount, mode:'day'|'week'|'month', startDate, endDate, onChange })
//   getValue() -> { startDate:'yyyy-MM-dd', endDate:'yyyy-MM-dd', mode }
//   setValue({startDate,endDate,mode}, silent) / getRange() / destroy()
// 铁律：只产出日期级 yyyy-MM-dd，不含时分秒；不触碰任何后端查询逻辑。
(function () {
  'use strict';

  // ---------- 日期工具（全部本地时区，按自然日计算） ----------
  const pad = (n) => String(n).padStart(2, '0');
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { const a = String(s || '').split('-').map(Number); return new Date(a[0] || 1970, (a[1] || 1) - 1, a[2] || 1); }
  function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function endOfWeek(d) { return addDays(startOfWeek(d), 6); }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function md(d) { return pad(d.getMonth() + 1) + '/' + pad(d.getDate()); }
  function isoWeekNum(d) {
    const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
    return { year: dt.getUTCFullYear(), week: week };
  }
  function rangeOfWeek(d) { return { startDate: iso(startOfWeek(d)), endDate: iso(endOfWeek(d)) }; }
  function rangeOfMonth(d) { return { startDate: iso(startOfMonth(d)), endDate: iso(endOfMonth(d)) }; }
  function quickRanges() {
    const t = new Date();
    const today = iso(t);
    const pm = addMonths(startOfMonth(t), -1);
    return [
      { key: 'today', label: '今天', range: { startDate: today, endDate: today } },
      { key: 'yesterday', label: '昨天', range: { startDate: iso(addDays(t, -1)), endDate: iso(addDays(t, -1)) } },
      { key: 'week', label: '本周', range: rangeOfWeek(t) },
      { key: 'last7', label: '最近7天', range: { startDate: iso(addDays(t, -6)), endDate: today } },
      { key: 'last30', label: '最近30天', range: { startDate: iso(addDays(t, -29)), endDate: today } },
      { key: 'month', label: '本月', range: rangeOfMonth(t) },
      { key: 'lastmonth', label: '上月', range: { startDate: iso(startOfMonth(pm)), endDate: iso(endOfMonth(pm)) } },
    ];
  }
  function buildWeeks() {
    const curMon = startOfWeek(new Date());
    const out = [];
    for (let i = 6; i >= -26; i--) {
      const mon = addDays(curMon, i * 7);
      const sun = addDays(mon, 6);
      const w = isoWeekNum(mon);
      out.push({ label: w.year + ' 第' + w.week + '周 · ' + md(mon) + '~' + md(sun), startDate: iso(mon), endDate: iso(sun) });
    }
    return out;
  }
  function buildMonths() {
    const cur = startOfMonth(new Date());
    const out = [];
    for (let i = 2; i >= -23; i--) {
      const m = addMonths(cur, i);
      out.push({ label: m.getFullYear() + '年' + (m.getMonth() + 1) + '月', startDate: iso(startOfMonth(m)), endDate: iso(endOfMonth(m)) });
    }
    return out;
  }

  const openInstances = new Set();
  document.addEventListener('mousedown', function (e) {
    openInstances.forEach(function (inst) {
      if (inst.open && !inst.root.contains(e.target)) inst._outside();
    });
  });

  class DateRangePicker {
    constructor(o) {
      o = o || {};
      this.root = o.mount;
      if (!this.root) throw new Error('DateRangePicker: 缺少 mount 容器');
      this.mode = (o.mode === 'week' || o.mode === 'month') ? o.mode : 'day';
      this.value = { startDate: o.startDate || '', endDate: o.endDate || '' };
      this.draft = { start: '', end: '' };
      this.viewMonth = startOfMonth(parse(this.value.startDate || iso(new Date())));
      this.onChange = typeof o.onChange === 'function' ? o.onChange : null;
      this.open = false;
      this._build();
    }

    _build() {
      this.root.classList.add('drp');
      this.root.innerHTML =
        '<div class="drp-controls">' +
          '<select class="drp-mode" title="时间维度">' +
            '<option value="day">按日</option><option value="week">按周</option><option value="month">按月</option>' +
          '</select>' +
          '<button type="button" class="drp-trigger" title="选择日期范围"><span class="drp-text"></span><span class="drp-caret">▾</span></button>' +
        '</div>' +
        '<div class="drp-panel drp-hidden"></div>';
      this.sel = this.root.querySelector('.drp-mode');
      this.trigger = this.root.querySelector('.drp-trigger');
      this.textEl = this.root.querySelector('.drp-text');
      this.panel = this.root.querySelector('.drp-panel');
      this.sel.value = this.mode;
      this.sel.onchange = () => this._setMode(this.sel.value);
      this.trigger.onclick = (e) => { e.stopPropagation(); this.toggle(); };
      this._sync();
    }

    _sync() {
      const s = this.value.startDate || '';
      const e = this.value.endDate || '';
      this.textEl.textContent = s ? (s === e ? s : s + ' ~ ' + e)
        : (this.mode === 'week' ? '选择周' : this.mode === 'month' ? '选择月份' : '选择日期范围');
      this.textEl.classList.toggle('drp-ph', !s);
    }

    _fire() { if (this.onChange) this.onChange(this.getValue()); }

    _setMode(m) {
      if (m === this.mode) return;
      this.mode = m;
      this.sel.value = m;
      if (this.value.startDate) {
        const s = parse(this.value.startDate);
        if (m === 'week') this.value = rangeOfWeek(s);
        else if (m === 'month') this.value = rangeOfMonth(s);
      }
      this.draft = { start: '', end: '' };
      this._sync();
      if (this.open) this._renderPanel();
      this._fire();
    }

    toggle() { this.open ? this._close() : this._show(); }

    _show() {
      openInstances.forEach((i) => { if (i !== this && i.open) i._outside(); });
      openInstances.add(this); // 关键：注册到打开实例集合，document mousedown 才能命中并触发容错关闭
      this.open = true;
      this.panel.classList.remove('drp-hidden');
      this._renderPanel();
    }

    _close() { this.open = false; openInstances.delete(this); this.panel.classList.add('drp-hidden'); }

    // 点击外部关闭：仅当用户已在面板里点过起始日期时才按容错规则提交（end=start），
    // 否则保留原有范围，避免「只是点开看看」误清空。
    _outside() {
      if (!this.open) return;
      if (this.draft.start) this._commit();
      else this._close();
    }

    _commit() {
      const s = this.draft.start || '';
      const e = this.draft.end || s; // 容错：只点了开始日期 -> end=start
      if (s) this.value = { startDate: s, endDate: e };
      this.draft = { start: '', end: '' };
      this._sync();
      this._close();
      this._fire();
    }

    _renderPanel() {
      this.panel.className = 'drp-panel drp-hidden';
      this.panel.classList.add('drp-p-' + this.mode);
      if (this.mode === 'day') this._renderDay();
      else if (this.mode === 'week') this._renderList(buildWeeks(), 'drp-list-week');
      else this._renderList(buildMonths(), 'drp-list-month');
      this.panel.classList.remove('drp-hidden');
    }

    _calHtml(monthDate) {
      const y = monthDate.getFullYear();
      const mo = monthDate.getMonth();
      const lead = (new Date(y, mo, 1).getDay() + 6) % 7;
      const days = new Date(y, mo + 1, 0).getDate();
      const hiS = this.draft.start || this.value.startDate;
      const hiE = this.draft.end || (this.draft.start ? this.draft.start : this.value.endDate);
      let cells = '';
      for (let i = 0; i < lead; i++) cells += '<span class="drp-cell drp-blank"></span>';
      for (let d = 1; d <= days; d++) {
        const ds = iso(new Date(y, mo, d));
        let cls = 'drp-cell';
        if (hiS && ds === hiS) cls += ' drp-sel';
        if (hiE && ds === hiE) cls += ' drp-sel';
        if (hiS && hiE && ds > hiS && ds < hiE) cls += ' drp-in';
        cells += '<button type="button" class="' + cls + '" data-date="' + ds + '">' + d + '</button>';
      }
      return '<div class="drp-cal"><div class="drp-cal-title">' + y + '年' + (mo + 1) + '月</div>' +
        '<div class="drp-cal-hd"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>' +
        '<div class="drp-cal-grid">' + cells + '</div></div>';
    }

    _renderDay() {
      const months = [this.viewMonth, addMonths(this.viewMonth, 1)];
      const quicks = quickRanges();
      this.panel.innerHTML =
        '<div class="drp-day">' +
          '<div class="drp-quick">' + quicks.map((q) => '<button type="button" data-q="' + q.key + '">' + q.label + '</button>').join('') + '</div>' +
          '<div class="drp-day-main">' +
            '<div class="drp-nav"><button type="button" data-nav="-1" title="上一月">‹</button><button type="button" data-nav="0" title="回到本月">今天</button><button type="button" data-nav="1" title="下一月">›</button></div>' +
            '<div class="drp-cals">' + months.map((m) => this._calHtml(m)).join('') + '</div>' +
            '<div class="drp-foot">' +
              '<button type="button" data-act="clear">清空</button><button type="button" class="primary" data-act="ok">确定</button></div>' +
          '</div>' +
        '</div>';
      this.panel.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
        const q = quicks.find((x) => x.key === b.dataset.q);
        if (!q) return;
        this.value = { startDate: q.range.startDate, endDate: q.range.endDate };
        this.viewMonth = startOfMonth(parse(q.range.startDate));
        this.draft = { start: '', end: '' };
        this._sync(); this._close(); this._fire();
      }));
      this.panel.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => {
        const n = Number(b.dataset.nav);
        this.viewMonth = n === 0 ? startOfMonth(new Date()) : addMonths(this.viewMonth, n);
        this._renderDay();
      }));
      this.panel.querySelectorAll('[data-date]').forEach((b) => (b.onclick = () => this._pickDay(b.dataset.date)));
      const clear = this.panel.querySelector('[data-act="clear"]');
      if (clear) clear.onclick = () => {
        this.value = { startDate: '', endDate: '' };
        this.draft = { start: '', end: '' };
        this._sync(); this._close(); this._fire();
      };
      const ok = this.panel.querySelector('[data-act="ok"]');
      if (ok) ok.onclick = () => this._commit();
    }

    _renderList(list, cls) {
      const cur = this.value.startDate;
      this.panel.innerHTML = '<div class="drp-list ' + cls + '">' + list.map((it) =>
        '<button type="button" class="drp-list-item' + (it.startDate === cur ? ' active' : '') + '" data-s="' + it.startDate + '" data-e="' + it.endDate + '">' + it.label + '</button>'
      ).join('') + '</div>';
      this.panel.querySelectorAll('.drp-list-item').forEach((b) => (b.onclick = () => {
        this.value = { startDate: b.dataset.s, endDate: b.dataset.e };
        this.draft = { start: '', end: '' };
        this._sync(); this._close(); this._fire();
      }));
    }

    _pickDay(s) {
      if (!this.draft.start || this.draft.end) {
        this.draft = { start: s, end: '' };
        this._renderDay();
      } else {
        if (s < this.draft.start) { this.draft.end = this.draft.start; this.draft.start = s; }
        else this.draft.end = s;
        this._commit();
      }
    }

    // ---------- 对外 API ----------
    getValue() { return { startDate: this.value.startDate || '', endDate: this.value.endDate || '', mode: this.mode }; }
    getRange() { return { startDate: this.value.startDate || '', endDate: this.value.endDate || '' }; }
    setValue(v, silent) {
      v = v || {};
      if (v.mode === 'day' || v.mode === 'week' || v.mode === 'month') { this.mode = v.mode; this.sel.value = v.mode; }
      this.value = { startDate: v.startDate || '', endDate: v.endDate || '' };
      this.draft = { start: '', end: '' };
      if (this.value.startDate) this.viewMonth = startOfMonth(parse(this.value.startDate));
      this._sync();
      if (this.open) this._renderPanel();
      if (!silent) this._fire();
    }
    destroy() { this._close(); openInstances.delete(this); this.root.innerHTML = ''; this.root.classList.remove('drp'); }
  }

  DateRangePicker.util = { iso, parse, addDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, isoWeekNum, rangeOfWeek, rangeOfMonth };
  window.DateRangePicker = DateRangePicker;
  if (window.ERP) window.ERP.DateRangePicker = DateRangePicker;
})();
