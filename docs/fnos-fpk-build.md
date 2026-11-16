# fnOS FPK 打包与上架指南（官方规范整理）

> 本文根据 fnOS（飞牛 OS）官方应用包规范与 `fnpack` / `appcenter-cli` 的实际行为整理，
> 面向想把 Web 服务（Node / Python / 静态站点）打成 FPK 安装到 fnOS 的开发者。
> 文末附本项目「阅读（legado-web）」的完整实例。

---

## 1. 什么是 FPK

FPK 是 fnOS 的应用安装包，本质是一个带约定目录结构的压缩包：

```
legado-web.fpk
├── manifest                 # 必需：应用元信息（键值对）
├── ICON.PNG                 # 必需：应用图标（建议 256x256）
├── ICON_256.PNG             # 可选：大图标
├── config/
│   ├── privilege            # 运行身份（用户/用户组）
│   └── resource             # 资源限制（可空对象）
├── cmd/
│   └── main                 # 必需：生命周期脚本 start/stop/status
└── app/
    ├── ui/
    │   ├── config           # 桌面入口定义（iframe 页面 / 直连端口）
    │   └── images/          # 入口图标 icon_{size}.png
    └── server/              # 你自己的程序文件（任意内容）
```

打包工具会把上述目录压缩为 `.fpk`，安装时由 `appcenter-cli` 解压到
`/var/apps/<appname>/target`（下文简称 `$TRIM_APPDEST`）。

---

## 2. manifest 字段说明

`manifest` 是 `key=value` 文本，**不能有 BOM，不要写注释**。常用字段：

| 字段 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `appname` | 是 | 应用唯一标识，小写字母/数字/连字符 | `legado-web` |
| `version` | 是 | 版本号，`x.y.z`；升级安装靠它比较 | `2.6.7` |
| `display_name` | 是 | 应用中心显示名 | `阅读` |
| `desc` | 是 | 一句话描述 | `在飞牛中读书…` |
| `source` | 是 | 来源，第三方填 `thirdparty` | `thirdparty` |
| `platform` | 是 | 架构，纯脚本/Node 填 `all` | `all` |
| `maintainer` | 是 | 维护者 | `TZYLXS` |
| `maintainer_url` | 否 | 维护者主页 | `https://github.com/TZYLXS` |
| `distributor` | 否 | 分发者 | `TZYLXS` |
| `desktop_uidir` | 是 | 桌面入口目录，相对包根 | `ui` |
| `desktop_applaunchname` | 是 | 默认启动入口 key，对应 `app/ui/config` 里的 `.url` 键 | `legado-web.main` |
| `install_dep_apps` | 否 | 依赖的官方应用（逗号分隔） | `nodejs_v22` |
| `service_port` | 否 | 服务端口，入口/网关会用到 | `1122` |
| `checkport` | 否 | 是否由系统探测端口就绪 | `false` |
| `ctl_stop` | 否 | 是否走 `cmd/main stop` 停止 | `true` |
| `changelog` | 否 | 本版本更新说明（单行） | `修复…` |

注意：

- `appname` 一旦确定不要改，数据目录、网关路径、升级都依赖它。
- `version` 必须随每次安装递增，否则 `appcenter-cli` 可能拒绝或视为同版本重装。
- `install_dep_apps=nodejs_v22` 表示安装前必须先装「Node.js v22」官方应用，
  运行时在 `/var/apps/nodejs_v22/target/bin/node`。
- `desktop_applaunchname` 必须与 `app/ui/config` 的键一致，否则桌面没有入口。

---

## 3. config/privilege：运行身份

```json
{
  "defaults": {
    "run-as": "package"
  },
  "username": "legado",
  "groupname": "legado"
}
```

- `run-as: package`：以本应用专属用户运行（推荐，隔离数据目录）。
- `username` / `groupname`：安装时自动创建，无登录 shell。
- 如果程序需要读取用户共享目录（如 `/vol1/1000/Books`），要把该目录设成
  该用户可读，或放行 ACL（本项目用 `chmod 644` + 目录属主调整解决）。

`config/resource` 可以是空对象：

```json
{}
```

如需限制内存/CPU，可按官方字段补充 `memory_limit`、`cpu_quota` 等（一般 Web 服务无需）。

