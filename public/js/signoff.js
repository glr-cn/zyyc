// ============================================================
//  图片签收单（云服务功能）：收货签收单拍照存证
//  - 图片 → 云存储 shared 共享区；元数据 → 云数据库 signoffs 表
//  - 需先完成「WorkBuddy 账号登录」（云空间未连接时引导登录）
//  入口：ERP.openSignoffModal(warehouse)（工时页工具栏调用）
// ============================================================
window.ERP = window.ERP || {};
ERP.openSignoffModal = function (warehouse) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-width:680px">
      <div class="modal-head"><span>图片签收单${warehouse ? '（' + esc(warehouse) + '）' : ''}</span><button class="close" type="button">×</button></div>
      <div class="modal-body">
        <div id="sfCloudTip" class="err" style="margin-bottom:8px"></div>
        <div id="sfForm">
          <label>客户名称*<input id="sf_cust" placeholder="货主公司全称或简称"></label>
          <div style="display:flex;gap:10px">
            <label style="flex:1">签收日期*<input id="sf_date" type="date"></label>
            <label style="flex:1">关联单号<input id="sf_order" placeholder="选填"></label>
          </div>
          <label>签收图片*<input id="sf_file" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label>
          <label>备注<textarea id="sf_note" rows="2" placeholder="签收情况说明（选填）"></textarea></label>
          <div id="sf_err" class="err"></div>
          <button id="sf_save" class="primary" type="button">上传签收单</button>
        </div>
        <div id="sfListWrap" style="margin-top:14px">
          <div style="color:var(--muted);font-size:12px;margin-bottom:6px">最近签收记录（最多 30 条，图片链接 10 分钟内有效，过期刷新列表即可）</div>
          <div id="sf_list" class="sf-grid"><div class="empty" style="grid-column:1/-1">加载中…</div></div>
        </div>
      </div>
      <div class="modal-foot"><button class="close" type="button">关闭</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
  const $ = (id) => modal.querySelector('#' + id);
  $('sf_date').value = new Date().toISOString().slice(0, 10);

  // 云会话守卫：未登录则隐藏表单并引导登录
  const sess = ERP_CLOUD.getSession();
  if (!sess) {
    $('sfCloudTip').textContent = '云空间未连接：请先在右上角完成「WorkBuddy 账号登录」后再上传签收单。';
    $('sfForm').style.display = 'none';
    $('sfListWrap').style.display = 'none';
    return;
  }

  async function loadList() {
    const box = $('sf_list');
    try {
      const rows = await ERP_CLOUD.listSignoffs(warehouse || null);
      const uid = (ERP_CLOUD.getSession() || {}).user && ERP_CLOUD.getSession().user.id;
      if (!rows.length) {
        box.innerHTML = '<div class="empty" style="grid-column:1/-1">暂无签收记录</div>';
        return;
      }
      box.innerHTML = rows.map((r) => `
        <div class="sf-card">
          ${r._url ? `<img src="${esc(r._url)}" alt="签收单图片" loading="lazy">` : '<div class="sf-noimg">图片链接已过期</div>'}
          <div class="sf-meta">
            <div class="sf-title">${esc(r.customer_name)} <span class="badge">${esc(r.warehouse || '通用')}</span></div>
            <div class="sf-sub">${esc(r.work_date)}${r.order_no ? ' · 单号 ' + esc(r.order_no) : ''}</div>
            <div class="sf-sub">${esc(r.owner_name || '')} · ${esc((r.created_at || '').replace('T', ' ').slice(0, 16))}</div>
            <div class="sf-ops">
              ${r._url ? '<a href="' + esc(r._url) + '" target="_blank" rel="noopener">查看原图</a>' : ''}
              ${r.owner_id === uid ? '<a href="javascript:void(0)" data-del="' + r.id + '" class="sf-del">删除</a>' : ''}
            </div>
          </div>
        </div>`).join('');
      box.querySelectorAll('[data-del]').forEach((a) => (a.onclick = async () => {
        const id = Number(a.dataset.del);
        const row = rows.find((x) => x.id === id);
        if (!row || !confirm('确定删除该签收单（含图片文件）？删除后不可恢复。')) return;
        try {
          await ERP_CLOUD.deleteSignoff(row);
          ERP.toast('签收单已删除');
          loadList();
        } catch (e) { alert(e.message); }
      }));
    } catch (e) {
      console.error('[signoff] 列表加载失败:', e);
      box.innerHTML = '<div class="empty" style="grid-column:1/-1">加载失败：' + esc(e.message) + '</div>';
    }
  }

  $('sf_save').onclick = async () => {
    const err = $('sf_err');
    err.textContent = '';
    const file = $('sf_file').files[0];
    const meta = {
      customer_name: $('sf_cust').value.trim(),
      warehouse: warehouse || '',
      work_date: $('sf_date').value,
      order_no: $('sf_order').value.trim(),
      note: $('sf_note').value.trim(),
    };
    if (!meta.customer_name) { err.textContent = '请填写客户名称'; return; }
    if (!meta.work_date) { err.textContent = '请选择签收日期'; return; }
    if (!file) { err.textContent = '请选择签收图片'; return; }
    const btn = $('sf_save');
    btn.disabled = true;
    btn.textContent = '上传中…';
    try {
      await ERP_CLOUD.uploadSignoff(file, meta);
      ERP.toast('签收单上传成功');
      $('sf_file').value = '';
      $('sf_note').value = '';
      loadList();
    } catch (e) {
      console.error('[signoff] 上传失败:', e);
      err.textContent = e.message || '上传失败，请重试';
    } finally {
      btn.disabled = false;
      btn.textContent = '上传签收单';
    }
  };

  loadList();
};
