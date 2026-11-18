// ============================================================================
//  菜单排序管理页面（仅超级管理员可见）
//  ----------------------------------------------------------------------------
//  功能：父级菜单拖拽排序 + 子菜单序号调整 + 实时预览 + 一键保存
//  路由：#/menu_sort → ERP_PAGES.menu_sort(host)
//  后端：/api/admin/menus/tree + /api/admin/menus/reorder（roleGate 超管拦截）
// ============================================================================
window.ERP_PAGES = window.ERP_PAGES || {};

// ---------- 小工具 ----------
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function escape(s) { if (s == null) return ''; return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function confirmDialog({ title, message, warn, okText = '确认', cancelText = '取消', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    overlay.innerHTML = `
      <div class="modal" style="min-width:440px">
        <div class="modal-head"><span>${escape(title)}</span><button class="close" type="button">×</button></div>
        <div class="modal-body">
          <p style="color:#606266;font-size:14px;margin:0;line-height:1.6">${message || ''}</p>
          ${warn ? `<p style="color:#c23a1b;font-size:13px;margin:10px 0 0;line-height:1.5">⚠️ ${escape(warn)}</p>` : ''}
        </div>
        <div class="modal-foot">
          <button type="button" class="ms-cancel">${escape(cancelText)}</button>
          <button type="button" class="primary ms-ok" style="${danger ? 'background:#e74c3c;border-color:#e74c3c' : ''}">${escape(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(!!val); };
    overlay.querySelector('.close').onclick = () => done(false);
    overlay.querySelector('.ms-cancel').onclick = () => done(false);
    overlay.querySelector('.ms-ok').onclick = () => done(true);
    overlay.onclick = (ev) => { if (ev.target === overlay) done(false); };
  });
}

// ---------- 主页面 ----------
function createPage(host) {
  host.innerHTML = '';
  host.style.padding = '20px';
  host.style.background = '#fff';

  const container = el('div', 'ms-container');

  container.appendChild(el('h2', '', '🎯 菜单排序管理'));
  const sub = el('div', '', '调整后全站菜单顺序实时生效 · 仅超级管理员可操作');
  sub.style.cssText = 'color:#909399;font-size:13px;margin-bottom:16px';
  container.appendChild(sub);

  // 工具栏
  const toolbar = el('div', 'ms-toolbar');
  toolbar.style.cssText = 'display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap';
  const btnSave = el('button', 'primary', '💾 保存排序变更');
  const btnReset = el('button', '', '↩️ 重置为已保存顺序');
  btnReset.style.cssText = 'background:#fff;border:1px solid #dcdfe6;color:#606266';
  const btnRefresh = el('button', '', '🔄 刷新');
  btnRefresh.style.cssText = 'background:#fff;border:1px solid #dcdfe6;color:#606266';
  const dirtyFlag = el('span', '', '');
  dirtyFlag.style.cssText = 'color:#e74c3c;font-size:13px;margin-left:auto;display:none';
  btnSave.onclick = saveAll;
  btnReset.onclick = reload;
  btnRefresh.onclick = reload;
  toolbar.appendChild(btnSave);
  toolbar.appendChild(btnReset);
  toolbar.appendChild(btnRefresh);
  toolbar.appendChild(dirtyFlag);
  container.appendChild(toolbar);

  // 父级列表容器（可拖拽）
  const parentList = el('div', 'ms-parent-list');
  parentList.style.cssText = 'border:1px solid #dcdfe6;border-radius:6px;min-height:100px;background:#fafbfc';
  container.appendChild(parentList);

  // 提示说明
  const hint = el('div', '', '📌 拖拽父级菜单卡片调整顺序；点击 ➕ 展开子菜单，用右侧输入框调整子菜单序号。父级移动不影响子菜单关联关系。');
  hint.style.cssText = 'color:#909399;font-size:12px;margin-top:10px;line-height:1.6';
  container.appendChild(hint);

  // 状态输出区
  const logArea = el('div', 'ms-log');
  logArea.style.cssText = 'margin-top:14px;border:1px solid #dcdfe6;border-radius:6px;background:#1e1e1e;color:#d4d4d4;padding:10px;font-family:Consolas,"Courier New",monospace;font-size:12px;min-height:80px;max-height:160px;overflow:auto';
  container.appendChild(logArea);

  host.appendChild(container);

  // ---------- 状态 ----------
  let tree = [];            // 原始树（保存后更新）
  let workingTree = [];     // 编辑中的树（未保存）
  let expandedParents = new Set();
  let dragId = null;
  let isDirty = false;

  function setDirty(dirty) {
    isDirty = dirty;
    dirtyFlag.style.display = dirty ? '' : 'none';
    dirtyFlag.textContent = dirty ? '⚠️ 有未保存的变更' : '';
    btnSave.disabled = !dirty;
    btnSave.style.opacity = dirty ? '1' : '0.5';
  }

  function log(msg, type) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const color = type === 'ok' ? '#6a9955' : type === 'warn' ? '#dcdcaa' : type === 'err' ? '#f48771' : '#d4d4d4';
    const line = el('div', '');
    line.style.cssText = `color:${color};line-height:1.7`;
    line.textContent = `[${ts}] ${msg}`;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
  }

  // ---------- 渲染 ----------
  function render() {
    parentList.innerHTML = '';
    const parents = workingTree;
    if (parents.length === 0) {
      parentList.appendChild(Object.assign(el('div', '', '加载中…'), {
        style: 'padding:20px;color:#909399;text-align:center'
      }));
      return;
    }
    parents.forEach((p, idx) => {
      const card = renderParentCard(p, idx);
      parentList.appendChild(card);
    });
  }

  function renderParentCard(p, idx) {
    const card = el('div', 'ms-parent-card');
    card.dataset.pid = p.menu_id;
    card.style.cssText = `border-bottom:1px solid #ebeef5;transition:background 0.15s;cursor:grab;` +
      (dragId === p.menu_id ? 'opacity:0.4;' : '');
    card.draggable = true;

    // 拖拽手柄 + 菜单信息 + 子菜单展开按钮
    const head = el('div', '');
    head.style.cssText = 'display:flex;align-items:center;padding:12px 14px;gap:12px';

    // 拖拽手柄（仅图标，避免整个卡片都可点击）
    const handle = el('span', '', '⠿');
    handle.style.cssText = 'color:#c0c4cc;font-size:16px;cursor:grab;user-select:none;line-height:1';
    head.appendChild(handle);

    // 序号（实时预览）
    const sortInput = el('input', '');
    sortInput.type = 'number';
    sortInput.value = p.sort;
    sortInput.style.cssText = 'width:60px;padding:4px 6px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;text-align:center';
    sortInput.onchange = () => {
      const v = parseInt(sortInput.value, 10);
      if (isNaN(v)) { sortInput.value = p.sort; return; }
      p.sort = v;
      setDirty(true);
    };
    head.appendChild(sortInput);

    // 图标
    const icon = el('span', '', p.icon || '📁');
    icon.style.cssText = 'font-size:18px';
    head.appendChild(icon);

    // 名称
    const name = el('span', '', p.menu_name);
    name.style.cssText = 'font-weight:600;color:#303133;font-size:14px';
    head.appendChild(name);

    // 菜单 code
    const code = el('span', '', `(${p.menu_code})`);
    code.style.cssText = 'color:#c0c4cc;font-size:12px';
    head.appendChild(code);

    // 子菜单数量徽标
    if (p.children && p.children.length > 0) {
      const badge = el('span', '', `${p.children.length} 个子菜单`);
      badge.style.cssText = 'margin-left:auto;background:#e4e7ed;color:#606266;padding:2px 8px;border-radius:10px;font-size:11px';
      head.appendChild(badge);
    } else {
      const tip = el('span', '', '无子菜单');
      tip.style.cssText = 'margin-left:auto;color:#c0c4cc;font-size:11px';
      head.appendChild(tip);
    }

    // 展开按钮
    const hasChildren = p.children && p.children.length > 0;
    const expandBtn = el('button', '', hasChildren ? (expandedParents.has(p.menu_id) ? '➖ 收起' : '➕ 子菜单') : '—');
    expandBtn.type = 'button';
    expandBtn.style.cssText = 'background:#fff;border:1px solid #dcdfe6;color:#606266;padding:2px 10px;border-radius:4px;font-size:12px;cursor:' + (hasChildren ? 'pointer' : 'default');
    if (hasChildren) {
      expandBtn.onclick = (e) => {
        e.stopPropagation();
        if (expandedParents.has(p.menu_id)) expandedParents.delete(p.menu_id);
        else expandedParents.add(p.menu_id);
        render();
      };
    }
    head.appendChild(expandBtn);

    card.appendChild(head);

    // 子菜单区域（展开才显示）
    if (hasChildren && expandedParents.has(p.menu_id)) {
      const childArea = el('div', 'ms-children');
      childArea.style.cssText = 'background:#f5f7fa;padding:10px 14px;border-top:1px dashed #ebeef5';
      p.children.forEach((c, cidx) => {
        const row = el('div', '');
        row.style.cssText = 'display:flex;align-items:center;padding:6px 12px;gap:10px;border-bottom:1px solid #ebeef5;cursor:grab';
        row.draggable = true;
        row.dataset.cid = c.menu_id;
        // 子菜单拖拽
        row.addEventListener('dragstart', (e) => {
          dragId = c.menu_id;
          dragKind = 'child'; dragParentId = p.menu_id;
          e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.style.background = '#ecf5ff'; });
        row.addEventListener('dragleave', () => { row.style.background = ''; });
        row.addEventListener('drop', (e) => {
          e.preventDefault(); row.style.background = '';
          if (dragKind !== 'child' || dragParentId !== p.menu_id || !dragId || dragId === c.menu_id) return;
          const list = p.children;
          const srcIdx = list.findIndex((x) => x.menu_id === dragId);
          const dstIdx = list.findIndex((x) => x.menu_id === c.menu_id);
          if (srcIdx < 0 || dstIdx < 0) return;
          const [m] = list.splice(srcIdx, 1);
          list.splice(dstIdx, 0, m);
          // 重排 sort（+10 递增）
          list.forEach((item, i) => { item.sort = (i + 1) * 10; });
          setDirty(true);
          dragId = null;
          render();
        });
        row.addEventListener('dragend', () => { dragId = null; row.style.background = ''; });

        const handle = el('span', '', '⠿');
        handle.style.cssText = 'color:#d0d0d0;font-size:14px;cursor:grab;user-select:none';
        row.appendChild(handle);

        const sortInput = el('input', '');
        sortInput.type = 'number';
        sortInput.value = c.sort;
        sortInput.style.cssText = 'width:55px;padding:3px 5px;border:1px solid #dcdfe6;border-radius:3px;font-size:12px;text-align:center';
        sortInput.onchange = () => {
          const v = parseInt(sortInput.value, 10);
          if (isNaN(v)) { sortInput.value = c.sort; return; }
          c.sort = v;
          setDirty(true);
        };
        row.appendChild(sortInput);

        const icon = el('span', '', c.icon || '');
        icon.style.cssText = 'font-size:14px';
        row.appendChild(icon);

        const name = el('span', '', c.menu_name);
        name.style.cssText = 'color:#303133;font-size:13px;flex:1';
        row.appendChild(name);

        const code = el('span', '', `(${c.menu_code})`);
        code.style.cssText = 'color:#c0c4cc;font-size:11px';
        row.appendChild(code);

        const pathTag = el('span', '', c.path ? `→ ${c.path}` : '（无路由）');
        pathTag.style.cssText = 'color:#909399;font-size:11px';
        row.appendChild(pathTag);

        childArea.appendChild(row);
      });
      card.appendChild(childArea);
    }

    // 父级拖拽事件
    let dragKind = null, dragParentId = null;
    card.addEventListener('dragstart', (e) => {
      dragId = p.menu_id;
      dragKind = 'parent';
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.borderTop = '3px solid #409eff'; });
    card.addEventListener('dragleave', () => { card.style.borderTop = ''; });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.style.borderTop = '';
      if (dragKind !== 'parent' || !dragId || dragId === p.menu_id) return;
      const list = workingTree;
      const srcIdx = list.findIndex((x) => x.menu_id === dragId);
      const dstIdx = list.findIndex((x) => x.menu_id === p.menu_id);
      if (srcIdx < 0 || dstIdx < 0) return;
      const [m] = list.splice(srcIdx, 1);
      list.splice(dstIdx, 0, m);
      // 重排 sort（10, 20, 30, ...）
      list.forEach((item, i) => { item.sort = (i + 1) * 10; });
      setDirty(true);
      dragId = null;
      render();
    });
    card.addEventListener('dragend', () => { dragId = null; card.style.borderTop = ''; });

    return card;
  }

  // ---------- 数据加载 ----------
  async function reload() {
    log('⏳ 从后端加载菜单树…');
    try {
      const r = await API.get('/admin/menus/tree');
      if (!r.ok) throw new Error(r.error);
      tree = r.data;
      workingTree = JSON.parse(JSON.stringify(tree)); // 深拷贝
      expandedParents = new Set();
      // 默认展开所有有子菜单的父级
      workingTree.forEach((p) => { if (p.children && p.children.length > 0) expandedParents.add(p.menu_id); });
      setDirty(false);
      render();
      log(`✅ 已加载 ${workingTree.length} 个父级菜单，共 ${workingTree.reduce((a, p) => a + (p.children ? p.children.length : 0), 0)} 个子菜单`, 'ok');
    } catch (e) {
      if (e.status === 403) { log('❌ 权限不足：需要超级管理员角色', 'err'); }
      else log('❌ 加载失败：' + e.message, 'err');
      parentList.innerHTML = '';
      parentList.appendChild(Object.assign(el('div', '', '❌ 加载失败（可能无权限）'), {
        style: 'padding:30px;color:#c23a1b;text-align:center'
      }));
    }
  }

  // ---------- 保存 ----------
  async function saveAll() {
    if (!isDirty) return;
    const ok = await confirmDialog({
      title: '确认保存菜单排序？',
      message: '将把当前所有父级 + 子菜单的 sort 值提交后端。保存后全站菜单顺序立即生效。',
      warn: '操作会写审计日志并全局生效。建议先确认侧边栏当前渲染顺序符合预期再保存。',
      okText: '立即保存',
      danger: false,
    });
    if (!ok) { log('用户取消了保存。', 'warn'); return; }

    // 收集所有变更项
    const items = [];
    workingTree.forEach((p) => {
      items.push({ menu_id: p.menu_id, sort: p.sort });
      if (p.children) p.children.forEach((c) => {
        items.push({ menu_id: c.menu_id, sort: c.sort });
      });
    });

    btnSave.disabled = true;
    log(`⏳ 提交 ${items.length} 条 sort 更新…`);
    try {
      const r = await API.put('/admin/menus/reorder', { items });
      if (r.ok) {
        log(`✅ ${r.message}`, 'ok');
        tree = JSON.parse(JSON.stringify(workingTree));
        setDirty(false);
      } else {
        log('❌ 保存失败：' + r.error, 'err');
      }
    } catch (e) {
      if (e.status === 403) log('❌ 权限不足（需要超级管理员角色）', 'err');
      else log('❌ 保存失败：' + e.message, 'err');
    } finally {
      btnSave.disabled = false;
    }
  }

  // 自动加载
  reload();
}

ERP_PAGES['menu_sort'] = createPage;
