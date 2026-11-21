# 佐雍云仓数据中心（light-erp）代码审查报告

> **审查时间**：2026-11-21  
> **审查范围**：`D:\数据中心网站\light-erp` 全部源码（src/routes、src/services、src/db、src/middleware、src/utils、public/js、scripts、配置与部署文件），不含 node_modules 与 public/zplab（第三方构建产物）。  
> **审查方式**：4 个专项审查 agent 并行 + 主审查交叉验证关键发现。  
> **状态**：⚠️ **仅审查未修改任何文件，以下修改意见待您确认后再发起修改。**  
> **说明**：本机 `npm test` 报 `spawn EPERM` 是 DSH 沙箱限制子进程的环境问题，非项目代码缺陷，不计入 bug。

---

## 问题汇总统计

| 严重程度 | 数量 | 说明 |
|---------|------|------|
| 🔴 严重 | 13 | 功能完全失效 / 数据错乱 / 越权 / 密钥泄露 |
| 🟠 中等 | 24 | 逻辑缺陷 / 交互不通 / 安全风险 / 事务缺失 |
| 🟡 轻微 | 30 | 健壮性 / 一致性 / 死代码 / 规范 |
| **合计** | **67** | |

---

## 一、🔴 严重（13 项）

### S1. `orders.js:43` — 全局菜单门禁 path `'orders'` 不存在，整个订单模块对非超管 403

**位置**：`src/routes/orders.js:43`  
**问题**：`router.use(menuGate('orders'))` 作为全局门禁，但 menus 表中**不存在** path=`'orders'` 的菜单（菜单种子 `src/db/menu_seed.sql:50-53` 只有 `order_import`(702)、`order_dashboard`(703)、`smart_quote`(701)）。`menuGate`（`src/middleware/rbac.js:53-62`）要求精确匹配 `menus.path` 且 `is_built=1`，查不到即 403。除 `role_code==='super_admin'` 短路放行外，**所有普通用户访问 `/api/orders/*`（列表、查询、导出、模板、地区方案、看板等）全部 403**。  
**修改建议**：删除 `router.use(menuGate('orders'))` 全局门禁，改为逐路由按实际菜单 path 授权：
- 列表/查询/导出 → `menuGate('order_dashboard')`
- 导入/模板/平台 → `menuGate('order_import')`

### S2. `orders.js:224,552,561,584,622` — `menuGate('orders_import')` 拼写错误（多一个 s）

**位置**：`src/routes/orders.js:224,552,561,584,622`  
**问题**：实际菜单 path 是 `'order_import'`（`migrateAddOrderMenus.js:47`，无 s）。这 5 个接口（导入历史、平台列表、Excel 导入、地区重算、导入看板）对非超管全部 403。  
**修改建议**：统一改为 `menuGate('order_import')`。

### S3. `customers.js:164` — `roleGate` 传数组而非展开参数，仓库排序接口非超管永久 403

**位置**：`src/routes/customers.js:164`  
**问题**：`roleGate(['管理员', '超级管理员'])` 传入了一个**数组对象**作为单一参数。`rbac.js:17-26` 的 `roleGate(...roles)` 用 `roles.some(r => r === u.role)`，此时 `r` 是数组 `['管理员','超级管理员']`，与任何字符串角色都不相等。除超管短路外所有用户 403，仓库排序功能不可用。  
**修改建议**：改为 `roleGate('管理员', '超级管理员')`（展开传参）。

### S4. `settings.js:30` — 全局门禁 `menuGate('settings')` 依赖动态迁移菜单

**位置**：`src/routes/settings.js:30`  
**问题**：`'settings'` 菜单不是 `menu_seed.sql` 固定种子，仅由 `migrateExpressWaybill.js` 迁移时动态 INSERT。若该迁移未执行或自定义角色未被授权此菜单，非超管访问 `/api/settings/*` 全部 403。  
**修改建议**：确认迁移在所有环境执行且给所有需要的角色授权；或改用 `roleGate('超级管理员')` 等不依赖动态菜单的门禁。

### S5. `analytics.js:168` — `menuGate('dashboard')` 门禁 path 不匹配

**位置**：`src/routes/analytics.js:168`  
**问题**：看板子菜单实际 path 是 `dash_wh_summary`(101)/`dash_express`(102)，不存在 path=`'dashboard'` 的可授权子菜单（`'dashboard'` 只是主菜单容器 path）。非超管大概率 403。前端已切到 `/dashboard/summary`。  
**修改建议**：删除该废弃路由；若保留则用 `menuGate('dash_wh_summary')`。

### S6. `workhours.js:1889` — `preset` 变量未定义，已归档记录「修改/查看」弹窗崩溃

