# 「阅读」APK 接入飞牛书库

给老安卓设备（Android 4.4–5.1，API 19–22）用的阅读器。App 本身不改造网络层，
由 FnReader 生成一份 Legado 书源，把飞牛书库的书架、书源、缓存全部暴露给 App。

- APK 仓库：<https://github.com/TZYLXS/yuedu-android4>
- 安装包：上面仓库的 Releases（文件名 `yuedu_app_*.apk`，v1+v2 双签，minSdk 19）

## 一、在服务端取导入链接

1. 打开 FnReader → 设置 → **阅读 APK 接入**
2. 复制「书源导入链接」，形如
   `legado://import/bookSource?src=http%3A%2F%2F<主机>%2Fapp%2Flegado-web%2Fapi%2Fm%2Fbooksource%3Ftoken%3D<令牌>`
3. 也可以只复制「书源 JSON」地址，在 App 里用「网络导入」粘贴

令牌来自「设置 → 手机接入」，重置令牌后需要重新导入书源。

## 二、在 App 里导入

1. 手机与飞牛在同一网段（能打开飞牛网页即可）
2. 打开「阅读」→ 我的 → 书源管理 → 右上角菜单 → **网络导入** → 粘贴上面的链接
3. 导入成功后书源列表里出现「飞牛书库」
4. 回到书架 → 搜索 → 选「飞牛书库」分组，即可搜到飞牛已配置书源里的书

## 三、服务端接口对应关系

| 阅读里的动作 | 实际请求 |
| --- | --- |
| 搜索 | `GET /api/m/legado/search?key=&page=` |
| 详情（含加入书架） | `GET /api/m/legado/book?u=<b64url(bookUrl)>&s=<b64url(书源)>&n=<书名>` |
| 目录 | `GET /api/m/legado/toc?u=<b64url(bookUrl)>` |
| 正文 | `GET /api/m/content?url=<bookUrl>&index=<i>` |
| 封面 | `GET /api/m/cover?url=<bookUrl>` |

书源规则（服务端生成，App 侧无需改）：

```json
{
  "ruleSearch":    {"bookList":"$.books[*]","name":"$.name","author":"$.author","bookUrl":"$.bookUrl","coverUrl":"$.coverUrl","kind":"$.kind","introduce":"$.intro","lastChapter":"$.lastChapter"},
  "ruleBookInfo":  {"name":"$.book.name","author":"$.book.author","coverUrl":"$.book.coverUrl","kind":"$.book.kind","introduce":"$.book.intro","lastChapter":"$.book.lastChapter","tocUrl":"$.book.tocUrl"},
  "ruleToc":       {"chapterList":"$.chapters[*]","chapterName":"$.title","chapterUrl":"$.url"},
  "ruleContent":   {"content":"$.paragraphs[*]"}
}
```

## 四、第一次打开会自动入架

早期版本手机端搜到书、但书不在飞牛书架里，点开就 404。
现在 `/api/m/legado/book` 在书不在书架时，会按搜索带过来的书源现场抓一次详情并
`store.upsertBook`（`addedBy: "apk"`），所以「搜到 → 点开 → 有目录 → 能读」整条链路是通的。

## 五、常见问题

| 现象 | 处理 |
| --- | --- |
| 导入提示「格式错误」 | 链接里的 `src=` 必须整段 URL 编码；直接复制设置页的链接别手动拼 |
| 搜索没结果 | 确认书源本身在电脑端能搜到（书源管理里状态为可用），且至少有一个源 `checkStatus=ok` |
| 打开书提示「书源不存在」 | 书源被删了，回到阅读重新搜索 |
| 打开书提示「不在书架中」 | 直接访问了旧的书签；回搜索重新点开一次即可自动入架 |
| 封面空白 | 封面走 `/api/m/cover` 代理，源站防盗链或封面抓不到时会留空，不影响阅读 |
| 4.4 上 TLS 握手失败 | App 已内置 TLSv1.2 强制开启；仍失败说明书源站点只支持 TLS1.3，需要服务端代抓（飞牛侧已代抓，正常不会出现） |
