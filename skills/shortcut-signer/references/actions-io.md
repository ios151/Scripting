# 输入输出、网络和系统类动作

证据标签（真机 / 样本 / 公开）的含义见 `actions.md`；参数值怎么写见 `values.md`。下面每个动作的「样本」后面写的是在 24 个真实样本里见到的个数。

## 给用户看 / 向用户要

### `is.workflow.actions.alert` — 显示提示

- 证据：**真机**（用户在真机上导入并运行成功；样本里没有它）
- 用途：弹一个带标题和内容的提示框，用户点「好」才继续。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFAlertActionTitle` | 文本 | 标题 |
| `WFAlertActionMessage` | 文本 | 内容 |
| `WFAlertActionCancelButtonShown` | 布尔 | 要不要显示「取消」按钮 |

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.alert</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>WFAlertActionCancelButtonShown</key>
		<false/>
		<key>WFAlertActionMessage</key>
		<string>内容</string>
		<key>WFAlertActionTitle</key>
		<string>标题</string>
	</dict>
</dict>
```

### `is.workflow.actions.notification` — 显示通知

- 证据：**样本**（9 个快捷指令、18 处）
- 用途：发一条本地通知（不打断流程）。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFNotificationActionTitle` | 文本 | 标题 |
| `WFNotificationActionBody` | 文本（常量 10 处 / 带变量 8 处） | 内容 |
| `WFNotificationActionSound`（公开） | 布尔 | 要不要响提示音 |
| `UUID` | UUID | 样本里 10 处写了；通知没有要引用的输出，可以不写 |

公开补充的参数的出处：A + B（见 `actions.md` 的「出处」；A：https://github.com/viticci/shortcuts-playground-plugin）。

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.notification</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>WFNotificationActionBody</key>
		<string>做完了</string>
		<key>WFNotificationActionTitle</key>
		<string>提醒</string>
	</dict>
</dict>
```

### `is.workflow.actions.ask` — 询问输入

- 证据：**样本**（11 个快捷指令、18 处）
- 用途：弹一个输入框，用户填的内容是这一步的输出。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFAskActionPrompt` | 文本 | 提示语 |
| `WFInputType` | 文本，样本里见过 `Text`（13 处）、`URL`（4 处）；公开资料里全部取值是 `Text`、`Number`、`URL`、`Date`、`Time`、`Date and Time` | 输入的类型；样本里有 1 处没写这个键 |
| `WFAllowsMultilineText` | 布尔 | 允许多行（样本里只有 1 处写了） |
| `WFAskActionDefaultAnswer`（公开） | 文本 | 输入框里预先填好的内容（文本类型）；数字、网址、日期、时间各有 `WFAskActionDefaultAnswerNumber` / `…URL` / `…Date` / `…Time` / `…DateAndTime` |
| `WFAskActionAllowsNegativeNumbers` / `WFAskActionAllowsDecimalNumbers`（公开） | 布尔 | 数字类型时允许负数 / 小数 |
| `CustomOutputName` | 文本 | 输出的名字（7 处起了名） |
| `UUID` | UUID | 输出要被引用时必须有 |

公开补充的参数的出处：A + B（见 `actions.md` 的「出处」；A：https://github.com/viticci/shortcuts-playground-plugin）。

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.ask</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>CustomOutputName</key>
		<string>输入</string>
		<key>UUID</key>
		<string>A1111111-1111-4111-8111-111111111111</string>
		<key>WFAskActionPrompt</key>
		<string>请输入名字</string>
		<key>WFInputType</key>
		<string>Text</string>
	</dict>
</dict>
```

### `is.workflow.actions.choosefromlist` — 从列表中选取

- 证据：**样本**（1 处，写法单薄）
- 用途：让用户从一个列表里选一项。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 单个变量 | 列表 |
| `WFChooseFromListActionPrompt` | 文本 | 提示语 |
| `WFChooseFromListActionSelectMultiple` / `WFChooseFromListActionSelectAll`（公开） | 布尔 | 允许多选 / 默认全选 |
| `CustomOutputName` / `UUID` | | 同上 |

