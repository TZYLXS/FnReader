# 给 AI 的构建指南（FnReader）

这份文档写给「想用 AI 继续开发本项目」的人：把仓库丢给模型，附上这个文件，就能少走弯路。
描述的是**当前代码的真实结构**，不是设想。

---

## 1. 这是什么

飞牛 fnOS 的应用（FPK 格式）。服务端是 Node.js，前端是原生 JS 单页应用，没有构建步骤（不用 webpack/vite）。
应用做的事：解析 Legado 书源规则 → 搜索/目录/正文 → 网页阅读器 + 下载 TXT + WebDAV + 手机 API。

**关键前提**：源码分两处

```
legado-web/            应用包工程（会被 fnpack 打包）
  manifest             元信息：appname / version / 依赖 nodejs_v22
  config/privilege     run-as: package，用户名 legado
  config/resource      端口、网关前缀
  cmd/main             start/stop/status 生命周期脚本（status 必须返回 0/3）
  app/ui/config        桌面入口与网关路径
  app/web/             前端（index.html + app.js + style.css，无框架）
  app/server/src/      服务端源码（最终被 esbuild 打成单文件）
tools/                 build-fpk.sh / release.py / deploy.sh / backup.sh
docs/                  文档与截图
dist/                  发布产物（fpk、示例书源）
test/                  e2e.js（内置模拟书源站）
```

---

## 2. 服务端结构（`legado-web/app/server/src/`）

| 文件 | 职责 |
| --- | --- |
| `server.js` | HTTP 路由、静态资源、SSE 搜索、下载任务、更新检查、手机 API、生命周期 |
| `books.js` | 搜索 / 详情 / 目录 / 正文 的完整流程；`isJunkResult()` 过滤期刊噪音 |
| `rules.js` | Legado 书源规则的解析与求值（CSS、`@` 链、索引、`##替换##`、`:正则`）|
| `xpath.js` | 精简 XPath 引擎（支持 `//a/@href`、`text()`、`position()`）|
| `jsrules.js` | `@js:` 规则沙箱（node:vm）|
| `util.js` | `request` / `requestBinary`：带超时、重试、全局并发信号量（4）|
| `store.js` | 数据落盘：sources.json / books.json / config.json |
| `cache.js` | 章节正文磁盘缓存 + 预取 |
| `searchcache.js` | 搜索结果缓存（key 带版本前缀，改逻辑要一起改版本）|
| `minidb.js` | 极简 JSONL 键值库 |
| `feeds.js` | RSS / Atom 解析 |
| `academic.js` | 学术关键词识别 |
| `dav.js` | WebDAV（/dav/books 只读、/dav/backup 读写）|
| `chapter-order.js` | 目录排序修正 |

**数据目录**：`/vol2/@appdata/legado-web/`（`TRIM_PKGVAR`），升级不会丢。

```
sources.json   书源（数组）      books.json   书架
config.json    设置 + apiToken   downloads.json 下载索引
cache/         正文缓存          webdav/backup/ WebDAV 备份
updates/       下载的更新包
```

---

## 3. 关键数据流

**搜索**：`GET /api/search?key=` → SSE 流
`start` → 每个源 `source-start`/`source-done` → `result`（合并去重后的书）→ `done`
每条结果字段：`name author coverUrl intro kind bookUrl origin originName`
搜索前会做三件事：学术词判定（`academic.js`）、可用源优先排序、结果过滤（`isJunkResult`）。

**阅读**：`GET /api/content?url=&index=` → `{title, paragraphs[], cached}`
正文先查 `cache.js`，未命中走书源规则，取到后写盘并预取下一章。

**图片**：`GET /api/image?url=&ref=` 服务端代理，避免图片站防盗链。

---

## 4. 手机 / 第三方接入

**HTTP API**（`X-Api-Token` 或 `?token=`，令牌在 `config.json` 的 `apiToken`）

| 接口 | 说明 |
| --- | --- |
| `GET /api/m/info` | 版本与接口表 |
| `GET /api/m/shelf` | 书架 |
| `GET /api/m/library` | **已缓存书籍清单**（书名 + 来源 + 章节数）|
| `GET /api/m/search?key=&limit=` | 跨源搜索 |
| `GET /api/m/toc?url=` | 目录 |
| `GET /api/m/content?url=&index=` | 正文 |
| `POST /api/m/progress` | 保存进度 |
| `GET /api/m/cover?url=` | 封面 |
| `POST /api/m/reset-token` | 重置令牌 |
| `GET/POST /api/m/sync` | App 一次拉/推书架与进度 |
| `GET/POST /api/m/sources/sync` | **书源双向同步**（`lastUpdateTime` 为准，LWW）|
| `POST /api/m/books` / `/cover` / `/sources` / `/cache` | App 上行：加书、传封面、传书源、传缓存文件 |

