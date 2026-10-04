# 服务器部署指南

服务器壳（`@armadra/server`）在一台机器上跑 core，浏览器与手机经 HTTPS 访问同一份页面。本文是运维照着做的步骤：
怎么起、证书从哪来、怎么从外网进来、备份恢复、升级回滚、安全基线与推送。命令行参数的完整表在
[开发指南 · 无窗口服务器壳](development.md#无窗口服务器壳)，接口形状在[契约](../contracts/core-json-api.md) §17。

需要你提供的只有两样：一台 Linux 机器（容器或 systemd 都行），以及（要对公网时）一个解析到它的域名、80/443 可达。

## 1. 选 Gateway 还是服务器壳

两者是同一份 Gateway 代码（`apps/desktop/src/core/gateway/`），差别在谁常开、配置从哪来。

|              | 桌面「对外服务」（Gateway）              | 服务器壳                                     |
| ------------ | ---------------------------------------- | -------------------------------------------- |
| 跑在哪       | 你的桌面，开着桌面壳才在                 | 服务器或 NAS，常开                           |
| 配置         | 设置 → 后台服务与对外服务（`gateway.*`） | 命令行 / 环境变量，设置页改不动（409）       |
| 证书缺省     | 本地 CA + 叶证书，手机装一次 CA          | 自签名；对公网用 ACME 或运维给的证书         |
| 适合         | 自己的手机、同一局域网里临时给别人看     | 多人长期共享、离开桌面也要能用、对公网       |
| Agent 在哪跑 | 桌面上，用桌面的 CLI 登录                | 服务器上，CLI 要在服务器（容器）里装好并登录 |

只给自己的手机用，开桌面的 Gateway 就够；要多人、常开或公网，用服务器壳。

## 2. 起服务

### 2.1 容器（推荐）

镜像 `ghcr.io/owlbay/armadra-server:<版本>`（推 `v*` 标签时发布，`linux/amd64` 与 `linux/arm64`），也可以从源码构建：
`docker build -f apps/server/docker/Dockerfile -t armadra-server .`。镜像以 uid 10001 运行，数据只在 `/data` 卷里，
环境变量表见 [apps/server/docker/README.md](../../apps/server/docker/README.md)。

```sh
mkdir -p /srv/armadra && cd /srv/armadra
curl -fsSLO https://raw.githubusercontent.com/Owlbay/Armadra/main/apps/server/docker/compose.yml
# 改 compose.yml 里的 ARMADRA_PUBLIC_ORIGIN 与 ARMADRA_ACME_EMAIL
docker compose up -d
docker compose logs armadra | grep "armadra-server pairing"
```

`ARMADRA_PUBLIC_ORIGIN` 必填：没有它容器以退出码 64 拒绝启动——服务器壳面对真浏览器，来源白名单是会话成立的前提。
它必须和用户地址栏里的一字不差（端口是 443 就不写端口）。

### 2.2 systemd（裸机）

```sh
pnpm install --frozen-lockfile && pnpm libs:build
pnpm --filter @armadra/web build && pnpm --filter @armadra/server build
sudo install -d -o armadra -g armadra -m 0700 /var/lib/armadra
node apps/server/out/main.js install --service-dir /etc/systemd/system --run-as armadra \
  --data-dir /var/lib/armadra --web-root "$PWD/apps/web/dist" \
  --listen 0.0.0.0:8443 --public-origin https://armadra.example.com \
  --env ARMADRA_ACME_EMAIL=ops@example.com --env ARMADRA_ACME_HTTP_PORT=8080
# install 只写文件：自己审阅生成的 unit，再 systemctl daemon-reload && systemctl enable --now
```

非 root 账号绑不了 80 / 443：用防火墙把 80→8080、443→8443 转发，或者在 unit 里加
`AmbientCapabilities=CAP_NET_BIND_SERVICE` 后直接监听 443 并去掉 `ARMADRA_ACME_HTTP_PORT`。

### 2.3 浏览器节点（可选 Chromium）

缺省镜像不带浏览器：服务器壳上的浏览器节点要一个 Chromium，找不到时页面不给「新建浏览器」入口。要它就带构建参数自己构建：

```sh
docker build --build-arg WITH_CHROMIUM=1 -f apps/server/docker/Dockerfile -t armadra-server:chromium .
```

镜像里多装 Debian 的 `chromium` 与中日韩字体（解压后多约 770 MiB，缺省镜像约 440 MiB），入口脚本设 `ARMADRA_BROWSER_PATH=/usr/bin/chromium`（自己设了
就以你的为准），`GET /health` 的 `capabilities.headlessBrowser` 变为 `true`。

- **Chromium 自己的沙箱是关的**（`/etc/chromium.d/armadra` 里的 `--no-sandbox`）：容器缺省的 seccomp 不放用户命名空间，
  SUID 沙箱也要 `CAP_SYS_ADMIN`，两条都起不来。隔离靠容器本身——uid 10001、没有额外 capability、只挂 `/data` 与项目目录。
  能给容器配允许用户命名空间的 seccomp 时，删掉那个文件即可恢复沙箱。
- `/dev/shm` 缺省只有 64 MiB，同一个文件里加了 `--disable-dev-shm-usage`；也可以 `--shm-size=1g` 后删掉它。
- 浏览器节点能打开容器网络里够得到的任何地址：内网有不该被访问的服务时，用容器网络或防火墙限制出站。
- 验证：`node tools/probes/server-e2e.mjs --container=armadra-server:chromium [--build --with-chromium]` 会照走浏览器节点一步
  （探针页在容器自己的回环上），缺省镜像则记 skipped。

## 3. 域名与证书

服务器壳只说 HTTPS（`__Host-` Cookie 要求安全上下文），证书有四个来源，`status` 与 `GET /api/gateway` 的 `tls.source` 会说明是哪一个。

### 3.1 ACME 内建（直接对公网时推荐）

`serve --acme <邮箱>` 或环境变量 `ARMADRA_ACME_EMAIL`。启动时向 Let's Encrypt 给 `--public-origin` 的每个主机名签一张证书，
缺省走 `http-01`：服务器壳自己在 80 端口（`ARMADRA_ACME_HTTP_PORT`，镜像里是 8080）答挑战，那个端口上别的请求一律 308 到 HTTPS。
不想开 80 时设 `ARMADRA_ACME_CHALLENGE=tls-alpn-01`：CA 的验证握手打对外 443（ALPN `acme-tls/1`），由服务器壳自己的 TLS
监听出示挑战证书，不再开明文端口。首签时监听还没起，服务器壳在 `--listen` 的地址上临时答一次验证再正式监听；外部 443
要转到 `--listen` 的端口，中间不能有终止 TLS 的代理（3.3 的反代场景用不了它）。

- 证书、私钥、账户密钥与续期状态在 `<数据目录>/tls/acme/`（目录 0700，文件 0600）。
- 寿命过去三分之二时自动续，续好当场热换，连接不断。失败按 1、2、4…小时退避（最多 12 小时），**一直用旧证书**直到它过期；
  连续失败 3 次在日志里记一条错误，`status` 显示「续期已连续失败 N 次」，`GET /api/gateway` 的 `tls.acme` 有原因。
- 签不出第一张证书时服务不启动，日志里是原因（`acme_misconfigured` / `acme_port_unavailable` / `acme_failed`）。
- 与 `--tls-cert` / `--tls-key` 互斥；对外来源是回环地址或 `localhost` 时拒绝。

| 变量                                                | 用途                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ARMADRA_ACME_DIRECTORY`                            | 别的 CA。先用 `https://acme-staging-v02.api.letsencrypt.org/directory` 演练不占限额        |
| `ARMADRA_ACME_PROFILE`                              | `shortlived`（6 天）或 `classic`；对外来源是公网 IP 时自动取 `shortlived`（IP 证书只有它） |
| `ARMADRA_ACME_CA_BUNDLE`                            | 私有 ACME CA（step-ca 等）的根证书 PEM 路径                                                |
| `ARMADRA_ACME_HTTP_PORT` / `ARMADRA_ACME_HTTP_HOST` | 挑战监听的端口与地址                                                                       |
| `ARMADRA_ACME_CHALLENGE`                            | `http-01`（缺省）或 `tls-alpn-01`                                                          |

本地演练：`pnpm dev-stack up pebble`，`ARMADRA_ACME_DIRECTORY=https://127.0.0.1:14000/dir`，
`ARMADRA_ACME_CA_BUNDLE` 指向 Pebble 镜像里的 `/test/certs/pebble.minica.pem`（`docker compose cp` 取出）。这一份 Pebble 不回连挑战；
要真验证用 `pnpm dev-stack up pebble-va --profile pebble-va`（目录 `https://127.0.0.1:14100/dir`），它按
`host.docker.internal` 回连 `tls-alpn-01` 的 5001 与 `http-01` 的 5002 端口——对外来源写 `https://host.docker.internal`，
监听与挑战端口绑在本机回环上即可（macOS 的容器运行时转得到，Linux 上宿主回环对容器不通）。

### 3.2 运维给的证书

`--tls-cert` / `--tls-key`（容器里 `ARMADRA_TLS_CERT` / `ARMADRA_TLS_KEY`，把文件挂进去）。服务器壳不签发也不续期：
换证书后重启服务。链文件里多于一张时，最后一张作为信任锚从 `GET /ca.crt` 发出。

### 3.3 反向代理（Caddy / Nginx）

已经有反向代理统一管证书时，让服务器壳只监听回环、证书交给代理：

```sh
armadra-server serve --listen 127.0.0.1:8443 --public-origin https://armadra.example.com
```

Gateway 自己也只说 TLS，所以代理到的上游是 `https://127.0.0.1:8443`，并且：

- **原样转发 `Host`**：来源白名单按对外来源判，`Host` 被改写会被拒。
- **WebSocket 升级**要放行（事件流、终端、实时协同都是长连接），读超时放到一小时级。
- 上游证书是自签名的：从 `curl -k https://127.0.0.1:8443/ca.crt -o armadra-upstream.crt` 取出来让代理只信这一张，
  校验名用对外来源的主机名（自签名证书的 SAN 覆盖它）。自签名证书 397 天后重签，届时重取；嫌麻烦就用 3.2 给它一张内部 CA 的证书。

Nginx（在本机容器里对着服务器壳镜像验证过配对与页面）：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
  listen 443 ssl;
  server_name armadra.example.com;
  ssl_certificate     /etc/letsencrypt/live/armadra.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/armadra.example.com/privkey.pem;
  client_max_body_size 200m;
  location / {
    proxy_pass https://127.0.0.1:8443;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_ssl_server_name on;
    proxy_ssl_name armadra.example.com;
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/nginx/armadra-upstream.crt;
    proxy_read_timeout 1h;
    proxy_buffering off;
  }
}
```

Caddy（2.8+；`Host` 缺省就原样转发；同一份配置换成环境变量后在 `tools/dev-stack/caddy/Caddyfile`，
`node tools/probes/server-e2e.mjs --proxy=caddy` 经它走完配对、邀请、事件流与撤销，`pnpm dev-stack up caddy --profile caddy` 可手动演练）：

```caddyfile
armadra.example.com {
  reverse_proxy https://127.0.0.1:8443 {
    transport http {
      tls_server_name armadra.example.com
      tls_trust_pool file /etc/caddy/armadra-upstream.crt
    }
  }
}
```

代理之后服务器壳看到的来源 IP 都是代理的：按 IP 的登录限流（20 次 / 分钟）由所有人共用，按账号的锁定不受影响。

### 3.4 自签名（缺省）

什么都不给时在 `<数据目录>/tls/` 生成自签名证书，`status` 标「自签名」。浏览器要手动信任；只适合局域网试用。

## 4. 不开公网端口也能从外面进来

都是运维选择，服务器壳不自建中继；共同点是 `--public-origin` 写用户实际访问的那个地址。

| 方案              | 做法                                                                                                                       | 注意                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Tailscale         | `--listen <tailscale IP>:8443 --public-origin https://<机器名>.<tailnet>.ts.net:8443`                                      | Personal 免费（6 用户、非商用）；证书可用 `tailscale cert` 给 3.2 |
| Headscale         | 同上，客户端 `tailscale up --login-server https://<你的 headscale>`                                                        | 控制面自托管                                                      |
| WireGuard         | 监听 WireGuard 接口地址，来源写那个地址或内部域名                                                                          | 需要一个公网 UDP 端口或一台 VPS                                   |
| Cloudflare Tunnel | `cloudflared` 指向 `https://127.0.0.1:8443`（`noTLSVerify` 或给它上游证书），`--public-origin https://armadra.example.com` | 免费；请求体上限 100 MB，大文件走分块上传（已支持）               |
| 自托管反向隧道    | frp / rathole / wstunnel + 一台小 VPS，VPS 上按 3.3 做代理                                                                 | 全部自持                                                          |

