# FnReader · 飞牛 fnOS 阅读器

把 [Legado（阅读）](https://github.com/gedoor/legado) 的书源生态带到飞牛 fnOS：不装模拟器，打开就是一个网页书架。

- **书源**：直接导入 Legado 3.x 书源 JSON，规则引擎实现了 CSS / XPath / JSONPath / 正则 / `@js:` 沙箱 / `@` 选择器链 / 索引语法
- **阅读**：书架、目录、正文、进度同步、主题/字号/行距
- **搜索**：多书源并发 + 结果流式返回；命中学术词时自动只搜学术源
- **订阅**：内置 RSS / Atom 阅读
- **下载**：整本抓取并合并为 TXT，可选保存到 fnOS 授权目录
- **离线加速**：章节正文磁盘缓存 + 后台预取，翻页约 20ms

![书架](docs/screenshots/shelf.png)


---

## 安装

1. 从 [dist/legado-web.fpk](dist/legado-web.fpk) 下载安装包
2. 飞牛「应用中心 → 手动安装」选择该文件
3. 桌面出现「阅读」图标，点击即可（走统一网关 `/app/legado-web/`）

依赖系统应用 `nodejs_v22`，安装时会自动拉起。

> **升级注意**：fnOS 的 `appcenter-cli install-fpk` 不支持覆盖升级（会提示成功但文件不变）。
> 升级请先卸载再安装；数据目录 `/vol2/@appdata/legado-web` 会保留。

## 使用

1. **书源** → 导入 Legado 书源 JSON（粘贴 / 链接 / 文件），或使用 [dist/](dist/) 里的示例源
2. 书源很多时先点「检测」，跑完点「停用未通过」，之后搜索会快很多
3. **搜索** → 找书 / 订阅；结果边搜边出，可随时停止
4. 书架点封面继续阅读；右上角「⋯」或长按封面可下载 TXT、刷新目录、删除

详细说明见 [docs/使用说明.md](docs/使用说明.md)，版本记录见 [docs/更新日志.md](docs/更新日志.md)。

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

```bash
python tools/release.py "修复了 xxx；新增了 yyy" --build
python tools/release.py "说明" --dry-run   # 只看计划，不落盘
```

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
