# `Owlbay/armadra-cloud` 仓库骨架：详细设计

> 状态：目标设计（2026-10-06）。本文是[落地总计划](../platform-implementation-plan.md)工作包 **C0-1** 的实现规格：目录、workspace、TypeScript / ESLint / Prettier / Vitest 配置、AGENTS.md、repo-check、migrations.lock、CI、Dockerfile、compose、一键脚本与版本选择。上位设计：[平台设计](../platform-saas-architecture.md) §16.2、§16.4、§17.8。
> 仓库现状：只有 `LICENSE`（MIT），私有。建仓、分支保护、npm trusted publishing、GHCR 权限是用户的对外操作；本文只写进仓库的东西。

## §1 版本选择（与 Armadra 对齐）

| 项                                                                                                    | 版本                                                                                                         | 来源 / 理由                                                  |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Node                                                                                                  | 22（镜像 `node:22.23.3-bookworm-slim`，`engines >=22.18`）                                                   | 与 Armadra 一致；≥ 22.18 原生类型剥离，开发态直接跑 `.ts`    |
| pnpm                                                                                                  | 11.18.0（`packageManager`）                                                                                  | 与 Armadra 一致                                              |
| TypeScript                                                                                            | 5.9.2，`strict` + `noUncheckedIndexedAccess` + `erasableSyntaxOnly` + `verbatimModuleSyntax`                 | 同 Armadra；`erasableSyntaxOnly` 让 Node 直跑                |
| zod                                                                                                   | 4.4.3                                                                                                        | 同 Armadra                                                   |
| oRPC                                                                                                  | `@orpc/contract` / `server` / `openapi` / `client` / `openapi-client` 1.15.4 精确                            | Armadra F2 / F15；repo-check 同一条「版本一致且非 beta」规则 |
| Vitest                                                                                                | 4.1.11                                                                                                       | 同 Armadra                                                   |
| Prettier                                                                                              | 3.6.2，无配置文件（默认）                                                                                    | 同 Armadra                                                   |
| ESLint                                                                                                | 与 Armadra E0 落定的 `eslint` / `typescript-eslint` 版本相同（精确）；`eslint.config.js` 从 Armadra 拷贝裁剪 | 同一套规则；本仓没有 React，去掉 react-hooks / jsx-a11y      |
| knip                                                                                                  | 与 Armadra E0 相同                                                                                           | nightly 报告                                                 |
| esbuild                                                                                               | 0.28.2                                                                                                       | 镜像打包单文件，同 Armadra 服务器壳                          |
| PostgreSQL                                                                                            | 17（`postgres:17.11-alpine`）                                                                                | 用户要求；与 Armadra dev-stack 的 glitchtip-postgres 同版    |
| Redis                                                                                                 | 8（`redis:8.8.3-alpine`）                                                                                    | 用户要求；同 dev-stack                                       |
| `ws`                                                                                                  | 8.21.0                                                                                                       | 同 Armadra                                                   |
| `postgres`                                                                                            | 3.4.x 精确                                                                                                   | [控制面](cloud-control-plane.md) §1                          |
| `redis`                                                                                               | 5.x 精确                                                                                                     | 同上                                                         |
| `@peculiar/x509`、`acme-client` 5.4.0、`@simplewebauthn/server` 14.0.3、`otplib` 13.5.0、`nodemailer` | 与 Armadra 同版（`acme-client` 的 `node-forge` override 与 patch 一并带过来）                                |                                                              |

全部 `dependencies` 精确版本（无 `^`），`pnpm-workspace.yaml` 带 `minimumReleaseAge: 7`（天）与与 Armadra 相同的安全 `overrides`（只保留本仓用到的）。

## §2 目录