公开补充的参数的出处：A（https://github.com/viticci/shortcuts-playground-plugin，见 `actions.md` 的「出处」）。

## 剪贴板、链接、网络

### `is.workflow.actions.getclipboard` — 获取剪贴板

- 证据：**样本**（7 个快捷指令、7 处）
- 参数：只有 `CustomOutputName` 和 `UUID`。输出是剪贴板的内容；引用它时用这个动作的 `UUID`（样本里还有一种 `Type` = `Clipboard` 的直接引用，见 `values.md` 第四节）。

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.getclipboard</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>CustomOutputName</key>
		<string>剪贴板</string>
		<key>UUID</key>
		<string>A1111111-1111-4111-8111-111111111111</string>
	</dict>
</dict>
```

### `is.workflow.actions.url` — URL

- 证据：**样本**（1 处）
- 参数：`WFURLActionURL`（要变成 URL 的文本；样本里那一处是个变量引用）、`UUID`。输出是一个 URL，默认名「URL」。

### `is.workflow.actions.openurl` — 打开 URL

- 证据：**样本**（13 个快捷指令、19 处）
- 用途：用系统打开一个链接，包括 App 的 URL Scheme（样本里有 `prefs:` 和 `roamcontrol://` 这类）。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 文本（常量 15 处）、带变量的文本（2 处）或单个变量（1 处） | 要打开的链接 |
| `UUID` | UUID | 样本里 15 处写了，不引用可以不写 |

### `is.workflow.actions.downloadurl` — 获取 URL 内容

- 证据：**样本**（9 个快捷指令、27 处；样本里全是 GET 请求）
- 用途：请求一个链接，输出响应内容（JSON 响应后面接 `getvalueforkey` 取字段）。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFURL` | 文本（常量 11 处 / 带变量 16 处） | 请求地址 |
| `WFHTTPMethod` | 文本，样本里只有 `GET`（18 处；另外 9 处没写，是默认）；公开资料里全部取值是 `GET`、`POST`、`PUT`、`PATCH`、`DELETE` | 请求方法 |
| `WFHTTPBodyType`（公开） | 文本：`JSON`、`Form`、`File` | 请求体的类型；**做 POST 时要写**，注意大小写（`JSON` 不是 `Json`） |
| `WFJSONValues`（公开） | 字典（`WFDictionaryFieldValue`，写法见 `values.md` 第八节） | `WFHTTPBodyType` 是 `JSON` 时的请求体 |
| `WFFormValues`（公开） | 字典（同上） | `WFHTTPBodyType` 是 `Form` 时的请求体 |
| `WFRequestVariable`（公开） | 单个变量 | `WFHTTPBodyType` 是 `File` 时，要上传的文件 |
| `WFHTTPHeaders`（公开） | 字典（同上） | 请求头，键是头名、值是头的内容 |
| `Advanced` / `ShowHeaders`（公开） | 布尔 | 界面里「显示更多」「显示请求头」的展开开关；**不写也行**——公开仓库里有不带它们的 POST + JSON 的真实快捷指令（29 个文件）；想让编辑器里展开着显示就写 `true` |
| `CustomOutputName` | 文本 | 输出的名字（样本里 9 处起名 `ParseJSON`，后面 24 处引用都用这个名字） |
| `UUID` | UUID | 18 处写了；要引用响应就必须写 |

POST 请求体的键名是这样对应的：JSON 体用 `WFJSONValues`、表单体用 `WFFormValues`、文件体用 `WFRequestVariable`。**别把 JSON 或表单体写进 `WFRequestVariable`**：有的第三方文档这么写，和 Apple 的参数表、公开仓库里真实导出的快捷指令都矛盾，据说导入后会悄悄失败。
样本里**没有** POST、请求头、请求体，上面带「（公开）」的行都是公开资料里核对出来的，不是样本；用了要告诉用户这部分没在真机上验证过。

公开补充的参数的出处：A + B（见 `actions.md` 的「出处」；A：https://github.com/viticci/shortcuts-playground-plugin ；B 里 POST + JSON 的真实例子很多，比如 https://github.com/huaminghuangtw/Shortcutomation）。

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.downloadurl</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>CustomOutputName</key>
		<string>响应</string>
		<key>UUID</key>
		<string>B2222222-2222-4222-8222-222222222222</string>
		<key>WFHTTPMethod</key>
		<string>GET</string>
		<key>WFURL</key>
		<string>https://example.com/api</string>
	</dict>
</dict>
```

