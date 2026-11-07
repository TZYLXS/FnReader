#!/usr/bin/env bash
# 把当前构建部署到 fnOS 设备（只更新文件并重启，保留数据）
#
# 用法：
#   FNOS_HOST=192.168.1.10 FNOS_USER=admin FNOS_PASS=**** bash tools/deploy.sh
set -e

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-node}"
HOST="${FNOS_HOST:?请设置 FNOS_HOST（fnOS 设备地址）}"
USER="${FNOS_USER:-admin}"
PASS="${FNOS_PASS:?请设置 FNOS_PASS（设备登录密码）}"
APP="${FNOS_APP:-legado-web}"
REMOTE_APP="/var/apps/$APP"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/docs"

echo "==> 构建服务端 bundle"
cd "$BASE/legado-web/app/server"
if [ -x node_modules/esbuild/bin/esbuild ]; then
  "$NODE" node_modules/esbuild/bin/esbuild src/server.js --bundle --platform=node --target=node18 --format=cjs --minify --outfile=server.bundle.js >/dev/null
else
  npx --yes esbuild src/server.js --bundle --platform=node --target=node18 --format=cjs --minify --outfile=server.bundle.js >/dev/null
fi

cp server.bundle.js "$BASE/legado-web/app/web/index.html" "$BASE/legado-web/app/web/app.js" "$BASE/legado-web/app/web/style.css" "$TMP/"
[ -f "$BASE/docs/更新日志.txt" ] && cp "$BASE/docs/更新日志.txt" "$TMP/docs/changelog.txt"

echo "==> 上传"
cd "$BASE/tools"
for f in server.bundle.js index.html app.js style.css; do
  FNOS_HOST="$HOST" FNOS_USER="$USER" FNOS_PASS="$PASS" "$NODE" ssh.js put "$TMP/$f" "/tmp/lw-$f"
done
[ -f "$TMP/docs/changelog.txt" ] && FNOS_HOST="$HOST" FNOS_USER="$USER" FNOS_PASS="$PASS" "$NODE" ssh.js put "$TMP/docs/changelog.txt" /tmp/lw-changelog.txt

echo "==> 安装并重启"
FNOS_HOST="$HOST" FNOS_USER="$USER" FNOS_PASS="$PASS" "$NODE" ssh.js exec "
echo '$PASS' | sudo -S -p '' cp /tmp/lw-server.bundle.js $REMOTE_APP/target/server/server.bundle.js &&
echo '$PASS' | sudo -S -p '' cp /tmp/lw-index.html $REMOTE_APP/target/web/index.html &&
echo '$PASS' | sudo -S -p '' cp /tmp/lw-app.js $REMOTE_APP/target/web/app.js &&
echo '$PASS' | sudo -S -p '' cp /tmp/lw-style.css $REMOTE_APP/target/web/style.css &&
echo '$PASS' | sudo -S -p '' mkdir -p $REMOTE_APP/target/web/docs &&
echo '$PASS' | sudo -S -p '' cp /tmp/lw-changelog.txt $REMOTE_APP/target/web/docs/changelog.txt &&
echo '$PASS' | sudo -S -p '' chown -R legado:legado $REMOTE_APP/target/server $REMOTE_APP/target/web &&
echo '$PASS' | sudo -S -p '' appcenter-cli restart $APP >/dev/null 2>&1 || true
"

echo "完成。若应用中心版本号未更新，请卸载后重新安装 dist/legado-web.fpk"
