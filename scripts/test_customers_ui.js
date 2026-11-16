// 仓储客户前端结构断言：三页工厂独立 / 仓库 Tab 与列联动 / 18 字段表单 / 查询参数
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const fails = [];
function t(name, fn) {
  const ok = () => { pass++; console.log('PASS ' + name); };
  const bad = (e) => { fails.push({ name, msg: e.message }); console.log('FAIL ' + name + ' -> ' + e.message); };
  try {
    const r = fn();
    // 异步用例必须返回 Promise 并让调用方 await，否则会出现「假通过」
    if (r && typeof r.then === 'function') return r.then(ok, bad);
    ok();
  } catch (e) { bad(e); }
}

// ---------- 1. 菜单 / Tab 元信息静态断言 ----------
const menu = read('js/menu.js');
const tabs = read('js/tabs.js');
const css = read('css/style.css');
const customersSrc = read('js/customers.js');
const apiSrc = read('js/api.js');

t('左侧菜单含 3 个子菜单且路由正确', () => {
  assert.ok(menu.includes("{ label: '仓储客户', page: 'cust_wh' }"));
  assert.ok(menu.includes("{ label: '共享单号', page: 'cust_shared' }"));
  assert.ok(menu.includes("{ label: '快运物流', page: 'cust_express' }"));
});
t('旧「客户资料」单一菜单项已移除', () => {
  assert.ok(!menu.includes("{ label: '客户资料', page: 'customers' }"));
});
t('PAGE_META 含 3 个新页签 + customers 兼容别名', () => {
  ['cust_wh', 'cust_shared', 'cust_express', 'customers'].forEach((k) => {
    assert.ok(new RegExp('\\b' + k + ': \\{ title:').test(tabs), k + ' 缺失');
  });
});
t('看板仍置顶且为直达项（未被本次改动影响）', () => {
  assert.ok(menu.includes("direct: 'dashboard'"));
});
t('api.js 提供 FormData 上传与带 token 下载', () => {
  assert.ok(apiSrc.includes('async upload(u, formData)'));
  assert.ok(apiSrc.includes('async download(u, filename)'));
});
t('CSS 含多选、分区表单、失败清单样式', () => {
  ['.multi-select', '.form-section', '.import-result', '.fail-grid', '.modal.wide'].forEach((s) => {
    assert.ok(css.includes(s), s + ' 缺失');
  });
});
t('源码无旧字段名残留（customer_name / owner_name / safety_stock 作为客户表字段）', () => {
  assert.ok(!/f_name|f_owner|f_safety|f_settle|toggle_.*启用/.test(customersSrc));
});

// ---------- 2. 极简 DOM 桩 + 真实渲染三页 ----------
function fakeEl() {
  return {
    value: '', files: [], checked: false, style: {}, dataset: {}, className: '',
    innerHTML: '', textContent: '', onclick: null, onchange: null, onkeydown: null,
    addEventListener() {}, click() {}, remove() {}, appendChild() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    closest() { return null; },
  };
}
function makeHost() {
  return {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
  };
}
const calls = [];
const sandbox = {
  window: {},
  document: { createElement: () => fakeEl(), body: { appendChild() {} } },
  URLSearchParams, FormData, Array, String, Number, Object, Math, RegExp, console,
  API: {
    async get(u) { calls.push(u); return { data: sandbox.__rows || [], total: (sandbox.__rows || []).length }; },
    async post() { return {}; },
    async put() { return {}; },
    async upload() { return {}; },
    async download() {},
  },
  alert() {}, confirm() { return true; }, setTimeout, URL,
};
vm.createContext(sandbox);
vm.runInContext(customersSrc, sandbox, { filename: 'customers.js' });
const PAGES = sandbox.window.ERP_PAGES;

async function mount(page) {
  const host = makeHost();
  PAGES[page](host);
  await new Promise((r) => setImmediate(r));   // 等 load() 的异步 render
  return host._html;
}

