# 写快捷指令草稿：结构规则和错误码

这份只讲**结构**：一个动作长什么样、怎么引用上一个动作的结果、控制流怎么配对，以及检查器的错误码。检查器（`check` 操作）查的就是这些。
有哪些动作、每个动作有哪些参数见 `actions.md`；参数的值怎么写见 `values.md`。

**可信度要说清楚：** 这些规则是从用户之前的 shortcut-skill 的检查器和样例整理来的，检查器会按它们逐条核对。它们拿 24 个 Apple 签名的真实快捷指令验过：控制流分组、变量引用的范围和占位符、App Intent 描述这几条规则在真实文件上一个错都没报，说明方向没错（这是「真实文件不会被判有错」的证据，不是「你写的这份能运行」的证据）。但**导入后能不能运行没有在真机上验证过**（本技能里真机验证过的只有 `templates/blank.plist` 里那一个「显示提示」动作）。用了这里的写法，导入后一定让用户先试跑，别声称一定能用。

## 零、顶层字段

真实快捷指令的顶层有这 12 个键：`WFWorkflowActions`、`WFWorkflowClientVersion`、`WFWorkflowMinimumClientVersion`、`WFWorkflowMinimumClientVersionString`、`WFWorkflowIcon`、`WFWorkflowImportQuestions`、`WFWorkflowTypes`、`WFWorkflowInputContentItemClasses`、`WFWorkflowOutputContentItemClasses`、`WFWorkflowHasOutputFallback`、`WFWorkflowHasShortcutInputVariables`、`WFQuickActionSurfaces`。**没有 `WFWorkflowName`**：快捷指令的名字在文件名里。

写草稿时**从 `templates/` 里的骨架开始，别删这些顶层键**，只改 `WFWorkflowActions`。骨架里多带了一个 `WFWorkflowName`（签出的文件就叫这个名字；不写的话，签名时用草稿的文件名）。检查器对没有名字只给警告 `missing_name`，因为真实导出的文件本来就没有它。

样本里这几个顶层键的取值（含义是按快捷指令设置里对应的开关理解的，没逐个验证；要做成分享面板里能用的，看 `recipes.md`）：

| 键 | 样本里见过 | 大意 |
|---|---|---|
| `WFWorkflowTypes` | `Watch`、`ActionExtension`、`WFWorkflowTypeShowInSearch` | 在手表上用 / 出现在分享面板里 / 在搜索里显示 |
| `WFWorkflowInputContentItemClasses` | `[WFStringContentItem]`（只收文字）或一长串（17 / 19 种） | 收哪些类型的输入 |
| `WFWorkflowHasShortcutInputVariables` | `true` / `false` | 用了「快捷指令输入」就是 `true` |
| `WFWorkflowMinimumClientVersion` / `…String` | `900`（16 个）、`3010`、`5023` | 最低要求的快捷指令版本，两个键写同一个数（一个整数、一个字符串） |
| `WFWorkflowClientVersion` | `"4407"`（20 个）、`"4610"` | 生成这份文件的快捷指令版本 |
| `WFWorkflowIcon` | `WFWorkflowIconStartColor`（整数颜色值）+ `WFWorkflowIconGlyphNumber`（字形编号，`61440` 最常见） | 图标。**别自己编**：颜色值和字形编号对应哪个图标没核对，沿用模板里的 |

## 一、一个动作

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.gettext</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>UUID</key>
		<string>A1111111-1111-4111-8111-111111111111</string>
		<key>WFTextActionText</key>
		<string>你好</string>
	</dict>
