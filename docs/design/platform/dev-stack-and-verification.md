# dev-stack、一键脚本与跨仓验收体系

> 状态：目标设计（2026-10-06）。本文是[落地总计划](../platform-implementation-plan.md)工作包 **A0-5（Armadra dev-stack 平台 profile 与 `pnpm platform:*`）**、**C0-3（cloud 仓 `scripts/e2e.mjs`）**、**V1–V3（跨仓契约测试、探针、每波验收）** 的实现规格。上位设计：[平台设计](../platform-saas-architecture.md) §13.4、§16.3、§16.5、§17.8；[仓库骨架](cloud-repo-skeleton.md) §7。
> 约束：本地 PostgreSQL / Redis 只用 Docker；不建云资源、不发布；探针用 `tools/probes/probe-home.mjs` 的临时 HOME。

## §1 Armadra dev-stack：`platform` 与 `personal` profile（A0-5）

### 1.1 `tools/dev-stack/docker-compose.yml` 新增服务

| 服务                 | 镜像 / 构建                                                                                                                                                                                                                                                                                     | profile                               | 宿主端口（127.0.0.1） | 说明                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform-postgres`  | `postgres:17.11-alpine`，`POSTGRES_DB: armadra_cloud`，口令来自 `.data/dev.env` 的 `PLATFORM_DB_PASSWORD`                                                                                                                                                                                       | `platform`                            | 5441                  | 卷 `platform-postgres`                                                                                                                                                                                                                                                                                                   |
| `platform-redis`     | `redis:8.8.3-alpine`                                                                                                                                                                                                                                                                            | `platform`                            | 6391                  |                                                                                                                                                                                                                                                                                                                          |
| `cloud`              | 缺省 `ghcr.io/owlbay/armadra-cloud:<compatibility.json platform.images.cloud>`；设 `ARMADRA_DEV_STACK_CLOUD_SRC` 时 `build: { context: $SRC, dockerfile: apps/cloud/Dockerfile }`                                                                                                               | `platform`                            | 8100                  | `ARMADRA_CLOUD_ISSUER=http://127.0.0.1:8100`、`APP_ORIGIN=http://127.0.0.1:8100`、`RELAY_DOMAIN=src.localhost`、`REQUIRE_EMAIL_VERIFIED=0`、密钥文件挂 `.data/platform/signing-keys.json`（首次 `up` 由 `dev-stack.mjs` 用容器内 `keys generate` 生成）、`SMTP_URL=smtp://mailpit:1025`、`WEB_ROOT=/app/web`（镜像自带） |
| `relay`              | 同上的 relay 镜像 / 本地构建；`saas serve`                                                                                                                                                                                                                                                      | `platform`                            | 8101                  | `RELAY_CLOUD_ISSUER=http://cloud:8100`、`RELAY_REDIS_URL=redis://platform-redis:6379`、`RELAY_DOMAIN=src.localhost`、`RELAY_ALLOW_INSECURE_TUNNEL=1`、`RELAY_TLS=plain`（本地走 HTTP；地址用 `*.src.localhost`，浏览器与 Node ≥ 22 都把 `*.localhost` 解析到回环）                                                       |
| `relay-personal`     | relay 镜像；`personal serve --host 127.0.0.1 --port 8103 --listen 0.0.0.0:8103 --tls self-signed`（issuer = `https://127.0.0.1:8103`，宿主机与容器内一致）；`RELAY_PERSONAL_ACCOUNT=dev`、`RELAY_PERSONAL_PASSWORD_FILE=/run/secrets/pw`（来自 `.data/dev.env` 的 `PERSONAL_RELAY_PASSWORD`）   | `personal`                            | 8103                  | 卷 `relay-personal`；`RELAY_ALLOW_INSECURE_TUNNEL=0`（走自签 TLS，探针信任 `/ca.crt`）                                                                                                                                                                                                                                   |
| `armadra-server-nat` | 现有 `armadra-dev-server:local` 构建；**不发布端口**；`ARMADRA_PUBLIC_ORIGIN=https://armadra-server-nat:8443`（personal 里用 `armadra-server-nat-personal`：`network_mode: service:relay-personal`，`ARMADRA_CLOUD_ISSUER/REGISTRATION_TOKEN/FINGERPRINT` 由 `dev-stack.mjs` 在中继起来后注入） | `platform`（personal 用 `-personal`） | 无                    | 「NAT 后的 core」：只能出站；探针用它验证「经中继可达」                                                                                                                                                                                                                                                                  |

