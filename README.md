# FnReader · 飞牛 fnOS 阅读器

把 [Legado（阅读）](https://github.com/gedoor/legado) 的书源生态带到飞牛 fnOS：不装模拟器，打开就是一个网页书架。
交流群：778213624

- **书源**：直接导入 Legado 3.x 书源 JSON，规则引擎实现了 CSS / XPath / JSONPath / 正则 / `@js:` 沙箱 / `@` 选择器链 / 索引语法
- **阅读**：书架、目录、正文、进度同步、主题/字号/行距
- **搜索**：多书源并发 + 结果流式返回；命中学术词时自动只搜学术源
- **订阅**：内置 RSS / Atom 阅读
- **下载**：整本抓取并合并为 TXT，可选保存到 fnOS 授权目录
- **离线加速**：章节正文磁盘缓存 + 后台预取，翻页约 20ms
- **手机接入**：`/api/m/*` 接口（令牌鉴权）供安卓 App 读取书架、目录、正文、进度
- **「阅读」APK 接入**：一键生成 Legado 书源导入链接，老安卓设备（4.4–5.1）装 [yuedu-android4](https://github.com/TZYLXS/yuedu-android4) 即可直连飞牛书库
- **WebDAV**：`/dav/` 把书架挂进文件管理器，也可直接给 Legado 的 WebDAV 备份用（客户端零改动）
- **应用内更新**：设置页检查 GitHub Release、下载 fpk 并给出安装指引
- **AI 友好**：结构扁平、无构建步骤，README 内附可直接复制的提示词，方便用 AI 继续开发

![书架](docs/screenshots/shelf.png)


---

## 安装

1. 从 [Releases](https://github.com/TZYLXS/FnReader/releases) 下载最新的 `legado-web.fpk`（打 tag 时由 CI 从源码构建，仓库不再提交旧包）
2. 飞牛「应用中心 → 手动安装」选择该文件
3. 桌面出现「阅读」图标，点击即可（走统一网关 `/app/legado-web/`）

依赖系统应用 `nodejs_v22`，安装时会自动拉起。

> **升级注意**：fnOS 的 `appcenter-cli install-fpk` 不支持覆盖升级（会提示成功但文件不变）。
> 升级请先卸载再安装；数据目录 `/vol2/@appdata/legado-web` 会保留。
> 也可以打开应用内「设置 → 版本更新」检查新版本并下载更新包。

## 使用

1. **书源** → 导入 Legado 书源 JSON（粘贴 / 链接 / 文件），或使用 [dist/](dist/) 里的示例源
2. 书源很多时先点「检测」，跑完点「停用未通过」，之后搜索会快很多
3. **搜索** → 找书 / 订阅；结果边搜边出，可随时停止
4. 书架点封面继续阅读；右上角「⋯」或长按封面可下载 TXT、刷新目录、删除

详细说明见 [docs/使用说明.md](docs/使用说明.md)，版本记录见 [docs/更新日志.md](docs/更新日志.md)。

## 手机 / 其他客户端接入

应用自带两种接入方式，客户端无需改代码：

**WebDAV**（给 Legado 的备份/恢复用，或挂进文件管理器）

```
http://<飞牛IP>:1122/dav/
用户名：任意        密码：设置页里的访问令牌
```

- `/dav/books/` 书架里已下载的书籍（只读，.txt）
- `/dav/backup/` 可读写，接 Legado「备份与恢复 → WebDAV」

**HTTP API**（给自建客户端用）

```
GET /api/m/shelf | /api/m/toc | /api/m/content | /api/m/cover
GET /api/m/search?key=...      POST /api/m/progress
请求头：X-Api-Token: <访问令牌>
```

详见 [docs/WebDAV接入.md](docs/WebDAV接入.md) 与 [docs/手机接入API.md](docs/手机接入API.md)。

## 用 AI 继续开发

这个项目刻意做成了「AI 友好」的结构：没有构建步骤、没有前端框架、目录扁平、测试自带模拟站点。
把仓库丢给任意 AI，粘一段下面的提示词，它就能自己上手改。

### 先让它建立上下文

```text
你是 FnReader（飞牛 fnOS 上的 Legado 书源阅读器）的开发者。请先按顺序读这些文件建立上下文：
1. docs/AI构建指南.md      项目结构、数据流、常见坑
2. legado-web/manifest      版本与依赖
3. legado-web/app/server/src/server.js   路由总入口（很长，先看路由分发）
4. legado-web/app/server/src/books.js    搜索 / 目录 / 正文主流程
5. legado-web/app/web/app.js             前端单页应用（按 renderXxx 划分）
6. test/e2e.js              验收标准

读完向我复述：服务端有哪些模块、前端有几个页面、数据存在哪里、怎样才能发一版。
不要先写代码。
```

### 修 bug

```text
项目：FnReader（Node.js 服务端 + 原生 JS 前端，飞牛 FPK 应用）。

现象：<把报错、截图、复现步骤贴这里>

请：
1. 先在代码里定位根因（给出 文件:行号），说明为什么会这样，不要猜；
2. 给出最小修复；
3. 说明会不会影响已有接口的返回结构；
4. 按「收尾自检」一节自测。
```

### 加功能

```text
在 FnReader 里新增功能：<一句话描述>。

约定（必须遵守）：
- 服务端接口放 server.js 的 route() 里，路径 /api/ 开头，出错统一 json(res, 4xx/5xx, {error})
- 移动端接口放 /api/m/*，走 checkApiToken
- 前端：新页面 = app.js 里加 renderXxx() + router 注册 path；样式追加到 style.css 末尾
- 不引入前端框架，不新增 npm 依赖（除非我同意）
- 改完在 test/e2e.js 补一条断言

先给我改动清单（文件 + 函数 + 大致行数），确认后再写代码。
```

### 适配新的书源规则

```text
书源规则解析在 legado-web/app/server/src/rules.js，XPath 在 xpath.js。

有个 Legado 书源用了我们还不支持的写法：<贴规则片段>

请：1) 对照 Legado 语法说明这条规则的语义；2) 指出 rules.js 里哪个函数负责解析
（parseSegment / evalString / evalRule）；3) 补上支持并在 test/e2e.js 加断言。
```

### 调界面

```text
FnReader 前端是原生 JS，没有构建步骤。
要改的是：<页面/组件>，期望效果：<描述或参考图>。

约束：
- 只用 CSS 变量（--bg / --panel / --line / --text / --text-2 / --accent），不要写死颜色
- 移动端优先，360–500px 不能溢出
- 新增样式追加到 style.css 末尾，别改旧规则
- 改完告诉我怎么本地预览（node test/preview.js）
```

### 收尾自检（每个任务都加这段）

```text
完成前请自查：
1. node test/e2e.js 是否全绿？失败项是哪条？
2. 有没有改动 /api/books、/api/toc、/api/content 的返回字段？（前端依赖，改了要同步）
3. 新增接口有没有参数校验和错误处理？
4. 有没有把密码、token、个人路径写进代码或文档？
5. 是否需要跟着改 docs/更新日志.txt？
```

### 懒人版

```text
这是 FnReader 的源码（飞牛 fnOS 上的 Legado 阅读器）。先读 docs/AI构建指南.md，
然后帮我：<你的需求>。改完跑 node test/e2e.js，全绿再来找我。
```

### 发版

```text
请给 FnReader 发一版：
1. python tools/release.py "一句话说明；第二条" --build
2. 把 dist/legado-web.fpk 传到 GitHub Release
3. 提醒我：fnOS 覆盖安装无效，必须 uninstall → install-fpk

发版前先跑 node test/e2e.js，必须全绿。
```

> 更细的说明（每个服务端文件的职责、数据流、7 条常见坑、改哪里对照表）见
> [docs/AI构建指南.md](docs/AI构建指南.md)。
**「阅读」APK 接入**（Android 4.4–5.1 老设备）

设置页 →「阅读 APK 接入」→ 复制 `legado://import/bookSource?src=...` 链接，
在 [yuedu-android4](https://github.com/TZYLXS/yuedu-android4) 的 APK 里「网络导入」即可搜书看正文。
详见 [docs/APK接入.md](docs/APK接入.md)。

## 构建

需要 Node.js 18+ 与 [fnpack](https://developer.fnnas.com/docs/cli/fnpack/)。

```bash
# 安装依赖（服务端用 cheerio + esbuild）
cd legado-web/app/server && npm install && cd -

# 打包，产物输出到 dist/legado-web.fpk
bash tools/build-fpk.sh
```

本地调试服务端：

```bash
cd legado-web/app/server
PORT=1122 LEGADO_DATA=./data node src/server.js
```

端到端测试（内置模拟书源站，无需外网）：

```bash
node test/e2e.js
```

## 发版

每次改动都走同一条流程——递增版本号、写更新日志、同步静态资源指纹、打包：

每次改动都要推源码 + 发版，一条命令搞定：

```bash
bash tools/publish.sh "修复了 xxx；新增了 yyy"
```

它会：升版本 → 写更新日志 → 打包 fpk → 提交并推送 main → 打 `v<版本>` tag。
推 tag 后 GitHub Actions 自动构建并发布 Release（附 `legado-web.fpk`）。

只看计划不落盘：`python tools/release.py "说明" --dry-run`。

## 项目结构

```
legado-web/            fnOS 应用包工程
├── manifest           应用元信息（版本、依赖、端口）
├── config/            privilege / resource
├── cmd/               生命周期脚本（start/stop/status）
├── app/ui/            桌面入口与图标
├── app/web/           前端（原生 JS 单页应用）
└── app/server/src/    服务端（Node.js）
    ├── books.js       搜索 / 详情 / 目录 / 正文流程
    ├── rules.js       书源规则解析与求值
    ├── xpath.js       精简 XPath 引擎
    ├── jrules.js      @js: 规则沙箱
    ├── academic.js    学术关键词识别
    ├── searchcache.js 搜索结果缓存（嵌入式 KV）
    └── server.js      HTTP 服务与接口

tools/                 构建、发版、部署脚本
docs/                  使用说明、更新日志、截图
dist/                  发布产物（fpk、示例书源）
test/                  端到端测试与模拟站点
```

## 书源与免责

本项目只提供**阅读工具**，不附带任何书籍内容，也不内置盗版站点。

- `dist/书源-OALib.json`：OALib 开放获取论文库
- `dist/书源-公版书与学术.json`：Project Gutenberg（公版书）+ arXiv（预印本）

请自行确认所使用书源的合法性。

## 技术栈

前端原生 JavaScript（无框架）、服务端 Node.js（cheerio + 自研规则引擎）、打包 esbuild，应用格式为飞牛 FPK。

## License

[Apache-2.0](LICENSE)