## 5. 首个管理员与成员

1. 启动日志里有一行 `armadra-server pairing https://…/#pair=<票>`，两分钟、一次性。容器：`docker compose logs armadra`。
2. 服务器上还没有管理员时，第一张被兑换的票就成为管理员（owner）。票过期了：`docker compose kill -s SIGUSR2 armadra`
   （裸机 `kill -USR2 <pid>`）再铸一张。
3. 之后在「设置 → 账号与共享」生成邀请、建组、按工作空间共享；撤销共享即刻断开对方的事件流并释放写租约。

## 6. 备份与恢复

数据目录里要备份的是：`canvas.db`（全部画布、身份与设置索引）、`settings.json`、`secrets/`（**`master.key` 丢了，加密存放的凭据就再也解不开**）、
`tls/`（ACME 账户与证书，丢了会重新签）。

**不停服的一致性备份**（库）：core 用 `VACUUM INTO` 在一个读事务里复制，不会拷到半页：

```sh
docker compose exec armadra node /app/docker/backup.mjs
# → {"path":"/data/canvas.db.backup-manual-20261003T104106Z","bytes":720896}
```

裸机上在页面「设置 → 数据 → 备份数据库」，或用 owner 会话 `POST /api/data/backup`。备份文件写在数据目录里，记得再拷到别的机器。

