# 服务器壳镜像

`apps/server/docker/` 是服务器壳（`@armadra/server`）的容器打包。怎么部署、证书怎么来、备份与升级见
[服务器部署指南](../../../docs/guides/server-deployment.md)；这里只说明文件。

| 文件                      | 作用                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `Dockerfile`              | 两段构建：编页面、服务器壳与 node-pty，运行段只留 `/app`；非 root（uid 10001）、`/data` 卷 |
| `Dockerfile.dockerignore` | 构建上下文（仓库根）里不进镜像的东西                                                       |
| `entrypoint.sh`           | 把 `ARMADRA_*` 环境拼成 `serve` 参数；没有对外来源拒绝启动（退出码 64）                    |
| `healthcheck.mjs`         | 容器里经回环打 `/health`                                                                   |
| `backup.mjs`              | `docker compose exec armadra node /app/docker/backup.mjs`：不停服的一致性备份              |
| `compose.yml`             | 直接对公网、ACME 自动证书的示例                                                            |

```sh
# 仓库根目录
docker build -f apps/server/docker/Dockerfile -t armadra-server:local .
docker run --rm -p 127.0.0.1:8443:8443 \
  -e ARMADRA_PUBLIC_ORIGIN=https://127.0.0.1:8443 armadra-server:local
```

环境变量：

| 变量                                   | 缺省           | 说明                                               |
| -------------------------------------- | -------------- | -------------------------------------------------- |
| `ARMADRA_PUBLIC_ORIGIN`                | 无（必填）     | 对外来源，多个用空格或逗号分开                     |
| `ARMADRA_LISTEN`                       | `0.0.0.0:8443` | 容器里的 HTTPS 监听                                |
| `ARMADRA_TLS_CERT` / `ARMADRA_TLS_KEY` | 无             | 运维给的证书（挂进容器的路径），与 ACME 互斥       |
| `ARMADRA_ACME_EMAIL`                   | 无             | 给了就走 ACME（等同 `serve --acme`）               |
| `ARMADRA_ACME_DIRECTORY`               | Let's Encrypt  | 别的 ACME CA（step-ca、ZeroSSL…）                  |
| `ARMADRA_ACME_PROFILE`                 | CA 缺省        | `shortlived` / `classic`；IP 来源自动 `shortlived` |
| `ARMADRA_ACME_CA_BUNDLE`               | 无             | 信任 ACME 目录服务器的 PEM（私有 CA）              |
| `ARMADRA_ACME_HTTP_PORT`               | `8080`         | http-01 挑战监听（镜像里非 root，绑不了 80）       |
| `ARMADRA_DATA_DIR`                     | `/data`        | 数据目录，卷挂在这里                               |

第一个参数不是 `serve` 时原样交给 `armadra-server`：`docker compose exec armadra node /app/out/main.js status`
或 `docker run --rm armadra-server:local version`。

发布：推 `v*` 标签时 `.github/workflows/server-image.yml` 把 `linux/amd64` + `linux/arm64` 推到
`ghcr.io/owlbay/armadra-server:<版本>` 与 `:latest`；拉取请求不推。夜间 `nightly.yml` 的
`linux` 作业跑 B 档条目 `server-container-e2e`（`tools/ci/e2e.d/server-container-e2e.json`）：构建镜像并对着容器跑 `tools/probes/server-e2e.mjs --container=…`。