```text
armadra-cloud/
├── .github/workflows/      ci.yml、release.yml、nightly.yml（§6）
├── .gitattributes .gitignore .prettierignore .npmrc（engine-strict）
├── AGENTS.md               §4
├── CHANGELOG.md            中英
├── LICENSE                 MIT（已有）
├── README.md               一页：两种模式、一键命令、链接到 docs/
├── THIRD_PARTY_NOTICES.md  tools/notices.mjs 生成（拷自 Armadra）
├── apps/
│   ├── cloud/              [控制面](cloud-control-plane.md)
│   └── relay/              [中继](relay.md)
├── packages/
│   ├── platform-protocol/  [协议包](protocol-package.md)
│   └── cloud-shared/       内部：db/（postgres 客户端、migrate.ts）、redis.ts、config.ts（env 解析 + zod）、log.ts、health.ts、http/（极小路由、错误输出、Origin 工具）
├── deploy/
│   ├── compose.yml         参考部署：cloud + relay + postgres + redis（§7.2）
│   ├── personal/compose.yml 个人中继单服务（§7.3）
│   ├── dev/compose.yml     本地依赖：postgres + redis + mailpit + pebble（§7.1）
│   ├── compat.json         验证过的 armadra-server 镜像区间（nightly 与 Dockerfile 的 web 来源）
│   └── README.md           运维手册：环境变量、密钥、滚动升级（先 relay 后 cloud）、备份
├── docs/
│   ├── README.md           索引（repo-check 校验登记）
│   ├── contracts/cloud-api.md   §1 编码规则、§2 账号与会话、§3 组织、§4 源目录与断言、§5 链接、§6 me/stream、§7 中继客户端面、§8 隧道 t/v1、§9 计费预留、§10 personal 模式子集、§11 TLS 约定
│   ├── contracts/cloud-openapi.json  生成物
│   ├── design/             本仓自己的设计补充（初版为空目录说明）
│   └── runbooks/           部署、轮换密钥、故障处理
├── migrations.lock         apps/cloud/src/db/migrations 的 sha256 表
├── package.json            §3
├── pnpm-workspace.yaml     packages: apps/*, packages/*
├── repo.rules.json         §5
├── scripts/                dev.sh（起停依赖）、e2e.mjs（跨仓联调）、seed.mjs、gen-vectors.mjs
├── tools/                  repo-check.mjs（+test）、notices.mjs、contract/generate.mjs（OpenAPI → cloud-api.md 标记块）、ci/validate-workflows.mjs
└── tsconfig.base.json      tsconfig.json（solution，references）
```

## §3 根 `package.json` 脚本

```json
{
  "name": "armadra-cloud",
  "private": true,
  "packageManager": "pnpm@11.18.0",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "libs:build": "pnpm --filter @armadra/platform-protocol build",
    "check": "pnpm libs:build && pnpm format:check && pnpm lint && pnpm typecheck && pnpm repo:check && pnpm contract:check && pnpm ci:workflows && pnpm notices:check",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "test:integration": "pnpm -r --if-present test:integration",
    "repo:check": "node tools/repo-check.mjs",
    "repo:test": "node --test tools/*.test.mjs tools/ci/*.test.mjs",
    "contract:check": "node tools/contract/generate.mjs --check",
    "contract:generate": "node tools/contract/generate.mjs",
    "ci:workflows": "node tools/ci/validate-workflows.mjs",
    "notices": "node tools/notices.mjs",
    "notices:check": "node tools/notices.mjs --check",
    "dev:up": "sh scripts/dev.sh up",
    "dev:down": "sh scripts/dev.sh down",
    "dev": "pnpm libs:build && node scripts/dev-run.mjs",
    "db:migrate": "node apps/cloud/src/cli.ts migrate",
    "cloud:keys": "node apps/cloud/src/cli.ts keys generate --out .data/dev/signing-keys.json --write-env .env.dev",
    "seed": "node scripts/seed.mjs",
    "relay:personal": "pnpm libs:build && node apps/relay/src/cli.ts personal serve --data-dir .data/personal --host 127.0.0.1 --port 8102 --tls self-signed --auto-init",
    "e2e": "node scripts/e2e.mjs",
    "build": "pnpm -r --if-present build",
    "images:build": "docker build -f apps/cloud/Dockerfile -t armadra-cloud:local . && docker build -f apps/relay/Dockerfile -t armadra-relay:local ."
  },
  "devDependencies": {
    "prettier": "3.6.2",
    "typescript": "5.9.2",
    "vitest": "4.1.11",
    "eslint": "<E0>",
    "typescript-eslint": "<E0>",
    "knip": "<E0>"
  }
}
```

`scripts/dev-run.mjs`：读 `.env.dev`，并行 `node --watch apps/cloud/src/main.ts` 与 `node --watch apps/relay/src/cli.ts saas serve`，前缀日志；任一退出就都退出。

