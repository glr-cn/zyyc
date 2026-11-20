#!/bin/sh
# ============================================================================
#  【永久规则 2·铁律】本脚本绝对不删除 / 覆盖持久目录里的业务数据！
#  持久目录 ~/.wbapp-erp-data/ 存放：
#    - erp.db          主业务库（代码包之外，跨发布永久保存）
#    - backups/*.db    自动快照（6h 定时，保留最近 1 份）
#    - jwt.secret      JWT 签名密钥（跨发布保持一致，token 不失效）
#    - logs/           运行日志
#  规则细节：
#    A. 绝不执行 rm / -rf / truncate 任何 $PERSIST_DIR 下的文件
#    B. 绝不执行 VACUUM INTO 持久目录（那是只读快照导出，不会删原库）
#    C. 空库自愈只有「持久库业务表全空」时才触发恢复——正常运行的线上库
#       业务行 > 0 → 即使包里带了新备份也绝不覆盖持久库
#    D. 每次发布都是在**现有数据之上增量部署**，不是干净重建
#
#  【永久规则 1】启动时 src/version.js 会读根目录 version.json，
#  把 build_version 注入所有 JSON 响应。前端据此判断是否弹"系统已更新，请刷新"。
#  【绝不踢用户下线】——JWT 有效期 12h + jwt.secret 持久化 → 跨发布保持登录。
# ============================================================================
cd "$(dirname "$0")"

PERSIST_DIR="${HOME}/.wbapp-erp-data"
PERSIST_DB="${PERSIST_DIR}/erp.db"
BUNDLE_BACKUP="./data/erp.restore-from-local.db"

# 先确保持久目录存在（run.sh 比 Node 早跑，此时 fs.mkdirSync 还没机会创建）
mkdir -p "$PERSIST_DIR"

if [ -f "$BUNDLE_BACKUP" ]; then
  # 持久目录存在，但 erp.db 可能还没被创建（首次启动）
  if [ ! -f "$PERSIST_DB" ]; then
    # 还没生成过持久库：直接把备份放进去，跳过后续自愈也能用
    cp "$BUNDLE_BACKUP" "$PERSIST_DB"
    echo "[restore] 持久目录初始化为包内备份（之前从未启动成功过）"
  else
    # ★ 2026-11-20 加固：逐业务表行数裁决（src/db/restoreGuard.js）
    #   OK      → 数据完整，跳过注入
    #   EMPTY   → 业务表全空 → 注入（空库无需留档）
    #   STALE   → 任一业务表少于备份（部分丢失）→ 先留档原库再注入
    #   ERROR   → 保守跳过（宁可少恢复，绝不误覆盖现有数据）
    VERDICT=$(node src/db/restoreGuard.js "$PERSIST_DB" "$BUNDLE_BACKUP" 2>/dev/null || echo "ERROR:script")
    case "$VERDICT" in
      OK)
        echo "[restore] 持久库数据完整（逐表校验通过），跳过注入"
        ;;
      EMPTY)
        cp "$BUNDLE_BACKUP" "$PERSIST_DB"
        echo "[restore] 检测到持久库为空，已用包内备份覆盖（业务数据已注入）"
        ;;
      STALE*)
        TS=$(date +%Y%m%d%H%M%S)
        mkdir -p "$PERSIST_DIR/backups"
        cp "$PERSIST_DB" "$PERSIST_DIR/backups/erp-PRE-RESTORE-$TS.db"
        cp "$BUNDLE_BACKUP" "$PERSIST_DB"
        echo "[restore] 判定=STALE（部分表行数少于备份：疑似部分丢失），已恢复；原库留档 backups/erp-PRE-RESTORE-$TS.db"
        ;;
      *)
        echo "[restore] 校验异常（判定=$VERDICT），保守跳过注入（不覆盖现有持久库）"
        ;;
    esac
  fi
else
  echo "[restore] 持久目录或包内备份缺失（dir=$([ -d "$PERSIST_DIR" ] && echo ok || echo miss), backup=$([ -f "$BUNDLE_BACKUP" ] && echo ok || echo miss)），跳过注入"
fi

exec node src/server.js
