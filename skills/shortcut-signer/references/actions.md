# 动作目录：先查这里，再写动作

写快捷指令草稿时，**动作的标识（`WFWorkflowActionIdentifier`）和参数的键名一个字都不能错**：标识写错，导入后那一步是「未知动作」；键名写错，那个参数会被悄悄忽略。检查器和签名都发现不了这种错——所以**只写这份目录里登记过的动作**。

## 证据标签

每个动作都标了证据，意思是：

| 标签 | 含义 | 你该怎么对待 |
|---|---|---|
| **真机** | 用户在真机上导入并运行成功 | 目前只有 `is.workflow.actions.alert` |
| **样本** | 在 24 个真实的、Apple 签名的快捷指令里见过：标识和参数键名是真的，值的写法也照样本。**但你写的这个组合没在真机上跑过** | 放心用，导入后先试跑 |
| **公开** | 样本里没有，但至少两个互相独立的公开出处对得上（A / B / C 各指什么见下面「出处」，每个条目里写出具体出处） | 比「样本」弱一档：用了要告诉用户这个动作没在真机上验证过，导入后先试跑 |

条目里写着「`键名`（公开）」的参数，是「样本」级的动作里靠公开资料补上的参数：动作本身样本里见过，这个参数样本里没有。

## 出处

「公开」级的条目里写的 A / B / C 指这三类出处，彼此独立：

- **A：Apple 自己的动作参数表**（快捷指令 App 内部的 ToolKit 数据库，iOS 27 / macOS 27 版）：由 Federico Viticci 整理成数据文件，放在 MIT 许可的 https://github.com/viticci/shortcuts-playground-plugin （`claude/skills/shortcuts-playground/data/toolkit-v78-first-party-parameter-keys.json` 和 `…enum-cases.json`）。每个动作有哪些参数键、取值有哪些，以它为准。**它不收「如果 / 重复 / 菜单」这几个控制流动作**（那几个只能看真实导出）。
- **B：公开仓库里真实导出的快捷指令**：约 3400 个文本版的 .shortcut / .plist 文件（240 个仓库，客户端版本从 700 到 4711），比如 https://github.com/huaminghuangtw/Shortcutomation 、https://github.com/suliveevil/My-Siri-Shortcuts 、https://github.com/jimbrig/ios-shortcuts 。条目里写的「N 个仓库」是这个语料里按不同仓库数的。
- **C：别的项目对动作的定义**：Cherri https://github.com/electrikmilk/cherri 、ScPL https://github.com/pfgithub/scpl 、shortcuts-js https://github.com/joshfarrant/shortcuts-js 、swift-shortcuts https://github.com/a2/swift-shortcuts 。

核对时对着本技能里「样本」级的动作做过标尺：A、B、Cherri 都和 24 个真实样本里读出来的写法对得上；个别第三方文档（比如把 POST 的 JSON 体写进 `WFRequestVariable` 的）和这三类都矛盾，没有采信。**这些出处都只是文件和文档，没有一个是在真机上跑过你拼出来的这个组合。**

目录里没有的动作，就是**没核对过**。别凭记忆写：请用户在快捷指令 App 里手动做出来、分享给你看，或者换成目录里的动作拼。以后哪个动作在真机上跑通了，就把它的标签升成「真机」。

## 怎么用

1. 先在下面的「按想做的事找动作」或「索引」里找到要用的动作。
2. 读这一类的文件，里面有参数表和能照着改的 XML：

| 文件 | 内容 |
|---|---|
| `actions-io.md` | 弹提示 / 通知 / 朗读、向用户要输入、剪贴板、分享、打开 App、运行快捷指令、链接、网络请求（含 POST）、设备信息、SSH、地图 |
| `actions-text.md` | 文本、替换、正则匹配、合并、拆分、大小写、URL 编码、Base64、哈希 |
| `actions-data.md` | 变量、列表、计数、计算、数字、日期、词典、取 / 设词典值 |
| `actions-flow.md` | 如果（含条件码表）/ 重复 / 对每个项目重复 / 菜单、等待、备注、停止、停止并输出 |

