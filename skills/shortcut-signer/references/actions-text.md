# 文本类动作

证据标签（真机 / 样本 / 公开）的含义见 `actions.md`；参数值怎么写（常量、变量、带变量的文本）见 `values.md`。下面每个动作的「样本」后面写的是在 24 个真实样本里见到的个数。

## `is.workflow.actions.gettext` — 文本

- 证据：**样本**（10 个快捷指令、26 处）
- 用途：放一段文本，输出它；文本里可以夹变量。常用来拼字符串、做后面动作的输入。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFTextActionText` | 文本（常量 8 处 / 带变量 15 处） | 文本内容 |
| `CustomOutputName` | 文本 | 输出的名字，要被引用时起一个（`values.md` 第六节） |
| `UUID` | UUID | 输出要被别的动作引用时必须有 |

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.gettext</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>CustomOutputName</key>
		<string>文本</string>
		<key>UUID</key>
		<string>A1111111-1111-4111-8111-111111111111</string>
		<key>WFTextActionText</key>
		<string>你好</string>
	</dict>
</dict>
```

## `is.workflow.actions.text.replace` — 替换文本

- 证据：**样本**（只在 1 个快捷指令里见过，15 处）
- 用途：把输入文本里的某段换成别的；可以用正则。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 带变量的文本 | 要处理的文本。样本里 15 处都是 TokenString 写法（里面放一个变量） |
| `WFReplaceTextFind` | 文本 | 要找的内容（正则时是正则表达式） |
| `WFReplaceTextReplace` | 文本 | 换成什么（正则时可以写 `$1`） |
| `WFReplaceTextRegularExpression` | 布尔 | 是否当正则（样本里 13 处写了这个键） |
| `WFReplaceTextCaseSensitive` | 布尔 | 是否区分大小写（10 处） |
| `CustomOutputName` / `UUID` | | 同上 |

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.text.replace</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>CustomOutputName</key>
		<string>替换后</string>
		<key>UUID</key>
		<string>B2222222-2222-4222-8222-222222222222</string>
		<key>WFInput</key>
		<dict>
			<key>Value</key>
			<dict>
				<key>attachmentsByRange</key>
				<dict>
					<key>{0, 1}</key>
					<dict>
						<key>OutputName</key>
						<string>文本</string>
						<key>OutputUUID</key>
						<string>A1111111-1111-4111-8111-111111111111</string>
						<key>Type</key>
						<string>ActionOutput</string>
					</dict>
				</dict>
				<key>string</key>
				<string>&#xFFFC;</string>
			</dict>
			<key>WFSerializationType</key>
			<string>WFTextTokenString</string>
		</dict>
		<key>WFReplaceTextCaseSensitive</key>
		<true/>
		<key>WFReplaceTextFind</key>
		<string>旧</string>
		<key>WFReplaceTextRegularExpression</key>
		<false/>
		<key>WFReplaceTextReplace</key>
		<string>新</string>
	</dict>
