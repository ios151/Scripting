# Scripting App 自己的动作（App Intent）

用户想让快捷指令去运行 Scripting 里的脚本、打开 Scripting 的聊天、开关隧道时，用的是 Scripting 这个 App 提供的 App Intent 动作。

**可信度要说清楚：** 下面的内容是用户之前从**真实导出的快捷指令**里观察到的（共 10 个动作），**没有在设备上运行验证过**，也不是完整的 API 定义：参数只列出了样本里出现过的，没出现不代表没有；哪些必填、默认值是什么都不知道。用了之后，一定让用户在快捷指令 App 里点开这个动作看一眼、试跑一次。各个意图具体做什么，以 Scripting 自己的文档为准，这里不解释。

## 动作怎么写

标识是 `com.scripting.ios.<意图名>`，参数字典里要有 `AppIntentDescriptor`，且**标识必须等于「BundleIdentifier.AppIntentIdentifier」**（检查器会核对，Scripting 的动作还要求下面这个团队标识）：

```xml
<dict>
	<key>WFWorkflowActionIdentifier</key>
	<string>com.scripting.ios.RunScriptIntent</string>
	<key>WFWorkflowActionParameters</key>
	<dict>
		<key>UUID</key>
		<string>B2222222-2222-4222-8222-222222222222</string>
		<key>AppIntentDescriptor</key>
		<dict>
			<key>BundleIdentifier</key>
			<string>com.scripting.ios</string>
			<key>AppIntentIdentifier</key>
			<string>RunScriptIntent</string>
			<key>Name</key>
			<string>Scripting</string>
			<key>TeamIdentifier</key>
			<string>58P5F4LJ36</string>
		</dict>
		<key>texts</key>
		<string>示例输入</string>
	</dict>
</dict>
```

固定的几项：`BundleIdentifier` = `com.scripting.ios`，`Name` = `Scripting`，`TeamIdentifier` = `58P5F4LJ36`。`UUID` 照常是这个动作自己的编号。

## 观察到的 10 个动作和参数

| 意图名（`AppIntentIdentifier`） | 观察到的参数（名字：类型） |
|---|---|
| `RunScriptIntent` | `script`：实体、`texts`：文本、`parameter`：输出引用、`urls`：文本 |
| `RunInAppIntent` | 同上 |
| `RunScriptForAudioRecordingIntent` | 同上 |
| `RunAndShowSnippetIntent` | 同上 |
| `RunTypescriptIntent` | `texts`：文本、`urls`：文本、`parameter`：输出引用（**没有观察到源码字段**，别编） |
| `RunIndexInAppIntent` | `queryParameters`：输出引用 |
| `OpenAgentChatIntent` | `prompt`：文本、`files`：输出引用、`images`：输出引用 |
| `OpenAgentHistoryChatIntent` | `prompt`：文本、`session`：实体、`files`：输出引用、`images`：输出引用 |
| `ListChatSessionsIntent` | 没有观察到参数（样本里没保存参数，**不代表它真的没有**） |
| `SetTunnelIntent` | `state`：只观察到 `on`（别的值别写，留给用户在编辑器里选） |

## 几种参数的写法

- **文本**（`texts`、`urls`、`prompt`）：直接写字符串。
- **输出引用**（`parameter`、`files`、`images`、`queryParameters`）：引用前面某个动作的输出，写成单独的变量附件：

  ```xml
  <key>parameter</key>
  <dict>
  	<key>Value</key>
  	<dict>
  		<key>OutputName</key>
  		<string>Text</string>
  		<key>OutputUUID</key>
  		<string>A1111111-1111-4111-8111-111111111111</string>
  		<key>Type</key>
  		<string>ActionOutput</string>
  	</dict>
  	<key>WFSerializationType</key>
  	<string>WFTextTokenAttachment</string>
  </dict>
  ```

  `OutputUUID` 必须是前面某个动作的 `UUID`（检查器会核对）。**不要凭空写文件路径当参数**：直接的文件引用只有导出证据，没有可靠写法，要么用变量，要么留给用户选。
- **实体**（`script`、`session`）：这是设备上某个具体对象（某个脚本、某次聊天），写法需要它在这台设备上的**真实标识符**，AI 不可能知道，也**不要按显示名字去猜**。办法：**不写这个参数**，导入后让用户在快捷指令 App 里点开这个动作，自己选脚本。告诉用户这一步要自己做；不能说成「运行时会自动询问」——省略参数不保证运行时会弹出选择。
- **枚举**（`SetTunnelIntent` 的 `state`）：只写观察到的值，其他留给用户。

## 做这类快捷指令时的提醒

1. 先问用户：Scripting 里**要运行哪个脚本**、要不要传参数。脚本名字你猜不了，让用户导入后自己选。
2. 用了这些动作的快捷指令，**只有装了 Scripting 的设备**才能正常用；要在交付说明里写明这个前置条件。
3. 写完先 `check`（会核对描述自洽、引用对得上），再 `sign`；导入后让用户点开动作确认、再试跑。
4. 「快捷指令里放一个调用 Scripting 的动作」属于**混合型**快捷指令：Shortcuts 负责串联，真正的逻辑在脚本里。逻辑本身很重、拆不成动作时，建议直接做成脚本，别硬塞进快捷指令。
