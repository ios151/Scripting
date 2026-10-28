---
name: shortcut-signer
description: 在手机本机写、检查、签名快捷指令：把未签名的 .shortcut / plist 签成可以直接导入快捷指令 App 的文件（通过已安装的「快捷指令签名」脚本，不上传到任何服务）。适用于：用户让你写一个快捷指令并且要能导入、手上有未签名的快捷指令文件、导入时提示「无法验证 / 未信任」。技能里自带一份核对过的快捷指令动作知识库，写草稿和检查草稿不需要别的东西；要签名，得先在 Scripting 里装好「快捷指令签名」脚本，并在手机上装好、信任它的证书。
runtime: scripting
entry: scripts/sign.ts
metadata:
  display_name: "快捷指令签名"
  intent_patterns: "快捷指令签名, 签名快捷指令, 给快捷指令签名, 导入快捷指令, 快捷指令导入不了, 快捷指令无法验证, 未信任的快捷指令, 写一个快捷指令, 生成快捷指令, 做一个快捷指令, 检查快捷指令, 快捷指令怎么写, 快捷指令动作, 快捷指令模板, sign shortcut, shortcut signing, import unsigned shortcut, create a shortcut file, check shortcut"
  required_tools: "run_shell_command, file_tool"
  input_schema_file: "schema.json"
---

# 用途

让你（Scripting 里的 AI）能调用已安装的「快捷指令签名」脚本，**在用户的手机上**检查并签名快捷指令，并在聊天里交出可以直接导入的文件。

背景：iOS 15 起，没签过名的快捷指令导入不了，只能导入签过名的 `.shortcut` 文件。「快捷指令签名」脚本用它自己生成的根证书签名；用户在手机上装好并信任这张证书之后，签出来的文件就能直接导入。整个过程在手机本机完成，不上传到任何服务。

本技能负责：帮用户把需求落成快捷指令草稿（技能里自带一份动作知识库，见下面「知识库」）、本地检查草稿的结构、调用「快捷指令签名」脚本签名、读结果、告诉用户下一步。签名的密码学全在脚本里，你不需要也不应该自己实现。

本技能是**搭配「快捷指令签名」脚本用的**：写草稿和检查草稿在技能自己里完成，签名和查证书状态交给脚本。

一次完整的交付是四步，**每一步都要有证据，别越级**：写草稿 → 结构检查（`check`）→ 本地签名（`sign`）→ 用户导入并试跑。

# 知识库：写任何动作之前先查这里

快捷指令里每个动作的标识和参数键名**一个字都不能错**，写错了检查和签名都发现不了，导入后那一步就是坏的。所以技能里带了一份核对过的动作知识库，**只写它登记过的动作**：

| 文件 | 内容 |
|---|---|
| `<skill_dir>/references/actions.md` | **先读这个**：动作索引（共 58 个）、证据标签（真机 / 样本 / 公开各代表什么、出处在哪）、按想做的事找动作 |
| `<skill_dir>/references/actions-io.md` | 弹提示 / 通知 / 朗读、向用户要输入、剪贴板、分享、打开 App、运行快捷指令、链接、网络请求（含 POST）、设备信息、SSH、地图、第三方 App 的动作 |
| `<skill_dir>/references/actions-text.md` | 文本、替换、正则匹配、合并、拆分、大小写、URL 编码、Base64、哈希 |
| `<skill_dir>/references/actions-data.md` | 变量、列表、计数、计算、数字、日期、词典、取 / 设词典值 |
| `<skill_dir>/references/actions-flow.md` | 如果（含条件码表）/ 重复 / 对每个项目重复 / 菜单、等待、备注、停止、停止并输出 |
| `<skill_dir>/references/values.md` | 参数的值怎么写：常量、变量引用、带变量的文本、字典、多条件、给输出起名 |
| `<skill_dir>/references/recipes.md` | 想做 X 该拿哪份模板改，怎么改 |
| `<skill_dir>/references/patterns.md` | 动作和控制流的结构规则、检查器的错误码对照 |
| `<skill_dir>/references/scripting-intents.md` | Scripting 自己的动作（运行脚本、打开 AI 聊天等） |

三条规矩：