</dict>
```

## `is.workflow.actions.text.match` — 匹配文本

- 证据：**样本**（只在 1 个快捷指令里见过，20 处）
- 用途：用正则在文本里找匹配，输出匹配到的内容。

| 参数 | 值 | 说明 |
|---|---|---|
| `text` | 带变量的文本 | 要在哪段文本里找（**键名是小写的 `text`**，不是 `WFInput`）。样本里 20 处都是 TokenString |
| `WFMatchTextPattern` | 文本 | 正则表达式 |
| `WFMatchTextCaseSensitive` | 布尔 | 是否区分大小写（样本里 4 处写了） |
| `CustomOutputName` / `UUID` | | 同上；没起名时输出的默认名样本里是「匹配」 |

## `is.workflow.actions.text.combine` — 合并文本

- 证据：**样本**（只见过 1 处，写法单薄）
- 用途：把一个列表里的各项用分隔符连成一段文本。

| 参数 | 值 | 说明 |
|---|---|---|
| `text` | 单个变量 | 要合并的列表（**键名是小写的 `text`**） |
| `WFTextSeparator` | 文本，样本里是 `Custom`；公开资料里全部取值是 `New Lines`、`Spaces`、`Custom` | 分隔符的种类 |
| `WFTextCustomSeparator` | 文本，样本里是 `,` | `WFTextSeparator` 是 `Custom` 时，具体的分隔符 |
| `UUID` | UUID | |

样本里只见过 `Custom` 这一种；`New Lines`、`Spaces` 是公开资料（Apple 的参数表）里的取值，没在样本里见过。出处：A（https://github.com/viticci/shortcuts-playground-plugin ，见 `actions.md` 的「出处」）。

## `is.workflow.actions.urlencode` — URL 编码

- 证据：**样本**（9 个快捷指令、9 处）
- 用途：把文本编码成能放进链接里的形式（`%E4…`）。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 带变量的文本或单个变量 | 要编码的文本（样本里 7 处 TokenString、1 处 TokenAttachment） |
| `WFEncodeMode` | 文本，样本里是 `Encode`；公开资料里还有 `Decode`（解码） | 编码方向 |
| `CustomOutputName` / `UUID` | | 同上 |

`Decode` 的出处：A（https://github.com/viticci/shortcuts-playground-plugin ，Apple 的参数表里的取值，见 `actions.md` 的「出处」）。

## 更多文本类动作（公开级）

以下几个样本里没有，是靠公开资料核对的（「公开」，出处写在每个条目里；A / B / C 各指什么见 `actions.md` 的「出处」）。**没在真机上验证过**，用了要告诉用户，导入后先试跑。

### `is.workflow.actions.text.split` — 拆分文本

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，38 个仓库；C：https://github.com/electrikmilk/cherri 、https://github.com/pfgithub/scpl）
- 用途：把一段文本按分隔符拆成一个列表。

| 参数 | 值 | 说明 |
|---|---|---|
| `text` | 带变量的文本或单个变量 | 要拆的文本（**键名是小写的 `text`**） |
| `WFTextSeparator` | 文本：`New Lines`（换行）、`Spaces`（空格）、`Every Character`（每个字符）、`Custom`（自定义） | 分隔符的种类 |
| `WFTextCustomSeparator` | 文本 | `WFTextSeparator` 是 `Custom` 时，具体的分隔符 |

### `is.workflow.actions.text.changecase` — 更改大小写

- 证据：**公开**
- 出处：A（https://github.com/viticci/shortcuts-playground-plugin ，Apple 的参数表里的取值）；C：https://github.com/electrikmilk/cherri 。真实导出里这个动作的取值有分歧（见下），所以只采信 Apple 的参数表
- 用途：把文本变成大写 / 小写等。

| 参数 | 值 | 说明 |
|---|---|---|
| `text` | 带变量的文本或单个变量 | 要处理的文本（**键名是小写的 `text`**） |
| `WFCaseType` | 文本：`UPPERCASE`、`lowercase`、`Capitalize Every Word`、`Capitalize with Title Case`、`Capitalize with sentence case`、`cApItAlIzE wItH aLtErNaTiNg cAsE` | 变成哪种；**照 Apple 现在的参数表写，后两项末尾没有句号** |

早年导出的快捷指令里，后两项的末尾带过一个句号（`…sentence case.`）；同一个仓库里两种写法都见过，所以不知道系统会不会都认。写新的就照上面的、不带句号。

### `is.workflow.actions.base64encode` — Base64 编码 / 解码

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，16 个仓库；C：https://github.com/electrikmilk/cherri 、https://github.com/joshfarrant/shortcuts-js）

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 带变量的文本或单个变量 | 要处理的内容 |
| `WFEncodeMode` | 文本：`Encode` 或 `Decode` | 编码还是解码 |
| `WFBase64LineBreakMode` | 文本：`None`、`Every 64 Characters`、`Every 76 Characters` | 编码结果要不要折行（只对 `Encode` 有意义） |

### `is.workflow.actions.hash` — 生成哈希

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令；C：https://github.com/electrikmilk/cherri 、https://github.com/joshfarrant/shortcuts-js）

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 带变量的文本或单个变量 | 要算哈希的内容 |
| `WFHashType` | 文本：`MD5`、`SHA1`、`SHA256`、`SHA512` | 哈希算法 |