**位置**：`public/js/workhours.js:1889`  
**问题**：`value="${escapeAttr(cur.date || preset.date || todayStr())}"`，但整个 `openModal` 作用域内只定义了 `presetName`（:1856），**没有 `preset` 变量**。当 `cur.date` 为空时触发 `ReferenceError: preset is not defined`，弹窗构建中断，点击「查看」「修改」已归档工时会失败。  
**修改建议**：改为 `cur.date || todayStr()`；或在使用前定义 `const preset = { date: cur.suggest_date || '' }`。

### S7. `workhours.js:1213+1454` — 虚拟缺口行删除失效，发出错误请求 `DELETE /workhours/0/force`

**位置**：`public/js/workhours.js:1213-1216, 1454`  
**问题**：`rowAttrs` 只写了 `data-row-wid` 等，没有 `data-row-id`。delAdmin 分支（:1454）读 `row.dataset.rowId` → `Number(undefined)` = `NaN`；:1456 `isVirtual` 判断因 `NaN` 恒为 false。缺口行（wid=0）本应走本地 localStorage 屏蔽逻辑，实际落入 `DELETE /workhours/0/force`，删除功能完全失效。  
**修改建议**：:1454 改为 `const wid = Number(row && row.dataset.rowWid);`，使 `wid===0` 判定成立。

### S8. `workhours.js:1062+1562` — 缺口行屏蔽后行内编辑回写到错误记录（数据串写）

**位置**：`public/js/workhours.js:1062-1070, 1562`  
**问题**：`renderRows` 先按 gap_block 过滤出 `rows`，用 `state._shownRows.indexOf(r)` 把**过滤后下标**写入 `data-row-idx`。但 `bindInlineRow`(:1562) 用 `state.lastRows[idx]`（**未过滤**的原始数组）做 syncBack 目标。只要屏蔽过任意缺口行，其后所有行的编辑内容会被写回相邻的错误记录，造成数据错乱。  
**修改建议**：:1070 改为 `state.lastRows.indexOf(r)`；或 syncBack 统一基于 `state._shownRows[idx]` 或按 `work_id` 定位。

### S9. `roles.js:218-222` — 编辑角色会清空自定义角色的 `data_scope` / `is_readonly`

**位置**：`public/js/roles.js:218-222` + `src/routes/roles.js:89-92`  
**问题**：前端编辑分支只提交 `{ role_name, description }`，后端对非内置角色无条件执行 `UPDATE roles SET role_name=?, description=?, data_scope=?, is_readonly=?`，其中 `data_scope` 取默认 `'all'`、`is_readonly` 取默认 `0`。编辑任意自定义角色的名称或描述后，其「仅本人数据」隔离和「只读」属性被静默重置为默认值，是权限安全相关的配置丢失。  
**修改建议**：编辑 payload 带上原值 `data_scope: role.data_scope, is_readonly: role.is_readonly`；弹窗编辑态也渲染这两个控件。

### S10. `auth.js:86-95`（中间件）— 角色被删的有效 token 降级为 `data_scope:'all'`，越权提权

**位置**：`src/middleware/auth.js:86-95`  
**问题**：`jwt.verify` 后按 `role_id` 查角色，查不到时降级为 `role_code:''`、`data_scope:'all'`、`is_readonly:0`。有效 token 的用户所属角色被删后，反而获得「全部数据范围」且非只读，属越权提权。  
**修改建议**：角色缺失直接返回 401/403，或降级为最小权限 `data_scope:'self'`、`is_readonly:1`。

### S11. `migrateCustomersRemoveUnique.js:97` — 自愈恢复路径调用 `db.transaction()` 但该方法不存在

**位置**：`src/db/migrateCustomersRemoveUnique.js:97`  
**问题**：调用 `db.transaction(rows => …)`，但传入的 db 是 `src/db/index.js:228-239` 包装后的对象，只有 `exec/prepare/runMigrations` 等，**没有 `.transaction` 方法**。一旦「customers 空、customers_bak 有数据」的崩溃场景触发，恢复必定抛 `db.transaction is not a function`，数据无法恢复。  
**修改建议**：改用 `db.exec('BEGIN')` + 逐行 `stmt.run()` + `COMMIT`；或让包装对象透传底层 `.transaction`。

### S12. `deploy.js:202-206` — 发布包会把 `jwt.secret` 打进发布包上传公网

**位置**：`scripts/deploy.js:202-206`  
**问题**：G5 打包的 robocopy 只排除了 `/XF .env`，**未排除 `jwt.secret`**。stage 暂存目录会包含真实 JWT 密钥，随后上传到 TraeSite 托管平台。任何人拿到发布包即可伪造 super_admin token 完全控制系统。`.gitignore`/`.dockerignore` 排除了该文件，但真正执行的 `deploy.js` 绕过了这两层保护。  
**修改建议**：robocopy 改为 `/XF .env jwt.secret *.db *.db-* *.bak* *.log`；收紧 jwt.secret 的 NTFS ACL 仅保留当前用户/System。

### S13. `prepublish_guard.js` 缺失但被四处引用 — 数据保护防线实际不存在

