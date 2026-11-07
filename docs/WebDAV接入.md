# WebDAV 接入（App 端零改动）

服务端内置了一个精简 WebDAV，Legado（阅读）等 App 用现成的 WebDAV 功能即可接入，**不需要改客户端源码**。

## 地址与账号

| 项 | 值 |
| --- | --- |
| 地址 | `http://<飞牛IP>:1122/dav/` |
| 用户名 | 任意（如 `fnreader`）|
| 密码 | 「设置 → 手机接入」里的访问令牌 |

## 两个目录

**`/dav/books/`（只读）**

书架里**已下载**的书，每本一个 `.txt`，文件名就是书名。支持 PROPFIND 列目录、GET 下载。

```
/dav/books/聊斋志异.txt     860 KB
```

**`/dav/backup/`（可读写）**

真实目录，映射到应用数据目录下的 `webdav/backup/`。支持 MKCOL / PUT / DELETE / GET，
用来接 Legado 的「备份与恢复 → WebDAV」。

## 在 Legado 里配置

1. Legado → 我的 → 备份与恢复 → **WebDAV 备份**
2. 填：
   - 服务器地址：`http://10.5.4.70:1122/dav/backup/`
   - 用户名：`fnreader`
   - 密码：设置页里的访问令牌
3. 点「备份」，文件会写到 NAS 的 `webdav/backup/` 下；换机时点「恢复」即可拉回。

> 说明：Legado 原生的 WebDAV 用于**备份/恢复**（书架、书源、阅读进度）。它不把 WebDAV 当书源，
> 所以 `books/` 目录主要是给文件管理器、其他阅读器或脚本用的；想在 Legado 里看书，
> 仍走原有书源，或用 FnReader 的网页版 / `/api/m/*`。

## 命令行自测

```bash
BASE=http://10.5.4.70:1122
TOKEN=<设置页令牌>

# 列目录
curl -X PROPFIND -H "Depth: 1" -u "fnreader:$TOKEN" $BASE/dav/books/

# 下载一本书
curl -u "fnreader:$TOKEN" $BASE/dav/books/聊斋志异.txt -o 聊斋志异.txt

# 上传备份
curl -X PUT --data-binary @backup.zip -u "fnreader:$TOKEN" $BASE/dav/backup/backup.zip
```

## 安全

- 所有请求要求 Basic 认证，密码即访问令牌；令牌仅在本机可见，可随时在设置页重置
- 建议只在局域网使用；需要外网访问时走 fnOS 的反代并加 HTTPS
