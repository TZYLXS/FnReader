#!/usr/bin/env bash
# 组装 fnOS 应用包并调用 fnpack 打包
set -e
BASE="C:/Users/csjt1/OneDrive/文档/deepseek-harness/default-workspace/work"
NODE="C:/Users/csjt1/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
SRC="$BASE/fnos-legado"
OUT="$BASE/build/legado-web"
DIST="$BASE/dist"

echo "==> 1/4 打包前端服务（esbuild）"
cd "$SRC/app/server"
"$NODE" node_modules/esbuild/bin/esbuild src/server.js \
  --bundle --platform=node --target=node18 --format=cjs --minify \
  --outfile=server.bundle.js >/dev/null

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
# Python 规则引擎桥（可选，缺 legado_rule 时自动回退 Node）
if [ -d "$SRC/app/server/python" ]; then
  mkdir -p "$OUT/app/server/python"
  cp -r "$SRC/app/server/python/." "$OUT/app/server/python/"
fi
cp -r "$SRC/app/web/." "$OUT/app/web/"

# 把系统更新日志一并打进包里（随静态资源发布，可在应用内打开）
mkdir -p "$OUT/app/web/docs"
if [ -f "$BASE/dist/更新日志.txt" ]; then
  cp "$BASE/dist/更新日志.txt" "$OUT/app/web/docs/changelog.txt"
fi

echo "==> 3/4 检查包结构"
for f in manifest config/privilege config/resource ICON.PNG ICON_256.PNG app/ui/config app/server/server.bundle.js app/web/index.html; do
  [ -e "$OUT/$f" ] || { echo "缺少文件: $f"; exit 1; }
done
du -sh "$OUT"

echo "==> 4/4 fnpack build"
cd "$OUT"
"$BASE/build-tools/fnpack.exe" build
mv -f legado-web.fpk "$DIST/" 2>/dev/null || true
ls -lh "$DIST"
