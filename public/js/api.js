// 统一 API 封装：自动带 token，401 跳登录
// 托管平台网关会覆盖 Authorization 头，业务令牌同时走自定义头 X-ERP-Token
// 分享码固化：平台 __wb_rsc cookie 会随会话失效，失效后网关对 /api 返回 HTML「链接已失效」，
// 表现为前端笼统「请求失败」。故把 sharecode 持久化到 localStorage，所有请求自动附加该参数。
//
// 【永久规则 1·2026-11-19】部署版本号检测：
//   后端每个 JSON 响应自动追加 _build_version 字段。前端 req() 每次成功请求后比对
//   localStorage 里存的 last_build_version，若变化则弹出「系统已更新，请刷新页面」
//   提示——绝不踢用户下线，JWT 12h 有效期不受影响，只要求刷新静态资源（新 JS/CSS）。
//   提示带"稍后"按钮：当前操作不打断；"立即刷新"按钮：location.reload()。
const API = {
  base: '/api',
  token: localStorage.getItem('erp_token'),
  // 版本检测状态
  _lastVer: null,           // 最近一次看到的 build_version
  _noticeShownFor: null,    // 当前已经提示过的版本（防止同一个版本反复弹）
  _pendingReload: false,    // 用户点了"稍后"后，下一次请求继续检测但不弹
  // 页面加载时立即问一次服务器当前版本（快速感知部署）
  async _checkVersionSilent() {
    try {
      const res = await fetch(this._url('/version'), { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        if (j && j._build_version) {
          this._lastVer = j._build_version;
          const prev = localStorage.getItem('erp_build_version');
          if (prev && prev !== j._build_version && this._noticeShownFor !== j._build_version) {
            this._showUpdateNotice();
          }
        }
      }
    } catch (e) { /* 网络异常不打断用户 */ }
  },
  _showUpdateNotice() {
    this._noticeShownFor = this._lastVer;
    // 单例：只出现一个提示
    if (document.getElementById('__erp_update_notice')) return;
    const box = document.createElement('div');
    box.id = '__erp_update_notice';
    box.innerHTML = `
      <div style="position:fixed;top:20px;right:20px;max-width:360px;padding:16px 20px;background:#409eff;color:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
        <div style="font-weight:600;margin-bottom:6px;">📦 系统已更新</div>
        <div style="font-size:13px;line-height:1.5;opacity:.95;margin-bottom:12px;">后台已部署新版本，刷新页面后即可使用最新功能。<br>（刷新不会影响你的登录状态）</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="__erp_update_later" style="background:rgba(255,255,255,.25);color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;">稍后</button>
          <button id="__erp_update_now" style="background:#fff;color:#409eff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;">立即刷新</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector('#__erp_update_later').onclick = () => box.remove();
    box.querySelector('#__erp_update_now').onclick = () => location.reload();
  },
  // 检查响应体里的 _build_version（每次成功请求后调用）
  _afterSuccess(j) {
    if (!j || typeof j !== 'object') return;
    const ver = j._build_version;
    if (!ver) return;
    // 第一次收到 → 存起来
    if (!this._lastVer) {
      this._lastVer = ver;
      localStorage.setItem('erp_build_version', ver);
      return;
    }
    // 版本变了 → 弹提示
    if (ver !== this._lastVer && this._noticeShownFor !== ver) {
      this._lastVer = ver;
      localStorage.setItem('erp_build_version', ver);
      this._showUpdateNotice();
    }
  },
  headers() {
    const h = {};
    if (this.token) {
      h['Authorization'] = 'Bearer ' + this.token;
      h['X-ERP-Token'] = this.token;
    }
    return h;
  },
  // 从当前 URL 捕获 sharecode（首次经分享链接进入时），后续请求不再依赖网关 cookie
  captureSharecode() {
    try {
      const m = /[?&]sharecode=([^&]+)/.exec(location.search);
      if (m && m[1]) localStorage.setItem('erp_sharecode', decodeURIComponent(m[1]));
    } catch (e) { /* ignore */ }
  },
  _url(u) {
    const sc = localStorage.getItem('erp_sharecode');
    if (!sc) return this.base + u;
    return this.base + u + (u.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + encodeURIComponent(sc);
  },
  setToken(t) {
    this.token = t;
    localStorage.setItem('erp_token', t);
  },
  clear() {
    this.token = null;
    localStorage.removeItem('erp_token');
    localStorage.removeItem('erp_user');
  },
  // 非成功响应 → 解析后端 JSON 的 error；若响应不是 JSON（如网关 502 HTML 页），
  // 则带上 HTTP 状态码与响应片段，便于定位（替代笼统的「请求失败」）
  // 结构化错误：Error 对象保留 status / code / detail / conflicts 字段，供业务层定制提示
  async _fail(res) {
    const text = await res.text().catch(() => '');
    let msg = '';
    let code = '';
    let detail = null;
    let conflicts = null;
    try {
      const j = JSON.parse(text);
      msg = j.error || j.message || '';
      code = j.code || '';
      detail = j.detail || null;
      conflicts = j.conflicts || null;
    } catch (e) { /* 响应不是 JSON */ }
    if (!msg) {
      const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (/<html|<!doctype/i.test(text)) {
        msg = '访问链接已失效（HTTP ' + res.status + (snippet ? '：' + snippet : '') + '），请从分享链接重新打开本系统';
      } else {
        msg = '请求失败（HTTP ' + res.status + (snippet ? '）：' + snippet : '）');
      }
    }
    const e = new Error(msg);
    e.status = res.status;
    if (code) e.code = code;
    if (detail) e.detail = detail;
    if (conflicts) e.conflicts = conflicts;
    throw e;
  },
  // 统一 401 处理：清 token + 跳登录
  _handle401() {
    this.clear();
    location.href = 'login.html';
    throw new Error('登录已过期');
  },
  async req(method, url, body) {
    const opt = { method, headers: this.headers() };
    // 权限/菜单数据绝不允许被浏览器或中间网关缓存，否则新增菜单不生效
    if (method === 'GET' && /^\/auth\/(me|login)/.test(url)) {
      opt.cache = 'no-store';
      opt.headers['Cache-Control'] = 'no-cache';
      opt.headers.Pragma = 'no-cache';
    }
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(this._url(url), opt);
    } catch (e) {
      throw new Error('网络异常，无法连接服务器：' + e.message);
    }
    if (res.status === 401) this._handle401();
    if (!res.ok) await this._fail(res);
    const j = await res.json();
    this._afterSuccess(j);  // 【永久规则 1】检测部署版本变化
    return j;
  },
  get(u, params) {
    let url = u;
    // 可选第二参数：普通对象 → 自动拼 query string（null/undefined 跳过）
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') sp.append(k, String(v));
      }
      const qs = sp.toString();
      if (qs) url += (u.indexOf('?') >= 0 ? '&' : '?') + qs;
    }
    return this.req('GET', url);
  },
  post(u, b) {
    return this.req('POST', u, b);
  },
  put(u, b) {
    return this.req('PUT', u, b);
  },
  del(u, b) {
    return this.req('DELETE', u, b);
  },
  // FormData 上传（不能走 req，避免被 JSON 序列化）
  async upload(u, formData) {
    const res = await fetch(this._url(u), {
      method: 'POST',
      headers: this.headers(),
      body: formData,
    });
    if (res.status === 401) this._handle401();
    if (!res.ok) await this._fail(res);
    return res.json();
  },
  // 带 token 的二进制下载（模板/导出）
  async download(u, filename) {
    const res = await fetch(this._url(u), { headers: this.headers() });
    if (res.status === 401) this._handle401();
    if (!res.ok) {
      await this._fail(res);
      throw new Error('下载失败'); // 不可达（_fail 必抛），仅为语法完整性
    }
    // 文件名兜底：调用方未传时，优先取后端 Content-Disposition，最后给默认名。
    // 若直接把 undefined 赋给 a.download，部分浏览器不会触发下载（表现为「点了没反应」）。
    let name = filename;
    if (!name) {
      const cd = res.headers.get('content-disposition') || '';
      let m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      if (m) { try { name = decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch (e) { name = ''; } }
      if (!name) { m = /filename="?([^";]+)"?/i.exec(cd); if (m) name = m[1].trim(); }
    }
    name = name || 'download.xlsx';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
// 暴露到 window，供 _page_loader 动态注入的异步脚本访问
// （defer 脚本共享顶层作用域，动态注入脚本有独立上下文，必须挂 window）
window.API = API;

// 【永久规则 1】启动时静默查询服务器版本，对比 localStorage 里的上次版本。
// 页面加载后 2 秒发起（不阻塞首屏渲染），之后每次 API 响应里也会检测。
// 用户点了"稍后"后不会再打断 —— 只有**新的部署版本**才会再次弹提示。
if (!window.__ERP_NO_VERSION_CHECK) {
  setTimeout(() => {
    try { window.API._checkVersionSilent(); } catch (e) {}
  }, 2000);
}