`services.mjs` 对应条目（`check`：cloud `/health` 200 + `/.well-known/armadra-platform` 的 `mode === "saas"`；relay `/health`；relay-personal `https://127.0.0.1:8103/.well-known/armadra-platform` 的 `mode === "personal"`（跳过证书校验只对回环）；postgres TCP；redis TCP）。`stack.test.mjs` 守端口一致。

`dev-stack.mjs` 的 `up`：`--profile platform` 时先确保 `.data/platform/signing-keys.json`（`docker compose run --rm cloud keys generate --out /data/signing-keys.json`）与 `PLATFORM_DB_PASSWORD`、`PERSONAL_RELAY_PASSWORD`、`ARMADRA_CLOUD_MASTER_KEY` 在 `.data/dev.env`；cloud 起来后跑一次 `seed`（`docker compose exec cloud node /app/out/main.js seed --email dev@armadra.test --password-env SEED_PASSWORD`，口令写 `.data/dev.env` 的 `PLATFORM_SEED_PASSWORD`）。

### 1.2 根 `package.json` 脚本

```json
"platform:up": "node tools/dev-stack/dev-stack.mjs up --profile platform",
"platform:down": "node tools/dev-stack/dev-stack.mjs down",
"platform:health": "node tools/dev-stack/dev-stack.mjs health --profile platform",
"platform:personal": "node tools/dev-stack/dev-stack.mjs up --profile personal",
"platform:e2e": "node tools/ci/e2e.mjs --only relay-roundtrip,personal-roundtrip,multi-source,link-join"
```

`ARMADRA_DEV_STACK_CLOUD_SRC=../armadra-cloud pnpm platform:up` 从本地克隆构建镜像（没发布 GHCR 之前这是缺省：`dev-stack.mjs` 发现 `../armadra-cloud` 存在且变量未设时自动用它，并打印一行说明）。

### 1.3 `tools/release/compatibility.json` 的 `platform` 项（A0-4）

```json
"platform": { "package": "@armadra/platform-protocol", "version": "0.1.0", "protocol": { "major": 1, "minor": 0 }, "images": { "cloud": "ghcr.io/owlbay/armadra-cloud:0.1.0", "relay": "ghcr.io/owlbay/armadra-relay:0.1.0" } }
```

`tools/release/version.mjs check` 加 `checkPlatformPin`：`version` 与 `packages/shared/package.json`（以及用到它的 `apps/desktop` / `apps/web`）、`pnpm-lock.yaml` 一致；`images` 两个 tag 等于 `version`。发布说明的 `armadra-compatibility` 围栏加一行 `platform: 1.0`。

## §2 cloud 仓一键脚本（C0-3）

