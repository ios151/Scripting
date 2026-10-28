# shortcut-signer · Scripting AI 技能

给 **Scripting 里的 AI 助手**用的技能，搭配「快捷指令签名」脚本：让 AI 能**写**快捷指令、**检查**它的结构、再调用脚本在手机本机**签名**。
用户让 AI 写一个快捷指令、或者手上有未签名的快捷指令文件时，AI 走「写草稿 → 结构检查（`check`）→ 本地签名（`sign`）」，
并在聊天里给出「导入」卡片，由用户自己导入、试跑。

技能里自带一份**快捷指令知识库**（`references/`：核对过的动作目录、参数值的写法、模板配方），AI 写动作之前先查它，只写登记过的动作。

分工：

- **写草稿、检查草稿**在技能自己里完成：`check` 用的是 `vendor/` 里带的一份检查器（和脚本里的逐字节相同），**不经过脚本**，所以脚本没装、版本旧也能用。
- **签名、查证书状态**交给「快捷指令签名」脚本：`scripts/router.ts` 用 `Script.run` 调它的无界面 API（脚本里的 `kit/api.ts`，`status` / `sign`），把结果交回。签名身份在脚本自己的钥匙串里，技能读不到。
- **证书确认就绪之后，`status` 不再启动脚本**：技能用自己的 `Storage` 记着「就绪」（`status` / `sign` 的结果里 `certificate.usable` 为 `true` 就记、不是就清），之后 `status` 直接答、结果里带 `"cached": true`；`"refresh": true` 强制重问一次。没就绪的状态每次都真的问脚本。起因是用户反馈：每次查证书状态都会弹出一个页面，配置好之后也一样。

给 AI 看的完整说明在 [SKILL.md](SKILL.md)。

## 使用前提

1. 想签名（`sign`）或查证书状态（`status`），Scripting 里要装好「快捷指令签名」脚本，名字必须一字不差，API 版本 ≥ 1。只写草稿、`check` 检查，不需要脚本。
2. 用户在那个脚本的「安装与信任证书」页，把证书装好并信任（系统不让脚本代劳，AI 也代劳不了），签出来的文件才导得进去。
3. 本技能是**搭配「快捷指令签名」脚本用的**，取代了之前那个 shortcut-skill（走第三方签名后端的那版）。手机上要是还装着旧的，**先删掉**：
   两个技能的触发语重叠，AI 可能挑到旧的、走已经被取代的签名链路。旧技能里有用的部分（检查器、写法模式、Scripting 动作目录）已经并进本技能。

## 安装

- **官方方式**：把整个 `shortcut-signer/` 文件夹放进一个 GitHub 仓库，用 Scripting 的技能导入链接打开
  `https://scripting.fun/import_skills?urls=<URL 编码的 JSON 数组>`，数组里放文件夹的 GitHub `tree` 地址
  （官方技能仓库的 README 里每个技能都有这样的 Import 链接，照着拼）。
- **手动**（未验证）：把文件夹拷到 `iCloud Drive → Scripting → scripting-skills/` 下，文件夹名保持 `shortcut-signer`。
  App 会不会自动识别手动拷进去的技能，没验证过；不行就用官方方式。

## 文件

```text
shortcut-signer/
├── SKILL.md                         给 AI 看的说明：知识库、三个操作怎么调用、返回什么、标准流程、证据分层、安全规则
├── README.md                        本文件
├── skill.json                       图标和颜色
├── schema.json                      sign.ts 的参数 schema（status / check / sign）
├── scripts/
│   ├── sign.ts                      调用入口，只接线；用 Storage 记「证书已就绪」
│   ├── router.ts                    路由：check 留在本地，status / sign 交给脚本；证书就绪后 status 直接答
│   └── localCheck.ts                本地检查：读文件 → 读 plist → 检查器 → 整形
├── vendor/                          脚本里同名文件的逐字节副本（检查器及其依赖，共 7 个）
│   ├── core/                        bytes / plist / check / read / report / names
│   └── kit/                         sources
├── templates/                       完整的快捷指令骨架：空白、询问并通知、菜单、如果 … 否则、请求接口、替换文本、分享面板收文字、文本 → 显示结果
├── references/
│   ├── actions.md                   动作索引、证据标签、按任务找动作
│   ├── actions-io.md                输入输出、网络、系统类动作
│   ├── actions-text.md              文本类动作
│   ├── actions-data.md              变量与数据类动作
│   ├── actions-flow.md              控制流与流程类动作
│   ├── values.md                    参数值的写法：变量、字典、条件、数字、给输出起名
│   ├── recipes.md                   模板配方：拿哪份改、怎么改
│   ├── patterns.md                  结构规则和检查器错误码对照
│   └── scripting-intents.md         Scripting 自己的 10 个动作（App Intent）的观察记录和写法
└── views/SignedShortcutView.tsx     聊天里的「导入」卡片
```