3. 参数的值怎么写（常量、变量、带变量的文本、字典、多条件）看 `values.md`。
4. 想直接拿现成的骨架改，看 `templates/`（`recipes.md` 说每份模板是干什么的）。
5. 写完 `check`，导入后先试跑，并跟用户说清楚用到的动作是什么证据等级。

## 按想做的事找动作

| 想做什么 | 用这些动作 |
|---|---|
| 弹一个提示 / 发一条通知 | `alert`（真机验证过）、`notification` |
| 向用户要一段输入 / 让用户选一项 | `ask`、`choosefromlist`、`choosefrommenu` |
| 拼文本、处理文本 | `gettext`、`text.replace`、`text.match`、`text.combine`、`urlencode` |
| 请求接口、取 JSON 里的字段 | `downloadurl` + `getvalueforkey` |
| 按条件分支 | `conditional`（条件码见 `actions-flow.md`） |
| 重复做几遍 / 停几秒 | `repeat.count`、`delay` |
| 存一个值、以后再用 | `setvariable`（取用见 `values.md` 第四节） |
| 读剪贴板 / 写剪贴板 | `getclipboard`、`setclipboard` |
| 打开链接 / 打开 App / 运行别的快捷指令 | `openurl`、`openapp`、`runworkflow`（后两个要小心，看条目里的提醒） |
| 显示结果 / 朗读 / 振动 | `showresult`、`speaktext`、`vibrate` |
| 发 POST 请求 | `downloadurl`（POST + JSON / 表单体的键见 `actions-io.md`）+ `getvalueforkey`、`detect.dictionary` |
| 拆分文本 / 改大小写 / Base64 / 哈希 | `text.split`、`text.changecase`、`base64encode`、`hash` |
| 取日期 / 格式化日期 | `date`、`format.date` |
| 取设备信息 / 电量 / 位置 / IP | `getdevicedetails`、`getbatterylevel`、`getcurrentlocation`、`getipaddress` |
| 遍历列表 | `repeat.each` |
| 把结果交出去（分享面板、别的快捷指令） | `output`（`exit` 是单纯停止、没有输出） |
| 通过 SSH 在服务器上跑命令 | `runsshscript`（密码别写进去） |

## 索引

