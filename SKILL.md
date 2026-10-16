# 维护手册

写给接手这个项目的人（包括三个月后的自己）。重点不是「代码在哪」——那个看目录
就行——而是**哪些地方反直觉、为什么那样写、改了会怎么坏**。

---

## 0. 系统与设备要求

| 要求 | 为什么 |
|---|---|
| **iOS 17+** | `Map` 组件本身是 iOS 17+；RemotePairing / RSD 这套开发者通道也是 iOS 17 起 |
| **iOS 18+**（部分功能） | 点中 POI 弹系统详情卡（`featureSelectionAccessory`）、`Annotation` 的标记选中。低版本上这两项静默失效，不影响主流程 |
| **iOS 26+**（外观） | 界面用了 `glassEffect`（Liquid Glass）。低版本上退化成普通背景，功能不受影响 |
| **开发者模式必须开** | 设置 → 隐私与安全性 → 开发者模式。整条链路都走开发者通道 |
| **灵动岛**（可选） | 需要带灵动岛的机型（iPhone 14 Pro 及以后）。没有的话实时活动仍会出现在锁屏和通知中心 |

`script.json` 里没有写最低版本——Scripting 应用自己有下限，脚本不另外设。
真正的硬门槛是 iOS 17 和开发者模式，其余都是「有更好、没有也能用」。

---

## 1. 这个东西是怎么工作的

```
本机配对（RemotePairing）
  → 申请一次性隧道监听，拿到端口和 PSK
    → VPN.localDevVPN.openRSDTunnel（TLS-PSK + CDTunnel 由原生做）
      → HTTP/2 + RemoteXPC 取服务表，找 com.apple.instruments.dtservicehub
        → DTX 开 LocationSimulation 频道
          → simulateLocationWithLatitude:longitude:
```

和 Xcode 的 Simulate Location 是同一套机制。整条链路里**只有 TLS-PSK 隧道那一段
是原生做的**，其余（RemotePairing 握手、pair-verify、HTTP/2、RemoteXPC、DTX、
bplist、NSKeyedArchiver）全是这个仓库里的 TypeScript 实现。

