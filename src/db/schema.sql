-- ============================================================
-- 佐雍云仓数据中心 建表 SQL（SQLite）
-- 约定：
--   * 库存余量不落字段，由 inventory_transactions 实时聚合
--   * 所有金额/工时数值在应用层统一 round(,3) 后存储
--   * owner_user_id 用于行级数据隔离（客户/订单/工时）
--   * status / payment_status / direction / reference_type / action
--     使用受控文本值，应用层做枚举校验
-- ============================================================

PRAGMA foreign_keys = ON;

-- 角色表（RBAC 重构：菜单权限数据库配置化；旧「管理员/业务员/查看者」保留为可配置角色）
--   * role_code 为稳定标识（super_admin/admin/operator/viewer/自定义），权限逻辑以它为准
--   * data_scope: all=全部数据 / self=仅本人（行级隔离，替换旧「业务员」硬编码）
--   * is_readonly: 1=只读角色（替换旧「查看者」硬编码）；is_system: 1=内置角色禁删禁改
CREATE TABLE IF NOT EXISTS roles (
  role_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  role_code   TEXT NOT NULL UNIQUE,
  role_name   TEXT NOT NULL UNIQUE,
  description TEXT,
  data_scope  TEXT NOT NULL DEFAULT 'all',
  is_readonly INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 菜单表（严格两级：parent_id IS NULL = 主菜单；否则 = 子菜单）
--   * menu_code 稳定标识，权限配置不依赖自增 id；path = 前端页面 id（hash 路由段）
--   * group_name 仅作飞出面板分组展示，不参与授权；is_built=0 为功能建设中（可预授权）
CREATE TABLE IF NOT EXISTS menus (
  menu_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_code  TEXT NOT NULL UNIQUE,
  parent_id  INTEGER REFERENCES menus(menu_id) ON DELETE CASCADE,
  menu_name  TEXT NOT NULL,
  path       TEXT UNIQUE,
  icon       TEXT,
  group_name TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  is_built   INTEGER NOT NULL DEFAULT 1,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 角色-菜单关联（role_menus）：保存角色被授权的主菜单与子菜单 id
CREATE TABLE IF NOT EXISTS role_menus (
  role_id INTEGER NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  menu_id INTEGER NOT NULL REFERENCES menus(menu_id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, menu_id)
);

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role_id       INTEGER NOT NULL REFERENCES roles(role_id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 客户资料（重构：18 个业务字段 + customer_type 分类 + 4 个系统列）
--   * company_name / customer_code 列级 UNIQUE 已移除（见 migrateCustomersRemoveUnique.js），
--     由后端 validate 的 is_deleted=0 过滤管理软删除客户的唯一性
--   * warehouse 为多仓字符串，英文逗号拼接（如 '龙湖仓,佳新仓'），全系统按精确边界匹配:
--     ',' || warehouse || ',' LIKE '%,仓名,%'（替代原 LIKE '%仓名%'，避免子串误命中/空仓漏出）
--   * 索引不写在本文件：旧库未迁移时 CREATE INDEX 会报 no such column，统一由 scripts/rebuild_customers.js 建
CREATE TABLE IF NOT EXISTS customers (
  customer_id        INTEGER PRIMARY KEY AUTOINCREMENT,   -- 系统列：orders.customer_id 外键依赖
  customer_code      TEXT,                                -- ① 货主代码（选填；已去掉 UNIQUE）
  company_name       TEXT NOT NULL,                        -- ② 公司全称（必填；已去掉 UNIQUE）
  short_name         TEXT,                              -- ③ 客户简称
  warehouse          TEXT NOT NULL DEFAULT '',           -- ④ 所在仓库（必填，多仓逗号拼接）
  contact_person     TEXT,                              -- ⑤ 客户联系人
  phone              TEXT,                              -- ⑥ 联系电话
  address            TEXT,                              -- ⑦ 客户地址
  erp_version        TEXT,                              -- ⑧ ERP版本名称
  product_type       TEXT,                              -- ⑨ 产品类型
  ecommerce_platform TEXT,                             -- ⑩ 电商平台
  product_count      INTEGER NOT NULL DEFAULT 0,        -- ⑪ 商品种类数
  payment_account    TEXT,                              -- ⑫ 打款账户
  prepaid_price      REAL NOT NULL DEFAULT 0,           -- ⑬ 预充单价（应用层 round3）
  cutoff_time        TEXT,                              -- ⑭ 截单时间 'HH:mm'
  logistics_control  TEXT,                              -- ⑮ 物流公司控制
  expiry_mgmt        TEXT NOT NULL DEFAULT '否',        -- ⑯ 效期管理 '是'/'否'
  coop_status        TEXT NOT NULL DEFAULT '合作中',     -- ⑰ 合作状态
  remark             TEXT,                              -- ⑱ 备注
  customer_type      TEXT NOT NULL DEFAULT '仓储客户',  -- 分类：仓储客户/共享单号/快运物流
  sort_order         INTEGER NOT NULL DEFAULT 9999,       -- 排序号：前端列表按 ASC 展示；默认 9999 排最后
  default_unit       TEXT NOT NULL DEFAULT '单',            -- 默认单位：发货工时列表客户自动带出（"单"/"箱"/"件"等）；用户可手动改
  owner_user_id      INTEGER REFERENCES users(user_id),  -- 系统列：rbac ownerScope 依赖
  is_deleted         INTEGER NOT NULL DEFAULT 0,        -- 软删除标记：1=已删除（行保留，关联与历史不丢）
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 分仓独立排序配置（每个仓库对同一份客户列表有独立的 sort_order 映射）
-- 查询时 warehouse_sort_config 优先，缺失行回退 customers.sort_order，再缺失回退 9999
CREATE TABLE IF NOT EXISTS warehouse_sort_config (
  warehouse    TEXT NOT NULL,
  customer_id  INTEGER NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL DEFAULT 9999,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (warehouse, customer_id)
);

-- 导入订单
CREATE TABLE IF NOT EXISTS orders (
  order_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no       TEXT NOT NULL,           -- 订单号
  customer_id    INTEGER NOT NULL REFERENCES customers(customer_id),
  owner_name     TEXT NOT NULL,           -- 货主名称
  ship_quantity  REAL NOT NULL,           -- 发货量
  unit           TEXT NOT NULL,           -- 单位
  order_date     TEXT NOT NULL,           -- 订单日期
  payment_status TEXT NOT NULL DEFAULT '未收',  -- 未收 / 部分 / 已收
  waybill_type   TEXT,                    -- 电子面单类型（快递公司名称，经 express_map 映射）
  owner_user_id  INTEGER REFERENCES users(user_id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 出入库流水（库存台账的唯一数据源）
CREATE TABLE IF NOT EXISTS inventory_transactions (
  transaction_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER REFERENCES orders(order_id),  -- 可空：期初/调整可独立存在
  owner_name      TEXT NOT NULL,          -- 货主名称
  quantity        REAL NOT NULL,          -- 数量（正数）
  direction       TEXT NOT NULL,          -- 入 / 出
  reference_type  TEXT NOT NULL,          -- purchase / sale / initial / adjustment
  business_date   TEXT NOT NULL,          -- 业务日期
  remark          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 工时记录（深度重构：四大仓库 × 四类工时）
-- 维度：warehouse(龙湖仓/佳新仓/速远仓/开元仓) × work_type(发货/收货/库内/后勤)
CREATE TABLE IF NOT EXISTS work_hours (
  work_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse      TEXT NOT NULL,                 -- 仓库（龙湖仓/佳新仓/速远仓/开元仓）
  work_type      TEXT NOT NULL,                 -- 工时类型（发货/收货/库内/后勤）
  customer_id    INTEGER,                       -- 客户关联 id（软关联 customers.customer_id；改名后历史名字随之更新）
  customer_name  TEXT,                          -- 客户名称快照（兼容历史纯文本；展示时优先取关联客户的最新名）
  unit           TEXT,                          -- 单位（件/箱/托/公斤）
  date           TEXT NOT NULL,                 -- 日期 YYYY-MM-DD
  ship_orders    REAL,                          -- 发货单量（发货）
  cartons        REAL,                          -- 箱数（收货）
  tons           REAL,                          -- 吨（收货）
  cubic          REAL,                          -- 方（收货）
  pallets        REAL,                          -- 托盘（收货）
  workload       REAL,                          -- 作业量（库内录入；可空，看板库内数量优先取它）
  project        TEXT,                          -- 项目（库内/后勤下拉）
  main_hours     REAL NOT NULL DEFAULT 0,        -- 主工时（小时）
  other_hours    REAL NOT NULL DEFAULT 0,        -- 其他工时（小时）
  shared_hours   REAL NOT NULL DEFAULT 0,        -- 公摊工时（小时；总工时=主+其他+公摊，后续补充公摊数据）
  total_hours    REAL NOT NULL DEFAULT 0,        -- 总工时（派生，入库存储，3 位）
  efficiency     REAL,                          -- 时效（发货:发货单量/主工时；收货:箱数/主工时）
  unit_cost      REAL,                          -- 单均成本（发货:总工时/发货单量）
  doc_cost       REAL,                          -- 单据成本（收货:总工时/箱数）
  remark         TEXT,                          -- 备注
  status         TEXT NOT NULL DEFAULT 'pending',-- 归档状态：pending 待提交/未归档、archived 已归档；历史行默认 pending
  submitter      TEXT,                          -- 提交人（点击「提交」时的登录用户名字快照；未提交为 NULL）
  submit_time    TEXT,                          -- 提交归档时间（datetime('now','localtime')；撤回后清空）
  owner_user_id  INTEGER REFERENCES users(user_id),  -- 行级隔离（沿用阶段5）
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_wh_type ON work_hours(warehouse, work_type);
CREATE INDEX IF NOT EXISTS idx_wh_date  ON work_hours(date);
CREATE INDEX IF NOT EXISTS idx_wh_cust  ON work_hours(customer_name);

-- 审计日志（日志中心）
--  * 前 8 列为历史列，结构/取值保持不变，旧代码与旧测试继续可用；
--    新增 8 列为日志中心标准字段，写入时「新旧双写」，读走 v_audit_logs 视图。
--  * 旧库缺列时由 src/db/migrateAuditLogs.js 幂等 ADD COLUMN + 回填；
--    本文件仅定义「全新库」的完整结构，绝不在旧库上重建或改列。
--  * 相关索引不在本文件创建（旧库执行会报 no such column），统一由迁移脚本建。
CREATE TABLE IF NOT EXISTS audit_logs (
  log_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  operator       TEXT NOT NULL,           -- 历史列：操作人（username）
  operated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  table_name     TEXT NOT NULL,
  record_id      TEXT NOT NULL,
  action         TEXT NOT NULL,           -- 历史列：create / update / delete / import
  before_summary TEXT,                    -- 历史列：修改前摘要（JSON 文本）
  after_summary  TEXT,                    -- 历史列：修改后摘要（JSON 文本）
  id             INTEGER,                 -- 标准列：恒等于 log_id（触发器 + 回填保证）
  user_id        INTEGER,                 -- 标准列：操作人 ID（历史无对应用户时为 NULL）
  user_name      TEXT,                    -- 标准列：操作人名称
  module         TEXT NOT NULL DEFAULT '历史未知操作',  -- 标准列：所属业务模块
  target_id      TEXT,                    -- 标准列：被操作的数据 ID
  content        TEXT,                    -- 标准列：{"before":…,"after":…} JSON 对比
  ip_address     TEXT NOT NULL DEFAULT '',
  created_at     TEXT                     -- 标准列：恒等于 operated_at
);

-- 菜单/关联索引（menus/role_menus 建表后才创建，旧库由 migrate_rbac.js 统一处理）
CREATE INDEX IF NOT EXISTS idx_menu_par ON menus(parent_id, sort);
CREATE INDEX IF NOT EXISTS idx_rm_menu  ON role_menus(menu_id);

-- 物流报价表（基础资料 → 物流报价）：维护各快递网点的计费规则
--   * price_rules 存 JSON 文本（应用层 JSON.stringify/parse），结构：
--     [{"min":0,"max":1,"price":2.5}, {"min":1,"max":3,"price":4.0}]
--   * volume_ratio 抛比：体积转重除数整数（6000/8000/12000…）
--   * express_code 为网点唯一编码（如「中通-杭州网点」），UNIQUE 防重
-- 物流报价（基础资料 → 物流报价）：维护各快递网点计费规则
--   * 同一快递编码可按「省/市/区」拆成多行区域报价
--   * price_rules 存阶梯报价 JSON：[{weight, price}]（1-40kg 离散，空重量段不入库）
CREATE TABLE IF NOT EXISTS logistics_quotes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  network_name  TEXT NOT NULL,                       -- 网点名称
  express_code  TEXT NOT NULL,                       -- 快递编码（同一编码可有多个区域行）
  province      TEXT NOT NULL DEFAULT '',            -- 省（区域匹配维度）
  city          TEXT NOT NULL DEFAULT '',            -- 市
  district      TEXT NOT NULL DEFAULT '',            -- 区/县
  volume_ratio  INTEGER NOT NULL DEFAULT 6000,       -- 抛比
  price_rules   TEXT NOT NULL DEFAULT '[]',          -- 阶梯报价 JSON：[{weight, price}]
  remark        TEXT,                                -- 备注
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (express_code, province, city, district)     -- 唯一键：编码 + 省市区（空串参与区分）
);

-- 应用级键值配置（存储智能测单等模块的系统级配置，如测算起步重量 / 面单类型白名单）
--   * key 唯一；value 存 JSON 文本，由业务层 JSON.stringify/parse
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 智能测单：历史测算批次（每次 Excel 上传生成一个批次，便于回溯）
CREATE TABLE IF NOT EXISTS smart_quote_batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_name   TEXT NOT NULL,                        -- 批次名称（默认 文件名 + 时间，或用户命名）
  source_type  TEXT NOT NULL DEFAULT 'excel',        -- excel / manual
  file_name    TEXT,                                 -- 上传文件名
  total_count  INTEGER NOT NULL DEFAULT 0,           -- 本批次明细行数
  operator     TEXT NOT NULL,                        -- 上传人 username
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 智能测单：历史测算明细（每个批次下的每行测算结果）
CREATE TABLE IF NOT EXISTS smart_quote_records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          INTEGER NOT NULL REFERENCES smart_quote_batches(id) ON DELETE CASCADE,
  so_no             TEXT,                            -- SO 单号
  owner_name        TEXT,                            -- 货主名称
  waybill_type      TEXT,                            -- 电子面单类型
  province          TEXT,                            -- 省份
  city              TEXT,                            -- 城市
  district          TEXT NOT NULL DEFAULT '',        -- 县区（区/县，区→市→省降级匹配维度）
  estimated_weight  REAL NOT NULL DEFAULT 0,         -- 预估重量(kg)
  total_volume      REAL NOT NULL DEFAULT 0,         -- 总体积(立方米)
  volumetric_weight REAL NOT NULL DEFAULT 0,         -- 抛比重量
  billing_weight    REAL NOT NULL DEFAULT 0,         -- 计费重量
  recommended_code  TEXT,                            -- 推荐快递编码
  recommended_price REAL NOT NULL DEFAULT 0,         -- 推荐总价
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sqr_batch ON smart_quote_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_sqr_so    ON smart_quote_records(so_no);

-- 偏远地区设置：以快递公司为维度的大偏远 / 小偏远 / 正常区域
--   * city/district 为空串表示「全省 / 全市」
--   * 同一快递公司下，同一区域只能属于一个分类（服务层校验）
CREATE TABLE IF NOT EXISTS express_region_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  carrier      TEXT NOT NULL,
  region_class TEXT NOT NULL CHECK(region_class IN ('大偏远','小偏远','正常')),
  province     TEXT NOT NULL,
  city         TEXT NOT NULL DEFAULT '',
  district     TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (carrier, region_class, province, city, district)
);

CREATE INDEX IF NOT EXISTS idx_express_region_carrier ON express_region_rules(carrier, region_class);