| 命令                                                          | 做什么                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:up`                                                 | `deploy/dev/compose.yml`：postgres(5440)、redis(6390)、mailpit(1026/8026)；生成 `.env.dev`；`--wait`；然后 `pnpm db:migrate` |
| `pnpm dev:down`                                               | 停；`--volumes` 删卷                                                                                                         |
| `pnpm dev`                                                    | `node --watch` 起 cloud(8100) 与 relay saas(8101)                                                                            |
| `pnpm db:migrate`                                             | 迁到最新；拒绝条件触发时退出 78 并打印原因                                                                                   |
| `pnpm seed`                                                   | `dev@armadra.test` + 组织 `dev-org`；口令写 `.data/dev/seed.env`                                                             |
| `pnpm relay:personal`                                         | 个人中继开发实例（8102，自签）                                                                                               |
| `pnpm test` / `test:integration`                              | 单测 / 集成（需 `dev:up`）                                                                                                   |
| `pnpm e2e [--server-image IMG] [--mode saas\|personal\|both]` | §3                                                                                                                           |

## §3 cloud 仓 `scripts/e2e.mjs`：源经中继被挂载（C0-3，随 R1 / R2 / C2 逐步补全）

用 `deploy/e2e/compose.yml`（临时项目名 `armadra-e2e-<rnd>`）：

1. 起 postgres、redis、cloud（本地构建）、relay saas（本地构建）、`armadra-server`（`--server-image`，缺省 `ghcr.io/owlbay/armadra-server:<deploy/compat.json min>`；**不发布端口**，环境 `ARMADRA_CLOUD_ISSUER=http://cloud:8100`、`ARMADRA_CLOUD_REGISTRATION_TOKEN=<第 3 步生成>`）。
2. `cloud seed` 建账号；登录拿云会话。
3. `sources.registrationToken` → 写进 `armadra-server` 的环境后启动它（compose `up` 分两步）。
4. 等 `me.sources` 出现该源且 `online: true`（≤ 30 s）。
5. 客户端（Node：`fetch` + `ws`）：`sources.assertion` → `POST http://<sourceId>.src.localhost:8101/api/identity/cloud/login { assertion, invitationToken }`（第一次需要邀请：脚本先用容器内 `armadra-server invite` 生成一条 `maxUses=1` 邀请）→ 会话 → `GET /api/workspaces` → 建终端 → WS `terminals/{id}/ws` 写 `echo hello` 读到 `hello` → 事件流收到 `terminal.*` → `boards/{id}/sync` 收到 sync step。
6. 4401：以 `ARMADRA_IDENTITY_ACCESS_TTL_MS=5000`（探针专用环境变量，core 只在非生产读）起 server，等 6 s 后 WS 收到 4401 → 换票重连成功。
7. 源下线：`docker stop armadra-server` → 5 s 内 `GET …/api/workspaces` 503 `source_offline`，WS 4404；重启 → `sourceOnline` 事件 ≤ 2 s。
8. `--mode personal`：换成 `relay personal`（自签，脚本信任 `/ca.crt`），步骤 2–3 改为 `auth.login(dev)` 与 `sources.registrationToken`；步骤 5 的路径 `https://127.0.0.1:<port>/s/<sourceId>/…`；再加链接访客：`links.create` → `links.accept` → 访客 `cloud/login`。
9. 输出 `result.json`（每步耗时与结果）；任一失败非零退出；`finally` `compose down -v`。

`nightly.yml` 对 `compat.min` 与 `latest` 各跑一次 `both`。

## §4 Armadra 探针（`tools/probes/`，清单 `tools/ci/e2e.d/<id>.json`）

| 探针                 | 档  | 内容                                                                                                                                                                                                                                                                                       | 依赖                           |
| -------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `personal-roundtrip` | A   | `pnpm platform:personal` → 裸 core（临时 HOME，`ARMADRA_RELAY_ALLOW_INSECURE=0`，信任 relay 的 `/ca.crt`）→ `sources.remoteAdd(personal)` → `identity.cloud.register` → 隧道 ready → Node 客户端经 `/s/<id>/` 开终端、实时板、事件流 → 4401 换票 → `identity.cloud.revoke` 即断（WS 4404） | Docker；无 Docker 记 `skipped` |
| `relay-roundtrip`    | A   | 同上但 `platform` profile（saas）：设备码流用 `cloud seed` 的账号直接 `auth.login` 代替浏览器；`armadra-server-nat` 容器作为第二个源                                                                                                                                                       | Docker                         |
| `multi-source`       | A   | 桌面页面（CDP，现有 `ui-features` harness）：本机源 + `armadra-server`（direct）+ `armadra-server-nat`（relayed）三源并存；侧栏三组；每组开一个终端并回显；断开 relayed 源后侧栏灰显、本机终端仍可输入；重连后恢复                                                                         | Docker、Chrome                 |
| `link-join`          | A   | 从分享链接到画布：owner 在桌面页面生成链接（personal 访客模式）→ 第二个浏览器上下文打开 `/j/<id>#…` → 加入 → 画布可见；量步数（≤ 3 次点击）与耗时                                                                                                                                          | Docker、Chrome                 |
| `ws-mux-e2e`         | A   | E2：两个浏览器上下文 + 杀 core 重启 + 断网 30 s                                                                                                                                                                                                                                            | Chrome                         |
| `nat-core-offline`   | B   | NAT 后 core 的中继断开 60 s（`docker pause relay`）：本地终端与 Agent 不中断（核对 PTY 输出连续）、恢复后客户端 ≤ 10 s 重连                                                                                                                                                                | Docker                         |
| `server-perf`（扩）  | B   | 现有基线加一组「经中继」的 30 终端 + 6 事件流，p95 延迟不高于直连的 1.5 倍                                                                                                                                                                                                                 | Docker                         |

