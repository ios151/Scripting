# Scripting 脚本

[Scripting](https://apps.apple.com/app/id6479691128) 应用上的脚本，自己写自己用，顺手公开。

每个脚本一个目录（判定依据是目录里有 `script.json`），发布产物统一打到 `dist/`。

---

## 脚本一览

| 脚本 | 做什么 | 当前版本 | 要求 | 安装 |
|---|---|---|---|---|
| **[WLOC 虚拟定位](docs/WLOC.md)** | 用苹果官方开发者接口模拟本机定位，与 Xcode 的 Simulate Location 同一套机制 | 2.7.5 | iOS 27+ · Scripting 3.3.0+ · 开发者模式 | [⬇️ 一键安装](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FWLOC.zip%22%5D) |

每个脚本的详细说明、已知限制、更新记录点进「脚本」那一列。
历史版本和更新日志在 [Releases](https://github.com/ios151/Scripting/releases)。

> ### ⚠️ Scripting 3.3.0 目前只在 TestFlight
>
> App Store 上架的还是 3.2.1。WLOC **2.7.1 起**用到了 `ScriptSession`、
> `BackgroundKeeper.getState`、`Device.getNetworkState`、`Device.appVersion`、
> `cancelRSDTunnelOpening` 这几个 3.3.0 才有的接口，在 3.2.1 上会静默失效。
>
> **还在用 App Store 版（3.2.1）、或者系统低于 iOS 27 的**，装最后一个不依赖这些
> 接口的版本：
> **[⬇️ 一键安装 WLOC 2.6.2](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fgithub.com%2Fios151%2FScripting%2Freleases%2Fdownload%2Fv2.6.2%2FWLOC.zip%22%5D)**
>
> 装了 2.6.2 之后**别去「远程资源」点检查更新** —— 那个地址永远指向最新版，
> 一点就被拉到 2.7.x 去了。

---

## 怎么装

**必须在 iPhone / iPad 上用 Safari 打开安装链接**，会直接唤起 Scripting 导入。
在电脑上点是没用的——那台机器上没有 Scripting。

链接的格式是：

```
https://www.scripting.fun/import_scripts/?urls=<URL 编码的 JSON 数组>
```

`urls` 是一个经过 URL 编码的 JSON 数组，**可以一次塞多个 zip 地址**，一次装好几个脚本。
本仓库的产物地址长这样：

```
https://raw.githubusercontent.com/ios151/Scripting/main/dist/<名字>.zip
```

装好之后脚本会自己从这个地址检查更新（`script.json` 里的 `remoteResource`）。

---

## 开发

```bash
# 类型检查。dts/ 是 Scripting 应用自带的类型定义，属于应用作者，不在本仓库内，
# 从 Scripting 的工作区复制一份到仓库根即可
npx -y -p typescript@5.6 tsc --noEmit -p tsconfig.json

# 自测，脱机可跑，不需要设备
npx -y tsx _selftest/<某一组>.test.ts

# 打包：遍历仓库根下每个带 script.json 的目录，打成 dist/<名字>.zip
python build-release.py
```

**zip 根目录必须直接是 `script.json` 和 `index.tsx`**，多包一层目录应用就认不出来，
`build-release.py` 会断言这一点。

### 加一个新脚本

1. 在仓库根建目录，放 `script.json` + `index.tsx`
2. `script.json` 的 `remoteResource.url` 指向 `dist/<名字>.zip` 的 raw 地址
   （**不要设 `autoUpdateInterval`**，它会按间隔自动覆盖设备上的脚本，开发期间很坑）
3. 要换 zip 文件名的话，在 `build-release.py` 的 `ALIASES` 里加一行
   （中文目录名直接做文件名会让 raw 链接塞满 `%E4%BD` 这种东西）
4. `python build-release.py`
5. 在上面那张表里加一行：名字、一句话说明、版本、要求、安装链接
6. 详细说明写到 `docs/<名字>.md`

### 文档都在哪

- [docs/](docs/) —— 每个脚本一份，面向用户：能做什么、要求、已知限制
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 项目边界（哪些方向不接受）、环境、提交约定
- [SKILL.md](SKILL.md) —— **WLOC 的维护手册**。协议链路怎么走、二十来个踩过的坑、
  为什么某些地方要那么写。动 `WLOC 虚拟定位/core/` 之前先看这个

提 issue 请用模板。Bug 模板里的「连接状态诊断」和日志很关键，缺了基本只能靠猜——
日志在「设置 → 导出日志」，一键存成 txt，已自动脱敏。
**任何情况下都不要贴配对记录或私钥。**

---

## 许可

**[GPL-3.0](LICENSE)**。代码随便看、随便改、随便用，但**任何衍生作品都必须同样以
GPL-3.0 开源并提供完整源码**——拿去改一改做成闭源 App 售卖这条路，协议上走不通。

第三方来源与许可范围见 [NOTICE.md](NOTICE.md)。其中一点要如实说明：WLOC 的界面
最初基于 BlackCCCat 的 Scripting 脚本改写，而**原脚本未声明任何许可**；协议层
（`core/`）则是完全独立的 TypeScript 实现，未复制任何上游源码。

## 声明

脚本只在你自己拥有并控制的设备上运行，不上传任何位置、搜索或配对数据。
配对记录存于钥匙串，仅本机可读。

位置模拟会影响所有依赖系统定位的应用。使用导航、紧急呼叫、交通出行或位置共享
之前，请务必先恢复真实位置。请勿用于误导他人、伪造证据、获取无权使用的服务，
或违反任何第三方服务的规则。
