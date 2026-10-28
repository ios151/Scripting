# 参数值的写法：变量、字典、条件、数字

这份讲「**一个参数的值怎么写**」。有哪些动作、每个动作有哪些参数见 `actions.md`；动作和控制流的结构规则、检查器的错误码见 `patterns.md`。

**可信度：** 下面的形状都是从 24 个真实的、Apple 签名的快捷指令里读出来的（写「样本里 N 处」的数字也是在这 24 个里数的），写法照抄真实样本。但你写的这个组合没在真机上跑过，导入后要先试跑，别声称一定能用。样本里没有的写法，这里要么不写、要么明说「样本里没有」。

## 一、参数值有这几种写法

| 写法 | 长什么样 | 用在哪 |
|---|---|---|
| 常量 | `<string>文字</string>`、`<integer>3</integer>`、`<true/>` | 绝大多数文本、数字、开关参数都收常量 |
| 带变量的文本 | `WFSerializationType` = `WFTextTokenString`，里面是 `string` + `attachmentsByRange` | 文本里要夹变量 |
| 单个变量 | `WFSerializationType` = `WFTextTokenAttachment`，里面是一个变量引用 | 参数的值就是「某个变量」 |
| 字典内容 / 多条件 | `WFDictionaryFieldValue` / `WFContentPredicateTableTemplate` | 字典动作的内容、「如果」的多个条件 |

**文本类参数通常常量和变量两种写法都收**：样本里同一个键既有常量也有带变量的写法（比如 `WFNotificationActionBody`：10 处常量、8 处带变量；`WFTextActionText`：8 处常量、15 处带变量）。能用常量就用常量，最简单、最不容易写错。

只有「必须引用上一步结果」的地方才用变量。

## 二、带变量的文本（TokenString）

```xml
<key>WFNotificationActionBody</key>
<dict>
	<key>Value</key>
	<dict>
		<key>attachmentsByRange</key>
		<dict>
			<key>{3, 1}</key>
			<dict>
				<key>OutputName</key>
				<string>输入</string>
				<key>OutputUUID</key>
				<string>A1111111-1111-4111-8111-111111111111</string>
				<key>Type</key>
				<string>ActionOutput</string>
			</dict>
		</dict>
		<key>string</key>
		<string>你好，&#xFFFC;！</string>
	</dict>
	<key>WFSerializationType</key>
	<string>WFTextTokenString</string>
</dict>
```

- `string` 里用占位符 U+FFFC 表示「这里放变量」，XML 里写成 `&#xFFFC;`（别直接粘贴那个看不见的字符）。
- `attachmentsByRange` 的键是 `{起点, 长度}`：起点是占位符在 `string` 里的下标（从 0 数，按 UTF-16 码元：中文、字母算 1，emoji 算 2），长度写 1。上面「你好，」是 3 个字，占位符在下标 3，所以键是 `{3, 1}`。一个文本里有几个变量就写几个键。
- **没有变量时，`attachmentsByRange` 可以整个不写**（样本里字典的键、`WFConditionalActionString` 都有这样的写法，也见过写成空字典 `<dict/>` 的）。
- `string` 里没有占位符、却写了 `attachmentsByRange` 的键，检查器会报 `range_missing_placeholder`。

## 三、单个变量（TokenAttachment）

```xml
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
```

参数的值整个就是一个变量时用它（样本里 `WFInput`、`WFItemIndex`、`WFRepeatCount`、`WFVariable`、`Input`、`text` 这些键常见）。同一个键有时也写成「只含一个占位符的 TokenString」，两种写法在样本里都出现过（比如 `urlencode` 的 `WFInput`：7 处 TokenString、1 处 TokenAttachment）。

**有一个例外**：「如果」动作（`conditional`）的 `WFInput` 在 TokenAttachment 外面还包了一层，见 `actions-flow.md`。

## 四、变量引用里 `Value` 的几种内容

| `Type` | 内容 | 意思 | 样本里 |
|---|---|---|---|
| `ActionOutput` | `OutputUUID` + `OutputName` | 某个动作的输出（`OutputUUID` = 那个动作的 `UUID`） | 212 处 |
| `Variable` | `VariableName` | 用「设定变量」起了名字的变量 | 97 处（含包装用法） |
| `ExtensionInput` | 只有 `Type` | 「快捷指令输入」（从分享面板等传进来的内容） | 19 处 |
| `Clipboard` | 只有 `Type` | 剪贴板 | 1 处 |
| `AskEachTime` | 只有 `Type` | 「每次运行时询问」 | 1 处 |

