#!/bin/sh
# 容器入口：把 ARMADRA_* 环境拼成 `armadra-server serve` 的参数。
#
#   ARMADRA_PUBLIC_ORIGIN  对外来源，必填；多个用空格或逗号分开
#   ARMADRA_LISTEN         监听地址，镜像缺省 0.0.0.0:8443
#   ARMADRA_TLS_CERT / ARMADRA_TLS_KEY   运维给的证书（与 ACME 互斥）
#   ARMADRA_ACME_EMAIL     给了就走 ACME（服务器壳自己读，见 server-deployment.md）
#   ARMADRA_BROWSER_PATH   浏览器节点的 Chromium；镜像带了 Chromium 时缺省指向它
#   ARMADRA_CLOUD_ISSUER + ARMADRA_CLOUD_REGISTRATION_TOKEN
#                          两个都给时，serve 就绪后自动登记到个人中转（`cloud register`，
#                          已登记则跳过；失败只记一行、不阻塞启动）
#   ARMADRA_CLOUD_FINGERPRINT  自签证书的中继 CA 指纹（64 位十六进制）；不给用系统信任
#   ARMADRA_CLOUD_LABEL    登记名，缺省取主机名
#
# 第一个参数不是 serve 时原样交给 armadra-server（status、version、logs…）。
set -eu

if [ "$#" -gt 0 ] && [ "$1" != "serve" ]; then
  exec node /app/out/main.js "$@"
fi
[ "$#" -gt 0 ] && shift

origins=""
for origin in $(printf '%s' "${ARMADRA_PUBLIC_ORIGIN:-}" | tr ',' ' '); do
  origins="$origins --public-origin $origin"
done
case " $* " in
  *" --public-origin"*) ;;
  *)
    if [ -z "$origins" ]; then
      echo "armadra-server: 需要对外来源。设置 ARMADRA_PUBLIC_ORIGIN=https://你的域名[:端口]" >&2
      exit 64
    fi
    ;;
esac

# 镜像带 Chromium（构建参数 WITH_CHROMIUM=1）而运维没指定时，浏览器节点用它。
if [ -z "${ARMADRA_BROWSER_PATH:-}" ] && [ -x /usr/bin/chromium ]; then
  export ARMADRA_BROWSER_PATH=/usr/bin/chromium
fi

tls=""
if [ -n "${ARMADRA_TLS_CERT:-}" ] || [ -n "${ARMADRA_TLS_KEY:-}" ]; then
  tls="--tls-cert ${ARMADRA_TLS_CERT:-} --tls-key ${ARMADRA_TLS_KEY:-}"
fi

# 个人中转自动登记：等 serve 把回环端点发布出来再登记（命令在服务没起来时退出 69，
# 重试到就绪为止）；令牌只走环境变量，不上命令行，也不留给 serve 进程。
if [ -n "${ARMADRA_CLOUD_ISSUER:-}" ] && [ -n "${ARMADRA_CLOUD_REGISTRATION_TOKEN:-}" ]; then
  (
    attempt=0
    while :; do
      status=0
      node /app/out/main.js cloud register \
        --data-dir "${ARMADRA_DATA_DIR:-/data}" \
        --issuer "$ARMADRA_CLOUD_ISSUER" \
        ${ARMADRA_CLOUD_FINGERPRINT:+--fingerprint "$ARMADRA_CLOUD_FINGERPRINT"} \
        ${ARMADRA_CLOUD_LABEL:+--label "$ARMADRA_CLOUD_LABEL"} || status=$?
      [ "$status" -eq 0 ] && break
      attempt=$((attempt + 1))
      if [ "$status" -ne 69 ] || [ "$attempt" -ge 60 ]; then
        echo "armadra-server: 自动登记到个人中转没有成功（退出码 $status），服务照常运行；可手动 cloud register" >&2
        break
      fi
      sleep 2
    done
  ) &
fi

# shellcheck disable=SC2086 # 来源与证书路径里没有空格，按词拆开正是想要的。
exec env -u ARMADRA_CLOUD_REGISTRATION_TOKEN node /app/out/main.js serve \
  --data-dir "${ARMADRA_DATA_DIR:-/data}" \
  --listen "${ARMADRA_LISTEN:-0.0.0.0:8443}" \
  --web-root "${ARMADRA_WEB_ROOT:-/app/web}" \
  $origins $tls "$@"
