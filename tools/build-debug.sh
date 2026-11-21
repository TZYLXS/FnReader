#!/usr/bin/env bash
# FnReader debug-only FPK：仅生成 legado-web-debug，不改正式 manifest/1122。
set -euo pipefail

BASE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$BASE/legado-web"
OUT="$BASE/build/legado-web-debug"
DIST="$BASE/dist"
CACHE="$BASE/build/runtime-cache"
NODE_HOME="${FNREADER_NODE_HOME:-/var/apps/nodejs_v26/target}"
JAVA_HOME_DETECTED="${FNREADER_JAVA_HOME:-/var/apps/java-21-openjdk/target}"
PYTHON_BIN="${FNREADER_PYTHON:-/usr/bin/python3.11}"

[ "$(uname -m)" = "x86_64" ] || { echo "当前离线运行时仅支持 Linux x86_64"; exit 1; }
[ -f "$SRC/manifest" ] || { echo "缺少 $SRC/manifest"; exit 1; }
[ -x "$NODE_HOME/bin/node" ] || { echo "缺少 Node 26：$NODE_HOME/bin/node"; exit 1; }
[ -x "$JAVA_HOME_DETECTED/bin/javac" ] || { echo "缺少 JDK 21：$JAVA_HOME_DETECTED"; exit 1; }
[ -x "$JAVA_HOME_DETECTED/bin/jlink" ] || { echo "缺少 jlink：$JAVA_HOME_DETECTED"; exit 1; }
[ -x "$PYTHON_BIN" ] || { echo "缺少 Python 3.11：$PYTHON_BIN"; exit 1; }
NODE_VERSION="$($NODE_HOME/bin/node --version 2>/dev/null || true)"
case "$NODE_VERSION" in v26.*) ;; *) echo "Node 26 当前无法独立启动，构建时会封装 libatomic 后复验：${NODE_VERSION:-unknown}" ;; esac
JAVA_VERSION="$($JAVA_HOME_DETECTED/bin/java -version 2>&1 | sed -n '1p')"
PYTHON_VERSION="$($PYTHON_BIN --version 2>&1)"
printf 'Node: %s\nJava: %s\nPython: %s\n' "${NODE_VERSION:-v26 (待私有 libatomic 复验)}" "$JAVA_VERSION" "$PYTHON_VERSION"

# 只允许清理本脚本专用的 debug 构建目录。
[ "$OUT" = "$BASE/build/legado-web-debug" ] || { echo "非法构建目录：$OUT"; exit 1; }
rm -rf -- "$OUT"
mkdir -p "$OUT/app/server" "$OUT/app/ui/images" "$OUT/app/web" \
  "$OUT/wizard" "$OUT/config" "$OUT/cmd" "$CACHE" "$DIST"

printf '==> 1/7 生成独立 debug manifest\n'
cat > "$OUT/manifest" <<'EOF'
appname=legado-web-debug
version=0.1.0
display_name=阅读-debug
desc=调试版：Node 26、Java 21 TOC 引擎、Python 进程池、软总线与手势阅读，端口 1123。
source=thirdparty
platform=all
maintainer=TZYLXS
maintainer_url=https://github.com/TZYLXS
distributor=TZYLXS
desktop_uidir=ui
desktop_applaunchname=legado-web-debug.main
service_port=1123
checkport=false
ctl_stop=true
changelog=仅调试环境：Node 26、Java 21/Python 引擎、并发搜索、TOC 独立队列、阅读页布局与手势翻页
EOF

