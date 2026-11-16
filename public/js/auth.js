// 登录逻辑
// 分享码固化：首次经分享链接进入时把 sharecode 存入 localStorage，
// 之后所有 API（含登录）自动附加该参数，不再依赖平台会过期的 __wb_rsc cookie。
(function () {
  const m = /[?&]sharecode=([^&]+)/.exec(location.search);
  if (m && m[1]) localStorage.setItem('erp_sharecode', decodeURIComponent(m[1]));
})();

function loginUrl() {
  const sc = localStorage.getItem('erp_sharecode');
  return '/api/auth/login' + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const res = await fetch(loginUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: f.username.value, password: f.password.value }),
    });
    // 网关拦截时返回 HTML（非 JSON），res.json() 会抛难懂的解析错误——给出明确指引
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e2) {
      throw new Error('访问链接已失效，请从分享链接重新打开本系统');
    }
    if (!res.ok) throw new Error(data.error || '登录失败');
    localStorage.setItem('erp_token', data.token);
    localStorage.setItem('erp_user', JSON.stringify(data.user));
    // 登录会话戳：每次登录生成新的会话戳（刷新页面不变）。
    // 标签页管理器据此判断——同一会话（刷新）恢复上次打开的标签；
    // 新会话（重新登录）重置临时标签状态。
    localStorage.setItem('erp_login_stamp', Date.now() + '-' + Math.random().toString(36).slice(2));
    location.href = 'app.html';
  } catch (ex) {
    err.textContent = ex.message;
  }
});
