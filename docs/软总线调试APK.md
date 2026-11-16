# 软总线调试工具（Android APK）

一个独立的小 App，用来手动连接 FnReader 服务端，**可视化软总线（Soft Bus）**的工作状态：
谁在线、领了什么任务（search / toc / content / bookinfo / ebook-parse）、payload 长什么样、
回传的内容是什么、服务端是否收到。

源码在 `tools/bus-debug-app/`，本文档面向「让 AI 重新构建 / 修改这个 APK」的场景。

## 0. 直接下载（不想自己构建）

Release 里已经挂好现成 APK：

```
https://github.com/TZYLXS/FnReader/releases/download/v2.6.11/bus-debug.apk
```

也由 GitHub Actions 自动构建（`.github/workflows/build-bus-debug.yml`），
每次 `tools/bus-debug-app/**` 变更会自动产出 `bus-debug-apk` Artifact。

---

## 1. 它能做什么

| 功能 | 说明 |
| --- | --- |
| 手动连接 | 填服务端地址、访问令牌、设备 ID/名称，点「连接」拉取 `/api/bus` |
| 总线状态 | 展示在线设备、handled 次数、pending 任务数（格式化 JSON） |
| 长轮询领任务 | `GET /api/m/remote/pending` 长轮询，每个任务弹窗展示 payload |
| 手动回传 | 弹窗里可编辑 `data` / 失败原因，点「回传成功 / 回传失败」提交 `/api/m/remote/result` |
| 手动下发任务 | 选 search / toc / content / bookinfo，填 payload 后 `POST /api/remote/job`，观察服务端等待与结果 |
| 运行日志 | 所有请求/响应带时间戳，可导出到应用外部目录 |

---

## 2. 软总线协议（服务端契约）

### 2.1 设备心跳与领任务

```http
GET /api/m/remote/pending?token=<API_TOKEN>&wait=10000&limit=5&id=<deviceId>&name=<deviceName>
```

- `wait`：长轮询毫秒数，最大 30000
- 返回：

```json
{ "jobs": [ { "id": "a1b2c3d4e5f6", "type": "search",
              "payload": { "source": "https://xxx.com", "key": "斗破苍穹" },
              "age": 1200 } ] }
```

- 未确认缓存位置时返回 **409**：

```json
{"error":"请先在网页端确认缓存保存位置","needConfirm":true,"setupUrl":"/#/setup"}
```

### 2.2 回传结果

```http
POST /api/m/remote/result?token=<API_TOKEN>
{ "id": "a1b2c3d4e5f6", "ok": true,
  "data": { "books": [ { "name": "…", "author": "…", "bookUrl": "…" } ] } }
```

失败：

```json
{ "id": "a1b2c3d4e5f6", "ok": false, "error": "解析失败原因" }
```

### 2.3 任务类型与 data 结构

| type | payload | data |
| --- | --- | --- |
| `search` | `{source, key}` | `{books:[{name,author,bookUrl,coverUrl,intro,kind}]}` |
| `toc` | `{source, bookUrl}` | `{chapters:[{title,url}]}` |
| `content` | `{source, chapterUrl, bookUrl}` | `{paragraphs:[string]}` |
| `bookinfo` | `{bookUrl}` | `{intro,coverUrl,author,kind,wordCount,lastChapter,totalChapterNum}` |
| `ebook-parse` | `{name,format,dataBase64}` | `{chapters:[…]}` |
| `ebook-chapter` | `{name,format,dataBase64,index}` | `{paragraphs:[…]}` |

### 2.4 查看总线 / 暂停设备

```http
GET  /api/bus
POST /api/bus/toggle   {"id":"phone-demo","enabled":false}
```

### 2.5 手动下发任务（模拟网页端）

```http
POST /api/remote/job
{ "type": "search", "payload": { "source": "https://xxx.com", "key": "斗破苍穹" }, "waitMs": 20000 }
```

- `waitMs` 最大 60000；`ebook-parse` 等待上限 240000
- 服务端会等手机回传后再返回 `{ok:true,data:{…}}`，超时返回 504

---

## 3. 项目结构