POST + JSON 体的写法（**公开级，没在真机上验证过**）：

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>is.workflow.actions.downloadurl</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>CustomOutputName</key>
		<string>响应</string>
		<key>UUID</key>
		<string>B2222222-2222-4222-8222-222222222222</string>
		<key>WFHTTPBodyType</key>
		<string>JSON</string>
		<key>WFHTTPMethod</key>
		<string>POST</string>
		<key>WFJSONValues</key>
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
		<key>WFURL</key>
		<string>https://example.com/api</string>
	</dict>
</dict>
```

## 地图、网络状态（样本里见过，用得少）

| 标识 | 证据 | 参数 | 说明 |
|---|---|---|---|
| `is.workflow.actions.getmapslink` — 获取地图链接 | **样本**（9 个快捷指令、9 处） | `WFInput`（单个变量 8 处 / 文本 1 处）、`UUID` | 输出一个地图 URL，默认名「地图URL」 |
| `is.workflow.actions.searchlocalbusinesses` — 搜索本地商家 | **样本**（9 个快捷指令、9 处） | `WFSearchQuery`（带变量的文本，样本里 9 处都是 `Variable` 令牌）、`UUID` | 输出默认名「本地商户」 |
| `is.workflow.actions.vpn.get` — 获取当前 VPN | **样本**（2 个快捷指令、2 处） | 只有 `UUID` | 输出默认名「当前VPN」；样本里后面用 `Aggrandizements` 的 `PropertyName` = `Is Connected` 判断是否已连接（`values.md` 第五节） |

## 更多给用户看的动作（公开级）

以下几个样本里没有，是靠公开资料核对的（「公开」，出处写在每个条目里；A / B / C 各指什么见 `actions.md` 的「出处」）。**没在真机上验证过**，用了要告诉用户，导入后先试跑。

### `is.workflow.actions.showresult` — 显示结果

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，几十个仓库里都有；C：https://github.com/electrikmilk/cherri 、https://github.com/a2/swift-shortcuts）
- 用途：把一段内容显示在结果窗口里。在 iOS 27 的快捷指令里它改名叫「显示内容」，标识没变。

| 参数 | 值 | 说明 |
|---|---|---|
| `Text` | 文本（常量或带变量的文本） | 要显示的内容。**键名是 `Text`**（不是 `WFText`） |

带变量的写法见 `templates/text-to-result.plist`。

### `is.workflow.actions.speaktext` — 朗读文本

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令；C：https://github.com/electrikmilk/cherri）
- 用途：用语音把一段文字读出来。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFText` | 文本 | 要读的内容 |
| `WFSpeakTextWait` | 布尔 | 读完再继续（默认 `true`） |
| `WFSpeakTextRate` | 数字 | 语速（真实导出里多在 0.5 左右） |
| `WFSpeakTextPitch` | 数字 | 音调（默认 1.0） |
| `WFSpeakTextLanguage` | 文本 | 语言代码，比如 `zh-CN`、`en-US`；真实导出里也见过 `auto` |
| `WFSpeakTextVoice` | 文本 | 声音，比如 `Default` |

### `is.workflow.actions.vibrate` — 振动

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，75 处都没带任何参数；C：https://github.com/electrikmilk/cherri）
- 用途：让设备振动一下。**不用写参数**（`WFWorkflowActionParameters` 写空字典）。Apple 的参数表里有个只在手表上用的 `WFVibrateHapticType`，真实导出里没见过它的用法，别写。

