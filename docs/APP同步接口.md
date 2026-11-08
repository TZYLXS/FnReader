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

---

## 7 方向二：App 回传，网页实时显示

网页端订阅 `GET /api/events`（SSE，无需令牌），App 一提交进度，网页的书架立刻更新。

```js
const es = new EventSource('/api/events');
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);      // {type:'progress', bookUrl, index, title, via:'app', at}
  if (msg.type === 'progress') { /* 更新本地书架条目 */ }
};
```

服务端在以下两处会广播：

- `POST /api/m/progress`
- `POST /api/m/progress/batch`

事件体：

```json
{ "type": "progress", "bookUrl": "http://...", "index": 45,
  "title": "第46章 石清虚", "via": "app", "at": 1794086400000 }
```

网页收到后会把书架卡片上的「读到 x/y 章」改写，并弹一条提示。

---

## 8 方向三：借用手机端解析器搜书

有些书源依赖 WebView 或加密接口，服务端跑不了。开启「手机解析」后，本机解析失败的源
会变成一个任务交给 App，App 执行完回传结果，网页拿到后照常显示。

### 8.1 服务端 → 建任务（网页内部用）

```http
POST /api/remote/job
{ "type": "search", "payload": { "source": "https://xxx.com", "key": "斗破苍穹" }, "waitMs": 20000 }
```

服务端会挂起等待，最多 `waitMs`（上限 60s）：

```json
// 成功
{ "ok": true, "data": { "books": [ { "name": "...", "author": "...", "bookUrl": "..." } ] } }
// 失败
{ "ok": false, "error": "手机端没有响应" }
```

### 8.2 App 领任务

```http
GET /api/m/remote/pending?token=…&wait=10000&limit=5
```

长轮询：没有任务时最多挂 10 秒（`wait` 可调，上限 30s），返回：

```json
{ "jobs": [ { "id": "a1b2c3d4e5f6", "type": "search",
              "payload": { "source": "https://xxx.com", "key": "斗破苍穹" }, "age": 1200 } ] }
```

`age` 是任务已等待的毫秒数。

### 8.3 App 回结果

```http
POST /api/m/remote/result?token=…
{ "id": "a1b2c3d4e5f6", "ok": true,
  "data": { "books": [ { "name": "斗破苍穹", "author": "天蚕土豆",
                         "bookUrl": "https://…", "coverUrl": "…", "intro": "…" } ] } }
```

失败时传 `{ "ok": false, "error": "解析失败原因" }`。

### 8.4 任务类型

| type | payload | data 约定 |
| --- | --- | --- |
| `search` | `{source, key}` | `{books: [{name,author,bookUrl,coverUrl,intro,kind}]}` |
| `toc` | `{source, bookUrl}` | `{chapters: [{title,url}]}` |
| `content` | `{source, chapterUrl}` | `{paragraphs: ["…"]}` |

### 8.5 App 侧实现建议

```text
loop:
  jobs = GET /api/m/remote/pending?wait=15000
  for job in jobs:
      result = 用书源规则在本地执行 job.type
      POST /api/m/remote/result {id: job.id, ok: true, data: result}
  sleep 1s
```

配上「前台服务」常驻，用户搜索时手机在后台就能接管解析；服务端 20 秒内没等到会退回本地结果。

---

## 9 把 App 本地新增的书推到 NAS

App 在自己这边加了一本书（本地书架有 5 本，NAS 只有 4 本）时，用这个接口补推：

```http
POST /api/m/books?token=…
{ "bookUrl": "https://…", "name": "书名", "author": "作者",
  "coverUrl": "https://…", "intro": "…", "originName": "手机端",
  "index": 3, "title": "第三章 标题" }
```

也支持一次传数组：`{ "books": [ … ] }` 或直接 `[ … ]`。

响应：`{ "ok": true, "added": 1, "updated": 0, "total": 5 }`

- 已存在的书按 `bookUrl` 合并（只覆盖传上来的字段）
- 新增的书会立刻出现在网页书架（通过 `/api/events` 广播 `{type:'shelf', action:'add'}`）

### 进度回传时也可以顺带建书

`POST /api/m/progress/batch` 的每一项如果带 `name`，服务端会自动建一条书架记录：

```json
{ "items": [
  { "bookUrl": "https://…", "name": "书名", "author": "作者", "index": 3, "title": "第三章" }
] }
```

不带 `name` 且书不存在时，会在响应的 `missing` 数组里返回这些 `bookUrl`，App 可以据此补传：

```json
{ "ok": true, "updated": 2, "total": 3, "missing": ["https://…"] }
```

> 建议：App 每次启动先 `GET /api/m/sync` 比对本地书架，把 NAS 没有的书用 `/api/m/books` 推上去，
> 再开始同步进度，这样两边数量才一致。

---

## 10 外网访问（不止内网）