**整卷备份**（连 `secrets/` 一起）：

```sh
docker compose stop armadra
docker run --rm -v armadra_armadra-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/armadra-$(date +%Y%m%d).tgz -C /data .
docker compose start armadra
```

**恢复**：停服务 → 把备份文件复制成 `canvas.db`，同时删掉 `canvas.db-wal` 与 `canvas.db-shm` → 启动。

```sh
docker compose stop armadra
docker compose run --rm --entrypoint sh armadra -c \
  'cd /data && rm -f canvas.db-wal canvas.db-shm && cp canvas.db.backup-manual-20261003T104106Z canvas.db'
docker compose start armadra
```

数据目录损坏或版本比程序新时 core 拒绝启动，不会自动清库或重建：按上面恢复，或换回能读它的版本。

## 7. 升级与回滚

**升级前先备份**（第 6 节）：新版本可能带新的数据库迁移，迁移只进不退。

容器：

```sh
docker compose pull && docker compose up -d       # compose.yml 里钉版本号更稳：armadra-server:0.2.0
docker compose logs -f armadra                      # 看到「服务器壳已就绪」
```

回滚：把镜像标签改回上一个版本再 `up -d`。如果新版本已经迁移过库，旧版本会拒绝启动——先按第 6 节恢复升级前的备份。

