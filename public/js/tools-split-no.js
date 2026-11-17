// ============================================================
//  快捷工具 → 分列单号
//  ------------------------------------------------------------
//  业务规则（对齐参考实现）：
//   1) 粘贴区每行一个单号；Excel 整列复制（制表符 / 空格 / 逗号 / 分号 / 顿号）自动拆开；
//   2) 单号「原样保留」——不做数字解析、不补零、不去掉前导零、不改变大小写；
//   3) 首尾引号（Excel 复制常见）剔除，避免"7701"被当成含引号的单号；
//   4) 空白行 / 纯分隔符忽略；无字母数字的疑似脏数据原样保留，但给出黄色预警计数；
//   5) 按「每批上限」顺序切批，批号 / 数量 / 序号区间三者严格对应同一批数据；
//   6) 末批不足上限时单独标注「末批 N 个」，不丢弃、不合并。
//  纯逻辑函数挂在 window.ERP_SPLIT_NO 上，供 scripts/test_split_no.js 直接单测。
// ============================================================
(function () {
  const PAGE = 'tool_split_no';
  const DEFAULT_SIZE = 500;
  const MAX_SIZE = 10000;

  // 分隔符：任意空白（含 \t \n \r 全角空格）+ 中英文逗号 / 分号 / 顿号
  const SEP_RE = /[\s,，、;；]+/;
  // Excel 整列复制时常见的包裹引号（中英文）
  const WRAP_QUOTE_RE = /^["'“”‘’]+|["'“”‘’]+$/g;

  // ---------- 纯逻辑（无 DOM 依赖，可单测） ----------

  /** 去掉 Excel 包裹引号与首尾空白；不改变数字形态（保留前导零） */
  function normalizeToken(raw) {
    return String(raw == null ? '' : raw).replace(WRAP_QUOTE_RE, '').trim();
  }

  /** 文本 → 单号数组：按分隔符拆开、规范化、丢弃空串，顺序保持不变 */
  function parseTokens(text) {
    if (text == null) return [];
    const s = String(text);
    if (!s.trim()) return [];
    return s.split(SEP_RE).map(normalizeToken).filter(Boolean);
  }

  /** 去重（保留首次出现顺序）；返回新数组，不修改入参 */
  function dedupeKeepOrder(list) {
    const seen = new Set();
    const out = [];
    for (const x of list || []) {
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
    return out;
  }

  /** 每批上限归一化：非法 / 空 / <1 → 回退默认；超出上限 → 截断到 MAX_SIZE */
  function normalizeBatchSize(value, fallback) {
    const def = fallback == null ? DEFAULT_SIZE : fallback;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, MAX_SIZE);
  }

  /**
   * 顺序切批
   * @returns [{ index, from, to, count, items }]，index 从 1 开始；
   *          from / to 为该批在原列表中的 1 基序号，与 count 严格自洽（to - from + 1 === count）
   */
  function buildBatches(list, size) {
    const arr = Array.isArray(list) ? list : [];
    const per = normalizeBatchSize(size, DEFAULT_SIZE);
    const batches = [];
    for (let i = 0; i < arr.length; i += per) {
      const items = arr.slice(i, i + per);
      batches.push({
        index: batches.length + 1,
        from: i + 1,
        to: i + items.length,
        count: items.length,
        items,
      });
    }
    return batches;
  }

  /** 疑似非单号：不含任何字母或数字（纯符号 / 乱码），仅用于预警，不参与过滤 */
  function isSuspiciousToken(token) {
    return !/[0-9A-Za-z\u4e00-\u9fa5]/.test(String(token || ''));
  }

  /** 统计疑似异常条数 */
  function countSuspicious(list) {
    return (list || []).reduce((n, t) => n + (isSuspiciousToken(t) ? 1 : 0), 0);
  }

  window.ERP_SPLIT_NO = {
    DEFAULT_SIZE,
    MAX_SIZE,
    normalizeToken,
    parseTokens,
    dedupeKeepOrder,
    normalizeBatchSize,
    buildBatches,
    isSuspiciousToken,
    countSuspicious,
  };

  // ---------- 页面 ----------
  function createPage() {
    const state = {
      tokens: [],      // 当前有效单号（去重后 / 原始粘贴结果）
      size: DEFAULT_SIZE,
      batches: [],
    };
    let host = null;
    const $ = (id) => host && host.querySelector('#' + id);

    function toast(msg) {
      if (window.ERP && typeof window.ERP.toast === 'function') window.ERP.toast(msg);
      else alert(msg);
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }

    /** 复制到剪贴板：优先异步 Clipboard API，非 HTTPS / 无权限时降级 execCommand */
    async function copyText(text) {
      if (!text) { toast('没有可复制的内容'); return false; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* 走降级 */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }

    /** 读取剪贴板（受浏览器权限限制，失败时提示手动粘贴） */
    async function readClipboard() {
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          throw new Error('浏览器不支持读取剪贴板');
        }
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) { toast('剪贴板里没有文本'); return; }
        const input = $('snInput');
        input.value = text;
        onChange();
        toast('已读取 ' + state.tokens.length + ' 个单号');
      } catch (e) {
        toast('浏览器拦截了剪贴板读取，请在输入框手动 Ctrl+V 粘贴');
      }
    }

    /** 输入变化 → 重算 → 重绘（唯一数据入口，避免多处状态不一致） */
    function onChange() {
      state.tokens = parseTokens($('snInput').value);
      recalc();
      render();
    }

    function recalc() {
      state.size = normalizeBatchSize($('snSize').value, DEFAULT_SIZE);
      state.batches = buildBatches(state.tokens, state.size);
    }

    // ---------- 渲染 ----------
    function render() {
      const total = state.tokens.length;
      const batchCount = state.batches.length;
      // 末批提示只在「存在满批 + 末批不满」时有意义；总数不足一批时不显示，避免噪音
      const remainder = total > 0 && total % state.size !== 0 && batchCount > 1 ? total % state.size : 0;
      const suspicious = countSuspicious(state.tokens);

      $('snTotal').textContent = total;
      $('snBatchCount').textContent = batchCount;

      const remEl = $('snRemainder');
      remEl.style.display = remainder ? '' : 'none';
      remEl.textContent = remainder ? '（末批 ' + remainder + ' 个）' : '';

      const susEl = $('snSuspicious');
      susEl.style.display = suspicious ? '' : 'none';
      susEl.textContent = suspicious ? '其中 ' + suspicious + ' 个疑似非单号（无字母/数字），已原样保留' : '';

      $('snListTotal').textContent = batchCount ? '共 ' + batchCount + ' 批' : '';

      const box = $('snBatches');
      box.innerHTML = '';
      if (!batchCount) {
        const empty = document.createElement('div');
        empty.className = 'sn-empty';
        empty.textContent = '粘贴单号后自动分批';
        box.appendChild(empty);
        return;
      }
      state.batches.forEach((b) => {
        const card = document.createElement('div');
        card.className = 'sn-batch' + (b.count < state.size ? ' sn-batch-partial' : '');
        card.dataset.i = String(b.index - 1);
        card.innerHTML =
          '<div class="sn-batch-title">第 ' + b.index + ' 批' +
            '<span class="sn-batch-count">' + b.count + ' 个</span></div>' +
          '<div class="sn-batch-range">第 ' + b.from + '-' + b.to + ' 个</div>';
        card.addEventListener('click', async () => {
          const batch = state.batches[Number(card.dataset.i)];
          if (!batch) return;
          const ok = await copyText(batch.items.join('\n'));
          if (ok) {
            card.classList.add('sn-batch-copied');
            setTimeout(() => card.classList.remove('sn-batch-copied'), 800);
            toast('已复制第 ' + batch.index + ' 批（' + batch.count + ' 个）');
          } else {
            toast('复制失败，请检查浏览器剪贴板权限');
          }
        });
        box.appendChild(card);
      });
    }

    // ---------- 事件绑定 ----------
    function bind() {
      $('snInput').addEventListener('input', onChange);
      $('snSize').addEventListener('input', () => { recalc(); render(); });
      $('snSize').addEventListener('blur', () => {
        // 失焦时把归一化后的值回写到输入框，避免 0 / 空 / 超大值造成展示歧义
        const v = normalizeBatchSize($('snSize').value, DEFAULT_SIZE);
        $('snSize').value = String(v);
        recalc(); render();
      });

      $('snReadClip').addEventListener('click', readClipboard);

      $('snDedupe').addEventListener('click', () => {
        const before = state.tokens.length;
        const deduped = dedupeKeepOrder(state.tokens);
        const removed = before - deduped.length;
        if (!removed) { toast('没有重复单号'); return; }
        state.tokens = deduped;
        $('snInput').value = deduped.join('\n');
        recalc(); render();
        toast('已去重 ' + removed + ' 个，剩余 ' + deduped.length + ' 个');
      });

      $('snClear').addEventListener('click', () => {
        $('snInput').value = '';
        onChange();
        $('snInput').focus();
      });

      $('snCopyAll').addEventListener('click', async () => {
        if (!state.tokens.length) { toast('还没有单号可复制'); return; }
        const ok = await copyText(state.tokens.join('\n'));
        toast(ok
          ? '已复制全部 ' + state.tokens.length + ' 个单号'
          : '复制失败，请检查浏览器剪贴板权限');
      });
    }

    return function mount(pageHost) {
      host = pageHost;
      host.innerHTML = `
        <div class="sn-wrap">
          <div class="sn-head">
            <div class="sn-title">粘贴单号
              <span class="sn-hint">每行一个；Excel 整列复制也行（制表符 / 空格 / 逗号自动拆开）。原样保留，不补零。</span>
            </div>
            <div class="sn-head-ops">
              <button type="button" class="ghost" id="snReadClip">读剪贴板</button>
              <button type="button" class="ghost" id="snDedupe">去重</button>
              <button type="button" class="ghost" id="snClear">清空</button>
            </div>
          </div>

          <textarea id="snInput" class="sn-input" spellcheck="false"
            placeholder="在此粘贴单号，每行一个；也支持 Excel 整列粘贴"></textarea>

          <div class="sn-stats">
            <div class="sn-stats-left">
              已识别 <b id="snTotal">0</b> 个单号 · 分为 <b id="snBatchCount">0</b> 批
              <span id="snRemainder" class="sn-remainder" style="display:none"></span>
              <span id="snSuspicious" class="sn-suspicious" style="display:none"></span>
            </div>
            <div class="sn-stats-right">
              <label class="sn-size-label">每批上限
                <input id="snSize" type="number" min="1" max="10000" step="1" value="${DEFAULT_SIZE}">
              </label>
              <button type="button" class="primary" id="snCopyAll">复制全部</button>
            </div>
          </div>

          <div class="sn-list-head">
            <span>分批复制 <span class="sn-hint">点一下即复制该批</span></span>
            <span id="snListTotal" class="sn-hint"></span>
          </div>
          <div id="snBatches" class="sn-batches"></div>
        </div>`;

      bind();
      onChange();
      host.querySelector('#snInput').focus();
    };
  }

  window.ERP_PAGES = window.ERP_PAGES || {};
  window.ERP_PAGES[PAGE] = createPage();
})();