- 用了「快捷指令输入」的快捷指令，样本里 10 个有 9 个把顶层的 `WFWorkflowHasShortcutInputVariables` 设成 `true`，且 10 个的顶层 `WFWorkflowTypes` 里都带 `ActionExtension`（分享面板里能选到它）。是不是必须这样没验证；写这类快捷指令时照着做（`recipes.md` 有「分享面板」一节，`templates/share-text.plist` 是现成的例子）。
- `ExtensionInput` 在样本里出现过三种容器：`setvariable` 的 `WFInput`（单个变量，7 处）、「如果」的 `WFInput` 包装里（9 处）、带变量的文本的 `attachmentsByRange` 里（3 处）。**最常见的做法是先 `setvariable` 存成一个名字，后面都用 `Variable` 引用它**。
- 任何一种引用后面都可以再带 `Aggrandizements`（见下一节）。

## 五、对变量再取内容（Aggrandizements）

变量后面可以再「取它的某个部分」，写在引用里的 `Aggrandizements` 数组里，每项一个字典。样本里见过三种：

| `Type` | 另一个键 | 意思 |
|---|---|---|
| `WFDictionaryValueVariableAggrandizement` | `DictionaryKey`：键名 | 取词典里这个键的值（9 处） |
| `WFCoercionVariableAggrandizement` | `CoercionItemClass`：`WFStringContentItem`（文本，9 处）或 `WFNumberContentItem`（数字，1 处） | 把变量当成这种类型 |
| `WFPropertyVariableAggrandizement` | `PropertyName`：属性名（见过 `Name`、`Is Connected`）；`Name` 那两处还带 `PropertyUserInfo` = `WFItemName` | 取变量的某个属性（4 处） |

```xml
<key>Value</key>
<dict>
	<key>Aggrandizements</key>
	<array>
		<dict>
			<key>DictionaryKey</key>
			<string>name</string>
			<key>Type</key>
			<string>WFDictionaryValueVariableAggrandizement</string>
		</dict>
	</array>
	<key>OutputName</key>
	<string>响应</string>
	<key>OutputUUID</key>
	<string>B2222222-2222-4222-8222-222222222222</string>
	<key>Type</key>
	<string>ActionOutput</string>
</dict>
```

要取 JSON 里的字段，更稳的做法是用「获取词典值」动作（`getvalueforkey`），不依赖这种内嵌写法。属性名是显示用的英文名，样本里只有两个，别凭记忆编别的。

## 六、给输出起名：`CustomOutputName`

别的动作引用某个动作的输出，**靠的是 `OutputUUID`（对上那个动作的 `UUID`）**，`OutputName` 是变量在编辑器里显示的名字。样本里有一处引用，写的名字和被引用动作的 `CustomOutputName` 对不上（引用里是旧名字）——这是 Shortcuts 自己导出的结果，说明它不强求两处名字一致、绑定靠的是 UUID；对不上时运行是不是一切正常，没验证。

**但默认名是本地化的**：样本里没起名的动作，引用里的名字要么是导出者系统语言的默认名（比如「文本」「词典」「如果的结果」「更新后的文本」），要么是英文的 `Output`；换种语言的设备上显示的名字会不一样。所以：

- **写草稿时，凡是输出要被引用的动作，都给它加 `CustomOutputName`**（`<key>CustomOutputName</key><string>响应</string>`），引用处的 `OutputName` 写同一个名字。样本里最规矩的写法就是这样（比如一个「获取 URL 内容」起名 `ParseJSON`，后面 24 处引用都写 `ParseJSON`）。
- 不想起名也行，但引用里的 `OutputName` 就不要瞎猜默认名；写成和动作的 `CustomOutputName` 一样最稳。

## 七、控制流的结果怎么引用

「如果」「重复」「从菜单中选取」是成组出现的动作（开始 / 中间 / 结束，见 `patterns.md` 第四节）。要引用它们的结果：

- **「如果」的结果、「重复」的结果：引用这一组里「结束」动作（`WFControlFlowMode` = 2）的 `UUID`**。样本里 9 处「如果的结果」、1 处「重复结果」，全都指向结束动作。所以要用结果，就给结束动作写 `UUID`。
- 「从菜单中选取」的 `UUID` 样本里写在开始动作（模式 0）上，但样本里没有谁引用它的结果；要引用菜单的选择结果，没有真实样例，别手写。

## 八、字典：`dictionary` 动作的 `WFItems`