## 调用一眼看

```bash
# 看证书状态（只读，经脚本）
scripting-ts run "<skill_dir>/scripts/sign.ts" --queryparameters '{"operation":"status"}' --timeout 30

# 签名前检查草稿的结构（只读，本地跑，不需要脚本和证书）
scripting-ts run "<skill_dir>/scripts/sign.ts" --queryparameters '{"operation":"check","paths":["/绝对路径/工作区/shortcuts/drafts/a.plist"]}' --timeout 60

# 签名（经脚本）
scripting-ts run "<skill_dir>/scripts/sign.ts" --queryparameters '{"operation":"sign","paths":["/绝对路径/工作区/shortcuts/drafts/a.plist"],"outputDir":"/绝对路径/工作区/shortcuts"}' --timeout 60
```

## 参考资料

动作目录里「公开」级的条目，是对着这些公开资料核对的（每个条目里写了具体出处，`references/actions.md` 的「出处」一节有说明）：

- Apple 自己的动作参数表（iOS 27 / macOS 27 的 ToolKit 数据库），Federico Viticci 整理，MIT 许可：https://github.com/viticci/shortcuts-playground-plugin
- 公开仓库里真实导出的快捷指令（约 3400 个文本版文件）
- 别的项目对动作的定义：Cherri（GPL-2.0）、shortcuts-js（GPL-3.0）、ScPL（MIT）、swift-shortcuts（MIT）；前两个是 GPL，只核对事实，没有抄它们的代码和表

技能里没有复制它们的代码或数据文件，只引用了「某个动作有哪些参数键、取值有哪些」这类事实。

## 维护

- **`vendor/` 里的 7 个文件是脚本里同名文件的逐字节副本，源头是脚本。** 别在 `vendor/` 里改：先改脚本的 `core/` / `kit/`，再复制过来，
  自测会逐字节比对，不一致就报红（复制命令见脚本的 `MAINTAINING.md` 第 14 节）。
- 技能和脚本是两份东西：技能的 `schema.json` 里的 `operation` 取值、`scripts/router.ts` 里的 `REQUIRED_API_VERSION` 和 `SIGNER_SCRIPT`，
  要和脚本那边（`kit/api.ts` 的 `API_ACTIONS` / `API_VERSION`、`script.json` 的 `name`）一致。自测核对这几处，改了任何一边都要跑一遍。
- **知识库的规矩**：动作目录里每个动作都要写证据标签（真机 / 样本 / 公开），目前 58 个动作：1 个真机（`alert`）、30 个样本、27 个公开。标「样本」的动作，标识和参数表里的键名必须在真实样本里见过（自测在有 Apple 样本时核对）；
  标「公开」的要写出处网址；检查器认的系统动作（`core/check.ts` 的 `KNOWN_ACTIONS`）要和目录是同一份名单；用了「公开」级动作的模板，`recipes.md` 里要标出来。
  哪个动作在真机上跑通了，把标签升成「真机」，并改自测里「只有 alert」那一项。要扩充目录：把更多真实的 `.shortcut` 加进样本目录重挖，比凭记忆强得多。
- `check` 的规则在脚本的 `core/check.ts`，`references/patterns.md` 最后的错误码对照要和它的错误码保持一致。
- `templates/blank.plist` 是在真机上验证过能导入并运行的骨架（和脚本里「试签一个测试快捷指令」同一份内容的变体），改它之前先想清楚：每个键都是照真机验证过的文件抄的。
  其余模板的动作和值的形状来自真实样本，但整个组合没在真机上跑过。
- `references/scripting-intents.md` 里 Scripting 的 App Intent 动作来自用户之前导出的快捷指令样本，是**观察记录**，不是设备上跑过的结果。
- 脚本和技能里不放作者频道、不署第三方项目的名字，致谢清单只在脚本的 `NOTICE.md` 里。