**位置**：`scripts/prepublish_guard.js`（缺失）；引用处 `.deployignore:10`、`scripts/test_db_path.js:162-166`、`scripts/run_all_tests.sh:12`、方案.md  
**问题**：确认 `prepublish_guard.js` 不存在。`test_db_path.js:163` 断言 `fs.existsSync(guard)`，`:164` 还读取其内容。`run_all_tests.sh` 把它列为第一项 → 全量回归**必然失败**。方案.md 声称的「三层防线」实际只剩两层。  
**修改建议**：补齐 `prepublish_guard.js` 实现（含 `--stage`/`--restore` 模式），或从文档/测试/脚本中彻底移除引用。

---

## 二、🟠 中等（24 项）

### M1. `deploy.js` 硬编码排除清单，不读取 `.deployignore`

**位置**：`scripts/deploy.js:202-206` vs `.deployignore:1-60`  
**问题**：`.deployignore` 定义了详尽排除清单（`*.db-wal`/`*.sqlite*`/`jwt.secret` 等），但 `deploy.js` 用硬编码 robocopy 参数，只排除 `/XF .env`。`.deployignore` 形同虚设。这是 S12 密钥泄露的同类根因。  
**修改建议**：让 `deploy.js` 解析 `.deployignore` 动态生成 robocopy `/XD`/`/XF` 参数。

### M2. `migrateDashboardSubmenus.js:68-76` — 无条件给所有角色授予新菜单权限

**位置**：`src/db/migrateDashboardSubmenus.js:68-76`  
**问题**：注释声称「有看板权限的角色」才授权，实际 `SELECT role_id FROM roles` 把新菜单 101/102 无条件授予所有角色，权限过度分配。  
**修改建议**：仅给 `role_code='super_admin'/'admin'` 或原本持有 menu_id=1 权限的角色授权。

### M3. `index.js:15-57`（db）— 快照清理误裁剪定时备份至 3 份

**位置**：`src/db/index.js:15-57`  
**问题**：`snapshotDb` 清理按文件名前缀匹配所有 base 备份，保留数 `keep = isPreMigrate ? 3 : 20` 由「本次快照原因」决定：一次迁移前快照会把定时备份也裁剪到 3 份，历史备份意外丢失。  
**修改建议**：按备份类型（pre-migrate vs scheduled）分别过滤后再应用各自的保留策略。

### M4. `index.js:172-226`（db）— 迁移失败仅记录日志继续启动

**位置**：`src/db/index.js:172-226`  
**问题**：`runMigrations` 捕获所有迁移错误仅 `console` 记录后继续启动，DB 可能处于「部分迁移」状态，后续请求运行时报 SQL 错。  
**修改建议**：迁移失败应抛错阻止启动并提供明确修复指引（或进入安全只读模式）。

### M5. `ordersImport.js:308` — 绑定软删除客户

**位置**：`src/services/ordersImport.js:308`  
**问题**：`findCust` 用 `company_name=? OR short_name=?` 匹配客户，未加 `is_deleted=0`，新订单会绑到软删除客户。  
**修改建议**：查询加 `AND is_deleted=0`。

### M6. `ordersImport.js:355` — INSERT 引用可能不存在的列

**位置**：`src/services/ordersImport.js:355`  
**问题**：INSERT 列出 `wms_platform/to_province/to_city/to_district/region_class`，但该服务只幂等补 `waybill_type`（:248-251），若 `migrateOrdersRegion` 未跑成功则「no such column」。  
**修改建议**：导入前效仿 `ordersQuery.js` 做 `ensureColumns` 建列。

### M7. `warehouseSort.js:41-61` — 批量更新客户排序无事务

**位置**：`src/services/warehouseSort.js:41-61`  
**问题**：批量更新客户排序无事务，中途失败留下半套排序；另 others 排除 `is_deleted=1` 客户，软删除客户的 wsc 行保留旧 `sort_order`。  
**修改建议**：`BEGIN/COMMIT` 包裹；删除客户时同步清理或纳入排序。

### M8. `migrateOrdersRemoveFk.js:72-93` 与 `migrateInvRemoveFk.js:66-81` — 事务内 PRAGMA foreign_keys 无效

**位置**：`src/db/migrateOrdersRemoveFk.js:72-93`、`src/db/migrateInvRemoveFk.js:66-81`  
**问题**：`PRAGMA foreign_keys=OFF/ON` 位于 `BEGIN/COMMIT` 之间，SQLite 在事务内忽略该 pragma，关闭 FK 的意图无效；且 `INSERT INTO orders_new SELECT * FROM orders` 依赖静态 schema，列数不匹配时 fingerprint 丢失后重跑会出错。  
**修改建议**：在 BEGIN 前关 FK、COMMIT 后开 FK；用 `PRAGMA table_info` 动态生成列清单。

### M9. `seed.js:51-59` — 硬编码弱口令 `admin123`

