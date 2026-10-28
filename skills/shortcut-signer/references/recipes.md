# 配方：想做 X，拿哪份模板改

`templates/` 里每份模板都是一个**完整的快捷指令**（顶层字段齐全），能直接过 `check`、能签名。用法：

1. 把模板复制到 `<工作区>/shortcuts/drafts/<名字>.plist`；
2. **只改** `WFWorkflowName` 和 `WFWorkflowActions` 里的值，别动顶层的其它键；
3. 加动作、换参数前，先到 `actions.md` 查动作、到 `values.md` 查值的写法；
4. 写完 `check`，再 `sign`，导入后先试跑。

模板里的动作都登记在 `actions.md` 里，绝大多数是「样本」级（只有 `blank.plist` 里的 `alert` 是「真机」，`text-to-result.plist` 里的 `showresult` 是「公开」级），但**每个组合都没在真机上跑过**（只有 `blank.plist` 里那一个 `alert` 在真机上验证过）。交付时照实说。

## 模板一览

| 模板 | 做什么 | 用到的动作 |
|---|---|---|
| `blank.plist` | 弹一个提示框，点「好」结束 | `alert` |
| `ask-and-notify.plist` | 问一句「你叫什么名字？」，把回答放进通知里 | `ask` → `notification` |
| `menu.plist` | 弹菜单，选「打招呼」或「说再见」，各发一条通知 | `choosefrommenu`（开始 / 两个菜单项 / 结束） + `notification` |
| `if-clipboard.plist` | 剪贴板有内容就把内容放进通知，否则提醒「是空的」 | `getclipboard` → `conditional`（开始 / 否则 / 结束） + `notification` |
| `http-json.plist` | 请求一个接口，取 JSON 里的 `name` 字段，放进通知 | `downloadurl` → `getvalueforkey` → `notification` |
| `replace-text.plist` | 问一段文字，把「旧」换成「新」，把结果放进通知 | `ask` → `text.replace` → `notification` |
| `share-text.plist` | **出现在分享面板里**，只收文字：把分享来的文字放进通知 | `setvariable`（值是「快捷指令输入」）→ `notification` |
| `text-to-result.plist` | 一段文本，显示成结果 | `gettext`（样本）→ `showresult`（**公开**级，样本里没有，见 `actions-io.md`） |

## 做成分享面板里能用的快捷指令

别的 App 的分享面板里要能选到它，靠顶层的几个字段（`share-text.plist` 就是这么写的；写法照样本里 10 个这样的快捷指令，其中 5 个跟这份一模一样的组合）：

- `WFWorkflowTypes` 里要有 `ActionExtension`（样本里 10 个分享面板类的快捷指令都有，且都同时有 `Watch`）；还见过 `WFWorkflowTypeShowInSearch`（在搜索里显示）。
- `WFWorkflowInputContentItemClasses`：它收哪些类型的内容。只收文字就是 `[WFStringContentItem]`（样本里 5 个）；不限制就列一长串（样本里 17 种或 19 种，照 `blank.plist` 里那串）。
- `WFWorkflowHasShortcutInputVariables`：用了「快捷指令输入」就写 `true`（样本里用了的 10 个有 9 个是 `true`；是不是必须没验证，照着写）。
- 在动作里用「快捷指令输入」：变量引用的 `Type` 写 `ExtensionInput`（`values.md` 第四节）；样本里最常见的写法是先 `setvariable` 存成一个名字，后面再用 `Variable` 引用（`share-text.plist` 就是这样）。

这些字段哪个对分享面板「必须」、哪个只是惯例，样本里分不出来，没在真机上验证过。

## 改模板时最容易错的地方

- **输出要被引用，就给那个动作写 `CustomOutputName` 和 `UUID`**，引用处的 `OutputName` 写同一个名字、`OutputUUID` 写那个 `UUID`（`values.md` 第六节）。模板里的 `A1111111-…`、`B2222222-…` 是示范用的编号，**加新动作要编新的、不能重复**（形状：8-4-4-4-12 位十六进制，第三段以 1–5 开头、第四段以 8 / 9 / A / B 开头）。
- **改了带变量的文本，要重新数 `attachmentsByRange` 的起点**：键 `{起点, 长度}` 的起点是占位符在文字里的下标（`values.md` 第二节）。比如 `名称：&#xFFFC;` 里「名称：」3 个字，占位符在下标 3，键就是 `{3, 1}`。
- **控制流（菜单、如果、重复）的几个动作要成组**：同一个 `GroupingIdentifier`，模式 0 → 若干个 1 → 2，一个都不能少；菜单项的 `WFMenuItemTitle` 要和开始动作的 `WFMenuItems` 一一对上（`actions-flow.md`）。每组的 `GroupingIdentifier` 自己编一个新的，别和别的组重复。
- **「如果」的 `WFInput` 要包一层**（`Type` = `Variable`），别当普通参数写（`actions-flow.md`）。
- `http-json.plist` 里的地址 `https://example.com/api` 和键名 `name` 只是占位，**要换成真的**，不然运行会失败。

## 怎么加一个菜单项

1. 开始动作的 `WFMenuItems` 数组里加一个字符串；
2. 在合适的位置（上一个菜单项要做的事之后、结束动作之前）加一个模式 1 的动作：同样的 `GroupingIdentifier`，`WFMenuItemTitle` 写成刚加的那个字符串；
3. 这一项要做的事，写在它后面。

## 怎么把「如果」换成别的条件

只改开始动作的 `WFCondition`（条件码表见 `actions-flow.md`）和需要的比较值（`WFConditionalActionString` 或 `WFNumberValue`）；`WFInput` 换成要判断的变量。`有任何值`（`100`）、`没有任何值`（`101`）不需要比较值。

## 目录里没有的动作怎么办

别写。告诉用户这个动作没核对过，请他在快捷指令 App 里手动做出来、分享给你看，或者换成目录里的动作拼。