服务端只监听 `:1122`，默认设计为**局域网使用**。要在外网同步，不要让 App 写死某个内网 IP，
把它做成「服务器地址 + 令牌」两个可配置项，然后在 NAS 侧选一种打通方式。

### 10.1 三种常见方案

| 方案 | 适用 | 优点 | 代价 |
| --- | --- | --- | --- |
| **组网（Tailscale / ZeroTier）** | 推荐 | 不用端口映射、不用公网 IP、自带加密 | 手机装一个客户端 |
| **fnOS 反代 + 域名 + HTTPS** | 有域名 | 标准 HTTP 服务，浏览器/App 都能用 | 需要备案域名或 DDNS |
| **frp / Cloudflare Tunnel** | 无公网 IP | 能穿透 NAT | 依赖第三方服务 |

### 10.2 方案 A：组网（最省事）

1. NAS 和手机都装 Tailscale，登录同一账号
2. NAS 会得到一个固定地址，如 `http://100.64.1.23:1122`
3. App 里服务器地址填这个

优点：不暴露任何端口到公网，令牌之外还有一层网络隔离。缺点：手机得常驻 VPN。

### 10.3 方案 B：fnOS 反向代理

1. 应用中心 → 反向代理 → 新建，目标填 `http://127.0.0.1:1122`
2. 域名填你的 DDNS 域名，开启 HTTPS（Let's Encrypt 或自签）
3. App 里地址填 `https://nas.example.com`（不要再带 `:1122`）

注意：反代后路径前缀可能变成 `/app/legado-web/`，此时接口是
`https://nas.example.com/app/legado-web/api/m/sync`，App 需要支持自定义 base path。

### 10.4 方案 C：frp / Cloudflare Tunnel

- frp：自建服务端，`local_port = 1122` 映射到一个远程端口
- Cloudflare Tunnel：`cloudflared tunnel --url http://127.0.0.1:1122`，得到 `https://xxx.trycloudflare.com`

两者都会给你一个**公网可访问的 https 地址**，直接填进 App 即可。

### 10.5 安全要点

1. **只暴露必要路径**：如果反代能配路径规则，只放行 `/api/m/*`，别把 `/dav/`（可写备份区）暴露出去
2. **必须开 HTTPS**：令牌在 HTTP 里是明文，公网上等于没有
3. **令牌定期重置**：「设置 → 手机接入 → 重置」，重置后 App 要重新填
4. **不要端口直连**：把 1122 直接映射到公网等于把整个应用（包括 WebDAV 写权限）敞开
5. **自签证书**：App 端要么信任该证书，要么在开发阶段临时跳过校验（正式版别关）

### 10.6 App 端该怎么做

```text
设置项：
  serverUrl  例：http://10.5.4.70:1122  或  https://nas.example.com
  token      设置页里的访问令牌

启动时：
  GET  {serverUrl}/api/m/info     （带 X-Api-Token）
  → 200：地址与令牌都正确，展示书架
  → 401：令牌错
  → 超时：地址不通（DNS / 端口 / 证书）
```

把探测失败的原因区分开提示用户，比一句「连接失败」有用得多。

---

## 11 软总线：哪台设备能代理解析

服务端维护一份「解析设备」清单，App 只要在轮询任务时自报身份，就会出现在网页的
「设置 → 软总线 → 手机解析待命」里。

### 11.1 设备报到（跟着领任务一起带上即可）

```http
GET /api/m/remote/pending?token=…
    &id=<设备唯一id>&name=<设备名>&model=<机型>&ver=<App版本>&wait=15000
```

也可以用请求头：`X-Device-Id` / `X-Device-Name` / `X-Device-Model`。

- 60 秒内有轮询算「在线」，超过显示离线
- 服务端按 `id` 去重，同名设备只保留一条

### 11.2 查看总线

```http
GET /api/bus
```

```json
{
  "devices": [
    { "id": "phone-demo", "name": "红米K60", "model": "Redmi K60", "version": "1.0",
      "lastSeen": 1794132208060, "handled": 12, "enabled": true, "online": true, "idle": 1 }
  ],
  "pending": 0
}
```

`handled` 是该设备累计代理解析的次数。

### 11.3 允许 / 暂停某台设备

```http
POST /api/bus/toggle
{ "id": "phone-demo", "enabled": false }
```

暂停后服务端不再给它派任务。

### 11.4 优先手机解析（设置项）

「设置 → 软总线 → 优先手机解析」开关，对应配置 `preferRemote`：

| 状态 | 搜索时的行为 |
| --- | --- |
| 关闭（默认） | 先本机解析，失败的源才问手机 |
| 开启 | 先问在线设备（最多等 8 秒），拿不到再本机解析 |

返回结果里 `via: "phone"` 表示这条来自手机，网页上会标「📱 手机解析」。