**位置**：`src/db/seed.js:51-59`  
**问题**：用户表为空时创建管理员使用硬编码弱口令 `'admin123'`（bcrypt 哈希）。  
**修改建议**：首次启动强制改密或随机生成并输出一次性密码。

### M10. `excel.js:73-106` — parseDate 缺 date1904 选项

**位置**：`src/utils/excel.js:73-106`  
**问题**：`parseDate` 第一分支未传 `date1904` 选项（默认 1900 日期系统），而 `threeHours.js` 显式传 `date1904`；用订单导入读 1904 系统的 xlsx 会整体偏移 4 年。  
**修改建议**：统一解析入口并传递一致的 `date1904` 配置。

### M11. `Dockerfile:19-20` — 未 COPY `templates/`，容器内三类工时模板下载 500

**位置**：`Dockerfile:19-20`、`src/routes/threeHours.js:13,62-67`  
**问题**：Dockerfile 只 `COPY src`、`COPY public`，没有 `COPY templates`。`threeHours.js` 的模板路径 `../../templates/三类工时导入模板.xlsx` 在镜像中不存在，`GET /api/workhours/three/template` 返回 500。`build.sh`（TraeSite 路径）正确 COPY 了 templates，故仅 Docker 部署受影响。  
**修改建议**：`Dockerfile` 增加 `COPY templates ./templates`。

### M12. Docker 以 root 运行 + `docker-compose.yml` 明文弱 JWT 默认值

**位置**：`Dockerfile:31-33`、`docker-compose.yml:12`  
**问题**：Dockerfile 不切非 root 用户，容器以 root 运行。`docker-compose.yml:12` 默认密钥为 `"please-change-me-to-a-long-random-string"`——公开可猜，若直接对外部署，攻击者可伪造任意 JWT。  
**修改建议**：通过 secret/环境变量注入且启动时校验非默认值；使用非 root 用户。

### M13. `server-update.sh:32-39` — 前端更新不重启，版本号不变用户看不到新功能

**位置**：`server-update.sh:32-39`、`src/version.js:29-45`  
**问题**：脚本对仅 `public/` 变更不重启服务。但 `_build_version` 来自 `version.json`（build.sh 生成），git pull 更新 public/ 不会更新它 → 前端版本检测感知不到变化，而生产环境静态资源 24h immutable 缓存，用户浏览器长时间加载旧 JS。  
**修改建议**：前端变更时也刷新 `version.json` 或重启服务。

### M14. `deploy.js:163` — 正则解析测试输出绑定 Node 22+ 格式，Node 20 上误判阻断发布

**位置**：`scripts/deploy.js:163`、`package.json`（无 engines）  
**问题**：`match(/ℹ pass (\d+)/)` 中 `ℹ` 是 Node 22+ spec reporter 符号；Node 20 的 `node --test` 默认 TAP 输出无此符号 → 在 Node 20 上 G1 闸门误判「测试未通过」阻断所有发布。  
**修改建议**：改用 `--test-reporter=json` 解析结构化输出；`package.json` 增加 `engines`。

### M15. `run_all_tests.sh:12` — 全量回归必然失败（根因同 S13）

**位置**：`scripts/run_all_tests.sh:12`、`scripts/test_db_path.js:162-164`  
**问题**：读取不存在的 `prepublish_guard.js` 会抛异常、非零退出 → 整体回归失败。  
**修改建议**：随 S13 补齐文件后修复，或从 TESTS 数组移除。

### M16. 默认管理员弱口令 `admin/admin123` 多处硬编码

**位置**：`scripts/deploy.js:65`、`scripts/prepublish-export.js:40`、`scripts/online_restore.js:17`、`scripts/seed.js:6-7`、`server-setup.sh`  
**问题**：生产若未改密码，攻击者用公开默认值即可登录 super_admin，配合 `/api/admin/db-export` 可拖走全库。  
**修改建议**：首次启动强制改密或生成随机初始密码。

### M17. `auth.js:59-80`（路由）— 首个超管自助注册无并发保护与输入校验

**位置**：`src/routes/auth.js:59-80`  
**问题**：仅当 users 表 COUNT=0 放行，两个并发请求可同时通过检查 → 产生两个超级管理员；用户名/密码无长度、字符集校验。  
**修改建议**：用事务/唯一约束保证只有一个首超管；复用 `rules.login` 做参数校验。

### M18. `admin.js:368-382,436-454,457-476` — 审计参数用错字段名，日志全部失真

**位置**：`src/routes/admin.js:368-382,436-454,457-476`  
**问题**：DELETE 业务数据/导入订单/备份时调 `audit.writeLog` 传 `{ operation:'DELETE', details: JSON.stringify(...) }`，但 `writeLog` 只认 `opts.action/content` → action=undefined 变 'unknown'，content 为 `{before:null,after:null}`，日志中心显示为「历史未知操作」且无内容。  
**修改建议**：改为 `{ table, module, action:'delete', content:{before, after} }`。

