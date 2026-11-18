// ============================================================================
//  数据迁移页面（仅超级管理员可见）
//  ----------------------------------------------------------------------------
//  当前功能：customers.sort_order 手动刷新（带快照回滚 + 审计日志 + 进度报告）
//  路由：#/data_migration → ERP_PAGES.data_migration(host)
//  后端：/api/admin/migrate-sort/*（roleGate('super_admin') 全链拦截）
// ============================================================================
const PAGE = 'data_migration';
window.ERP_PAGES = window.ERP_PAGES || {};

// ---------- 小工具 ----------
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function escape(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---------- 二次确认弹窗（Promise 风格，Promise<boolean>） ----------
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
          <button type="button" class="dm-cancel">${escape(cancelText)}</button>
          <button type="button" class="primary dm-ok" style="${danger ? 'background:#e74c3c;border-color:#e74c3c' : ''}">${escape(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(!!val); };
    overlay.querySelector('.close').onclick = () => done(false);
    overlay.querySelector('.dm-cancel').onclick = () => done(false);
    overlay.querySelector('.dm-ok').onclick = () => done(true);
    overlay.onclick = (ev) => { if (ev.target === overlay) done(false); };
  });
}

// ---------- 主页面 ----------
function createPage(host) {
  host.innerHTML = '';
  host.style.padding = '20px';
  host.style.background = '#fff';

  const container = el('div', 'dm-container');

  // 头部
  container.appendChild(el('h2', '', '⚙️ 数据迁移工具'));
  const sub = el('div', '', '客户排序号（customers.sort_order）手动刷新 · 仅限超级管理员');
  sub.style.cssText = 'color:#909399;font-size:13px;margin-bottom:20px';
  container.appendChild(sub);

  // 状态面板
  const statusPanel = el('div', 'dm-panel');
  statusPanel.style.cssText = 'border:1px solid #dcdfe6;border-radius:6px;padding:16px;margin-bottom:16px;background:#fafbfc';
  container.appendChild(statusPanel);

  // 操作按钮行
  const actions = el('div', 'dm-actions');
  actions.style.cssText = 'display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap';
  const btnRefresh = el('button', 'primary', '🔄 执行排序刷新');
  const btnRollback = el('button', '', '↩️ 从快照回滚');
  btnRollback.style.cssText = 'background:#fff;border:1px solid #e6a23c;color:#e6a23c';
  const btnClear = el('button', '', '🗑️ 清除快照');
  btnClear.style.cssText = 'background:#fff;border:1px solid #909399;color:#909399';
  const btnRefresh2 = el('button', '', '🔄 刷新状态');
  btnRefresh2.style.cssText = 'background:#fff;border:1px solid #dcdfe6;color:#606266';
  btnRefresh.onclick = runMigration;
  btnRollback.onclick = runRollback;
  btnClear.onclick = clearSnapshot;
  btnRefresh2.onclick = loadStatus;
  actions.appendChild(btnRefresh);
  actions.appendChild(btnRollback);
  actions.appendChild(btnClear);
  actions.appendChild(btnRefresh2);
  container.appendChild(actions);

  // 进度条 + 日志输出区
  const logArea = el('div', 'dm-log');
  logArea.style.cssText = 'border:1px solid #dcdfe6;border-radius:6px;background:#1e1e1e;color:#d4d4d4;padding:12px;font-family:Consolas,"Courier New",monospace;font-size:13px;min-height:200px;max-height:400px;overflow:auto;margin-bottom:16px;white-space:pre-wrap';
  container.appendChild(logArea);

  // 结果报告区
  const reportArea = el('div', 'dm-report');
  reportArea.style.cssText = 'border:1px solid #dcdfe6;border-radius:6px;padding:16px;background:#fff';
  container.appendChild(reportArea);

  host.appendChild(container);

  // ---------- 子函数 ----------

  function log(msg, type) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const color = type === 'ok' ? '#6a9955' : type === 'warn' ? '#dcdcaa' : type === 'err' ? '#f48771' : '#d4d4d4';
    const line = el('div', '');
    line.style.cssText = `color:${color};line-height:1.7`;
    line.textContent = `[${ts}] ${msg}`;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
  }

  function setBusy(busy) {
    [btnRefresh, btnRollback, btnClear].forEach((b) => (b.disabled = busy));
  }

  async function loadStatus() {
    logArea.innerHTML = '';
    reportArea.innerHTML = '';
    btnRollback.style.display = 'none';
    btnClear.style.display = 'none';
    log('查询当前排序迁移状态…');
    try {
      const s = await API.get('/admin/migrate-sort/status');
      renderStatus(s);
      renderReport(null, s);
      log('状态查询完成。', 'ok');
    } catch (e) {
      log('状态查询失败：' + e.message, 'err');
      statusPanel.innerHTML = `<div style="color:#c23a1b">加载失败：${escape(e.message)}</div>`;
    }
  }

  function renderStatus(s) {
    const rows = [
      ['指纹标记（启动自动迁移）', s.fingerprintExists ? '✅ 已标记（启动时自动跳过）' : '❌ 未标记（首次启动将自动执行）'],
      ['客户总行数', s.totalCustomers],
      ['排序名单条数', s.sortListSize],
      ['名单中预期命中行数', s.expectedMatchedOnRun],
      ['当前已分配 sort_order 行数', s.alreadyMatched],
      ['未匹配名单条数', s.unmatched.length],
      ['快照行数（可回滚）', s.snapshotRows ? s.snapshotRows + ' 行' : '—'],
    ];
    statusPanel.innerHTML = rows
      .map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed #ebeef5"><span style="color:#909399">${k}</span><span style="font-weight:500;color:#303133">${v}</span></div>`)
      .join('');

    // 快照有内容时显示回滚按钮
    if (s.snapshotRows > 0) {
      btnRollback.style.display = '';
      btnClear.style.display = '';
    }
  }

  function renderReport(report, s) {
    reportArea.innerHTML = '';
    const h = el('h3', '', '📋 迁移结果报告');
    h.style.cssText = 'margin:0 0 12px;font-size:15px;color:#303133';
    reportArea.appendChild(h);

    if (report) {
      // 迁移后实时读取状态
      renderStatus(s);
      const rows = [
        ['迁移成功匹配', `<span style="color:#6a9955;font-weight:600">${report.matched} 行</span>`],
        ['名单未匹配', `<span style="color:#dcdcaa;font-weight:600">${report.unmatched.length} 条</span>`],
        ['快照保存', report.snapshotRows + ' 行'],
      ];
      const summary = el('div', '');
      summary.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px';
      rows.forEach(([k, v]) => {
        const card = el('div', '');
        card.style.cssText = 'border:1px solid #ebeef5;border-radius:6px;padding:12px;background:#fafbfc;text-align:center';
        card.innerHTML = `<div style="color:#909399;font-size:12px;margin-bottom:4px">${k}</div><div style="font-size:16px">${v}</div>`;
        summary.appendChild(card);
      });
      reportArea.appendChild(summary);

      if (report.unmatched.length) {
        const t = el('div', '', '⚠️ 以下名单未匹配到任何客户（将保持 sort_order=9999）：');
        t.style.cssText = 'color:#dcdcaa;font-size:13px;margin-bottom:8px';
        reportArea.appendChild(t);
        const list = el('ul', '');
        list.style.cssText = 'margin:0;padding-left:20px;font-size:13px';
        report.unmatched.forEach((n) => {
          const li = el('li', '', escape(n));
          li.style.cssText = 'color:#c23a1b;line-height:1.8';
          list.appendChild(li);
        });
        reportArea.appendChild(list);
      }
    } else if (s) {
      // 初始状态展示（未执行迁移）
      if (s.unmatched.length) {
        const t = el('div', '', '⚠️ 当前名单中以下客户在库内不存在：');
        t.style.cssText = 'color:#dcdcaa;font-size:13px;margin-bottom:8px';
        reportArea.appendChild(t);
        const list = el('ul', '');
        list.style.cssText = 'margin:0;padding-left:20px;font-size:13px';
        s.unmatched.forEach(({ seq, name }) => {
          const li = el('li', '', `#${seq} ${escape(name)}`);
          li.style.cssText = 'color:#c23a1b;line-height:1.8';
          list.appendChild(li);
        });
        reportArea.appendChild(list);
      } else {
        reportArea.appendChild(el('div', '', '✅ 名单中所有客户都能在库内找到，执行刷新将全部命中。').style.cssText = 'color:#6a9955;font-size:13px');
      }
    }
  }

  async function runMigration() {
    setBusy(true);
    try {
      const ok = await confirmDialog({
        title: '确认执行排序刷新？',
        message: '将按固定名单重新刷入 customers.sort_order 排序号。',
        warn: '本次操作会先保存当前排序号快照，失败或不满意可一键回滚。快照将保存到 _sort_order_snapshot 表。',
        okText: '立即执行',
        danger: true,
      });
      if (!ok) { log('用户取消了迁移。', 'warn'); return; }

      log('⏳ 开始执行排序刷新…', 'warn');
      log('① 保存当前排序号快照到 _sort_order_snapshot…');
      const r = await API.post('/admin/migrate-sort');

      if (r.ok) {
        log(`✅ 快照保存 ${r.snapshotRows} 行`, 'ok');
        log(`② 名单 ${r.report.sortListSize} 条，匹配 ${r.report.matched} 行`, 'ok');
        if (r.report.unmatched.length) log(`⚠️ 未匹配 ${r.report.unmatched.length} 条`, 'warn');
        log(`✅ ${r.message}`, 'ok');

        // 迁移后重新拉最新状态（包含新快照）
        const s = await API.get('/admin/migrate-sort/status');
        renderReport({ ...r.report, snapshotRows: r.snapshotRows }, s);
      } else {
        log('❌ 迁移失败：' + r.error, 'err');
        if (r.autoRollback) log('🔄 已自动回滚：' + JSON.stringify(r.autoRollback), 'warn');
      }
    } catch (e) {
      log('❌ 请求异常：' + e.message, 'err');
      if (e.status === 403) log('💡 这是权限不足（需要超级管理员角色）', 'err');
    } finally {
      setBusy(false);
      // 迁移后刷新按钮状态
      try {
        const s = await API.get('/admin/migrate-sort/status');
        renderStatus(s);
      } catch (_) { /* ignore */ }
    }
  }

  async function runRollback() {
    setBusy(true);
    try {
      const ok = await confirmDialog({
        title: '确认从快照回滚？',
        message: '将把所有 customers.sort_order 恢复到上次迁移前的状态。',
        warn: '回滚是不可逆的（快照恢复后会被覆盖）。操作前请确认当前快照是你想恢复的版本。',
        okText: '确认回滚',
        danger: true,
      });
      if (!ok) { log('用户取消了回滚。', 'warn'); return; }

      log('⏳ 开始回滚…', 'warn');
      const r = await API.post('/admin/migrate-sort/rollback');
      if (r.ok) {
        log(`✅ 已恢复 ${r.restoredRows} 行`, 'ok');
        log(`✅ ${r.message}`, 'ok');
        const s = await API.get('/admin/migrate-sort/status');
        renderStatus(s);
      } else {
        log('❌ 回滚失败：' + r.error, 'err');
      }
    } catch (e) {
      log('❌ 请求异常：' + e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function clearSnapshot() {
    setBusy(true);
    try {
      const ok = await confirmDialog({
        title: '确认清除快照？',
        message: '将删除 _sort_order_snapshot 快照表中所有数据。',
        warn: '清除后将无法回滚到本次迁移前的状态。请仅在迁移结果确认无误后操作。',
        okText: '清除快照',
        danger: false,
      });
      if (!ok) { log('用户取消了清除。', 'warn'); return; }

      log('⏳ 清除快照…', 'warn');
      const r = await API.del('/admin/migrate-sort/snapshot');
      if (r.ok) {
        log('✅ 快照已清除', 'ok');
        btnRollback.style.display = 'none';
        btnClear.style.display = 'none';
        const s = await API.get('/admin/migrate-sort/status');
        renderStatus(s);
      }
    } catch (e) {
      log('❌ 请求异常：' + e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  // 自动加载初始状态
  loadStatus();
}

ERP_PAGES[PAGE] = createPage;
