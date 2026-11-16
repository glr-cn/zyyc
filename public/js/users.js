// 用户管理页（阶段 5，仅管理员）：列表 / 新增 / 重置密码 / 删除
window.ERP_PAGES = window.ERP_PAGES || {};
window.ERP_PAGES.users = function (host) {
  const c = host;
  const $ = (id) => c.querySelector("#" + id);
  c.innerHTML = `
    <div class="toolbar">
      <button id="addBtn" class="primary">+ 新增用户</button>
    </div>
    <table class="grid">
      <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody id="userBody"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody>
    </table>`;

  $('addBtn').onclick = openModal;
  load();

  async function load() {
    const r = await API.get('/users');
    const body = $('userBody');
    const rows = r.data || [];
    body.innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : '<tr><td colspan="5" class="empty">暂无用户</td></tr>';
    rows.forEach((u) => {
      const rb = $('reset_' + u.user_id);
      const db = $('del_' + u.user_id);
      if (rb) rb.onclick = () => resetPwd(u.user_id);
      if (db) db.onclick = () => del(u.user_id);
    });
  }

  function rowHtml(u) {
    const isSelf = window.ERP_USER && u.user_id === window.ERP_USER.user_id;
    return `<tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.display_name)}</td>
      <td>${escapeHtml(u.role_name)}</td>
      <td>${escapeHtml(u.created_at)}</td>
      <td class="ops">
        <button id="reset_${u.user_id}">重置密码</button>
        <button id="del_${u.user_id}" ${isSelf ? 'disabled' : ''}>删除</button>
      </td>
    </tr>`;
  }

  async function resetPwd(id) {
    const pwd = prompt('请输入新密码（至少 6 位）：');
    if (!pwd) return;
    try {
      await API.put('/users/' + id + '/password', { password: pwd });
      alert('密码已重置');
    } catch (e) { alert(e.message); }
  }

  async function del(id) {
    if (!confirm('确认删除该用户？')) return;
    try {
      await API.req('DELETE', '/users/' + id);
      load();
    } catch (e) { alert(e.message); }
  }

  function openModal() {
    // 角色下拉走 RBAC：从 roles 表读取可分配角色（超管角色仅超管可见，后端过滤）
    API.get('/roles/options').then((r) => {
      const roles = r.data || [];
      const opts = roles
        .map((x) => '<option value="' + escapeHtml(x.role_name) + '">' + escapeHtml(x.role_name) + '</option>')
        .join('');
      openModalWith(opts);
    }).catch(() => openModalWith('<option value="业务员">业务员</option><option value="查看者">查看者</option>'));
  }

  function openModalWith(roleOptions) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-head"><span>新增用户</span><button class="close" type="button">×</button></div>
        <div class="modal-body">
          <label>用户名*<input id="f_user" placeholder="登录账号"></label>
          <label>显示名<input id="f_disp"></label>
          <label>角色*
            <select id="f_role">${roleOptions}</select>
          </label>
          <label>初始密码*<input id="f_pwd" type="text" placeholder="至少 6 位"></label>
          <div id="f_err" class="err"></div>
        </div>
        <div class="modal-foot">
          <button id="saveBtn" class="primary" type="button">创建</button>
          <button class="close" type="button">取消</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
    modal.querySelector('#saveBtn').onclick = async () => {
      const errEl = modal.querySelector('#f_err');
      const payload = {
        username: modal.querySelector('#f_user').value.trim(),
        display_name: modal.querySelector('#f_disp').value.trim(),
        role_name: modal.querySelector('#f_role').value,
        password: modal.querySelector('#f_pwd').value,
      };
      if (!payload.username || !payload.password) { errEl.textContent = '用户名和密码必填'; return; }
      try {
        await API.post('/users', payload);
        modal.remove();
        load();
      } catch (e) { errEl.textContent = e.message; }
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
};
