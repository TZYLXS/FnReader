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

### 11.5 手机解析的书，目录和正文也走手机

搜索阶段由手机返回的书会带上 `viaPhone: true`。这类书加入书架后：

| 操作 | 服务端行为 |
| --- | --- |
| 打开目录 | 发 `toc` 任务给手机，等 `chapters` 回传后写进书架（`totalChapterNum` 同步） |
| 阅读正文 | 发 `content` 任务给手机，等 `paragraphs` 回传后进缓存 |

任务载荷：

```json
// toc
{ "source": "https://…", "bookUrl": "https://…", "name": "书名" }
// 回传
{ "chapters": [ { "title": "第一章", "url": "https://…" } ] }

// content
{ "source": "https://…", "chapterUrl": "https://…", "title": "第一章" }
// 回传
{ "paragraphs": ["第一段", "第二段"] }
```

超时（目录 20 秒 / 正文 25 秒）或手机不在线时，服务端会退回本地书源解析；
本地也没有该源时书架会显示「目录为空」。

> 所以 App 端必须实现 `toc` 与 `content` 两种任务，只回 `search` 会导致
> 「书能搜到、点开没目录」。

---

## 12 令牌与配置接口（安全说明）

`apiToken` 是访问 `/api/m/*` 的唯一凭据，服务端不再把它随便发给任何人。

### 12.1 `/api/config` 的下发规则

| 请求来源 | 是否返回 `apiToken` |
| --- | --- |
| 本机（fnOS 网关 `127.0.0.1` / unix socket） | ✅ 返回 |
| 已携带正确 `X-Api-Token` 的请求 | ✅ 返回 |
| 局域网其它设备直连 `:1122` | ❌ 不返回，附带 `tokenRequired: true` |

也就是说：**外部设备读 `/api/config` 只能拿到主题、字号这类非敏感设置，拿不到令牌。**

### 12.2 客户端该怎么办

App 不要把「读配置」当成取令牌的手段。正确流程：

1. 用户在设置里手动填 `token`（从飞牛桌面打开本应用 → 设置 → 手机接入 查看）
2. App 把 token 存本地（建议加密存储）
3. 之后所有请求都带 `X-Api-Token`

### 12.3 仍然存在的风险

- `POST /api/config`（改设置）目前不校验令牌：能访问 `:1122` 的局域网设备可以改主题/下载目录等，
  但改不了令牌本身（重置令牌需要令牌）
- 因此**不要把 1122 直接映射到公网**；外网请用组网或反向代理 + HTTPS，见第 10 章

---

## 13 App 上传：封面与书源

App 除了回传进度，还可以把**封面图片**和**书源**一并推到 NAS，两边保持同一套数据。

### 13.1 上传封面

两种方式，都返回本地封面地址：

**A. JSON + base64**（适合从网络取到图片后再转）

```http
POST /api/m/cover      X-Api-Token: …
{ "bookUrl": "https://…", "mime": "image/jpeg", "data": "<base64>" }
```

**B. 直接传二进制**（更省内存）

```http
POST /api/m/cover?bookUrl=https%3A%2F%2F…   X-Api-Token: …
Content-Type: image/png
<二进制图片>
```

响应：

```json
{ "ok": true, "coverUrl": "http://192.168.5.114:1122/api/covers/5c1490be35afe31c.png",
  "size": 70, "book": true }
```

- 图片存到应用数据目录 `covers/`，文件名是 `bookUrl` 的 SHA1 前 16 位
- `bookUrl` 命中书架里的书时，自动把该书的 `coverUrl` 改成这个本地地址（`book: true`）
- 单张上限 8 MB；支持 png / jpeg / webp / gif

封面读取：`GET /api/covers/<文件名>`（无需令牌，带 7 天缓存）。

### 13.2 上传书源

```http
POST /api/m/sources      X-Api-Token: …
[ { "bookSourceName": "…", "bookSourceUrl": "…", "ruleSearch": { … } }, … ]
```

也接受 `{ "sources": [ … ] }`。按 `bookSourceUrl` 去重：