</dict>
```

- `WFWorkflowActionIdentifier`：动作标识，非空字符串。
- `WFWorkflowActionParameters`：参数字典，没有参数也要写空字典 `<dict/>`。
- `UUID`（在参数字典里）：**这个动作自己的编号**。别的动作要引用它的输出，就靠它：**输出会被引用的动作必须有**；输出没人引用的可以没有（24 个真实样本里 558 个动作有 254 个没有 UUID）。没有 UUID 的动作检查器会给 `missing_uuid` 警告，注释动作 `is.workflow.actions.comment` 不警告。警告只是提醒你确认一下，不是错误；真正的错误是别的动作引用了一个不存在的 UUID（`unknown_output_uuid`）。
- UUID 的形状：8-4-4-4-12 位十六进制，**第三段以 1–5 开头、第四段以 8 / 9 / A / B 开头**（Shortcuts 自己生成的是版本 4，比如 `A1111111-1111-4111-8111-111111111111`）。同一份快捷指令里不能重复。写新的就按这个形状编，别用 `11111111-1111-1111-1111-111111111111` 这种（第四段以 1 开头，不合格）。

## 二、引用上一个动作的结果（变量）

要把上一步的结果放进某个参数里，有两种写法：**带变量的文本**（`WFTextTokenString`：文字里夹变量）和**单个变量**（`WFTextTokenAttachment`：参数整个就是一个变量）。完整的写法、变量引用里各种 `Type`、`Aggrandizements`、怎么给输出起名，都在 `values.md`，这里只列检查器核对的几条：

- 带变量的文本里，`string` 用**占位符 U+FFFC**（对象替换字符）表示「这里放变量」。XML 里写成 `&#xFFFC;`（别直接粘贴那个看不见的字符，复制时容易丢）。文字和变量可以混排，比如 `前缀&#xFFFC;后缀`。
- `attachmentsByRange` 的键是 `{起点, 长度}`：起点是占位符在 `string` 里的**下标**（从 0 数，按 UTF-16 码元；中文、字母都算 1，emoji 算 2），长度写 1。`前缀&#xFFFC;后缀` 里占位符在下标 2，键就是 `{2, 1}`。
- 键的范围必须落在文本里，并且**盖住占位符**。范围对不上，导入后变量会错位或丢失。
- `Type` 是 `ActionOutput` 时必须有 `OutputUUID`，它要等于**前面某个动作**的 `UUID`；`OutputName` 写那个输出的名字，不要留空（最稳的做法是给那个动作写 `CustomOutputName`，引用处写同一个名字，见 `values.md` 第六节）。
- 整个参数就是一个变量（没有别的文字）时，也可以用「单个变量」写法：`WFSerializationType` 是 `WFTextTokenAttachment`，`Value` 里直接放 `{Type, OutputUUID, OutputName}`，不需要 `string` 和 `attachmentsByRange`。
- 变量引用的类型有 `ActionOutput`、`Variable`、`ExtensionInput`、`Clipboard`、`AskEachTime`（样本里见过的）以及检查器认得的 `Ask`、`CurrentDate`；检查器**不会校验这些类型的其余字段**，没有真实样例就别手写（`values.md` 第四节）。

## 三、最小的动作链：文本 → 显示结果

`templates/text-to-result.plist` 就是这条链：

```text
is.workflow.actions.gettext（有 UUID）→ is.workflow.actions.showresult（用 ActionOutput 引用上一步）
```

- 输出会被引用的动作（这里的 `gettext`）在参数里写 `UUID`；
- `showresult` 的 `Text` 用上面「带附件的文本」引用它；
- 写完先 `check`，再 `sign`。

这份模板的顶层字段沿用了真机验证过的骨架，但两个动作的写法**没在真机上跑过**，导入后要先试跑。

## 四、控制流（如果 / 重复 / 从菜单选取这一类）

这类动作成组出现：同一组的每个动作，参数里有同一个 `GroupingIdentifier`（一个 UUID），再用 `WFControlFlowMode` 标出自己的位置：

| `WFControlFlowMode` | 含义 |
|---|---|
| `0` | 这一组的开始 |
| `1` | 中间（比如「否则」、菜单的每个分支） |
| `2` | 这一组的结束 |

规则（检查器会核对）：

- 同一组**正好一个**开始（0）和**一个**结束（2）；
- 顺序必须是 `0`，然后零个或多个 `1`，最后 `2`；
- 每个动作都要有 `GroupingIdentifier`，模式只能是 0、1、2。

这里只讲分组配对。**各个控制流动作自己的参数**（「如果」的条件怎么写、菜单项怎么对应、重复几次……）见 `actions-flow.md`，那里的写法来自真实样本；样本里没有的参数别凭记忆写，请用户在快捷指令 App 里做一个导出来当参照。

## 五、检查器能查什么、不能查什么

**查：** plist 外层是字典；`WFWorkflowActions` 是数组；每个动作有标识和参数字典；系统动作的标识在不在知识库里（不在只给警告 `unknown_action`）；动作 UUID 的形状和唯一性；变量引用能对上某个动作的 UUID；`attachmentsByRange` 的键写法、范围、占位符；控制流分组；App Intent 动作的描述自洽。

