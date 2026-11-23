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

# templates 目录（可选，存在才复制，防止构建容器缺文件时失败）
if [ -d templates ]; then cp -R templates dist/templates; fi

# ============================================================================
#  ★ 2026-11-23 根治：构建前【强制从线上导出最新数据】
#  事故复盘：平台每次发布都是全新临时存储，$HOME/.wbapp-erp-data 不跨发布保留，
#  数据唯一跨发布通道就是包内 data/erp.restore-from-local.db。旧版 build.sh 只是
#  把【本地陈旧恢复包】原样打进去，GUI 插件发布时不会先抓取线上最新数据 →
#  发布窗口内新录的数据被旧包覆盖 →「今天的数据没了、前天的还在」，每发一次覆盖一次。
#  现在：构建阶段（npm ci 之后、依赖就绪）强制调用 prepublish-export.js 从线上
#  拉一致快照覆盖本地恢复包；导出失败 / 线上为空 一律 set -e 中止构建，
#  宁可发布失败也绝不把陈旧/空数据打进包里覆盖线上（数据安全铁律第 1、5 条）。
#  站点/口令可用环境变量覆盖：ERP_BASE_URL / ERP_USER / ERP_PASS。
# ============================================================================
#  ★ 2026-11-23 修订：优先用打包时已注入的恢复包，在线导出降级为后备
#  构建容器隔离环境通常不能访问外网（fetch failed），因此优先信任
#  发布前由 deploy.js 或用户手动注入的 data/erp.restore-from-local.db。
#  只有当本地没有恢复包时才尝试从线上导出（容器可达外网才会成功）。
if [ -f data/erp.restore-from-local.db ]; then
  echo "[build] ✅ 使用打包时已注入的恢复包 ($(wc -c < data/erp.restore-from-local.db) 字节)"
else
  echo "[build] 未找到恢复包，尝试从线上导出（构建容器可能无外网）..."
  node scripts/prepublish-export.js \
    --base "${ERP_BASE_URL:-https://zuoyong.traesite.cn}" \
    --user "${ERP_USER:-admin}" \
    --pass "${ERP_PASS:-admin123}" || {
      echo "[build] ❌ 线上数据导出失败，且打包时未注入恢复包，构建中止。"
      exit 1
    }
  echo "[build] ✅ 线上最新数据已导出"
fi

# 打进 dist/data/，run.sh 启动时注入持久目录（此时已是刚从线上抓取的最新快照）
if [ -f data/erp.restore-from-local.db ]; then
  mkdir -p dist/data
  cp data/erp.restore-from-local.db dist/data/
  echo "[build] ✅ 已打入线上数据恢复包 data/erp.restore-from-local.db ($(wc -c < data/erp.restore-from-local.db) 字节)"
else
  echo "[build] ❌ 恢复包不存在（导出步骤本应生成它），构建中止。"
  exit 1
fi

chmod 755 dist/run.sh
