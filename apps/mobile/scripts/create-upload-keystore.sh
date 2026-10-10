#!/usr/bin/env bash
# 用法：apps/mobile/scripts/create-upload-keystore.sh [owner/repo] [--secrets-only]
#
# 生成 Android 上传密钥并写进仓库 secrets，供 release.yml 的 android 作业签名 APK。
# 维护者在自己的机器上跑；密钥丢了就再也发不了同一个 App 的更新，跑完务必把
# ~/.armadra-signing/ 备份到安全的地方（密码管理器 / 离线介质）。
#
# - 密钥与口令写在 ~/.armadra-signing/（0700 / 0600），已存在就拒绝覆盖。
# - 口令随机生成，不打印；secrets 经 stdin 交给 gh，不进命令行参数与 shell 历史。
# - 需要 keytool（JDK 17+）、openssl、gh（已登录且对仓库有 admin 权限）。
set -euo pipefail

repo=${1:-AMA-Link/Armadra}
dir="$HOME/.armadra-signing"
keystore="$dir/armadra-upload.jks"
password_file="$dir/armadra-upload.password"
alias=armadra-upload

for tool in keytool openssl gh; do
  command -v "$tool" >/dev/null || { echo "缺少 $tool" >&2; exit 1; }
done
if [ -e "$keystore" ]; then
  echo "$keystore 已存在，不覆盖。只想重新写 secrets 就加 --secrets-only。" >&2
  [ "${2:-}" = "--secrets-only" ] || exit 1
else
  mkdir -p "$dir"
  chmod 700 "$dir"
  umask 077
  openssl rand -base64 33 | tr -d '\n/+=' > "$password_file"
  keytool -genkeypair -noprompt \
    -keystore "$keystore" -storetype PKCS12 \
    -alias "$alias" -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=Armadra, O=AMA-Link" \
    -storepass:file "$password_file" >/dev/null
  echo "已生成 $keystore"
fi

base64 < "$keystore" | tr -d '\n' | gh secret set ANDROID_UPLOAD_KEYSTORE_BASE64 -R "$repo"
gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD -R "$repo" < "$password_file"
printf '%s' "$alias" | gh secret set ANDROID_UPLOAD_KEY_ALIAS -R "$repo"
echo "已写入 $repo 的 ANDROID_UPLOAD_KEYSTORE_BASE64、ANDROID_UPLOAD_KEYSTORE_PASSWORD、ANDROID_UPLOAD_KEY_ALIAS"
keytool -list -keystore "$keystore" -storepass:file "$password_file" -alias "$alias" | grep -i "SHA-256" || true
echo "请立即备份 $dir"