### M19. `logistics-quotes.js:385-386,402-404` — 全局判重过严，新增接口不可用

**位置**：`src/routes/logistics-quotes.js:385-386,402-404`  
**问题**：POST / 与 PUT /:id 用 `SELECT 1 FROM logistics_quotes WHERE express_code=?` 全局判重，但同编码按省市区明细允许多行（by-code 导入即产生多行同编码）→ 给已有编码增加任何新区域都 400 拒绝。  
**修改建议**：按 `(express_code + 省市区)` 联合判重，或改成「整编码编辑」语义。

### M20. `logistics-quotes.js:175,222,233,391,412,421` — 自定义 action 不在审计枚举中

**位置**：`src/routes/logistics-quotes.js:175,222,233,391,412,421`  
**问题**：`writeAudit(req,'update_region'/'update_batch'/'delete_batch')` 的 action 不在 `auditLog.toEnum` 映射里 → v_audit_logs 显示「历史未知操作」。  
**修改建议**：统一传标准 action（update/delete），细粒度用 content.note 记录。

### M21. `smart-quote.js:147-222` — 智能测单导入落库无事务

**位置**：`src/routes/smart-quote.js:147-222`  
**问题**：一次导入 INSERT batch + N 条 records + audit，逐条执行无事务，中途失败留下半批次/孤儿 batch。  
**修改建议**：用 `db.transaction` 包裹整个写入过程。

### M22. `customers.js:451-470` — Excel 导入 Upsert 键缺 customer_type 且未排已删除

**位置**：`src/routes/customers.js:451-470`  
**问题**：`SELECT * FROM customers WHERE company_name=?` 未限定 `customer_type` 和 `is_deleted`，多分类重名客户会错误恢复/更新到另一分类的记录。  
**修改建议**：Upsert 键改为 `(company_name, customer_type)`，并加 `AND is_deleted=0`。

### M23. `analytics.js:91,168` — 汇总 SQL 不过滤 status，草稿计入汇总

**位置**：`src/routes/analytics.js:91,168`  
**问题**：`/summary` 注释称基于 archived 数据，但 SQL 无 `status='archived'`，pending 草稿被计入汇总，数据口径错误。  
**修改建议**：SQL 加 status 过滤或按需求明确口径。

### M24. `dashboard.js:39-86` — 单日环比上期计算错误

**位置**：`src/routes/dashboard.js:39-86`  
**问题**：`periodType='day'` 且 `startDate===endDate` 时 span=0，`prevStart=prevEnd=本期同一天`，环比 wow(cur,cur) 恒为 0%，应为前一日。另 week/month 分支忽略传入 endDate 强制自然周/月，与注释矛盾。  
**修改建议**：单日时上期取前一日；按注释口径尊重传入 endDate 或修正注释。

### M25. `api.js:159-179`（前端）— 非幂等请求在 5xx 时自动重试，可能重复提交

**位置**：`public/js/api.js:159-179`  
**问题**：`req()` 对 `res.status >= 500` 无条件重试，包含 POST/PUT/DELETE。若服务端已写入但返回 5xx，会造成重复数据。  
**修改建议**：仅对 GET 重试；非 GET 遇 5xx 直接抛错。

### M26. `orders.js:96-98,157-161`（前端）— 模板下载/导入缺 token 与 sharecode

**位置**：`public/js/orders.js:96-98,157-161`  
**问题**：:96 `window.open('/api/orders/template', '_blank')` 不带鉴权头；:157 导入用裸 `fetch` 仅带 `Authorization`，缺 `X-ERP-Token` 与 sharecode。纯分享码访问模式下模板下载与导入都会 401。  
**修改建议**：统一改用 `API.download('/orders/template')` 和 `API.upload('/orders/import', fd)`。

### M27. `orders-module.js:61-62,468,879-1014`（前端）— 模块级单例状态导致多标签串页

**位置**：`public/js/orders-module.js:61-62,468,879-1014`  
**问题**：`_platforms`/`_dragCleanup`/`oqState` 为模块级单例：两个 tab 各自 mountImport 后挂载者调 `_dragCleanup()` 会解绑前者拖拽；两 tab 共用分页状态互相影响；全局 `document.querySelector` 总命中 DOM 第一个面板。  
**修改建议**：状态全部收敛进 `createPage()` 闭包，DOM 查询限定在 `host` 内。

### M28. `roles.js:12-22`（前端）— 同步 XHR + eval 兜底加载权限树组件

**位置**：`public/js/roles.js:12-22`  
**问题**：用已废弃的同步 `XMLHttpRequest` 拉取 `permission-tree.js?v=10` 并 `eval()`，在严格 CSP 下失效，且阻塞主线程。  
**修改建议**：把 `permission-tree.js` 加入 `_page_loader` 声明为 roles 的依赖，移除 eval。

