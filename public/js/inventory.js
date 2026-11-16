// 库存台账页（阶段 2）：按货主实时聚合 + 安全库存预警 + 负库存标红
window.ERP_PAGES = window.ERP_PAGES || {};
window.ERP_PAGES.inventory = function (host) {
  const c = host;
  const $ = (id) => c.querySelector("#" + id);
  c.innerHTML = `
    <div class="toolbar">
      <input id="ownerFilter" placeholder="按货主名称筛选">
      <button id="qryBtn" class="primary">查询</button>
      <button id="refreshBtn">刷新</button>
    </div>
    <div id="warnBox"></div>
    <h3>库存台账（实时聚合：期初 + 入库 − 出库）</h3>
    <table class="grid">
      <thead><tr>
        <th>货主名称</th><th>期初</th><th>入库合计</th><th>出库合计</th>
        <th>当前库存</th><th>安全库存</th><th>状态</th>
      </tr></thead>
      <tbody id="ledgerBody"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
    </table>`;

  function load() {
    const owner = $('ownerFilter').value.trim();

    API.get('/inventory/warnings')
      .then((w) => {
        const wb = $('warnBox');
        if (w.data && w.data.length) {
          let h = `<div class="warn-box"><strong>⚠ 安全库存预警（${w.count} 项）：</strong><ul>`;
          w.data.forEach((x) => {
            h += `<li>${escapeHtml(x.owner_name)}：当前库存 <b>${x.balance}</b>，安全库存 ${x.safety_stock}${
              x.is_negative ? '（<span class="badge off">负库存</span>）' : ''
            }，缺口 ${x.deficit}</li>`;
          });
          h += '</ul></div>';
          wb.innerHTML = h;
        } else {
          wb.innerHTML = '<div class="ok">暂无安全库存预警。</div>';
        }
      })
      .catch(() => {});

    API.get('/inventory/ledger?owner=' + encodeURIComponent(owner)).then((r) => {
      const body = $('ledgerBody');
      const rows = r.data || [];
      body.innerHTML = rows.length
        ? rows.map(rowHtml).join('')
        : '<tr><td colspan="7" class="empty">暂无库存流水</td></tr>';
    });
  }

  $('qryBtn').onclick = load;
  $('refreshBtn').onclick = load;
  $('ownerFilter').onkeydown = (e) => {
    if (e.key === 'Enter') load();
  };
  load();

  function rowHtml(r) {
    const status = r.is_negative
      ? '<span class="badge off">负库存</span>'
      : r.below_safety
      ? '<span class="badge warn">低于安全库存</span>'
      : '<span class="badge ok">正常</span>';
    const balCls = r.is_negative ? 'num neg' : 'num';
    return `<tr>
      <td>${escapeHtml(r.owner_name)}</td>
      <td class="num">${r.opening}</td>
      <td class="num">${r.total_in}</td>
      <td class="num">${r.total_out}</td>
      <td class="${balCls}">${r.balance}</td>
      <td class="num">${r.safety_stock}</td>
      <td>${status}</td>
    </tr>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }
};