1. **目录里没有的动作不要写。** 请用户在快捷指令 App 里手动做出来、分享给你看，或者换成目录里的动作拼。
2. **每个动作都带证据标签。** 只有 `alert` 是「真机」验证过的，其余是「样本」（在 24 个真实的 Apple 签名快捷指令里见过）或「公开」（两个独立的公开出处对得上）。标签只说明「这个动作的标识和键名是真的」，**不说明你拼出来的这个组合一定能运行**。
3. **交付时告诉用户用到了哪些动作、各是什么证据等级，并让他导入后先试跑。**

# 你能做什么，不能做什么

| 能做 | 不能做 |
|---|---|
| 查证书状态（`status`） | 替用户装证书、点「信任」——系统不让脚本代劳，你也做不到，只能指引用户 |
| 签名前检查草稿的结构（`check`，在技能自己里本地跑，不需要脚本和证书） | 保证检查通过的快捷指令导入后一定能运行：检查只看结构 |
| 给一个或多个快捷指令文件签名（`sign`） | 自动导入：最后一步必须用户自己点（分享面板里选「快捷指令」） |
| 帮用户写一个简单的新快捷指令，再检查、签名 | 读取或修改**已经签过名**的快捷指令的完整内容（`check` / `sign` 只返回动作标识这类摘要，不会把内容反解成 plist 交给你） |
| 在聊天里显示「导入」卡片 | 检测证书到底有没有被系统信任：`confirmedInstalled` 只是用户在脚本里自己打的勾 |

# 先决条件

1. 要查证书状态（`status`）或签名（`sign`），「快捷指令签名」脚本得装在 Scripting 里，名字**必须一字不差**，脚本返回里的 `apiVersion` 至少是 1（更旧的版本调用会得到 `outdated` 错误）。**只写草稿、用 `check` 检查，不需要这个脚本**：`check` 在技能自己里本地跑。
2. 用户已经在脚本的「安装与信任证书」页做完三步（装描述文件、在「设置 → 通用 → 关于本机 → 证书信任设置」里信任、回脚本里打勾）。这件事只有用户能做。**`status` 和 `check` 不需要证书**；`sign` 能签，但签出来的文件要证书就绪才导得进去。
3. 手机上没有这张证书的设备，导不进签出来的文件；证书是每台设备各装各的。

**每次开始前先跑一次 `status`**：便宜、只读、不会生成任何东西。证书没就绪就别急着签，先告诉用户怎么办（见「证书没就绪时怎么说」）；草稿可以照常写、照常检查。`status` 报 `launch` / `no_result` / `outdated`（脚本没装或太旧）也不用停：草稿照写、照 `check`，只是到签名那一步要先让用户装 / 更新脚本。

# 调用方式

所有调用都是同一个入口：

```bash
scripting-ts run "<skill_dir>/scripts/sign.ts" --queryparameters '<JSON>' --timeout 60
```

`<skill_dir>` 是本技能的安装目录。命令会打印一行 `Script result: <json>`，`<json>` 就是下面各个返回值。路径里有空格很正常，所以脚本路径要加双引号；JSON 里不要出现单引号（路径里有单引号时，让用户改文件名，别硬转义）。

**不要把整份 plist 塞进命令行。** XML 里的引号、换行、`&` 在 shell 里很容易转义错。正确做法是先用 `file_tool` 把 plist 写成文件，再把路径传进来；这样用户也能在工作区里看到自己到底在签什么。

## operation: status

```bash
scripting-ts run "<skill_dir>/scripts/sign.ts" --queryparameters '{"operation":"status"}' --timeout 30
```

返回：

```json
{
  "ok": true,
  "action": "status",
  "apiVersion": 2,
  "certificate": {
    "generated": true,
    "confirmedInstalled": false,
    "usable": false,
    "name": "Shortcut Signer Root b661",
    "fingerprint": "39:D4:28:…",
    "expires": "2036-10-25"
  },
  "nextStep": "证书还没确认装好并信任。让用户打开「快捷指令签名」脚本，……"
}
```

