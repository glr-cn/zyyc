#!/bin/sh
# ============================================================================
#  每日备份总入口（供 /etc/cron.daily/zyyc-backup 调用）
#   1) 一致性快照：node scripts/backup_db.js（VACUUM INTO + integrity_check）
#   2) 异地同步：配置 BACKUP_RCLONE_REMOTE 后，用 rclone 把最近 25 小时的快照
#      推到对象存储（腾讯云 COS / 阿里云 OSS / S3 均兼容）
#
#  配置：在 /etc/zyyc.env 增加
#      BACKUP_RCLONE_REMOTE=cos:zyyc-backup
#      BACKUP_KEEP=30
#  日志：/data/zyyc/backups/backup.log
# ============================================================================
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

APP_DIR=${APP_DIR:-/opt/zyyc}
ENV_FILE=${ENV_FILE:-/etc/zyyc.env}
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${ERP_DB_PATH:=/data/zyyc/erp.db}"
export ERP_DB_PATH

BACKUPS_DIR=$(dirname "$ERP_DB_PATH")/backups
NOW=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$NOW] ---- backup start ----"
cd "$APP_DIR" || { echo "[$NOW] 应用目录不存在：$APP_DIR"; exit 1; }

if ! node scripts/backup_db.js; then
  echo "[$NOW] 本地快照失败，跳过异地同步"
  exit 1
fi

# 异地同步（可选）：只推 25 小时内新增/变化的快照，避免每天全量重传
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    if rclone copy "$BACKUPS_DIR" "$BACKUP_RCLONE_REMOTE" \
        --include 'erp-*.db' --max-age 25h --no-traverse --quiet; then
      echo "[$NOW] 异地同步完成 -> $BACKUP_RCLONE_REMOTE"
    else
      echo "[$NOW] 异地同步失败（本地快照已保留），请检查 rclone 配置/网络"
      exit 1
    fi
  else
    echo "[$NOW] 未安装 rclone，已跳过异地同步"
  fi
fi

echo "[$NOW] ---- backup done ----"
