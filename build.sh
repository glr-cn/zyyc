#!/bin/sh
set -eu

export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'
npm ci --registry='https://registry.npmjs.org/'
npm prune --omit=dev
mkdir -p dist
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