- `generated`：脚本里有没有签名身份。没有的话，第一次 `sign` 会自动生成。
- `confirmedInstalled`：用户有没有在脚本里打「我已经装好并信任了这张证书」的勾。**这是用户的自述，不是系统检测的结果。**
- `usable`：`generated` 且 `confirmedInstalled`。只有它为 `true`，才可以对用户说「签好的文件可以导入」。
- `nextStep`：下一步该做什么，写给你看的，转述给用户即可；没有待办就是 `null`。

## operation: check

签名**之前**检查草稿的结构：只读，不会生成或写出任何文件。

**它在技能自己的运行时里直接跑，不经过「快捷指令签名」脚本**（技能里带了一份和脚本逐字节相同的检查器）：所以脚本没装、版本旧、证书没信任，都不影响它。

```bash
scripting-ts run "<skill_dir>/scripts/sign.ts" --queryparameters '{"operation":"check","paths":["/绝对路径/当前工作区/shortcuts/drafts/喝水提醒.plist"]}' --timeout 60
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `operation` | `"check"` | ✅ | |
| `paths` / `path` | 字符串数组 / 字符串 | ✅ | 文件的**绝对路径**，最多 20 个；XML plist、二进制 plist 都行。**已签名的 `.shortcut` 本地检查不收**（会是一条 `unreadable`，说明直接 `sign`） |
| `strict` | 布尔 | 否 | `true` 时警告也当成错误（错误码加 `strict_` 前缀） |

返回（一份通过、一份没通过的例子；**没有 `apiVersion`**，因为它不经过脚本）：

```json
{
  "ok": true,
  "action": "check",
  "checkedCount": 2,
  "passedCount": 1,
  "failedCount": 1,
  "items": [
    {
      "name": "最小有效.plist", "ok": true, "inputKind": "xml", "actionCount": 2,
      "actionIds": ["is.workflow.actions.gettext", "is.workflow.actions.showresult"],
      "errorCount": 0, "warningCount": 1, "errors": [],
      "warnings": [{ "severity": "warning", "code": "missing_uuid", "path": "$.WFWorkflowActions[1].WFWorkflowActionParameters.UUID", "message": "……" }]
    },
    {
      "name": "无效.plist", "ok": false, "inputKind": "xml", "actionCount": 2, "actionIds": ["……"],
      "errorCount": 3, "warningCount": 1, "warnings": [],
      "errors": [{ "severity": "error", "code": "invalid_uuid", "path": "$.WFWorkflowActions[0].WFWorkflowActionParameters.UUID", "message": "动作 UUID 的形状不对……" }]
    }
  ],
  "nextStep": "有 1 份没通过：按各自 errors 里的 code 和 message 修改后重新 check。……"
}
```

- 每个问题有稳定的 `code`、出问题的位置 `path` 和给人看的 `message`；错误码的含义和改法见 `<skill_dir>/references/patterns.md` 最后的对照表。
- `items[].ok` 为 `true` 只表示**没有错误**（有警告也算通过，`strict` 例外）。**通过只说明结构上没发现问题**，不保证导入后能运行。
- 常见的警告不用慌：`missing_uuid`（动作没有 UUID，输出没人引用就没关系，真实文件里将近一半的动作都没有）、`missing_name`（没有 `WFWorkflowName`，真实导出的快捷指令本来就没有）。真正要改的是错误。
- **例外：`unknown_action` 这条警告自己写的草稿要当回事**：它说某个系统动作的标识不在知识库里，多半是拼错了或者凭记忆编的，对着 `actions.md` 改成登记过的动作（用户给的现成文件里的别的系统动作可以不管）。它只核对标识，**参数键名对不对检查器不管**，要自己对着 `actions-*.md` 核。
- 每份最多列 50 条错误和 50 条警告，总数在 `errorCount` / `warningCount` 里；先改前面的，往往后面的一并消失。
- 读不了的、不是 plist 的文件、已签名的文件，会是一条 `unreadable` 错误，原因写在 `message` 里。
- **用户给的现成文件不必先 `check`**：检查器是为你写的草稿设计的。拿 24 个真实的 Apple 签名样本试过，没有一个被判有错，但它没见过的写法仍可能被报成问题，那不代表文件有错。跑了的话当参考，别当裁决。
- **检查通过 ≠ 动作写对了**：检查器只看结构，不知道某个动作的标识、参数键名对不对（那是「知识库」管的事）。草稿里的动作都要在 `actions.md` 的目录里查过。

## operation: sign

```bash
scripting-ts run "<skill_dir>/scripts/sign.ts" --queryparameters '{"operation":"sign","paths":["/绝对路径/我的快捷指令.plist"],"outputDir":"/绝对路径/当前工作区/shortcuts"}' --timeout 60
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `operation` | `"sign"` | ✅ | |
| `paths` / `path` | 字符串数组 / 字符串 | ✅ | 要签的文件的**绝对路径**，最多 20 个；`path` 是只有一个文件时的简写 |
| `outputDir` | 字符串 | 强烈建议 | 签好的文件放哪：绝对路径的目录，不存在会创建，**重名不覆盖**（自动加序号）。不给就写到临时目录，那里的文件可能被系统或脚本下次启动时清掉，所以**总是给一个当前工作区里的目录**（约定用 `<工作区>/shortcuts/`） |

