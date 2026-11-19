#!/bin/sh
set -eu

export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'
npm ci --registry='https://registry.npmjs.org/'
npm prune --omit=dev
mkdir -p dist

# 【永久规则 1】生成构建版本号（git short SHA + Unix timestamp）
# 后端 src/version.js 启动时会读根目录或 dist/version.json，作为当前代码身份标识，
# 每个 JSON 响应自动追加 _build_version 字段 → 前端据此判断是否需要刷新。
# 【永久规则 2】绝对不删除任何 .db / .sqlite 文件（build.sh 本身就不处理数据目录）
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
TS=$(date +%s)
VJ="{\"build_version\":\"${SHA}-${TS}\",\"build_time\":\"$(date -Iseconds)\"}"
echo "$VJ" > version.json
echo "$VJ" > dist/version.json

cp run.sh dist/
cp package.json dist/
cp package-lock.json dist/
cp -R src dist/src
cp -R public dist/public
cp -R node_modules dist/node_modules

# 恢复备份（若存在）：打进 dist/data/，run.sh 启动时注入持久目录
if [ -f data/erp.restore-from-local.db ]; then
  mkdir -p dist/data
  cp data/erp.restore-from-local.db dist/data/
fi

chmod 755 dist/run.sh