```xml
<key>WFItems</key>
<dict>
	<key>Value</key>
	<dict>
		<key>WFDictionaryFieldValueItems</key>
		<array>
			<dict>
				<key>WFItemType</key>
				<integer>0</integer>
				<key>WFKey</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>string</key>
						<string>name</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenString</string>
				</dict>
				<key>WFValue</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>string</key>
						<string>示例</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenString</string>
				</dict>
			</dict>
		</array>
	</dict>
	<key>WFSerializationType</key>
	<string>WFDictionaryFieldValue</string>
</dict>
```

`WFItemType` 是这一项的值的类型，样本里见过三种：

| `WFItemType` | 值的类型 | `WFValue` 的写法 |
|---|---|---|
| `0` | 文本 | TokenString（上面这个例子） |
| `1` | 字典（嵌套） | `{ Value: { Value: { WFDictionaryFieldValueItems: [ …同样的项… ] , WFSerializationType: WFDictionaryFieldValue }, WFSerializationType: WFDictionaryFieldValue } }`：**外面包了两层** |
| `4` | 布尔 | `{ Value: <true/> 或 <false/>, WFSerializationType: WFNumberSubstitutableState }` |

公开资料（`https://github.com/joshfarrant/shortcuts-js` 的取值表）里还有 `2` 数组、`3` 数字、`5` 文件，这三种的 `WFValue` 写法样本里没有、各来源的例子也不一致，**别手写**；真要用，请用户做一个含这种项的词典、导出来当参照。

## 九、「如果」的多个条件：`WFConditions`

只有一个条件时，「如果」直接用 `WFCondition`（见 `actions-flow.md`）。有多个条件时改用 `WFConditions`（样本里 12 处），整个值是：

```xml
<key>WFConditions</key>
<dict>
	<key>Value</key>
	<dict>
		<key>WFActionParameterFilterPrefix</key>
		<integer>0</integer>
		<key>WFActionParameterFilterTemplates</key>
		<array>
			<dict>
				<key>WFCondition</key>
				<integer>101</integer>
				<key>WFInput</key>
				<dict>
					<key>Type</key>
					<string>Variable</string>
					<key>Variable</key>
					<dict>
						<key>Value</key>
						<dict>
							<key>Type</key>
							<string>Variable</string>
							<key>VariableName</key>
							<string>输入</string>
						</dict>
						<key>WFSerializationType</key>
						<string>WFTextTokenAttachment</string>
					</dict>
				</dict>
			</dict>
			<dict>
				<key>WFCondition</key>
				<integer>4</integer>
				<key>WFConditionalActionString</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>attachmentsByRange</key>
						<dict/>
						<key>string</key>
						<string>清除</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenString</string>
				</dict>
				<key>WFInput</key>
				<dict>
					<key>Type</key>
					<string>Variable</string>
					<key>Variable</key>
					<dict>
						<key>Value</key>
						<dict>
							<key>Type</key>
							<string>Variable</string>
							<key>VariableName</key>
							<string>输入</string>
						</dict>
						<key>WFSerializationType</key>
						<string>WFTextTokenAttachment</string>
					</dict>
				</dict>
			</dict>
		</array>
		<key>WFContentPredicateBoundedDate</key>
		<false/>
	</dict>
	<key>WFSerializationType</key>
	<string>WFContentPredicateTableTemplate</string>
</dict>
```

- 每个条件一项：`WFCondition`（数字码）+ `WFInput`（被判断的变量，**同样要包 `Type` = `Variable` 那一层**）+ 需要比较值时的 `WFConditionalActionString`（文本）或 `WFNumberValue`（数字，写成字符串）。
- `WFActionParameterFilterPrefix`：`0` 是**任一条件满足**（或），`1` 是**所有条件都满足**（且）。样本里只见过 `0`；`1` 的含义是公开资料里的（出处：Viticci 整理的说明 https://github.com/viticci/shortcuts-playground-plugin 的 `CONTROL_FLOW.md`，和 Cherri https://github.com/electrikmilk/cherri 一致）。
- 多条件时「如果」开始动作上就不再写 `WFInput` / `WFCondition`（样本里 12 个多条件的开始动作都没有这两个键）。

## 十、数字

- 整数写 `<integer>`（样本里 `WFDelayTime` 32 处是整数）；小数写 `<real>`（`WFDelayTime` 有 3 处是小数）。
- **有的数字参数在样本里是字符串**：比如「如果」的 `WFNumberValue` 写成 `<string>1</string>`，「计算」的 `WFMathOperand` 写成 `<string>1</string>`。照样本写：这两个键用字符串。
- 数字参数收变量时用 TokenAttachment（比如 `WFRepeatCount`、`WFItemIndex`）。
