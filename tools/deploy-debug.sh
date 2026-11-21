#!/bin/bash
# 部署 debug 服务端并保证单实例（避免旧进程占 1123 导致新代码不生效）
# 用法：bash tools/deploy-debug.sh /tmp/server.bundle.js
set -e
APP=/vol4/@appcenter/legado-web-debug
VAR=/vol4/@appdata/legado-web-debug
PORT=1123
BUNDLE_SRC=${1:-/tmp/lw-debug-bundle.js}

echo "[deploy] copy bundle"
sudo -S -p "" cp "$BUNDLE_SRC" "$APP/server/server.bundle.js" <<< 'a!123456'
sudo -S -p "" chown legado:legado "$APP/server/server.bundle.js" <<< 'a!123456'

echo "[deploy] stop instances on :$PORT"
PIDS=$(sudo -S -p "" ss -lptn "sport = :$PORT" 2>/dev/null <<< 'a!123456' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
if [ -z "$PIDS" ]; then
  PIDS=$(pgrep -f "legado-web-debug/server/server.bundle.js" || true)
fi
if [ -n "$PIDS" ]; then
  echo "[deploy] kill $PIDS"
  sudo -S -p "" kill $PIDS 2>/dev/null <<< 'a!123456' || true
  sleep 3
  sudo -S -p "" kill -9 $PIDS 2>/dev/null <<< 'a!123456' || true
fi
sleep 1

echo "[deploy] start"
sudo -S -p "" -u legado env \
  TRIM_APPNAME=legado-web-debug \
  TRIM_APPDEST="$APP" \
  TRIM_PKGVAR="$VAR" \
  TRIM_SERVICE_PORT="$PORT" \
  NODE_COMPILE_CACHE="$VAR/cache/node-compile-cache" \
  UV_THREADPOOL_SIZE=16 \
  LD_LIBRARY_PATH="$APP/server/runtime/node/lib" \
  bash -c "cd $APP && nohup ./server/runtime/node/bin/node ./server/server.bundle.js >> $VAR/app.log 2>&1 & echo \$! > $VAR/app.pid" <<< 'a!123456'

sleep 4
COUNT=$(pgrep -fc "legado-web-debug/server/server.bundle.js" || true)
CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)
echo "[deploy] instances=$COUNT health=$CODE"
if [ "$COUNT" != "1" ] || [ "$CODE" != "200" ]; then
  echo "[deploy] FAILED: 期望单实例且 health=200"
  exit 1
fi
echo "[deploy] OK"