**不保证：** 导入一定成功；动作一定能运行；**动作的参数键名对不对**（只核对标识，键名要自己对着 `actions-*.md` 核）；第三方 App Intent 的真实序列化；变量的类型和接收它的参数是否匹配；Shortcuts 在不同系统版本上的兼容性。**检查通过只说明「结构上没发现问题」。**

## 六、错误码对照

| 错误码 | 意思 | 怎么改 |
|---|---|---|
| `unreadable` | 文件读不了或不是 plist（读文件那一步给的，不是检查器规则）；本地检查还不收已签名的 `.shortcut` | 看 message：路径不对、写成了 JSON、包了 Markdown 围栏……；已签名的文件不用检查，直接 `sign` |
| `root_not_dict` | 顶层不是字典 | 顶层写 `<dict>` |
| `missing_actions` | 没有 `WFWorkflowActions` 数组 | 补上，没有动作也要是 `<array/>` |
| `action_not_dict` | 动作不是字典 | 每个动作写成 `<dict>` |
| `missing_action_identifier` | 动作没有标识 | 补 `WFWorkflowActionIdentifier` |
| `missing_action_parameters` | 动作没有参数字典 | 补 `WFWorkflowActionParameters`（可以是空字典） |
| `invalid_uuid` | UUID 形状不对 | 按第一节的形状重编 |
| `duplicate_uuid` | UUID 重复 | 每个动作用不同的 |
| `control_missing_group` | 控制流动作没有 `GroupingIdentifier` | 同一组用同一个 UUID |
| `control_invalid_mode` | `WFControlFlowMode` 不是 0 / 1 / 2 | 改成整数 0、1 或 2 |
| `control_group_unbalanced` | 一组里开始或结束不是正好一个 | 补齐或删掉多余的 |
| `control_group_order` | 顺序不是 0 → 若干个 1 → 2 | 调整动作顺序 |
| `intent_descriptor_mismatch` | App Intent 动作的标识和描述对不上 | 标识要等于 `BundleIdentifier.AppIntentIdentifier` |
| `scripting_descriptor_invalid` | Scripting 的动作缺观察到的 Bundle / Team 标识 | 见 `scripting-intents.md` |
| `invalid_output_token` | 变量引用缺 `OutputUUID`，或附件不是字典 | 补 `OutputUUID` |
| `missing_token_type` | 变量引用没有 `Type` | 补 `Type`（比如 `ActionOutput`） |
| `invalid_range` | `attachmentsByRange` 的键写法不对 | 写成 `{起点, 长度}` |
| `range_out_of_bounds` | 范围超出了文本长度 | 起点 + 长度不能超过 `string` 的长度 |
| `range_missing_placeholder` | 范围没盖住占位符 | 把键改成 `{占位符的下标, 1}` |
| `unknown_output_uuid` | 引用的 `OutputUUID` 找不到对应动作 | 改成前面某个动作的 `UUID`，或补上那个动作 |

警告（不影响 `ok`，除非 `strict`）：

- `unknown_action`：**系统动作（`is.workflow.actions.` 开头）的标识不在知识库里。自己写的草稿遇到这条要当回事**：多半是拼错了（比如 `notificaton`）或者凭记忆编的，对着 `actions.md` 改成登记过的动作；用户给的现成文件里的别的系统动作可以不管。第三方 App 的动作（`com.` 开头）不报这条。
- `missing_name`：没有 `WFWorkflowName`。真实导出的快捷指令本来就没有，签名时用文件名；写草稿时带上名字更清楚。
- `missing_uuid`：动作没有 UUID。输出没人引用的可以忽略；真实文件里将近一半的动作都没有。
- `missing_output_name`：引用没写输出名。
- `unknown_token_type`：不认识的变量类型，检查器没有校验它。

## 七、范围错了怎么修

`range_out_of_bounds` 和 `range_missing_placeholder` 的修法是同一个：数出占位符在 `string` 里的下标 `n`（`&#xFFFC;` 之前有几个字符就是几，emoji 算 2），把键改成 `{n, 1}`。一个文本里有多个变量，就每个占位符各一个键。
