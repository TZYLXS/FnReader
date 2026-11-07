#!/bin/bash
# 上传/部署前备份：把 NAS 上的应用目录与数据目录打包到 var/backup/
set -e
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-node}"
HOST="${FNOS_HOST:?请设置 FNOS_HOST}"
USER="${FNOS_USER:-admin}"
PASS="${FNOS_PASS:?请设置 FNOS_PASS}"
APP="${FNOS_APP:-legado-web}"
STAMP="$(date +%Y%m%d-%H%M%S)"
REMOTE_DIR="/var/apps/$APP"
BACKUP_DIR="$REMOTE_DIR/var/backup"

cd "$BASE/tools"
FNOS_HOST="$HOST" FNOS_USER="$USER" FNOS_PASS="$PASS" "$NODE" ssh.js exec "
set -e
echo '$PASS' | sudo -S -p '' mkdir -p '$BACKUP_DIR'
# 1) 数据（书源/书架/下载索引/订阅/配置）
echo '$PASS' | sudo -S -p '' tar -czf '$BACKUP_DIR/data-$STAMP.tar.gz' \
  -C '$REMOTE_DIR/var' \$(ls '$REMOTE_DIR/var' | grep -v '^backup$' | tr '\n' ' ') 2>/dev/null || true
# 2) 当前安装的程序文件（用于回滚）
echo '$PASS' | sudo -S -p '' tar -czf '$BACKUP_DIR/app-$STAMP.tar.gz' -C '$REMOTE_DIR/target' . 2>/dev/null || true
ls -lh '$BACKUP_DIR' | tail -5
"
