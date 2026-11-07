# App 同步接口

这份文档面向**要在别的客户端里复刻书架**的开发者（或让 AI 写客户端时的输入）。
一次请求就能拿到：书架、阅读进度、书源配置。

所有接口都要带令牌：

```
X-Api-Token: <令牌>        或        ?token=<令牌>
```

令牌在「设置 → 手机接入」里查看，可重置。

---

## 1 一次性同步：`GET /api/m/sync`

| 参数 | 说明 |
| --- | --- |
| `since` | 可选，毫秒时间戳。只返回此时间之后有变动的书架条目（增量同步）|
| `full` | `1` 时 `sources.items` 返回带完整规则的源对象（默认只返回精简信息）|

### 响应

```json
{
  "app": "FnReader",
  "version": "1.7.25",
  "serverTime": 1794086400000,
  "since": 0,
  "incr": false,

  "shelfCount": 3,
  "shelf": [
    {
      "bookUrl": "http://www.qiushu.info/t/148864/",
      "name": "聊斋志异",
      "author": "【清】蒲松龄",
      "coverUrl": "http://...",
      "intro": "……",
      "kind": "小说",
      "origin": "http://www.qiushu.info",
      "originName": "求书网",
      "lastChapter": "第49章 人妖",
      "totalChapterNum": 50,
      "durChapterIndex": 45,
      "durChapterTitle": "第46章 石清虚",
      "durChapterPos": 0,
      "durChapterTime": 1794000000000
    }
  ],

  "progressCount": 3,
  "progress": [
    { "bookUrl": "http://...", "index": 45, "title": "第46章 石清虚", "pos": 0, "time": 1794000000000 }
  ],

  "sources": {
    "total": 1062,
    "enabled": 840,
    "groups": [ { "name": "源仓库/小说", "count": 233 } ],
    "items": [
      { "bookSourceName": "笔趣阁", "bookSourceUrl": "https://...", "bookSourceGroup": "源仓库/小说",
        "bookSourceType": 0, "enabled": true, "searchUrl": "https://...?q={{key}}", "checkStatus": "ok" }
    ],
    "full": false
  },

  "endpoints": { "toc": "…", "content": "…", "progress": "…" }
}
```

- `shelf` 是书架条目的**轻量快照**，不含章节数组
- `progress` 与 `shelf` 同源，单独列一份方便只做进度同步
- `sources.items` 默认精简；要完整规则（含 `ruleSearch`/`ruleToc`/`ruleContent`）用 `?full=1`
- `incr: true` 表示这是增量结果（请求里带了 `since`）

---

## 2 书源配置文件：`GET /api/m/sources.json`

返回**与 Legado 导出一致的数组**，可直接给客户端「导入书源」用：

```json
[ { "bookSourceName": "…", "bookSourceUrl": "…", "ruleSearch": { … }, "ruleToc": { … } }, … ]
```

参数：`?all=1` 包含被停用的源（默认只给启用的）。

---

## 3 读正文

```
GET /api/m/toc?url=<bookUrl>                → { chapters: [{index,title,url}] }
GET /api/m/content?url=<bookUrl>&index=45   → { title, paragraphs: ["…"], total, next, prev }
```

目录若是旧数据，带一个 `refresh=1` 可强制重解析。

---

## 4 回传阅读进度

单条：

```http
POST /api/m/progress
{ "bookUrl": "http://...", "index": 45, "pos": 0, "title": "第46章 石清虚" }
```

批量（App 退出时一次提交）：

```http
POST /api/m/progress/batch
{ "items": [
  { "bookUrl": "http://...", "index": 45, "pos": 0, "title": "第46章 石清虚" },
  { "bookUrl": "http://...", "index": 3,  "pos": 0, "title": "第4章 …" }
] }
```

响应：`{ "ok": true, "updated": 2, "total": 2 }`（不在书架里的书会被跳过）。

---

## 5 其它

| 接口 | 用途 |
| --- | --- |
| `GET /api/m/info` | 版本与接口表（可用来探活）|
| `GET /api/m/cover?url=<bookUrl>` | 封面（服务端代理，无防盗链）|
| `GET /api/m/library` | 已下载书籍清单（书名 / 来源 / 章节数）|

---

## 6 客户端实现建议

1. **首次启动**：`GET /api/m/sync?full=0` 拿书架 + 源列表；需要让用户选源时再 `?full=1`
2. **定时同步**：记住上次 `serverTime`，下次带 `since=<上次 serverTime>`，只拉变动的书
3. **阅读时**：`/api/m/toc` 取目录 → `/api/m/content` 取正文 → 每翻一章 `POST /api/m/progress`
4. **本地缓存**：以 `bookUrl` 为主键，`durChapterTime` 做冲突判定（时间新的赢）
5. **书源导入**：直接下载 `/api/m/sources.json`，按 Legado 的规则字段解析

### 错误码

| HTTP | 含义 |
| --- | --- |
| 401 | 令牌无效或缺失 |
| 404 | 书不在书架 / 章节不存在 |
| 502 | 上游书源抓取失败（可对同一接口重试一次）|
