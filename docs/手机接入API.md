# 手机接入 API

服务端提供 `/api/m/*` 接口，供安卓 App 或第三方客户端读取书架数据。
所有接口都需要在请求头带 `X-Api-Token`（也可以在 query 里用 `?token=`）。

令牌在「设置 → 手机接入」里查看和重置。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/m/info` | 应用版本与可用接口列表 |
| GET | `/api/m/shelf` | 书架列表（按最近阅读排序）|
| GET | `/api/m/search?key=&group=&limit=` | 跨书源搜索（默认 8 个源，最多 30）|
| GET | `/api/m/remote/pending` | App 领任务；**未确认缓存位置时返回 409**（见 `APP同步接口.md` 8.3.1）|
| GET | `/api/setup` | 查询是否需要确认缓存位置 |
| GET | `/api/m/toc?url=` | 目录 |
| GET | `/api/m/content?url=&index=` | 正文（paragraphs 数组）|
| POST | `/api/m/progress` | 保存进度 `{bookUrl,index,pos,title}` |
| GET | `/api/m/cover?url=` | 封面图片（走服务端代理）|
| POST | `/api/m/reset-token` | 重置访问令牌 |
| GET | `/api/m/booksource?token=` | 「阅读」书源 JSON（给 Legado 导入用）|
| GET | `/api/m/legado/search?key=&page=` | 书源搜索（返回 Legado 规则可直接解析的结构）|
| GET | `/api/m/legado/book?u=&s=&n=` | 书籍详情，首次打开会自动加入书架 |
| GET | `/api/m/legado/toc?u=` | 目录，章节地址直指 `/api/m/content` |
| POST | `/api/m/remote/result` | 回传软总线任务结果 `{id, ok, data\|error}`，见 `APP同步接口.md` 8.3 |
| GET | `/api/m/ebook/file/<sha1>` | 下载本地电子书原文件；支持 `Range`（206/416）|
| POST | `/api/m/ebook/part?sha1=&seq=&total=` | 上传电子书解析分片（明文或 gzip，≤8 MB / 解压后 ≤20 MB）|
| GET | `/api/m/ebook/parts?sha1=` | 电子书分片断点查询 `{total,received,complete,status,parts}` |
| POST | `/api/m/ebook/chapter?sha1=&index=` | 单章按需回传（toc-only 模式的补章接口）|
| POST | `/api/m/ebook/upload?name=` | 客户端传书（pdf/mobi/azw3/epub/txt），用 `X-Upload-Token` 鉴权 |
| GET | `/api/ebook/upload` | 查询传书配置与上传令牌 |
| POST | `/api/ebook/upload/reset-token` | 重置上传令牌 |
| POST | `/api/ebook/pages` | 触发 PDF 原页渲染 `{sha1,dpi?}` |
| GET | `/api/ebook/pages?sha1=` | 原页渲染状态 `{ready,count,rendering}` |
| GET | `/api/ebook/page/<sha1>/<n>` | PDF 第 n 页 PNG |
| GET | `/api/ebook/list` | 本地电子书登记表（sha1/格式/状态/章数）|
| POST | `/api/ebook/scan` | 立即扫描本地电子书目录 |
| POST | `/api/ebook/reparse` | 重新解析某本电子书 `{sha1}` |
| GET | `/api/ebook/settings` | 电子书解析模式与统计 `{mode,dir,total,local,device}` |
| POST | `/api/ebook/settings` | 切换解析模式 `{mode:"proxy"\|"local"\|"off"}` |
| POST | `/api/cache/dedupe` | 缓存目录去重（合并「书名 (2)(3)…」）|

## 本地电子书（ebook）链路

服务端扫描到 epub/mobi/pdf/txt 后，书会以 `ebook://<sha1>` 形式进入书架；
`/api/toc`、`/api/content` 对这类 URL 直接返回解析产物（`via="ebook-json"`）。

客户端要参与 EPUB/MOBI 解析时：

1. `GET /api/m/remote/pending` 领到 `type=ebook-parse`；
2. `GET /api/m/ebook/file/<sha1>` 下载原文件（带 `X-Api-Token`，支持 Range 续传）；
3. 解析后 `POST /api/m/ebook/part?sha1=&seq=&total=` 逐片上传（part0 是清单）；
4. `POST /api/m/remote/result {id, ok:true, data:{chapters,parts,chars}}` 收尾。

详细分片结构与错误码见 `电子书解析引擎接入.md` 与 `APP同步接口.md` 8.4。

## 示例

```bash
BASE="http://10.5.4.70:1122"
TOKEN="<设置页里的令牌>"

curl -H "X-Api-Token: $TOKEN" "$BASE/api/m/shelf"
curl -H "X-Api-Token: $TOKEN" "$BASE/api/m/content?url=<bookUrl>&index=0"
```

```json
// GET /api/m/shelf
{ "books": [ { "bookUrl": "...", "name": "聊斋志异", "author": "...", "durChapterIndex": 0, "totalChapterNum": 50 } ] }

// GET /api/m/content
{ "bookUrl": "...", "title": "第49章 人妖", "index": 0, "total": 50,
  "prev": "", "next": "第48章 丐仙", "paragraphs": ["...", "..."], "cached": false }
```

## 安卓客户端接入要点

1. 首次启动让用户填「服务器地址 + 令牌」，调 `/api/m/info` 验证
2. 书架页拉 `/api/m/shelf`，点开先 `/api/m/toc`，再 `/api/m/content`
3. 翻页时上报 `/api/m/progress`，下次进来用 `durChapterIndex` 续读
4. 封面用 `/api/m/cover?url=<bookUrl>`，服务端已处理防盗链

## 给「阅读」APK 用的书源桥（/api/m/legado/*）

飞牛版「阅读」不写死接口，而是由服务端生成一份 Legado 书源，App 侧零改动：

- 书源 JSON：`GET /api/m/booksource?token=…`
- 导入链接：`legado://import/bookSource?src=<上面这个地址（URL 编码）>`
- 搜索：`/api/m/legado/search` → `{"books":[{name,author,kind,intro,lastChapter,coverUrl,bookUrl}]}`
- 网页端搜索默认跳过正版接口源（起点 / QQ阅读 / 掌阅 / 番茄 / 七猫等）；手机 API 的搜索不受此限制
- 详情：`/api/m/legado/book?u=<b64url(bookUrl)>&s=<b64url(书源地址)>&n=<书名>`，书不在书架时自动 `upsertBook` 入架（`addedBy: "apk"`）
- 目录：`/api/m/legado/toc?u=<b64url(bookUrl)>`，章节 `url` 直接是 `/api/m/content?url=…&index=i`
- 正文：复用 `/api/m/content`，返回 `paragraphs` 数组，书源规则为 `$.paragraphs[*]`

设置页「阅读 APK 接入」会直接显示可复制的导入链接和 JSON 地址。