```json
{ "ok": true, "added": 1, "updated": 0, "total": 1253 }
```

- 已存在的源用新字段覆盖（`enabled` 不传则保留原值）
- 新源默认启用，导入后网页端书源列表立刻可见

### 13.3 App 侧建议

```text
同步时：
  for book in 本地新增的书:
      POST /api/m/books            # 书架
      if 有封面: POST /api/m/cover  # 封面
  if 本地书源有更新:
      POST /api/m/sources          # 只传变化的即可（按 bookSourceUrl 合并）
  POST /api/m/progress/batch       # 进度
```

与 yuedu-pro 的「接入飞牛服务器」保持一致：书源仍然是 Legado 数组格式，
只是方向从「NAS → App」变成「App → NAS」也支持了。

---

## 14 自动同步：加书即同步（推荐实现）

触发条件只有一个：**App 把一本书加进本地书架**。加完立刻推 NAS，不依赖用户再点「同步」。

### 14.1 触发点

| App 里的动作 | 是否触发 |
| --- | --- |
| 搜索页「加入书架」 | ✅ |
| 详情页「加入书架」 | ✅ |
| 换源后重新加书 | ✅ |
| 导入书单 / 批量加书 | ✅（逐个或批量） |
| 只翻开阅读、不改书架 | ❌ |

### 14.2 一次请求搞定「书 + 封面」

把封面 base64 塞进同一个请求，避免两次往返：

```http
POST /api/m/books      X-Api-Token: …
{
  "bookUrl": "https://…",
  "name": "书名",
  "author": "作者",
  "originName": "源名",
  "coverData": "<base64 或 data:image/png;base64,…>",
  "coverMime": "image/png",
  "intro": "简介",
  "totalChapterNum": 120,
  "index": 0
}
```

响应：

```json
{ "ok": true, "added": 1, "updated": 0, "total": 11 }
```

- `coverData` 会被落盘到 `covers/`，该书的 `coverUrl` 自动指向本地地址
- 同一 `bookUrl` 再推是**更新**（`updated: 1`），不会重复加书，可以放心重试
- 没有图片就省略 `coverData`；也可以单独调 `POST /api/m/cover`

### 14.3 书源同样自动推

本地书源有新增或修改时，跟加书一起推（只传变化的）：

```http
POST /api/m/sources   [ { "bookSourceName": "…", "bookSourceUrl": "…", "ruleSearch": {…} } ]
```

### 14.4 失败重试

加书是用户操作，网络可能不通，要排队重试：

```text
onAddBook(book):
    localDB.insert(book)                 # 先本地成功
    pendingQueue.push({ type: 'book', bookUrl, payload, retries: 0 })
    flush()

flush():
    while pendingQueue.top():
        item = pendingQueue.top()
        try:
            POST /api/m/books  (带 coverData)
            pendingQueue.pop()
        catch (e):
            item.retries += 1
            if item.retries > 5: 标记 failed，通知用户「未同步到 NAS」
            else: 等 2^retries 秒后再试（2/4/8/16/32）
            break        # 队列保序，失败就停，等下次事件再 flush
```

队列要持久化（SQLite / SharedPreferences），App 被杀掉、手机重启后还能补传。

### 14.5 批量加书

书单导入时不要每条都发一次请求，攒成一批：

```http
POST /api/m/books
{ "books": [ { … }, { … } ] }
```

单批建议 ≤ 20 本，避免请求体过大。

### 14.6 双向一致的判定

| 场景 | 处理 |
| --- | --- |
| NAS 已有同 `bookUrl` | 覆盖元数据，进度以 `durChapterTime` 大的为准 |
| NAS 没有 | 新增 |
| App 删书 | 调 `DELETE /api/books?url=<bookUrl>`（可选，默认不同步删除） |

### 14.7 网页端会立刻看到

服务端在加书/换封面后会通过 `/api/events` 广播：

```json
{ "type": "shelf", "action": "add", "bookUrl": "https://…", "via": "app" }
```

网页开着的话书架会自动刷新出这本新书，不用手动点刷新。

---