书源双向同步的约定：客户端每次改书源写 `lastUpdateTime = now`，推送时带上；
服务端按「时间戳大的赢、相等服务端赢」合并，`pull` 里回传服务端更进的版本。
详见 `docs/APP同步接口.md` 第 17 章。

**WebDAV**（Basic 认证，用户名随意、密码 = apiToken）

```
/dav/books/manifest.json   缓存书籍清单（同上 library.json）
/dav/books/<书名>.txt       下载好的书
/dav/backup/               可读写，Legado 备份用
```

`library.json` 结构：

```json
{
  "generatedAt": "2026-11-08T02:50:00.000Z",
  "count": 2,
  "books": [
    { "name": "聊斋志异", "origin": "【清】蒲松龄", "source": "🎉 狗狗书籍",
      "chapters": 50, "size": 860836, "bookUrl": "http://...", "path": "/dav/books/聊斋志异.txt" }
  ]
}
```

---

## 5. 构建 / 发版

```bash
# 依赖
cd legado-web/app/server && npm install && cd -

node test/e2e.js                         # 端到端测试（35 条断言，内置模拟站）
bash tools/build-fpk.sh                  # 只打包，产物 dist/legado-web.fpk
```

**每次改动都要走这一条**（升版本 → 写日志 → 打包 → 推源码 → 打 tag → CI 自动发 Release）：

```bash
bash tools/publish.sh "修复了 xxx；新增了 yyy"
```

`build-fpk.sh` 做的事：esbuild 打包 → 组装 `build/legado-web/` → 校验关键文件 → `fnpack build` → 拷到 `dist/`。
它会把 `docs/更新日志.txt` 复制成包内的 `app/web/docs/changelog.txt`（应用内更新日志就读这个）。

**部署到设备**（需要 fnOS 主机、账号密码）：

```bash
FNOS_HOST=192.168.1.10 FNOS_USER=admin FNOS_PASS=**** NODE=node bash tools/deploy.sh
```

---

## 6. 改代码时最容易踩的坑

1. **fnOS 覆盖安装无效**：`appcenter-cli install-fpk` 对已安装应用会返回成功但不替换文件。
   升级必须 `stop → uninstall → install → start`。`/api/update/install` 已按这个顺序实现（需 sudoers 授权，见 `tools/enable-update-permission.sh`）。
2. **前端缓存**：静态资源带 `?v=版本号`，`index.html` 里还有版本自愈脚本（页面版本与 `/api/health` 不一致会自动带 `?b=` 重载）。**改完前端必须让 `release.py` 跑一遍**，否则用户看到的还是旧页面。
3. **SSE 搜索**：不要用普通 `res.json`，客户端按 `data: {...}\n\n` 解析。
4. **规则求值**：`@` 链、`class.`/`text.` 前缀、`a.0`/`p!0`、`li.1:2` 索引都在 `rules.js`；加新语法先看 `parseSegment`。
5. **全局并发**：所有出站请求走 `util.js` 的信号量，别绕过它开裸 `fetch`，否则会打满 NAT。
6. **书源数据很大**（上千个），任何遍历都要考虑性能；`store.saveSources` 会整体写盘。
7. **`dataDir`**：本地调试用 `LEGADO_DATA=./data`，不要写死 `/vol2/...`。

本地起服务：

```bash
cd legado-web/app/server
PORT=1122 LEGADO_DATA=./data node src/server.js
```

---

## 7. 常见需求怎么改

| 想做的事 | 改哪里 |
| --- | --- |
| 加一个搜索过滤规则 | `books.js` 的 `isJunkResult` |
| 加一个设置项 | `app/web/app.js` 的 `renderSettings` + `server.js` 的 `/api/config` |
| 加一个手机接口 | `server.js` 里照抄 `/api/m/shelf`，注意走 token 校验分支 |
| 改阅读器样式 | `app/web/style.css` 末尾「Kindle 风格阅读页」段 |
| 换自动更新源 | `server.js` 的 `UPDATE_REPO` |
| 加书源解析语法 | `rules.js` + `xpath.js`，并在 `test/e2e.js` 补断言 |

---

## 8. 约束（请遵守）

- 不内置、不抓取盗版站点内容；示例书源只用公版书 / 开放获取（Gutenberg、arXiv、OALib）
- 不把设备密码、GitHub token 写进仓库或提交历史
- 提交前跑 `node test/e2e.js`，保持全绿
- 发版必须走 `tools/release.py`（版本号、更新日志、资源指纹三者要同步）

---

## 9. 可直接复制的提示词

把仓库（或 zip）丢给任意 AI，再粘下面第一段，它就能自己上手。

### 9.1 开局：让 AI 建立上下文

