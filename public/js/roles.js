// ============================================================
//  角色权限页（RBAC 管理界面）
//  - 左栏：角色列表（名称/描述/用户数/操作）+「+ 新增角色」表单弹窗
//  - 右栏：选中角色后展示权限树（父子联动 + 半选），保存写入 role_menus
//  - 内置角色（is_system）禁删、禁改名、超管禁配权限
//  需「角色权限」菜单授权（后端 menuGate('roles') 双重校验）
// ============================================================
window.ERP_PAGES = window.ERP_PAGES || {};
window.ERP_PAGES.roles = function (host) {
  const $ = (id) => host.querySelector('#' + id);
  host.innerHTML = `
    <div class="roles-layout">
      <div class="roles-left card">
        <div class="toolbar">
          <button id="roleAddBtn" class="primary">+ 新增角色</button>
        </div>
        <table class="grid roles-table">
          <colgroup>
            <col style="width:140px">
            <col style="width:200px">
            <col style="width:70px">
            <col style="width:70px">
            <col style="width:200px">
          </colgroup>
          <thead><tr><th>角色名称</th><th>描述</th><th>用户数</th><th>菜单数</th><th>操作</th></tr></thead>
          <tbody id="roleBody"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
      <div class="roles-right card">
        <div class="ptree-head">
          <span id="permRoleName" class="ptree-role">权限配置（左侧选择角色）</span>
          <span class="ptree-actions">
            <button id="permAllBtn">全选</button>
            <button id="permClearBtn">清空</button>
            <button id="permSaveBtn" class="primary">保存权限</button>
          </span>
        </div>
        <div id="permTip" class="ptree-tip">勾选主菜单将自动全选其子菜单；仅勾部分子菜单时主菜单呈半选状态。</div>
        <div id="permTree" class="ptree-panel">请先在左侧选择一个角色</div>
        <div id="permErr" class="err"></div>
      </div>
    </div>`;

  let tree = null;
  let currentRole = null;

  // 统一数组兜底：data 是数组直接用；是对象则尝试从指定字段取数组；其余一律 []
  function normalizeArray(data, pick) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const picked = pick(data);
      if (Array.isArray(picked)) return picked;
    }
    return [];
  }

  $('roleAddBtn').onclick = () => openRoleModal(null);
  $('permAllBtn').onclick = () => tree && tree.checkAll();
  $('permClearBtn').onclick = () => tree && tree.clearAll();
  $('permSaveBtn').onclick = savePerms;
  load();

  // ---------- 角色列表 ----------
  // 任何失败都必须解除「加载中…」状态并展示具体错误，严禁静默卡死
  async function load() {
    const body = $('roleBody');
    try {
      const r = await API.get('/roles');
      // 数据兜底：返回 null/undefined/非数组时一律降级为空数组，杜绝 .length/.map 崩溃
      const rowsRaw = Array.isArray(r && r.data) ? r.data : [];
      // ★ 前端过滤：只展示超级管理员（角色管理暂时只暴露超级管理员一个入口）
      const rows = rowsRaw.filter((x) =>
        (x.role_code === 'super_admin') || (x.role_name && x.role_name.includes('超级管理员'))
      );
      console.log('[roles] 角色列表加载成功，共', rowsRaw.length, '个角色，过滤后展示', rows.length, '个:', r);
      body.innerHTML = rows.length
        ? rows.map(rowHtml).join('')
        : '<tr><td colspan="5" class="empty">暂无角色</td></tr>';
      rows.forEach((row) => {
        const b = $('perm_' + row.role_id);
        const e = $('redit_' + row.role_id);
        const d = $('rdel_' + row.role_id);
        if (b) b.onclick = () => selectRole(row);
        if (e) e.onclick = () => openRoleModal(row);
        if (d) d.onclick = () => delRole(row);
      });
    } catch (e) {
      console.error('[roles] 角色列表加载失败:', e);
      body.innerHTML =
        '<tr><td colspan="5" class="empty">加载失败：' + escapeHtml(e.message || '未知错误') +
        '　<a href="javascript:void(0)" id="roleRetry" style="color:#4f7cff">点击重试</a></td></tr>';
      const retry = $('roleRetry');
      if (retry) {
        retry.onclick = () => {
          body.innerHTML = '<tr><td colspan="5" class="empty">加载中…</td></tr>';
          load();
        };
      }
    }
  }

  function rowHtml(r) {
    const isSuper = r.role_code === 'super_admin';
    const readonlyTag = r.is_readonly ? '<span class="badge off">只读</span>' : '';
    const scopeTag = r.data_scope === 'self' ? '<span class="badge">仅本人数据</span>' : '';
    return `<tr class="${currentRole && currentRole.role_id === r.role_id ? 'active-row' : ''}">
      <td class="role-name">${escapeHtml(r.role_name)} ${readonlyTag}${scopeTag}</td>
      <td class="role-desc">${escapeHtml(r.description || '')}</td>
      <td class="num">${r.user_count}</td>
      <td class="num">${isSuper ? '全部' : r.menu_count}</td>
      <td class="ops">
        <div style="display:flex;flex-direction:row;gap:8px;justify-content:center;align-items:center;white-space:nowrap;flex-wrap:nowrap;">
          <button id="perm_${r.role_id}">分配权限</button>
          <button id="redit_${r.role_id}">编辑</button>
          ${r.is_system ? '' : `<button id="rdel_${r.role_id}" class="danger">删除</button>`}
        </div>
      </td>
    </tr>`;
  }

  // ---------- 选中角色 → 加载权限树 ----------
  async function selectRole(role) {
    currentRole = role;
    $('permRoleName').textContent = '权限配置：' + role.role_name;
    $('permErr').textContent = '权限数据加载中…';
    try {
      const [tr, granted] = await Promise.all([
        API.get('/menus/tree'),
        API.get('/roles/' + role.role_id + '/menus'),
      ]);
      console.log('[roles] 权限树返回:', tr, '已授权菜单:', granted);
      // 数据兜底（核心）：赋值给树组件前做类型校验，null/undefined/对象一律强制为 []
      // 兼容两种后端结构：{ data: [...] } 直接数组，或 { data: { menuList: [...] } }
      const menuList = normalizeArray(tr && tr.data, (d) => d.menuList || d.menus || d.tree);
      const grantedList = normalizeArray(granted && granted.data, (d) => d.menuIds || d.ids || d.list);
      if (!menuList.length) {
        // 菜单树为空：明确提示，不再让树组件去遍历非法数据
        tree = null;
        $('permTree').innerHTML = '<div class="empty">未获取到菜单树数据</div>';
        $('permErr').textContent = '权限数据加载失败：菜单树为空或格式异常（详见控制台 F12）';
        console.error('[roles] 菜单树为空或格式异常:', tr);
        return;
      }
      tree = ERP.createPermissionTree($('permTree'), menuList);
      tree.hydrate(grantedList);
      $('permErr').textContent = '';
      load(); // 刷新选中态
    } catch (e) {
      console.error('[roles] 权限配置加载失败:', e);
      tree = null;
      // 展示后端真实错误（含 HTTP 状态码），而非只显示前端 JS 报错
      const status = e.status ? 'HTTP ' + e.status + ' ' : '';
      $('permErr').textContent = '权限数据加载失败：' + status + (e.message || '未知错误') + '（请重试或检查登录状态）';
    }
  }

  async function savePerms() {
    if (!tree || !currentRole) { $('permErr').textContent = '请先在左侧选择一个角色'; return; }
    const menuIds = tree.collect();
    try {
      const r = await API.put('/roles/' + currentRole.role_id + '/menus', { menuIds });
      $('permErr').textContent = '';
      ERP.toast('权限已保存（已授权 ' + r.granted + ' 项菜单）');
      load();
    } catch (e) {
      console.error('[roles] 保存权限失败:', e);
      const status = e.status ? 'HTTP ' + e.status + ' ' : '';
      $('permErr').textContent = '保存失败：' + status + (e.message || '未知错误');
    }
  }

  // ---------- 新增 / 编辑角色弹窗 ----------
  function openRoleModal(role) {
    const isEdit = !!role;
    const isSystem = isEdit && role.is_system;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-head"><span>${isEdit ? '编辑角色' : '新增角色'}</span><button class="close" type="button">×</button></div>
        <div class="modal-body">
          <label>角色名称${isSystem ? '' : '*'}<input id="r_name" value="${isEdit ? escapeHtml(role.role_name) : ''}" ${isSystem ? 'disabled' : ''} placeholder="如：仓库主管"></label>
          <label>角色描述<textarea id="r_desc" rows="2" placeholder="角色职责说明">${isEdit ? escapeHtml(role.description || '') : ''}</textarea></label>
          ${!isEdit ? `
          <label>数据范围
            <select id="r_scope"><option value="all">全部数据</option><option value="self">仅本人数据（行级隔离）</option></select>
          </label>
          <label class="chk"><input type="checkbox" id="r_ro"> 只读角色（仅可查看，禁止写操作）</label>` : ''}
          <div id="r_err" class="err"></div>
        </div>
        <div class="modal-foot">
          <button id="r_save" class="primary" type="button">保存</button>
          <button class="close" type="button">取消</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
    modal.querySelector('#r_save').onclick = async () => {
      const errEl = modal.querySelector('#r_err');
      try {
        if (isEdit) {
          await API.put('/roles/' + role.role_id, {
            role_name: modal.querySelector('#r_name').value.trim(),
            description: modal.querySelector('#r_desc').value.trim(),
          });
        } else {
          await API.post('/roles', {
            role_name: modal.querySelector('#r_name').value.trim(),
            description: modal.querySelector('#r_desc').value.trim(),
            data_scope: modal.querySelector('#r_scope').value,
            is_readonly: modal.querySelector('#r_ro').checked ? 1 : 0,
          });
        }
        modal.remove();
        load();
      } catch (e) {
        // 展示后端具体错误（如「角色名称已存在」「服务器内部错误：…」），并留痕控制台便于排查
        console.error('[roles] 保存角色失败:', e);
        errEl.textContent = e.message || '保存失败，请查看控制台（F12）获取详情';
      }
    };
  }

  async function delRole(role) {
    if (!confirm('确定删除角色「' + role.role_name + '」？')) return;
    try {
      await API.req('DELETE', '/roles/' + role.role_id);
      if (currentRole && currentRole.role_id === role.role_id) {
        currentRole = null;
        tree = null;
        $('permRoleName').textContent = '权限配置（左侧选择角色）';
        $('permTree').innerHTML = '请先在左侧选择一个角色';
      }
      load();
    } catch (e) { alert(e.message); }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
};
