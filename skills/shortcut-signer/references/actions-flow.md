# 控制流与流程类动作

证据标签（真机 / 样本 / 公开）的含义见 `actions.md`；参数值怎么写见 `values.md`。下面每个动作的「样本」后面写的是在 24 个真实样本里见到的个数。

## 成组的动作

「如果」「重复」「从菜单中选取」是成组出现的：同一组的每个动作带同一个 `GroupingIdentifier`（一个 UUID），用 `WFControlFlowMode` 标出位置：`0` 开始、`1` 中间、`2` 结束。这一组要做的事，就放在对应的开始 / 中间 / 结束动作**之间**。

样本里各种组的形状：

| 组 | 模式序列 | 样本里 |
|---|---|---|
| 如果（有「否则」） | 0 1 2 | 37 组 |
| 如果（没有「否则」） | 0 2 | 5 组 |
| 从菜单中选取 | 0，每个菜单项一个 1，2（比如 0 1 1 2 是两个菜单项） | 14 组（2 到 6 个菜单项） |
| 重复 N 次 | 0 2（没有中间） | 1 组 |

每组要有且只有一个开始、一个结束，顺序是 0 → 若干个 1 → 2（检查器会核对，见 `patterns.md` 第四节）。样本里没有、但公开资料里有的「对每个项目重复」（`repeat.each`）形状和「重复」一样（0 → 2，没有中间），见本文件最后。

## `is.workflow.actions.conditional` — 如果

- 证据：**样本**（14 个快捷指令、42 组共 121 个动作）
- 用途：按条件分支：「如果 … 否则 … 结束如果」。

**开始动作**（`WFControlFlowMode` = 0）：

| 参数 | 值 | 说明 |
|---|---|---|
| `GroupingIdentifier` | UUID | 这一组共用的编号 |
| `WFControlFlowMode` | 整数 `0` | 开始 |
| `WFInput` | **`Type` = `Variable` 的包装，里面再放一个单个变量**（见下面的例子） | 被判断的东西。样本里 30 个单条件的开始动作全是这个写法 |
| `WFCondition` | 整数条件码 | 见下表 |
| `WFConditionalActionString` | 文本 | 文本比较时的比较值 |
| `WFNumberValue` | **文本**（写成字符串，比如 `<string>1</string>`） | 数字比较时的比较值 |
| `WFConditions` | 多个条件时用，写法见 `values.md` 第九节 | 有它就不写 `WFInput` 和 `WFCondition`（样本里 12 个多条件的开始动作都没有这两个键） |
| `UUID` | UUID | 样本里 42 个开始动作有 9 个写了，可以不写 |

**中间动作**（模式 1，「否则」）：只有 `GroupingIdentifier` 和 `WFControlFlowMode`（样本里 37 个有 5 个另外写了 `UUID`）。

**结束动作**（模式 2）：`GroupingIdentifier`、`WFControlFlowMode`，以及 `UUID`（样本里 42 个有 31 个写了）。**别的动作要引用「如果的结果」，就引用结束动作的 `UUID`**（`values.md` 第七节）。

`WFCondition` 条件码（样本里单条件的开始动作一共 30 个，其中 22 个是数字码）：

| `WFCondition` | 条件 | 比较值 | 证据 |
|---|---|---|---|
| `100` | 有任何值 | 不要 | 样本（13 处） |
| `101` | 没有任何值 | 不要 | 样本（2 处） |
| `4` | 是（文本相等） | `WFConditionalActionString` | 样本（3 处） |
| `5` | 不是 | `WFConditionalActionString`（样本里那 1 处带的是 `WFNumberValue`，数字也能用） | 样本（1 处） |
| `2` | 大于 | `WFNumberValue` | 样本（2 处带数字值；「大于」这个含义来自公开资料） |
| `3` | 大于等于 | `WFNumberValue` | 样本（1 处带数字值；含义同上） |
| `0` | 小于 | `WFNumberValue` | （公开） |
| `1` | 小于等于 | `WFNumberValue` | （公开） |
| `8` | 以……开头 | `WFConditionalActionString` | （公开） |
| `9` | 以……结尾 | `WFConditionalActionString` | （公开） |
| `99` | 包含 | `WFConditionalActionString` | （公开） |
| `999` | 不包含 | `WFConditionalActionString` | （公开） |
| `1003` | 介于（数字） | `WFNumberValue`（下限，字符串）+ `WFAnotherNumber`（上限；资料里写的是变量引用，常量行不行没核对） | （公开） |