| 标识 | 名称 | 证据 | 文件 |
|---|---|---|---|
| `is.workflow.actions.alert` | 显示提示 | 真机 | actions-io.md |
| `is.workflow.actions.notification` | 显示通知 | 样本 | actions-io.md |
| `is.workflow.actions.ask` | 询问输入 | 样本 | actions-io.md |
| `is.workflow.actions.choosefromlist` | 从列表中选取 | 样本 | actions-io.md |
| `is.workflow.actions.getclipboard` | 获取剪贴板 | 样本 | actions-io.md |
| `is.workflow.actions.url` | URL | 样本 | actions-io.md |
| `is.workflow.actions.openurl` | 打开 URL | 样本 | actions-io.md |
| `is.workflow.actions.downloadurl` | 获取 URL 内容 | 样本 | actions-io.md |
| `is.workflow.actions.getmapslink` | 获取地图链接 | 样本 | actions-io.md |
| `is.workflow.actions.searchlocalbusinesses` | 搜索本地商家 | 样本 | actions-io.md |
| `is.workflow.actions.vpn.get` | 获取当前 VPN | 样本 | actions-io.md |
| `is.workflow.actions.showresult` | 显示结果 | 公开 | actions-io.md |
| `is.workflow.actions.speaktext` | 朗读文本 | 公开 | actions-io.md |
| `is.workflow.actions.vibrate` | 振动 | 公开 | actions-io.md |
| `is.workflow.actions.waittoreturn` | 等待返回 | 公开 | actions-io.md |
| `is.workflow.actions.setclipboard` | 拷贝到剪贴板 | 公开 | actions-io.md |
| `is.workflow.actions.share` | 共享 | 公开 | actions-io.md |
| `is.workflow.actions.openapp` | 打开 App | 公开 | actions-io.md |
| `is.workflow.actions.runworkflow` | 运行快捷指令 | 公开 | actions-io.md |
| `is.workflow.actions.getdevicedetails` | 获取设备详细信息 | 公开 | actions-io.md |
| `is.workflow.actions.getbatterylevel` | 获取电池状态 | 公开 | actions-io.md |
| `is.workflow.actions.getcurrentlocation` | 获取当前位置 | 公开 | actions-io.md |
| `is.workflow.actions.getipaddress` | 获取当前 IP 地址 | 公开 | actions-io.md |
| `is.workflow.actions.setbrightness` | 设置亮度 | 公开 | actions-io.md |
| `is.workflow.actions.setvolume` | 设置音量 | 公开 | actions-io.md |
| `is.workflow.actions.runsshscript` | 通过 SSH 运行脚本 | 公开 | actions-io.md |
| `is.workflow.actions.gettext` | 文本 | 样本 | actions-text.md |
| `is.workflow.actions.text.replace` | 替换文本 | 样本 | actions-text.md |
| `is.workflow.actions.text.match` | 匹配文本 | 样本 | actions-text.md |
| `is.workflow.actions.text.combine` | 合并文本 | 样本 | actions-text.md |
| `is.workflow.actions.urlencode` | URL 编码 | 样本 | actions-text.md |
| `is.workflow.actions.text.split` | 拆分文本 | 公开 | actions-text.md |
| `is.workflow.actions.text.changecase` | 更改大小写 | 公开 | actions-text.md |
| `is.workflow.actions.base64encode` | Base64 编码 | 公开 | actions-text.md |
| `is.workflow.actions.hash` | 生成哈希 | 公开 | actions-text.md |
| `is.workflow.actions.setvariable` | 设定变量 | 样本 | actions-data.md |
| `is.workflow.actions.getvariable` | 获取变量 | 样本 | actions-data.md |
| `is.workflow.actions.list` | 列表 | 样本 | actions-data.md |
| `is.workflow.actions.getitemfromlist` | 从列表中获取项目 | 样本 | actions-data.md |
| `is.workflow.actions.count` | 计数 | 样本 | actions-data.md |
| `is.workflow.actions.math` | 计算 | 样本 | actions-data.md |
| `is.workflow.actions.dictionary` | 词典 | 样本 | actions-data.md |
| `is.workflow.actions.getvalueforkey` | 获取词典值 | 样本 | actions-data.md |
| `is.workflow.actions.number` | 数字 | 公开 | actions-data.md |
| `is.workflow.actions.appendvariable` | 添加到变量 | 公开 | actions-data.md |
| `is.workflow.actions.detect.dictionary` | 从输入获取词典 | 公开 | actions-data.md |
| `is.workflow.actions.setvalueforkey` | 设置词典值 | 公开 | actions-data.md |
| `is.workflow.actions.date` | 日期 | 公开 | actions-data.md |
| `is.workflow.actions.format.date` | 格式化日期 | 公开 | actions-data.md |
| `is.workflow.actions.conditional` | 如果 | 样本 | actions-flow.md |
| `is.workflow.actions.choosefrommenu` | 从菜单中选取 | 样本 | actions-flow.md |
| `is.workflow.actions.repeat.count` | 重复 | 样本 | actions-flow.md |
| `is.workflow.actions.delay` | 等待 | 样本 | actions-flow.md |
| `is.workflow.actions.comment` | 备注 | 样本 | actions-flow.md |
| `is.workflow.actions.nothing` | 什么都不做 | 样本 | actions-flow.md |
| `is.workflow.actions.exit` | 停止这个快捷指令 | 样本 | actions-flow.md |
| `is.workflow.actions.repeat.each` | 对每个项目重复 | 公开 | actions-flow.md |
| `is.workflow.actions.output` | 停止并输出 | 公开 | actions-flow.md |

Scripting 自己的动作（运行脚本、打开 AI 聊天等）见 `scripting-intents.md`，第三方 App 的动作（App Intent）的共同写法见 `actions-io.md` 最后一节。
