-- ============================================================================
--  audit_logs 安全升级 SQL（SQLite / 佐雍云仓数据中心 · 日志中心）
--  执行器：src/db/migrateAuditLogs.js（按「-- @@」分段执行，逐列判断，幂等、事务化）
--  入口：node scripts/migrate_audit_logs.js   或   服务启动时 src/db/index.js 自动执行
--
--  【数据完整性铁律】
--   1. 只做 ADD COLUMN / 回填「新增列」/ 建索引 / 建视图 / 建触发器；
--   2. 绝不 DROP TABLE、绝不 RENAME COLUMN、绝不 UPDATE 或 DELETE 任何历史列；
--      audit_logs 原有 8 列（log_id / operator / operated_at / table_name /
--      record_id / action / before_summary / after_summary）保持逐字节不变，
--      旧代码、旧测试脚本（校验 action='create|update|delete'）继续可用；
--   3. 旧行只补新列，缺失来源一律落 '历史未知操作' / 空串，绝不编造业务数据；
--   4. 全事务执行，迁移前记录历史列指纹，迁移后校验行数/指纹/字段/主键/视图，
--      任一不符即 ROLLBACK。
--
--  历史表原结构：
--    log_id INTEGER PK, operator TEXT NOT NULL, operated_at TEXT NOT NULL,
--    table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL,
--    before_summary TEXT, after_summary TEXT
--  目标标准字段（本文件新增）：
--    id, user_id, user_name, module, action(已存在), target_id,
--    content, ip_address, created_at
--  说明：action 列已存在，值为受控英文枚举 create/update/delete/import。
--        为不改动任何历史数据，中文「新增/修改/删除/导入」由 v_audit_logs
--        视图统一映射输出（详见文件末尾），查询与页面均基于该视图。
-- ============================================================================

-- ① 逐列新增。迁移器按 PRAGMA table_info 判断，已存在则跳过 → 可重复执行。
ALTER TABLE audit_logs ADD COLUMN id INTEGER;
-- @@
ALTER TABLE audit_logs ADD COLUMN user_id INTEGER;
-- @@
ALTER TABLE audit_logs ADD COLUMN user_name TEXT;
-- @@
ALTER TABLE audit_logs ADD COLUMN module TEXT NOT NULL DEFAULT '历史未知操作';
-- @@
ALTER TABLE audit_logs ADD COLUMN target_id TEXT;
-- @@
ALTER TABLE audit_logs ADD COLUMN content TEXT;
-- @@
ALTER TABLE audit_logs ADD COLUMN ip_address TEXT NOT NULL DEFAULT '';
-- @@
ALTER TABLE audit_logs ADD COLUMN created_at TEXT;
-- @@

-- ② 旧数据回填：所有 UPDATE 只写「新增列」，历史列一字节不动。
--    id 与 log_id 严格一一对应，created_at 与 operated_at 严格一致，避免错位。
UPDATE audit_logs SET id = log_id WHERE id IS NULL;
-- @@
UPDATE audit_logs SET user_name = operator WHERE user_name IS NULL;
-- @@
UPDATE audit_logs SET created_at = operated_at WHERE created_at IS NULL;
-- @@
UPDATE audit_logs SET target_id = record_id WHERE target_id IS NULL;
-- @@
UPDATE audit_logs SET
  user_id = COALESCE(user_id, (SELECT u.user_id FROM users u WHERE u.username = audit_logs.operator LIMIT 1))
WHERE user_id IS NULL;
-- @@
-- 历史 IP 无法追溯，落空串（不编造、不置 NULL）
UPDATE audit_logs SET ip_address = '' WHERE ip_address IS NULL;
-- @@

-- ③ module 回填：按原 table_name 做确定性语义映射（不是编造），
--    映射不到的旧数据按需求落 '历史未知操作'。
--    与 src/services/auditLog.js 的 MODULE_BY_TABLE 保持一致。
UPDATE audit_logs SET module =
  CASE table_name
    WHEN 'customers'              THEN '客户资料'
    WHEN 'work_hours'             THEN '工时管理'
    WHEN 'logistics_quotes'       THEN '物流报价'
    WHEN 'smart_quote_batches'    THEN '智能测单'
    WHEN 'smart_quote_records'    THEN '智能测单'
    WHEN 'smart_quote'            THEN '智能测单'
    WHEN 'app_settings'           THEN '智能测单'
    WHEN 'users'                  THEN '系统/权限'
    WHEN 'roles'                  THEN '系统/权限'
    WHEN 'role_menus'             THEN '系统/权限'
    WHEN 'menus'                  THEN '系统/权限'
    WHEN 'orders'                 THEN '其他业务'
    WHEN 'inventory_transactions' THEN '其他业务'
    ELSE '历史未知操作'
  END