- **别搞混**：`0` 是「小于」，不是「等于」；没有数字的「等于」码，要比较两个数相等，用文本相等的 `4`，或者「大于等于」和「小于等于」两个条件一起用（`values.md` 第九节的多条件）。`2` 和 `3` 只差一个「等于」，容易写反。
- 样本里还有早期的字符串写法：`WFCondition` 直接写文字 `Has Any Value`（3 处）、`Is`（5 处），从用法看和数字码 `100`、`4` 是同一个意思；**写新的一律用数字码**。
- 公开级条件码的出处：Apple ToolKit 的数据 https://github.com/viticci/shortcuts-playground-plugin（MIT，`claude/skills/shortcuts-playground/CONTROL_FLOW.md` 里有「对着 Apple 自己做的样本核过」的码表）；Cherri 的动作定义 https://github.com/electrikmilk/cherri；快捷指令里的 JS 反编译器 Shortcut Source Tool 的码表。三处的 0 / 1 / 2 / 3 / 4 / 5 / 8 / 9 / 99 / 100 / 101 / 999 完全一致；`1003` 在公开仓库里真实导出的快捷指令里也见过用法。

一个完整的组（「如果剪贴板有内容……否则……」），三个动作缺一不可：

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.conditional</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>GroupingIdentifier</key>
		<string>D4444444-4444-4444-8444-444444444444</string>
		<key>WFCondition</key>
		<integer>100</integer>
		<key>WFControlFlowMode</key>
		<integer>0</integer>
		<key>WFInput</key>
		<dict>
			<key>Type</key>
			<string>Variable</string>
			<key>Variable</key>
			<dict>
				<key>Value</key>
				<dict>
					<key>OutputName</key>
					<string>剪贴板</string>
					<key>OutputUUID</key>
					<string>A1111111-1111-4111-8111-111111111111</string>
					<key>Type</key>
					<string>ActionOutput</string>
				</dict>
				<key>WFSerializationType</key>
				<string>WFTextTokenAttachment</string>
			</dict>
		</dict>
	</dict>
</dict>
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.conditional</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>GroupingIdentifier</key>
		<string>D4444444-4444-4444-8444-444444444444</string>
		<key>WFControlFlowMode</key>
		<integer>1</integer>
	</dict>
</dict>
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.conditional</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>GroupingIdentifier</key>
		<string>D4444444-4444-4444-8444-444444444444</string>
		<key>UUID</key>
		<string>E5555555-5555-4555-8555-555555555555</string>
		<key>WFControlFlowMode</key>
		<integer>2</integer>
	</dict>
</dict>
```

上面是三个动作连着写；真正用的时候，「有内容时要做的事」放在第一个和第二个之间，「没内容时要做的事」放在第二个和第三个之间（完整例子见 `templates/if-clipboard.plist`）。

## `is.workflow.actions.choosefrommenu` — 从菜单中选取

- 证据：**样本**（14 个快捷指令、14 组共 74 个动作）
- 用途：弹出菜单让用户选一项，只执行选中那一项下面的动作。

| 位置 | 参数 | 说明 |
|---|---|---|
| 开始（模式 0） | `GroupingIdentifier`、`WFControlFlowMode` = 0 | |
| 开始 | `WFMenuPrompt` | 提示语（文本） |
| 开始 | `WFMenuItems` | 菜单项：文本数组 |
| 开始 | `UUID` | 样本里 14 个有 10 个写了；不引用菜单结果就不用写 |
| 每个菜单项一个动作（模式 1） | `GroupingIdentifier`、`WFControlFlowMode` = 1、`WFMenuItemTitle` | 标题**要和 `WFMenuItems` 里的某一项一模一样，顺序也一样**（样本里 14 个菜单项数、标题、顺序全部一致） |
| 结束（模式 2） | `GroupingIdentifier`、`WFControlFlowMode` = 2 | 没有别的参数 |

某一项要做的事，放在它的模式 1 动作后面、下一个模式 1 或结束动作前面。引用「用户选了哪项」的写法样本里没有，**没有真实样例就别手写**。完整例子见 `templates/menu.plist`。

## `is.workflow.actions.repeat.count` — 重复

- 证据：**样本**（1 个快捷指令、1 组）
- 用途：把开始和结束之间的动作重复 N 次。没有中间动作（模式序列 0 → 2）。

| 位置 | 参数 | 说明 |
|---|---|---|
| 开始（模式 0） | `GroupingIdentifier`、`WFControlFlowMode` = 0、`WFRepeatCount` | 样本里 `WFRepeatCount` 是一个变量引用；**写成常数整数行不行，样本里没有，没验证** |
| 结束（模式 2） | `GroupingIdentifier`、`WFControlFlowMode` = 2、`UUID` | 「重复结果」引用结束动作的 `UUID`（`values.md` 第七节） |

## `is.workflow.actions.delay` — 等待

- 证据：**样本**（21 个快捷指令、35 处）
- 用途：停几秒再继续。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFDelayTime` | 数字，单位秒（整数 32 处、小数 3 处） | 等多久 |
| `UUID` | UUID | 样本里 8 处写了，不用写 |

