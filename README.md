# Scripting 脚本

[Scripting](https://apps.apple.com/app/id6479691128) 应用上的脚本，自己写自己用，顺手公开。

每个脚本一个目录（判定依据是目录里有 `script.json`），发布产物统一打到 `dist/`。

---

## 脚本一览

| 脚本 | 做什么 | 当前版本 | 要求 | 安装 |
|---|---|---|---|---|
| **[WLOC 虚拟定位](docs/WLOC.md)** | 用苹果官方开发者接口模拟本机定位，与 Xcode 的 Simulate Location 同一套机制 | 2.7.5 | iOS 27+ · Scripting 3.3.0+ · 开发者模式 | [⬇️ 一键安装](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FWLOC.zip%22%5D) |
| **[设备工具箱](docs/设备工具箱.md)** | 走同一条开发者通道管本机：设备信息、电池健康、主屏布局、应用管理、配置描述文件、签名诊断、实时性能、硬件规格、通话录音提示音 | 2.1.3 | iOS 27+ · TestFlight 版 Scripting · 开发者模式 | [⬇️ 一键安装](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FDeviceToolbox.zip%22%5D) |
| **[JavBus](docs/JavBus.md)** | JavBus 非官方客户端（移植自 JSBox 脚本 JavBus 9.2）：检索、女优与分类、收藏、磁链、预览与字幕、推荐（网友推荐走社区推荐服务）。含成人内容 | 1.2.0 | Scripting 3.3.0+ · 能访问 javbus.com · 18+ | [⬇️ 一键安装](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FJavBus.zip%22%5D) |
| **[快捷指令签名](docs/快捷指令签名.md)** | 在手机本机给快捷指令签名：自己生成根证书，装上并信任后，签出能直接导入的 `.shortcut`；不要服务器、不要 Mac、不靠第三方签名服务。带分享面板入口，也能被别的脚本调用（含结构检查） | 0.1.0 | Scripting 3.3.0+ · 只在 iOS 27.2 上验证过 · 手机上要装并信任一张自己生成的证书 | [⬇️ 一键安装](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FShortcutSigner.zip%22%5D) |

每个脚本的详细说明、已知限制、更新记录点进「脚本」那一列。

**WLOC 虚拟定位**的历史版本在 [Releases](https://github.com/ios151/Scripting/releases)。
**设备工具箱不发 Release** —— 上面那个一键安装链接指向 `main` 上的 `dist/DeviceToolbox.zip`，
点进去装到的始终是最新版；想看改了什么翻提交记录。
**JavBus 同样不发 Release**，一键安装装到的始终是最新版，改了什么见它文档末尾的「更新记录」。
**快捷指令签名也不发 Release**，一键安装装到的始终是最新版，改了什么翻提交记录。

> ### ⚠️ 必须是 TestFlight 版的 Scripting
>
> **App Store 版（目前 3.2.1）跑不了这个脚本，装哪个 WLOC 版本都一样。**
> 整条链路的第一步是本机回环隧道（`VPN.localDevVPN`），而那套接口只有 TestFlight
> 版才有——没有它，后面的 RSD、DTX 全部无从谈起。
>
> **iOS 27 以下同样不支持。** 就算装上，配对那一步也**拿不到 PIN**，配不上对
> 整个脚本就没法用。原因还没排查，暂时不处理。
>
> 另外 WLOC 2.7.1 起用了 `ScriptSession`、`BackgroundKeeper.getState`、
> `Device.getNetworkState`、`Device.appVersion`、`cancelRSDTunnelOpening`
> 五个 3.3.0 才有的接口——这条只用来区分 TF 的新旧版本，对 App Store 版没有意义。

---

## AI 技能

给 Scripting 里的 AI 助手用的「技能」，放在 [skills/](skills/)。技能不是脚本，导入的地方不一样，上面那些一键安装链接装不了它。

| 技能 | 做什么 | 要求 | 安装 |
|---|---|---|---|
| **[shortcut-signer](skills/shortcut-signer)** | 搭配上面的「快捷指令签名」：让 AI 查着知识库写快捷指令草稿、做结构检查，再调用脚本在手机本机签名，聊天里给出「导入」卡片。详见[文档](docs/快捷指令签名.md#给-scripting-里的-ai-用) | 先装「快捷指令签名」脚本，并装好、信任证书 | [⬇️ 一键导入](https://scripting.fun/import_skills?urls=%5B%22https%3A%2F%2Fgithub.com%2Fios151%2FScripting%2Ftree%2Fmain%2Fskills%2Fshortcut-signer%22%5D) · [⬇️ 直接下载 zip](https://raw.githubusercontent.com/ios151/Scripting/main/dist/ShortcutSignerSkill.zip) |

一键导入用的是 Scripting 官方的技能导入链接：

```
https://scripting.fun/import_skills?urls=<URL 编码的 JSON 数组>
```

数组里放技能文件夹的 GitHub `tree` 地址（本仓库的技能在 `skills/<名字>`）。zip 是同一个文件夹打的包，
里面是一层 `<技能名>/` 目录，方便直接下载后导入；`build-release.py` 打包时顺带生成，放在 `dist/`。

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

# 打包：遍历仓库根下每个带 script.json 的目录，打成 dist/<名字>.zip；
# skills/ 下每个带 SKILL.md 的技能目录也一并打成 zip（根上多一层 <技能名>/，和脚本的相反）
python build-release.py
```

**zip 根目录必须直接是 `script.json` 和 `index.tsx`**，多包一层目录应用就认不出来，
`build-release.py` 会断言这一点。

### 加一个新脚本

1. 在仓库根建目录，放 `script.json` + `index.tsx`
2. `script.json` 的 `remoteResource.url` 指向 `dist/<名字>.zip` 的 raw 地址
   （**开发用的那份别设 `autoUpdateInterval`**：它会按间隔用已发布的 zip 覆盖设备上的脚本，开发期间很坑。
   想让用户装好后自动更新，只在仓库里的发布版设——JavBus 就是这样，86400 秒，即每天一次；WLOC 和设备工具箱没设）
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
（`core/`）则是完全独立的 TypeScript 实现，未复制任何上游源码。JavBus 的功能、接口与文案移植自 Nicked639 的
JSBox 脚本 JavBus 9.2，原脚本同样没有找到公开的许可声明。

## 声明

脚本只在你自己拥有并控制的设备上运行，不上传任何位置、搜索或配对数据。
配对记录存于钥匙串，仅本机可读。

位置模拟会影响所有依赖系统定位的应用。使用导航、紧急呼叫、交通出行或位置共享
之前，请务必先恢复真实位置。请勿用于误导他人、伪造证据、获取无权使用的服务，
或违反任何第三方服务的规则。

JavBus 是非官方客户端，不提供任何内容，所有数据来自第三方站点，可用性不受本项目控制。**含成人内容，未满十八岁禁止使用。**