(async function run() {
  await t('ERP_PAGES 注册 3 个新页 + customers 别名，且为互不相同的工厂实例', async () => {
    ['cust_wh', 'cust_shared', 'cust_express', 'customers'].forEach((k) => {
      assert.strictEqual(typeof PAGES[k], 'function', k + ' 未注册');
    });
    assert.notStrictEqual(PAGES.cust_wh, PAGES.cust_shared);
    assert.notStrictEqual(PAGES.cust_wh, PAGES.customers, '别名须独立实例，避免共享 host');
  });

  let whHtml, sharedHtml, expressHtml;
  await t('仓储客户页渲染：仓库 Tabs(4) + 8 列表头 + 模板/导入按钮', async () => {
    calls.length = 0;
    whHtml = await mount('cust_wh');
    assert.ok(whHtml.includes('id="whTabs"'), '缺仓库 Tabs');
    ['龙湖仓', '佳新仓', '速远仓', '开元仓'].forEach((w) => assert.ok(whHtml.includes('data-wh="' + w + '"'), '缺 ' + w));
    assert.ok(whHtml.includes('id="tplBtn"') && whHtml.includes('下载导入模板'));
    assert.ok(whHtml.includes('id="importBtn"') && whHtml.includes('导入 Excel'));
    assert.ok(whHtml.includes('<th>所在仓库</th>'), '缺仓库列');
    ['货主代码', '公司全称', '客户简称', '截单时间', '预充单价', '合作状态', '操作']
      .forEach((h) => assert.ok(whHtml.includes('<th>' + h + '</th>'), '缺表头 ' + h));
    assert.ok(whHtml.includes('colspan="8"'), '仓储页应为 8 列');
  });
  await t('仓储客户查询固定传 customer_type=仓储客户 且带 warehouse', async () => {
    const u = calls.find((x) => x.startsWith('/customers?'));
    assert.ok(u, '未发起查询');
    assert.ok(u.includes('customer_type=' + encodeURIComponent('仓储客户')));
    assert.ok(u.includes('warehouse=' + encodeURIComponent('龙湖仓')));
  });
  await t('共享单号页：无仓库 Tabs、无仓库列、7 列、固定类型', async () => {
    calls.length = 0;
    sharedHtml = await mount('cust_shared');
    assert.ok(!sharedHtml.includes('id="whTabs"'));
    assert.ok(!sharedHtml.includes('<th>所在仓库</th>'));
    assert.ok(sharedHtml.includes('colspan="7"'));
    assert.ok(calls[0].includes('customer_type=' + encodeURIComponent('共享单号')));
    assert.ok(!calls[0].includes('warehouse='));
  });
  await t('快运物流页：无仓库 Tabs、无仓库列、固定类型', async () => {
    calls.length = 0;
    expressHtml = await mount('cust_express');
    assert.ok(!expressHtml.includes('id="whTabs"'));
    assert.ok(!expressHtml.includes('<th>所在仓库</th>'));
    assert.ok(calls[0].includes('customer_type=' + encodeURIComponent('快运物流')));
  });
  await t('三页均保留搜索/分页/新增按钮（组件结构复用）', async () => {
    [whHtml, sharedHtml, expressHtml].forEach((h, i) => {
      ['searchInput', 'searchBtn', 'addBtn', 'prevBtn', 'nextBtn'].forEach((id) => {
        assert.ok(h.includes('id="' + id + '"'), '第 ' + (i + 1) + ' 页缺 ' + id);
      });
    });
  });

  // ---------- 3. 手工表单：18 字段 + 仓库多选联动 ----------
  const FORM_IDS = [
    'f_code', 'f_company', 'f_short', 'f_contact', 'f_phone', 'f_address', 'f_erp', 'f_product',
    'f_platform', 'f_count', 'f_account', 'f_price', 'f_cutoff', 'f_logistics', 'f_expiry', 'f_coop', 'f_remark',
  ];
  await t('表单源码含 17 个单值字段 + 仓库多选，共 18 个业务字段', async () => {
    FORM_IDS.forEach((id) => assert.ok(customersSrc.includes('id="' + id + '"'), '缺 ' + id));
    assert.ok(customersSrc.includes('id="f_wh"'), '缺仓库多选');
    assert.strictEqual(FORM_IDS.length + 1, 18);
  });
  await t('表单分区：基础信息 / 业务配置两列布局', async () => {
    assert.ok(customersSrc.includes('>基础信息</div>'));
    assert.ok(customersSrc.includes('>业务配置</div>'));
    assert.ok(css.includes('.modal-body .form-section'));
  });
  await t('所在仓库/合作状态/效期管理为下拉或多选，非纯文本框', async () => {
    assert.ok(/<select id="f_coop"/.test(customersSrc));
    assert.ok(/<select id="f_expiry"/.test(customersSrc));
    assert.ok(/input type="checkbox" value="\$\{w\}"/.test(customersSrc));
  });
  await t('仓库多选仅在仓储客户页渲染（cfg.withWarehouse 条件）', async () => {
    assert.ok(customersSrc.includes('${cfg.withWarehouse ? `') || customersSrc.includes("cfg.withWarehouse ? '"));
    assert.ok(customersSrc.includes('withWarehouse: true'), '仓储页配置');
    assert.ok(customersSrc.includes('withWarehouse: false'), '共享/快运配置');
  });
  await t('前端必填校验：公司全称 + 仓储客户至少选一仓', async () => {
    assert.ok(customersSrc.includes("if (!p.company_name)"));
    assert.ok(customersSrc.includes('cfg.withWarehouse && !p.warehouse.length'));
  });
  await t('导入结果显示成功提示 + 失败清单（行号/原因）', async () => {
    assert.ok(customersSrc.includes('导入成功'));
    assert.ok(customersSrc.includes('导入失败清单'));
    assert.ok(customersSrc.includes('第 ${f.row} 行'));
    assert.ok(customersSrc.includes('f.reason'));
  });
  await t('导入按当前页类型提交 customer_type', async () => {
    assert.ok(customersSrc.includes("fd.append('customer_type', cfg.type)"));
  });

  // ---------- 4. 删除功能：RBAC 展示控制 + 二次确认弹窗 ----------
  await t('删除按钮角色控制：仅 管理员/超级管理员 渲染', async () => {
    assert.ok(customersSrc.includes("role === '管理员' || role === '超级管理员'"), '缺角色判断');
    assert.ok(customersSrc.includes('canDelete()'), '缺 canDelete() 调用');
    assert.ok(customersSrc.includes('window.ERP_USER'), '删除控制须读取当前登录用户');
  });
  // 注入一行客户数据，使操作列按钮真正渲染（用例结束即清空，不影响其他用例）
  const DEMO_ROW = {
    customer_id: 99, customer_code: 'C99', company_name: '测试删除公司', short_name: '测删',
    warehouse: '龙湖仓', cutoff_time: '16:00', prepaid_price: 0.35, coop_status: '合作中',
  };
  const withRow = async (fn) => {
    sandbox.__rows = [DEMO_ROW];
    try { await fn(); } finally { sandbox.__rows = []; }
  };
  await t('管理员视角：操作列渲染红色「删除」按钮', async () => withRow(async () => {
    sandbox.window.ERP_USER = { user_id: 1, role: '管理员' };
    calls.length = 0;
    const html = await mount('cust_wh');
    assert.ok(html.includes('class="danger">删除</button>'), '缺删除按钮');
    assert.ok(html.includes('id="del_'), '缺 del_ 行按钮 id');
    assert.ok(html.includes('>查看</button>') && html.includes('>编辑</button>')
      && html.includes('>暂停</button>'), '原按钮（查看/编辑/暂停）保留');
  }));
  await t('业务员视角：不渲染「删除」按钮', async () => withRow(async () => {
    sandbox.window.ERP_USER = { user_id: 2, role: '业务员' };
    const html = await mount('cust_wh');
    assert.ok(!html.includes('>删除</button>'), '业务员不应看到删除按钮');
    assert.ok(html.includes('>查看</button>'), '其余按钮不受影响');
  }));
  await t('查看者视角：不渲染「删除」按钮', async () => withRow(async () => {
    sandbox.window.ERP_USER = { user_id: 3, role: '查看者' };
    const html = await mount('cust_wh');
    assert.ok(!html.includes('>删除</button>'), '查看者不应看到删除按钮');
    assert.ok(html.includes('>查看</button>'), '其余按钮不受影响');
  }));
  await t('删除二次确认弹窗：指定文案 + 确定后才发 DELETE', async () => {
    assert.ok(customersSrc.includes('确定要删除客户 ['), '缺确认文案前缀');
    assert.ok(customersSrc.includes('删除后将不可恢复，且可能导致该客户的历史订单和工时数据无法追溯'), '缺确认文案主体');
    assert.ok(customersSrc.includes("API.req('DELETE', '/customers/'"), '确认后走 DELETE 接口');
    assert.ok(customersSrc.includes('delOkBtn'), '缺「确定删除」按钮');
    assert.ok(customersSrc.includes('delErr'), '失败提示展示在弹窗内');
  });
  await t('CSS：红色删除按钮 + 确认弹窗文案样式', () => {
    assert.ok(css.includes('button.danger'), '缺 button.danger 样式');
    assert.ok(css.includes('.del-warn') && css.includes('.del-tip'), '缺弹窗文案样式');
  });

  console.log('\n' + '='.repeat(48));
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) {
    fails.forEach((f) => console.log('  - ' + f.name + ': ' + f.msg));
    process.exit(1);
  }
})();
