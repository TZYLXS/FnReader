#!/usr/bin/env bash
# 只更新服务端 bundle + 前端静态文件并重启（保留书源/书架数据）
set -e
BASE="C:/Users/csjt1/OneDrive/文档/deepseek-harness/default-workspace/work"
NODE="C:/Users/csjt1/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
PASS='a!123456'
TMP='/c/Users/csjt1/AppData/Local/Temp/lw-deploy'
rm -rf "$TMP" && mkdir -p "$TMP"

cd "$BASE/fnos-legado/app/server"
"$NODE" node_modules/esbuild/bin/esbuild src/server.js --bundle --platform=node --target=node18 --format=cjs --minify --outfile=server.bundle.js >/dev/null
cp server.bundle.js "$TMP/server.bundle.js"
cp "$BASE/fnos-legado/app/web/index.html" "$BASE/fnos-legado/app/web/app.js" "$BASE/fnos-legado/app/web/style.css" "$TMP/"

cd "$BASE"
mkdir -p "$TMP/docs"
if [ -f "$BASE/dist/更新日志.txt" ]; then cp "$BASE/dist/更新日志.txt" "$TMP/docs/changelog.txt"; fi

for f in server.bundle.js index.html app.js style.css; do
  MSYS_NO_PATHCONV=1 "$NODE" tools/ssh.js put "$(cygpath -w "$TMP/$f")" "/tmp/lw-$f" >/dev/null
done
MSYS_NO_PATHCONV=1 "$NODE" tools/ssh.js put "$(cygpath -w "$TMP/docs/changelog.txt")" /tmp/lw-changelog.txt >/dev/null

MSYS_NO_PATHCONV=1 "$NODE" tools/ssh.js exec "
echo '$PASS' | sudo -S -p '' cp /tmp/lw-server.bundle.js /var/apps/legado-web/target/server/server.bundle.js &&
echo '$PASS' | sudo -S -p '' cp /tmp/lw-index.html /var/apps/legado-web/target/web/index.html &&
echo '$PASS' | sudo -S -p '' cp /tmp/lw-app.js /var/apps/legado-web/target/web/app.js &&
echo '$PASS' | sudo -S -p '' cp /tmp/lw-style.css /var/apps/legado-web/target/web/style.css &&
echo '$PASS' | sudo -S -p '' mkdir -p /var/apps/legado-web/target/web/docs &&
echo '$PASS' | sudo -S -p '' cp /tmp/lw-changelog.txt /var/apps/legado-web/target/web/docs/changelog.txt &&
echo '$PASS' | sudo -S -p '' chown -R legado:legado /var/apps/legado-web/target/server /var/apps/legado-web/target/web &&
echo '$PASS' | sudo -S -p '' appcenter-cli stop legado-web >/dev/null 2>&1;
sleep 1;
echo '$PASS' | sudo -S -p '' appcenter-cli start legado-web 2>&1 | tail -1;
sleep 2;
tail -3 /var/apps/legado-web/var/app.log
" 2>&1 | tail -6
