#!/bin/sh
# ============================================================================
#  佐雍云仓数据中心 —— 自有服务器快速更新（root 执行）
#  用法：sh server-update.sh
#  规则：
#   - 只有前端（public/）改动：git pull 即生效，不重启、不构建（Express 每次请求实时读文件）
#   - 后端（src/）或依赖改动：自动重装依赖并重启，约 3-5 秒
#   - 数据库始终在 /data/zyyc，不受更新影响
# ============================================================================
set -eu

APP_DIR="/opt/zyyc"
SERVICE="zyyc"

[ "$(id -u)" = "0" ] || { echo "[错误] 请用 root 执行"; exit 1; }

cd "$APP_DIR"
BEFORE=$(git rev-parse HEAD)
git pull --ff-only
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "已是最新代码，无需更新"
  exit 0
fi

CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")

echo "本次更新文件："
echo "$CHANGED" | sed 's/^/  /'

if echo "$CHANGED" | grep -qE '^(package\.json|package-lock\.json|src/|server\.js)'; then
  echo "检测到后端或依赖变更 → 安装依赖并重启"
  npm ci --omit=dev --registry=https://registry.npmjs.org/
  systemctl restart "$SERVICE"
  sleep 2
else
  echo "仅前端改动 → 无需重启，浏览器刷新即可"
fi

systemctl is-active "$SERVICE" >/dev/null && echo "服务状态：running" || echo "服务状态：异常，请查看 journalctl -u $SERVICE"