## 15 每日推荐（`GET /api/daily`）

服务端每天抓一次榜单，缓存在 `daily.json`，网页端「搜索 → 每日推荐」直接展示。

```json
{
  "source": "纵横",
  "url": "https://www.zongheng.com/rank",
  "updatedAt": 1794132400000,
  "count": 30,
  "books": [ { "rank": 1, "name": "无敌天命", "author": "", "score": "15020",
               "url": "https://www.zongheng.com/detail/1336976", "cover": "", "from": "纵横" } ]
}
```

取值顺序：

1. **起点** `https://www.qidian.com/rank/recom/` —— 有反爬（返回 202 挑战页），
   服务端直连通常拿不到；如果软总线有在线手机，会先让手机抓（任务类型 `rank`）
2. **纵横** `https://www.zongheng.com/rank` —— 服务端可直连，作为主力来源
3. **17K** `https://www.17k.com/top/` —— 再兜底
4. 全都失败 → 返回磁盘里的上一次结果（`stale: true`）

缓存 6 小时；App 也可以直接调这个接口做「今日推荐」页。

---

## 16 缓存同步：直接搬客户端缓存文件

App 不需要自己解析正文再重排版，**把缓存文件原样发上来**即可：服务端自己转码成网页端可读的格式。

### 16.1 请求

```http
POST /api/m/cache      X-Api-Token: …
{
  "layout": "legado",
  "book": {
    "bookUrl": "https://…",
    "name": "书名",
    "author": "作者",
    "origin": "https://源站",
    "originName": "源名",
    "intro": "简介",
    "durChapterIndex": 12
  },
  "coverData": "<base64>",
  "coverMime": "image/jpeg",
  "chapters": [
    {
      "index": 12,
      "title": "第十二章 雾",
      "file": "00012-9f86d081884c7d65.nb",
      "raw": "　　浓雾在窗外翻滚……
　　他转过身，看到了<img src=\"https://…/1.jpg\">挂在墙上。"
    }
  ],
  "images": [ { "name": "1.jpg", "data": "<base64>" } ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `layout` | 固定 `legado`（客户端缓存的原始格式） |
| `chapters[].file` | 客户端缓存文件名，如 `00012-<titleMD5>.nb`，原样保存 |
| `chapters[].raw` | 该文件**原文**（直接 `File.readText()` 的内容，不要预处理） |
| `images[]` | 章节里的图片文件（`name` 建议用客户端里的文件名，如 `<md5>.jpg`）|
| `coverData` | 封面 base64（可选） |

`raw` 里的特征（服务端会处理，App 不用管）：

- 段首两个全角空格 `　　`
- 段落用 `
` 分隔
- 可能夹着 `<img src="…">` 单标签

### 16.2 服务端做什么

1. **原样存一份**：`raw/<客户端文件名>`，方便以后回传 App 或排查
2. **转码一份**：去标签、去段首缩进、按行拆成段落，`<img>` 换成 `[图片]`，
   段落间空一行，写成 `0001 第十二章 雾.txt`
3. **图片**：存 `images/<name>`
4. **封面**：存公共 `covers/` 目录，并写回书架该书的封面
5. **登记书架**：`book.chapters` 带上 `file` 字段，`cachedDir` 指向本目录
6. 之后 `/api/content` 直接读本地文件，不再访问网络

### 16.3 落盘结构

```
<下载目录>/cache/<书名>/
    meta.json
    cover.jpg
    0001 第十二章 雾.txt      ← 转码后，网页阅读读这个
    0002 第十三章 墙.txt
    raw/
        00012-9f86d081884c7d65.nb   ← 客户端原文
        00013-0a1b2c3d4e5f6a7b.nb
    images/
        1.jpg
```

### 16.4 响应

```json
{ "ok": true, "layout": "legado", "dir": "/vol3/1000/DownLoad/cache/书名",
  "chapters": 2, "withText": 2, "images": 1, "bytes": 484,
  "cover": "http://192.168.5.114:1122/api/covers/b0ca563fe607eede.png" }
