#!/usr/bin/env bash
# 一条命令完成：升版本 → 写更新日志 → 打包 → 提交 → 推 main → 打 tag（CI 自动发 Release）
#
#   bash tools/publish.sh "修复了 xxx；新增了 yyy"
#
# 前提：本机已配置可推送的 origin（HTTPS/SSH 均可）
set -e

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTE="${1:?用法: bash tools/publish.sh \"更新说明；第二条\"}"
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || PY=python

cd "$BASE"

echo "==> 1/4 升版本 + 写更新日志 + 打包"
"$PY" tools/release.py "$NOTE" --build

VER="$(grep '^version=' legado-web/manifest | cut -d= -f2 | tr -d '[:space:]')"
echo "==> 版本 $VER"

echo "==> 2/4 提交"
git add -A
git commit -m "release: v$VER — $NOTE" || echo "（没有需要提交的改动）"

echo "==> 3/4 推送源码"
git push origin HEAD:main

echo "==> 4/4 打 tag 触发 CI 发版"
git tag -f "v$VER"
git push origin "v$VER"

echo
echo "完成：v$VER 已推送，GitHub Actions 会自动构建 fpk 并发布到 Releases"
echo "安装到飞牛：应用中心 → 手动安装（升级请先卸载，数据目录会保留）"