返回（签好一份、失败一份的例子）：

```json
{
  "ok": true,
  "action": "sign",
  "apiVersion": 2,
  "signedCount": 1,
  "failedCount": 1,
  "items": [
    {
      "ok": true,
      "name": "喝水提醒",
      "path": "/绝对路径/当前工作区/shortcuts/喝水提醒.shortcut",
      "size": 2312,
      "actionCount": 2,
      "actionIds": ["is.workflow.actions.alert", "is.workflow.actions.alert"],
      "actionIdsTruncated": false,
      "compressed": false,
      "inputKind": "xml",
      "resigned": false
    },
    { "ok": false, "name": "坏文件.zip", "error": "认不出这个文件：……共 44 字节，开头是 50 4B 03 04 ……像是 zip 压缩包：先解压，再选里面的 .shortcut 文件。" }
  ],
  "certificate": { "generated": true, "confirmedInstalled": true, "usable": true, "name": "…", "fingerprint": "…", "expires": "2036-10-25" },
  "nextStep": "签好了。让用户点「导入」，在系统分享面板里选「快捷指令」。"
}
```

- `items` 按传入顺序，一份一份各管各的：成功的有 `path`，失败的有 `error`（能直接转述给用户的中文原因）。
- `actionIds` 是每个动作的标识，按顺序，最多 100 个；读不出来的是 `"unknown"`。**用它核对「签的到底是什么」**，再用人话告诉用户。
- `inputKind`：来料原本是 `xml` / `bplist` / `signed`。`resigned` 为 `true` 表示来料已经是签过名的，这次只是换成了本脚本的签名。
- `compressed`：结果里有没有真的压缩过的段，只是诊断信息，不影响导入。
- 整体 `ok: true` 只表示「请求处理了」，**要看每个 `items[].ok`**。
- `sign` **不会自动先 `check`**，也不会因为没检查就拒绝；该不该先查是你的流程，不是脚本的闸。

## 失败时的返回

```json
{ "ok": false, "error": { "type": "validation", "message": "没有给文件路径：用 paths（字符串数组）或 path（字符串）传文件的绝对路径" } }
```

（`status` / `sign` 是脚本处理的，它们的失败结果里还会带一个 `apiVersion`。）

| `error.type` | 含义 | 你该怎么办 |
|---|---|---|
| `validation` | 参数不对（没给路径、路径不是绝对路径、超过 20 个、`outputDir` 不是绝对路径、`operation` 不认识） | 照 `message` 改参数再试，不用惊动用户 |
| `identity` | 签名身份读不出来（钥匙串里的数据损坏）或存不进去 | 原样告诉用户。损坏的话，让用户在脚本「证书」页最下面点「重新生成签名身份」；重新生成后证书要重装、重新信任 |
| `internal` | 脚本内部出了意外 | 把 `message` 告诉用户，别反复重试 |
| `launch` | 没能运行「快捷指令签名」脚本（只会出现在 `status` / `sign`） | 多半是没装，或者名字被改了。让用户确认脚本装在 Scripting 里 |
| `no_result` | 脚本没返回结果（只会出现在 `status` / `sign`） | 多半是脚本版本太旧、还没有 API 入口，或者被用户手动关掉了。让用户更新脚本，或先手动打开确认它能运行 |
| `outdated` | 脚本的 API 版本比本技能要求的旧（只会出现在 `status` / `sign`） | 让用户更新「快捷指令签名」脚本 |