```text
你是 FnReader（飞牛 fnOS 上的 Legado 书源阅读器）的开发者。请先按顺序读这些文件建立上下文：
1. docs/AI构建指南.md      项目结构、数据流、坑
2. legado-web/manifest      版本与依赖
3. legado-web/app/server/src/server.js   路由总入口（很长，先看路由分发部分）
4. legado-web/app/server/src/books.js    搜索/目录/正文主流程
5. legado-web/app/web/app.js             前端单页应用（按路由函数划分）
6. test/e2e.js                            验收标准

读完向我复述：服务端有哪些模块、前端有几个页面、数据存在哪里、怎样才能发一版。
不要先写代码。
```

### 9.2 修 bug

```text
项目：FnReader（Node.js 服务端 + 原生 JS 前端，飞牛 FPK 应用）。

现象：<把报错、截图、复现步骤贴这里>

请：
1. 先在代码里定位根因（给出文件:行号），说明为什么会这样，不要猜；
2. 给出最小修复；
3. 说明这个改动会不会影响已有接口的返回结构；
4. 按「验收」小节自测。
```

### 9.3 加一个功能

```text
在 FnReader 里新增功能：<一句话描述>。

约定（必须遵守）：
- 服务端接口放 server.js 的 route() 里，路径以 /api/ 开头，出错统一 json(res, 4xx/5xx, {error})
- 需要鉴权的移动端接口放 /api/m/*，走 checkApiToken
- 前端：新页面 = 在 app.js 里加一个 renderXxx() + 在 router 里注册 path；样式追加到 style.css 末尾
- 不要引入前端框架，不要引入新的 npm 依赖（除非我同意）
- 改完在 test/e2e.js 补一条断言

先给我：改动清单（文件 + 函数 + 大致行数），我确认后再写代码。
```

### 9.4 适配新的书源规则

```text
FnReader 的书源规则解析在 legado-web/app/server/src/rules.js，XPath 在 xpath.js。

有个 Legado 书源用了我们还不支持的写法：<贴规则片段>

请：
1. 对照 Legado 的规则语法文档，说明这条规则的语义；
2. 判断 rules.js 里哪个函数负责解析（parseSegment / evalString / evalRule）；
3. 补上支持，并在 test/e2e.js 加一条覆盖该语法的断言。
```

### 9.5 调界面

```text
FnReader 前端是原生 JS，没有构建步骤。
要改的是：<页面/组件>，期望效果：<描述或参考图>。

约束：
- 只用 CSS 变量（--bg / --panel / --line / --text / --text-2 / --accent），不要写死颜色
- 移动端优先，宽度 360–500px 不能溢出
- 现有 class 命名用短横线，新增样式追加到 style.css 末尾，别改旧规则
- 改完告诉我怎么在本地预览（node test/preview.js）
```

### 9.6 发版

```text
请给 FnReader 发一版：
1. python tools/release.py "一句话说明；第二条" --build
2. 把 dist/legado-web.fpk 传到 GitHub Release（tag 由 release.py 写入 manifest 的版本决定）
3. 提醒我：fnOS 覆盖安装无效，必须 uninstall → install-fpk

发版前先跑 node test/e2e.js，必须 35 条全绿。
```

### 9.7 让 AI 自检（每个任务结尾都加这段）

```text
完成前请自查：
1. node test/e2e.js 是否全绿？失败项是哪条？
2. 有没有改动 /api/books、/api/toc、/api/content 的返回字段？（前端依赖这些字段，改了要同步改前端）
3. 新增的接口有没有做参数校验和错误处理？
4. 有没有把密码、token、个人路径写进代码或文档？
5. 改动是否需要跟着改 docs/更新日志.txt？
```

### 9.8 一句话版（懒人用）

```text
这是 FnReader 的源码（飞牛 fnOS 上的 Legado 阅读器）。先读 docs/AI构建指南.md，
然后帮我：<你的需求>。改完跑 node test/e2e.js，全绿再来找我。
```

---

## 10. 发版纪律（约定）

**每次改动都要：推送源码到 GitHub + 打 tag 发版**，不做「只改本地不推」的改动。

```bash
bash tools/publish.sh "一句话说明；第二条"
```

这条命令会：

1. `python tools/release.py` 递增版本号、写 `docs/更新日志.txt/.md`、同步 `app.js` 与 `index.html` 的版本显示
2. `tools/build-fpk.sh` 打包出 `dist/legado-web.fpk`
3. `git commit` 并推送 `main`
4. 打 `v<版本>` tag 并推送 → GitHub Actions 构建 + 发布 Release（带 fpk 产物）

装到飞牛：应用中心 → 手动安装，升级先卸载（`appcenter-cli install-fpk` 覆盖安装不生效），数据目录 `/vol2/@appdata/legado-web` 会保留。