裸机（systemd）：`upgrade` 先查候选文件（绝对路径、普通文件、权限、可选 sha256、自报版本），没有 `--confirm` 只打印计划：

```sh
node apps/server/out/main.js upgrade --binary /opt/armadra/next/main.js \
  --expect-version 0.2.0 --checksum-file /opt/armadra/next/main.js.sha256
node apps/server/out/main.js upgrade --binary /opt/armadra/next/main.js --confirm
systemctl restart armadra-server
# 回滚：换回上一份（.previous），同样要 --confirm
node apps/server/out/main.js upgrade --rollback --confirm && systemctl restart armadra-server
```

## 8. 安全基线

- **只开 HTTPS**：页面带 `Strict-Transport-Security: max-age=31536000`；会话 Cookie 是 `__Host-` 前缀、`Secure`、`HttpOnly`、`SameSite=Strict`，
  写请求要带 CSRF 头。明文 HTTP 只有 ACME 的挑战端口，它只答挑战、其余 308。
- **非 root**：镜像以 uid 10001 运行；裸机 `install` 拒绝 root / SYSTEM 一类账号。数据目录 0700，私钥与密钥 0600。
- **来源白名单**：`--public-origin` 只写真实使用的地址；不在名单里的 `Origin` / `Host` 一律拒。
- **设置建议**（设置键，页面在「设置 → 安全」）：`identity.mfa.requireFor` 至少 `members`；`identity.breachCheck` 服务器壳缺省 `warn`（经 HIBP 的
  k-匿名接口只发 SHA-1 前 5 位），离线环境改 `off`，要强制时 `block`；成员只经邀请加入，不开放注册；不用的设备在「会话与设备」撤销。