### M29. `customers.js:20-23` 与 `logistics-quotes.js:13-16`（前端）— 写权限用中文角色名判断

**位置**：`public/js/customers.js:20-23`、`public/js/logistics-quotes.js:13-16`  
**问题**：`canDelete()`/`canWrite()` 仅判断 `ERP_USER.role === '管理员'|'超级管理员'`（role_name），角色改名后权限展示失效；`settings.js:29-33` 已同时判断 `role_code`，口径不一致。  
**修改建议**：改用 `role_code === 'admin'|'super_admin'`。

### M30. `workhours.js:751-794,796-810` — 超管批量/物理删除无仓库约束

**位置**：`src/routes/workhours.js:751-794,796-810`  
**问题**：`/batch` 在 warehouse 为空时不过滤任何仓；`/:id/force` 超管有短路。任何超管可不传 warehouse 跨仓批量物理删除。  
**修改建议**：`/batch` 强制 warehouse 必填；超管跨仓操作二次确认或记录审计。

### M31. `orders-module.js:350,355`（前端）— 文件名直接拼入 innerHTML（XSS）

**位置**：`public/js/orders-module.js:350,355`  
**问题**：`prog.innerHTML` 直接拼 `f.name`（本地文件名未转义），构造含 HTML 的文件名即可注入。  
**修改建议**：对 `f.name` 做 HTML 转义后再拼接。

### M32. `menu.js:225-227,254-257,267`（前端）— 菜单名 innerHTML 拼接未转义（XSS）

**位置**：`public/js/menu.js:225-227,254-257,267`  
**问题**：`cat.menu_name`、`g.title` 直接拼进 `innerHTML`，后端菜单名若含 HTML 会被执行。  
**修改建议**：插入前统一 HTML 转义。

### M33. `users.js:34`（前端）— 自删除判断类型不一致

**位置**：`public/js/users.js:34`  
**问题**：`const isSelf = u.user_id === window.ERP_USER.user_id`；若两方类型不一致（string vs number）则判断失败，用户可能删除自己。  
**修改建议**：`Number(u.user_id) === Number(window.ERP_USER.user_id)`。

### M34. `rbac.js:45-50` — `ensureOwn` 类型不一致可能误判

**位置**：`src/middleware/rbac.js:45-50`  
**问题**：`ensureOwn` 用 `!==` 严格比较 `owner_user_id`（int）与 `req.user.user_id`（可能 string），类型不一致可能误判。  
**修改建议**：统一 `Number()` 后比较。

### M35. `cors` 通配符域名不被识别（`server.js:89-97`）

**位置**：`src/server.js:89-97`  
**问题**：`cors` 生产配置使用 `'https://*.workbuddy.host'` 和 `'https://*.traesite.cn'`，但 `cors` 包将通配符域名视为**字面字符串**，不会匹配子域名。实测 `https://foo.traesite.cn` 不返回 `Access-Control-Allow-Origin` 头 → 浏览器跨域请求被拦截。仅精确域名 `wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host` 可用。  
**修改建议**：改用函数动态校验 origin：`origin: (origin, cb) => { if (!origin || /workbuddy\.host$|traesite\.cn$/.test(origin)) return cb(null, true); cb(new Error('Not allowed')); }`。

### M36. `menu_version` 前后端不一致（auth.js:40 vs menu.js:127）

**位置**：`src/routes/auth.js:40` vs `public/js/menu.js:127`  
**问题**：后端返回 `menu_version: 7`，前端 `ERP.MENU_SCHEMA_VERSION = 8`（v8 = 看板从直达变容器）。版本不一致可能导致前端重复清理菜单缓存或触发不必要的刷新。  
**修改建议**：统一为 8（与最新菜单结构一致）。

### M37. `version.js:56` — 运算符优先级错误

**位置**：`src/version.js:56`  
**问题**：`'dev-' + process.env.START_TIME || 'dev'` 运算符优先级错误，`START_TIME` 未设时得 `'dev-undefined'`（虽下一行覆盖但属死代码）。  
**修改建议**：`_cachedVersion = 'dev-' + (process.env.START_TIME || Date.now())` 并删除后续 if。

---

## 三、🟡 轻微（30 项）

> 以下为健壮性/一致性/死代码/规范类问题，按模块分组。

### 数据库与迁移

