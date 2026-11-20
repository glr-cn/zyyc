// ============================================================================
// settings.js · 系统设置（2026-11-20）
// ----------------------------------------------------------------------------
// 页面：基础资料 → 系统设置
// 功能：物流映射配置（快递公司编码 ↔ 名称）可视化增删改、恢复默认，保存后实时生效
// 权限：页面读由菜单权限控制；写操作后端 roleGate 二次校验（管理员/超级管理员）
// ============================================================================
(function () {
  const API = window.API;
  const CARD_CSS = 'background:#fff;border-radius:8px;padding:18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06);';
  const BTN_PRIMARY = 'background:#409eff;color:#fff;border:none;border-radius:4px;padding:8px 20px;font-size:14px;cursor:pointer;';
  const BTN_GHOST = 'background:#fff;color:#409eff;border:1px solid #409eff;border-radius:4px;padding:7px 16px;font-size:14px;cursor:pointer;';
  const BTN_DANGER = 'background:#fff;color:#f56c6c;border:1px solid #f56c6c;border-radius:4px;padding:5px 12px;font-size:13px;cursor:pointer;';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function canWrite() {
    const role = (window.ERP_USER || {}).role;
    const code = (window.ERP_USER || {}).role_code;
    return role === '管理员' || role === '超级管理员' || code === 'admin' || code === 'super_admin';
  }
  function toast(msg, type) {
    if (window.ERP && ERP.toast) ERP.toast(msg, type);
    else alert(msg);
  }

  // --------------------------------------------------------------------------
  // 物流映射配置弹窗
  // --------------------------------------------------------------------------
  function openExpressMapModal() {
    const old = document.getElementById('__expressMapModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = '__expressMapModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:720px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.2);">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #ebeef5;">
          <div>
            <div style="font-size:16px;font-weight:700;color:#303133;">🚚 物流映射配置</div>
            <div style="font-size:12px;color:#909399;margin-top:4px;">维护快递公司编码与名称的对应关系，保存后立即对订单导入与统计生效</div>
          </div>
          <button id="emClose" style="background:none;border:none;font-size:22px;color:#909399;cursor:pointer;line-height:1;">×</button>
        </div>
        <div style="padding:16px 20px;overflow:auto;flex:1;">
          <div id="emAlert"></div>
          <div style="overflow:auto;border:1px solid #ebeef5;border-radius:6px;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead><tr style="background:#f5f7fa;">
                <th style="padding:8px 10px;border:1px solid #ebeef5;width:46%;text-align:left;">快递公司编码</th>
                <th style="padding:8px 10px;border:1px solid #ebeef5;text-align:left;">快递公司名称</th>
                <th style="padding:8px 10px;border:1px solid #ebeef5;width:132px;">操作</th>
              </tr></thead>
              <tbody id="emRows"></tbody>
            </table>
          </div>
          <div style="margin-top:14px;padding:12px;background:#f7f9fc;border-radius:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#606266;">
              新编码
              <input id="emNewCode" placeholder="如 JTSD" maxlength="20" style="padding:6px 10px;border:1px solid #dcdfe6;border-radius:4px;width:160px;font-size:13px;text-transform:uppercase;">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#606266;">
              新名称
              <input id="emNewName" placeholder="如 极兔速递" maxlength="40" style="padding:6px 10px;border:1px solid #dcdfe6;border-radius:4px;width:200px;font-size:13px;">
            </label>
            <button id="emAdd" style="${BTN_PRIMARY};padding:7px 16px;">+ 新增</button>
            <span style="flex:1;"></span>
            <button id="emReset" style="${BTN_GHOST};padding:6px 14px;font-size:13px;">恢复默认映射</button>
          </div>
          <div style="margin-top:10px;font-size:12px;color:#909399;">
            提示：编码不区分大小写（STO/zto 等价）；导入时按「编码 → 名称」转换，未配置的编码会原样保留。
          </div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #ebeef5;display:flex;justify-content:flex-end;">
          <button id="emDone" style="${BTN_GHOST}">完成</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const rowsEl = overlay.querySelector('#emRows');
    const alertEl = overlay.querySelector('#emAlert');
    const writable = canWrite();

    function showAlert(msg, type) {
      const color = type === 'error' ? '#f56c6c' : '#67c23a';
      const bg = type === 'error' ? '#fef0f0' : '#f0f9eb';
      alertEl.innerHTML = `<div style="margin-bottom:12px;padding:8px 12px;background:${bg};color:${color};border-radius:4px;font-size:13px;">${esc(msg)}</div>`;
      setTimeout(() => { alertEl.innerHTML = ''; }, 4000);
    }

    function renderRows(items) {
      if (!items.length) {
        rowsEl.innerHTML = '<tr><td colspan="3" style="padding:24px;text-align:center;color:#909399;">暂无映射，请新增</td></tr>';
        return;
      }
      rowsEl.innerHTML = items.map((it, i) => `
        <tr data-code="${esc(it.code)}" style="border-bottom:1px solid #ebeef5;">
          <td style="padding:6px 8px;border:1px solid #ebeef5;">
            <input class="em-code" value="${esc(it.code)}" ${writable ? '' : 'disabled'} maxlength="20"
              style="width:100%;padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;font-family:monospace;text-transform:uppercase;box-sizing:border-box;">
          </td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;">
            <input class="em-name" value="${esc(it.name)}" ${writable ? '' : 'disabled'} maxlength="40"
              style="width:100%;padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;box-sizing:border-box;">
          </td>
          <td style="padding:6px 8px;border:1px solid #ebeef5;text-align:center;white-space:nowrap;">
            ${writable ? `<button class="em-save" data-idx="${i}" style="${BTN_PRIMARY};padding:5px 12px;font-size:13px;">保存</button>
            <button class="em-del" data-code="${esc(it.code)}" style="${BTN_DANGER};margin-left:6px;">删除</button>` : '<span style="color:#c0c4cc;">只读</span>'}
          </td>
        </tr>`).join('');

      if (!writable) return;
      rowsEl.querySelectorAll('.em-save').forEach((btn) => {
        btn.onclick = () => {
          const tr = btn.closest('tr');
          const origCode = tr.dataset.code;
          const code = tr.querySelector('.em-code').value.trim();
          const name = tr.querySelector('.em-name').value.trim();
          btn.disabled = true;
          API.put('/settings/express-map/' + encodeURIComponent(origCode), { code, name })
            .then((r) => { renderRows(r.items); showAlert('已保存：' + code, 'ok'); })
            .catch((e) => showAlert(e.message, 'error'))
            .finally(() => { btn.disabled = false; });
        };
      });
      rowsEl.querySelectorAll('.em-del').forEach((btn) => {
        btn.onclick = () => {
          const code = btn.dataset.code;
          if (!confirm('确认删除映射「' + code + '」？删除后该编码导入时将原样保留。')) return;
          API.del('/settings/express-map/' + encodeURIComponent(code))
            .then((r) => { renderRows(r.items); showAlert('已删除：' + code, 'ok'); })
            .catch((e) => showAlert(e.message, 'error'));
        };
      });
    }

    function load() {
      rowsEl.innerHTML = '<tr><td colspan="3" style="padding:24px;text-align:center;color:#909399;">⏳ 加载中...</td></tr>';
      API.get('/settings/express-map')
        .then((r) => renderRows(r.items || []))
        .catch((e) => {
          rowsEl.innerHTML = `<tr><td colspan="3" style="padding:24px;text-align:center;color:#f56c6c;">加载失败：${esc(e.message)}</td></tr>`;
        });
    }

    overlay.querySelector('#emAdd').onclick = () => {
      if (!writable) return toast('当前角色无配置权限', 'error');
      const code = overlay.querySelector('#emNewCode').value.trim();
      const name = overlay.querySelector('#emNewName').value.trim();
      if (!code || !name) return showAlert('编码和名称都要填写', 'error');
      API.post('/settings/express-map', { code, name })
        .then((r) => {
          overlay.querySelector('#emNewCode').value = '';
          overlay.querySelector('#emNewName').value = '';
          renderRows(r.items);
          showAlert('已新增：' + code, 'ok');
        })
        .catch((e) => showAlert(e.message, 'error'));
    };

    overlay.querySelector('#emReset').onclick = () => {
      if (!writable) return toast('当前角色无配置权限', 'error');
      if (!confirm('恢复默认映射会覆盖当前全部配置（STO/ZTO/YTO4/YTO5/SF/DBKD），确认继续？')) return;
      API.post('/settings/express-map/reset', {})
        .then((r) => { renderRows(r.items); showAlert('已恢复默认映射', 'ok'); })
        .catch((e) => showAlert(e.message, 'error'));
    };

    const close = () => overlay.remove();
    overlay.querySelector('#emClose').onclick = close;
    overlay.querySelector('#emDone').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay._esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', overlay._esc); } };
    document.addEventListener('keydown', overlay._esc);

    load();
  }

  // --------------------------------------------------------------------------
  // 页面
  // --------------------------------------------------------------------------
  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES.settings = function (host) {
    host.innerHTML = '';
    host.style.cssText = 'padding:16px;background:#f5f7fa;min-height:100%;box-sizing:border-box;';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:1000px;margin:0 auto;';
    wrap.innerHTML = `
      <div style="${CARD_CSS}">
        <h3 style="margin:0 0 6px;font-size:16px;color:#303133;">⚙️ 系统设置</h3>
        <div style="font-size:12px;color:#909399;">系统级基础配置。修改后实时生效，不影响历史数据。</div>
      </div>

      <div style="${CARD_CSS}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">
          <div>
            <div style="font-size:14px;font-weight:600;color:#303133;">🚚 物流映射配置</div>
            <div style="font-size:13px;color:#909399;margin-top:6px;line-height:1.6;">
              维护快递公司编码与名称的对应关系（如 STO → 申通快递）。<br>
              订单导入时自动按映射把编码转换为名称，并作为「电子面单类型」保存与统计。
            </div>
          </div>
          <button id="openExpressMap" style="${BTN_PRIMARY}">⚙️ 物流映射配置</button>
        </div>
      </div>
    `;
    host.appendChild(wrap);
    wrap.querySelector('#openExpressMap').onclick = openExpressMapModal;
  };
})();