- **端口**：对外只开 443（与 ACME 时的 80）；core 自己的监听只在容器 / 机器的回环上，不要把它映射出去。
- **凭据**：Agent CLI 的登录、OAuth 客户端密钥、推送密钥都进密钥后端（服务器壳是 `secrets/master.key` 封装的文件），不要写进环境变量或 compose 文件；
  `install --env` 会拒绝名字带 TOKEN / SECRET / PASSWORD / CREDENTIAL 的变量。

## 9. 推送

推送由设置键 `push.*` 配置（契约 §19），`push.transport` 三选一；网页与 PWA 另走 Web Push，不需要任何第三方凭据。

- `log`（缺省）：不发，只记日志；页面里的通知照常。
- `direct`：服务器直连 APNs / FCM，适合自己构建 App 的部署。要用户提供 APNs 的 `.p8`（Key ID、Team ID）或 FCM 服务账号 JSON——**只把文件挂进容器、在设置里填路径**，
  不要把内容放进环境变量。服务器需要能出站访问 `api.push.apple.com` 与 `fcm.googleapis.com`。
- `relay`：经推送中继（`push.relayUrl`）转发，给商店版 App 用：`.p8` 与服务账号属于发布方，只在中继上。core 交出的是按设备
  X25519 公钥端到端加密的信封，中继看不到正文，也不存表。中继是 [`apps/push-relay`](../../apps/push-relay/README.md)，单独部署：
  只需出站 HTTPS 与那一组 APNs / FCM 凭据，放在第 3 节同样的 HTTPS 入口后面；是否运营由发布方决定。

推送正文不含终端原文与文件内容。本地联调用 dev-stack 的 `push-sink`（假 APNs / FCM / 中继，`http://127.0.0.1:8091`）。

## 10. 排错

| 现象                            | 原因与处理                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 容器退出码 64                   | 没设 `ARMADRA_PUBLIC_ORIGIN`                                                                         |
| 页面能开但登录后立刻掉线 / 403  | 地址栏的来源与 `--public-origin` 不一致（端口、大小写、代理改了 `Host`）                             |
| `acme_port_unavailable`         | 挑战端口被占或没权限：改 `ARMADRA_ACME_HTTP_PORT` 并把外部 80 转发过去                               |
| `acme_failed`                   | CA 拒绝或连不上：域名没解析到这台机器、80 不通、触发限额（先用 staging 目录演练）                    |
| `status` 显示「续期已连续失败」 | 同上；旧证书仍在用，过期前修好即可，修好后下一次重试自动换上                                         |
| 启动时报库版本或损坏            | 不会自动修：按第 6 节恢复备份，或换回能读它的版本                                                    |
| 健康检查 `unhealthy`            | `docker compose logs armadra` 看启动日志；`docker compose exec armadra node /app/out/main.js status` |
