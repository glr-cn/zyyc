// ============================================================
//  快捷工具 → 条码设计
//  ------------------------------------------------------------
//  对齐参考产品（快标签编辑器）的核心能力：
//   1) 左侧：添加图片 / 文字（标题·副标题·正文）/ 条形码 / 二维码 / PDF417 / DataMatrix
//      / 线条 / 矩形 / 椭圆；可调纸张尺寸（mm）与预设。
//   2) 画布：mm 坐标精确排版，拖拽移动、8 向缩放、缩放比例、网格、撤销重做、图层上下移 / 复制 / 锁定 / 删除。
//   3) 右侧：对齐、位置尺寸、内容与样式（字体 / 字号 / 字间距 / 行间距 / 颜色 / 条码类型 / 显示文字）。
//   4) 数据源：文本 / 批量（Excel 整列粘贴，Tab 或逗号分列）/ 序号（前缀·起始·步长·位数·数量）。
//   5) 打印：浏览器原生打印通道（window.print + @page 精确纸张尺寸 + 0 边距），
//      条码以 SVG 矢量输出，任意 DPI 不糊边；支持打印机 X/Y 偏移校准。
//  条码引擎：本地 vendor/bwip-js-min.js（BWIPP，工业级，覆盖全部码制），按需懒加载。
//  纯逻辑函数挂在 window.ERP_BC_MODEL，供 scripts/test_barcode.js 单测。
// ============================================================
(function () {
  const PAGE = 'tool_barcode';
  const PX_PER_MM = 96 / 25.4;          // CSS 像素与毫米换算（100% 缩放）
  const TPL_KEY = 'erp_bc_templates_v1';
  const BWIP_SRC = 'vendor/bwip-js-min.js';
  const MAX_ELEMENTS = 200;

  // ============================================================
  //  一、纯逻辑（无 DOM 依赖，可单元测试）
  // ============================================================
  let _seq = 0;
  function nextId() {
    _seq += 1;
    return 'e' + Date.now().toString(36) + '_' + _seq;
  }

  const r1 = (n) => Math.round(Number(n) * 10) / 10;
  const r2 = (n) => Math.round(Number(n) * 100) / 100;

  function mmToPx(mm, zoom) { return Number(mm) * PX_PER_MM * (zoom == null ? 1 : zoom); }
  function pxToMm(px, zoom) { return Number(px) / (PX_PER_MM * (zoom == null ? 1 : zoom)); }

  const LABEL_PRESETS = [
    { name: '100 × 60 mm（默认）', widthMm: 100, heightMm: 60 },
    { name: '40 × 30 mm', widthMm: 40, heightMm: 30 },
    { name: '50 × 30 mm', widthMm: 50, heightMm: 30 },
    { name: '60 × 40 mm', widthMm: 60, heightMm: 40 },
    { name: '70 × 40 mm', widthMm: 70, heightMm: 40 },
    { name: '100 × 50 mm', widthMm: 100, heightMm: 50 },
    { name: '100 × 100 mm', widthMm: 100, heightMm: 100 },
    { name: '40 × 60 mm（竖）', widthMm: 40, heightMm: 60 },
  ];

  const SYMBOLOGIES = [
    { id: 'code128', name: 'Code 128（通用）' },
    { id: 'code39', name: 'Code 39' },
    { id: 'ean13', name: 'EAN-13' },
    { id: 'ean8', name: 'EAN-8' },
    { id: 'upca', name: 'UPC-A' },
    { id: 'itf14', name: 'ITF-14' },
    { id: 'pdf417', name: 'PDF417' },
    { id: 'datamatrix', name: 'DataMatrix' },
    { id: 'qrcode', name: '二维码 QR' },
  ];

  const FONT_OPTIONS = [
    { label: '微软雅黑', value: '"Microsoft YaHei", sans-serif' },
    { label: '黑体', value: 'SimHei, "Microsoft YaHei", sans-serif' },
    { label: '宋体', value: 'SimSun, serif' },
    { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
    { label: 'Times New Roman', value: '"Times New Roman", serif' },
    { label: '等宽 Consolas', value: 'Consolas, "Courier New", monospace' },
  ];

  function createLabel(patch) {
    return Object.assign({ version: 1, widthMm: 60, heightMm: 40, bg: '#ffffff', elements: [] }, patch || {});
  }

  /** 新建元素：每种类型给出贴近参考产品的默认尺寸与外观 */
  function createElement(type, patch) {
    const base = { id: nextId(), type: type, x: 2, y: 2, w: 40, h: 10, rotation: 0, locked: false };
    let el;
    if (type === 'text') {
      el = Object.assign({}, base, {
        w: 40, h: 8, text: '文本内容', fontSize: 10, fontFamily: FONT_OPTIONS[0].value,
        fontWeight: 'normal', color: '#111111', align: 'center', letterSpacing: 0,
        lineHeight: 1.2, isVar: false,
      });
    } else if (type === 'barcode') {
      el = Object.assign({}, base, {
        w: 40, h: 15, symbology: 'code128', text: 'B01-01',
        includetext: true, fontSize: 8, color: '#000000', isVar: false,
      });
    } else if (type === 'qrcode') {
      el = Object.assign({}, base, {
        w: 20, h: 20, symbology: 'qrcode', text: 'https://example.com', color: '#000000', isVar: false,
      });
    } else if (type === 'pdf417') {
      el = Object.assign({}, base, {
        w: 40, h: 16, symbology: 'pdf417', text: 'PDF417-TEST', color: '#000000', isVar: false,
      });
    } else if (type === 'datamatrix') {
      el = Object.assign({}, base, {
        w: 20, h: 20, symbology: 'datamatrix', text: 'DM-001', color: '#000000', isVar: false,
      });
    } else if (type === 'rect' || type === 'ellipse') {
      el = Object.assign({}, base, { w: 20, h: 10, fill: '#ffffff', stroke: '#333333', strokeWidth: 0.3 });
    } else if (type === 'line') {
      el = Object.assign({}, base, { w: 30, h: 1, stroke: '#333333', strokeWidth: 0.3 });
    } else if (type === 'image') {
      el = Object.assign({}, base, { w: 25, h: 25, src: '' });
    } else {
      throw new Error('未知元素类型：' + type);
    }
    return Object.assign(el, patch || {});
  }

  /** 限制在纸张范围内（不允许拖出纸外） */
  function clampElement(el, label) {
    const maxX = Math.max(0, Number(label.widthMm) - Number(el.w));
    const maxY = Math.max(0, Number(label.heightMm) - Number(el.h));
    return {
      x: r2(Math.min(Math.max(0, Number(el.x) || 0), maxX)),
      y: r2(Math.min(Math.max(0, Number(el.y) || 0), maxY)),
    };
  }

  /** 对齐：left / hcenter / right / top / vcenter / bottom */
  function alignTo(el, label, mode) {
    let x = Number(el.x) || 0;
    let y = Number(el.y) || 0;
    if (mode === 'left') x = 0;
    if (mode === 'hcenter') x = (Number(label.widthMm) - Number(el.w)) / 2;
    if (mode === 'right') x = Number(label.widthMm) - Number(el.w);
    if (mode === 'top') y = 0;
    if (mode === 'vcenter') y = (Number(label.heightMm) - Number(el.h)) / 2;
    if (mode === 'bottom') y = Number(label.heightMm) - Number(el.h);
    return clampElement(Object.assign({}, el, { x: x, y: y }), label);
  }

  /** 图层顺序：up 上移一层 / down 下移一层（数组尾部 = 最上层） */
  function moveLayer(list, id, dir) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const i = arr.findIndex((e) => e.id === id);
    if (i < 0) return arr;
    const j = dir === 'up' ? i + 1 : i - 1;
    if (j < 0 || j >= arr.length) return arr;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
    return arr;
  }

  /** 复制元素（新 id，位置右移 2mm 便于区分） */
  function duplicateElement(list, id) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const src = arr.find((e) => e.id === id);
    if (!src) return arr;
    const copy = Object.assign({}, src, { id: nextId(), x: r2(Number(src.x) + 2), y: r2(Number(src.y) + 2) });
    arr.push(copy);
    return arr;
  }

  /** 批量数据：每行一条；Tab / 逗号 / 分号分列（多变量按列顺序填充） */
  function parseBatch(text) {
    if (text == null) return [];
    return String(text)
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line.trim() !== '')
      .map((line) => line.split(/[\t,，;；]/).map((s) => s.trim()));
  }

  /** 序号：前缀 + 递增数字（补零到 pad 位），数量上限 5000 */
  function buildSeries(opts) {
    const o = opts || {};
    const prefix = String(o.prefix == null ? '' : o.prefix);
    const step = Number.isFinite(Number(o.step)) && Number(o.step) !== 0 ? Number(o.step) : 1;
    let value = Number.isFinite(Number(o.start)) ? Number(o.start) : 1;
    const pad = Math.max(0, Math.min(12, Math.floor(Number(o.pad) || 0)));
    const count = Math.max(0, Math.min(5000, Math.floor(Number(o.count) || 0)));
    const out = [];
    for (let i = 0; i < count; i++) {
      // 补零只作用于数字部分；负数符号单独拼，避免出现「--2」
      const negative = value < 0;
      const digits = pad > 0 ? String(Math.abs(value)).padStart(pad, '0') : String(Math.abs(value));
      out.push(prefix + (negative ? '-' : '') + digits);
      value += step;
    }
    return out;
  }

  /** 条码内容校验：返回中文错误提示，null 表示合法 */
  function validateContent(symbology, text) {
    const t = String(text == null ? '' : text);
    if (!t) return '内容不能为空';
    if (symbology === 'ean13' && !/^\d{12,13}$/.test(t)) return 'EAN-13 需 12 位（自动补校验位）或 13 位数字';
    if (symbology === 'ean8' && !/^\d{7,8}$/.test(t)) return 'EAN-8 需 7 位或 8 位数字';
    if (symbology === 'upca' && !/^\d{11,12}$/.test(t)) return 'UPC-A 需 11 位或 12 位数字';
    if (symbology === 'itf14' && !/^\d{13,14}$/.test(t)) return 'ITF-14 需 13 位或 14 位数字';
    if (symbology === 'code39' && !/^[0-9A-Z\-. $/+%]+$/.test(t)) return 'Code 39 仅支持 0-9 A-Z - . 空格 $ / + %';
    if (symbology === 'code128' && !/^[\x20-\x7E]+$/.test(t)) return 'Code 128 仅支持可见 ASCII 字符';
    return null;
  }

  /** 纸张尺寸归一化：10 ~ 300 mm，保留 1 位小数 */
  function sanitizeSize(v, def) {
    const n = Number(v);
    const d = def == null ? 60 : Number(def);
    if (!Number.isFinite(n) || n <= 0) return d;
    return r1(Math.min(300, Math.max(10, n)));
  }

  /** 模板序列化 / 反序列化（带结构校验，脏数据一律拒绝） */
  function serializeLabel(label) {
    return JSON.stringify({
      version: 1,
      widthMm: Number(label.widthMm),
      heightMm: Number(label.heightMm),
      bg: label.bg || '#ffffff',
      elements: Array.isArray(label.elements) ? label.elements : [],
    });
  }

  function parseLabel(json) {
    try {
      const o = typeof json === 'string' ? JSON.parse(json) : json;
      if (!o || typeof o !== 'object' || !Array.isArray(o.elements)) return null;
      const widthMm = sanitizeSize(o.widthMm, 60);
      const heightMm = sanitizeSize(o.heightMm, 40);
      const bg = /^#[0-9a-fA-F]{6}$/.test(o.bg || '') ? o.bg : '#ffffff';
      const elements = o.elements
        .filter((e) => e && typeof e === 'object' && e.type)
        .slice(0, MAX_ELEMENTS)
        .map((e) => Object.assign({ id: nextId(), x: 0, y: 0, w: 10, h: 5, rotation: 0, locked: false }, e));
      return { version: 1, widthMm: widthMm, heightMm: heightMm, bg: bg, elements: elements };
    } catch (err) {
      return null;
    }
  }

  window.ERP_BC_MODEL = {
    PX_PER_MM, LABEL_PRESETS, SYMBOLOGIES, FONT_OPTIONS, MAX_ELEMENTS,
    mmToPx, pxToMm, r1, r2,
    createLabel, createElement, clampElement, alignTo, moveLayer, duplicateElement,
    parseBatch, buildSeries, validateContent, sanitizeSize, serializeLabel, parseLabel,
  };

  // ============================================================
  //  二、页面
  // ============================================================
  /**
   * 默认画布模板：100 × 60 mm，仅保留「条形码 + 二维码」两个组件
   * 布局对齐参考稿：条形码通栏居中（含大字内容），二维码贴右下角，四周留 2~3mm 安全边距
   */
  function defaultTemplate() {
    const M = window.ERP_BC_MODEL;
    const label = M.createLabel({ widthMm: 100, heightMm: 60 });
    const barcode = M.createElement('barcode', {
      x: 2, y: 2, w: 96, h: 36,
      text: 'B01-01', fontSize: 26, includetext: true, symbology: 'code128',
    });
    const qr = M.createElement('qrcode', {
      x: 79, y: 40, w: 18, h: 18, text: 'B01-01', symbology: 'qrcode',
    });
    label.elements = [barcode, qr];
    return label;
  }

  function createPage() {
    const M = window.ERP_BC_MODEL;

    const state = {
      label: defaultTemplate(),
      selectedId: null,
      zoom: 1,
      autoFit: true,               // 自适应缩放：手动改缩放后置 false，调纸张后恢复
      grid: false,                 // 默认不显示网格：与参考稿一致，白底更干净
      dataMode: 'text',            // text | batch | series
      singleValue: '',
      batchRows: [],
      seriesRows: [],
      history: [],
      future: [],
    };
    let host = null;
    let bwipPromise = null;
    const $ = (id) => host && host.querySelector('#' + id);

    // ---------- 工具函数 ----------
    function toast(msg) {
      if (window.ERP && typeof window.ERP.toast === 'function') window.ERP.toast(msg);
      else alert(msg);
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }
    function ensureBwip() {
      if (window.bwipjs) return Promise.resolve();
      if (bwipPromise) return bwipPromise;
      bwipPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = BWIP_SRC;
        s.onload = () => resolve();
        s.onerror = () => { bwipPromise = null; reject(new Error('条码引擎加载失败：' + BWIP_SRC)); };
        document.head.appendChild(s);
      });
      return bwipPromise;
    }
    function selected() { return state.label.elements.find((e) => e.id === state.selectedId) || null; }

    // ---------- 历史（撤销 / 重做） ----------
    function snapshot() {
      state.history.push(M.serializeLabel(state.label));
      if (state.history.length > 80) state.history.shift();
      state.future = [];
    }
    function undo() {
      if (!state.history.length) return;
      state.future.push(M.serializeLabel(state.label));
      const prev = M.parseLabel(state.history.pop());
      if (prev) { state.label = prev; state.selectedId = null; renderAll(); }
    }
    function redo() {
      if (!state.future.length) return;
      state.history.push(M.serializeLabel(state.label));
      const next = M.parseLabel(state.future.pop());
      if (next) { state.label = next; state.selectedId = null; renderAll(); }
    }

    // ---------- 数据行 ----------
    function resolvedRows() {
      if (state.dataMode === 'batch') return state.batchRows.length ? state.batchRows : [['']];
      if (state.dataMode === 'series') return state.seriesRows.length ? state.seriesRows.map((v) => [v]) : [['']];
      return [[state.singleValue || '']];
    }

    /** 变量元素按出现顺序，依次使用当前数据行的第 1..n 列 */
    function applyRow(row) {
      const vars = state.label.elements.filter((e) => e.isVar && (e.type === 'text' || e.type === 'barcode' || e.type === 'qrcode' || e.type === 'pdf417' || e.type === 'datamatrix'));
      const values = {};
      vars.forEach((el, i) => {
        const v = row && row[i] != null ? row[i] : '';
        values[el.id] = v;
      });
      return values;
    }

    function resolvedContent(el, values) {
      if (values && Object.prototype.hasOwnProperty.call(values, el.id)) {
        const v = values[el.id];
        if (v !== '') return v;
      }
      return el.type === 'text' ? el.text : el.text;
    }

    // ---------- 条码渲染 ----------
    function barcodeSvg(el, value) {
      const err = M.validateContent(el.symbology, value);
      if (err) return '<div class="bc-invalid">' + esc(err) + '</div>';
      if (!window.bwipjs) return '<div class="bc-invalid">条码引擎加载中…</div>';
      try {
        const opts = {
          bcid: el.symbology,
          text: String(value),
          scale: 4,
          barcolor: String(el.color || '#000000').replace('#', ''),
          textcolor: String(el.color || '#000000').replace('#', ''),
        };
        if (el.type === 'barcode') {
          // 条高占元素高度的一半左右，剩余空间留给人眼可读文字（BWIPP 限制 textsize < 25）
          opts.height = Math.max(6, Math.min(60, (Number(el.h) || 15) * 0.55));
          opts.includetext = !!el.includetext;
          if (el.includetext) {
            opts.textxalign = 'center';
            opts.textsize = Math.max(4, Math.min(24, Number(el.fontSize) || 8));
          }
        }
        let svg = window.bwipjs.toSVG(opts);
        // 让矢量条码完整缩放填满元素盒子：保留/补出 viewBox，去掉固定宽高
        // （bwip-js 的部分码制输出不带 viewBox，直接改宽高会导致内容按原始像素绘制而被裁切）
        svg = svg.replace(/<svg([^>]*)>/, function (m, attrs) {
          const wm = /width="([\d.]+)/.exec(attrs);
          const hm = /height="([\d.]+)/.exec(attrs);
          const vb = /viewBox="([^"]+)"/.exec(attrs);
          const cleaned = attrs
            .replace(/\swidth="[^"]*"/g, '')
            .replace(/\sheight="[^"]*"/g, '')
            .replace(/\sviewBox="[^"]*"/g, '')
            .replace(/\spreserveAspectRatio="[^"]*"/g, '');
          let viewBox = vb ? vb[1] : (wm && hm ? '0 0 ' + wm[1] + ' ' + hm[1] : '');
          return '<svg' + cleaned +
            (viewBox ? ' viewBox="' + viewBox + '"' : '') +
            ' width="100%" height="100%" preserveAspectRatio="none">';
        });
        return svg;
      } catch (e) {
        return '<div class="bc-invalid">条码生成失败：' + esc(e.message || e) + '</div>';
      }
    }

    // ---------- 元素 HTML（画布与打印共用，坐标全部用 mm） ----------
    function elStyle(el) {
      return 'left:' + el.x + 'mm;top:' + el.y + 'mm;width:' + el.w + 'mm;height:' + el.h + 'mm;' +
        (Number(el.rotation) ? 'transform:rotate(' + Number(el.rotation) + 'deg);' : '');
    }

    function elInner(el, value) {
      if (el.type === 'text') {
        return '<div class="bc-text" style="font-size:' + (Number(el.fontSize) || 10) + 'pt;' +
          'font-family:' + el.fontFamily + ';font-weight:' + (el.fontWeight || 'normal') + ';' +
          'color:' + (el.color || '#111111') + ';text-align:' + (el.align || 'center') + ';' +
          'letter-spacing:' + (Number(el.letterSpacing) || 0) + 'pt;line-height:' + (Number(el.lineHeight) || 1.2) + ';">' +
          esc(value) + '</div>';
      }
      if (el.type === 'barcode' || el.type === 'qrcode' || el.type === 'pdf417' || el.type === 'datamatrix') {
        return '<div class="bc-code">' + barcodeSvg(el, value) + '</div>';
      }
      if (el.type === 'rect') {
        return '<div class="bc-shape" style="background:' + (el.fill || 'transparent') + ';' +
          'border:' + (Number(el.strokeWidth) || 0) + 'mm solid ' + (el.stroke || 'transparent') + ';"></div>';
      }
      if (el.type === 'ellipse') {
        return '<div class="bc-shape bc-ellipse" style="background:' + (el.fill || 'transparent') + ';' +
          'border:' + (Number(el.strokeWidth) || 0) + 'mm solid ' + (el.stroke || 'transparent') + ';"></div>';
      }
      if (el.type === 'line') {
        return '<div class="bc-line" style="border-top:' + (Number(el.strokeWidth) || 0.3) + 'mm solid ' + (el.stroke || '#333') + ';"></div>';
      }
      if (el.type === 'image') {
        return el.src ? '<img class="bc-img" src="' + esc(el.src) + '" alt="">' : '<div class="bc-invalid">未选择图片</div>';
      }
      return '';
    }

    function elementHtml(el, values, opts) {
      const o = opts || {};
      const value = resolvedContent(el, values);
      return '<div class="bc-el bc-el-' + el.type + (o.selected ? ' selected' : '') +
        (el.locked ? ' locked' : '') + '" data-id="' + el.id + '" style="' + elStyle(el) + '">' +
        elInner(el, value) + '</div>';
    }

    // ---------- 渲染 ----------
    function renderSurface() {
      const surface = $('bcSurface');
      const label = state.label;
      surface.style.width = label.widthMm + 'mm';
      surface.style.height = label.heightMm + 'mm';
      surface.style.background = label.bg || '#ffffff';
      surface.classList.toggle('bc-grid', state.grid);

      const values = applyRow(resolvedRows()[0] || ['']);
      const html = label.elements.map((el) => elementHtml(el, values, { selected: el.id === state.selectedId })).join('');
      $('bcElements').innerHTML = html;
      renderOverlay();
      // 画布缩放用 transform 实现，占位尺寸 = 缩放后尺寸（外层 padding 负责留白），避免高倍缩放被裁掉
      const inner = $('bcCanvasInner');
      if (inner) {
        inner.style.width = (M.mmToPx(label.widthMm, 1) * state.zoom) + 'px';
        inner.style.height = (M.mmToPx(label.heightMm, 1) * state.zoom) + 'px';
      }
      $('bcZoomLabel').textContent = Math.round(state.zoom * 100) + '%';
      const zoom2 = $('bcZoomLabel2');
      if (zoom2) zoom2.textContent = Math.round(state.zoom * 100) + '%';
      renderRulers();
      renderElList();
    }

    /** 标尺：顶部/左侧 mm 刻度（每 1mm 细线，每 10mm 数字） */
    function renderRulers() {
      const top = $('bcRulerTop');
      const left = $('bcRulerLeft');
      if (!top || !left) return;
      const label = state.label;
      const wPx = M.mmToPx(label.widthMm, 1) * state.zoom;
      const hPx = M.mmToPx(label.heightMm, 1) * state.zoom;
      const step = M.mmToPx(1, 1) * state.zoom;       // 1mm 对应像素
      const majorStep = step * 10;

      top.style.width = wPx + 'px';
      top.style.backgroundSize = step + 'px 100%';
      left.style.height = hPx + 'px';
      left.style.backgroundSize = '100% ' + step + 'px';

      let ticks = '';
      for (let mm = 10; mm <= label.widthMm; mm += 10) {
        ticks += '<span class="bc-tick" style="left:' + (mm * step) + 'px">' + mm + '</span>';
      }
      top.innerHTML = ticks;
      ticks = '';
      for (let mm = 10; mm <= label.heightMm; mm += 10) {
        ticks += '<span class="bc-tick bc-tick-v" style="top:' + (mm * step) + 'px">' + mm + '</span>';
      }
      left.innerHTML = ticks;
      // 大刻度用更深的分隔线覆盖（每 10mm）
      top.style.backgroundImage =
        'repeating-linear-gradient(to right, #c7ced9 0 1px, transparent 1px ' + step + 'px),' +
        'repeating-linear-gradient(to right, #9aa5b4 0 1px, transparent 1px ' + majorStep + 'px)';
      top.style.backgroundSize = step + 'px 100%, ' + majorStep + 'px 100%';
      left.style.backgroundImage =
        'repeating-linear-gradient(to bottom, #c7ced9 0 1px, transparent 1px ' + step + 'px),' +
        'repeating-linear-gradient(to bottom, #9aa5b4 0 1px, transparent 1px ' + majorStep + 'px)';
      left.style.backgroundSize = '100% ' + step + 'px, 100% ' + majorStep + 'px';
    }

    /** 「我的」元素列表：点选定位，便于精确选中小元素 */
    function renderElList() {
      const box = $('bcElList');
      if (!box) return;
      if (!state.label.elements.length) {
        box.innerHTML = '<div class="bc-el-list-empty">暂无元素</div>';
        return;
      }
      const typeName = { barcode: '条形码', qrcode: '二维码', text: '文字', pdf417: 'PDF417', datamatrix: 'DataMatrix', rect: '矩形', ellipse: '椭圆', line: '线条', image: '图片' };
      box.innerHTML = state.label.elements.slice().reverse().map((el) => {
        const snippet = String(el.text || '').slice(0, 18) || typeName[el.type] || el.type;
        return '<div class="bc-el-row' + (el.id === state.selectedId ? ' active' : '') + '" data-eid="' + el.id + '">' +
          '<span class="bc-el-type">' + (typeName[el.type] || el.type) + '</span>' +
          '<span class="bc-el-snippet">' + esc(snippet) + '</span>' +
          (el.locked ? '<span class="bc-el-lock">锁</span>' : '') +
          '</div>';
      }).join('');
    }

    function renderOverlay() {
      const box = $('bcOverlay');
      const el = selected();
      if (!el) { box.innerHTML = ''; box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.style.left = el.x + 'mm';
      box.style.top = el.y + 'mm';
      box.style.width = el.w + 'mm';
      box.style.height = el.h + 'mm';
      box.classList.toggle('locked', !!el.locked);
      box.innerHTML = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
        .map((d) => '<span class="bc-handle bc-handle-' + d + '" data-dir="' + d + '"></span>')
        .join('') +
        (el.locked ? '' : '<span class="bc-tag">' + esc(el.type) + '</span>');
    }

    function renderPanel() {
      const el = selected();
      $('bcEmptyPanel').style.display = el ? 'none' : '';
      $('bcProps').style.display = el ? '' : 'none';
      if (!el) return;

      $('bcPosX').value = el.x;
      $('bcPosY').value = el.y;
      $('bcPosW').value = el.w;
      $('bcPosH').value = el.h;
      $('bcRotation').value = el.rotation || 0;

      // 仅保留条码 / 二维码属性区（其余元素类型已从工具箱移除）
      const isCode = ['barcode', 'qrcode', 'pdf417', 'datamatrix'].indexOf(el.type) >= 0;
      $('bcCodeProps').style.display = isCode ? '' : 'none';

      $('bcLocked').checked = !!el.locked;
      $('bcElTypeLabel').textContent = ({
        text: '文字', barcode: '条形码', qrcode: '二维码', pdf417: 'PDF417',
        datamatrix: 'DataMatrix', rect: '矩形', ellipse: '椭圆', line: '线条', image: '图片',
      })[el.type] || el.type;

      if (isCode) {
        $('bcSymbology').value = el.symbology;
        $('bcSymbology').disabled = el.type !== 'barcode';
        $('bcCodeText').value = el.text || '';
        $('bcIncludeText').checked = !!el.includetext;
        $('bcIncludeTextRow').style.display = el.type === 'barcode' ? '' : 'none';
        $('bcCodeFontSize').value = el.fontSize || 8;
        $('bcCodeColor').value = el.color || '#000000';
        $('bcIsVar').checked = !!el.isVar;
        const err = M.validateContent(el.symbology, el.text || '');
        $('bcCodeError').style.display = err ? '' : 'none';
        $('bcCodeError').textContent = err || '';
      }
    }

    function renderAll() {
      renderSurface();
      renderPanel();
      updateDataStats();
      renderTemplates();
      updateSizeText();
    }

    // ---------- 选择 / 拖动 / 缩放 ----------
    let drag = null;

    function beginDrag(e, el, dir) {
      if (!el || el.locked) return;
      e.preventDefault();
      snapshot();
      drag = {
        id: el.id, dir: dir || null,
        startX: e.clientX, startY: e.clientY,
        orig: { x: el.x, y: el.y, w: el.w, h: el.h },
        moved: false,
      };
      document.addEventListener('pointermove', onDragMove);
      document.addEventListener('pointerup', endDrag);
    }

    function onDragMove(e) {
      if (!drag) return;
      const el = state.label.elements.find((x) => x.id === drag.id);
      if (!el) return;
      const dx = M.r2(M.pxToMm(e.clientX - drag.startX, state.zoom));
      const dy = M.r2(M.pxToMm(e.clientY - drag.startY, state.zoom));
      if (!drag.moved && Math.abs(e.clientX - drag.startX) < 2 && Math.abs(e.clientY - drag.startY) < 2) return;
      drag.moved = true;

      if (!drag.dir) {
        const c = M.clampElement({ x: drag.orig.x + dx, y: drag.orig.y + dy, w: el.w, h: el.h }, state.label);
        el.x = c.x; el.y = c.y;
      } else {
        const min = 2;
        let x = drag.orig.x, y = drag.orig.y, w = drag.orig.w, h = drag.orig.h;
        if (drag.dir.indexOf('e') >= 0) w = Math.max(min, drag.orig.w + dx);
        if (drag.dir.indexOf('s') >= 0) h = Math.max(min, drag.orig.h + dy);
        if (drag.dir.indexOf('w') >= 0) {
          w = Math.max(min, drag.orig.w - dx);
          x = drag.orig.x + (drag.orig.w - w);
        }
        if (drag.dir.indexOf('n') >= 0) {
          h = Math.max(min, drag.orig.h - dy);
          y = drag.orig.y + (drag.orig.h - h);
        }
        if (el.type === 'line') h = Math.max(1, h);
        const c = M.clampElement({ x: x, y: y, w: M.r2(w), h: M.r2(h) }, state.label);
        el.x = c.x; el.y = c.y; el.w = M.r2(w); el.h = M.r2(h);
      }

      // 拖动过程只更新当前节点几何，避免重建条码 SVG 造成卡顿
      const node = $('bcElements').querySelector('[data-id="' + el.id + '"]');
      if (node) node.setAttribute('style', elStyle(el));
      renderOverlay();
      $('bcPosX').value = el.x; $('bcPosY').value = el.y;
      $('bcPosW').value = el.w; $('bcPosH').value = el.h;
    }

    function endDrag() {
      document.removeEventListener('pointermove', onDragMove);
      document.removeEventListener('pointerup', endDrag);
      if (drag && drag.moved) { renderSurface(); renderPanel(); }
      drag = null;
    }

    function bindCanvas() {
      const surface = $('bcSurface');
      surface.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest && e.target.closest('.bc-handle');
        if (handle) {
          const el = selected();
          if (el) beginDrag(e, el, handle.dataset.dir);
          return;
        }
        const node = e.target.closest && e.target.closest('.bc-el');
        if (!node) {
          state.selectedId = null;
          renderSurface(); renderPanel();
          return;
        }
        const el = state.label.elements.find((x) => x.id === node.dataset.id);
        if (!el) return;
        if (state.selectedId !== el.id) {
          state.selectedId = el.id;
          renderSurface(); renderPanel();
        }
        beginDrag(e, el, null);
      });

      // 滚轮缩放（Ctrl + 滚轮）
      surface.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        setZoom(state.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
      }, { passive: false });
    }

    // ---------- 增删改 ----------
    function addElement(type) {
      if (state.label.elements.length >= M.MAX_ELEMENTS) { toast('元素数量已达上限 ' + M.MAX_ELEMENTS); return; }
      snapshot();
      const count = state.label.elements.length;
      const el = M.createElement(type, { x: 2 + (count % 5), y: 2 + (count % 5) });
      state.label.elements.push(el);
      state.selectedId = el.id;
      renderAll();
      toast('已添加' + ({ text: '文字', barcode: '条形码', qrcode: '二维码', pdf417: 'PDF417', datamatrix: 'DataMatrix', rect: '矩形', ellipse: '椭圆', line: '线条', image: '图片' })[type]);
    }

    function deleteSelected() {
      const el = selected();
      if (!el) return;
      snapshot();
      state.label.elements = state.label.elements.filter((x) => x.id !== el.id);
      state.selectedId = null;
      renderAll();
    }

    /** 修改选中元素：统一入口（自动记录历史 + 重绘） */
    function patchSelected(patch, options) {
      const el = selected();
      if (!el) return;
      if (!(options && options.silent)) snapshot();
      Object.assign(el, patch);
      const c = M.clampElement(el, state.label);
      el.x = c.x; el.y = c.y;
      renderAll();
    }

    // ---------- 数据源 ----------
    function updateDataStats() {
      const stats = $('bcDataStats');
      if (state.dataMode === 'batch') {
        stats.textContent = state.batchRows.length ? '共 ' + state.batchRows.length + ' 条数据' : '尚未粘贴数据';
      } else if (state.dataMode === 'series') {
        stats.textContent = state.seriesRows.length ? '共 ' + state.seriesRows.length + ' 条序号' : '尚未生成序号';
      } else {
        stats.textContent = '单条文本';
      }
      const vars = state.label.elements.filter((e) => e.isVar).length;
      $('bcVarHint').textContent = vars ? '已标记 ' + vars + ' 个变量元素（按顺序取第 1..' + vars + ' 列）' : '提示：在元素属性里勾选「作为批量变量」后，批量数据才会填入';
      $('bcVarHint').style.display = vars ? 'none' : '';
    }

    function switchDataMode(mode) {
      state.dataMode = mode;
      ['text', 'batch', 'series'].forEach((m) => {
        const btn = $('bcTab-' + m);
        if (btn) btn.classList.toggle('active', m === mode);
      });
      $('bcDataText').style.display = mode === 'text' ? '' : 'none';
      $('bcDataBatch').style.display = mode === 'batch' ? '' : 'none';
      $('bcDataSeries').style.display = mode === 'series' ? '' : 'none';
      updateDataStats();
      renderSurface();
    }

    // ---------- 打印 ----------
    function buildPrintHtml(rows) {
      const label = state.label;
      const offX = Number($('bcOffX').value) || 0;
      const offY = Number($('bcOffY').value) || 0;
      return rows.map((row) => {
        const values = applyRow(row);
        const inner = label.elements.map((el) => elementHtml(el, values, {})).join('');
        return '<div class="bc-print-label"><div class="bc-print-inner" style="transform:translate(' +
          offX + 'mm,' + offY + 'mm)">' + inner + '</div></div>';
      }).join('');
    }

    async function doPrint() {
      const btn = $('bcPrintBtn');
      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = '准备中…';
      try {
        await ensureBwip();
        const rows = resolvedRows().filter((r) => r.some((v) => String(v).trim() !== ''));
        if (!rows.length) { toast('没有可打印的数据，请先填写内容或批量数据'); return; }
        const vars = state.label.elements.filter((e) => e.isVar).length;
        if (state.dataMode !== 'text' && !vars) {
          toast('批量/序号模式需要先在元素属性中勾选「作为批量变量」');
          return;
        }
        if (state.dataMode === 'text' && !vars && !state.label.elements.some((e) => e.type !== 'rect' && e.type !== 'ellipse' && e.type !== 'line')) {
          toast('画布是空的，请先添加内容');
          return;
        }

        const label = state.label;
        let root = document.getElementById('bcPrintRoot');
        if (!root) {
          root = document.createElement('div');
          root.id = 'bcPrintRoot';
          root.className = 'bc-print-root';
          document.body.appendChild(root);
        }
        let style = document.getElementById('bcPrintStyle');
        if (!style) {
          style = document.createElement('style');
          style.id = 'bcPrintStyle';
          document.head.appendChild(style);
        }
        style.textContent =
          '@page{size:' + label.widthMm + 'mm ' + label.heightMm + 'mm;margin:0}' +
          'body.bc-printing #app{display:none!important}' +
          'body.bc-printing .bc-print-root{display:block!important}' +
          '.bc-print-root{display:none}' +
          '.bc-print-label{position:relative;overflow:hidden;background:' + (label.bg || '#ffffff') + ';' +
            'width:' + label.widthMm + 'mm;height:' + label.heightMm + 'mm;page-break-after:always;break-after:page;}' +
          '.bc-print-label:last-child{page-break-after:auto;break-after:auto}' +
          '.bc-print-inner{position:absolute;left:0;top:0;width:100%;height:100%}' +
          '.bc-print-inner .bc-el{position:absolute;overflow:hidden}' +
          '.bc-print-inner .bc-text{width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:inherit;white-space:pre-wrap;word-break:break-all}' +
          '.bc-print-inner .bc-code{width:100%;height:100%;display:flex;align-items:center;justify-content:center}' +
          '.bc-print-inner .bc-code svg{display:block}' +
          '.bc-print-inner .bc-shape{width:100%;height:100%;box-sizing:border-box}' +
          '.bc-print-inner .bc-ellipse{border-radius:50%}' +
          '.bc-print-inner .bc-line{width:100%;position:absolute;top:50%}' +
          '.bc-print-inner .bc-img{width:100%;height:100%;object-fit:contain}' +
          '.bc-print-inner .bc-invalid{font-size:6pt;color:#c00;padding:1mm;text-align:center}';

        root.innerHTML = buildPrintHtml(rows);
        document.body.classList.add('bc-printing');
        const cleanup = () => {
          document.body.classList.remove('bc-printing');
          root.innerHTML = '';
          window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        setTimeout(() => window.print(), 60);
        setTimeout(cleanup, 60000); // 兜底：部分浏览器不触发 afterprint
      } catch (e) {
        toast(e.message || String(e));
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }

    // ---------- 导出 PNG ----------
    async function exportPng() {
      const btn = $('bcPngBtn');
      btn.disabled = true;
      try {
        btn.textContent = '生成中…';
        await ensureBwip();
        if (!window.htmlToImage) throw new Error('图片导出库未加载');
        const blob = await window.htmlToImage.toBlob($('bcSurface'), {
          pixelRatio: 4, backgroundColor: '#ffffff', cacheBust: true,
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '条码标签_' + state.label.widthMm + 'x' + state.label.heightMm + 'mm.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast('已导出 PNG');
      } catch (e) {
        toast('导出失败：' + (e.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = '导出 PNG';
      }
    }

    // ---------- 模板 ----------
    function readTemplates() {
      try {
        const raw = localStorage.getItem(TPL_KEY);
        const o = raw ? JSON.parse(raw) : {};
        return o && typeof o === 'object' ? o : {};
      } catch (e) { return {}; }
    }
    function writeTemplates(obj) {
      try { localStorage.setItem(TPL_KEY, JSON.stringify(obj)); } catch (e) { toast('模板保存失败（本地存储不可用）'); }
    }
    function renderTemplates(keepValue) {
      const sel = $('bcTplSelect');
      if (!sel) return;
      const cur = keepValue != null ? keepValue : sel.value;
      const tpls = readTemplates();
      const names = Object.keys(tpls).sort();
      sel.innerHTML = '<option value="">— 选择模板 —</option>' +
        names.map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
      if (cur && names.indexOf(cur) >= 0) sel.value = cur;
    }
    function saveTemplate() {
      const name = prompt('模板名称（同名会覆盖）：', '标签模板 ' + new Date().toLocaleDateString('zh-CN'));
      if (!name) return;
      const tpls = readTemplates();
      tpls[name] = M.parseLabel(M.serializeLabel(state.label));
      writeTemplates(tpls);
      renderTemplates(name);
      toast('模板「' + name + '」已保存');
    }
    function loadTemplate() {
      const name = $('bcTplSelect').value;
      if (!name) { toast('请先选择一个模板'); return; }
      const tpls = readTemplates();
      const label = M.parseLabel(tpls[name]);
      if (!label) { toast('模板数据已损坏，无法载入'); return; }
      snapshot();
      state.label = label;
      state.selectedId = null;
      $('bcWidth').value = label.widthMm;
      $('bcHeight').value = label.heightMm;
      renderAll();
      toast('已载入模板「' + name + '」');
    }
    function deleteTemplate() {
      const name = $('bcTplSelect').value;
      if (!name) { toast('请先选择一个模板'); return; }
      if (!confirm('删除模板「' + name + '」？')) return;
      const tpls = readTemplates();
      delete tpls[name];
      writeTemplates(tpls);
      renderTemplates('');
      toast('已删除');
    }

    // ---------- 缩放 / 网格 / 自适应 ----------
    function applyZoom() {
      const wrap = $('bcSurfaceWrap');
      if (wrap) wrap.style.transform = 'scale(' + state.zoom + ')';
      renderSurface();
    }

    /** 同步缩放下拉框；isFit=true 时把自适应比例作为临时选项显示 */
    function syncZoomSelect(isFit) {
      const sel = $('bcZoomSelect');
      if (!sel) return;
      const old = sel.querySelector('option[data-fit="1"]');
      if (old) old.remove();
      if (isFit && !sel.querySelector('option[value="' + state.zoom + '"]')) {
        const o = document.createElement('option');
        o.value = String(state.zoom);
        o.dataset.fit = '1';
        o.textContent = Math.round(state.zoom * 100) + '%（自适应）';
        sel.appendChild(o);
      }
      sel.value = String(state.zoom);
    }

    function setZoom(z) {
      state.autoFit = false;
      state.zoom = Math.min(4, Math.max(0.3, Math.round(Number(z) * 100) / 100));
      syncZoomSelect(false);
      applyZoom();
    }

    /** 自适应画布：让整张标签完整落在可视框内（不溢出、不留过多空白） */
    function fitToView() {
      const scroller = host && host.querySelector('.bc-canvas-scroll');
      if (!scroller) return;
      const cw = scroller.clientWidth;
      const ch = scroller.clientHeight;
      // 标签页首次渲染时视图为 display:none，尺寸为 0；此时不计算，等 ResizeObserver 回调再适配
      if (cw < 120 || ch < 120) return;
      const availW = cw - 56;
      const availH = ch - 56;
      const w = M.mmToPx(state.label.widthMm, 1);
      const h = M.mmToPx(state.label.heightMm, 1);
      if (!w || !h) return;
      const fit = Math.min(availW / w, availH / h);
      state.autoFit = true;
      state.zoom = Math.min(3, Math.max(0.3, Math.floor(fit * 100) / 100));
      syncZoomSelect(true);
      applyZoom();
    }

    let resizeTimer = null;
    function onResize() {
      if (!state.autoFit) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitToView, 180);
    }

    // ---------- 模板字符串 ----------
    function pageHtml() {
      const presetOpts = M.LABEL_PRESETS.map((p) => '<option value="' + p.widthMm + 'x' + p.heightMm + '">' + p.name + '</option>').join('');
      const symOpts = M.SYMBOLOGIES.map((s) => '<option value="' + s.id + '">' + s.name + '</option>').join('');
      return `
      <div class="bc-app">
        <header class="bc-appbar">
          <div class="bc-brand"><span class="bc-logo">佐</span><span class="bc-brand-name">条码设计</span></div>
          <div class="bc-appbar-right">
            <select id="bcTplSelect" class="bc-tpl-select"><option value="">— 选择模板 —</option></select>
            <button type="button" class="ghost" id="bcTplSave">保存模板</button>
            <button type="button" class="ghost" id="bcTplLoad">载入</button>
            <button type="button" class="ghost" id="bcTplDelete">删除</button>
            <button type="button" class="bc-green" id="bcPrintBtn">导出作品</button>
          </div>
        </header>

        <div class="bc-body">
          <div class="bc-designer">
            <!-- 左侧工具轨 -->
            <nav class="bc-rail">
              <button type="button" class="bc-rail-btn active" data-panel="add">添加</button>
              <button type="button" class="bc-rail-btn" data-panel="paper">纸张</button>
              <button type="button" class="bc-rail-btn" data-panel="mine">我的</button>
            </nav>

            <!-- 左侧面板 -->
            <aside class="bc-side">
              <div class="bc-panel" data-panel="add">
                <div class="bc-group-title">添加组件</div>
                <div class="bc-tile-row">
                  <button type="button" class="bc-tile" data-add="barcode">条形码</button>
                  <button type="button" class="bc-tile" data-add="qrcode">二维码</button>
                </div>
                <div class="bc-hint">内容可在右侧修改；条形码支持 Code128 / Code39 / EAN / UPC / ITF 等 9 种码制。</div>
                <div class="bc-group-title">纸张</div>
                <button type="button" class="ghost bc-full" id="bcOpenSize">设置尺寸</button>
                <div class="bc-hint">当前：<span id="bcSizeText">—</span></div>
              </div>

              <div class="bc-panel" data-panel="paper" style="display:none">
                <div class="bc-group-title">纸张尺寸（mm）</div>
                <select id="bcPreset">${presetOpts}</select>
                <div class="bc-row2">
                  <label>宽 <input type="number" id="bcWidth" min="10" max="300" step="0.1"></label>
                  <label>高 <input type="number" id="bcHeight" min="10" max="300" step="0.1"></label>
                </div>
                <button type="button" class="ghost bc-full" id="bcApplySize">应用尺寸</button>
              </div>

              <div class="bc-panel" data-panel="mine" style="display:none">
                <div class="bc-group-title">我的元素</div>
                <div id="bcElList" class="bc-el-list"></div>
              </div>
            </aside>

        <!-- 中间：画布 -->
        <section class="bc-main">
          <div class="bc-toolbar">
            <button type="button" class="ghost" id="bcUndo" title="撤销 (Ctrl+Z)">撤销</button>
            <button type="button" class="ghost" id="bcRedo" title="重做 (Ctrl+Y)">重做</button>
            <span class="bc-sep"></span>
            <label class="bc-inline">缩放
              <select id="bcZoomSelect">
                <option value="0.5">50%</option><option value="0.75">75%</option>
                <option value="1">100%</option><option value="1.25">125%</option>
                <option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option>
              </select>
            </label>
            <label class="bc-inline"><input type="checkbox" id="bcGridToggle"> 网格</label>
            <span class="bc-sep"></span>
            <button type="button" class="ghost" id="bcDup" title="复制 (Ctrl+D)">复制</button>
            <button type="button" class="ghost" id="bcLayerUp">上移一层</button>
            <button type="button" class="ghost" id="bcLayerDown">下移一层</button>
            <button type="button" class="ghost" id="bcDelete">删除</button>
            <button type="button" class="ghost" id="bcFit" title="按可视区域自动缩放，让整张标签完整显示">适应画布</button>
          </div>
          <div class="bc-canvas-scroll">
            <div class="bc-canvas-inner" id="bcCanvasInner">
              <div class="bc-ruler-top" id="bcRulerTop"></div>
              <div class="bc-ruler-left" id="bcRulerLeft"></div>
              <div class="bc-surface-wrap" id="bcSurfaceWrap">
                <div class="bc-surface" id="bcSurface">
                  <div class="bc-elements" id="bcElements"></div>
                  <div class="bc-overlay" id="bcOverlay" style="display:none"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="bc-tip">拖动元素移动，拖动手柄缩放；Ctrl + 滚轮缩放画布；Delete 删除，Ctrl+D 复制，方向键微调 0.5mm（Shift 0.1mm）</div>
        </section>

        <!-- 右侧：属性 / 数据 / 打印 -->
        <aside class="bc-props">
          <button type="button" class="ghost bc-full" id="bcPngBtn">导出 PNG</button>

          <div class="bc-section">
            <div class="bc-props-title">尺寸</div>
            <div class="bc-size-line">
              <span id="bcSizeText2">—</span>
              <button type="button" class="ghost" id="bcOpenSize2">调整尺寸</button>
            </div>
          </div>

          <div class="bc-section">
            <div class="bc-props-title">背景颜色</div>
            <input type="color" id="bcBgColor" class="bc-color-wide" value="#ffffff">
          </div>

          <div class="bc-align">
            <button type="button" class="ghost" data-align="left" title="左对齐">左</button>
            <button type="button" class="ghost" data-align="hcenter" title="水平居中">中</button>
            <button type="button" class="ghost" data-align="right" title="右对齐">右</button>
            <button type="button" class="ghost" data-align="top" title="顶对齐">上</button>
            <button type="button" class="ghost" data-align="vcenter" title="垂直居中">中</button>
            <button type="button" class="ghost" data-align="bottom" title="底对齐">下</button>
          </div>

          <div class="bc-empty-panel" id="bcEmptyPanel">在画布中选择一个元素，或从左侧添加。</div>

          <div id="bcProps" style="display:none">
            <div class="bc-props-title">元素：<span id="bcElTypeLabel">—</span>
              <label class="bc-inline bc-lock"><input type="checkbox" id="bcLocked"> 锁定</label>
            </div>

            <div class="bc-field-grid">
              <label>X <input type="number" id="bcPosX" step="0.1"></label>
              <label>Y <input type="number" id="bcPosY" step="0.1"></label>
              <label>宽 <input type="number" id="bcPosW" step="0.1" min="1"></label>
              <label>高 <input type="number" id="bcPosH" step="0.1" min="1"></label>
              <label>旋转 <input type="number" id="bcRotation" step="1"></label>
            </div>

            <!-- 条码 / 二维码属性 -->
            <div id="bcCodeProps" class="bc-prop-section">
              <label class="bc-block">码制<select id="bcSymbology">${symOpts}</select></label>
              <label class="bc-block">内容<input type="text" id="bcCodeText" spellcheck="false"></label>
              <div class="bc-error" id="bcCodeError" style="display:none"></div>
              <div class="bc-field-grid">
                <label>条码颜色 <input type="color" id="bcCodeColor"></label>
                <label>字号(pt) <input type="number" id="bcCodeFontSize" step="0.5" min="4" max="24"></label>
              </div>
              <div class="bc-field-grid" id="bcIncludeTextRow">
                <label class="bc-check"><input type="checkbox" id="bcIncludeText"> 显示文字</label>
              </div>
              <label class="bc-check"><input type="checkbox" id="bcIsVar"> 作为批量变量</label>
            </div>
          </div>

          <div class="bc-divider"></div>

          <!-- 数据源 -->
          <div class="bc-props-title">数据源</div>
          <div class="bc-tabs">
            <button type="button" class="bc-tab active" id="bcTab-text">文本</button>
            <button type="button" class="bc-tab" id="bcTab-batch">批量</button>
            <button type="button" class="bc-tab" id="bcTab-series">序号</button>
          </div>

          <div id="bcDataText">
            <label class="bc-block">文本内容（无变量时直接写入选中元素）
              <input type="text" id="bcSingleValue" spellcheck="false">
            </label>
          </div>

          <div id="bcDataBatch" style="display:none">
            <label class="bc-block">批量数据（每行一条；Tab / 逗号分列）
              <textarea id="bcBatchInput" rows="6" spellcheck="false" placeholder="B01-01&#10;B01-02&#10;B01-03"></textarea>
            </label>
          </div>

          <div id="bcDataSeries" style="display:none">
            <div class="bc-field-grid">
              <label>前缀 <input type="text" id="bcSeriesPrefix" value="B"></label>
              <label>起始 <input type="number" id="bcSeriesStart" value="1"></label>
              <label>步长 <input type="number" id="bcSeriesStep" value="1"></label>
              <label>位数 <input type="number" id="bcSeriesPad" value="3" min="0" max="12"></label>
              <label>数量 <input type="number" id="bcSeriesCount" value="10" min="0" max="5000"></label>
            </div>
            <button type="button" class="ghost" id="bcSeriesBuild">生成序号</button>
          </div>

          <div class="bc-data-stats" id="bcDataStats"></div>
          <div class="bc-var-hint" id="bcVarHint"></div>

          <div class="bc-divider"></div>
          <div class="bc-props-title">打印校准</div>
          <div class="bc-field-grid">
            <label>X 偏移(mm) <input type="number" id="bcOffX" step="0.1" value="0"></label>
            <label>Y 偏移(mm) <input type="number" id="bcOffY" step="0.1" value="0"></label>
          </div>
          <div class="bc-hint">按实际打印机走纸偏移微调；打印对话框请选择实际标签纸尺寸、缩放 100%、边距无。</div>
        </aside>
          </div><!-- /bc-designer -->
        </div><!-- /bc-body -->

        <footer class="bc-footer">
          <div class="bc-pages">
            <div class="bc-page-thumb active" id="bcPageThumb"><span>条码</span></div>
          </div>
          <div class="bc-zoombar">
            <button type="button" class="ghost" id="bcZoomOut" title="缩小">−</button>
            <span id="bcZoomLabel" class="bc-zoom-val">100%</span>
            <button type="button" class="ghost" id="bcZoomIn" title="放大">＋</button>
            <button type="button" class="ghost" id="bcFit2" title="适应画布">适应</button>
          </div>
        </footer>

        <!-- 设置尺寸弹窗（对齐参考站交互） -->
        <div class="bc-modal" id="bcSizeModal" style="display:none">
          <div class="bc-modal-mask" data-size-close="1"></div>
          <div class="bc-modal-box">
            <div class="bc-modal-head">
              <span>设置尺寸</span>
              <button type="button" class="bc-modal-x" id="bcSizeClose">×</button>
            </div>
            <div class="bc-modal-body">
              <div class="bc-row2">
                <label>宽（mm） <input type="number" id="bcSizeW" min="10" max="300" step="0.1"></label>
                <label>高（mm） <input type="number" id="bcSizeH" min="10" max="300" step="0.1"></label>
              </div>
              <div class="bc-group-title">常用尺寸</div>
              <div class="bc-preset-grid" id="bcSizePresets"></div>
            </div>
            <div class="bc-modal-foot">
              <button type="button" class="ghost" id="bcSizeCancel">取消</button>
              <button type="button" class="bc-green" id="bcSizeOk">确定</button>
            </div>
          </div>
        </div>
      </div>`;
    }

    // ---------- 事件绑定 ----------
    function bindOnce() {
      // 添加元素（工具箱仅保留条形码 / 二维码）
      host.querySelectorAll('[data-add]').forEach((btn) => {
        btn.addEventListener('click', () => addElement(btn.dataset.add));
      });

      // 左侧工具轨：切换「添加 / 纸张 / 我的」面板
      host.querySelectorAll('.bc-rail-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          host.querySelectorAll('.bc-rail-btn').forEach((b) => b.classList.toggle('active', b === btn));
          host.querySelectorAll('.bc-panel').forEach((p) => {
            p.style.display = p.dataset.panel === btn.dataset.panel ? '' : 'none';
          });
        });
      });

      // 纸张
      $('bcPreset').addEventListener('change', (e) => {
        const v = e.target.value;
        if (!v) return;
        const parts = v.split('x');
        $('bcWidth').value = parts[0];
        $('bcHeight').value = parts[1];
        applySize();
      });
      $('bcApplySize').addEventListener('click', applySize);

      // 设置尺寸弹窗
      $('bcOpenSize').addEventListener('click', openSizeModal);
      $('bcOpenSize2').addEventListener('click', openSizeModal);
      $('bcSizeClose').addEventListener('click', closeSizeModal);
      $('bcSizeCancel').addEventListener('click', closeSizeModal);
      host.querySelector('.bc-modal-mask').addEventListener('click', closeSizeModal);
      $('bcSizePresets').addEventListener('click', (e) => {
        const b = e.target.closest('.bc-preset-item');
        if (!b) return;
        $('bcSizeW').value = b.dataset.w;
        $('bcSizeH').value = b.dataset.h;
      });
      $('bcSizeOk').addEventListener('click', () => {
        $('bcWidth').value = $('bcSizeW').value;
        $('bcHeight').value = $('bcSizeH').value;
        closeSizeModal();
        applySize();
      });

      // 背景颜色
      $('bcBgColor').addEventListener('input', (e) => {
        state.label.bg = e.target.value;
        renderSurface();
      });

      // 「我的」元素列表：点选
      $('bcElList').addEventListener('click', (e) => {
        const row = e.target.closest('.bc-el-row');
        if (!row) return;
        state.selectedId = row.dataset.eid;
        renderSurface();
        renderPanel();
      });

      // 底部缩放条
      $('bcZoomIn').addEventListener('click', () => setZoom(state.zoom + 0.1));
      $('bcZoomOut').addEventListener('click', () => setZoom(state.zoom - 0.1));
      $('bcFit2').addEventListener('click', fitToView);

      // 工具栏
      $('bcUndo').addEventListener('click', undo);
      $('bcRedo').addEventListener('click', redo);
      $('bcZoomSelect').addEventListener('change', (e) => setZoom(Number(e.target.value)));
      $('bcGridToggle').addEventListener('change', (e) => { state.grid = e.target.checked; renderSurface(); });
      $('bcDup').addEventListener('click', () => {
        if (!state.selectedId) { toast('请先选择元素'); return; }
        snapshot();
        state.label.elements = M.duplicateElement(state.label.elements, state.selectedId);
        renderAll();
      });
      $('bcLayerUp').addEventListener('click', () => { if (!state.selectedId) return; snapshot(); state.label.elements = M.moveLayer(state.label.elements, state.selectedId, 'up'); renderAll(); });
      $('bcLayerDown').addEventListener('click', () => { if (!state.selectedId) return; snapshot(); state.label.elements = M.moveLayer(state.label.elements, state.selectedId, 'down'); renderAll(); });
      $('bcDelete').addEventListener('click', deleteSelected);
      $('bcFit').addEventListener('click', fitToView);

      // 对齐
      host.querySelectorAll('[data-align]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const el = selected();
          if (!el) { toast('请先选择元素'); return; }
          const pos = M.alignTo(el, state.label, btn.dataset.align);
          patchSelected(pos);
        });
      });

      // 位置尺寸
      const geoIds = ['bcPosX', 'bcPosY', 'bcPosW', 'bcPosH', 'bcRotation'];
      geoIds.forEach((id) => {
        $(id).addEventListener('change', (e) => {
          const el = selected();
          if (!el) return;
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          const patch = {};
          if (id === 'bcPosX') patch.x = v;
          if (id === 'bcPosY') patch.y = v;
          if (id === 'bcPosW') patch.w = Math.max(1, v);
          if (id === 'bcPosH') patch.h = Math.max(1, v);
          if (id === 'bcRotation') patch.rotation = v;
          patchSelected(patch);
        });
      });

      // 元素锁定
      $('bcLocked').addEventListener('change', (e) => patchSelected({ locked: e.target.checked }));

      // 条码 / 二维码属性
      $('bcSymbology').addEventListener('change', (e) => patchSelected({ symbology: e.target.value }));
      $('bcCodeText').addEventListener('input', (e) => patchSelected({ text: e.target.value }, { silent: true }));
      $('bcCodeColor').addEventListener('input', (e) => patchSelected({ color: e.target.value }, { silent: true }));
      $('bcCodeFontSize').addEventListener('change', (e) => patchSelected({ fontSize: Number(e.target.value) || 8 }));
      $('bcIncludeText').addEventListener('change', (e) => patchSelected({ includetext: e.target.checked }));
      $('bcIsVar').addEventListener('change', (e) => { patchSelected({ isVar: e.target.checked }); updateDataStats(); });

      // 数据源
      $('bcTab-text').addEventListener('click', () => switchDataMode('text'));
      $('bcTab-batch').addEventListener('click', () => switchDataMode('batch'));
      $('bcTab-series').addEventListener('click', () => switchDataMode('series'));

      $('bcSingleValue').addEventListener('input', (e) => {
        state.singleValue = e.target.value;
        // 无变量元素时，把文本直接写入选中元素，便于快速改内容
        const vars = state.label.elements.filter((x) => x.isVar).length;
        const el = selected();
        if (!vars && el && (el.type === 'text' || el.type === 'barcode' || el.type === 'qrcode' || el.type === 'pdf417' || el.type === 'datamatrix')) {
          patchSelected({ text: e.target.value }, { silent: true });
        } else {
          renderSurface();
        }
      });
      $('bcBatchInput').addEventListener('input', (e) => {
        state.batchRows = M.parseBatch(e.target.value);
        updateDataStats();
        renderSurface();
      });
      $('bcSeriesBuild').addEventListener('click', () => {
        state.seriesRows = M.buildSeries({
          prefix: $('bcSeriesPrefix').value,
          start: $('bcSeriesStart').value,
          step: $('bcSeriesStep').value,
          pad: $('bcSeriesPad').value,
          count: $('bcSeriesCount').value,
        });
        updateDataStats();
        renderSurface();
        toast(state.seriesRows.length ? '已生成 ' + state.seriesRows.length + ' 条序号' : '数量需大于 0');
      });

      // 模板
      $('bcTplSave').addEventListener('click', saveTemplate);
      $('bcTplLoad').addEventListener('click', loadTemplate);
      $('bcTplDelete').addEventListener('click', deleteTemplate);

      // 打印 / 导出
      $('bcPrintBtn').addEventListener('click', doPrint);
      $('bcPngBtn').addEventListener('click', exportPng);

      // 键盘快捷键
      document.addEventListener('keydown', onKeydown);
    }

    // ---------- 设置尺寸弹窗 ----------
    function renderSizePresets() {
      const box = $('bcSizePresets');
      if (!box) return;
      box.innerHTML = M.LABEL_PRESETS.map((p) =>
        '<button type="button" class="bc-preset-item" data-w="' + p.widthMm + '" data-h="' + p.heightMm + '">' +
        p.widthMm + ' × ' + p.heightMm + ' mm</button>').join('');
    }

    function openSizeModal() {
      $('bcSizeW').value = state.label.widthMm;
      $('bcSizeH').value = state.label.heightMm;
      $('bcSizeModal').style.display = 'flex';
    }
    function closeSizeModal() { $('bcSizeModal').style.display = 'none'; }

    function updateSizeText() {
      const txt = state.label.widthMm + ' × ' + state.label.heightMm + ' mm';
      const a = $('bcSizeText');
      const b = $('bcSizeText2');
      if (a) a.textContent = txt;
      if (b) b.textContent = txt;
      const bg = $('bcBgColor');
      if (bg) bg.value = state.label.bg || '#ffffff';
    }

    function applySize() {
      const w = M.sanitizeSize($('bcWidth').value, state.label.widthMm);
      const h = M.sanitizeSize($('bcHeight').value, state.label.heightMm);
      snapshot();
      state.label.widthMm = w;
      state.label.heightMm = h;
      // 收缩后把越界元素拉回纸内
      state.label.elements.forEach((el) => {
        const c = M.clampElement(el, state.label);
        el.x = c.x; el.y = c.y;
        el.w = Math.min(el.w, w);
        el.h = Math.min(el.h, h);
      });
      $('bcWidth').value = w;
      $('bcHeight').value = h;
      renderAll();
      fitToView();
      toast('纸张已设为 ' + w + ' × ' + h + ' mm');
    }

    function onKeydown(e) {
      // 焦点在输入框内时不劫持按键
      const tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (!host || !host.offsetParent) return;

      const el = selected();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (el) { snapshot(); state.label.elements = M.duplicateElement(state.label.elements, el.id); renderAll(); }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && el) { e.preventDefault(); deleteSelected(); return; }
      if (el && /^Arrow/.test(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 0.1 : 0.5;
        const patch = {};
        if (e.key === 'ArrowLeft') patch.x = M.r2(el.x - step);
        if (e.key === 'ArrowRight') patch.x = M.r2(el.x + step);
        if (e.key === 'ArrowUp') patch.y = M.r2(el.y - step);
        if (e.key === 'ArrowDown') patch.y = M.r2(el.y + step);
        patchSelected(patch);
      }
    }

    return function mount(pageHost) {
      host = pageHost;
      host.innerHTML = pageHtml();

      // 初始纸张
      $('bcWidth').value = state.label.widthMm;
      $('bcHeight').value = state.label.heightMm;
      $('bcPreset').value = state.label.widthMm + 'x' + state.label.heightMm;

      bindOnce();
      bindCanvas();
      renderTemplates();
      renderSizePresets();
      renderAll();
      syncZoomSelect(false);   // 缩放下拉框与当前比例对齐（默认 100%）

      // 等布局稳定后按可视区域自适应缩放（保证整张标签完整落在框内）
      requestAnimationFrame(() => { fitToView(); });
      window.addEventListener('resize', onResize);

      // 标签页从隐藏变为可见、或窗口/分栏尺寸变化时，重新自适应
      if (typeof ResizeObserver !== 'undefined') {
        let lastW = 0;
        let lastH = 0;
        const ro = new ResizeObserver(() => {
          const s = host.querySelector('.bc-canvas-scroll');
          if (!s) return;
          const w = s.clientWidth;
          const h = s.clientHeight;
          if (w === lastW && h === lastH) return;
          lastW = w;
          lastH = h;
          if (state.autoFit) fitToView();
        });
        ro.observe(host.querySelector('.bc-canvas-scroll'));
      }

      // 预加载条码引擎（失败不阻塞页面，打印时再提示）
      ensureBwip().then(() => renderSurface()).catch(() => { /* 静默，打印时会提示 */ });
    };
  }

  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES[PAGE] = createPage();
})();