---

## 4. cmd/main：生命周期脚本

必须支持 `start` / `stop` / `status` 三个参数，返回值约定：

| 命令 | 成功 | 失败 |
| --- | --- | --- |
| `start` | 0 | 非 0 |
| `stop` | 0 | 0（幂等） |
| `status` | 0（运行中） | 3（未运行） |

脚本里可用的环境变量（由 fnOS 注入）：

| 变量 | 含义 |
| --- | --- |
| `TRIM_APPDEST` | 应用安装目录，例如 `/var/apps/legado-web/target` |
| `TRIM_PKGVAR` | 应用数据目录，例如 `/var/apps/legado-web/var`（推荐持久化到这里） |
| `TRIM_SERVICE_PORT` | 分配的服务端口 |
| `TRIM_TEMP_LOGFILE` | 临时日志文件（启动失败写这里） |
| `TRIM_APPNAME` | 应用名 |

最小可用模板：

```bash
#!/bin/bash
NODE_BIN="/var/apps/nodejs_v22/target/bin/node"
DATA_DIR="${TRIM_PKGVAR:-/var/apps/legado-web/var}"
PID_FILE="$DATA_DIR/app.pid"
LOG_FILE="$DATA_DIR/app.log"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
}

do_start() {
  if is_running; then return 0; fi
  [ -x "$NODE_BIN" ] || NODE_BIN=$(command -v node)
  mkdir -p "$DATA_DIR"
  export TRIM_APPNAME TRIM_APPDEST TRIM_PKGVAR TRIM_SERVICE_PORT
  cd "$TRIM_APPDEST" || return 1
  nohup "$NODE_BIN" "$TRIM_APPDEST/server/server.bundle.js" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  is_running
}

do_stop() {
  if is_running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    sleep 1
    kill -9 "$(cat "$PID_FILE")" 2>/dev/null
  fi
  rm -f "$PID_FILE" "${TRIM_APPDEST}/app.sock"
}

case "$1" in
  start) do_start ;;
  stop) do_stop ;;
  status) is_running && exit 0 || exit 3 ;;
  *) exit 1 ;;
esac
```

要点：

- 用 `nohup` + PID 文件，避免脚本退出后进程被回收。
- 停止时**顺手删除 `$TRIM_APPDEST/app.sock`**，否则网关 Socket 残留会导致下次启动失败。
- 脚本必须可执行：`chmod +x cmd/main`。

---

## 5. app/ui/config：桌面入口

决定应用中心「打开」按钮怎么打开你的应用：

```json
{
  ".url": {
    "legado-web.main": {
      "title": "阅读",
      "icon": "images/icon_{0}.png",
      "type": "iframe",
      "protocol": "",
      "gatewayPrefix": "/app/legado-web",
      "gatewaySocket": "app.sock",
      "url": "/app/legado-web/",
      "allUsers": true
    }
  }
}
```

两种典型入口：

1. **网关入口（推荐）**
   - `gatewayPrefix: /app/<appname>`，`gatewaySocket: app.sock`
   - fnOS 网关会通过 unix socket 把请求转发给你的进程
   - 你的服务需要监听 `app.sock`（或让网关按端口反代）
   - 页面里**不要写死 `/api/...` 根路径**，要用相对路径 `./api/...`，
     否则在 `/app/<appname>/` 子路径下会 404（本项目踩过）

2. **直连端口入口**
   - `protocol: "http"`，`port: "1122"`，`url: "/"`
   - 页面上额外提供一个 `noDisplay: true` 的入口即可不显示在桌面

建议：宿主环境保留网关入口，直连端口入口标记 `noDisplay`，方便调试又不干扰用户。

---

## 6. 打包：fnpack

```bash
fnpack build                 # 在当前目录生成 <appname>.fpk
fnpack build --output dist   # 指定输出目录
```

打包前自检清单：

- [ ] `manifest` 无 BOM、`version` 已递增
- [ ] `ICON.PNG` 存在（256×256 PNG）
- [ ] `cmd/main` 可执行、`start/stop/status` 可跑
- [ ] `app/ui/config` 中 `desktop_applaunchname` 键存在
- [ ] 程序文件权限：建议 `644`，目录 `755`
- [ ] 不把 `node_modules` 里不需要的测试文件、`.git` 打进去（体积）