```
tools/bus-debug-app/
├── settings.gradle.kts
├── build.gradle.kts              # AGP 8.5.2 / Kotlin 1.9.24
├── gradle.properties
├── app/
│   ├── build.gradle.kts          # compileSdk 34, minSdk 24
│   └── src/main/
│       ├── AndroidManifest.xml   # INTERNET + usesCleartextTraffic
│       └── java/com/tzylxs/busdebug/MainActivity.kt
└── README.md
```

界面是**纯代码构建**的（没有 XML 布局、没有图片资源），方便 AI 直接改逻辑。

---

## 4. 构建 APK

### 4.1 环境

- JDK 17
- Android SDK Platform 34 + Build-Tools 34
- Gradle 8.7（或使用 Android Studio 自带）

### 4.2 Android Studio

1. `File → Open` 选择 `tools/bus-debug-app`
2. 等待 Gradle Sync
3. `Build → Build Bundle(s)/APK(s) → Build APK(s)`
4. 产物：`app/build/outputs/apk/debug/app-debug.apk`

### 4.3 命令行

```bash
cd tools/bus-debug-app
# 首次需要生成 gradle wrapper（本仓库没有提交 gradle-wrapper.jar）
gradle wrapper --gradle-version 8.7

# 构建 debug 包
./gradlew assembleDebug

# 安装到手机
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Windows：

```bat
gradle wrapper --gradle-version 8.7
gradlew.bat assembleDebug
```

### 4.4 签名 release 包（可选）

```bash
keytool -genkeypair -v -keystore bus-debug.jks -alias busdebug \
  -keyalg RSA -keysize 2048 -validity 10000

./gradlew assembleRelease
# 然后使用 apksigner 签名
apksigner sign --ks bus-debug.jks --ks-key-alias busdebug \
  --out bus-debug.apk app/build/outputs/apk/release/app-release-unsigned.apk
```

> 也可以用 Android Studio 的「Generate Signed Bundle / APK」向导，更省事。

---

## 5. 使用流程

1. 打开 App，填：
   - 服务端地址：`http://10.5.4.70:1122`（局域网）或 Cloudflare 域名
   - 访问令牌：网页端「设置 → 手机接入 → 访问令牌」
   - 设备 ID / 设备名：任意，调试用
2. 点 **连接**：看到 `/api/bus` 的设备列表与 pending 数
3. 点 **开始轮询**：保持前台，服务端派任务时会弹窗
4. 弹窗里：
   - 上半部分是 payload（只读/可编辑）
   - 中间是回传 `data`，默认模板按任务类型给出
   - 点 **回传成功** → 服务端立刻拿到结果
   - 点 **回传失败** 或 **忽略** 验证超时分支
5. 点 **下发搜索/目录/正文/详情**：App 直接向服务端建任务，可在日志里看到服务端返回的最终数据

---

## 6. 扩展建议（给 AI 的改造点）

- **自动应答**：`defaultData()` 里按 type 生成假数据，改成自动回传即可做「假手机」压测。
- **批量压测**：循环 `POST /api/remote/job` 几百次，统计 P95 延迟与 504 比例。
- **WebSocket 版**：目前是长轮询；服务端如果加 SSE/WS，可把 `pollOnce()` 换成订阅。
- **ebook 任务**：`ebook-parse` / `ebook-chapter` 的 payload 带 base64 文件，弹窗里直接展示会卡；
  建议加「保存到文件」再查看。
- **HTTPS 自签证书**：当前 `usesCleartextTraffic=true`；若服务端上 HTTPS 自签，需要
  自定义 `TrustManager` 或改用系统信任的证书（Cloudflare 域名天然可信）。

---

## 7. 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 连接失败 / 超时 | 手机与服务端不在同一网络，或端口未放行 | 用局域网 IP 测试；公网走 Cloudflare 域名 |
| 轮询一直 409 | 服务端新装/升级后未确认缓存位置 | 网页端打开设置确认一次 |
| 回传后服务端仍超时 | `id` 不对或 token 错误 | 检查日志里的 409/401 |
| 任务弹窗太多 | 服务端在批量派单 | 先「停止轮询」，或把 `limit` 改小 |
| 真机装不上 | 未开启「允许安装未知来源」 | 系统设置里允许 |

---

## 8. 相关文档

- `docs/APP同步接口.md`（8.x 软总线章节，完整字段）
- `docs/手机接入API.md`（token 获取、接口前缀）
- `docs/fnos-fpk-build.md`（服务端打包与部署）