协议细节以 [jkcoxson/idevice](https://github.com/jkcoxson/idevice) 为真值。
改字节之前先对一遍它，别凭猜测调。

### 模块地图

| 文件 | 职责 |
|---|---|
| `core/bytes.ts` | hex / base64 / 拼接 / 大小端读写 |
| `core/bplist.ts` | 二进制 plist 读写 |
| `core/keyed_archive.ts` | NSKeyedArchiver 编解码 |
| `core/tlv8.ts` | HomeKit 风格的 TLV8（含 >255 字节分片） |
| `core/crypto_utils.ts` | HKDF-SHA512、X25519、Ed25519、ChaCha20-Poly1305 |
| `core/rppairing.ts` | RemotePairing 信封、pair-verify M1–M4、申请隧道监听 |
| `core/srp.ts` `core/opack.ts` `core/pair_setup.ts` `core/bonjour.ts` | PIN 自配对（响应方） |
| `core/pairing.ts` | 配对记录的存取、解析、三种格式导出 |
| `core/xpc.ts` `core/http2.ts` `core/rsd.ts` | RemoteXPC 服务发现 |
| `core/dtx.ts` | DTX 消息帧与方法调用 |
| `core/location.ts` `core/session.ts` | 坐标下发、会话生命周期、诊断 |
| `core/geo.ts` `core/movement.ts` `core/gpx.ts` | 移动模拟（纯计算，脱机可测） |
| `core/tlsprobe.ts` | 手搓 TLS 1.2 ClientHello，隧道取证用（只在诊断页手动触发） |
| `utils/coords.ts` | GCJ-02 ↔ WGS-84 换算、地图链接解析、位置扰动 |

---

## 2. 改之前必须知道的坑

这一节是这个手册的核心。每一条都是真栽过的。

### 2.1 Node 的 Buffer 不能开视图，必须拷贝

```ts
// 错：在 Node 的 Buffer 内存上开视图
push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
// 对：拷贝
push(new Uint8Array(data));
```

Buffer 来自共享内存池，数据在队列里排队期间底层就可能被回收复用。
症状是**偶发的协议解析错误**，难复现、难定位。见 `core/tcp.ts`。

### 2.2 `BackgroundKeeper.keepAlive()` 返回 boolean，不是抛错

系统拒绝时 `resolve(false)`，不是 reject。只接 reject 分支的话，保活失败会被
当成成功，锁屏掉线时界面上一点线索都没有。要检查返回值，再复核
`BackgroundKeeper.isActive`。

保活什么时候申请、什么时候撤、谁来撤，见 **2.26**——那三条比这条重要得多。

### 2.3 `List` 的一行里放多个 `Button`，只有最后一个会响应

SwiftUI 把列表行当成一个点击目标。做一排颜色圆点时栽过——点哪里都只选中最后
一个。加 `buttonStyle="borderless"` 即可。

### 2.4 实时活动的几个槽位不接受 `null`

`compactLeading` / `compactTrailing` / `minimal` 传 `null` 过不了类型检查，
想「不显示」只能塞一个空白 `Text` 占位。

### 2.5 实时活动的卡片生命周期独立于脚本

> 另见 **2.16**：一个脚本只能注册一个 Live Activity。


脚本被划掉、会话异常中断时卡片都会留在灵动岛上，内容停在最后一次更新那一刻。
所以：

- 启动时要清掉**无主卡片**（没有「未收尾记录」就说明上次正常结束，那张卡是残留）
- 设置改动要**主动推一次更新**，不能只在「有进行中的会话」时推——卡片可能是
  上一次留下的，那时 `activeLoc` 已经是 null，但岛上还挂着旧内容
- **`start()` 之前必须先 `LiveActivity.endAllActivities()`**

最后那条是真摔出来的：启动时的清理在「有未收尾记录」时会**故意跳过**（那张卡正是
提醒你去恢复的东西），于是

```
开模拟 → 卡 A，退出 App（没停）→ 重进，有记录所以不清 → 又开模拟 → 卡 B → …
```

几轮下来通知中心堆了好几条「定点模拟」，每张还带着各自那个时间点的坐标。

手上的 `liveActivity` 实例句柄只认得**本进程**起的那张，收不掉上一轮留下的，
所以清场只能用静态的 `LiveActivity.endAllActivities`。`end()` 仍然用实例方法——
那是正常收尾，只该结束自己那张。

### 2.5a `start()` 对一个实例只能调一次

```ts
// LiveActivity.register 返回的是工厂函数，不是实例
static register<T>(name: string, builder: ...): () => LiveActivity<T>
```

实例内部有 `_started` 标志（还暴露成只读的 `started`），第二次调 `start()` 直接抛
`Failed to execute LiveActivity.start, this method must only be called once`。

```ts
// 错：整个会话复用一个实例，第二次开模拟卡片就再也起不来了
const activity = useObservable(() => SimulationLiveActivity());
await activity.value.start(state);

// 对：每次开卡都从工厂拿新的
activity.setValue(SimulationLiveActivity());
await activity.value.start(state);
```

这个坑特别阴，因为起卡片失败是**被兜住的**（起不来不该影响定位模拟），
只落一行日志，用户那边的表现只是「这次怎么没灵动岛了」。`index.tsx` 的
`startLiveActivity` 和 `PairingPage` 的 PIN 卡两处都要这么写。

### 2.6 Observable 必须在组件自己的 render 里读

```tsx
// 错：在 GeometryReader 的子闭包里读，订阅建立不到本组件身上
<GeometryReader>{(proxy) => <Map>{activeLoc.value && <Marker/>}</Map>}</GeometryReader>

// 对：先在 render 里读出来
const active = activeLoc.value;
<GeometryReader>{(proxy) => <Map>{active && <Marker/>}</Map>}</GeometryReader>
```

症状是**底部坐标卡在变、地图上的标记不动**。render-prop 嵌套会把响应式边界搞糊。

### 2.7 `useEffect(…, [])` 捕获的是首帧闭包

`pages/MapPage.tsx` 里有三处这样的 effect 捕获了 `onCoordChange`。现在能跑是
因为里面读的全是 Observable / ref / `setState`（稳定引用）。**哪天有人在回调里
读一个普通 state，POI 选点就会静默用旧值。**

这也是 `drawing` / `drawnPath` 当初不得不改成 Observable + ref 的原因——那是绕过
症状，没治根。根治办法是用 ref 存最新回调，effect 里读 `ref.current`。

### 2.8 不要静默吞掉用户发起的动作的错误

`.catch(() => undefined)` 只用在清理路径上。这个项目已经因为「catch 掉就算了」
栽过三次——后台保活、实时活动、地图选点，每次都是界面上毫无线索，排查全靠猜。

### 2.9 密钥材料不进日志

只记长度，不记内容。日志会被贴进 issue 和聊天窗口。`core/debug.ts` 的 `DEBUG`
默认是 `false`，排查时才打开。

### 2.10 XML 实体：写入转义了，读取也要反转义

`core/pairing.ts` 的 XML plist 路径当初只做了写入转义，设备名带 `&` 或 `<` 的
记录读回来是 `A&lt;B`。wloc 导出的记录同样会中招。注意 `&amp;` 要**最后**反转义，
否则 `&amp;lt;` 会被还原成 `<`。

### 2.11 别让 `@types/node` 漏进来

`tsconfig.json` 里有 `"types": []`。工作区的上级目录装了 `@types/node`，
不排除的话它会和 Scripting 自己的 `dts/node.d.ts` 一起合并进 `module "net"`，
两个同名 `class Server` 冲突（`skipLibCheck` 把错误吞了），
结果 `on` / `once` / `removeListener` 解析不到。

Scripting 的 dts 自带定时器和 `node:*` 全套声明，不需要 @types/node。

### 2.12 隧道监听是一次性的

`createTcpListener()` 拿到的端口只能用一次。**拿到端口后绝不能先做 TCP 探测**，
否则监听被消费掉，真正的隧道建立会失败，错误码还会变（当初排查时错误 6 变成了
错误 7，白白误导了半天）。

`core/tlsprobe.ts` 的取证因此做成了诊断页里的手动按钮，不放在自动失败路径上。

### 2.13 地图选点用 `MapReader`

```tsx
<MapReader>
  {(proxy: MapProxy) => (
    <Map onTapGesture={{ perform: (p) => {
      const coord = proxy.convertPoint(p);   // 投影取不到时返回 null
      ...
    }}} />
  )}
</MapReader>
```

`convertPoint` / `convertCoordinate` 由 MapKit 自己做投影，倾斜、旋转、任意
缩放都准。**不要再自己从 `cameraPosition` 反推跨度去插值**——那是这个 API
进来之前的权宜做法，`MapCameraPosition` 回写成哪种形态（region / rect /
camera / item）由 MapKit 决定，camera 形态下拿不到跨度，倾斜后是透视投影、
线性插值根本不成立。

### 2.14 坐标系：地图是 GCJ-02，设备是 WGS-84

界面上存的是地图系坐标，下发前用 `toDeviceCoordinate` 转成 WGS-84。
中国境内两者差 300–500 米，**漏转就是整条街的偏差**。

反过来，`Location.reverseGeocode` 和 `Location.requestCurrent` 给的是 WGS-84，
摆到地图上要先 `fromDeviceCoordinate`。

### 2.15 大陆设备搜不到境外地点，而且会给错答案

全球搜索走的是 Cloudflare Worker 中转 Nominatim（`api/searchApi.ts`）。
**不要试图用系统接口替掉它。** 2026-10-16 在大陆 iPhone 实测：

| 调用 | 结果 |
|---|---|
| `MapSearch.locate("Eiffel Tower")` | 巴黎铁塔 @ 30.584, 103.728（**四川**的山寨） |
| `MapSearch.locate("Eiffel Tower", region=巴黎)` | `MKErrorDomain 4`（placemarkNotFound） |
| `MapSearch.locate("Times Square", region=纽约)` | `MKErrorDomain 4` |
| `Location.geocodeAddress("Eiffel Tower, Paris, France")` | 上海市崇明区埃菲尔铁塔 @ 31.730, 121.247 |
| `MapSearch.locate("王府井")`（对照） | 王府井步行街 @ 39.913, 116.412 ✓ |

大陆 iPhone 的地图数据源是高德，没有境外 POI。给境外 `region` 直接报错；
不给 `region` 则**拿国内同名建筑顶替**——返回一个格式正确、坐标完全错误的结果。

对定位模拟来说这比返回空更危险：用户以为定位到了巴黎，实际在成都。

### 2.16 一个脚本只能注册一个 Live Activity

```ts
// 错：注册两个，应用分不清运行中的活动该用哪个 builder，
//     灵动岛上直接渲染成红色的「错误」
LiveActivity.register("WlocSimulation", simulationBuilder);   // live_activity.tsx
LiveActivity.register("WlocPairingPin", pairingBuilder);      // pairing_activity.tsx

// 对：一个注册，状态里带字段分流
const builder = (state) =>
  state.kind === "pairing" ? pairingUI(state) : simulationUI(state);
LiveActivity.register("WlocSimulation", builder);
```

文档里没写这条限制（`live_activity/zh.md` 只给了单个 `register` 的例子），
是实测撞出来的。需要多种卡片样式时，用同一个注册 + 状态字段分流，
别为每种样式各注册一个。

现在配对 PIN 和定位模拟共用 `SimulationState`，靠 `kind` 区分。
用不上的字段给中性值即可（见 `pages/PairingPage.tsx` 的 `pairingCardState`）。

### 2.17 毛玻璃浮层压在地图上，一拖就掉帧

`glassEffect` 要实时采样背后的内容再做模糊，而浮层背后是 MapKit 的地图。
浮层每移动一帧就得跨这层边界重采样一次——静止时没事，拖起来一帧一跳。

摇杆卡片的处理是按状态切：

```tsx
// 静止时和周围浮层一个质感；只在拖动的那几百毫秒降级成不透明底
glassEffect={dragging ? undefined : { type: "rect", cornerRadius: 24 }}
background={dragging ? <RoundedRectangle fill="rgba(28,28,32,0.9)" /> : undefined}
```

同理，跟着手指动的元素（摇杆帽）阴影半径要压小：半径越大，每帧要重算的
范围越大。原生那版（`RoamControl/Features/Joystick/JoystickPad.swift`）
踩的是同一个坑，那边的注释写得更细。

### 2.18 手势挂在会移动的视图上，坐标空间必须是 `global`

```tsx
// 错：把手随卡片一起移动，local 坐标系的原点跟着动，
//     translation 的基准被逐帧改写——位移被吃掉一部分（跟不上手指），
//     误差还逐帧累积（抖）
onDragGesture={{ minDistance: 0, onChanged: ... }}

// 对：钉在全局坐标系上，起点才是固定的
onDragGesture={{ minDistance: 0, coordinateSpace: "global", onChanged: ... }}
```

另外拖动把手上不该有点按行为，这样 `minDistance` 才能取 0。默认的 10 点
意味着手指要先划过一段才开始动，同样是「不跟手」。

### 2.19 别每个 tick 都写 `cameraPosition`

写它就是在抢相机控制权。用户正在捏合或平移时，我们下一次写入会直接把
手势顶掉——表现是「地图缩放不了、一拖就弹回中间」。

摇杆试过两版自动跟随都不行：每 tick 跟一次，手势根本做不完；改成只在
目标快出视野时才跟，用户一平移就立刻越界，照样被拽回。**根子在于谁控制
相机，不是判断条件的松紧。**

最后的做法是不自动跟随，卡片上给一个准星按钮，用户要居中时自己点一下
（`recenterCoord`）。要读当前镜头状态时注意 MapKit 回写成
`region` / `rect` / `camera` / `item` 四种形态由它自己定，`rect` 的 size
是米、`camera` 只有视距，都得换算（见 `pages/MapPage.tsx` 的 `currentSpan`）。

### 2.20 模拟进行中别去问 `Location.requestCurrent`

模拟期间系统返回什么由它说了算，实测会给一个几小时前的缓存。曾经因此
出现路线起点落在一千多公里外的陈旧位置上，然后用步行方式规划，
MapKit 自然算不出来，界面上就是「规划不出来」。

正在模拟时，「当前位置」就是我们自己下发的那个坐标，直接用 `activeLoc`。
只有没在模拟时才去问真实定位，而且要带 `forceRequest`——缓存返回得快，
但可能是上一个城市的。两种情况都要包超时，拿不到就明确让用户手动指定起点。

### 2.21 日志缓冲区常开，`DEBUG` 只管要不要往终端刷

`core/debug.ts` 里的环形缓冲（最近 400 条）**不受 `DEBUG` 控制**，这是有意的：
手机上出了问题，不可能让用户为了看日志去改一行代码再重跑一遍，那时候现场
早没了。缓冲常开，「连接状态」页点一下就能整段复制进 issue。

开销是 400 条字符串、约 40 KB，可以忽略。真正有成本的是 `console.log` 走
JS→原生 bridge，那个才归 `DEBUG` 管，默认 `false`。

写日志仍然只记长度不记内容（见 2.9）。

### 2.22 长文案别用系统 `alert` / `confirm`

系统弹窗的正文**不滚动**：行数一多就自己压字号，再多直接截断。而这个项目里
最该让人读清楚的恰恰是最长的那几段——`loopbackOnlyFailure` 带着四步操作指引，
配对说明带着「设置 → 隐私与安全性 → 开发者 → 配对」这条路径，都是十几行。
实测在 `Dialog.confirm` 里会被挤成一团。

统一走 `pages/MessageSheet.tsx`（半屏 sheet）：

- **`presentationDetents` 要跟着内容走**，不要一律 `medium`。有正文给
  `["medium", "large"]`（可往上拉读全文），只有一行标题时压到 `[0.3]`——
  否则一句「请先在地图上选择位置」会是一个圆标加一行字吊在半块屏幕里。
- **第一行当标题、其余作正文**。诊断文案本来就是「结论 + 详情」结构，
  调用时把结论放第一行即可，不必额外传 title。
- **正文必须包 `ScrollView`**，这是换 sheet 的全部意义。
- **一个视图只能挂一个 `sheet`**。主界面 `ZStack` 那个已经被功能页占着，
  提示浮层挂在包住 `MapPage` 的 `Group` 上——`Group` 是透明容器，不影响层叠。
- 确认态把主按钮放**上面**、取消放下面。系统 alert 是反的（取消在上），
  手指自然落点在下面那颗，于是最该谨慎的操作反而最好按。

两种情况**保留**系统弹窗，不要一刀切：`Dialog.prompt`（要文本输入，系统那个
自带 `selectAll` / 默认值 / 键盘处理，自己用 `TextField` 重做一遍不划算），
以及 `MovementPanel` 里那个 `alert`——那个面板自己就活在 sheet 里，再叠一层会把它盖住。

`Dialog.actionSheet` 分两种看：**破坏性操作确认**（删除收藏、清空全部）留着，
红色 destructive 是系统惯例；**带说明的决策**（如启动时「上次的模拟没有正常结束」）
该换——actionSheet 把说明压成小字顶在列表上方，而那是进应用看到的第一件事。
换过去时注意：**下拉关闭不会触发 `onDismiss`**，所以「用户明确表示不要」才该做的事
（那里是 `clearRecovery`）放 `onDismiss`，下拉只当误触，下次启动照样提醒。

### 2.23 空状态用 `ContentUnavailableView`，别手搓

`Image` + 两行 `Text` 叠出来的空状态，字号、灰阶、间距全是写死的常量，
换了动态字号或深色模式就得各自再调。系统为这个场景提供了标准件：

```tsx
<ContentUnavailableView title="暂无收藏" systemImage="star" description="在地图上选好位置后点击「收藏」" />
```

官方示例把它挂在 `List` 的 `overlay` 上，**这个项目不能那么用**：
收藏页没有收藏时，下面还有「历史」要显示，overlay 会把整个列表盖住。
放进对应的 `Section` 里即可。

### 2.24 别用 `declare const X: any` 糊类型缺口

`FavoritesPage` 曾有一行 `declare const Dialog: any`、`utils/coords.ts` 有一行
`declare const fetch: ...`。`Dialog` 在 `dts/global.d.ts` 里本来就有完整的 namespace
定义，这行 `any` 等于把那一整个文件里的 Dialog 调用全部移出类型检查。
两行都已删除，删完类型检查依旧 0 错误——它们从一开始就是多余的。

真正的类型缺口长这样（`core/crypto_utils.ts`）：Web Crypto 的标准类型里没有
HKDF-SHA512 和 X25519，只能 `as any`。这种有注释说明的个例可以留，
整个全局对象塞成 `any` 不行。

### 2.25 `localDevVPN.getState()` 会抛，而且在某些设备上每次都抛

这个 API 用 `expectedState` 做乐观并发控制：读的那一瞬间配置被别处改动，就抛

```
LocalDevVPN settings or the active configuration changed. Read again before saving.
```

它说的是「**这次没读到**」，不是「隧道坏了」。代理工具连接 / 断开 / 切节点都会
改动系统的活动 VPN 配置，撞上的概率不低。`VPN.getState()` 有同款
（`...changed while reading`）。

**2026-10-16 真机（iOS 27.0.1 + 代理模式）：它每次必抛**，连试三次都一样。
乐观并发冲突本该是瞬时的，持续失败疑似宿主侧状态不一致——脚本只能绕，不能修。
同一台设备上 TLS 取证回了 `serverHello`、Bonjour 公告的是 WiFi 地址，
握手 / 配对 / 端口 / 隧道协商全部正常，唯一的障碍就是这个读取。

#### 按用途分两类，别逐处打补丁

`session.ts` 里有 7 处读这个状态，其中 **4 处只是写一行日志或做可选判断**，
却都会中断启动。**2.6.1 只修了其中一处，断点立刻挪到了下一处**——逐处打补丁
在这里是错的方法。现在分成：

- `readLocalDevState()` — 会抛，**只用于 builtIn 那条必须确认隧道生效的路径**。
  内含一次重试（那句报错字面上就是「再读一次」）。
- `tryReadLocalDevState()` — 读不到返回 `null`，**绝不中断**。凡是「读到了锦上
  添花、读不到也能继续」的地方一律走它。

写下 `// 只作记录` 的时候，要真的让它只作记录。`openDeviceChannel` 里那次读取
注释正是这么写的，却把整个启动断掉了——产物只有下面一行 `debugLog`。

轮询循环尤其要用不抛的版本：`if (!polled) continue`。轮询本来就有 20 次机会，
而「VPN 正在变化」恰恰是轮询期间最可能发生的事——我们等的就是它变完。

#### 诊断页「各项正常」不等于能连上

「连接状态」**只做到与设备握手为止**，不跑 pair-verify、不建隧道（那两步慢且有
副作用）。所以握手全绿、开始模拟却失败是完全可能的，断点在握手之后那三步里。

别据此告诉用户「功能没问题」——这个判断错过一次：诊断页显示红叉的那一项，
恰恰就是启动失败的同一个错误。

### 2.26 后台保活的三条铁律

保活是这个脚本的命根子：没有它，切去任意一个 App 几分钟，Scripting 就被系统
挂起，隧道断、定位弹回真实位置，而界面上什么都不会报。**下面三条是真机上用
掉线换来的，改保活之前先读完。**

#### 别按 `Script.env` 预判能不能保活

文档和 dts 都写着「仅当 `Script.env === "index"` 时可用」。照着写了个

```ts
if (Script.env !== "index") return;   // ← 2.7.1 的错
```

结果把首页 Tab 这个入口整个废掉了——Tab 跑在主 App 里，保活本来一直好好的。
用户的实际反馈是「随便打开个天气就断，几分钟必断，蜂窝压根没法用」。

能不能用**问 API 自己**：`keepAlive()` 被系统拒绝时 resolve(false)，环境不允许
时 reject（dts：`Audio failure resolves to false; access errors reject`）。
按环境名预判等于替它回答，而它的答案和文档不一致。

#### 在前台就申请好，回前台**不要**撤

dts 的原话是 `Request keepAlive() while foregrounded, before starting
background work.` —— 关键在 **while foregrounded**。

早先是「进后台时 keepAlive、回前台时 stopKeepAlive」，照文档「回到前台时停止
保活」写的。但按下电源键锁屏那一瞬，音频引擎来不及从 `background` 事件里预热，
App 几秒内就被挂起。文档那句针对的是「回到前台工作就结束」的脚本，而这里的会话
跨着前后台一直在跑：**建会话时（前台）就申请，一直持有到会话收尾**。

#### 引用计数按脚本算，不按调用算

dts：`stopKeepAlive() releases that script's request.` 同一个脚本里不管哪段代码
调 `stopKeepAlive()`，整份请求都没了。本脚本有两处要保活（模拟会话、配对输 PIN），
各调各的就会出现「模拟进行中去重新配对，配完一松手，模拟的保活被一起撤掉」——
而系统更新后边模拟边重新配对恰恰是常见操作。

所以统一走 `utils/keepalive.ts` 的 `retainKeepAlive(owner)` /
`releaseKeepAlive(owner)`，自己记一份持有者，最后一个松手才真的停。
**不要再直接调 `BackgroundKeeper.stopKeepAlive()`。**
这条不变量有自测守着：`_selftest/wloc-keepalive.test.ts`。

---

## 3. 开发流程

```bash
# 类型检查（dts 从 Scripting 的工作区复制到仓库根）
npx -y -p typescript@5.6 tsc --noEmit -p tsconfig.json

# 自测，脱机可跑，不需要设备（247 项）
npx -y tsx _selftest/wloc-engine.test.ts      # 字节序、plist、归档、握手原语、配对记录导出
npx -y tsx _selftest/wloc-movement.test.ts    # 球面几何、路径推进、往返、摇杆、GPX
npx -y tsx _selftest/wloc-pairverify.test.ts  # pair-verify 四步与密钥派生
npx -y tsx _selftest/wloc-rsd.test.ts         # HTTP/2 帧、RemoteXPC、服务发现
npx -y tsx _selftest/wloc-redact.test.ts      # 日志脱敏：该打码的打掉、该留的留住
npx -y tsx _selftest/wloc-coords.test.ts      # 链接解析、坐标系判定与换算、值域校验
npx -y tsx _selftest/wloc-keepalive.test.ts   # 保活持有者记账（见 2.26）

# 打包发布产物
python build-release.py
```

**协议层的改动必须补自测。** 往返测试最有价值：编码 → 解码 → 比对。
加配对记录导出时就是靠它抓出了「写入转义了、读取没反转义」。

**自测样本一律用虚构值。** 写脱敏那组测试时顺手贴了一份真机日志进来——里面是
实际位置、住处附近的街道名、设备 UUID，推上来就全公开了。格式照着真日志抄
（位数、结构、JSON 包裹方式），内容另造：坐标用公开地标，UUID 和 IPv6 用一眼
看得出是编的那种。`10.7.0.1` 这类公开约定值可以照用。

### 发布

- `dist/<名字>.zip`，**zip 根目录必须直接是 `script.json` + `index.tsx`**，
  多包一层目录应用就认不出来（`build-release.py` 会断言这一点）
- `script.json` 的 `remoteResource.url` 指向 **raw zip 地址**，不是仓库地址
- **不要设 `autoUpdateInterval`** ——会按间隔自动覆盖设备上的脚本，开发期间很坑
- 改了代码记得把 `version` 往上提，否则用户看不出有更新
- 自测文件在仓库里是 `_selftest/`，和 Scripting 工作区的目录层级不同：
  工作区里脚本在 `scripts/WLOC 虚拟定位/`，仓库里在根下。从工作区同步过来时
  相对路径要跟着换：`../scripts/WLOC 虚拟定位/` → `../WLOC 虚拟定位/`

安装链接的拼法：

```
https://www.scripting.fun/import_scripts/?urls=<URL 编码的 JSON 数组>
```

数组元素是 zip 的 **raw 地址**，可以一次塞多个。本仓库当前的链接：

[https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FWLOC.zip%22%5D](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FWLOC.zip%22%5D)

换了 zip 名字或仓库路径之后记得把 README 里那个链接一起改——
它是用户唯一的安装入口，改漏了就是 404。

---

## 4. 已知限制（不是 bug，别重复排查）

- **金融类应用改不了位置**。系统给模拟位置打 `isSimulatedBySoftware` 标记。
  本项目不绕过，相关 PR 不会被接受。
- **停止模拟后系统地图未必立刻回到真实位置**。拿 Xcode 做对照也一样，根因未明。
  打开地图 App 触发一次真实定位即可。
- **步频 / 步数做不了**。`LocationSimulation` 只有
  `simulateLocationWithLatitude:longitude:`，步数属于 CMPedometer / HealthKit，
  硬件层面隔离。原生实现同样没有。
- **代理工具模式要点**：自身隧道会是 inactive（回环由代理提供），**不要拿它当
  拦截条件**；同时要打开 `LocalDevVPN` 开关但**不要**启动 Scripting 自己的 VPN——
  前者是 `openRSDTunnel` 的前提，后者会抢掉代理工具的 VPN 名额。两件事都栽过。
- **隧道开着时系统的地理编码有时查不出来**。iOS 同时只允许一条 VPN，本机回环占着
  那个名额。不是必然失败——多数地点照常返回，少数查不到。想稳妥的话
  **先选点等地名出来，再开始模拟**，结果有缓存。
- **蜂窝数据下要开关一次飞行模式**。三个错误码串起来才是完整链条，实测顺序：

  | 状态 | 错误 | 含义 |
  |---|---|---|
  | 5G 下直接开始 | `ECONNREFUSED` | 流量到了本机，但那个端口上没有服务 |
  | 飞行模式开着 | `ENETUNREACH` | 连 `10.7.0.1` 这条路由都不存在 |
  | 飞行模式关掉后 | 连上 | — |

  **起作用的是「关掉」那一下**，不是「开着」的时候：网络栈重置 → TUN 重连 →
  `remotepairingd` 重新注册并广播。原生那版（见其 CHANGELOG 1.0.7 和
  `MobileDataGuidanceView`）给的机制是「撤掉蜂窝接口让 mDNS 回到本地」，
  但那个说法在代理工具提供隧道时不成立——隧道本身也依附于网络接口，
  飞行模式一开它跟着断，所以开着的时候必然是 `ENETUNREACH`。

  引导 UI（`pages/CellularGuide.tsx`）因此要明说「开着时连不上是正常的」，
  否则用户会以为是又失败了。三个错误码在 `describePairingFailure` 里分开处理，
  **不能混成一句**：`ECONNREFUSED`（没服务）、`ENETUNREACH`（没路由）、
  超时（石沉大海）指向完全不同的动作。

- **蜂窝下的真正原因：`remotepairingd` 只绑回环**。上面那条讲的是现象和操作，
  这条是 2026-10-16 查到的机制。关键证据是两个错误码的区别：

  | 地址 | 错误 | 发生在 | 含义 |
  |---|---|---|---|
  | `10.7.0.1:49152` | `ECONNREFUSED` | `connect` | 没人听 |
  | `127.0.0.1:49152` | `ECONNRESET` | **`read`** | **连上了**，对面读完才砍 |

  `ECONNRESET on read` 说明三次握手成功、服务确实在那儿。而同一轮 Bonjour 公告的
  地址只有 `127.0.0.1` 和 `::1`——**没有任何网络接口地址**。公告反映的就是实际
  绑定情况，所以：蜂窝下 `remotepairingd` 缩回回环，WiFi 下才绑 ANY。
  回环又不被接受（`localDevVPN` 这层隧道存在的意义就是让连接看起来像远程），
  两头堵死。开关飞行模式起作用，是因为接口重建会让它重新绑定。

  由此有三条实现要求：
  1. **Bonjour 的地址和端口一样重要**。`discoverPairingService` 要返回
     `{ port, addresses }`，候选是「隧道对端排第一 + 公告地址跟后面」逐个试，
     这也是原生版 `LocalDeviceSessionCoordinator.candidatePeerAddresses` 的做法。
     只取端口、一律连 `10.7.0.1`，蜂窝下必然失败。
  2. **回环地址不要全段扫描**。服务就在公告的那个端口上，扫出别的端口同样连不通，
     每个还要赔 6 秒握手超时——三个地址各扫一遍白费 20 秒。
  3. **公告地址全是回环 = 可以确诊**，直接给结论，别再列「开发者模式开了吗」
     那串猜测。见 `loopbackOnlyFailure`。
- **换代理工具解决不了「只绑回环」**。2026-10-16 实测 Surge（proxyApp 模式）与
  Scripting 自身隧道结果完全一致。原因在 `reflect` 的语义——
  [Surge 手册](https://manual.nssurge.com/features/ip-rewrite.html)写明 `[IP Rewrite]`
  只有 `reflect` / `reject` / `drop` 三个动作，**没有「改写到指定 IP」**，而
  `reflect` 做的是**交换源/目的地址**把包送回发送方。所以发往 `10.7.0.1:49152`
  的包反射后目标是 **TUN(VIF) 自己的地址**，不是 `127.0.0.1`——`remotepairingd`
  在那儿不听，`ECONNREFUSED` 是必然。Loon 的 `include-tun` + reflect 同义。
  想靠绑定源地址凑出 `127.0.0.1` 也不行：源地址必须属于出接口，内核不会让
  lo0 的地址走 utun。

  顺带一提，代理模式下 `10.7.0.1` 得到的是 `ECONNREFUSED` 而不是超时，这正是
  **reflect 生效的证据**（包回到了本机，是本机回的 RST）。别把它读成「代理没配好」。
- **重建 utun 不能代替飞行模式，别再试这个方向**。推理看着很顺：`remotepairingd`
  像是在接口出现时才绑定的，飞行模式真正做的事无非是让接口重建一遍，而 utun
  也是接口——所以 `VPN.stop()` → `VPN.start()` 应该等价，还能免掉用户那趟控制中心。
  **2026-10-16 实测无效**：重建完公告里依然只有 `127.0.0.1` 和 `::1`。
  它要的不是「有接口变化」，而是蜂窝/WiFi 接口本身重建，utun 顶替不了。
  相关代码已删，`session.ts` 里留了一段注释记着这个结论。
- **状态不会自己变的失败，别刷满日志**。真机日志 282 条里八成是引导把那段
  十几行的操作指引整段记了 14 遍，真正有用的几行反而要翻半天。这类失败
  （`ENETUNREACH`、「只绑回环」）在引导里各记一行短的就够，详情看第一次那条。
- **握手超时 ≠ 连接超时**。`message.includes("超时")` 会把两者混成一句
  「本机隧道可能没真正建立」，而握手超时恰恰说明 TCP 连上了。蜂窝下扫到的
  `50370` 是上一轮会话遗留的隧道监听（它等的是 TLS-PSK），照旧文案会把人
  引去查隧道，隧道其实好好的。
- **连不上时先弹引导，别直接甩错误**。读不到网络类型（Scripting 没有这个 API），
  所以照原生版的做法让用户自己说在用什么网。关键是进入引导后**每 4 秒自动重试**——
  用户去控制中心切飞行模式、再切回来的这段时间脚本自己在试，连上就跳到下一阶段，
  不用每切一次都回来手动点。循环里要有「上一轮没跑完就跳过」的闸，
  否则几条建会话流程会叠在一起。
- **端口缓存失效要能回退**。配对端口是动态的，重启和切换网络都会换。
  缓存命中时直接返回、连不上就判死刑的话，日志里只剩一句「试过 1 个端口」。
  现在第一轮失败且候选只有缓存那一个时，会清掉缓存再走一轮全量扫描。
- **更新系统后要重新配对**。设备侧的授权会随系统更新失效；本地记录和握手都还正常，
  卡在建隧道那一步。日常重启不受影响。

---

## 5. 和原生版的关系

同类的原生实现是 **[seanhowarthdev/Roam-Control](https://github.com/seanhowarthdev/Roam-Control)**（MIT，Swift）。
协议层可以对照它读，但那是原生 App，有些事它能做我们做不到：

| | 原生（Roam Control） | 这个脚本 |
|---|---|---|
| 地图选点 | `MapReader` + `proxy.convert(_:from:)` | 手算跨度 + 线性插值（见 2.13） |
| 相机跟踪 | `onMapCameraChange(frequency: .continuous)` | 只有手势结束时回写 |
| 后台 | Info.plist 的 background modes | `BackgroundKeeper` 保活队列 |
| 实时活动 | ActivityKit 直接用 | `LiveActivity.register` + 独立文件 |

**不要照搬它的后台方案**——两边机制完全不同，照搬没有意义。
协议细节可以对照（它和本项目都以 idevice 为真值），UI 和系统集成一律按
Scripting 的文档与 dts 来。

---

## 6. 还没做的

按价值排序，想动手可以从这里挑：

1. **`index.tsx` 1700 多行**，该拆。可参考 Roam Control 的分法：
   `live_activity_controller`（卡片控制）、`path_simulation`（移动编排）、
   `route_planner`（路线）、`map_link`（从 coords.ts 拆出链接解析）。
2. **2.7 那个 stale closure**，用 ref 存最新回调根治。
3. **坐标格式化散落 14 处**、**速度换算 `* 3.6` 散落 10 处**，该各提一个函数。