- **L1** `src/db/index.js:63-103` — `appliedNow`（:65）计算后从未使用，所谓「schema 变更检测」实际只看 mtime，存在漏检。建议：真正对比迁移指纹数或删除死代码。
- **L2** `src/db/index.js:194-198 + migrateRolesCleanup` — 每次启动先建 admin/operator/viewer 角色，再被 seed.js INSERT OR IGNORE、最后被 migrateRolesCleanup 删除，产生无意义 churn。建议：由单一迁移/seed 管理角色初始化。
- **L3** `src/db/index.js:228-239` — `db.prepare` 包装返回新对象，丢弃底层 `stmt.finalize`，预处理语句无法显式释放。建议：包装对象保留 finalize 能力。
- **L4** `src/db/driver.js:21-28` — `nativeAvailable()` 只 `require('node:sqlite')`，未验证 `DatabaseSync` 是否导出。建议：检查 `typeof DatabaseSync === 'function'`。
- **L5** `src/db/driver.js:14-15` — 注释明确 wasm 下不应多开连接，但 `dbBackup.js:43` 与 `dbPath.js:191-210` 额外开连接，存在锁/数据竞争隐患。建议：统一用主连接或串行化访问。
- **L6** `src/db/driver.js:58-62` — wasmBind 把「单个参数本身是数组」误判为绑定数组。建议：绑定统一按参数列表处理。
- **L7** `src/db/safety.js:49-62` — `safeRebuild` 数据拷贝在 BEGIN/COMMIT 之外，仅 rename 原子；失败残留新表+数据。建议：建表/拷贝/rename 全纳入同一事务。
- **L8** `src/db/safety.js:55` — `newDdl.replace(tableName, tmp)` 只替换首次出现，DDL 中多次引用表名会替换不全。建议：用正则全局替换或显式构造 DDL。
- **L9** `src/db/dbPath.js:259-280` — `autoRestoreIfEmpty` 定义并导出却从未被调用，`index.js:127-151` 重复内联实现。建议：统一调用该函数。
- **L10** `src/db/migrateOrdersRegion.js:84-89` — `PRIMARY KEY (province, city)` 中 city 为 NULL 表示全省行，SQLite 允许多行 (省,NULL) 重复。建议：全省行用哨兵值或加 WITHOUT ROWID + CHECK。
- **L11** `src/db/migrateOrdersRegion.js:74-130` — CREATE/seed/ALTER/index 无事务包裹。建议：加 BEGIN/COMMIT。
- **L12** `src/db/migrateAuditLogs.js:111-112` — `PRAGMA foreign_key_check` 在 COMMIT 之后执行，检查失败无法回滚。建议：在事务内执行检查。

### 服务层

- **L13** `src/services/auditLog.js:55-58` — `clientIp` 直接取 `X-Forwarded-For`，可伪造审计来源 IP。建议：仅信任可信代理。
- **L14** `src/services/auditLog.js:87-101` — INSERT 后再 `UPDATE audit_logs SET id = log_id` 依赖 id 与 log_id 对齐的假设，脆弱。建议：直接插入正确 id。
- **L15** `src/services/ordersImport.js:365-389` — 手动 BEGIN 后循环内 try/catch 吞掉失败行不回滚整批，BEGIN 与 COMMIT 之间未捕获的异常会留下未结束事务污染后续请求。建议：catch 中统一 ROLLBACK。
- **L16** `src/services/ordersImport.js:369` — `order_no` 回退 `'ORD'+Date.now()+random(1000)` 并发下可能重复。建议：用 UUID/数据库序列。
- **L17** `src/services/ordersImport.js:191-203` — `classifyRegion` 读 `shentong_region_class` 无 try/catch，表缺失时整个导入抛错。建议：惰性建表或降级处理。
- **L18** `src/services/ordersQuery.js:122` — LIMIT/OFFSET 未在 service 层设上限。建议：service 内 clamp pageSize 上限。
- **L19** `src/services/backupScheduler.js:39-53` — 以 `listSnapshots(dir)[0]` 当最新备份，若排序不确定会误判。建议：显式按 mtime/文件名排序取最新。
- **L20** `src/services/dbBackup.js:41` — 同秒文件名冲突抛错；:54-55 仅检查 `integrity_check==='ok'`；:43 新连接违反 driver 多连接约束。建议：文件名加毫秒/序号，校验所有 check 项，复用主连接。
- **L21** `src/services/menuService.js:isSuper` — 仅认 `role_code==='super_admin'`，旧 admin 角色不视为超管。建议：确认角色编码规范。

### 中间件与工具

- **L22** `src/middleware/rbac.js:37-42` — `readonlyGate` 仅判断 `method!=='GET'`，HEAD/OPTIONS 可能绕过只读。建议：显式允许 GET/HEAD/OPTIONS。
- **L23** `src/utils/round.js:2-5` — EPSILON 在缩放后加成无意义；负数 `Math.round(-1.5)=-1` 与常见「四舍五入」期望相反。建议：按符号处理或明确舍入语义。
- **L24** `src/utils/logger.js` — 注释称「按天轮转」，实际只配 `maxFiles+maxsize` 无日期轮转。建议：加 dailyRotateFile 或修正注释。

### 前端

