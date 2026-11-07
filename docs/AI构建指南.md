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

bash tools/build-fpk.sh                  # 产物 dist/legado-web.fpk
python tools/release.py "改了什么；另一条" --build   # 版本+1、写日志、改资源版本号、打包
node test/e2e.js                         # 端到端测试（35 条断言，内置模拟站）
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
