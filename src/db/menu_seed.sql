-- ============================================================
--  初始化菜单数据（RBAC：唯一维护点）
--  以后新增菜单 / 子菜单：在本文件追加一行（新页面上线把 is_built 改 1），
--  重跑 scripts/migrate_rbac.js（幂等）即可；超级管理员自动获得新菜单权限。
--  约定：parent_id IS NULL = 主菜单（容器，path 为 NULL 除「看板」直达）；
--        group_name 对应前端飞出面板分组标题，不参与授权。
-- ============================================================

-- 主菜单（sort 决定左侧顺序）
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (1,'dashboard',NULL,'看板','dashboard','📉',NULL,10,1),
 (2,'outbound', NULL,'出库',NULL,'📦',NULL,20,1),
 (3,'inbound',  NULL,'入库',NULL,'📥',NULL,30,1),
 (4,'inventory',NULL,'库存',NULL,'📊',NULL,40,1),
 (5,'master',   NULL,'基础资料',NULL,'📁',NULL,50,1),
 (6,'work',     NULL,'工时',NULL,'⏱️',NULL,60,1),
 (7,'docs',     NULL,'单据',NULL,'🧾',NULL,70,1);

-- 出库
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (101,'ob_orders',2,'订单导入','orders',NULL,'单据',10,1),
 (102,'ob_bill',2,'出库单',NULL,NULL,'单据',20,0),
 (103,'ob_waybill',2,'面单打印',NULL,NULL,'打单',30,0),
 (104,'ob_batch',2,'批次打单',NULL,NULL,'打单',40,0),
 (105,'ob_pick',2,'拣货任务',NULL,NULL,'拣货',50,0),
 (106,'ob_pick_confirm',2,'拣货确认',NULL,NULL,'拣货',60,0),
 (107,'ob_check',2,'验货复核',NULL,NULL,'验货',70,0),
 (108,'ob_handover',2,'发货交接',NULL,NULL,'发货',80,0),
 (109,'ob_track',2,'物流跟踪',NULL,NULL,'发货',90,0),
 (110,'ob_wrong',2,'错发漏发',NULL,NULL,'异常处理',100,0),
 (111,'ob_return',2,'退货登记',NULL,NULL,'异常处理',110,0);

-- 入库
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (201,'ib_forecast',3,'到货预报',NULL,NULL,'到货',10,0),
 (202,'ib_reg',3,'到货登记',NULL,NULL,'到货',20,0),
 (203,'ib_confirm',3,'收货确认',NULL,NULL,'收货',30,0),
 (204,'ib_putaway',3,'上架任务',NULL,NULL,'上架',40,0),
 (205,'ib_location',3,'库位调整',NULL,NULL,'上架',50,0),
 (206,'ib_qc',3,'入库质检',NULL,NULL,'质检',60,0),
 (207,'ib_damage',3,'破损登记',NULL,NULL,'异常处理',70,0);

-- 库存
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (301,'iv_ledger',4,'库存台账','inventory',NULL,'库存查询',10,1),
 (302,'iv_initial',4,'期初导入',NULL,NULL,'库存调整',20,0),
 (303,'iv_count',4,'库存盘点',NULL,NULL,'库存调整',30,0);

-- 基础资料（客户 + 权限）
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (401,'cust_wh',5,'仓储客户','cust_wh',NULL,'客户',10,1),
 (402,'cust_shared',5,'共享单号','cust_shared',NULL,'客户',20,1),
 (403,'cust_express',5,'快运物流','cust_express',NULL,'客户',30,1),
 (404,'users',5,'用户管理','users',NULL,'权限',40,1),
 (405,'roles',5,'角色权限','roles',NULL,'权限',50,1),
 (406,'logi_quotes',5,'物流报价','logi_quotes',NULL,'物流',10,1);

-- 工时
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (501,'wh_lh',6,'龙湖仓工时管理','wh_lh',NULL,'录入',10,1),
 (502,'wh_jx',6,'佳新仓工时管理','wh_jx',NULL,'录入',20,1),
 (503,'wh_sy',6,'速远仓工时管理','wh_sy',NULL,'录入',30,1),
 (504,'wh_ky',6,'开元仓工时管理','wh_ky',NULL,'录入',40,1),
 (505,'analytics',6,'工时汇总','analytics',NULL,'汇总',50,1);

-- 单据
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (701,'smart_quote',7,'智能测算','smart_quote','🧮','测算',10,1);

-- 日志中心（父级为纯容器，path=NULL 不放行路由；权限只看子菜单 path）
-- 前 5 个子菜单与业务模块一一对应，各页只查 module=对应值；
-- log_all 为跨模块汇总页，保证「其他业务」「历史未知操作」等日志同样可见、不丢数据。
-- menu_code / path 必须与 public/js/tabs.js 的 ERP.PAGE_META、
-- public/js/log-center.js 的 window.ERP_PAGES 键完全一致，否则前端 403。
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (8,'logs',NULL,'日志中心',NULL,'📜',NULL,80,1);

INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (801,'log_customer', 8,'客户资料日志','log_customer', NULL,'业务日志',10,1),
 (802,'log_workhours',8,'工时管理日志','log_workhours',NULL,'业务日志',20,1),
 (803,'log_logistics',8,'物流报价日志','log_logistics',NULL,'业务日志',30,1),
 (804,'log_smartquote',8,'智能测单日志','log_smartquote',NULL,'业务日志',40,1),
 (805,'log_system',   8,'系统/权限日志','log_system',   NULL,'系统日志',50,1),
 (806,'log_all',      8,'全部日志',    'log_all',      NULL,'汇总',    60,1);

-- 快捷工具（父级为纯容器；子菜单上线前 is_built=0 → 面板置灰提示「功能建设中」）
INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (9,'tools',NULL,'快捷工具',NULL,'🧰',NULL,90,1);

INSERT OR IGNORE INTO menus (menu_id,menu_code,parent_id,menu_name,path,icon,group_name,sort,is_built) VALUES
 (901,'tool_split_no',9,'分列单号',  'tool_split_no',NULL,'工具',10,1),
 (902,'tool_barcode', 9,'条码设计',  'tool_barcode', NULL,'工具',20,1),
 (903,'tool_img2file',9,'图片转文件','tool_img2file',NULL,'工具',30,0);
