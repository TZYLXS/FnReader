# 工作区约定（AGENTS.md）

## 自动发版规则（用户明确要求，2026-11-10）

只要用户消息里出现**「增加」「更新」「改一下」**（或等价的新需求/改动请求），
完成代码修改后**必须自动走完整发版流程**，不需要再问：

1. 升版本号（patch +1，`tools/release.py` 会自动改 manifest / app.js / index.html / 更新日志）
2. 构建 FPK（`bash tools/build-fpk.sh`）
3. 装到 NAS（stop → uninstall → install-fpk → start，数据目录保留）
4. 同步到仓库副本 `C:\Users\csjt1\AppData\Local\Temp\FnReader`，提交并打 tag
5. 推送 main + tag（本机没有 git 时用 `tools/gh-push-files.js` 走 GitHub API）
6. 等 CI 出 Release，确认 `legado-web.fpk` 资产已更新

一键脚本：`bash tools/auto-release.sh "改动说明1；改动说明2"`

例外：纯文档 / 纯排查 / 用户说「不用发版」时不发版。

## debug 版规则

- 内部 debug 应用 `legado-web-debug`（独立安装，端口 1123，数据目录 `/vol4/@appdata/legado-web-debug`）
- **每次改动都要升 debug 版本号**（0.0.X +1），用 `bash tools/build-debug.sh` 自动递增并打包
- 正式版与 debug 版代码相同、版本号独立；正式版版本号由用户指定后才发


## 文档同步规则（用户要求，2026-11-17）

**只要本次更新有「增加功能」或「删除功能」，必须同步维护 Markdown 文档**，不能只写更新日志：

1. 找到对应的现有文档（`docs/` 下），把新增/删除的内容**合并进已有章节**，不要另起零散文件
2. 涉及接口/字段的变更 → 更新 `docs/APP同步接口.md`
3. 涉及软总线/路由/设备 → 更新 `docs/软总线路由与权重.md`、`docs/软总线调试APK.md`
4. 涉及电子书/解析引擎 → 更新 `docs/电子书解析引擎接入.md`
5. 打包/部署相关 → 更新 `docs/fnos-fpk-build.md`
6. 新增独立主题（如新的调试工具）时才新建 md，并在相关旧文档里加一句指路链接
7. **纯 bug 修复没有增删功能**时，可以不改接口文档，但仍要写更新日志
8. 文档改动随同一版本一起提交/发版（纯文档改动可按例外不发版）

## 环境备忘

- 本机**没有 git**，也没有 MSYS2 常规路径；推送用 GitHub API（token 从 Windows 凭据管理器读：
  `powershell -File C:\Users\csjt1\AppData\Local\Temp\gettok.ps1`）
- node: `C:/Users/csjt1/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`
- python: `C:/Users/csjt1/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`
- NAS: 10.5.4.70 / admin / ssh 密码在 `tools/ssh.js`（默认值）；应用目录 `/var/apps/legado-web/target`，
  appcenter-cli 需要 `echo '<pwd>' | sudo -S -p ''`
- MSYS 会把 `/tmp/x` 转成 Windows 路径：给 ssh.js 传远端路径要写 `//tmp/x`
