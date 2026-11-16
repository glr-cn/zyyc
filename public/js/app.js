// 应用外壳：登录态校验 → 权限加载 → 动态菜单 → hash 路由守卫 → 标签页初始化
// RBAC：/auth/me 返回 menus（两级权限菜单树）+ permissions（可访问 path 白名单），
// 前端菜单只渲染后端返回的数据；地址栏直访未授权路由由 hashchange 守卫拦截到 403。
(function () {
  const token = localStorage.getItem('erp_token');
  if (!token) {
    location.href = 'login.html';
    return;
  }
  API.captureSharecode(); // 从 URL 捕获分享码固化到 localStorage（防网关 cookie 失效）
  API.token = token;

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
    el.innerHTML =
      '<div class="err403">' +
      '<div class="code403">403</div>' +
      '<div class="msg403">无权访问「' + name + '」：该菜单未授权给当前角色，请联系管理员在「基础资料 → 权限 → 角色权限」中配置。</div>' +
      '<button id="backHomeBtn" class="primary">返回首页</button>' +
      '</div>';
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
    })
    .catch(() => {
      API.clear();
      location.href = 'login.html';
    });

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
})();
