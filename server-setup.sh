#!/bin/sh
# ============================================================================
#  佐雍云仓数据中心 —— 自有服务器一键部署（Ubuntu 22.04 / 24.04，root 执行）
#  用法：GITHUB_TOKEN=<你的PAT> sh server-setup.sh
#  说明：
#   - 代码放 /opt/zyyc，数据放 /data/zyyc（云硬盘，重装/重启都不丢）
#   - Node 直接跑在 systemd 下，前端改动不需要构建、不需要重启（Express 实时读 public/）
#   - Nginx 反代 80 → 3000，只暴露 80/443
# ============================================================================
set -eu

REPO_HOST="github.com"
REPO_PATH="glr-cn/zyyc.git"
APP_DIR="/opt/zyyc"
DATA_DIR="/data/zyyc"
SERVICE="zyyc"
SECRET_FILE="/etc/zyyc.env"

[ "$(id -u)" = "0" ] || { echo "[错误] 请用 root 执行"; exit 1; }

echo "[1/7] 安装 Node.js 20 与基础组件"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get update -y
apt-get install -y git nginx ca-certificates curl

echo "[2/7] 拉取代码到 $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git clone "https://${GITHUB_TOKEN}@${REPO_HOST}/${REPO_PATH}" "$APP_DIR"
    git -C "$APP_DIR" remote set-url origin "https://${REPO_HOST}/${REPO_PATH}"
  else
    git clone "https://${REPO_HOST}/${REPO_PATH}" "$APP_DIR"
  fi
fi

echo "[3/7] 安装生产依赖"
cd "$APP_DIR"
npm ci --omit=dev --registry=https://registry.npmjs.org/

echo "[4/7] 准备数据目录与 JWT 密钥"
mkdir -p "$DATA_DIR/backups"
if [ ! -f "$SECRET_FILE" ]; then
  umask 077
  printf 'ERP_JWT_SECRET=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -d '\n')" > "$SECRET_FILE"
  echo "  已生成固定 JWT 密钥：$SECRET_FILE"
else
  echo "  复用已有 JWT 密钥：$SECRET_FILE"
fi

echo "[5/7] 注册 systemd 服务"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=ZYYC Cloud Warehouse ERP
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${SECRET_FILE}
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=ERP_DB_PATH=${DATA_DIR}/erp.db
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE"

echo "[6/7] 配置 Nginx 反向代理"
cat > /etc/nginx/sites-available/zyyc <<'EOF'
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/zyyc /etc/nginx/sites-enabled/zyyc
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "[7/7] 配置每日自动备份"
cat > /etc/cron.daily/zyyc-backup <<EOF
#!/bin/sh
mkdir -p ${DATA_DIR}/backups
cp ${DATA_DIR}/erp.db ${DATA_DIR}/backups/erp-\$(date +%Y%m%d).db 2>/dev/null || true
find ${DATA_DIR}/backups -name 'erp-*.db' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/zyyc-backup

IP=$(curl -s --max-time 5 https://api.ipify.org || echo "你的公网IP")
echo ""
echo "================ 部署完成 ================"
echo "访问地址：http://${IP}/"
echo "健康检查：http://${IP}/api/health"
echo "数据文件：${DATA_DIR}/erp.db"
echo "服务管理：systemctl status ${SERVICE} / journalctl -u ${SERVICE} -f"
echo "=========================================="
