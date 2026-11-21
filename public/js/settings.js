// ============================================================================
// settings.js · 系统设置（2026-11-20）
// ----------------------------------------------------------------------------
// 页面：基础资料 → 系统设置
// 功能：
//   1. 物流映射设置：表格编码 ↔ 快递公司，导入时自动转换，支持增删改查
//   2. 偏远地区设置：按快递公司配置大偏远 / 小偏远 / 正常区域，省市区三级联动多选
// 权限：页面读由菜单权限控制；写操作后端 roleGate 二次校验（管理员/超级管理员）
// 生效：保存即生效（后端每次导入实时读取，并重算该公司历史订单分类）
// ============================================================================
(function () {
  const API = window.API;
  const CARD_CSS = 'background:#fff;border-radius:8px;padding:18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06);';
  const BTN_PRIMARY = 'background:#409eff;color:#fff;border:none;border-radius:4px;padding:8px 20px;font-size:14px;cursor:pointer;';
  const BTN_GHOST = 'background:#fff;color:#409eff;border:1px solid #409eff;border-radius:4px;padding:7px 16px;font-size:14px;cursor:pointer;';
  const BTN_DANGER = 'background:#fff;color:#f56c6c;border:1px solid #f56c6c;border-radius:4px;padding:5px 12px;font-size:13px;cursor:pointer;';
  const BTN_PLAIN = 'background:#fff;color:#606266;border:1px solid #dcdfe6;border-radius:4px;padding:6px 14px;font-size:13px;cursor:pointer;';
  const CLASS_META = {
    '大偏远': { color: '#f56c6c', bg: '#fef0f0', border: '#fbc4c4', desc: '优先级最高，命中即为大偏远' },
    '小偏远': { color: '#e6a23c', bg: '#fdf6ec', border: '#f5dab1', desc: '未命中大偏远时判定' },
    '正常': { color: '#67c23a', bg: '#f0f9eb', border: '#c2e7b0', desc: '未填写时，除大/小偏远外均视为正常' },
  };

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
  function areaKey(a) {
    return `${a.province || ''}|${a.city || ''}|${a.district || ''}`;
  }
  function areaLabel(a) {
    if (!a.province) return '';
    const parts = [a.province, a.city, a.district].filter(Boolean);
    if (!a.city) return a.province + '（全省）';
    if (!a.district) return parts.join(' / ') + '（全市）';
    return parts.join(' / ');
  }

  // --------------------------------------------------------------------------
  // 物流映射设置弹窗
  // --------------------------------------------------------------------------
  function openExpressMapModal() {
    const old = document.getElementById('__expressMapModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = '__expressMapModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:760px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.2);">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #ebeef5;">
          <div>
            <div style="font-size:16px;font-weight:700;color:#303133;">🚚 物流映射设置</div>
            <div style="font-size:12px;color:#909399;margin-top:4px;">导入物流数据时，按「表格编码」自动转换为「快递公司」，保存后立即生效</div>
          </div>
          <button id="emClose" style="background:none;border:none;font-size:22px;color:#909399;cursor:pointer;line-height:1;">×</button>
        </div>
        <div style="padding:16px 20px;overflow:auto;flex:1;">
          <div id="emAlert"></div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
            <input id="emSearch" placeholder="搜索表格编码 / 快递公司" style="flex:1;padding:7px 10px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;box-sizing:border-box;">
            <span id="emCount" style="font-size:12px;color:#909399;white-space:nowrap;"></span>
          </div>
          <div style="overflow:auto;border:1px solid #ebeef5;border-radius:6px;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead><tr style="background:#f5f7fa;">
                <th style="padding:8px 10px;border:1px solid #ebeef5;width:44%;text-align:left;">表格编码</th>
                <th style="padding:8px 10px;border:1px solid #ebeef5;text-align:left;">快递公司</th>
                <th style="padding:8px 10px;border:1px solid #ebeef5;width:132px;">操作</th>
              </tr></thead>
              <tbody id="emRows"></tbody>
            </table>
          </div>
          <div style="margin-top:14px;padding:12px;background:#f7f9fc;border-radius:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#606266;">
              表格编码
              <input id="emNewCode" placeholder="如 JTSD" maxlength="20" style="padding:6px 10px;border:1px solid #dcdfe6;border-radius:4px;width:160px;font-size:13px;text-transform:uppercase;">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#606266;">
              快递公司
              <input id="emNewName" placeholder="如 极兔速递" maxlength="40" style="padding:6px 10px;border:1px solid #dcdfe6;border-radius:4px;width:200px;font-size:13px;">
            </label>
            <button id="emAdd" style="${BTN_PRIMARY};padding:7px 16px;">+ 新增</button>
            <span style="flex:1;"></span>
            <button id="emReset" style="${BTN_GHOST};padding:6px 14px;font-size:13px;">恢复默认映射</button>
          </div>
          <div style="margin-top:10px;font-size:12px;color:#909399;">
            提示：表格编码不区分大小写（STO/sto 等价），且不可重复；导入时按「编码 → 快递公司」转换，未配置的编码原样保留。
          </div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #ebeef5;display:flex;justify-content:flex-end;">
          <button id="emDone" style="${BTN_GHOST}">完成</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const rowsEl = overlay.querySelector('#emRows');
    const alertEl = overlay.querySelector('#emAlert');
    const searchEl = overlay.querySelector('#emSearch');
    const countEl = overlay.querySelector('#emCount');
    const writable = canWrite();
    let allItems = [];

    function showAlert(msg, type) {
      const color = type === 'error' ? '#f56c6c' : '#67c23a';
      const bg = type === 'error' ? '#fef0f0' : '#f0f9eb';
      alertEl.innerHTML = `<div style="margin-bottom:12px;padding:8px 12px;background:${bg};color:${color};border-radius:4px;font-size:13px;">${esc(msg)}</div>`;
      setTimeout(() => { alertEl.innerHTML = ''; }, 4000);
    }

    function renderRows(items) {
      allItems = items || [];
      const kw = searchEl.value.trim().toLowerCase();
      const list = kw
        ? allItems.filter((it) => String(it.code).toLowerCase().includes(kw) || String(it.name).toLowerCase().includes(kw))
        : allItems;
      countEl.textContent = kw ? `匹配 ${list.length} / ${allItems.length} 条` : `共 ${allItems.length} 条`;

      if (!list.length) {
        rowsEl.innerHTML = `<tr><td colspan="3" style="padding:24px;text-align:center;color:#909399;">${kw ? '没有匹配的映射' : '暂无映射，请新增'}</td></tr>`;
        return;
      }
      rowsEl.innerHTML = list.map((it) => `
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
            ${writable ? `<button class="em-save" style="${BTN_PRIMARY};padding:5px 12px;font-size:13px;">保存</button>
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

    searchEl.oninput = () => renderRows(allItems);

    overlay.querySelector('#emAdd').onclick = () => {
      if (!writable) return toast('当前角色无配置权限', 'error');
      const code = overlay.querySelector('#emNewCode').value.trim();
      const name = overlay.querySelector('#emNewName').value.trim();
      if (!code || !name) return showAlert('表格编码和快递公司都要填写', 'error');
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
  // 偏远地区设置 · 区域选择弹窗（省 → 市 → 区 三级联动，区县多选）
  // --------------------------------------------------------------------------
  let REGION_TREE_CACHE = null;
  function loadRegionTree() {
    if (REGION_TREE_CACHE) return Promise.resolve(REGION_TREE_CACHE);
    return API.get('/settings/region-tree').then((r) => {
      REGION_TREE_CACHE = r.provinces || [];
      return REGION_TREE_CACHE;
    });
  }

  function openAreaPicker({ tree, cls, onAdd }) {
    const old = document.getElementById('__areaPicker');
    if (old) old.remove();

    const meta = CLASS_META[cls];
    const overlay = document.createElement('div');
    overlay.id = '__areaPicker';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.2);">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #ebeef5;">
          <div style="font-size:15px;font-weight:700;color:${meta.color};">添加「${cls}」区域</div>
          <button id="apClose" style="background:none;border:none;font-size:22px;color:#909399;cursor:pointer;line-height:1;">×</button>
        </div>
        <div style="padding:16px 18px;overflow:auto;flex:1;">
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <label style="flex:1;min-width:150px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:#606266;">
              省 / 直辖市
              <select id="apProvince" style="padding:7px 8px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;">
                <option value="">请选择省份</option>
                ${tree.map((p) => `<option value="${esc(p.province)}">${esc(p.province)}</option>`).join('')}
              </select>
            </label>
            <label style="flex:1;min-width:150px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:#606266;">
              市
              <select id="apCity" disabled style="padding:7px 8px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;">
                <option value="">请先选择省份</option>
              </select>
            </label>
          </div>
          <div id="apDistrictWrap" style="margin-top:14px;display:none;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
              <span style="font-size:12px;color:#606266;">区 / 县（可多选）</span>
              <span>
                <button id="apAll" style="${BTN_PLAIN};padding:2px 8px;">全选</button>
                <button id="apNone" style="${BTN_PLAIN};padding:2px 8px;margin-left:4px;">清空</button>
              </span>
            </div>
            <div id="apDistricts" style="max-height:240px;overflow:auto;border:1px solid #ebeef5;border-radius:6px;padding:8px 10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;"></div>
            <div id="apNoDistrict" style="display:none;font-size:12px;color:#909399;padding:8px 2px;">该市暂无可选区县数据，可直接按「全市」添加。</div>
          </div>
          <div style="margin-top:14px;font-size:12px;color:#909399;line-height:1.7;">
            可添加全省、全市或勾选多个区县。添加多个区域时逐个操作即可。
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid #ebeef5;display:flex;justify-content:flex-end;gap:8px;">
          <button id="apCancel" style="${BTN_PLAIN}">取消</button>
          <button id="apAdd" style="${BTN_PRIMARY}">添加</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const provSel = overlay.querySelector('#apProvince');
    const citySel = overlay.querySelector('#apCity');
    const distWrap = overlay.querySelector('#apDistrictWrap');
    const distBox = overlay.querySelector('#apDistricts');
    const noDist = overlay.querySelector('#apNoDistrict');
    let currentCities = [];

    function renderDistricts(city) {
      const item = currentCities.find((c) => c.city === city);
      const list = item ? item.districts : [];
      if (!city || !list.length) {
        distBox.innerHTML = '';
        distWrap.style.display = city ? 'block' : 'none';
        noDist.style.display = city ? 'block' : 'none';
        return;
      }
      noDist.style.display = 'none';
      distWrap.style.display = 'block';
      distBox.innerHTML = list.map((d) => `
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#303133;cursor:pointer;">
          <input type="checkbox" class="ap-dist" value="${esc(d)}"> ${esc(d)}
        </label>`).join('');
    }

    provSel.onchange = () => {
      const p = provSel.value;
      const node = tree.find((x) => x.province === p);
      currentCities = (node && node.cities) || [];
      citySel.innerHTML = '<option value="">全部市（按全省添加）</option>' +
        currentCities.map((c) => `<option value="${esc(c.city)}">${esc(c.city)}</option>`).join('');
      citySel.disabled = !p;
      renderDistricts('');
    };
    citySel.onchange = () => renderDistricts(citySel.value);

    overlay.querySelector('#apAll').onclick = () => {
      distBox.querySelectorAll('.ap-dist').forEach((el) => { el.checked = true; });
    };
    overlay.querySelector('#apNone').onclick = () => {
      distBox.querySelectorAll('.ap-dist').forEach((el) => { el.checked = false; });
    };

    const close = () => overlay.remove();
    overlay.querySelector('#apClose').onclick = close;
    overlay.querySelector('#apCancel').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    overlay.querySelector('#apAdd').onclick = () => {
      const province = provSel.value;
      if (!province) return toast('请先选择省份', 'error');
      const city = citySel.value;
      if (!city) {
        onAdd([{ province, city: '', district: '' }]);
        return close();
      }
      const checked = Array.from(distBox.querySelectorAll('.ap-dist:checked')).map((el) => el.value);
      if (!checked.length) {
        onAdd([{ province, city, district: '' }]);
        return close();
      }
      onAdd(checked.map((d) => ({ province, city, district: d })));
      close();
    };
  }

  // --------------------------------------------------------------------------
  // 偏远地区设置弹窗
  // --------------------------------------------------------------------------
  function openRegionRulesModal() {
    const old = document.getElementById('__regionRulesModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = '__regionRulesModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:860px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.2);">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #ebeef5;">
          <div>
            <div style="font-size:16px;font-weight:700;color:#303133;">🗺️ 偏远地区设置</div>
            <div style="font-size:12px;color:#909399;margin-top:4px;">按快递公司维护大偏远 / 小偏远 / 正常区域，保存后立即生效</div>
          </div>
          <button id="rrClose" style="background:none;border:none;font-size:22px;color:#909399;cursor:pointer;line-height:1;">×</button>
        </div>
        <div style="padding:14px 20px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <label style="font-size:13px;color:#606266;">快递公司</label>
          <select id="rrCarrier" style="padding:7px 10px;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;min-width:200px;"></select>
          <span id="rrStatus" style="font-size:12px;color:#909399;"></span>
          <span style="flex:1;"></span>
          <button id="rrClear" style="${BTN_DANGER};padding:6px 12px;">清空该公司配置</button>
        </div>
        <div style="padding:12px 20px;overflow:auto;flex:1;">
          <div id="rrAlert"></div>
          <div id="rrGroups"></div>
          <div style="margin-top:10px;padding:10px 12px;background:#f7f9fc;border-radius:6px;font-size:12px;color:#606266;line-height:1.8;">
            判定规则：① 大偏远优先，其次小偏远；② 正常区域未配置时，未被划入大偏远/小偏远的地区自动判定为正常；
            ③ 正常区域已配置时，仅配置的正常区域判定为正常，其余为「其他」。
          </div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #ebeef5;display:flex;justify-content:flex-end;gap:8px;">
          <button id="rrDone" style="${BTN_GHOST}">关闭</button>
          <button id="rrSave" style="${BTN_PRIMARY}">保存配置</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const carrierSel = overlay.querySelector('#rrCarrier');
    const statusEl = overlay.querySelector('#rrStatus');
    const alertEl = overlay.querySelector('#rrAlert');
    const groupsEl = overlay.querySelector('#rrGroups');
    const writable = canWrite();
    const state = { carrier: '', groups: { '大偏远': [], '小偏远': [], '正常': [] }, tree: [] };

    overlay.querySelector('#rrSave').style.display = writable ? '' : 'none';
    overlay.querySelector('#rrClear').style.display = writable ? '' : 'none';

    function showAlert(msg, type) {
      const color = type === 'error' ? '#f56c6c' : '#67c23a';
      const bg = type === 'error' ? '#fef0f0' : '#f0f9eb';
      alertEl.innerHTML = `<div style="margin-bottom:12px;padding:8px 12px;background:${bg};color:${color};border-radius:4px;font-size:13px;">${esc(msg)}</div>`;
      setTimeout(() => { alertEl.innerHTML = ''; }, 5000);
    }

    function renderGroups() {
      groupsEl.innerHTML = ['大偏远', '小偏远', '正常'].map((cls) => {
        const meta = CLASS_META[cls];
        const list = state.groups[cls] || [];
        const chips = list.length
          ? list.map((a, i) => `
            <span style="display:inline-flex;align-items:center;gap:4px;margin:3px 6px 3px 0;padding:4px 8px;background:${meta.bg};color:${meta.color};border:1px solid ${meta.border};border-radius:4px;font-size:12px;">
              ${esc(areaLabel(a))}
              ${writable ? `<span class="rr-del" data-cls="${cls}" data-idx="${i}" style="cursor:pointer;font-weight:700;padding:0 2px;">×</span>` : ''}
            </span>`).join('')
          : '<span style="color:#c0c4cc;font-size:12px;">未配置</span>';
        return `
          <div style="border:1px solid #ebeef5;border-radius:8px;padding:12px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span style="font-size:13px;font-weight:700;color:${meta.color};">${cls}</span>
              <span style="font-size:12px;color:#909399;">${meta.desc}（已配置 ${list.length} 个区域）</span>
              <span style="flex:1;"></span>
              ${writable ? `<button class="rr-add" data-cls="${cls}" style="${BTN_GHOST};padding:4px 12px;font-size:12px;">+ 添加区域</button>` : ''}
            </div>
            <div style="min-height:26px;">${chips}</div>
          </div>`;
      }).join('');

      if (!writable) return;
      groupsEl.querySelectorAll('.rr-add').forEach((btn) => {
        btn.onclick = () => {
          openAreaPicker({
            tree: state.tree,
            cls: btn.dataset.cls,
            onAdd: (areas) => addAreas(btn.dataset.cls, areas),
          });
        };
      });
      groupsEl.querySelectorAll('.rr-del').forEach((el) => {
        el.onclick = () => {
          const cls = el.dataset.cls;
          const idx = Number(el.dataset.idx);
          state.groups[cls].splice(idx, 1);
          renderGroups();
        };
      });
    }

    function addAreas(cls, areas) {
      let added = 0;
      let skipped = 0;
      for (const a of areas) {
        const key = areaKey(a);
        const dupCls = ['大偏远', '小偏远', '正常'].find(
          (c) => c !== cls && state.groups[c].some((x) => areaKey(x) === key)
        );
        if (dupCls) {
          skipped++;
          showAlert(`「${areaLabel(a)}」已在「${dupCls}」中，请先移除后再添加`, 'error');
          continue;
        }
        if (state.groups[cls].some((x) => areaKey(x) === key)) { skipped++; continue; }
        state.groups[cls].push(a);
        added++;
      }
      if (added) renderGroups();
      if (!added && skipped) return;
      if (added) toast(`已添加 ${added} 个区域，保存后生效`, 'success');
    }

    function setCarrier(carrier, data) {
      state.carrier = carrier;
      state.groups = (data && data.groups) || { '大偏远': [], '小偏远': [], '正常': [] };
      statusEl.textContent = data && data.hasConfig
        ? `已配置 ${data.count} 个区域（保存后将重算该公司历史订单）`
        : '尚未配置（该公司订单按系统内置规则判定）';
      renderGroups();
    }

    function loadRules(carrier) {
      if (!carrier) return;
      groupsEl.innerHTML = '<div style="padding:24px;text-align:center;color:#909399;">⏳ 加载中...</div>';
      API.get('/settings/region-rules/' + encodeURIComponent(carrier))
        .then((r) => setCarrier(carrier, r))
        .catch((e) => {
          groupsEl.innerHTML = `<div style="padding:24px;text-align:center;color:#f56c6c;">加载失败：${esc(e.message)}</div>`;
        });
    }

    function load() {
      statusEl.textContent = '⏳ 加载数据...';
      Promise.all([
        API.get('/settings/region-rules/carriers'),
        loadRegionTree(),
      ]).then(([r]) => {
        state.tree = REGION_TREE_CACHE || [];
        const list = r.carriers || [];
        if (!list.length) {
          carrierSel.innerHTML = '<option value="">暂无快递公司，请先在物流映射设置中维护</option>';
          groupsEl.innerHTML = '<div style="padding:24px;text-align:center;color:#909399;">请先在「物流映射设置」中维护快递公司</div>';
          statusEl.textContent = '';
          return;
        }
        carrierSel.innerHTML = list.map((c) => {
          const mark = c.hasConfig ? `（已配置 ${c.count}）` : '（未配置）';
          return `<option value="${esc(c.carrier)}">${esc(c.carrier)}${mark}</option>`;
        }).join('');
        // 默认优先选中已配置的公司
        const first = list.find((c) => c.hasConfig) || list[0];
        carrierSel.value = first.carrier;
        loadRules(first.carrier);
      }).catch((e) => {
        statusEl.textContent = '';
        groupsEl.innerHTML = `<div style="padding:24px;text-align:center;color:#f56c6c;">加载失败：${esc(e.message)}</div>`;
      });
    }

    carrierSel.onchange = () => loadRules(carrierSel.value);

    overlay.querySelector('#rrSave').onclick = () => {
      const carrier = carrierSel.value;
      if (!carrier) return toast('请先选择快递公司', 'error');
      const btn = overlay.querySelector('#rrSave');
      btn.disabled = true;
      API.put('/settings/region-rules/' + encodeURIComponent(carrier), state.groups)
        .then((r) => {
          setCarrier(carrier, r);
          const recalc = r.recalced ? `，已重算 ${r.recalced} 条历史订单` : '';
          showAlert(`已保存「${carrier}」的区域配置${recalc}，立即生效`, 'ok');
          // 更新下拉文案
          const opt = Array.from(carrierSel.options).find((o) => o.value === carrier);
          if (opt) opt.textContent = `${carrier}（已配置 ${r.count}）`;
        })
        .catch((e) => showAlert(e.message, 'error'))
        .finally(() => { btn.disabled = false; });
    };

    overlay.querySelector('#rrClear').onclick = () => {
      const carrier = carrierSel.value;
      if (!carrier) return;
      if (!confirm(`确认清空「${carrier}」的全部区域配置？清空后该公司订单回退系统内置规则。`)) return;
      API.del('/settings/region-rules/' + encodeURIComponent(carrier))
        .then((r) => {
          setCarrier(carrier, r);
          showAlert(`已清空「${carrier}」的区域配置${r.recalced ? `，重算 ${r.recalced} 条历史订单` : ''}`, 'ok');
          const opt = Array.from(carrierSel.options).find((o) => o.value === carrier);
          if (opt) opt.textContent = `${carrier}（未配置）`;
        })
        .catch((e) => showAlert(e.message, 'error'));
    };

    const close = () => overlay.remove();
    overlay.querySelector('#rrClose').onclick = close;
    overlay.querySelector('#rrDone').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay._esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', overlay._esc); } };
    document.addEventListener('keydown', overlay._esc);

    renderGroups();
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
            <div style="font-size:14px;font-weight:600;color:#303133;">🚚 物流映射设置</div>
            <div style="font-size:13px;color:#909399;margin-top:6px;line-height:1.6;">
              维护「表格编码」与「快递公司」的对应关系（如 STO → 申通快递）。<br>
              导入物流数据时自动转换，并以快递公司名称保存与统计。
            </div>
          </div>
          <button id="openExpressMap" style="${BTN_PRIMARY}">配置</button>
        </div>
      </div>

      <div style="${CARD_CSS}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">
          <div>
            <div style="font-size:14px;font-weight:600;color:#303133;">🗺️ 偏远地区设置</div>
            <div style="font-size:13px;color:#909399;margin-top:6px;line-height:1.6;">
              以快递公司为维度配置大偏远 / 小偏远 / 正常区域（省/市/区三级）。<br>
              导入时按规则判定地区分类，配置保存后立即生效。
            </div>
          </div>
          <button id="openRegionRules" style="${BTN_PRIMARY}">配置</button>
        </div>
      </div>
    `;
    host.appendChild(wrap);
    wrap.querySelector('#openExpressMap').onclick = openExpressMapModal;
    wrap.querySelector('#openRegionRules').onclick = openRegionRulesModal;
  };
})();