- **L25** `public/js/settings.js:208,212,324,551` — 弹窗 `close()` 仅 `overlay.remove()`，document keydown 监听器泄漏。建议：`close()` 统一 `removeEventListener`。
- **L26** `public/js/smart-quote-history.js:77` — `共 ${state.records.length ? '' : ''}` 两分支都是空串，分页信息永远空白。建议：改为后端返回的 `r.total`。
- **L27** `public/js/api.js:216-242` — `download()` 成功路径未调用 `_afterSuccess(j)`，版本检测在纯下载场景遗漏。
- **L28** 硬编码仓库列表多处：`customers.js:4`、`analytics.js:6`、`dashboard.js:5` 均为 `['龙湖仓','佳新仓','速远仓','开元仓']`。建议：统一从后端接口或单一配置读取。
- **L29** `public/js/charts.js` 全文为死代码（仅被死代码 analytics.js 引用），连同 `app.html:72` 的 chart.js CDN 都是无效依赖。建议：连同 S5（analytics.js）一并处理。
- **L30** `public/js/_page_loader.js:35` — `analytics: 'js/dashboard.js'`（注释「复用 dashboard.js」），`analytics.js`(87 行) 永远不会执行。需与 S5 一并决策。

### 配置与部署

- **L31** `package.json` 无 `engines`；多个脚本要求 Node22+ 或原生编译，运行时要求不一致。建议：加 `engines: {node: ">=20"}`。
- **L32** `src/server.js:292-311` — `apicache`/`cache2m`/`cache5m` 配置了但从未挂到任何路由，属未使用依赖。建议：移除或实际启用。
- **L33** `src/server.js:438-440` — `PRAGMA query_timeout = 15000` 是无效设置（SQLite 无此 PRAGMA），不产生任何超时保护。建议：删除或改用 `busy_timeout`。
- **L34** `server-setup.sh:34-35,80-95` — `git clone "https://${GITHUB_TOKEN}@..."` token 出现在 URL/进程参数；nginx 仅 `listen 80`，JWT/密码明文 HTTP 传输。建议：用 header 传 token；配置 TLS。
- **L35** `server-update.sh:32` — 模式 `^(package\.json|...|server\.js)` 中 `server.js` 匹配仓库根，但项目无根 server.js（入口 `src/server.js` 已被 `src/` 覆盖）。冗余但不会漏判。
- **L36** `scripts/verify_data_integrity.js:13` — 硬编码 `node:sqlite`（Node22+），Node20 部署环境无此模块，`npm run verify:data` 会失败。建议：改用 `src/db/driver.js` 的 `openDatabase()`。
- **L37** `scripts/build_recovery_templates.js:20-25`、`scripts/restore_from_excel.js:30-35` — 硬编码个人机器绝对路径 `C:/Users/顾力瑞/Desktop/...`，其他机器不可用。建议：改为命令行参数。

---

## 四、修复优先级建议

### 第一优先级（安全 + 功能阻断）—— 建议立即修复
| 编号 | 问题 | 影响 |
|------|------|------|
| S1-S5 | 菜单门禁 path 错误（orders/settings/analytics/customers） | 非超管用户核心功能完全不可用 |
| S10 | 角色删除后越权提权 | 安全漏洞 |
| S12 | jwt.secret 随发布包上传公网 | 密钥泄露 |
| S13 | prepublish_guard.js 缺失 | 数据保护防线缺失 |
| M35 | CORS 通配符域名不生效 | 新平台跨域被拦截 |
| M16 | 默认弱口令多处硬编码 | 可被公开默认值登录 |

### 第二优先级（数据正确性 + 可用性）
| 编号 | 问题 | 影响 |
|------|------|------|
| S6-S8 | workhours 弹窗崩溃/删除失效/数据串写 | 工时模块数据错乱 |
| S9 | 编辑角色清空权限配置 | 权限丢失 |
| S11 | 自愈恢复路径崩溃 | 崩溃后无法恢复 |
| M5-M6 | 订单导入绑定软删除客户/缺列 | 导入数据错误 |
| M18-M20 | 审计日志字段错误/失真 | 操作不可追溯 |
| M24 | 看板环比计算错误 | 数据展示错误 |

### 第三优先级（健壮性 + 规范 + 死代码）
M1-M4, M7-M15, M21-M23, M25-M37, L1-L37 按需排期。

---

## 五、已验证排除的项（避免误报）

- **API 路径一致性**：前端 107 处调用均命中后端注册路由，未发现缺失路由（`threeHours` 经 `workhours.js` 挂载有效）。
- **字段一致性**：`default_unit`、`audit_logs` 双写等在前后端一致。
- **SQL 注入面**：整体可控，绝大多数使用占位符；`scope.sql` 来自可信常量。LIKE 通配符未转义属逻辑问题非注入。
- **roleGate 数组调用**：全项目仅 `customers.js:164` 一处。
- **测试 spawn EPERM**：DSH 沙箱限制，非项目缺陷。

---

> **请审阅以上报告，确认需要修复的问题范围与优先级后，我再发起修改。**  
> 如对某条问题有疑问或需要补充验证，请告知。
