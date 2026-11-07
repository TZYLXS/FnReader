#!/usr/bin/env bash
# 组装 fnOS 应用包并调用 fnpack 打包
# 依赖：node（或设置 NODE=/path/to/node）、fnpack（PATH 里，或放到 build-tools/）
set -e

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$BASE/legado-web"
OUT="$BASE/build/legado-web"
DIST="$BASE/dist"
NODE="${NODE:-node}"

command -v "$NODE" >/dev/null 2>&1 || { echo "找不到 node，请先安装 Node.js 18+，或设置 NODE=/path/to/node"; exit 1; }

echo "==> 1/4 打包前端服务（esbuild）"
cd "$SRC/app/server"
if [ -x node_modules/esbuild/bin/esbuild ]; then
  "$NODE" node_modules/esbuild/bin/esbuild src/server.js \
    --bundle --platform=node --target=node18 --format=cjs --minify \
    --outfile=server.bundle.js >/dev/null
else
  npx --yes esbuild src/server.js \
    --bundle --platform=node --target=node18 --format=cjs --minify \
    --outfile=server.bundle.js >/dev/null
fi

echo "==> 2/4 组装应用目录"
rm -rf "$OUT"
mkdir -p "$OUT/app/server" "$OUT/app/ui/images" "$OUT/wizard" "$OUT/config" "$OUT/cmd" "$DIST"

cp "$SRC/manifest" "$OUT/manifest"
cp "$SRC/ICON.PNG" "$SRC/ICON_256.PNG" "$OUT/"
cp "$SRC/config/privilege" "$SRC/config/resource" "$OUT/config/"
cp "$SRC"/cmd/* "$OUT/cmd/"
chmod +x "$OUT"/cmd/*
cp "$SRC/app/ui/config" "$OUT/app/ui/config"
cp "$SRC/app/ui/images/"*.png "$OUT/app/ui/images/"
cp "$SRC/app/server/server.bundle.js" "$OUT/app/server/"
cp -r "$SRC/app/web/." "$OUT/app/web/"

# 把更新日志一并打进包里（随静态资源发布，应用内可直接打开）
mkdir -p "$OUT/app/web/docs"
if [ -f "$BASE/docs/更新日志.txt" ]; then
  cp "$BASE/docs/更新日志.txt" "$OUT/app/web/docs/changelog.txt"
fi

echo "==> 3/4 检查包结构"
for f in manifest config/privilege config/resource ICON.PNG ICON_256.PNG app/ui/config app/server/server.bundle.js app/web/index.html; do
  [ -e "$OUT/$f" ] || { echo "缺少文件: $f"; exit 1; }
done
du -sh "$OUT" 2>/dev/null || true

echo "==> 4/4 fnpack build"
FNPACK="${FNPACK:-}"
if [ -z "$FNPACK" ]; then
  if command -v fnpack >/dev/null 2>&1; then FNPACK="fnpack"
  elif [ -x "$BASE/build-tools/fnpack.exe" ]; then FNPACK="$BASE/build-tools/fnpack.exe"
  elif [ -x "$BASE/build-tools/fnpack" ]; then FNPACK="$BASE/build-tools/fnpack"
  else echo "找不到 fnpack，请从 https://developer.fnnas.com/docs/cli/fnpack/ 下载后放到 PATH 或 build-tools/"; exit 1
  fi
fi

cd "$OUT"
"$FNPACK" build
mv -f ./*.fpk "$DIST/" 2>/dev/null || true
ls -lh "$DIST"/*.fpk