### `is.workflow.actions.waittoreturn` — 等待返回

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，68 处都没带任何参数；C：https://github.com/electrikmilk/cherri）
- 用途：等用户回到快捷指令 App 再继续（先「打开 URL」跳去别的 App 时常配合它用）。**没有参数。**

## 剪贴板、分享、打开 App、运行快捷指令（公开级）

### `is.workflow.actions.setclipboard` — 拷贝到剪贴板

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，41 个仓库；C：https://github.com/electrikmilk/cherri 、https://github.com/a2/swift-shortcuts）
- 用途：把一个值放进剪贴板。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFInput` | 单个变量或文本 | 要拷贝的内容 |
| `WFLocalOnly` | 布尔 | 是否只留在本机 |
| `WFExpirationDate` | 文本，可以是空串 | 剪贴板内容的过期时间 |

### `is.workflow.actions.share` — 共享

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，16 个仓库；C：https://github.com/electrikmilk/cherri）
- 用途：弹出系统分享面板。只有一个参数：`WFInput`（要分享的内容，单个变量）。

### `is.workflow.actions.openapp` — 打开 App

- 证据：**公开**
- 出处：A + B（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，`WFAppIdentifier` 见于 11 个仓库、`WFSelectedApp` 见于 6 个仓库；C：https://github.com/electrikmilk/cherri）
- 用途：打开某个 App。**这个动作要特别小心**：Apple 现在的参数表里是 `WFSelectedApp`，真实导出里新版同时写 `WFAppIdentifier`，旧版只有 `WFAppIdentifier`，下面两种写法的关系没核对清楚。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFSelectedApp` | 字典：`BundleIdentifier`（App 的包名，比如 `com.apple.mobilesafari`）、`Name`、`TeamIdentifier` | 要打开的 App；Apple 现在的参数表里的键 |
| `WFAppIdentifier` | 文本：App 的包名 | 真实导出里（新版同时写、旧版只有它）见过；**Apple 现在的参数表里没有这个键**（是老键，系统怎么对待它没核对） |

只写 `WFAppIdentifier`、不写 `WFSelectedApp` 在新系统上能不能用，**没有证据**；不想冒险就让用户导入后点开这个动作自己选 App。

### `is.workflow.actions.runworkflow` — 运行快捷指令

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，`WFWorkflowName` 见于 20 个仓库、`WFWorkflow` 见于 15 个仓库；C：https://github.com/electrikmilk/cherri）
- 用途：运行另一个快捷指令。**目标快捷指令的内部编号是那台设备上才有的，AI 不可能知道。**

| 参数 | 值 | 说明 |
|---|---|---|
| `WFWorkflow` | 字典：`workflowIdentifier`（目标的内部 UUID）、`workflowName`（名字）、`isSelf`（布尔，是不是运行自己） | 指定运行哪个；Apple 现在的参数表里的键 |
| `WFWorkflowName` | 文本：目标快捷指令的名字 | 真实导出里常和 `WFWorkflow` 一起出现；**Apple 现在的参数表里没有这个键**（老键） |
| `WFInput` | 单个变量 | 传给它的输入 |
| `WFShowWorkflow` | 布尔 | 运行时是否显示（真实导出里多是 `false`）；**Apple 现在的参数表里没有这个键**（老键） |

只写 `WFWorkflowName`、不写 `WFWorkflow` 能不能找到目标，**没有证据**。稳妥的做法：导入后让用户点开这个动作，自己选一遍要运行的快捷指令。

## 设备与系统信息（公开级）

下面这些动作的输出，别的动作要引用时同样要写 `UUID`，最好也起一个 `CustomOutputName`（`values.md` 第六节）。