## `is.workflow.actions.comment` — 备注

- 证据：**样本**（23 个快捷指令、111 处）
- 用途：在快捷指令里写一句给人看的备注，不做任何事。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFCommentActionText` | 文本 | 备注内容 |
| `UUID` | UUID | 样本里 61 处写了，不用写（检查器对备注动作不报「没有 UUID」） |

## `is.workflow.actions.nothing` — 什么都不做

- 证据：**样本**（1 个快捷指令、5 处）
- 参数：只有（可选的）`UUID`。

## `is.workflow.actions.exit` — 停止这个快捷指令

- 证据：**样本**（1 处）
- 参数：没有（`WFWorkflowActionParameters` 写空字典 `<dict/>`）。运行到这里，整个快捷指令就停了。

## `is.workflow.actions.repeat.each` — 对每个项目重复

- 证据：**公开**
- 出处：公开仓库里真实导出的快捷指令，比如 https://github.com/huaminghuangtw/Shortcutomation、https://github.com/jimbrig/ios-shortcuts（几十个仓库里都有）；Cherri 的动作定义 https://github.com/electrikmilk/cherri；Viticci 整理的 Apple ToolKit 数据（https://github.com/viticci/shortcuts-playground-plugin）里说明了：「如果 / 重复 / 菜单」这几个控制流动作不在 ToolKit 的普通动作表里，是特殊处理的，所以参数只能看真实导出
- 用途：对一个列表里的每一项，把开始和结束之间的动作各做一遍。形状和 `repeat.count` 一样：只有开始（模式 0）和结束（模式 2），没有中间。

| 位置 | 参数 | 说明 |
|---|---|---|
| 开始（模式 0） | `GroupingIdentifier`、`WFControlFlowMode` = 0、`WFInput` | `WFInput` 是要遍历的列表（变量引用）；只写在开始动作上 |
| 结束（模式 2） | `GroupingIdentifier`、`WFControlFlowMode` = 2 | 要引用「重复结果」时，结束动作上写 `UUID`（Cherri 这样写；真实导出里没单独核对） |

循环体里怎么引用「当前这一项」（「重复项目」那个变量）的写法，这里没有核对过，**别手写**；需要时请用户做一个导出来当参照。

## `is.workflow.actions.output` — 停止并输出

- 证据：**公开**
- 出处：Apple ToolKit 的参数数据 https://github.com/viticci/shortcuts-playground-plugin（MIT，`data/toolkit-v78-first-party-parameter-keys.json` 和 `…enum-cases.json`）；公开仓库里真实导出的快捷指令（https://github.com/huaminghuangtw/Shortcutomation 等 16 个仓库里见过）；Cherri 的动作定义 https://github.com/electrikmilk/cherri
- 用途：停下整个快捷指令并把一个值作为输出交出去（给分享面板、给别的快捷指令用）。注意它**不是**「停止这个快捷指令」（`exit`，没有输出）。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFOutput` | 文本或单个变量 | 要输出的内容 |
| `WFNoOutputSurfaceBehavior` | 文本：`Copy to Clipboard`（没地方输出时复制到剪贴板）、`Respond`（回应）、`Do Nothing`（什么都不做） | 没有地方接收输出时怎么办；真实导出里见过前两种，没写时就是默认行为 |
| `WFResponse` | 文本 | `WFNoOutputSurfaceBehavior` 是 `Respond` 时要说的话 |
