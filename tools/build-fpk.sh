#!/usr/bin/env bash
# 组装 fnOS 应用包并调用 fnpack 打包（Windows / Linux 通用）
set -e

BASE="$(cd "$(dirname "$0")/.." && pwd)"

# 应用目录可能是 legado-web（仓库）或 fnos-legado（本地工作目录）
# 两个都在时取 manifest 最新的那个，避免用到过期副本
SRC=""
NEWEST=0
for d in "$BASE/legado-web" "$BASE/fnos-legado"; do
  [ -f "$d/manifest" ] || continue
  ts=$(stat -c %Y "$d/manifest" 2>/dev/null || stat -f %m "$d/manifest" 2>/dev/null || echo 0)
  if [ "$ts" -gt "$NEWEST" ]; then NEWEST="$ts"; SRC="$d"; fi
done
if [ -z "$SRC" ]; then echo "找不到应用目录（legado-web / fnos-legado）"; exit 1; fi
echo "应用目录: $SRC"

OUT="$BASE/build/$(basename "$SRC")"
DIST="$BASE/dist"
mkdir -p "$DIST"

echo "==> 1/4 打包前端服务（esbuild）"
cd "$SRC/app/server"
NODE_BIN="${NODE:-node}"
if [ -f node_modules/esbuild/bin/esbuild ]; then
  "$NODE_BIN" node_modules/esbuild/bin/esbuild src/server.js \
    --bundle --platform=node --target=node18 --format=cjs --minify \
    --outfile=server.bundle.js >/dev/null
else
  npx --yes esbuild src/server.js \
    --bundle --platform=node --target=node18 --format=cjs --minify \
    --outfile=server.bundle.js >/dev/null
fi

echo "==> 2/4 组装应用目录"
rm -rf "$OUT"
mkdir -p "$OUT/app/server" "$OUT/app/ui/images" "$OUT/wizard" "$OUT/config" "$OUT/cmd"

cp "$SRC/manifest" "$OUT/manifest"
cp "$SRC/ICON.PNG" "$SRC/ICON_256.PNG" "$OUT/"
cp "$SRC/config/privilege" "$SRC/config/resource" "$OUT/config/"
cp "$SRC"/cmd/* "$OUT/cmd/"
chmod +x "$OUT"/cmd/*
cp "$SRC/app/ui/config" "$OUT/app/ui/config"
cp "$SRC/app/ui/images/"*.png "$OUT/app/ui/images/"
cp "$SRC/app/server/server.bundle.js" "$OUT/app/server/"

# Python 规则引擎（可选，缺 legado_rule 时自动回退 Node）
if [ -d "$SRC/app/server/python" ]; then
  mkdir -p "$OUT/app/server/python"
  cp -r "$SRC/app/server/python/." "$OUT/app/server/python/"
fi

mkdir -p "$OUT/app/web"
cp -r "$SRC/app/web/." "$OUT/app/web/"

# 系统更新日志随包发布
mkdir -p "$OUT/app/web/docs"
if [ -f "$DIST/更新日志.txt" ]; then
  cp "$DIST/更新日志.txt" "$OUT/app/web/docs/changelog.txt"
elif [ -f "$BASE/docs/更新日志.txt" ]; then
  cp "$BASE/docs/更新日志.txt" "$OUT/app/web/docs/changelog.txt"
fi

echo "==> 3/4 检查包结构"
for f in manifest config/privilege config/resource ICON.PNG ICON_256.PNG app/ui/config app/server/server.bundle.js app/web/index.html; do
  [ -e "$OUT/$f" ] || { echo "缺少文件: $f"; exit 1; }
done
du -sh "$OUT"

echo "==> 4/4 fnpack build"
cd "$OUT"
if command -v fnpack >/dev/null 2>&1; then
  fnpack build
elif [ -x "$BASE/build-tools/fnpack.exe" ]; then
  "$BASE/build-tools/fnpack.exe" build
else
  echo "找不到 fnpack（CI 会自动下载，本地请放到 build-tools/fnpack.exe）"; exit 1
fi
mv -f "$(basename "$SRC").fpk" "$DIST/legado-web.fpk" 2>/dev/null || mv -f *.fpk "$DIST/legado-web.fpk"
ls -lh "$DIST"