### `is.workflow.actions.getdevicedetails` — 获取设备详细信息

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令；C：https://github.com/electrikmilk/cherri）
- 参数：`WFDeviceDetail`，文本，取值：`Device Name`（设备名）、`Device Hostname`、`Device Model`（型号）、`Device Is Watch`、`System Version`（系统版本）、`System Build Number`、`Screen Width`、`Screen Height`、`Current Volume`、`Current Brightness`、`Current Appearance`（深浅色）、`Device Is Locked`。

### `is.workflow.actions.getbatterylevel` — 获取电池状态

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令；C：https://github.com/electrikmilk/cherri）
- 参数：可以不写（取电量）；新版有 `Subject`，文本，取值：`Battery Level`（电量）、`Is Charging`（是否在充电）、`Is Connected to Charger`、`Charge Limit`。

### `is.workflow.actions.getcurrentlocation` — 获取当前位置

- 证据：**公开**
- 出处：A + B（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，3 个仓库见过 `Accuracy`；C：https://github.com/electrikmilk/cherri ）
- 参数：可以不写；可选 `Accuracy`，文本，取值：`Best`、`NearestTenMeters`、`HundredMeters`、`Kilometer`、`ThreeKilometers`。用到位置要先让用户同意，别替他决定。

### `is.workflow.actions.getipaddress` — 获取当前 IP 地址

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令；C：https://github.com/electrikmilk/cherri）

| 参数 | 值 | 说明 |
|---|---|---|
| `WFIPAddressSourceOption` | 文本：`External`（公网）或 `Local`（局域网） | 取哪种地址 |
| `WFIPAddressTypeOption` | 文本：`IPv4` 或 `IPv6` | 取哪个版本 |

### `is.workflow.actions.setbrightness` — 设置亮度

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令；C：https://github.com/electrikmilk/cherri 、https://github.com/joshfarrant/shortcuts-js）
- 参数：`WFBrightness`，0 到 1 的小数（或变量）。

### `is.workflow.actions.setvolume` — 设置音量

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令；C：https://github.com/electrikmilk/cherri 、https://github.com/joshfarrant/shortcuts-js）
- 参数：`WFVolume`，0 到 1 的小数（或变量）；新版另有 `WFVolumeSetting`（文本：`Media` 调媒体音量，或 `Ringtone` 调铃声音量；旧系统没有这个键）。

## 远程命令（公开级）

### `is.workflow.actions.runsshscript` — 通过 SSH 运行脚本

- 证据：**公开**
- 出处：A + B + C（A：https://github.com/viticci/shortcuts-playground-plugin ；B：公开仓库里真实导出的快捷指令，9 个仓库；C：https://github.com/electrikmilk/cherri 、https://github.com/joshfarrant/shortcuts-js）
- 用途：登录一台机器，运行一段命令，输出是命令的输出。

| 参数 | 值 | 说明 |
|---|---|---|
| `WFSSHScript` | 文本 | 要运行的命令 |
| `WFSSHHost` / `WFSSHPort` / `WFSSHUser` | 文本 | 主机、端口（也是文本）、用户名 |
| `WFSSHAuthenticationType` | 文本：`Password` 或 `SSH Key` | 登录方式 |
| `WFSSHPassword` | 文本 | 密码。**别把密码写进快捷指令**：让用户导入后自己填，或用「每次询问」 |
| `WFInput` | 单个变量 | 传给命令的输入 |

## 第三方 App 的动作（App Intent）

样本里有 WLOC、LocalDevVPN、Egern 的动作（标识形如 `com.xxx.Yyy…Intent`）。它们的共同点：

- 标识 = `BundleIdentifier` + `.` + `AppIntentIdentifier`（检查器会核对）；
- 参数里有 `AppIntentDescriptor`，键有 `BundleIdentifier`、`Name`、`AppIntentIdentifier`，有的还有 `TeamIdentifier`（同一个 WLOC 动作在 10 个快捷指令里出现，4 个带它、6 个不带；Scripting 的动作检查器要求有）；
- 其余参数各 App 各不相同，有的还带 `ShowWhenRun`（布尔）。

具体 App 的参数键名没有真实样例就**不要写**；Scripting 自己的动作见 `scripting-intents.md`。