# 标准流程

## A. 用户给了现成的快捷指令文件

1. 跑 `status`，看 `certificate.usable`（没就绪先走「证书没就绪时怎么说」，用户愿意再继续）。
2. 拿到文件的绝对路径。文件要在你拿得到绝对路径的地方（当前工作区里，或用户明确给出的路径）。
3. 如果文件是 **iCloud 分享链接**（`https://www.icloud.com/shortcuts/…`）：那本来就是 Apple 签过名的，在 Safari 里直接打开就能导入，**不需要也不应该**用本技能。
4. 跑 `sign`，`outputDir` 用 `<工作区>/shortcuts`。
5. 读结果（见「读结果」），再按「怎么给用户看结果」交付。

## B. 用户要你写一个新的快捷指令

**1. 先把需求规格化。** 缺哪个问哪个，别替用户定：

- 目标：要完成什么结果；
- 触发：手动 / 分享面板 / 自动化；
- 输入、处理步骤、输出，以及输出去哪；
- 需要的权限，依赖哪些 App（比如要不要调用 Scripting 里的脚本）；
- 运行时是否需要用户选择；
- 运行在 iOS / iPadOS / macOS。

**2. 判断路线**（给用户一句话说明）：

- 输入和处理都能用系统自带的动作串起来 → **直接做成快捷指令**；
- 有一部分得交给外面（Scripting 脚本、网络服务、第三方 App）→ **混合型**：快捷指令只负责串联，外部依赖要在交付说明里写明（调用 Scripting 的动作见 `<skill_dir>/references/scripting-intents.md`）；
- 逻辑很重、拆不成系统动作 → **不建议做成快捷指令**，建议直接做成脚本。

**3. 查知识库，把要放的动作用人话列给用户，得到明确同意。**

- 先读 `<skill_dir>/references/actions.md`，在索引里找到要用的每个动作；用到哪一类就读哪一类的 `actions-*.md`，参数的值怎么写读 `values.md`。**列出来的动作必须都在目录里**；目录里没有的，换个做法，或者请用户在快捷指令 App 里手动做出来给你看。
- 把每个动作的作用和证据等级（真机 / 样本 / 公开）一起说给用户。涉及发消息、发邮件、网络请求、读剪贴板 / 照片 / 联系人、运行脚本、删除之类的动作，要特别说明，并得到明确同意。

**4. 选骨架**，**只改你需要改的部分**（`WFWorkflowName`、`WFWorkflowActions`）。`<skill_dir>/references/recipes.md` 说了每份模板是干什么的、怎么改：

- 只弹一个提示：`<skill_dir>/templates/blank.plist`（真机验证过能导入并运行）；
- 向用户要一段文字、再通知：`<skill_dir>/templates/ask-and-notify.plist`；
- 弹菜单让用户选：`<skill_dir>/templates/menu.plist`；
- 按剪贴板有没有内容分支（「如果 … 否则」）：`<skill_dir>/templates/if-clipboard.plist`；
- 请求接口、取 JSON 字段、再通知：`<skill_dir>/templates/http-json.plist`；
- 对文字做替换：`<skill_dir>/templates/replace-text.plist`；
- 要出现在分享面板里、接别的 App 分享来的文字：`<skill_dir>/templates/share-text.plist`；
- 文本 → 显示结果：`<skill_dir>/templates/text-to-result.plist`；
- 要让快捷指令去运行 Scripting 里的脚本：先读 `<skill_dir>/references/scripting-intents.md`。

变量引用、控制流分组的结构规则和检查器的错误码，读 `<skill_dir>/references/patterns.md`。

**5. 写草稿**：用 `file_tool` 写到 `<工作区>/shortcuts/drafts/<名字>.plist`，记下绝对路径。内容必须是**纯 XML plist 文本**，不要加 Markdown 代码围栏，不要写成 JSON。

