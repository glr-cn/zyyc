// 轻量 SVG 图表（无外部依赖，保证离线渲染）：折线图 + 堆叠柱状图
const Charts = (function () {
  const COLORS = { main: '#2f6fed', other: '#f0a020', shared: '#16a34a', line: '#2f6fed', grid: '#e3e8ef', text: '#6b7785' };

  function esc(s) { return String(s == null ? '' : s); }

  // 折线图：labels[], values[]（数值）；host 为当前页签容器（keep-alive 作用域）
  function line(elId, labels, values, host) {
    const el = (host || document).querySelector('#' + elId);
    if (!el) return;
    if (!labels.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    const W = 660, H = 240, pad = 42;
    const maxV = Math.max(0.0001, ...values);
    const minV = 0;
    const innerW = W - pad * 2, innerH = H - pad * 2;
    const x = (i) => pad + (labels.length === 1 ? innerW / 2 : (innerW * i) / (labels.length - 1));
    const y = (v) => pad + innerH - ((v - minV) / (maxV - minV || 1)) * innerH;
    let g = '';
    // 网格 + y 轴刻度（4 段）
    for (let k = 0; k <= 4; k++) {
      const gy = pad + (innerH * k) / 4;
      const val = (maxV * (4 - k)) / 4;
      g += `<line x1="${pad}" y1="${gy}" x2="${W - pad}" y2="${gy}" stroke="${COLORS.grid}" stroke-width="1"/>`;
      g += `<text x="${pad - 6}" y="${gy + 4}" text-anchor="end" font-size="10" fill="${COLORS.text}">${val.toFixed(3)}</text>`;
    }
    // 折线 + 点
    const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    g += `<polyline points="${pts}" fill="none" stroke="${COLORS.line}" stroke-width="2"/>`;
    values.forEach((v, i) => {
      g += `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${COLORS.line}"/>`;
      g += `<text x="${x(i)}" y="${y(v) - 8}" text-anchor="middle" font-size="10" fill="${COLORS.text}">${v.toFixed(3)}</text>`;
    });
    // x 标签（过多时隔点显示）
    labels.forEach((lb, i) => {
      if (labels.length <= 12 || i % Math.ceil(labels.length / 12) === 0) {
        g += `<text x="${x(i)}" y="${H - pad + 16}" text-anchor="middle" font-size="10" fill="${COLORS.text}">${esc(lb)}</text>`;
      }
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
  }

  // 堆叠柱状图：labels[], series={main:[],other:[],shared:[]}
  function stackedBar(elId, labels, series, host) {
    const el = (host || document).querySelector('#' + elId);
    if (!el) return;
    if (!labels.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    const W = 660, H = 240, pad = 42, legendH = 22;
    const totals = labels.map((_, i) => (series.main[i] || 0) + (series.other[i] || 0) + (series.shared[i] || 0));
    const maxV = Math.max(0.0001, ...totals);
    const innerW = W - pad * 2, innerH = H - pad * 2 - legendH;
    const bw = (innerW / labels.length) * 0.6;
    const gap = (innerW / labels.length);
    const y = (v) => pad + innerH - (v / maxV) * innerH;
    let g = '';
    for (let k = 0; k <= 4; k++) {
      const gy = pad + (innerH * k) / 4;
      const val = (maxV * (4 - k)) / 4;
      g += `<line x1="${pad}" y1="${gy}" x2="${W - pad}" y2="${gy}" stroke="${COLORS.grid}" stroke-width="1"/>`;
      g += `<text x="${pad - 6}" y="${gy + 4}" text-anchor="end" font-size="10" fill="${COLORS.text}">${val.toFixed(3)}</text>`;
    }
    labels.forEach((lb, i) => {
      const cx = pad + gap * i + gap / 2;
      const x0 = cx - bw / 2;
      let acc = 0;
      const layers = [
        { v: series.main[i] || 0, c: COLORS.main },
        { v: series.other[i] || 0, c: COLORS.other },
        { v: series.shared[i] || 0, c: COLORS.shared },
      ];
      layers.forEach((L) => {
        if (L.v > 0) {
          const yTop = y(acc + L.v);
          const h = y(acc) - yTop;
          g += `<rect x="${x0}" y="${yTop}" width="${bw}" height="${h}" fill="${L.c}"/>`;
          acc += L.v;
        }
      });
      if (labels.length <= 12 || i % Math.ceil(labels.length / 12) === 0) {
        g += `<text x="${cx}" y="${H - pad - legendH + 16}" text-anchor="middle" font-size="10" fill="${COLORS.text}">${esc(lb)}</text>`;
      }
    });
    // 图例
    const legend = [
      { c: COLORS.main, t: '主工时' },
      { c: COLORS.other, t: '其他工时' },
      { c: COLORS.shared, t: '公摊工时(分摊后)' },
    ];
    let lx = pad;
    legend.forEach((l) => {
      g += `<rect x="${lx}" y="${H - 14}" width="10" height="10" fill="${l.c}"/>`;
      g += `<text x="${lx + 14}" y="${H - 4}" font-size="10" fill="${COLORS.text}">${l.t}</text>`;
      lx += 110;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
  }

  return { line, stackedBar, COLORS };
})();