各 app 的 `package.json`：`build`（esbuild → `out/main.js`，`--platform=node --format=esm --target=node22 --bundle`，`node-pty` 无关、无原生模块）、`typecheck`、`test`（`vitest run`）、`test:integration`（`vitest run --config vitest.integration.config.mts`）。`apps/relay` 另有 `"bin": { "armadra-relay": "./out/cli.js" }`、`"files": ["out"]`、`publishConfig.access = public`（npm 包 `@armadra/relay`）。

## §4 `AGENTS.md`

```md
# armadra-cloud 开发约定

## 代码边界

- `apps/cloud` 是控制面，`apps/relay` 是中继；`apps/relay` 不得 import `apps/cloud`，两者只共享 `packages/*`。两个 app 都不得 import Armadra 仓的源码；与 Armadra 的全部往来只经 `@armadra/platform-protocol` 与容器镜像。
- `@orpc/*` 只能出现在 `packages/platform-protocol/src/cloud-api/`、`apps/cloud/src/http/rpc.ts`、`apps/relay/src/personal/api.ts`、`tools/contract/`（ESLint `no-restricted-imports` 守）。
- 错误码只从 `@armadra/platform-protocol/errors` 取；线上形状 `{ code, message, requestId?, details? }`，JSON camelCase。
- relay 不碰数据库；relay 与 cloud 都不得持久化或记录任何流正文、终端输出、画布内容、口令、令牌明文。
- `personal` 模式不得引入对 PostgreSQL / Redis 的运行时依赖（`control/memory.ts` 的 import 扫描测试守）。

## 数据库

- 迁移只有一个目录 `apps/cloud/src/db/migrations/`，编号从 0001 连续；字节记进 `migrations.lock`（`pnpm repo:check`）；已发布迁移不得修改；未知 / 损坏的账本拒绝启动，禁止自动清库或重建。
- 每个迁移同 PR 带测试。

## 按需阅读与验证

- 契约：`docs/contracts/cloud-api.md`（§N 不改号，只追加）；形状表由 `pnpm contract:generate` 从契约生成，改形状改协议包。
- 验证：`pnpm check`、`pnpm test`、`pnpm test:integration`（需 `pnpm dev:up`）、`pnpm e2e`（需 Docker 与 Armadra 服务器镜像）。
- 发布：`v*` 标签触发 `release.yml`（协议包与 `@armadra/relay` 发 npm，两镜像推 GHCR）；本地绝不手动 `npm publish` / `docker push`。
- 不出现任何第三方参考项目的名字。

## Review guidelines

- 简体中文，先结论，每条写文件与行号。
- relay import cloud、app import Armadra 源码、`@orpc/*` 出现在门面之外：P1。
- 修改已发布迁移、编号不连续、lock 未同步、任何自动清库：P0。
- 正文 / 令牌 / 口令进入日志、持久化或响应：P0。
- 令牌校验少了 `aud` / `exp` / `jti` 任一项、中继把流转给非令牌 `src` 的源：P0。
- 接口形状改了而协议包 / `cloud-api.md` 没同步：P1。
```

## §5 `repo.rules.json`

从 Armadra 拷贝，裁剪：`root` 白名单按 §2；`blacklist` 加 `.data/`、`out/`；`docs.index = docs/README.md`，`directoryOnly: ["runbooks"]`；`naming`：`apps` 与 `packages` 前缀 `@armadra/`；`fileSize.max = 1500`；`migrations.sources = [{ path: "apps/cloud/src/db/migrations", kind: "directory" }]`；新增规则 `orpc`：`{ "packages": ["@orpc/contract","@orpc/server","@orpc/openapi","@orpc/client","@orpc/openapi-client"], "sameVersion": true, "forbidPrerelease": true }`（与 Armadra E0-6 同一实现，`tools/repo-check.mjs` 拷贝后保持同一份代码，差异只在规则文件）。

## §6 CI（`.github/workflows/`）

### 6.1 `ci.yml`（push main、pull_request）

单作业 `check`（ubuntu-latest，Node 22，pnpm 11.18.0）+ 服务容器 `postgres:17.11-alpine`（`POSTGRES_PASSWORD: test`，健康检查 `pg_isready`）与 `redis:8.8.3-alpine`：

1. `pnpm install --frozen-lockfile`
2. `pnpm check`（含 lint、typecheck、repo-check、contract:check、workflows、notices）
3. `pnpm repo:test`
4. `pnpm test`
5. `pnpm test:integration`（`ARMADRA_CLOUD_TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres`、`REDIS_URL=redis://localhost:6379`）
6. `docker build` 两个镜像，`--load` 不推送；`docker run --rm armadra-relay:local personal --help` 冒烟
7. 上传 `coverage/`（`@vitest/coverage-v8`，只报告）

### 6.2 `release.yml`（`v*` 标签；写好但发布步骤靠用户配置的 OIDC / 权限才会成功）

`permissions: { id-token: write, contents: write, packages: write }`：

1. 校验标签 = 根 `package.json`、协议包、`@armadra/relay`、两 app 的版本一致（`tools/release-check.mjs`）。
2. `pnpm check && pnpm test`。
3. `pnpm --filter @armadra/platform-protocol publish --provenance --access public --no-git-checks`；`pnpm --filter @armadra/relay publish …`（trusted publishing，不用 token）。
4. `docker/login-action`（GHCR，`GITHUB_TOKEN`）→ `docker/build-push-action` 推 `ghcr.io/owlbay/armadra-cloud:<v>` 与 `armadra-relay:<v>`（`linux/amd64,linux/arm64`），`latest` 只在非预发布标签。
5. GitHub Release 草稿，正文从 CHANGELOG 截取。

### 6.3 `nightly.yml`（cron 每日 + 手动）

1. `pnpm e2e --server-image ghcr.io/owlbay/armadra-server:<compat.min>` 与 `:latest`（两次）——跨仓端到端（[验证](dev-stack-and-verification.md) §4）。
2. `knip`、`pnpm audit --prod --audit-level=high`（失败开 issue，同 Armadra B 档规则）。

`tools/ci/validate-workflows.mjs` 从 Armadra 拷贝（校验 action 钉 SHA、`permissions` 最小、`timeout-minutes` 必填）。

## §7 Docker

### 7.1 `deploy/dev/compose.yml`（`pnpm dev:up`）

```yaml
name: armadra-cloud-dev
services:
  postgres:
    {
      image: postgres:17.11-alpine,
      environment:
        {
          POSTGRES_USER: armadra,
          POSTGRES_PASSWORD: "${DEV_PG_PASSWORD:?run pnpm dev:up}",
          POSTGRES_DB: armadra_cloud,
        },
      ports: ["127.0.0.1:5440:5432"],
      volumes: [pg:/var/lib/postgresql/data],
      healthcheck:
        {
          test: ["CMD", "pg_isready", "-U", "armadra"],
          interval: 5s,
          timeout: 5s,
          retries: 20,
        },
    }
  redis:
    {
      image: redis:8.8.3-alpine,
      ports: ["127.0.0.1:6390:6379"],
      healthcheck:
        {
          test: ["CMD", "redis-cli", "ping"],
          interval: 5s,
          timeout: 5s,
          retries: 20,
        },
    }
  mailpit:
    {
      image: axllent/mailpit:v1.31.4,
      ports: ["127.0.0.1:1026:1025", "127.0.0.1:8026:8025"],
    }
  pebble:
    {
      image: ghcr.io/letsencrypt/pebble:2.10.1,
      profiles: ["acme"],
      environment: { PEBBLE_VA_ALWAYS_VALID: "1" },
      ports: ["127.0.0.1:14001:14000"],
    }
volumes: { pg: {} }
```

`scripts/dev.sh up`：没有 `.env.dev` 就生成（随机 `DEV_PG_PASSWORD`、`ARMADRA_CLOUD_MASTER_KEY`，写 `ARMADRA_CLOUD_ISSUER=http://127.0.0.1:8100`、`APP_ORIGIN=http://127.0.0.1:8100`、`DATABASE_URL`、`REDIS_URL`、`RELAY_DOMAIN=src.localhost`、`RELAY_ALLOW_INSECURE_TUNNEL=1`、`SMTP_URL=smtp://127.0.0.1:1026`），`docker compose --env-file .env.dev up -d --wait`，然后 `pnpm db:migrate`；`down [--volumes]`。端口与 Armadra dev-stack 错开（5440 / 6390 / 1026 / 8026 / 14001）。

### 7.2 `deploy/compose.yml`（参考部署）

`cloud`（`ghcr.io/owlbay/armadra-cloud:${ARMADRA_CLOUD_VERSION}`，env 来自 `.env`，挂 `signing-keys.json`，`depends_on` postgres / redis 健康）、`relay`（同版本，`saas serve`，`RELAY_CLOUD_ISSUER=http://cloud:8100`，`443:8443`，证书挂载）、`postgres`、`redis`；注释写明：生产应换托管 PG / Redis、证书由运维办、先升 relay 后升 cloud。

### 7.3 `deploy/personal/compose.yml`

```yaml
name: armadra-relay-personal
services:
  relay:
    image: ghcr.io/owlbay/armadra-relay:${ARMADRA_RELAY_VERSION:-latest}
    command:
      [
        "personal",
        "serve",
        "--host",
        "${RELAY_HOST:?set RELAY_HOST to your public IP or domain}",
      ]
    environment:
      {
        RELAY_PERSONAL_ACCOUNT: "${RELAY_ACCOUNT:-me}",
        RELAY_PERSONAL_PASSWORD_FILE: /run/secrets/relay_password,
      }
    secrets: [relay_password]
    ports: ["443:8443"]
    volumes: [relay-data:/data]
    restart: unless-stopped
secrets: { relay_password: { file: ./relay_password.txt } }
volumes: { relay-data: {} }
```

首次启动若 `/data/state.json` 不存在且给了口令文件 → 自动 `init`；启动日志打印 CA 指纹与 `https://<host>/ca.crt`。

### 7.4 Dockerfile

`apps/cloud/Dockerfile` 与 `apps/relay/Dockerfile` 同一模板（两段）：

```dockerfile
ARG NODE_IMAGE=node:22.23.3-bookworm-slim
ARG WEB_IMAGE=ghcr.io/owlbay/armadra-server:0.2.0     # deploy/compat.json 的 web；页面产物来源
FROM ${WEB_IMAGE} AS web
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm libs:build && pnpm --filter @armadra/cloud build   # relay 镜像换 filter
RUN mkdir -p /app && cp -r apps/cloud/out /app/out && cp -r apps/cloud/src/db/migrations /app/migrations
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10002 armadra && useradd --system --uid 10002 --gid armadra --home-dir /data armadra && mkdir -p /data && chown armadra:armadra /data
COPY --from=build /app /app
COPY --from=web /app/web /app/web
ENV NODE_ENV=production ARMADRA_CLOUD_WEB_ROOT=/app/web ARMADRA_CLOUD_MIGRATIONS_DIR=/app/migrations
USER armadra
VOLUME ["/data"]
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:8100/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini","--","node","/app/out/main.js"]
CMD ["serve"]
```

relay 镜像：`EXPOSE 8443`、`ENTRYPOINT … /app/out/cli.js`、`CMD ["saas","serve"]`；`personal` 模式用 `command: ["personal","serve",…]` 覆盖。镜像不含 Chromium、tmux、git（中继与控制面不需要）。

## §8 `docs/README.md` 与 `docs/contracts/cloud-api.md` 初版

`docs/README.md`：目录表（contracts / design / runbooks）与各文档一行；`cloud-api.md` 初版只有 §1 编码规则与 §8 隧道（指向协议包）与 §10 personal 子集的散文，形状表为生成块占位（`<!-- rpc:begin contract=§2 -->`）；`pnpm contract:generate` 填充。

## §9 验收（C0-1）

- 新仓 `pnpm install && pnpm check && pnpm test` 过（两 app 各一条空测试 + 协议包占位）。
- `pnpm dev:up && pnpm db:migrate && pnpm dev` 起得来；`curl http://127.0.0.1:8100/health` 200；`curl http://127.0.0.1:8101/health` 200。
- `pnpm images:build` 两镜像构建成功；`docker run --rm armadra-relay:local personal --help` 打印用法。
- `ci.yml` 在 PR 上绿（除发布步骤外无外部依赖）；`release.yml` / `nightly.yml` 通过 `validate-workflows`。
- `pnpm repo:check` 守住：根目录白名单、文档登记、迁移 lock（空表也要有文件）、oRPC 版本规则。
