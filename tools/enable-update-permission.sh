#!/bin/bash
# 给飞牛应用授予「免密安装自身更新」的权限（一次性，需 root 执行）
#   sudo bash tools/enable-update-permission.sh [应用用户名]
set -e

CLI=/usr/local/bin/appcenter-cli
APP_USER="${1:-legado}"
TARGET=/etc/sudoers.d/fnreader-update

[ "$(id -u)" = "0" ] || { echo "请用 root 执行：sudo bash $0"; exit 1; }
[ -x "$CLI" ] || { echo "找不到 $CLI"; exit 1; }
id "$APP_USER" >/dev/null 2>&1 || { echo "用户 $APP_USER 不存在"; exit 1; }

echo "$APP_USER ALL=(root) NOPASSWD: $CLI" > "$TARGET"
chmod 0440 "$TARGET"

if visudo -c -f "$TARGET" >/dev/null 2>&1; then
  echo "已授权：$APP_USER 可免密执行 $CLI"
  echo "撤销：rm $TARGET"
else
  rm -f "$TARGET"
  echo "sudoers 校验失败，已回滚"
  exit 1
fi
