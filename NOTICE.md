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
| `快捷指令签名/` | 本项目独立实现，没有拷贝任何上游源码；签名流程参考了 0xilis 的格式研究（见下） |
| `skills/shortcut-signer/` | 本项目原创；知识库里动作和参数的核对用到了公开资料，只引用事实、没有复制代码或数据（见下） |
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

## 快捷指令签名的上游（0xilis）

`快捷指令签名/` 的代码是自己用 TypeScript 写的，没有拷贝任何上游源码。下面是它参考过格式研究的上游：

| 上游 | 借鉴了什么 | 许可 |
|---|---|---|
| [libshortcutsign](https://github.com/0xilis/libshortcutsign) / [shortcut-sign](https://github.com/0xilis/shortcut-sign) / libNeoAppleArchive（0xilis） | AEA1 容器的签名流程：密钥推导的次序、HMAC 链、签名覆盖的范围；对 WorkflowKit 签名校验的逆向分析（见其博客 *Reversing Contact Signed Shortcuts*） | MIT，全文见下 |
| RFC 6979 附录 A.2.5 | ECDSA-P256 实现拿它的已知答案（固定 k 的 r / s）核对过 | 公开文档 |

libshortcutsign 的 MIT 许可全文：

```
MIT License

Copyright (c) 2024 0xilis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

shortcut-sign 同为 MIT（Copyright (c) 2025 Snoolie Keffaber），许可文本与上面相同。

在 `script.json` 的 `contributors`、[docs/快捷指令签名.md](docs/快捷指令签名.md) 两处署名致谢。

写入端的验证用到了本机存的 24 个 Apple 官方签名的 `.shortcut`（多为他人作品），这些样本**不在本仓库内**。
Apple、iOS、Shortcuts（快捷指令）是 Apple Inc. 的商标，本脚本与 Apple 无隶属关系。

---

## shortcut-signer 技能知识库的资料来源

`skills/shortcut-signer/references/` 里的动作目录、参数值的写法和模板，文字是自己写的，示例里用的都是虚构的值。
「某个动作有哪些参数键、取值有哪些」这类事实，对着下面这些来源核过；**没有复制它们的代码或数据文件**：

| 来源 | 用来核对什么 | 许可 |
|---|---|---|
| [shortcuts-playground-plugin](https://github.com/viticci/shortcuts-playground-plugin)（Federico Viticci） | Apple 自己的动作参数表（iOS 27 / macOS 27 的 ToolKit 数据库）里的参数键和枚举取值 | MIT |
| 公开仓库里真实导出的快捷指令（约 3400 个文本版文件） | 动作标识、参数键、值的形状 | 各自的作者；只统计事实，没有复制内容 |
| [Cherri](https://github.com/electrikmilk/cherri) | 动作的定义，对照核对 | GPL-2.0；只核对事实，没有抄代码和表 |
| [shortcuts-js](https://github.com/joshfarrant/shortcuts-js) | 同上 | GPL-3.0；同上 |
| [ScPL](https://github.com/pfgithub/scpl) | 同上 | MIT |
| [swift-shortcuts](https://github.com/a2/swift-shortcuts) | 同上 | MIT |

结构检查器的规则和 `references/patterns.md` 里的写法模式，来自作者之前写的另一个快捷指令技能（作者自己的作品）。
`references/scripting-intents.md` 是对 Scripting 自己那十个 App Intent 动作的观察记录，来自作者导出的快捷指令样本。

---

## 运行环境

本项目是 [Scripting](https://apps.apple.com/app/id6479691128) 应用的脚本，
只能在该应用内运行。Scripting 应用本身及其类型定义（`dts/`）属于其作者，
不随本仓库分发，也不在本许可覆盖范围内。
