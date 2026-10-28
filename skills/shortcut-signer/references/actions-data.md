# 变量与数据类动作

证据标签（真机 / 样本 / 公开）的含义见 `actions.md`；参数值怎么写见 `values.md`。下面每个动作的「样本」后面写的是在 24 个真实样本里见到的个数。

## `is.workflow.actions.setvariable` — 设定变量

- 证据：**样本**（10 个快捷指令、46 处）
- 用途：把一个值存进有名字的变量；后面用 `Variable` 引用（`values.md` 第四节）按名字取出来。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFVariableName` | 文本 | 变量名；引用处的 `VariableName` 要写成同一个名字 |
| `WFInput` | 单个变量（30 处是动作输出，7 处是「快捷指令输入」），或文本常量（7 处） | 变量的值 |

设定变量**没有输出，样本里 46 处一个 `UUID` 都没有**，不用写。

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.setvariable</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>WFInput</key>
		<dict>
			<key>Value</key>
			<dict>
				<key>OutputName</key>
				<string>文本</string>
				<key>OutputUUID</key>
				<string>A1111111-1111-4111-8111-111111111111</string>
				<key>Type</key>
				<string>ActionOutput</string>
			</dict>
			<key>WFSerializationType</key>
			<string>WFTextTokenAttachment</string>
		</dict>
		<key>WFVariableName</key>
		<string>名字</string>
	</dict>
</dict>
```

## `is.workflow.actions.getvariable` — 获取变量

- 证据：**样本**（1 个快捷指令、3 处，写法单薄）
- 用途：取出一个变量的值，作为这一步的输出。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFVariable` | 单个变量 | 要取的变量。样本里 3 处都是动作输出的引用；取有名字的变量应该写 `Variable` 令牌，但样本里没有这种写法 |

## `is.workflow.actions.list` — 列表

- 证据：**样本**（1 处）
- 用途：造一个列表。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFItems` | 文本数组：`<array><string>甲</string><string>乙</string></array>` | 列表项。样本里项都是纯文本；项里放变量的写法样本里没有 |
| `UUID` | UUID | |

## `is.workflow.actions.getitemfromlist` — 从列表中获取项目

- 证据：**样本**（1 个快捷指令、7 处）

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 单个变量 | 列表（5 处动作输出、2 处命名变量） |
| `WFItemSpecifier` | 文本，样本里是 `Item At Index`；公开资料里全部取值是 `First Item`、`Last Item`、`Random Item`、`Item At Index`、`Items in Range` | 取哪一项 |
| `WFItemIndex` | 单个变量（样本里的那一处是变量） | `WFItemSpecifier` 是 `Item At Index` 时，第几项（序号从几开始、能不能直接写常数，样本里没有，没核对） |
| `WFItemRangeStart` / `WFItemRangeEnd`（公开） | 整数 | `WFItemSpecifier` 是 `Items in Range` 时，起止的项 |
| `UUID` | UUID | |

没写 `WFItemSpecifier` 的 6 处就是默认取法（样本里默认的输出名是「来自列表的项目」）。除 `Item At Index` 外的取值是公开资料（Apple 的参数表）里的，样本里没有；出处：A（https://github.com/viticci/shortcuts-playground-plugin ，见 `actions.md` 的「出处」）。

## `is.workflow.actions.count` — 计数

- 证据：**样本**（1 处）

| 参数 | 值 | 说明 |
|---|---|---|
| `Input` | 单个变量 | 要数的东西（**键名是 `Input`，不是 `WFInput`**） |
| `WFCountType`（公开） | 文本：`Items`（项目）、`Characters`（字符）、`Words`（词）、`Sentences`（句）、`Lines`（行） | 数什么 |
| `UUID` | UUID | |

样本里没写计数类型，用的是默认（按项目数），输出的默认名是「计数」。`WFCountType` 是公开资料（Apple 的参数表）里的，出处：A（https://github.com/viticci/shortcuts-playground-plugin ，见 `actions.md` 的「出处」）。

## `is.workflow.actions.math` — 计算

- 证据：**样本**（1 个快捷指令、2 处）

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 单个变量 | 左边的数 |
| `WFMathOperation` | 文本，样本里见过 `+`、`-`；公开资料里还有 `×`、`÷`（Apple 的参数表，出处：A https://github.com/viticci/shortcuts-playground-plugin ） | 运算 |
| `WFMathOperand` | **文本**（样本里是 `<string>1</string>`） | 右边的数 |
| `UUID` | UUID | 输出的默认名样本里是「计算结果」 |

## `is.workflow.actions.dictionary` — 词典

