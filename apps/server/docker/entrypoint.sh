#!/bin/sh
# 容器入口：把 ARMADRA_* 环境拼成 `armadra-server serve` 的参数。
#
#   ARMADRA_PUBLIC_ORIGIN  对外来源，必填；多个用空格或逗号分开
#   ARMADRA_LISTEN         监听地址，镜像缺省 0.0.0.0:8443
#   ARMADRA_TLS_CERT / ARMADRA_TLS_KEY   运维给的证书（与 ACME 互斥）
#   ARMADRA_ACME_EMAIL     给了就走 ACME（服务器壳自己读，见 server-deployment.md）
#   ARMADRA_BROWSER_PATH   浏览器节点的 Chromium；镜像带了 Chromium 时缺省指向它
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

# shellcheck disable=SC2086 # 来源与证书路径里没有空格，按词拆开正是想要的。
exec node /app/out/main.js serve \
  --data-dir "${ARMADRA_DATA_DIR:-/data}" \
  --listen "${ARMADRA_LISTEN:-0.0.0.0:8443}" \
  --web-root "${ARMADRA_WEB_ROOT:-/app/web}" \
  $origins $tls "$@"