printf '==> 2/7 组装服务端与阅读页\n'
cp "$SRC/ICON.PNG" "$SRC/ICON_256.PNG" "$OUT/"
cp "$SRC/config/privilege" "$SRC/config/resource" "$OUT/config/"
cp "$SRC"/cmd/* "$OUT/cmd/"
chmod +x "$OUT"/cmd/*
sed -e 's/legado-web/legado-web-debug/g' -e 's/"port": "1122"/"port": "1123"/' \
  -e 's/"title": "阅读"/"title": "阅读-debug"/' \
  -e 's/"title": "阅读（直连端口）"/"title": "阅读-debug（直连端口）"/' \
  "$SRC/app/ui/config" > "$OUT/app/ui/config"
cp "$SRC/app/ui/images/"*.png "$OUT/app/ui/images/"
cp -r "$SRC/app/web/." "$OUT/app/web/"
[ -f "$SRC/app/server/server.bundle.js" ] || { echo "请先用 esbuild --target=node26 生成 server.bundle.js"; exit 1; }
[ -f "$SRC/app/server/parse-worker.bundle.js" ] || { echo "请先用 esbuild --bundle 生成 parse-worker.bundle.js"; exit 1; }
cp "$SRC/app/server/server.bundle.js" "$OUT/app/server/"
cp "$SRC/app/server/parse-worker.bundle.js" "$OUT/app/server/parse-worker.js"
cp -r "$SRC/app/server/python" "$OUT/app/server/python"
mkdir -p "$OUT/app/server/src/java"
cp "$SRC/app/server/src/java/FnReaderJavaWorker.java" "$OUT/app/server/src/java/"
# 不携带运行时数据、开发依赖或正式环境配置。
find "$OUT/app/server/python" -type d -name __pycache__ -prune -exec rm -rf -- {} +

printf '==> 3/7 编译 Java TOC worker\n'
mkdir -p "$OUT/app/server/java"
"$JAVA_HOME_DETECTED/bin/javac" -encoding UTF-8 -d "$OUT/app/server/java" \
  "$OUT/app/server/src/java/FnReaderJavaWorker.java"

printf '==> 4/7 内置 Node 26 与私有 libatomic\n'
mkdir -p "$OUT/app/server/runtime/node/bin" "$OUT/app/server/runtime/node/lib"
cp "$NODE_HOME/bin/node" "$OUT/app/server/runtime/node/bin/node"
chmod 755 "$OUT/app/server/runtime/node/bin/node"
[ -f "$NODE_HOME/LICENSE" ] && cp "$NODE_HOME/LICENSE" "$OUT/app/server/runtime/node/LICENSE" || true
ATOMIC_DIR="$CACHE/libatomic"
if [ ! -f "$ATOMIC_DIR/usr/lib/x86_64-linux-gnu/libatomic.so.1" ]; then
  mkdir -p "$ATOMIC_DIR"
  (cd "$CACHE" && apt-get download libatomic1)
  DEB="$(find "$CACHE" -maxdepth 1 -type f -name 'libatomic1_*.deb' -print -quit)"
  [ -n "$DEB" ] || { echo "libatomic1 下载失败"; exit 1; }
  dpkg-deb -x "$DEB" "$ATOMIC_DIR"
fi
cp -a "$ATOMIC_DIR/usr/lib/x86_64-linux-gnu/libatomic.so.1"* "$OUT/app/server/runtime/node/lib/"
LD_LIBRARY_PATH="$OUT/app/server/runtime/node/lib" "$OUT/app/server/runtime/node/bin/node" --version

printf '==> 5/7 生成 Java 21 精简运行时\n'
"$JAVA_HOME_DETECTED/bin/jlink" --add-modules java.base,java.net.http,jdk.httpserver,java.logging,jdk.crypto.ec \
  --no-man-pages --no-header-files --compress=zip-6 \
  --output "$OUT/app/server/runtime/java"
"$OUT/app/server/runtime/java/bin/java" -version
JAVA_PROBE_LOG="$CACHE/java-worker-probe.log"
: > "$JAVA_PROBE_LOG"
"$OUT/app/server/runtime/java/bin/java" -cp "$OUT/app/server/java" FnReaderJavaWorker > "$JAVA_PROBE_LOG" 2>&1 & JAVA_PID=$!
JAVA_PORT=''
for _ in $(seq 1 20); do
  JAVA_PORT="$(sed -n 's/^PORT=//p' "$JAVA_PROBE_LOG" | head -n 1)"
  [ -n "$JAVA_PORT" ] && break
  sleep 0.25
done
if [ -z "$JAVA_PORT" ]; then
  cat "$JAVA_PROBE_LOG"; kill "$JAVA_PID" >/dev/null 2>&1 || true; wait "$JAVA_PID" >/dev/null 2>&1 || true; exit 1
fi
JAVA_HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:$JAVA_PORT/health" || true)"
printf 'Java worker: %s\n' "$JAVA_HEALTH"
kill "$JAVA_PID" >/dev/null 2>&1 || true
wait "$JAVA_PID" >/dev/null 2>&1 || true
printf '%s' "$JAVA_HEALTH" | grep -q '"virtualThreads":true' || { echo 'Java 21 虚拟线程健康检查失败'; exit 1; }

printf '==> 6/7 内置 Python 3.11 运行时\n'
mkdir -p "$OUT/app/server/runtime/python/bin" "$OUT/app/server/runtime/python/lib"
cp "$PYTHON_BIN" "$OUT/app/server/runtime/python/bin/python3.11"
cp -aL /usr/lib/python3.11 "$OUT/app/server/runtime/python/lib/"
# fnOS 拒绝指向包外的绝对符号链接，运行时一律携带真实文件。
if find "$OUT/app/server/runtime" -type l -lname '/*' -print -quit | grep -q .; then
  echo '运行时仍含绝对符号链接'; exit 1
fi
cat > "$OUT/app/server/runtime/python/bin/python3" <<'EOF'
#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export PYTHONHOME="$ROOT"
export LD_LIBRARY_PATH="$ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$ROOT/bin/python3.11" "$@"
EOF
chmod 755 "$OUT/app/server/runtime/python/bin/python3"
"$OUT/app/server/runtime/python/bin/python3" --version
PYTHONPATH="$OUT/app/server/python:$OUT/app/server/python/vendor" \
  "$OUT/app/server/runtime/python/bin/python3" "$OUT/app/server/python/legado_bridge.py" probe

printf '==> 7/7 fnpack 构建与结构验收\n'
for f in manifest config/privilege config/resource ICON.PNG ICON_256.PNG \
  app/ui/config app/server/server.bundle.js app/server/parse-worker.js app/server/java/FnReaderJavaWorker.class \
  app/server/runtime/node/bin/node app/server/runtime/java/bin/java \
  app/server/runtime/python/bin/python3 app/web/index.html app/web/reader-gesture.js; do
  [ -e "$OUT/$f" ] || { echo "缺少文件：$f"; exit 1; }
done
(cd "$OUT" && fnpack build)
FPK="$(find "$OUT" -maxdepth 1 -type f -name 'legado-web-debug*.fpk' -print -quit)"
[ -n "$FPK" ] || { echo "fnpack 未生成 debug FPK"; exit 1; }
TARGET="$DIST/legado-web-debug-node26-java21.fpk"
cp "$FPK" "$TARGET"
tar -tf "$TARGET" | grep -E '^(app.tgz|manifest|cmd/main)$'
printf 'DEBUG_FPK=%s\n' "$TARGET"
sha256sum "$TARGET"
ls -lh "$TARGET"
