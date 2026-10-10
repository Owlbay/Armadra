# syntax=docker/dockerfile:1
#
# Armadra 服务器壳的正式镜像（补全计划 G3-5，部署见 docs/guides/server-deployment.md）。
#
#   docker build -f apps/server/docker/Dockerfile -t armadra-server .
#
# 构建上下文是仓库根：服务器壳直接打包 apps/desktop/src/core，页面产物来自
# apps/web，单拿 apps/server 一个目录造不出来。两段：
#
#   build    装全仓依赖、编页面与服务器壳、给 node-pty 现编 Linux 原生模块、
#            打 hook 客户端；只留 /app 一棵树。
#   runtime  node 运行时 + tmux / git / bash，非 root 用户 armadra（uid 10001），
#            数据只在 /data 卷里；入口脚本把 ARMADRA_* 环境拼成 serve 的参数，
#            没有对外来源就拒绝启动。
#
# 可选：--build-arg WITH_CHROMIUM=1 在 runtime 里装 Debian 的 Chromium（服务器壳
# 上的浏览器节点用它），入口脚本设 ARMADRA_BROWSER_PATH。缺省不装：解压后多约 770 MiB。

ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS build

ENV CI=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# node-pty 在 Linux 上没有预编译产物，按 Node ABI 现编一份要编译器。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm libs:build \
 && pnpm --filter @armadra/web build \
 && pnpm --filter @armadra/server build \
 && node apps/desktop/scripts/ensure-node-pty.mjs --prebuilt

# /app/out/main.js 是服务器壳；core 在它旁边找 ../cli/armadra-hook.js（hook
# 客户端，Agent CLI 每个事件 fork 一次）与 out/agent*/（随包的 ama）。
# node-pty 是唯一的外部原生模块，连同编好的 build/ 复制成普通目录（pnpm 的
# 符号链接在下一段里不存在）。迁移目录在检出里是往上找到的，镜像里没有检出，
# 复制到 /app/migrations 并由 ARMADRA_CORE_MIGRATIONS_DIR 指过去。
RUN mkdir -p /app/node_modules /app/cli \
 && cp -r apps/server/out /app/out \
 && cp -r apps/desktop/src/core/db/migrations /app/migrations \
 && rm -f /app/out/*.map \
 && cp -r apps/web/dist /app/web \
 && cp -rL apps/desktop/node_modules/node-pty /app/node_modules/node-pty \
 && rm -rf /app/node_modules/node-pty/src /app/node_modules/node-pty/deps \
 && pnpm --filter @armadra/server exec esbuild ../desktop/src/cli/armadra-hook/main.ts \
      --bundle --platform=node --format=cjs --target=node22 --external:electron \
      --log-level=warning --outfile=/app/cli/armadra-hook.js
COPY apps/server/docker/entrypoint.sh apps/server/docker/healthcheck.mjs \
     apps/server/docker/backup.mjs /app/docker/
RUN chmod 0755 /app/docker/entrypoint.sh

FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="armadra-server" \
      org.opencontainers.image.description="Armadra 无窗口服务器壳" \
      org.opencontainers.image.source="https://github.com/AMA-Link/Armadra" \
      org.opencontainers.image.licenses="NOASSERTION"

# tmux：终端在 core 重启后还活着（契约 §15.1 的缺省后端）；git / bash /
# ca-certificates / openssh-client：Agent 与终端里的日常工具。tini 收僵尸进程。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux git bash ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 armadra \
 && useradd --system --uid 10001 --gid armadra --home-dir /data \
      --shell /bin/bash armadra \
 && mkdir -p /data \
 && chown armadra:armadra /data \
 && chmod 0700 /data

# 浏览器节点（可选）。Debian 的 /usr/bin/chromium 是个包装脚本，会读
# /etc/chromium.d/ 下的片段：容器里没有可用的命名空间沙箱（缺省 seccomp 不放
# CLONE_NEWUSER），所以关掉 Chromium 自己的沙箱，靠容器隔离（非 root、无额外
# capability）；/dev/shm 缺省只有 64 MiB，共享内存改走 /tmp。
ARG WITH_CHROMIUM=0
RUN if [ "$WITH_CHROMIUM" = "1" ]; then \
      apt-get update \
   && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
   && rm -rf /var/lib/apt/lists/* \
   && printf '%s\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage"' \
        > /etc/chromium.d/armadra; \
    fi

COPY --from=build /app /app

ENV NODE_ENV=production \
    NODE_PATH=/app/node_modules \
    HOME=/data \
    SHELL=/bin/bash \
    ARMADRA_DATA_DIR=/data \
    ARMADRA_LISTEN=0.0.0.0:8443 \
    ARMADRA_WEB_ROOT=/app/web \
    ARMADRA_CORE_MIGRATIONS_DIR=/app/migrations \
    # 非 root 绑不了 80：ACME 的 http-01 挑战监听在 8080，compose 把宿主 80 映射过来。
    ARMADRA_ACME_HTTP_PORT=8080

USER armadra:armadra
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8443 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["serve"]
