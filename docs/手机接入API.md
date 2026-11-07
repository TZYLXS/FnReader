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
| GET | `/api/m/toc?url=` | 目录 |
| GET | `/api/m/content?url=&index=` | 正文（paragraphs 数组）|
| POST | `/api/m/progress` | 保存进度 `{bookUrl,index,pos,title}` |
| GET | `/api/m/cover?url=` | 封面图片（走服务端代理）|
| POST | `/api/m/reset-token` | 重置访问令牌 |
| GET | `/api/m/booksource?token=` | 「阅读」书源 JSON（给 Legado 导入用）|
| GET | `/api/m/legado/search?key=&page=` | 书源搜索（返回 Legado 规则可直接解析的结构）|
| GET | `/api/m/legado/book?u=&s=&n=` | 书籍详情，首次打开会自动加入书架 |
| GET | `/api/m/legado/toc?u=` | 目录，章节地址直指 `/api/m/content` |

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
- 详情：`/api/m/legado/book?u=<b64url(bookUrl)>&s=<b64url(书源地址)>&n=<书名>`，书不在书架时自动 `upsertBook` 入架（`addedBy: "apk"`）
- 目录：`/api/m/legado/toc?u=<b64url(bookUrl)>`，章节 `url` 直接是 `/api/m/content?url=…&index=i`
- 正文：复用 `/api/m/content`，返回 `paragraphs` 数组，书源规则为 `$.paragraphs[*]`

设置页「阅读 APK 接入」会直接显示可复制的导入链接和 JSON 地址。
