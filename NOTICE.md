# 第三方声明与许可范围

本仓库以 **GPL-3.0** 发布（见 [LICENSE](LICENSE)）。

选这个协议的理由很直接：代码可以随便看、随便改、随便用，但**任何衍生作品都必须
同样以 GPL-3.0 开源并提供完整源码**。拿去改一改做成闭源 App 售卖这条路，协议上
走不通。

---

## 许可覆盖的范围

| 部分 | 状态 |
|---|---|
| `core/` 协议层 | 本项目独立实现（见下） |
| `pages/`、`index.tsx` 等界面 | 在 BlackCCCat 的脚本基础上改写（见下） |
| `设备工具箱/kit/airlift.ts`、`atc.ts`、`airbeep.ts` | 思路来自 @Waa404，实现为本项目重写（见下） |
| `JavBus/` | 功能、接口与文案移植自 Nicked639 的 JSBox 脚本 JavBus 9.2，代码用 TypeScript 重写（见下） |
| `_selftest/` | 本项目原创 |
| `dev-loopback/` | 本项目原创 |
| `dts/` | **不在本仓库内**，属于 Scripting 应用作者 |

---

## BlackCCCat 的 Scripting 脚本（界面基座）

- 项目：[BlackCCCat/Scripting-Scripts](https://github.com/BlackCCCat/Scripting-Scripts)
- 许可：**原脚本未声明任何许可**
- 说明：WLOC 的界面最初是在其同名脚本上改出来的。经过多轮重写，当前各页面与
  原脚本已有较大差异，但结构上的承袭关系仍然存在，因此在此声明。

**这一点需要如实说明**：原脚本既没有 LICENSE 文件，`script.json` 里的 `author`
与 `contributors` 也是空的。按版权法的默认规则，未声明许可即「保留所有权利」，
严格来说本项目无权对这部分代码重新许可。

本项目的处理方式是：在 README、`script.json` 的 `contributors`、应用内「关于」页
三处署名致谢，并在此说明来源与状态。**若原作者对此有任何异议，请通过 GitHub
Issue 联系，我们会立即配合调整或移除相关部分。**

---

## 协议层

`core/` 下的全部实现——二进制 plist、NSKeyedArchiver、OPACK、TLV8、SRP-6a、
HKDF / X25519 / Ed25519 / ChaCha20-Poly1305、RemotePairing 握手与 pair-verify、
HTTP/2 与 RemoteXPC、RSD 服务发现、DTX 消息帧——均为本项目的独立 TypeScript
实现，**未复制任何上游源码**。

实现过程中对照阅读了以下项目以理解协议格式。协议本身属于事实性接口，不受版权
保护，但仍在此致谢：

| 项目 | 许可 | 说明 |
|---|---|---|
| [wloc for iOS](https://github.com/ios151/wloc) | MIT | 同作者的原生实现，协议链路的主要参考 |
| [Roam Control](https://github.com/seanhowarthdev/Roam-Control) | MIT | 原生实现，可对照阅读 |
| [idevice](https://github.com/jkcoxson/idevice) | MIT | 协议格式参考 |
| [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) | GPL-3.0 | 协议格式参考 |

> `10.7.0.1` / `10.7.1.1` 这组回环地址沿用
> [LocalDevVPN](https://github.com/jkcoxson/LocalDevVPN) 的约定，以便已有工具
> 无需改动即可配合使用。这是接口约定而非代码复用。

---

## 通话录音提示音（@Waa404）

设备工具箱里「通话录音提示音」那一页，把系统「正在录音」的播报声换成静音文件。
它要动的两个文件在 `/var/mobile/Library/CallServices/Greetings/default/`——**媒体域之外**，
AFC 够不着。走通这条路要三步：`com.apple.streaming_zip_conduit` 把一个带符号链接的 zip
解进媒体域；往 `Books/Sync/Books.plist` 写一份资产清单；再借 AirTraffic（`com.apple.atc`）
的同步，顺着那条符号链接把文件搬到媒体域之外。关键在符号链接的内容写成 `../../../<目标目录>`。

**这条链是 @Waa404 趟出来的**，本项目的实现在他的方案基础上重写。相对原方案改的几处
（每一条的来由都写在 `设备工具箱/kit/airlift.ts` 的文件头）：

- 读回轮询**复用同一条 AFC 连接**——每轮重借要四趟往返，真实探测间隔会被拉到秒级，
  抓不住设备把文件搬过来的那一瞬
- 同一个目录下的文件凑成一轮写回（读仍然一个文件一轮：真机实测设备一轮只收一个越界资产）
- 读不到时**保留**媒体域里的 `airlift-recovered-*`——这条链的读是搬运式的，读超时那会儿
  原路径上的文件已经没了，那一份是用户仅存的
- 默认不做读回校验：校验要多跑三轮、占掉整个操作四分之三的时间，还时灵时不灵

协议细节另外对照了 [idevice](https://github.com/jkcoxson/idevice) 和
[pymobiledevice3](https://github.com/doronz88/pymobiledevice3)（已列在上一节）。

> **@Waa404 没有公开仓库，这里只署名致谢**，因此无从标注许可。和 BlackCCCat 那一节
> 同样的态度：若原作者对此有任何异议，请通过 GitHub Issue 联系，我们会立即配合调整
> 或移除相关部分。

---

## JavBus 的上游（Nicked639 的 JSBox 脚本）

`JavBus/` 把 Nicked639 的 JSBox 脚本 **JavBus 9.2**（「你口袋中的 AV 辞典」）移植到 Scripting：功能清单、请求的页面、
解析方式逐条对照原脚本核出来，界面和逻辑用 TypeScript / Scripting 的原生组件重写；作者声明、更新说明等文案沿用原版。
推荐功能里的「作者精选」读的是原作者在 GitLab 上公开维护的列表，「作者推荐」走原作者的 Apps Script；
「网友推荐」改走另做的社区推荐服务（原作者的网友推荐上传已经失效）。

- 作者：Nicked639（[Telegram](https://t.me/nicked)）
- 许可：**没有找到任何公开的许可声明**。原脚本经 JSBox / Telegram 分发；作者早年的 GitHub 仓库
  [Nicked639/xteko](https://github.com/Nicked639/xteko) 没有 LICENSE，里面现在也已经没有 JavBus 的文件。

和上面几节同样的态度：在 `script.json` 的 `contributors`、脚本设置页的「关于」、[docs/JavBus.md](docs/JavBus.md) 三处署名致谢，
并在此说明来源与状态。**若原作者对此有任何异议，请通过 GitHub Issue 联系，我们会立即配合调整或移除相关部分。**

---

## 运行环境

本项目是 [Scripting](https://apps.apple.com/app/id6479691128) 应用的脚本，
只能在该应用内运行。Scripting 应用本身及其类型定义（`dts/`）属于其作者，
不随本仓库分发，也不在本许可覆盖范围内。