全部探针：临时 HOME；不读写操作员配置；结果 `result.json`。

## §5 跨仓契约测试（V1）

| 位置                                                                             | 读什么                     | 断言                                            |
| -------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------- |
| Armadra `core/relay/frames.test.ts`                                              | 协议包 `fixtures/tunnel/*` | 黄金字节往返                                    |
| Armadra `core/identity/cloud/assertion.test.ts`                                  | `fixtures/assertion/*`     | 各失败码                                        |
| Armadra `apps/web/src/sources/*.test.ts`                                         | `fixtures/cloud-api/*`     | 响应样例过 schema；客户端对假远程服务的调用形状 |
| Armadra `packages/shared/src/contract/cloud.test.ts`                             | 协议包 `core-api`          | §31 schema 与协议包同一对象（`===`）            |
| cloud 仓 `apps/relay/src/tunnel/*.test.ts`、`apps/cloud/src/assertion/*.test.ts` | 同一批 fixtures            | 同上                                            |
| 两仓 `errors.scan.test.ts`                                                       | `fixtures/errors.json`     | 源码字面量 ⊆ 注册表                             |
| 两仓 identity 向量测试                                                           | `identity-vectors`         | scrypt / 哈希前缀 / 锁定序列                    |

改形状的顺序：先改协议包与 fixtures（minor+1）→ cloud 仓实现并发包 → Armadra 升级钉住版本（P0-4 的 `platform` 项是显式 PR）。

## §6 每波验收清单（V3）

| 波  | 验收（全部命令在各自仓库根）                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0  | Armadra：`pnpm check`（含 lint）、`pnpm libs:build && pnpm -r --if-present test`、`pnpm release:test`；E0 基线数记入 `docs/guides/ci-release.md`                                                                                                                      |
| W1  | Armadra：E1 对偶测试与 `contract:check`；A3-0 `server-perf` 不退化；A0-5 `pnpm platform:up`（本地构建）健康。cloud：`pnpm check && pnpm test`；协议包 `pnpm pack` 含 fixtures；`pnpm images:build`；C0-3 `pnpm e2e --mode personal` 的前 3 步（起栈、登录、注册令牌） |
| W2  | Armadra：A1-1 / A1-3 单测；`pnpm --filter @armadra/web typecheck`；E2 `ws-mux-e2e`。cloud：R1 集成 `roundtrip.test.ts`（假 core）；R2 `personal-e2e.test.ts`；C2-1 集成 `accounts.test.ts`                                                                            |
| W3  | **个人中转端到端**：Armadra `personal-roundtrip` 探针绿；A1-4 页面「远程服务」添加个人中转 → 分享本机 → 第二台（dev-stack 的 `armadra-server-nat`）经中继挂载；A1-5 模拟器两源。cloud：C2-2 `sources.test.ts`；`pnpm e2e --mode personal` 全步绿                      |
| W4  | **SaaS 端到端**：`relay-roundtrip`、`multi-source` 绿；cloud `pnpm e2e --mode saas` 全步绿；两节点 `two-nodes.test.ts`；A4-1 并发邀请；E3-1 … E3-4 对偶                                                                                                               |
| W5  | `link-join`（personal 与 saas 两种）；组织页；A5-1 `packaged-smoke` 的 `serve` 步；E3-5 … E3-8 对偶；`nat-core-offline`                                                                                                                                               |
| W6  | E4：`routes.ts` 只剩 REST 残留；knip 0；C6 托管源 e2e（本地容器 API）、配额 429、`OPEN kind=tls` 抓包无明文（`tcpdump` 在 relay 容器里看不到 HTTP 请求行）；E5 每步 CI 时长记录                                                                                       |

每波结束另跑：Armadra `pnpm check && pnpm libs:build && pnpm -r --if-present test && pnpm release:test` 与 A 档 e2e；cloud `pnpm check && pnpm test && pnpm test:integration`；`docs/status/completion-progress.md` 各包填「做了什么 / 实测 / 没做」；`docs/status/platform-implementation-status.md` 加一节。