**6. 检查**：跑 `check`。有错误就按 `code` / `message` 改，再 `check`；**最多改三轮**，三轮还没过就把剩下的问题原样告诉用户，别无限循环，也别把没过的草稿悄悄签掉。`check` 通过之后，**再回头把草稿里的每个动作对一遍知识库**：检查器只看结构，不会替你核对动作的标识和参数键名对不对。

**7. 签名**：`check` 通过后跑 `sign`，`outputDir` 用 `<工作区>/shortcuts`；`actionIds` 要和你打算放的动作一致。

**8. 交付**（见「怎么给用户看结果」），并提醒用户：**导入后先小范围试跑**。检查和签名通过，只说明文件的结构和签名没问题，动作写得对不对要运行才知道。

### plist 的写法要点

- 顶层是字典，必须有 `WFWorkflowActions`（数组）；**从 `templates/` 里的骨架开始，别删它的顶层键**（真实快捷指令有 12 个顶层键，见 `<skill_dir>/references/patterns.md` 第零节）。骨架里多带了 `WFWorkflowName`：真实导出的快捷指令里没有这个键，名字在文件名里，所以没有它检查器只给警告、签名时用草稿的文件名。每个动作是一个字典：`WFWorkflowActionIdentifier`（字符串）+ `WFWorkflowActionParameters`（字典）。
- **动作的标识和参数键名只用知识库里登记过的**（`actions.md`）。本机真机验证过的动作只有一个：`is.workflow.actions.alert`；其余登记的动作是「样本」（真实 Apple 签名快捷指令里见过）或「公开」（两个独立的公开出处对得上）级，**标签说明标识和键名是真的，不说明你拼出的组合一定能运行**，导入后必须先试跑。
- **不要凭记忆编目录里没有的动作的标识和参数名。** 写错了检查和签名照样可能通过，但导入后那个动作会是坏的或被忽略。没把握的动作，宁可告诉用户「这个动作我没核对过」，请用户在快捷指令 App 里手动做出来、分享给你看，或者换成目录里的动作。
- XML 转义：字符串里的 `&` 写成 `&amp;`，`<` 写成 `&lt;`，`>` 写成 `&gt;`。布尔值是 `<true/>` / `<false/>`，整数是 `<integer>`，浮点数是 `<real>`。
- 文件用 UTF-8，不要带 BOM；文件名随意，`.plist` 或 `.shortcut` 都行（脚本按内容认，不按扩展名）。
- 快捷指令的名字取自 `WFWorkflowName`，没有的话用草稿的文件名（去掉扩展名）；签好的文件就叫 `<名字>.shortcut`。名字里有 `/` 之类不能放进文件名的字符，脚本会换成下划线。

## C. 读结果

1. 先看 `ok`。`false` 就按上面「失败时的返回」处理。
2. 逐项看 `items[].ok`：成功的进入交付；失败的把 `error` 转述给用户，并按下面的对照表判断是不是你的文件写错了：

| `error` 里的关键词 | 多半是 | 怎么办 |
|---|---|---|
| 「认不出这个文件」 | 文件不是 plist。你自己写的话，多半是包了 Markdown 围栏、写成了 JSON，或者开头多了别的字 | 重写成纯 XML plist，开头应该是 `<?xml`。报错里的「开头是 …」字节能帮你判断 |
| 「plist 解析失败」 | XML 有语法错误：标签没闭合、`&` 没转义 | 修好再签 |
| 「plist 里没有 WFWorkflowActions」/「顶层不是字典」 | 缺关键字段 | 补上 |
| 「这是网页（HTML）」 | 拿到的是网页，不是文件 | 换成真正的文件 |
| 「读不了这个文件」 | 路径不对，或文件在 iCloud 里还没下载 | 核对路径；让用户先把文件下载到本地 |
| 「文件太大」 | 超过 20 MB，不像快捷指令 | 让用户确认选对了文件 |

3. 成功但 `resigned` 为 `true`：来料本来就是签过名的。告诉用户这次是换成了本脚本的签名；如果他只是想导入一个 Apple 签过名的文件，其实不需要经过这里。

## D. 怎么给用户看结果

**先说清现在到了哪一层，每层只说证据支持的话：**

