// 应用外壳：登录态校验 → 权限加载 → 动态菜单 → hash 路由守卫 → 标签页初始化
// ★ 启动守卫（启动期间 _booting=true）：
//   FaaS 部署切换/冷启动期间，/auth/me 可能临时 502/超时/401。
//   以前：任何异常 → API.clear() → location.href='login.html' → 用户被强制踢下线
//   现在：启动期间不清 token、不跳登录 → 显示"服务启动中，点击重试"UI → 重试 3 次 → 再失败才兜底
(function () {
  const token = localStorage.getItem('erp_token');
  if (!token) {
    location.href = 'login.html';
    return;
  }
  API.captureSharecode();
  API.token = token;
  API._booting = true;  // ★ 标记启动阶段，_handle401 不清 token

  // 启动期间的"服务暂不可用"UI（可重试）
  function showBootErrorUI(msg) {
    document.body.innerHTML =
      '<div style="display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:-apple-system,sans-serif;background:#f5f7fa;">' +
      '<div style="max-width:420px;padding:32px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;">' +
      '<div style="font-size:48px;margin-bottom:16px;">🔄</div>' +
      '<div style="font-size:18px;font-weight:600;margin-bottom:8px;">服务启动中</div>' +
      '<div style="font-size:14px;color:#666;line-height:1.6;margin-bottom:24px;">' +
      (msg || '服务器正在切换新版本，请稍等几秒后重试。') +
      '</div>' +
      '<div style="display:flex;gap:10px;justify-content:center;">' +
      '<button id="__retryBoot" style="background:#409eff;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">重试</button>' +
      '<button id="__forceLogin" style="background:#f5f7fa;color:#666;border:1px solid #dcdfe6;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;">重新登录</button>' +
      '</div></div></div>';
    document.getElementById('__retryBoot').onclick = () => location.reload();
    document.getElementById('__forceLogin').onclick = () => { API.clear(); location.href = 'login.html'; };
  }

  // 403 拦截页：渲染到主内容区（不生成标签页），提供返回首个授权页入口
  ERP.render403 = function (page) {
    const content = document.getElementById('content');
    if (!content) return;
    document.querySelectorAll('.page-403').forEach((el) => el.remove());
    Object.keys(ERP.tabs.views || {}).forEach((p) => {
      if (ERP.tabs.views[p]) ERP.tabs.views[p].style.display = 'none';
    });
    const meta = ERP.PAGE_META[page];
    const name = meta ? meta.title : page || '该页面';
    const el = document.createElement('div');
    el.className = 'page-403';
    // ★ 修复 F6：page 来自 location.hash，原 innerHTML 直接拼接 → 反射型 XSS。
    //   结构用 innerHTML（静态），动态 name 用 textContent 注入，杜绝脚本执行。
    el.innerHTML =
      '<div class="err403">' +
      '<div class="code403">403</div>' +
      '<div class="msg403">无权访问「<span class="page403-name"></span>」：该菜单未授权给当前角色，请联系管理员在「基础资料 → 权限 → 角色权限」中配置。</div>' +
      '<button id="backHomeBtn" class="primary">返回首页</button>' +
      '</div>';
    el.querySelector('.page403-name').textContent = name;
    content.appendChild(el);
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    document.title = '403 无权访问 · 佐雍云仓数据中心';
    el.querySelector('#backHomeBtn').addEventListener('click', () => {
      if (ERP._go) ERP._go(ERP._defaultPage());
    });
  };

  // hash 路由守卫：页面必须在 PAGE_META 且在权限白名单内
  ERP.guard = function (page) {
    if (!page) {
      // 根路径重定向到首个授权页（不产生多余标签）
      const def = ERP._defaultPage();
      try { location.replace('#/' + def); } catch (e) { /* ignore */ }
      return;
    }
    if (!ERP.PAGE_META[page] || !ERP.PERMS.has(page)) {
      ERP.render403(page);
      return;
    }
    ERP.tabs.open(page);
  };

  // 菜单结构版本号 + 时间戳：绕过浏览器/托管网关对 /auth/me 的旧响应缓存，
  // 这是「后端已加菜单但左侧不显示」最常见的根因
  const MENU_V = ERP.MENU_SCHEMA_VERSION || 1;
  API.get('/auth/me?mv=' + MENU_V + '&_=' + Date.now())
    .then((r) => {
      const user = r.user;
      document.getElementById('uname').textContent =
        (user.display_name || user.username) + '（' + user.role + '）';
      window.ERP_USER = user;
      // 用户名可点击 → 修改密码（自助）
      document.getElementById('uname').addEventListener('click', openChangePwd);

      // 权限白名单（有序数组 + Set 双结构：默认页取第一项）
      ERP.PERM_LIST = r.permissions || [];
      ERP.PERMS = new Set(ERP.PERM_LIST);

      // 版本不一致 → 清理菜单缓存；把权限白名单交给渲染器做「后端 menus 缺日志中心」兜底
      if (ERP.ensureMenuVersion) ERP.ensureMenuVersion(r.menu_version || MENU_V);
      ERP.renderMenu(r.menus || [], {
        permissions: ERP.PERM_LIST,
        version: r.menu_version || MENU_V,
      });
      document.getElementById('app').style.display = 'flex';

      // 页面切换：写 hash → hashchange 守卫 → tabs.open
      ERP._go = (page) => { location.hash = '#/' + page; };
      ERP.HASH_ROUTING = true; // 打开 tabs 内的 hash 联动（测试桩环境不受影响）

      function onHash() {
        const page = location.hash.replace(/^#\/?/, '');
        ERP.guard(page);
      }
      window.addEventListener('hashchange', onHash);

      // 初始化标签页（刷新恢复 / 新登录重置），随后按当前 hash 进入守卫
      ERP.tabs.init(user);
      onHash();
      API._booting = false;  // ★ 启动成功，解除启动守卫
    })
    .catch((e) => {
      API._booting = false;
      // ★ 启动失败：不清 token！区分"真过期"和"临时故障"
      const msg = (e && e.message) || '未知错误';
      // 只有明确的 JWT 过期错误才跳登录
      if (/登录已过期|未登录/.test(msg)) {
        // 真过期：清 token + 跳登录
        API.clear();
        location.href = 'login.html';
      } else {
        // 临时故障（网络/502/冷启动）：显示重试 UI，token 保留在 localStorage
        // 用户点"重试"→ location.reload() → 重新走启动链路
        // 如果这次还失败，说明真的挂了，用户可以点"重新登录"
        showBootErrorUI(msg);
      }
    });

  // ---------- 自助修改密码（点击右上角用户名） ----------
  function openChangePwd() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="width:420px;max-width:94vw;">
        <div class="modal-head"><span>修改密码</span><button class="close" type="button">×</button></div>
        <div class="modal-body" style="display:block;">
          <label style="display:block;margin-bottom:12px;">旧密码
            <input id="cp_old" type="password" autocomplete="current-password" placeholder="请输入当前密码" style="width:100%;margin-top:4px;">
          </label>
          <label style="display:block;margin-bottom:12px;">新密码
            <input id="cp_new" type="password" autocomplete="new-password" placeholder="至少 6 位" style="width:100%;margin-top:4px;">
          </label>
          <label style="display:block;">确认新密码
            <input id="cp_new2" type="password" autocomplete="new-password" placeholder="再次输入新密码" style="width:100%;margin-top:4px;">
          </label>
          <div id="cp_err" class="err" style="margin-top:10px;"></div>
        </div>
        <div class="modal-foot">
          <button id="cp_save" class="primary" type="button">确定修改</button>
          <button class="close" type="button">取消</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('.close').forEach((b) => (b.onclick = () => modal.remove()));
    const errEl = modal.querySelector('#cp_err');
    modal.querySelector('#cp_save').onclick = async () => {
      const old_password = modal.querySelector('#cp_old').value;
      const new_password = modal.querySelector('#cp_new').value;
      const new2 = modal.querySelector('#cp_new2').value;
      if (!old_password || !new_password) { errEl.textContent = '请填写旧密码和新密码'; return; }
      if (new_password !== new2) { errEl.textContent = '两次输入的新密码不一致'; return; }
      if (new_password.length < 6) { errEl.textContent = '新密码至少 6 位'; return; }
      const btn = modal.querySelector('#cp_save');
      btn.disabled = true;
      try {
        await API.put('/auth/change-password', { old_password, new_password });
        modal.remove();
        alert('密码修改成功，请用新密码重新登录');
        API.clear();
        location.href = 'login.html';
      } catch (e) {
        errEl.textContent = e.message || '修改失败';
        btn.disabled = false;
      }
    };
    modal.querySelector('#cp_old').focus();
  }

  document.getElementById('logout').addEventListener('click', () => {
    API.clear();
    location.href = 'login.html';
  });

  // ---------- 云空间状态（WorkBuddy Cloud Service） ----------
  // 重要：云空间（Cloud Service）仅用于"签收单附件"等【可选文件存储】，
  // 与 ERP 业务数据库（本地 SQLite / 或云 Postgres）完全独立。
  // "未连接"只是没登录云存储，绝不影响 ERP 数据读写与持久化，请勿误以为是数据库断开。
  // 先处理 OAuth 回调（登录回跳），再刷新状态展示；回调分发须在路由守卫之前完成
  const cloudBtn = document.getElementById('cloudState');
  function renderCloudState() {
    const sess = ERP_CLOUD.getSession();
    if (sess && sess.user) {
      cloudBtn.textContent = '☁ 云存储已连：' + (sess.user.name || '云用户');
      cloudBtn.classList.add('ok');
      cloudBtn.title = '点击断开云存储（不影响 ERP 本地数据）';
    } else {
      cloudBtn.textContent = '☁ 云存储（可选）';
      cloudBtn.classList.remove('ok');
      cloudBtn.title = 'ERP 数据存于本地数据库，与云存储无关；点击可用 WorkBuddy 账号登录云空间（仅用于签收单附件等可选存储）';
    }
  }
  cloudBtn.addEventListener('click', async () => {
    const sess = ERP_CLOUD.getSession();
    if (sess && sess.user) {
      if (confirm('断开云空间连接？（不影响 ERP 本地登录）')) {
        await ERP_CLOUD.logout();
        renderCloudState();
      }
    } else {
      try {
        await ERP_CLOUD.login(); // 成功时页面跳转授权页
      } catch (e) {
        console.error('[cloud] 登录发起失败:', e);
        alert('云登录发起失败：' + e.message);
      }
    }
  });
  (async () => {
    if (!ERP_CLOUD.sdkReady()) {
      cloudBtn.textContent = '☁ 云服务不可用';
      cloudBtn.title = '云服务 SDK 加载失败（检查网络）';
      return;
    }
    try { await ERP_CLOUD.init(); } catch (e) { console.error('[cloud] 回调处理异常:', e); }
    await ERP_CLOUD.refreshSession();
    renderCloudState();
  })();

  // ---------- 全局 Escape 关闭弹窗 ----------
  // 覆盖所有 modal-overlay（7 个文件、19 处弹窗：errAlert / confirmDialog / openImportConfirm / 编辑弹窗等）
  // 策略：优先触发弹窗内的 .close 按钮 click（复用已有关闭逻辑：清理状态、移除 overlay），
  // 没有 .close 按钮（如 confirmDialog 的 confirmOnly 模式）就直接 remove()
  // 嵌套弹窗处理：querySelectorAll 后取最后一个（DOM 中最后 appendChild 的 = 最上层）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlays = document.querySelectorAll('.modal-overlay');
    if (!overlays.length) return;
    const top = overlays[overlays.length - 1];
    const closeBtn = top.querySelector('.close');
    if (closeBtn) closeBtn.click();
    else top.remove();
  });
})();
