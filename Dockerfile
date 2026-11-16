# 佐雍云仓数据中心 —— Node 20 运行镜像
# 与线上验证过的运行时一致；数据库驱动自动回退 node-sqlite3-wasm（见 src/db/driver.js）。
# 数据不放在镜像里：通过持久卷挂载到 /data，重发布/重启都不会丢。
FROM node:20-alpine

WORKDIR /app

# 数据目录固定为 /data（由平台持久卷挂载覆盖），JWT 密钥也建议用 ERP_JWT_SECRET 环境变量固定
ENV NODE_ENV=production \
    PORT=3000 \
    ERP_DB_PATH=/data/erp.db

# 先装依赖，利用层缓存（锁定版本，官方源）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmjs.org/ \
 && npm cache clean --force

# 只发布运行所需代码
COPY src ./src
COPY public ./public

# 持久卷挂载点（卷由平台创建并挂载；这里保证目录存在）
RUN mkdir -p /data/backups

EXPOSE 3000

# 健康检查直接打业务自检接口（会返回库路径/表数量/业务行数）
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 说明：不切换非 root 用户，避免持久卷由 root 创建后应用无写权限；
# 如需加固，请在平台侧以指定 UID 挂载卷后再补 USER 指令。
CMD ["node", "src/server.js"]