```

### 16.5 App 侧实现

```text
书目录 = /Android/data/io.legado.pro/files/book_cache/<book.getFolderName()>
chapters = 遍历该目录下 *.nb：
    { index: 从文件名前 5 位解析,
      title: 从 DB 的 BookChapter 取,
      file:  文件名,
      raw:   File.readText() }

images = 遍历 <书目录>/images/*：{ name, data: base64 }
POST /api/m/cache { layout:'legado', book, coverData, chapters, images }
```

要点：

- **不要**在 App 里做去标签、补缩进等处理，原样传 `raw`
- 一次请求体上限 32 MB，整本几千章建议分批（每批 50 章，`book` 相同、`chapters` 不同）
  分批会新建目录，所以更推荐**一次推完整本**；后续可加增量参数
- 重名书目录自动加 `(2)`

---

## 17 书源双向同步（C/S，最后一次修改为准）

客户端和服务端各有一份书源，改动可能发生在任何一边。约定用 **`lastUpdateTime`（毫秒）**
做「最后写入者赢」（LWW）判定：**谁的时间戳大，谁的版本生效**。

### 17.1 拉取增量：`GET /api/m/sources/sync?since=<毫秒>`

```json
{
  "ok": true,
  "serverTime": 1794149022425,
  "sources": [ { "bookSourceUrl": "…", "bookSourceName": "…", "lastUpdateTime": 1794149000000, "ruleSearch": {…} } ],
  "truncated": false
}
```

- `since=0` → 全量
- 只返回 `lastUpdateTime > since` 的源
- 客户端把返回的每个源存本地，并把 `serverTime` 记为下次的 `since`

### 17.2 推送改动：`POST /api/m/sources/sync`

```json
{
  "since": 1794148000000,
  "updated": [
    { "bookSourceUrl": "https://…", "bookSourceName": "…", "lastUpdateTime": 1794149100000, "ruleSearch": {…} }
  ],
  "deleted": [
    { "bookSourceUrl": "https://…", "lastUpdateTime": 1794149110000 }
  ]
}
```

响应：

```json
{
  "ok": true,
  "applied": 2,          // 采纳了多少条（新增/覆盖/删除）
  "skipped": 1,          // 因为服务端更进而被忽略的条数
  "pull": [ … ],         // 服务端更进的版本，客户端应以这些为准
  "pullDeleted": [],
  "serverTime": 1794149022425,
  "truncated": false,
  "total": 1254
}
```

### 17.3 判定规则

| 情况 | 结果 |
| --- | --- |
| 服务端没有这个源 | 新增 |
| 客户端 `lastUpdateTime` **大于** 服务端 | 覆盖服务端 |
| 客户端 `lastUpdateTime` **小于等于** 服务端 | 忽略，并把服务端版本放进 `pull` |
| 删除且时间戳 ≥ 服务端 | 删除服务端 |
| 删除但时间戳更旧 | 忽略，`pull` 里带回服务端版本 |
| 客户端没带 `lastUpdateTime` | 当作「刚刚修改」 |

服务端自己的改动（网页端导入/启停/删除书源）也会自动写 `lastUpdateTime = Date.now()`，
所以两边都能成为「最后修改者」。

### 17.4 客户端建议流程

```text
每次启动 / 每 10 分钟 / 用户手动点同步：
  since = 本地记的 serverTime（首次 0）
  r = POST /api/m/sources/sync { since, updated: 本地变更队列, deleted: 本地删除队列 }
  对 r.pull 里的每条：按 bookSourceUrl 覆盖本地（服务端版本更进）
  对 r.pullDeleted 里的每条：从本地删除
  本地 serverTime = r.serverTime
  清空本地变更队列
```

本地维护「变更队列」：用户新增/编辑/删除书源时，把源（带 `lastUpdateTime = now`）压进队列，
同步成功后再清空；失败就留着下次重试。

### 17.5 完整导入（批量首次）

第一次接入时如果本地有上千条源，用一次性接口更省事，行为和上面一致（按 URL 合并）：

```http
POST /api/m/sources        [ … ]        // 见 13.2
```
