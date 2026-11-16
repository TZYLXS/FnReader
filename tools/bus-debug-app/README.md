# 软总线调试工具（BusDebug）

一个极简 Android App，用来手动连接 FnReader 服务端，观察和操作软总线任务。

完整说明见仓库 `docs/软总线调试APK.md`。

## 快速构建

```bash
cd tools/bus-debug-app
gradle wrapper --gradle-version 8.7
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 功能

- 填地址 + token 手动连接，展示 `/api/bus` 设备与 pending
- 长轮询 `/api/m/remote/pending`，任务弹窗可视化 payload
- 编辑并回传 `/api/m/remote/result`（成功/失败/忽略）
- 手动下发 search / toc / content / bookinfo 任务，观察服务端结果
- 日志带时间戳，可导出到 `Android/data/com.tzylxs.busdebug/files/`

## 环境

JDK 17、Android SDK 34、Gradle 8.7（或用 Android Studio 打开本目录）。