---

## 7. 安装 / 升级 / 卸载：appcenter-cli

```bash
# 安装（必须显式指定卷，否则报 "Use --volume"）
appcenter-cli install-fpk --volume 4 /tmp/legado-web.fpk

# 启动 / 停止
appcenter-cli start   legado-web
appcenter-cli stop    legado-web
appcenter-cli status  legado-web
appcenter-cli list                # 查看所有应用与状态
```

常见流程（升级）：

```bash
appcenter-cli stop   legado-web
appcenter-cli uninstall legado-web
appcenter-cli install-fpk --volume 4 /tmp/legado-web.fpk
appcenter-cli start  legado-web
```

### ⚠️ 卸载会删除 `@appdata`

实测：`appcenter-cli uninstall` 会同时删掉 `/vol4/@appdata/<appname>`（用户数据）。
如果你把数据放在 `@appdata`，升级前务必：

```bash
cp -a /vol4/@appdata/legado-web /vol4/@appdata/legado-web.bak-deploy
# …卸载、安装、启动…
cp -a /vol4/@appdata/legado-web.bak-deploy/. /vol4/@appdata/legado-web/
```

或者直接把数据目录指向 `@appdata` 之外的路径（如 `/vol4/1000/xxx`）。

---

## 8. 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `install-fpk` 报 `Use --volume` | 未指定卷 | 加 `--volume 4` |
| 安装成功但桌面无入口 | `desktop_applaunchname` 与 `app/ui/config` 键不一致 | 改成一致的 key |
| 打开白屏 | 页面里写死了 `/api`、`/assets` 根路径 | 改相对路径 `./api` |
| 启动失败，日志为空 | `cmd/main` 没有可执行权限 / 依赖未装 | `chmod +x`，检查 `nodejs_v22` |
| 重启后启动失败 | 网关 Socket 残留 | `stop` 里删除 `app.sock` |
| 端口被占用 | 固定端口与其它应用冲突 | 改用 `TRIM_SERVICE_PORT` 或 `checkport` |
| 升级后数据丢失 | 卸载删除 `@appdata` | 卸载前备份、安装后还原 |
| 进程启动即退出 | 以 package 用户运行，无写权限 | 数据目录 `chown` 到 `username` |
| 文件读不到 | 共享目录权限 | `chmod 644` / ACL 放行 |
| 应用内 404 | 网关前缀 `/app/<app>` 未剥离 | 服务端按相对路径处理静态资源 |

---

## 9. 本项目实例（legado-web）

目录：

```
work/fnos-legado/
├── manifest
├── ICON.PNG / ICON_256.PNG
├── config/{privilege,resource}
├── cmd/main
├── app/ui/config + app/ui/images
└── app/
    ├── web/            # 前端（index.html / app.js / style.css / docs）
    └── server/         # server.bundle.js（esbuild 打包）+ python/（规则引擎）
```

manifest 关键行：

```ini
appname=legado-web
version=2.6.7
install_dep_apps=nodejs_v22
service_port=1122
desktop_uidir=ui
desktop_applaunchname=legado-web.main
gatewayPrefix=/app/legado-web        # 在 app/ui/config
```

打包与发布脚本（仓库内）：

```bash
bash tools/build-fpk.sh      # esbuild 打包服务端 → 复制前端/docs → fnpack
bash tools/build-debug.sh    # 生成独立调试包（端口 1123，版本 0.0.X）
bash tools/auto-release.sh   # 升版本 → 打包 → 安装 → 推送 GitHub → 等 CI Release
```

CI 产物：GitHub Releases 中的 `legado-web.fpk`，可在 fnOS 应用中心手动安装。

---

## 10. 参考

- fnOS 开发者中心：<https://developer.fnnas.com/>
- fnOS 应用包规范（manifest / 生命周期脚本 / 桌面入口）：以开发者中心最新文档为准
- `fnpack`、`appcenter-cli`：随 fnOS 系统提供，SSH 登录 NAS 后可直接使用

> 提示：官方字段可能随 fnOS 版本增加，本文档以实际可用的最小集合为准；
> 遇到新字段以 `fnpack` 校验输出和开发者中心文档为准。