WHERE module IS NULL OR module = '' OR module = '历史未知操作';
-- @@

-- ④ content 回填：把原 before_summary / after_summary 组装成标准对比 JSON
--    {"before": {...}|null, "after": {...}|null}；json_valid 守卫非法文本，
--    不会因历史脏字符串导致迁移报错。原两列保持原样。
UPDATE audit_logs SET content = json_object(
  'before', CASE WHEN before_summary IS NOT NULL AND json_valid(before_summary) THEN json(before_summary) ELSE NULL END,
  'after',  CASE WHEN after_summary  IS NOT NULL AND json_valid(after_summary)  THEN json(after_summary)  ELSE NULL END
) WHERE content IS NULL;
-- @@

-- ⑤ 查询索引（只加速，不改变数据）
CREATE INDEX IF NOT EXISTS idx_audit_module_time ON audit_logs(module, created_at);
-- @@
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
-- @@
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
-- @@

-- ⑥ 兼容触发器：任何遗漏的旧式 INSERT 也会自动补齐 id = log_id，
--    保证新旧写入路径下「id 与 log_id」永不错位（元数据操作，不动数据）。
DROP TRIGGER IF EXISTS trg_audit_logs_id;
-- @@
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_id
AFTER INSERT ON audit_logs
WHEN NEW.id IS NULL
BEGIN
  UPDATE audit_logs SET id = NEW.log_id WHERE log_id = NEW.log_id;
END;
-- @@

-- ⑦ 标准读视图：日志中心唯一数据源。
--    字段名与需求完全对齐：id / user_id / user_name / module / action /
--    target_id / content / ip_address / created_at；action 输出中文枚举。
--    所有字段都有 COALESCE 兜底，即使出现漏填也不会出现空值或断链。
DROP VIEW IF EXISTS v_audit_logs;
-- @@
CREATE VIEW v_audit_logs AS
SELECT
  COALESCE(a.id, a.log_id) AS id,
  COALESCE(a.user_id, (SELECT u.user_id FROM users u WHERE u.username = a.operator LIMIT 1)) AS user_id,
  COALESCE(a.user_name, a.operator) AS user_name,
  CASE
    WHEN a.module IS NOT NULL AND a.module <> '' AND a.module <> '历史未知操作' THEN a.module
    ELSE CASE a.table_name
      WHEN 'customers'              THEN '客户资料'
      WHEN 'work_hours'             THEN '工时管理'
      WHEN 'logistics_quotes'       THEN '物流报价'
      WHEN 'smart_quote_batches'    THEN '智能测单'
      WHEN 'smart_quote_records'    THEN '智能测单'
      WHEN 'smart_quote'            THEN '智能测单'
      WHEN 'app_settings'           THEN '智能测单'
      WHEN 'users'                  THEN '系统/权限'
      WHEN 'roles'                  THEN '系统/权限'
      WHEN 'role_menus'             THEN '系统/权限'
      WHEN 'menus'                  THEN '系统/权限'
      WHEN 'orders'                 THEN '其他业务'
      WHEN 'inventory_transactions' THEN '其他业务'
      ELSE '历史未知操作'
    END
  END AS module,
  CASE a.action
    WHEN 'create' THEN '新增'
    WHEN 'update' THEN '修改'
    WHEN 'delete' THEN '删除'
    WHEN 'import' THEN '导入'
    WHEN 'submit' THEN '提交归档'
    WHEN 'withdraw' THEN '撤回'
    WHEN 'archive' THEN '归档'
    WHEN '新增' THEN '新增'
    WHEN '修改' THEN '修改'
    WHEN '删除' THEN '删除'
    WHEN '导入' THEN '导入'
    WHEN '提交' THEN '提交归档'
    WHEN '撤回' THEN '撤回'
    WHEN '归档' THEN '归档'
    ELSE '历史未知操作'
  END AS action,
  COALESCE(a.target_id, a.record_id) AS target_id,
  COALESCE(a.content, json_object(
    'before', CASE WHEN a.before_summary IS NOT NULL AND json_valid(a.before_summary) THEN json(a.before_summary) ELSE NULL END,
    'after',  CASE WHEN a.after_summary  IS NOT NULL AND json_valid(a.after_summary)  THEN json(a.after_summary)  ELSE NULL END
  )) AS content,
  COALESCE(a.ip_address, '') AS ip_address,
  COALESCE(a.created_at, a.operated_at) AS created_at,
  a.action AS action_raw,
  a.log_id, a.operator, a.operated_at, a.table_name, a.record_id,
  a.before_summary, a.after_summary
FROM audit_logs a;
-- @@
