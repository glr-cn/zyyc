// 历史测算（单据 → 历史测算）：查看每次 Excel 上传的测算批次及明细
(function () {
  const PAGE = 'smart_quote_history';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const num = (x, d = 3) => {
    const n = Number(x);
    if (isNaN(n)) return '—';
    return d === 0 ? n.toFixed(0) : n.toFixed(d);
  };

  function createPage() {
    const state = { view: 'list', batches: [], batchId: null, batchName: '', records: [], page: 1, pages: 1, q: '' };
    let host = null;
    const $ = (id) => host && host.querySelector('#' + id);

    // ---------- 批次列表 ----------
    function listHtml() {
      const rows = state.batches.length
        ? state.batches.map((b) => `<tr>
            <td>${b.id}</td>
            <td>${esc(b.batch_name)}</td>
            <td>${esc(b.source_type)}</td>
            <td>${esc(b.file_name || '—')}</td>
            <td class="num">${b.total_count}</td>
            <td>${esc(b.operator)}</td>
            <td>${esc(b.created_at)}</td>
            <td><button class="ghost viewBtn" data-id="${b.id}" data-name="${esc(b.batch_name)}">查看明细</button></td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">暂无历史测算记录，去「智能测单」上传 Excel 即会自动生成批次</td></tr>`;
      return `
        <h3>历史测算批次</h3>
        <table class="grid">
          <thead><tr>
            <th>ID</th><th>批次名称</th><th>来源</th><th>文件名</th><th>行数</th><th>上传人</th><th>上传时间</th><th>操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    // ---------- 批次明细 ----------
    function detailHtml() {
      const rows = state.records.length
        ? state.records.map((r) => `<tr>
            <td>${esc(r.so_no || '')}</td>
            <td>${esc(r.owner_name || '')}</td>
            <td>${esc(r.waybill_type || '')}</td>
            <td>${esc(r.province || '')}</td>
            <td>${esc(r.city || '')}</td>
            <td>${esc(r.district || '')}</td>
            <td class="num">${num(r.estimated_weight, 3)}</td>
            <td class="num">${num(r.total_volume, 4)}</td>
            <td class="num">${num(r.volumetric_weight, 3)}</td>
            <td class="num">${num(r.billing_weight, 0)}</td>
            <td><b>${esc(r.recommended_code || '—')}</b></td>
            <td class="num price">${r.recommended_price == null ? '—' : '¥' + num(r.recommended_price, 3)}</td>
          </tr>`).join('')
        : `<tr><td colspan="12" class="empty">该批次没有匹配的记录</td></tr>`;
      return `
        <div class="toolbar">
          <button id="backBtn" class="ghost">← 返回批次列表</button>
          <span class="muted">批次：${esc(state.batchName)}</span>
          <input id="recQ" placeholder="按 SO 单号搜索" value="${esc(state.q)}" style="margin-left:12px">
          <button id="recSearch" class="ghost">搜索</button>
        </div>
        <table class="grid">
          <thead><tr>
            <th>SO单号</th><th>货主</th><th>面单类型</th><th>省份</th><th>城市</th><th>县区</th>
            <th>预估重量</th><th>总体积</th><th>抛比重量</th><th>计费重量</th><th>推荐编码</th><th>推荐总价</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="pager">
          <button id="prevBtn" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${state.page} / ${state.pages} 页（共 ${state.records.length ? '' : ''}）</span>
          <button id="nextBtn" ${state.page >= state.pages ? 'disabled' : ''}>下一页</button>
        </div>`;
    }

    function render() {
      host.innerHTML = state.view === 'detail' ? detailHtml() : listHtml();
      bind();
    }

    function bind() {
      if (state.view === 'list') {
        host.querySelectorAll('.viewBtn').forEach((b) => {
          b.onclick = () => openDetail(Number(b.dataset.id), b.dataset.name);
        });
      } else {
        $('backBtn').onclick = () => { state.view = 'list'; state.batchId = null; state.batchName = ''; loadList(); };
        $('recSearch').onclick = () => { state.q = $('recQ').value.trim(); state.page = 1; loadRecords(); };
        $('recQ').onkeydown = (e) => { if (e.key === 'Enter') { state.q = $('recQ').value.trim(); state.page = 1; loadRecords(); } };
        $('prevBtn').onclick = () => { if (state.page > 1) { state.page--; loadRecords(); } };
        $('nextBtn').onclick = () => { if (state.page < state.pages) { state.page++; loadRecords(); } };
      }
    }

    function loadList() {
      API.get('/smart-quote/history')
        .then((r) => { state.batches = (r && r.data) || []; state.view = 'list'; render(); })
        .catch((e) => alert('加载历史失败：' + e.message));
    }
    function openDetail(id, name) {
      state.batchId = id; state.batchName = name; state.view = 'detail'; state.page = 1; state.q = '';
      loadRecords();
    }
    function loadRecords() {
      API.get('/smart-quote/history/' + state.batchId + '/records?page=' + state.page + (state.q ? '&q=' + encodeURIComponent(state.q) : ''))
        .then((r) => {
          state.records = (r && r.data) || [];
          state.pages = (r && r.pages) || 1;
          state.page = (r && r.page) || 1;
          render();
        })
        .catch((e) => alert('加载明细失败：' + e.message));
    }

    return function mount(pageHost) {
      host = pageHost;
      loadList();
    };
  }

  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES[PAGE] = createPage();
})();