- 证据：**样本**（1 处）
- 用途：造一个词典（键值对），后面用 `getvalueforkey` 取值。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFItems` | `WFDictionaryFieldValue`：每项 = 键 + 值类型 + 值 | 写法和 `WFItemType` 各取值见 `values.md` 第八节 |
| `UUID` | UUID | 输出的默认名样本里是「词典」 |

## `is.workflow.actions.getvalueforkey` — 获取词典值

- 证据：**样本**（9 个快捷指令、27 处）
- 用途：从词典（常见的是「获取 URL 内容」解析出来的 JSON）里按键名取值。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 单个变量 | 词典（样本里 24 处是动作输出的引用） |
| `WFDictionaryKey` | 文本 | 键名 |
| `WFGetDictionaryValueType`（公开） | 文本：`Value`（取值，默认）、`All Keys`（所有键）、`All Values`（所有值） | 取什么；样本里 27 处都没写，用的是默认的取值 |
| `CustomOutputName` | 文本 | 输出的名字（样本里 27 处都起了名） |
| `UUID` | UUID | 24 处写了，要被引用就必须写 |

`WFGetDictionaryValueType` 的出处：A + B（见 `actions.md` 的「出处」；A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，44 个仓库）。

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.getvalueforkey</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>CustomOutputName</key>
		<string>名称</string>
		<key>UUID</key>
		<string>C3333333-3333-4333-8333-333333333333</string>
		<key>WFDictionaryKey</key>
		<string>name</string>
		<key>WFInput</key>
		<dict>
			<key>Value</key>
			<dict>
				<key>OutputName</key>
				<string>响应</string>
				<key>OutputUUID</key>
				<string>B2222222-2222-4222-8222-222222222222</string>
				<key>Type</key>
				<string>ActionOutput</string>
			</dict>
			<key>WFSerializationType</key>
			<string>WFTextTokenAttachment</string>
		</dict>
	</dict>
</dict>
```

## 更多变量与数据类动作（公开级）

以下几个样本里没有，是靠公开资料核对的（「公开」，出处写在每个条目里；A / B / C 各指什么见 `actions.md` 的「出处」）。**没在真机上验证过**，用了要告诉用户，导入后先试跑。

### `is.workflow.actions.number` — 数字

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，27 个仓库；C：https://github.com/electrikmilk/cherri 、https://github.com/a2/swift-shortcuts）
- 用途：放一个数字，输出它。
- 参数：`WFNumberActionNumber`，数字（真实导出里数字和写成字符串的数字两种都有，也可以是变量引用）；输出要被引用时写 `UUID`，最好加 `CustomOutputName`。

### `is.workflow.actions.appendvariable` — 添加到变量

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，36 个仓库；C：https://github.com/electrikmilk/cherri ）
- 用途：把一个值加到一个已有的变量里（变量是列表时就是追加一项）。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFVariableName` | 文本 | 变量名 |
| `WFInput` | 单个变量 | 要加进去的值 |

### `is.workflow.actions.detect.dictionary` — 从输入获取词典

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，49 个仓库；C：https://github.com/electrikmilk/cherri ）
- 用途：把输入（比如「获取 URL 内容」的响应）解析成词典。只有一个参数：`WFInput`（单个变量）；输出要被引用时写 `UUID`。

### `is.workflow.actions.setvalueforkey` — 设置词典值

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，20 个仓库；C：https://github.com/electrikmilk/cherri ）
- 用途：给词典里的一个键设一个值，输出改好的词典。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFDictionary` | 单个变量 | 要改的词典 |
| `WFDictionaryKey` | 文本 | 键名 |
| `WFDictionaryValue` | 文本 | 值（文本以外的类型的写法没核对） |

### `is.workflow.actions.date` — 日期

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，26 个仓库；C：https://github.com/electrikmilk/cherri 、https://github.com/joshfarrant/shortcuts-js）
- 用途：取当前日期，或者指定一个日期，输出一个日期。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFDateActionMode` | 文本：`Current Date`（当前日期）或 `Specified Date`（指定日期） | 哪种 |
| `WFDateActionDate` | 文本或带变量的文本，比如 `Today` | `Specified Date` 时的日期 |

### `is.workflow.actions.format.date` — 格式化日期

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令；C：https://github.com/electrikmilk/cherri 、https://github.com/joshfarrant/shortcuts-js）
- 用途：把一个日期变成一段文本。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFDate` | 单个变量或带变量的文本 | 要格式化的日期 |
| `WFDateFormatStyle` | 文本：`None`、`Short`、`Medium`、`Long`、`Relative`、`RFC 2822`、`ISO 8601`、`Custom` | 日期的格式 |
| `WFTimeFormatStyle` | 文本：`None`、`Short`、`Medium`、`Long`、`Relative` | 时间的格式 |
| `WFDateFormat` | 文本，比如 `yyyy-MM-dd HH:mm` | `WFDateFormatStyle` 是 `Custom` 时的格式串 |
| `WFISO8601IncludeTime` | 布尔 | `ISO 8601` 时要不要带时间 |
| `WFRelativeDateFormatStyle` | 文本：`Short`、`Medium`、`Long` | `Relative` 格式的风格（核心键之外，这个键只在公开仓库里的 1 个例子里见过，把握中等） |
