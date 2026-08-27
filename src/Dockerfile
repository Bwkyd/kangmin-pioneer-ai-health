# syntax=docker/dockerfile:1

# 构建阶段：安装完整依赖（含 dev）并编译 TypeScript；
# typescript、playwright 等 dev 依赖只存在于本阶段，不进入运行时镜像。
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# npm workspaces 的依赖归属由各包 manifest 决定；先复制 manifest，才能让
# 缓存层中的 npm ci 安装完整构建依赖，而不是只看根 package.json。
COPY apps/kangmin-admin/package.json ./apps/kangmin-admin/package.json
COPY apps/kangmin-api/package.json ./apps/kangmin-api/package.json
COPY apps/kangmin-cli/package.json ./apps/kangmin-cli/package.json
COPY apps/kangmin-miniprogram/package.json ./apps/kangmin-miniprogram/package.json
COPY packages/kangmin-core/package.json ./packages/kangmin-core/package.json
COPY packages/kangmin-database/package.json ./packages/kangmin-database/package.json
COPY packages/kangmin-integrations/package.json ./packages/kangmin-integrations/package.json
COPY packages/kangmin-runtime/package.json ./packages/kangmin-runtime/package.json
RUN npm ci
COPY . .
# 编译产物写入 dist/；随后按锁文件重装生产依赖，
# 保证 runner 阶段拿到的 node_modules 不含任何 dev 依赖。
RUN npm run build \
  && npm ci --omit=dev

# 运行阶段：只携带 dist/ 与生产 node_modules，以非 root 用户 node 运行。
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
# 容器内监听全部网卡（编排层负责网络边界）；本地裸跑默认仍仅回环。
ENV KANGMIN_HTTP_HOST=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
# 根 dist 通过 @kangmin/core 子路径加载核心包；保留 workspace 软链接的目标。
COPY --from=builder --chown=node:node /app/packages/kangmin-core/package.json ./packages/kangmin-core/package.json
COPY --from=builder --chown=node:node /app/packages/kangmin-core/dist ./packages/kangmin-core/dist
COPY --from=builder --chown=node:node /app/packages/kangmin-database/package.json ./packages/kangmin-database/package.json
COPY --from=builder --chown=node:node /app/packages/kangmin-database/dist ./packages/kangmin-database/dist
COPY --from=builder --chown=node:node /app/packages/kangmin-integrations/package.json ./packages/kangmin-integrations/package.json
COPY --from=builder --chown=node:node /app/packages/kangmin-integrations/dist ./packages/kangmin-integrations/dist
COPY --from=builder --chown=node:node /app/packages/kangmin-runtime/package.json ./packages/kangmin-runtime/package.json
COPY --from=builder --chown=node:node /app/packages/kangmin-runtime/dist ./packages/kangmin-runtime/dist
COPY --from=builder --chown=node:node /app/apps/kangmin-api/package.json ./apps/kangmin-api/package.json
COPY --from=builder --chown=node:node /app/apps/kangmin-api/dist ./apps/kangmin-api/dist
COPY --from=builder --chown=node:node /app/apps/kangmin-cli/package.json ./apps/kangmin-cli/package.json
COPY --from=builder --chown=node:node /app/apps/kangmin-cli/dist ./apps/kangmin-cli/dist
USER node
EXPOSE 8787
# node:22-bookworm-slim 不含 curl，健康检查用 node 内置 fetch 打 /live。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "apps/kangmin-api/dist/server.js"]
