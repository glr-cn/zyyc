// ============================================================
//  权限树组件（原生 JS，三态复选框：全选 / 半选 / 未选）
//  - 父勾选 → 递归勾选全部子菜单；父取消 → 递归取消全部子菜单
//  - 仅勾部分子菜单 → 父呈现半选（浏览器原生 indeterminate 横杠）
//  - collect()：收集全部 checked 节点 id 提交后端（半选父节点不提交，
//    后端会做二次收敛，父节点仅作全选标记）
//  - hydrate(ids)：编辑回填，父状态完全由子节点推导
//
//  【2026-11-16 崩溃修复】
//  原实现用 treeData.forEach(function visit(n, parent){...}) 建索引，
//  forEach 的第二参数是「数组下标数字」而非父节点对象：
//    · 根节点 parent 被赋成 0/1/2…（数字）
//    · hydrate 自底向上 recomputeUp 递归到数字 → 读 (number).children.length
//      → TypeError: Cannot read properties of undefined (reading 'length')
//  现改为独立 visit(n, parent) 显式传父节点，根节点 parent = null。
//  同时对所有外部入参做 Array.isArray 兜底，接口返回 null/对象也不再崩溃。
// ============================================================
window.ERP = window.ERP || {};

ERP.createPermissionTree = function (host, treeData) {
  const index = new Map();

  // 数据兜底：接口异常返回 null/undefined/对象时，统一降级为空数组
  const nodes = Array.isArray(treeData) ? treeData : [];

  // 建索引：parent 指针 / children 数组 / 初始未选
  // ⚠️ 必须独立定义 visit 并显式传 parent，切勿写成 array.forEach(visit)！
  function visit(n, parent) {
    if (!n || typeof n !== 'object') return; // 跳过脏数据节点
    n.parent = parent || null;
    n.children = Array.isArray(n.children) ? n.children : [];
    n.state = 'unchecked';
    if (n.menu_id != null) index.set(n.menu_id, n);
    n.children.forEach((c) => visit(c, n));
  }
  nodes.forEach((n) => visit(n, null));

  const depth = (n) => { let d = 0, p = n && n.parent; while (p && typeof p === 'object') { d++; p = p.parent; } return d; };

  // 勾/取消某节点 → 递归联动全部子孙
  function setState(n, on) {
    if (!n || !Array.isArray(n.children)) return;
    n.state = on ? 'checked' : 'unchecked';
    n.children.forEach((c) => setState(c, on));
  }

  // 子 → 父推导：全选 checked / 全不选 unchecked / 部分选 indeterminate（半选）
  function recomputeUp(n) {
    if (!n || typeof n !== 'object' || !Array.isArray(n.children)) return; // 兜底：脏节点直接跳过
    if (n.children.length) {
      const all = n.children.every((c) => c.state === 'checked');
      const none = n.children.every((c) => c.state === 'unchecked');
      n.state = all ? 'checked' : none ? 'unchecked' : 'indeterminate';
    }
    recomputeUp(n.parent);
  }

  function toggle(id) {
    const n = index.get(id);
    if (!n) return;
    setState(n, n.state !== 'checked'); // 半选点击 → 全选（常规交互）
    recomputeUp(n);
    render();
  }

  function render() {
    host.innerHTML = '';
    if (!nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '暂无可配置的菜单';
      host.appendChild(empty);
      return;
    }
    nodes.forEach((root) => {
      const box = document.createElement('div');
      box.className = 'ptree-root';
      appendNode(box, root, 0);
      host.appendChild(box);
    });
  }

  function appendNode(container, n, level) {
    const row = document.createElement('div');
    row.className = 'ptree-row' + (level === 0 ? ' tree-parent' : '') + (n.is_built === 0 ? ' unbuilt' : '');
    row.style.paddingLeft = level * 20 + 'px';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = n.state === 'checked';
    cb.indeterminate = n.state === 'indeterminate'; // 浏览器原生「半选」横杠
    cb.addEventListener('click', (e) => {
      e.preventDefault();          // 状态由组件统一管理，避免双写
      toggle(n.menu_id);
    });
    row.appendChild(cb);

    const label = document.createElement('span');
    label.className = 'ptree-label';
    label.textContent = n.menu_name;
    label.addEventListener('click', () => toggle(n.menu_id));
    row.appendChild(label);

    if (n.is_built === 0) {
      const tag = document.createElement('span');
      tag.className = 'ptree-tag';
      tag.textContent = '建设中';
      row.appendChild(tag);
    }
    container.appendChild(row);

    (n.children || []).forEach((c) => appendNode(container, c, level + 1));
  }

  return {
    toggle,
    render,
    // 提交：全部 checked 节点 id（半选父不提交；子节点已包含实际权限）
    collect: () => [...index.values()].filter((n) => n.state === 'checked').map((n) => n.menu_id),
    // 回填：叶子按 ids 置位，父状态自底向上推导（ids 非数组时按空集合处理）
    hydrate: (ids) => {
      const S = new Set(Array.isArray(ids) ? ids : []);
      [...index.values()].filter((n) => !n.children.length)
        .forEach((n) => { n.state = S.has(n.menu_id) ? 'checked' : 'unchecked'; });
      [...index.values()].filter((n) => n.children.length)
        .sort((a, b) => depth(b) - depth(a)).forEach(recomputeUp);
      render();
    },
    checkAll: () => { nodes.forEach((n) => setState(n, true)); render(); },
    clearAll: () => { nodes.forEach((n) => setState(n, false)); render(); },
  };
};
