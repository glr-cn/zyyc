// ============================================================
//  云服务接入（WorkBuddy Cloud Service）
//  - CDN SDK 初始化（publicConfig 三值：endpoint / oauthRelayBaseUrl / publishableKey）
//  - 云身份：WorkBuddy 账号登录（Relay + PKCE），会话恢复与回调分发
//  - 签收单能力：云存储上传（shared 共享区）+ 云数据库元数据 + 签名 URL 查看
//  所有请求由 SDK 注入 publishableKey 与登录会话；禁止手写 fetch 调 /.cloud/**。
// ============================================================
window.ERP_CLOUD = (function () {
  // publicConfig（由 workbuddy_cloud_service 激活结果下发；publishableKey 无权限语义，可入前端）
  const PUBLIC_CONFIG = {
    endpoint: 'https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_asI4JZhsb1Qg5dmqbGcRuy_16ciuEVBvCYep0TRuhaSgqSgdKFIYJxC',
  };

  let cloud = null;
  let session = null; // 当前云会话缓存 { user: { id, name, ... } }

  function sdkReady() { return typeof WorkBuddyCloud !== 'undefined' && !!WorkBuddyCloud.createWorkBuddyCloud; }

  function client() {
    if (!cloud) {
      if (!sdkReady()) throw new Error('云服务 SDK 未加载（检查网络或 CDN 可达性）');
      cloud = WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: PUBLIC_CONFIG.endpoint,
        oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
        publishableKey: PUBLIC_CONFIG.publishableKey,
      });
    }
    return cloud;
  }

  // ---------- 会话 ----------
  async function refreshSession() {
    try {
      const { data, error } = await client().auth.getSession();
      session = error ? null : (data || null);
    } catch (e) {
      console.error('[cloud] 会话获取失败:', e);
      session = null;
    }
    return session;
  }

  function getSession() { return session; }

  // ---------- 登录 / 退出 ----------
  // WorkBuddy 账号登录：signInWithOAuth 不跳转，返回授权 URL 后由页面 assign。
  // redirectTo 必须是站点根 + 应用自身参数（保留 sharecode），绝不转发旧回调参数。
  async function login() {
    const back = new URL(location.href);
    back.pathname = '/';
    back.hash = ''; // 登录后回到默认首页，避免残留 403 hash
    for (const key of ['code', 'state', 'provider']) back.searchParams.delete(key);
    const { data, error } = await client().auth.signInWithOAuth({
      provider: 'workbuddy',
      redirectTo: back.toString(),
    });
    if (error) throw new Error(error.message || '云登录发起失败');
    location.assign(data.url);
  }

  async function logout() {
    try { await client().auth.signOut(); } catch (e) { console.error('[cloud] 退出失败:', e); }
    session = null;
  }

  // 回调分发：URL 携带 code/error 时按 provider 处理；成功后清除回调参数（保留 sharecode）。
  // 返回 true 表示本次加载是 OAuth 回调且已处理完成。
  async function handleCallbackIfAny() {
    const url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return false;
    const provider = url.searchParams.get('provider');
    if (provider === 'workbuddy') {
      try {
        await client().auth.handleWorkBuddyCallback();
        await refreshSession();
      } catch (e) {
        console.error('[cloud] WorkBuddy 登录回调处理失败:', e);
        ERP.toast && ERP.toast('云登录失败：' + (e.message || '未知错误'));
      }
    }
    // 无论成败都清掉回调参数（state 单次有效，残留会导致刷新重放报错），保留 sharecode 等业务参数
    for (const key of ['code', 'state', 'provider', 'error']) url.searchParams.delete(key);
    history.replaceState(null, '', url.toString());
    return true;
  }

  // ---------- 图片签收单 ----------
  const MAX_SIZE = 10 * 1024 * 1024;
  const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  // 上传：云存储 shared 共享区（登录用户全员可读，上传者可管理）→ 元数据落云库 signoffs 表
  // meta: { customer_name, warehouse, work_date, order_no, note }
  async function uploadSignoff(file, meta) {
    if (!session) throw new Error('请先登录云空间');
    if (!OK_TYPES.includes(file.type)) throw new Error('仅支持 JPG/PNG/WebP/GIF 图片');
    if (file.size > MAX_SIZE) throw new Error('图片不能超过 10MB');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const safe = (file.name.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40)) || 'signoff';
    const path = client().storage.sharedPath(
      session.user.id,
      'signoffs/' + Date.now() + '_' + safe + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext
    );
    const up = await client().storage.upload(path, file, { contentType: file.type });
    if (up.error) throw new Error('图片上传失败：' + (up.error.message || '未知错误'));
    const ins = await client().database.from('signoffs').insert({
      owner_name: session.user.name || session.user.id,
      customer_name: meta.customer_name,
      warehouse: meta.warehouse || null,
      work_date: meta.work_date,
      order_no: meta.order_no || null,
      file_path: path,
      file_name: file.name,
      note: meta.note || null,
    }).select();
    if (ins.error) throw new Error('签收单保存失败：' + (ins.error.message || '未知错误'));
    return (ins.data && ins.data[0]) || null;
  }

  // 列表：按仓库过滤（可选），时间倒序，附签名下载 URL（10 分钟有效）
  async function listSignoffs(warehouse) {
    if (!session) throw new Error('请先登录云空间');
    let q = client().database.from('signoffs').select('*').order('created_at', { ascending: false }).limit(30);
    if (warehouse) q = q.eq('warehouse', warehouse);
    const { data, error } = await q;
    if (error) throw new Error('签收单读取失败：' + (error.message || '未知错误'));
    const rows = data || [];
    if (rows.length) {
      const urls = await client().storage.createSignedUrls(rows.map((r) => r.file_path), 600);
      if (!urls.error && Array.isArray(urls.data)) {
        rows.forEach((r, i) => { r._url = urls.data[i] && urls.data[i].url; });
      }
    }
    return rows;
  }

  async function deleteSignoff(row) {
    if (!session) throw new Error('请先登录云空间');
    const del = await client().database.from('signoffs').delete().eq('id', row.id).select();
    if (del.error) throw new Error('删除失败：' + (del.error.message || '未知错误'));
    if (Array.isArray(del.data) && del.data.length === 0) throw new Error('删除被拒绝（可能无权限）');
    const rm = await client().storage.remove([row.file_path]);
    if (rm.error) console.error('[cloud] 图片文件删除失败（记录已删）:', rm.error);
    return true;
  }

  return {
    PUBLIC_CONFIG,
    sdkReady,
    init: handleCallbackIfAny,
    refreshSession,
    getSession,
    login,
    logout,
    uploadSignoff,
    listSignoffs,
    deleteSignoff,
  };
})();