| 层级 | 证据 | 你能说 |
|---|---|---|
| 草稿 | 你写了文件 | 「这是草稿」，不能说能导入 |
| 已检查 | `check` 通过 | 「结构上没发现问题」，不保证能运行 |
| 已签名 | `sign` 成功（脚本已自检）且 `certificate.usable` 为 `true` | 「文件格式和签名没问题，可以导入」 |
| 已导入 / 已运行 | 用户告诉你他导入了、试跑了 | 以用户的说法为准，别替他宣布 |

`certificate.usable` 为 `false` 时，签名虽然成功，但**手机不信任这张证书**，别说「可以导入了」，走「证书没就绪时怎么说」。

对每个成功的文件：

1. 用一个直接的 Markdown 链接报出文件路径；
2. 输出一个 `scripting-file` 块，在聊天里显示「导入」卡片（用户点「导入」→ 系统分享面板 → 选「快捷指令」）：

````markdown
```scripting-file
{
  "path": "<skill_dir>/views/SignedShortcutView.tsx",
  "props": {
    "path": "/绝对路径/当前工作区/shortcuts/喝水提醒.shortcut",
    "name": "喝水提醒",
    "actionCount": 2,
    "size": 2312,
    "certificateReady": true
  }
}
```
````

`path` 里的 `<skill_dir>` 要换成本技能的**绝对安装目录**（通常是 `/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripting-skills/shortcut-signer`）。`props.certificateReady` 填 `sign` 结果里的 `certificate.usable`：它是 `false` 的话，卡片上会提醒「证书还没确认装好，导入会失败」。

3. 说清楚三件事：这个快捷指令会做什么（用人话，依据你写的内容和 `actionIds`）；怎么导入（点卡片上的「导入」→ 分享面板 → 选「快捷指令」）；导入后先试跑一遍。

## 证书没就绪时怎么说

`status` 的 `usable` 为 `false`（或 `sign` 结果里 `certificate.usable` 为 `false`）时，**不要说「签好了，可以导入了」**。告诉用户：

1. 打开「快捷指令签名」脚本（可以点这个链接：`scripting://run/%E5%BF%AB%E6%8D%B7%E6%8C%87%E4%BB%A4%E7%AD%BE%E5%90%8D`），进「安装与信任证书」；
2. 第一步装证书：两条路任选其一（Safari 下载描述文件 / 存到「文件」里点开装）；
3. 第二步在「设置」里装并信任：「设置」最上面的「已下载描述文件」→ 安装；再到「设置 → 通用 → 关于本机 → 证书信任设置」里打开这张证书的开关；
4. 回到脚本，在第二步底下打勾「我已经装好并信任了这张证书」；
5. 可选：点第三步「试签一个测试快捷指令」，导入并运行，弹出提示框就说明整条链路通了。

做完之后你再跑一次 `status`，`usable` 变成 `true` 才算就绪。

# 安全规则

1. **签名不是审核。** 它只说明「这个文件是用这台手机上的那张证书签的」，不说明内容安全。快捷指令能做很多事：发消息和邮件、请求网络、读剪贴板 / 照片 / 联系人、运行脚本、删文件……
2. **签名前先用人话向用户说明这个快捷指令会做什么，拿到明确同意。** 别人给的文件尤其要看 `actionIds`：出现网络请求、发消息 / 邮件、运行脚本 / SSH、删除、读取敏感数据之类的动作，先提醒用户，再问要不要继续。
3. 不要把用户的隐私（剪贴板、联系人、位置、密码、token）硬编码进快捷指令。
4. 不要替用户做决定去装证书、点信任；不要建议用户把根证书发给别人。
5. 不要为了「看起来像官方的」给快捷指令取具有迷惑性的名字或说明。
6. 失败了先读 `error` 再改，别连续重试刷出一堆文件（重名会自动加序号，不会覆盖，但工作区会变乱）。
7. 不要承诺「一定能运行」：检查通过只说明结构没发现问题，自检通过只保证文件格式和签名对得上 Apple 的校验。

# 脚本做了什么（需要向用户解释时用）

- 脚本生成一张根证书和一张叶证书；**根私钥生成完叶证书就丢弃，从不存盘**；叶私钥存在 Scripting 的钥匙串里，只能签快捷指令。
- 手机里装的是根证书，信任它是整机生效的。这也是为什么根私钥必须丢掉：它要是还在，就能给这台手机签任意网站的证书。
- 每份签出来的文件，脚本都会自己再验一遍（和 Apple 校验的同一套），验不过就丢掉，不会交给用户。
- 叶证书固定一张，想换只能整套重新生成，手机上重装、重新信任。
- 签出来的文件**只有信任这张根证书的设备**才导得进去。想公开分享，就先导入到自己的快捷指令里，再用快捷指令自己的「拷贝 iCloud 链接」，那样上传的是 Apple 重新签过的版本。

# 排错对照

| 用户说 | 多半是 | 怎么办 |
|---|---|---|
| 导入时提示「无法验证」「未信任」「已损坏」 | 证书没装，或装了没在「证书信任设置」里打开开关 | 走上面「证书没就绪时怎么说」，重做第二步 |
| `status` / `sign` 报 `launch` / `no_result` / `outdated` | 脚本没装 / 名字被改 / 版本太旧 | 让用户确认脚本装在 Scripting 里、名字是「快捷指令签名」，并更新脚本。写草稿和 `check` 不受影响，可以先做 |
| 分享面板里没有「快捷指令」 | 系统没列出来 | 让用户改用卡片上的「存到文件」，到「文件」App 里点开；或在脚本里用结果行的「打开方式」 |
| 导入成功但运行出错，或某一步显示「未知动作」 | 动作写错了（标识或参数） | 这是 plist 内容的问题，不是签名的问题；回到 B 流程，对着 `actions.md` 和对应的 `actions-*.md` 核标识和键名，按用户的实际报错改，别瞎猜动作写法 |
| `check` 报一堆问题 | 草稿结构有问题，或者来料是别人导出的、检查器不认识它的写法 | 自己写的草稿：按 `code` 改；别人的文件：把检查结果当参考 |
| `identity` 错误 | 钥匙串里的身份损坏 | 脚本「证书」页最下面「重新生成签名身份」，然后重装、重新信任证书 |

# 文件结构

```text
shortcut-signer/
├── SKILL.md                         本文件
├── README.md                        安装说明
├── skill.json                       图标和颜色
├── schema.json                      sign.ts 的参数 schema
├── scripts/
│   ├── sign.ts                      调用入口，只接线：Script.queryParameters → router → Script.exit
│   ├── router.ts                    路由：check 留在本地，status / sign 才用 Script.run 交给「快捷指令签名」脚本
│   └── localCheck.ts                本地检查（check）：读文件 → 读 plist → 检查器 → 整形
├── vendor/                          和脚本里同名文件逐字节相同的副本（检查器及其依赖），改动要先改脚本那边再复制过来
│   ├── core/                        bytes / plist / check / read / report / names
│   └── kit/                         sources
├── templates/                       能直接签名导入的完整骨架，说明见 references/recipes.md
│   ├── blank.plist                  空白骨架（一个「显示提示」动作），真机验证过
│   ├── ask-and-notify.plist         询问输入 → 通知
│   ├── menu.plist                   菜单
│   ├── if-clipboard.plist           如果 … 否则（按剪贴板有没有内容）
│   ├── http-json.plist              请求接口 → 取字段 → 通知
│   ├── replace-text.plist           询问输入 → 替换文本 → 通知
│   ├── share-text.plist             出现在分享面板里，只收文字 → 通知
│   └── text-to-result.plist         文本 → 显示结果
├── references/
│   ├── actions.md                   动作索引、证据标签、按任务找动作
│   ├── actions-io.md                输入输出、网络、系统类动作
│   ├── actions-text.md              文本类动作
│   ├── actions-data.md              变量与数据类动作
│   ├── actions-flow.md              控制流与流程类动作
│   ├── values.md                    参数值的写法：变量、字典、条件、数字、给输出起名
│   ├── recipes.md                   模板配方：拿哪份改、怎么改
│   ├── patterns.md                  结构规则（动作、控制流）和检查器错误码对照
│   └── scripting-intents.md         Scripting 自己的 10 个动作（App Intent）的观察记录和写法
└── views/
    └── SignedShortcutView.tsx       聊天里的「导入」卡片
```
