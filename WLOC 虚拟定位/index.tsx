// WLOC 虚拟定位 —— Scripting 应用上的本机定位模拟脚本
// Copyright (C) 2026 ios151
//
// 本程序是自由软件：你可以依据自由软件基金会发布的 GNU 通用公共许可证
// （第 3 版或任何后续版本）条款重新分发和/或修改它。
//
// 分发本程序是希望它能派上用场，但不提供任何担保；甚至不包含适销性或
// 特定用途适用性的默示担保。详见 GNU 通用公共许可证。
//
// 你应当已随本程序收到一份 GNU 通用公共许可证副本（见 LICENSE）；
// 如果没有，请见 <https://www.gnu.org/licenses/>。

// WLOC 虚拟定位 — 入口
//
// 在地图上选点，经苹果官方开发者接口（本机隧道 → RemotePairing → RSD → DVT）
// 把坐标下发给本机，与 Xcode 的 Simulate Location 同一套机制。
//
// 坐标显示和操作按钮在 App 层渲染（与 Map 平级），避免 Map 的 SwiftUI 渲染隔离。

import {
  Script,
  Navigation,
  useEffect,
  useObservable,
  useRef,
  useState,
  ZStack,
  Group,
  Rectangle,
  VStack,
  HStack,
  Text,
  Spacer,
  Image,
  Button,
  AppEvents,
  LiveActivity,
  type ScenePhase,
  type VirtualNode,
  type Color,
  type KeywordPoint,
  type ScriptingApi,
} from "scripting";
// Animation 与 withAnimation 是全局声明，不从 "scripting" 导出，直接用即可。
import type { ActiveLocation, AppSettings, Coordinate, FavoriteLocation, MapLayerId, PickTarget, SessionState } from "./types";
import {
  loadFavorites,
  addFavorite,
  removeFavorite,
  clearFavorites,
  loadHistory,
  addHistory,
  clearHistory,
  loadSettings,
  saveSettings,
  saveActiveCache,
  loadRecovery,
  saveRecovery,
  clearRecovery,
  endpointFromSettings,
  saveSessionID,
  clearSessionID,
} from "./utils/storage";
import { MapPage } from "./pages/MapPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { PairingPage } from "./pages/PairingPage";
import { SearchPage } from "./pages/SearchPage";
import { AboutPage } from "./pages/AboutPage";
import { MovementPanel, type MovementSelection } from "./pages/MovementPanel";
import { JoystickPad } from "./pages/JoystickPad";
import { CellularGuide, type GuideStage } from "./pages/CellularGuide";
import { MessageSheet, type MessageAction, type MessageTone } from "./pages/MessageSheet";
import {
  applyJitter,
  coordinateReadout,
  formatLatLng,
  fromDeviceCoordinate,
  parseAndConvert,
  toDeviceCoordinate,
} from "./utils/coords";
import { openAppSettings } from "./utils/appSettings";
import { releaseKeepAlive, retainKeepAlive } from "./utils/keepalive";
import { loadPairing, type PairingRecord } from "./core/pairing";
import { debugLog, describeError } from "./core/debug";
import { restoreRealLocation, startLocationSession, type LocationSessionHandle } from "./core/session";
import { defaultSpeed, joystickStep, modeInfo, PathWalker, type WalkState } from "./core/movement";
import { parseGPX } from "./core/gpx";
import { distanceBetween } from "./core/geo";
import { delay, withTimeout } from "./core/stream";
import { DEFAULT_GLOBAL_ENDPOINT, reverseGlobalPlace } from "./api/searchApi";
import { SimulationLiveActivity, type SimulationState } from "./live_activity";

type SheetKind = "settings" | "favorites" | "search" | "movement" | null;

/** 收起式菜单里的一个入口。 */
interface MenuEntry {
  icon: string;
  tint: Color;
  action: () => void;
}

/** 移动模拟的推进间隔。与 wloc（iOS）一致，太密会让 DTX 队列排不过来。 */
const MOVEMENT_TICK_MS = 500;
/*
  一拍最多按这么长算。

  `setInterval` 在系统忙或 App 被挂起时会延迟、甚至把多拍合并成一次（dts 写明
  了这一点），所以不能一律按 500 ms 推进——那样算出来的速度永远偏低，锁屏一会儿
  再回来，走过的距离比该走的少一大截。改成按**实际经过的时间**推进。

  但也不能无限补：挂起十分钟再回来，一次补完十分钟的距离等于瞬移。2 秒是
  上限，超出的部分直接丢掉。
*/
const MOVEMENT_MAX_STEP_S = 2;
/*
  恢复记录最多多久刷一次。

  它要记的是「最后模拟到哪」，所以得跟着下发走；但移动时每 0.5 秒下发一次，
  每次都写一遍 Storage 没必要。5 秒的粒度足够——真崩在中途，位置差几米
  不影响用户判断要不要恢复。
*/
const RECOVERY_SAVE_MS = 5000;
/*
  断线重连的节奏。
  关掉飞行模式后网络要几秒才稳，2 秒一次、试 5 次≈10 秒，足够跨过切换期；
  再连不上就如实报错，别无限转圈。
*/
const RECONNECT_DELAY_MS = 2000;
const RECONNECT_TRIES = 5;

/**
 * 这次是作为 Scripting 首页的 Tab 在跑，而不是从脚本列表点开的一次运行。
 *
 * 两者的差别不止是入口：Tab 上的实例**常驻**（切走再切回来状态还在），
 * 没有可以关闭的模态，也不该调 `Script.exit()`。
 */
const IS_HOME_TAB = Script.env === "home_screen";

/** 当前在跑哪种移动。 */
type MovementKind = "none" | "route" | "joystick";

interface PlannedRoute {
  name?: string;
  coordinates: Coordinate[];
  distance: number;
  travelTime: number;
}

export interface AppProps {
  /**
   * 分享表单 / 快捷指令传进来的落点，由 `intent.tsx` 解析好后传入。
   * 不传就是正常启动。
   */
  shared?: { latitude: number; longitude: number; name?: string };
}

/**
 * 整个界面。
 *
 * 导出是给另外两个入口用的：`home_screen_default_ui.tsx`（首页 Tab 直接挂载
 * 这个组件，不走 `Navigation.present`）和 `intent.tsx`（分享进来时带一个落点）。
 */
export function App({ shared }: AppProps = {}) {
  const dismiss = Navigation.useDismiss();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [favorites, setFavorites] = useState<FavoriteLocation[]>(() => loadFavorites());
  const [history, setHistory] = useState<FavoriteLocation[]>(() => loadHistory());
  const [pairing, setPairing] = useState<PairingRecord | null>(() => loadPairing());
  /*
    设置和配对记录的「当前值」。

    只挂一次的 effect（会话通道、网络监听）里**不能直接读 state**：那些闭包捕获
    的是首次渲染时的值，之后用户在本次运行里完成配对、或者改了隧道来源，它们
    一概看不见——引导会拿着一份空的配对记录一直重试。
    每次渲染同步一下，用的地方读 `.current`。
  */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [showCredit, setShowCredit] = useState(true);

  const session = useObservable<LocationSessionHandle | null>(null);

  // 移动模拟：推进器与定时器放 observable 里，避免重渲染时被重建。
  const [movementKind, setMovementKind] = useState<MovementKind>("none");
  const [paused, setPaused] = useState(false);
  const [selection, setSelection] = useState<MovementSelection>(() => ({
    mode: "walking",
    speed: defaultSpeed("walking"),
    lapPlan: "oneWay",
  }));
  /*
    移动方式和参数另存一份 ref，理由同 placeNameRef。

    移动的推进定时器是在点「开始」那一帧建的，那时 `movementKind` 还是 "none"，
    之后的重渲染**改不到这个闭包**。而卡片每一拍都经
    `pushCoordinate → updateLiveActivity` 构造，只读 state 的话永远是定点的样子：
    方式为空、速度 0、没有进度条。
    界面渲染照常用 state，只有卡片那条路读 ref。
  */
  const movementKindRef = useRef<MovementKind>("none");
  const selectionRef = useRef(selection);
  /**
   * 最后一次真正下发给设备的地图坐标。掉线重连就回到它。
   *
   * 以前重连目标是**建会话时**定死的（`connectSession` 的 `reconnectTo` 参数），
   * 于是点过「更新坐标」之后再掉线，会被拉回最初那个点。原生版的做法是每次
   * 下发都更新重连目标，这里照搬。
   */
  const lastPushed = useRef<Coordinate | null>(null);

  /** 写移动方式。两份一起写——别绕过它直接调 `setMovementKind`。 */
  function updateMovementKind(kind: MovementKind) {
    movementKindRef.current = kind;
    setMovementKind(kind);
  }

  /** 写移动参数。两份一起写——别绕过它直接调 `setSelection`。 */
  function updateSelection(choice: MovementSelection) {
    selectionRef.current = choice;
    setSelection(choice);
  }
  /** 规划出的全部方案，选中的那条才是要走的。 */
  const [routes, setRoutes] = useState<PlannedRoute[]>([]);
  const [routeIndex, setRouteIndex] = useState(0);
  /** 路线起点；null 表示用当前真实位置。 */
  const [routeStart, setRouteStart] = useState<Coordinate | null>(null);
  const [drawnPath, setDrawnPath] = useState<Coordinate[]>([]);
  /**
   * 手绘模式：开着的时候，点地图就是落一个点。
   *
   * 用 Observable 而不是 useState，是因为地图的选点回调里有一条（POI 选中）
   * 挂在 `[]` 依赖的 useEffect 上，拿到的是首帧的闭包——读 state 会永远是初始值。
   */
  const drawing = useObservable(false);
  /** 同上：落点要基于最新的点列，不能用闭包里那份快照。 */
  const drawnRef = useRef<Coordinate[]>([]);
  /** 正在自动重连，挡住重连过程中再次触发的掉线回调。 */
  /** 正在重连。observable 而非 ref——底部卡片要据此显示「取消」按钮。 */
  const reconnecting = useObservable(false);
  /** 本次会话的开始时间（ISO）。刷新恢复记录时要保留它，不能每次都改成当前时刻。 */
  const recoveryStartedAt = useRef("");
  /** 上次刷新恢复记录的时刻，配合 RECOVERY_SAVE_MS 节流。 */
  const recoverySavedAt = useRef(0);

  /** 用户在重连期间按了「取消」。下一轮开始前会看它。 */
  const reconnectCancelled = useRef(false);
  /** 反查过的地名。空串表示查过但没有结果，避免对同一个点反复请求。 */
  const placeCache = useRef(new Map<string, string>());
  const walker = useObservable<PathWalker | null>(null);
  const movementTimer = useObservable<ReturnType<typeof setInterval> | null>(null);
  const joystickVector = useObservable({ dx: 0, dy: 0 });
  /** 摇杆卡片被拖到哪儿了。浮层总会挡住一部分地图，挡哪儿由用户决定。 */
  const joystickOffset = useObservable({ x: 0, y: 0 });
  const joystickPosition = useObservable<Coordinate | null>(null);
  /** 锁屏/灵动岛卡片。脚本被划掉后它仍在，是「忘了恢复」的最后一道提醒。 */
  const liveActivity = useObservable(() => SimulationLiveActivity());
  const [placeName, setPlaceName] = useState("");
  /*
    地名另存一份 ref。

    卡片内容要在写入地名之后**立刻**构造（见 applyPlaceName 末尾那次刷新），
    而 state 更新是异步的——那一刻闭包里拿到的还是上一个值，卡片会被刷成旧地名，
    看起来就像「刷新了但没生效」。界面渲染照常用 state，只有卡片那条路读 ref。
  */
  const placeNameRef = useRef("");

  /** 写地名。两份一起写，别单独调 setPlaceName。 */
  function updatePlaceName(label: string) {
    placeNameRef.current = label;
    setPlaceName(label);
  }

  // 当前选点（来自搜索/链接解析/收藏），供 MapPage 监听并跳转
  const pendingCoord = useObservable<PickTarget | null>(null);
  /*
    蜂窝数据引导的状态。
    guideStart/guideError 用 ref：它们只在回调里读写，进渲染只会多出无谓的重绘。
  */
  const guideStage = useObservable<GuideStage | null>(null);
  const guideAttempts = useObservable(0);
  /**
   * 当前是不是走蜂窝。`null` = 还没测出来。
   *
   * `Device.getNetworkState()` 是 2026-10-16 那版 TF 新加的。在那之前读不到
   * 网络类型，蜂窝引导只能开口问用户「你在用 WiFi 还是流量」——而用户自己
   * 往往也说不准（连着 WiFi 却走蜂窝太常见）。
   */
  const onCellular = useObservable<boolean | null>(null);
  const guideStart = useRef<Coordinate | null>(null);
  const guideError = useRef<unknown>(null);
  const guideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 正在跑一次建会话。轮询和「继续」可能撞上，用它互斥。 */
  const guideBusy = useRef(false);
  /** 轮次号。过期那一轮迟到的结果一律丢弃，不许它改状态。 */
  const guideRun = useRef(0);

  /** 把镜头移到这个点（摇杆卡片上的准星）。保留当前缩放，不动选中点。 */
  const recenterCoord = useObservable<Coordinate | null>(null);

  // 坐标状态（App 层管理）
  const coordLat = useObservable(0);
  const coordLng = useObservable(0);
  const coordReady = useObservable(false);
  const activeLoc = useObservable<ActiveLocation | null>(null);

  const layer = useObservable<MapLayerId>(settings.defaultLayer);

  const sheetKind = useObservable<SheetKind>(null);
  const showSheet = useObservable(false);
  /** 顶部功能入口是否展开。收起时只留关闭与齿轮两个按钮。 */
  const menuOpen = useObservable(false);

  const toastMsg = useObservable("");
  const showToast = useObservable(false);

  const errorMsg = useObservable("");
  const showError = useObservable(false);

  function fireToast(msg: string) {
    toastMsg.setValue(msg);
    showToast.setValue(true);
  }

  /*
    提示浮层的附加配置。

    放 ref 不放 state：它总是和 errorMsg 一起设，而 errorMsg 是 observable，
    setValue 会触发重渲染，那时 ref 已经是新值了，再多一个 state 只是白跑一轮。
  */
  const messageOptions = useRef<{
    tone: MessageTone;
    action: MessageAction | null;
    dismissLabel?: string;
    onDismiss?: () => void;
  }>({ tone: "warning", action: null });

  /**
   * 弹半屏提示（`pages/MessageSheet`）。
   *
   * 第一行会被当成标题、其余作正文，所以写的时候把结论放第一行、
   * 详情换行跟在后面，别挤成一整段。
   *
   * @param options.tone  中性的说明用 `info`，默认是「没成功」的警示橙
   * @param options.action 给一颗主按钮，点完自动收起浮层——需要确认才做的事走这里
   * @param options.onDismiss 点次要按钮时跑。**下拉关闭不会触发它**，
   *                          所以这里只放「用户明确表示不要」才该做的事。
   */
  function showMessage(
    msg: string,
    options?: {
      tone?: MessageTone;
      action?: MessageAction;
      dismissLabel?: string;
      onDismiss?: () => void;
    },
  ) {
    messageOptions.current = {
      tone: options?.tone ?? "warning",
      action: options?.action ?? null,
      dismissLabel: options?.dismissLabel,
      onDismiss: options?.onDismiss,
    };
    errorMsg.setValue(msg);
    showError.setValue(true);
  }

  /**
   * 按脚本授权的结果。`null` = 还没问过（或这个环境不弹窗）。
   *
   * 只有用户在设置里打开「Require Per-Script Permission」时才真的拦截，
   * 但一旦打开、又拒掉了 `localDevVPN`，后面建隧道会直接报权限错——而那个错
   * 会一路漏到 `openRSDTunnel`，被包装成「建立加密隧道失败……卡在隧道握手
   * 这一步」，把人引去查隧道和代理，查不出所以然。
   */
  const granted = useRef<ScriptingApi[] | null>(null);

  /*
    一次性把 VPN / 本机隧道 / 定位的授权都申请掉，省得中途被弹窗打断。

    **结果必须留下来。** 以前是 `.catch(() => undefined)` 把返回值整个丢了，
    等于白问一场。clipboard / fileSystem 故意不在这里申请：按最小权限，
    等真要读剪贴板或导入文件时再弹，用不到那些功能的人不该被问。
  */
  useEffect(() => {
    void Script.requestAccess(["vpn", "localDevVPN", "location"])
      .then((list) => {
        granted.current = list;
        debugLog("perm", `已授权：${list.join("、") || "（无）"}`);
      })
      .catch((error) => {
        // 没有呈现视图的环境（Widget / 分享扩展等）不弹窗，这里也拿不到结果。
        debugLog("perm", "申请授权失败", describeError(error));
      });
  }, []);

  /**
   * 建会话前先过一道权限闸。
   *
   * @returns 缺的那项能力名；齐全或无从判断时返回 null
   */
  function missingAccess(): ScriptingApi | null {
    const list = granted.current;
    // 没问过就别拦——「Require Per-Script Permission」默认是关的，
    // 这种情况下 requestAccess 本来就不弹窗，拦了反而误伤。
    if (!list) return null;
    if (!list.includes("localDevVPN")) return "localDevVPN";
    // 代理模式下不需要 Scripting 自己的 VPN，名额本来就让出去了。
    if (settingsRef.current.tunnelSource === "builtIn" && !list.includes("vpn")) return "vpn";
    return null;
  }

  /**
   * 这个失败该不该弹蜂窝引导。
   *
   * 引导讲的是一件很具体的事：**找不到配对服务**，去开关一次飞行模式。只有
   * 「连不上那个端口」这一类错误才对得上。
   *
   * 以前建会话失败一律弹它，于是 pair-verify 被拒（系统更新后配对授权失效，
   * 该做的是重新配对）、权限被拒、隧道握手失败，统统显示成「连不上这台设备」
   * 外加一段讲蜂窝 mDNS 的说明——方向完全是错的。原生版也只把「隧道未就绪」
   * 那一类送进引导。
   */
  function shouldOfferGuide(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code ?? "";
    if (code === "ECONNREFUSED" || code === "ENETUNREACH" || code === "EHOSTUNREACH") return true;

    const message = error instanceof Error ? error.message : String(error);
    // 这几句都出自 describePairingFailure / loopbackOnlyFailure，说的都是
    // 「没找到能握手的配对服务」。
    if (message.includes("只绑在回环地址上")) return true;
    if (message.includes("没有开放端口")) return true;
    if (message.includes("拒绝了连接")) return true;
    if (message.includes("这条路由不存在")) return true;
    if (message.includes("没有响应")) return true;
    /*
      握手超时也算：连上了端口、对面不按 RPPairing 回话，和「找不到服务」
      是同一类处境。但**建隧道超时**不算——那时配对早就成功了，开关飞行
      模式解决不了，所以这里只认前者。
    */
    if (message.includes("握手超时")) return true;
    return false;
  }

  /** 权限被拒时的说明。两个入口共用。 */
  function accessDeniedMessage(api: ScriptingApi): string {
    const label = api === "vpn" ? "VPN" : "本机开发者隧道（LocalDevVPN）";
    return [
      `缺少「${label}」权限`,
      "这台设备开启了「按脚本单独授权」，而本脚本的这项权限被拒过。",
      "",
      "去 Scripting 的设置里找到本脚本的权限项重新允许，再回来开始模拟。",
      "整条链路都走系统的开发者通道，没有这项权限连不上设备。",
    ].join("\n");
  }


  useEffect(() => {
    const timer = setTimeout(() => setShowCredit(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  /*
     启动时清掉遗留的实时活动卡片。

     卡片的生命周期独立于脚本：脚本被划掉、会话异常中断时它都会留在灵动岛上，
     内容还停在当时那一刻。没有未收尾记录就说明上次是正常结束的，那张卡片
     纯属残留——留着会一直显示「正在模拟位置」，比没有卡片更误导。
     有未收尾记录时反而要留着，它正是提醒你去恢复的那个东西。
   */
  useEffect(() => {
    if (loadRecovery()) return;
    void LiveActivity.endAllActivities({ dismissTimeInterval: 0 })
      .then((ok) => debugLog("liveactivity", `清理遗留卡片：${ok}`))
      .catch(() => undefined);
  }, []);

  /*
    从分享表单带进来的落点。

    解析在 `intent.tsx` 里做完了——那才是分享 / 快捷指令的入口文件，这个
    组件只负责把结果落到地图上。
  */
  useEffect(() => {
    if (!shared) return;
    debugLog("intent", `分享落点 ${shared.latitude.toFixed(5)}, ${shared.longitude.toFixed(5)}`);
    handlePick({ latitude: shared.latitude, longitude: shared.longitude }, shared.name);
  }, []);

  /*
    跟踪网络类型。

    `addNetworkChangeListener` 会先给一次当前快照，之后只推变化——所以这一个
    监听既负责初始值，也负责后续。不必自己调一次 `getNetworkState()`
    （那个还要等系统给首个路径，最多 10 秒）。

    对蜂窝引导的意义不止是「不用问用户」：开关飞行模式那几秒，接口变化会从
    这里推过来，重试可以**由它驱动**，不必再 1.5 秒一次地盲试。隧道重连上的
    窗口很短，盲轮询常常整段错过。
  */
  useEffect(() => {
    // 分享 / 快捷指令环境下这一页只是过客，没有引导也不该挂监听。
    if (Script.env !== "index" && Script.env !== "home_screen") return;

    const listener = (state: Device.NetworkState) => {
      /*
        三态，不是是非题。

        接口列表里只有 `other`（代理工具的全局隧道会这样）或者干脆是空的时候，
        既不能说在用蜂窝、也不能说在用 WiFi。以前写成
        `includes("cellular") && !includes("wifi")`，这两种情况都会落成 false，
        引导于是一口咬定「检测到正在用 WiFi」——而用户可能正拿着 5G。
        拿不准就老实说拿不准，那一档的文案本来就是中性的。
      */
      const cellular = state.interfaces.includes("wifi")
        ? false
        : state.interfaces.includes("cellular")
          ? true
          : null;
      const before = onCellular.value;
      onCellular.setValue(cellular);
      debugLog("net", `接口 ${state.interfaces.join("/") || "无"}（${state.status}）`);

      /*
        正在等飞行模式切换时，网络一恢复就立刻试一次。

        这是比定时重试准得多的信号：用户关掉飞行模式的那一刻接口就回来了，
        而那正是配对服务重新上线的时候。定时器照常留着兜底。
      */
      if (guideStage.value === "airplaneOn" && before !== null && state.status === "satisfied") {
        debugLog("guide", "网络恢复，立刻重试一次");
        // 走 ref：这个 effect 只挂一次，直接调会永远用首次渲染那份
        // （连本次运行里刚配好的记录都看不见）。
        attemptInGuideRef.current();
      }
    };
    Device.addNetworkChangeListener(listener);
    return () => Device.removeNetworkChangeListener(listener);
  }, []);

  // 上次会话没正常收尾时主动问一句——设备那头可能还保持着模拟位置。
  useEffect(() => {
    const record = loadRecovery();
    if (!record) return;

    /*
      走提示浮层而不是系统 actionSheet。

      这是进应用看到的第一件事，而且是个有后果的决定——actionSheet 把说明压成
      小字顶在列表上方，坐标还得挤在里面。

      「暂不处理」才清记录，**下拉关掉不清**：下拉多半是误触，清掉之后下次
      启动就不再提醒了，而设备那头可能还保持着假位置。
    */
    showMessage(
      "上次的模拟没有正常结束\n" +
        `最后模拟到 ${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}。\n\n` +
        "设备可能仍保持着这个位置。现在连上去可以把它恢复成真实定位。",
      {
        tone: "info",
        action: { label: "恢复真实位置", run: () => void handleRestoreRealLocation() },
        dismissLabel: "暂不处理",
        onDismiss: clearRecovery,
      },
    );
  }, []);

  /** 不建立会话，只连上去补发一次停止指令。 */
  async function handleRestoreRealLocation() {
    const record = loadPairing();
    if (!record) {
      showMessage("请先在「配对」里导入配对记录，才能连上设备恢复");
      return;
    }

    setSessionState("connecting");
    setStatusMsg("连接设备以恢复…");
    try {
      await restoreRealLocation({
        record,
        endpoint: endpointFromSettings(settings),
        onStatus: setStatusMsg,
      });
      clearRecovery();
      activeLoc.setValue(null);
      saveActiveCache(null);
      void endLiveActivity();
      fireToast("已恢复真实位置");
    } catch (e) {
      debugLog("ui", "恢复失败", describeError(e));
      showMessage(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSessionState("idle");
      setStatusMsg("");
    }
  }

  function openSheet(kind: SheetKind) {
    sheetKind.setValue(kind);
    showSheet.setValue(true);
  }

  function closeSheet() {
    showSheet.setValue(false);
    setTimeout(() => sheetKind.setValue(null), 200);
  }

  function handleCloseApp() {
    dismiss();
  }

  /** 展开/收起带回弹，手感比直接切换明显。 */
  function toggleMenu() {
    void withAnimation(Animation.bouncy({ duration: 0.38, extraBounce: 0.18 }), () => {
      menuOpen.setValue(!menuOpen.value);
    });
  }

  /** 点完入口就把菜单收起来，省得它一直挡着地图。 */
  function withMenuClosed(action: () => void) {
    void withAnimation(Animation.smooth({ duration: 0.22 }), () => menuOpen.setValue(false));
    action();
  }

  function cycleLayer() {
    const layers: MapLayerId[] = ["standard", "imagery", "hybrid"];
    const idx = layers.indexOf(layer.value);
    layer.setValue(layers[(idx + 1) % layers.length]);
  }

  function layerIcon(id: MapLayerId): string {
    switch (id) {
      case "imagery":
        return "globe.europe.africa.fill";
      case "hybrid":
        return "map.fill";
      case "standard":
      default:
        return "map";
    }
  }

  function handlePick(coord: Coordinate, name?: string) {
    coordLat.setValue(coord.latitude);
    coordLng.setValue(coord.longitude);
    coordReady.setValue(true);
    /*
      地名和历史统一交给 `handleCoordChange`——跳转之后 MapPage 会回调它。

      以前这里也写一遍，结果是：这边刚把「杭州大剧院」设上，MapPage 回调时
      因为没带名字又走了「清空 + 反查」那条路，转眼变成一个街道名；历史也
      顺带写了两条。名字跟着目标点一起传过去，那边据此决定要不要反查。
    */
    pendingCoord.setValue({ ...coord, name });
    closeSheet();
    fireToast("已定位到该坐标");
  }

  /**
   * 反查地名。
   *
   * 点空地选点时 MapKit 不给名称，锁屏卡片上就只剩两行一模一样的坐标。
   * 这里补一次反向地理编码，拼成「街道 · 区」这种能认出来的说法。
   * 查不到就算了，卡片退回显示坐标，不影响模拟。
   */
  /**
   * 地名查到了：落缓存、更新界面，必要时把卡片也刷一遍。
   *
   * @param source 日志前缀，标明走的哪条路。要写在坐标**前面**——脱敏会把箭头
   *               之后的地名整段打掉，写在后面连这个标记一起没了。
   */
  function applyPlaceName(lat: number, lng: number, label: string, source: string): void {
    // 空结果也缓存：查不到的点再点一次还是查不到，不该反复请求。
    placeCache.current.set(`${lat.toFixed(5)},${lng.toFixed(5)}`, label);
    if (!label) return;
    // 期间用户可能又点了别处，坐标对不上就丢弃这次结果。
    if (coordLat.value !== lat || coordLng.value !== lng) return;

    debugLog("geocode", `${source}${lat.toFixed(5)}, ${lng.toFixed(5)} → ${label}`);
    updatePlaceName(label);
    setHistory(addHistory(label, lat, lng));

    /*
      补一次卡片刷新。

      地名是异步回来的，而卡片在「开始模拟」那一刻就建好了——那时多半还没查到，
      卡片上写的是坐标。定点模拟下坐标不再变化，`pushCoordinate` 不会被调用，
      卡片就一直停在那个样子。境外更明显：系统反查先失败、再绕一趟 Worker，
      慢的时候好几秒，卡片早就立住了。

      只在反查的点**正是**当前模拟中的那个点时才刷：用户边模拟边在地图上点别处
      查看是常事，不该把卡片改成他只是看了一眼的地方。
    */
    const active = activeLoc.value;
    if (
      session.value &&
      active &&
      Math.abs(active.latitude - lat) < 1e-6 &&
      Math.abs(active.longitude - lng) < 1e-6
    ) {
      void updateLiveActivity({ latitude: lat, longitude: lng });
    }
  }

  async function resolvePlaceName(lat: number, lng: number): Promise<void> {
    // 查过的点直接用缓存。反查有频率限制，来回点同几个位置时不该重复请求。
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const cached = placeCache.current.get(key);
    if (cached !== undefined) {
      if (cached) updatePlaceName(cached);
      return;
    }

    // 反查要用设备坐标系（WGS-84），地图上拿到的是地图系，先换过去。
    const wgs = toDeviceCoordinate(lat, lng);

    /*
      反查要联网，常见失败是 kCLErrorDomain 2（网络不可用）。
      开着「Scripting 自身」的隧道时尤其容易——iOS 同时只允许一条 VPN，
      本机回环占着那个名额，系统的地理编码未必出得去。
      只重试一次：多试反而会被频率限制拒得更久。
    */
    const lookup = async () =>
      await Location.reverseGeocode({ latitude: wgs.latitude, longitude: wgs.longitude });

    try {
      const marks = await lookup().catch(async () => {
        await delay(1500);
        return await lookup();
      });

      const mark = marks?.[0];
      if (!mark) {
        placeCache.current.set(key, "");
        return;
      }

      // name 往往已经是「××路123号」这类完整说法，优先用它；
      // 没有就拿街道 + 子区域拼，两者都没有才退回区县。
      const label =
        mark.name?.trim() ||
        [mark.thoroughfare, mark.subLocality].filter(Boolean).join(" ") ||
        mark.locality ||
        "";
      applyPlaceName(lat, lng, label, "");
    } catch (error) {
      debugLog("geocode", `${key} 系统反查失败，试 Worker`, describeError(error));
      /*
        退回 Worker → Nominatim。

        大陆设备的系统地理编码走高德，境外基本没有覆盖——定位到首尔只会
        kCLErrorDomain 8（没有结果），卡片上就剩一串坐标。搜索那边早有这条路
        （「全球」模式），反查一直缺。

        仍然失败就记空，免得对同一个点反复请求；显示坐标不影响模拟。
      */
      try {
        const label = await reverseGlobalPlace(
          wgs.latitude,
          wgs.longitude,
          settings.globalSearchEndpoint.trim() || DEFAULT_GLOBAL_ENDPOINT,
        );
        applyPlaceName(lat, lng, label, "Worker 反查 ");
      } catch (fallbackError) {
        placeCache.current.set(key, "");
        debugLog("geocode", `${key} Worker 反查也失败`, describeError(fallbackError));
      }
    }
  }

  function handleCoordChange(lat: number, lng: number, name?: string) {
    coordLat.setValue(lat);
    coordLng.setValue(lng);
    coordReady.setValue(true);
    if (name !== undefined) {
      // 点中 POI 时 MapKit 直接给名称，比反查的结果准，优先用。
      updatePlaceName(name);
      setHistory(addHistory(name || "地图选点", lat, lng));
    } else {
      // 点的是空地：先清掉上一个点的名字，再去反查，免得卡片上挂着旧地名。
      updatePlaceName("");
      void resolvePlaceName(lat, lng);
    }
    // 手绘模式下点地图就是落点，不用为了加一个点去开合一次面板。
    if (drawing.value) appendDrawnPoint(lat, lng);
  }

  async function handleAddFavorite(coord: Coordinate) {
    /*
      默认名直接用当前地名。

      搜到「杭州大剧院」再点收藏，默认却填着「我的收藏」，等于每次都要手动改一遍。
      地名已经在卡片上显示着了，拿来当默认值才是顺手的那个选择；
      反查不出地名时（空地、隧道开着）再退回通用名。
    */
    const suggested = placeName.trim() || "我的收藏";
    const name = await Dialog.prompt({
      title: "收藏此位置",
      message: `经度 ${coord.longitude.toFixed(6)}  纬度 ${coord.latitude.toFixed(6)}`,
      defaultValue: suggested,
      placeholder: "备注名称（如：公司、家）",
      selectAll: true,
      confirmLabel: "保存",
      cancelLabel: "取消",
    });
    if (name == null) return;

    const trimmed = name.trim();
    if (trimmed) {
      setFavorites(addFavorite(trimmed, coord.latitude, coord.longitude));
      fireToast(`已收藏：${trimmed}`);
    }
  }

  async function handleLinkParse() {
    const rawUrl = await Dialog.prompt({
      title: "解析地图链接或坐标",
      message: "支持 苹果/Google/高德/百度 地图链接或经纬度文本。",
      placeholder: "在此粘贴地图链接或经纬度",
      selectAll: true,
      confirmLabel: "解析并定位",
      cancelLabel: "取消",
    });
    if (rawUrl == null) return;

    const trimmed = rawUrl.trim();
    if (!trimmed) return;

    try {
      const result = await parseAndConvert(trimmed);
      handlePick({ latitude: result.latitude, longitude: result.longitude }, result.name);
      fireToast(result.name ? `已定位到：${result.name}` : "已成功定位");
    } catch (e) {
      // 走和其他提示同一个半屏浮层，别再单开一个系统 alert
      showMessage(`解析失败\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handlePickFromMap() {
    try {
      const picked = await Location.pickFromMap();
      if (picked) handlePick({ latitude: picked.latitude, longitude: picked.longitude });
    } catch (e) {
      showMessage(`选点失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleCurrentLocation() {
    try {
      // GPS 是 WGS-84，摆到地图上要先转成地图系，否则在国内会偏数百米。
      const gps = await Location.requestCurrent({ forceRequest: true });
      if (gps) {
        const mapped = fromDeviceCoordinate(gps.latitude, gps.longitude);
        handlePick({ latitude: mapped.latitude, longitude: mapped.longitude });
        fireToast("已定位到当前位置");
      }
    } catch (e) {
      showMessage(`定位失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 设置页改一项存一项，不在这里关表单，也不弹提示——否则每敲一个字都要弹。 */
  function handleSettingsChange(next: AppSettings) {
    // 立刻同步 ref，不等重渲染：移动中改了灵动岛样式，下一拍（0.5 秒）就会
    // 经定时器重建卡片，那条路读的是 ref。
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
    layer.setValue(next.defaultLayer);
    debugLog("settings", "已保存", JSON.stringify(next));

    // 灵动岛样式改了要立刻推一次更新：卡片的内容只在 start/update 时重算，
    // 不主动推的话改完要等下一次坐标变动才生效，看起来就像「设置没用」。
    //
    // 不要求有进行中的会话——卡片可能是上一次留下的，那时 activeLoc 已经是 null，
    // 但岛上还挂着旧内容（之前就是这样：设置里改成了新值，岛上还是旧的）。
    const loc = activeLoc.value ?? { latitude: coordLat.value, longitude: coordLng.value };
    void updateLiveActivity({ latitude: loc.latitude, longitude: loc.longitude }, next);
  }

  function handleDeleteFav(id: string) {
    setFavorites(removeFavorite(id));
    fireToast("已删除");
  }

  function handleClearAllFav() {
    clearFavorites();
    setFavorites([]);
    fireToast("已清空收藏");
  }

  function isCurrentCoordFavorited(): boolean {
    if (!coordReady.value) return false;
    return favorites.some(
      (f) =>
        Math.abs(f.latitude - coordLat.value) < 1e-6 && Math.abs(f.longitude - coordLng.value) < 1e-6,
    );
  }

  function handleRemoveCurrentFavorite() {
    const fav = favorites.find(
      (f) =>
        Math.abs(f.latitude - coordLat.value) < 1e-6 && Math.abs(f.longitude - coordLng.value) < 1e-6,
    );
    if (fav) handleDeleteFav(fav.id);
  }

  async function openPairingPage() {
    await Navigation.present({ element: <PairingPage /> });
    setPairing(loadPairing());
  }

  /** 地图系坐标 → 真正下发给设备的坐标：先换算坐标系，再按设置加扰动。 */
  function deviceCoordinate(lat: number, lng: number): Coordinate {
    const converted = toDeviceCoordinate(lat, lng);
    return applyJitter(converted.latitude, converted.longitude, settings.jitterRadius);
  }

  function markActive(lat: number, lng: number) {
    const loc: ActiveLocation = { latitude: lat, longitude: lng };
    activeLoc.setValue(loc);
    saveActiveCache(loc);
  }

  /** 复制一套坐标。给个 toast——不然点完毫无反应，不知道成没成。 */
  function copyCoord(label: string, lat: number, lng: number) {
    Pasteboard.setString(formatLatLng(lat, lng));
    fireToast(`已复制 ${label} 坐标`);
  }

  /** 卡片里的一行：坐标系名 + 数值 + 复制按钮。 */
  function coordRow(label: string, point: { latitude: number; longitude: number }) {
    return (
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Text font="caption2" foregroundStyle="secondaryLabel" frame={{ width: 52 }}>
          {label}
        </Text>
        <Text font="subheadline" fontDesign="monospaced" foregroundStyle="label">
          {formatLatLng(point.latitude, point.longitude)}
        </Text>
        <Spacer />
        <Button
          buttonStyle="borderless"
          action={() => copyCoord(label, point.latitude, point.longitude)}
        >
          <Image systemName="doc.on.doc" foregroundStyle="systemBlue" font="caption" />
        </Button>
      </HStack>
    );
  }

  /**
   * 当前点的两套坐标。
   *
   * 只在 render 期间调用：里面读了 `coordLat` / `coordLng` 两个 observable，
   * 挪到别处读就收不到更新了（SKILL 2.6）。
   */
  function coordReadoutRows() {
    const readout = coordinateReadout(coordLat.value, coordLng.value);
    return (
      <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity" }}>
        {/* 境外两系相同，只留一行，并按它真实的身份标成 WGS-84 */}
        {readout.same ? null : coordRow("GCJ-02", readout.map)}
        {coordRow("WGS-84", readout.wgs84)}
      </VStack>
    );
  }

  /**
   * 保活为什么没成。
   *
   * 后台保活靠的是**共享音频引擎**（dts 原文：App-wide audio state、
   * Audio failure resolves to false），所以被拒几乎都是音频被别人占着——
   * 在放歌、在通话、在录音。跟 WiFi 还是蜂窝没有任何关系，而旧提示只说
   * 「系统拒绝了后台保活」，用户自然会往网络上想。
   *
   * `getState().lastFailure` 是这次 TF 新给的，能直接拿到原因。
   */
  async function keepAliveFailureHint(): Promise<string> {
    try {
      const state = await BackgroundKeeper.getState();
      debugLog("keepalive", "保活状态", JSON.stringify(state));
      if (state.status === "interrupted") return "音频被其他 App 打断了（在放歌或通话？）";
      if (state.lastFailure) return state.lastFailure;
    } catch (error) {
      debugLog("keepalive", "读保活状态失败", describeError(error));
    }
    return "多半是音频被其他 App 占着";
  }

  /** 保活没起来只提醒一次，别每次进后台都弹。开新会话时重置。 */
  const keepAliveWarned = useRef(false);

  /** 同一轮会话里只提醒一次。 */
  function warnKeepAlive(message: string): void {
    if (keepAliveWarned.current) return;
    keepAliveWarned.current = true;
    fireToast(message);
  }

  /**
   * 申请后台保活。
   *
   * **别按 `Script.env` 预判能不能用。** 文档和 dts 都写着「仅 index 可用」，
   * 2.7.1 据此把首页 Tab 拦掉了——而 Tab 跑在主 App 里，保活本来好好的。
   * 拦掉的后果是蜂窝下切去任何一个 App 几分钟就必掉线（POSIX 57），
   * 这个入口等于废了。能不能用问 `keepAlive()` 自己，别替它回答。
   */
  async function acquireKeepAlive(): Promise<void> {
    try {
      const started = await retainKeepAlive("session");
      if (!started) {
        warnKeepAlive(`后台保活没起来：${await keepAliveFailureHint()}`);
        return;
      }
      // 以应用自己报的状态为准，不是以我们调过为准。
      const active = await BackgroundKeeper.isActive;
      debugLog("keepalive", `isActive=${active}`);
      if (!active) warnKeepAlive("后台保活未生效，锁屏后可能掉线");
    } catch (error) {
      // dts：access errors reject。分享表单那类非主 App 的入口会走到这儿。
      debugLog("keepalive", `申请后台保活出错（env=${Script.env}）`, describeError(error));
      warnKeepAlive("这个入口拿不到后台保活，锁屏会掉线；从脚本列表打开则不受影响");
    }
  }

  /**
   * 会话期间维持保活。
   *
   * **回前台不撤保活。** 保活在会话建立时就申请好（见 connectSession），
   * 整个模拟期间一直持有，直到会话收尾才松手。
   *
   * 以前是「进后台申请、回前台撤掉」，照着文档「回到前台时停止保活」写的。
   * 但 dts 讲得更准：`Request keepAlive() while foregrounded, before starting
   * background work.`——要在**前台就绪**，而不是等进了后台再申请。按下电源键
   * 锁屏那一下，音频引擎根本来不及从 background 事件里预热起来，App 几秒内就被
   * 挂起，连接跟着断。文档那句针对的是「回到前台工作就结束了」的脚本，
   * 而这里的会话跨着前后台一直在跑。
   *
   * 这里只留一手兜底：进后台时再 retain 一次。保活靠共享音频引擎，中途被电话
   * 之类打断后 retain 能把它接回来，而且重复调用是幂等的。
   */
  useEffect(() => {
    const listener = (phase: ScenePhase) => {
      // inactive 是前后台切换的过渡态，下面也不据此做任何事。记它纯属刷屏——
      // 一次切换就能刷出 active → inactive → background 三条。
      if (phase !== "inactive") debugLog("keepalive", `scenePhase=${phase}`);
      if (session.value === null) return;
      if (phase === "background") void acquireKeepAlive();
    };
    AppEvents.scenePhase.addListener(listener);
    return () => AppEvents.scenePhase.removeListener(listener);
  }, []);

  /*
    接住锁屏 / 灵动岛上「恢复真实位置」的请求。

    那个按钮的 intent 跑在单独的环境里，拿不到这里的会话；会话心跳又每 4 秒
    重发一次假坐标，intent 自己连上去发停止，几秒后就被盖回去——真机上表现为
    「卡片没了，定位还在」。所以会话进行中这里每秒报一次平安、看一眼有没有请求，
    有就走和「停止」按钮同一条路收尾，再把结果回执给 intent（见 app_intents.tsx）。

    经 ref 调用 handleStopSession：这个定时器只在挂载时建一次，直接引用会一直
    拿着第一次渲染时的那份函数。
  */
  const stopSessionRef = useRef(handleStopSession);
  stopSessionRef.current = handleStopSession;
  /*
    挂一个会话，等锁屏卡片来喊停。

    以前是拿 Storage 当信箱：这里每秒醒一次查有没有请求、顺手写一次心跳，
    intent 那头投完请求再每 300 毫秒查回执。`ScriptSession` 把这套换成了直接的
    请求/应答——定时器、心跳、TTL、撤回全都不需要了，响应也不再等一个轮询周期。

    几条规矩：
      - **只能从 index / home_screen 注册**。`intent.tsx` 也会渲染这个组件，
        那边不能注册，否则等于自己给自己发请求。
      - 主脚本退出时系统会关掉 session，Storage 里的 ID 就成了陈旧值。不用
        特意清——intent 拿它 request 会失败，正好触发「自己连设备」的回落。
      - 处理函数里**不能**依赖闭包里的 `handleStopSession`：这个 effect 只跑一次，
        直接引用会永远拿着首次渲染那份。走 ref。
  */
  useEffect(() => {
    if (Script.env !== "index" && Script.env !== "home_screen") return;

    let busy = false;
    const id = ScriptSession.register(async (message) => {
      const type = (message as { type?: string } | null)?.type;
      if (type !== "restore") return { ok: false, message: `不认识的请求：${String(type)}` };

      // 同一时刻只处理一个：连点两下卡片按钮不该叠两次停止流程。
      if (busy) return { ok: false, message: "正在处理上一个请求" };

      busy = true;
      debugLog("liveactivity", `收到卡片上的恢复请求（会话${session.value ? "在" : "不在"}）`);
      try {
        // 有现成会话就用它收尾，最快也最稳。
        if (session.value !== null) {
          const failure = await stopSessionRef.current(true);
          // message 用 null 不用 undefined：ScriptSession 的回值要能 JSON 化。
          return { ok: failure === null, message: failure };
        }

        /*
          没有会话，也**必须由主脚本来做**，不能回给 intent 自己连。

          文档（local_dev_vpn）写明本机隧道「所有操作仅允许原始活跃主 App 脚本」
          ——intent 那边的 `restoreDirectly` 根本调不动 openRSDTunnel。以前靠它
          兜底其实是假的；而「没有会话」恰恰是最需要兜底的几种场景：启动时发现
          上次没收尾、断线重连期间、以及停止失败之后（那条提示本身就让用户去点
          卡片）。这些时候设备很可能还停在模拟位置。

          所以这里自己连一次补发停止——和「上次没正常结束」走的是同一条路。
        */
        const record = loadPairing();
        if (!record) return { ok: false, message: "没有配对记录，无法连上设备恢复" };

        debugLog("liveactivity", "本地没有会话，主脚本自己连上去补发停止");
        try {
          await restoreRealLocation({
            record,
            endpoint: endpointFromSettings(settingsRef.current),
          });
          clearRecovery();
          void endLiveActivity();
          return { ok: true, message: null };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          debugLog("liveactivity", "主脚本补发停止失败", describeError(error));
          return { ok: false, message: detail };
        }
      } finally {
        busy = false;
      }
    });
    saveSessionID(id);
    debugLog("liveactivity", `已注册会话通道（env=${Script.env}）`);

    return () => {
      ScriptSession.unregister(id);
      clearSessionID();
    };
  }, []);

  /**
   * 会话异常中断的统一收尾。
   *
   * 锁屏、切后台、系统回收隧道都会打断 RSD 连接（典型是
   * `RSDTCPAdapter.Failure 错误 0`）。定点模拟可以原地重连——整条链路从配对
   * 到下发不到一秒，比弹个框让用户自己重来强得多。
   *
   * @param retry 能重连就传重连动作；不能（比如移动中）传 null
   */
  async function handleSessionDropped(initialMessage: string, retryPoint: Coordinate | null) {
    // 重连过程中会被改写成「最后一次失败」的原因，见下面的循环。
    let message = initialMessage;
    debugLog("ui", "会话中断", message);
    session.setValue(null);
    /*
      恢复记录故意不删：连接是异常断的，停止指令未必送达，
      下次启动仍要提示用户恢复。

      **保活也先不放。** 掉线十有八九发生在锁屏时，而下面那段重连要等
      2 秒再试、最多五轮——这会儿把保活撤了，整个循环立刻跟着被挂起，
      等用户解锁回来才继续跑，那时它可能把已经恢复的真实位置又改回假的。
      原生版的注释写的是同一件事：重连间隙不释放保活。
      放在最后统一收（见本函数末尾）。
    */

    if (retryPoint && !reconnecting.value) {
      reconnecting.setValue(true);
      reconnectCancelled.current = false;
      setSessionState("connecting");
      setStatusMsg("连接中断，正在重连…（可取消）");
      fireToast("连接中断，正在重连…");
      try {
        /*
          等一会儿再试，而且多试几次。

          掉线最常见的起因是网络刚切换——关掉飞行模式、WiFi 转蜂窝——这时候
          代理工具的 TUN 正在重建，立刻重连必然失败。上一版就是立即重连一次，
          失败后又把用户甩回蜂窝引导，连上再断、断了再弹，绕不出去。
        */
        for (let attempt = 1; attempt <= RECONNECT_TRIES; attempt++) {
          await delay(RECONNECT_DELAY_MS);
          // 用户按了取消就别再试了。整轮可能跑一分多钟，中途无从叫停很难受。
          if (reconnectCancelled.current) {
            debugLog("ui", `断线重连被用户取消（已试 ${attempt - 1} 次）`);
            message = "重连已取消。设备可能仍停在模拟位置，重新连接一次再停即可。";
            break;
          }
          setStatusMsg(`连接中断，正在重连…第 ${attempt}/${RECONNECT_TRIES} 次（可取消）`);
          try {
            await connectSession(retryPoint);
            debugLog("ui", `断线重连成功（第 ${attempt} 次）`);
            fireToast("已重新连上");
            return;
          } catch (error) {
            debugLog("ui", `断线重连第 ${attempt} 次失败`, describeError(error));
            /*
              报最后一次的错，不报最初那次掉线的原因。

              掉线常常只是网络切换的一瞬，而重连连不上才是真正拦路的那件事
              （比如切到蜂窝后配对服务不在了）。只报最初那句，用户照着查
              永远查不到点子上。
            */
            message = error instanceof Error ? error.message : String(error);
          }
        }
      } finally {
        reconnecting.setValue(false);
      }
    }

    /*
      走到这儿才是真的放弃：要么不重连，要么五轮都失败了。
      保活到这一刻才撤——上面那段重连需要它撑着（见函数开头）。
    */
    void releaseKeepAlive("session");
    // 重连全败时移动也停掉，否则界面一直停在「移动中」，而底下根本没有会话。
    stopMovement();
    setSessionState("idle");
    setStatusMsg("");
    activeLoc.setValue(null);
    saveActiveCache(null);
    void endLiveActivity();
    showMessage(message);
  }

  async function handleStartSession() {
    if (!pairing) {
      showMessage("还没有配对。去「配对」页点「配对这台设备」，或导入已有的配对记录");
      return;
    }
    // 权限不全就别往下连：缺 localDevVPN 时错误会一路漏到建隧道那一步，
    // 报成「卡在隧道握手」，把人引去查代理和网络。
    const denied = missingAccess();
    if (denied) {
      showMessage(accessDeniedMessage(denied));
      return;
    }
    if (!coordReady.value) {
      showMessage("请先在地图上选择目标位置");
      return;
    }

    const lat = coordLat.value;
    const lng = coordLng.value;
    const target = deviceCoordinate(lat, lng);

    setSessionState("connecting");
    setStatusMsg("准备中…");
    debugLog(
      "ui",
      `开始模拟：地图系 ${lat.toFixed(6)}, ${lng.toFixed(6)} → 设备 ${target.latitude.toFixed(6)}, ${target.longitude.toFixed(6)}（扰动 ${settings.jitterRadius}m）`,
    );

    /*
      走和「移动」面板同一条路。

      这里原先自己抄了一遍 startLocationSession 的调用和善后，于是后来给
      ensureSession 加的蜂窝引导、失败分诊这些，主按钮一概享受不到——用户点
      「开始位置模拟」连不上，弹的还是那段生硬的错误文字。两处行为必须一致，
      就只能有一份实现。
    */
    try {
      await connectSession({ latitude: lat, longitude: lng });
      fireToast("位置模拟已启动");
    } catch (e) {
      setSessionState("idle");
      setStatusMsg("");
      debugLog("ui", "启动失败", describeError(e));
      // 只有「找不到配对服务」那一类才值得弹引导，其余直接说真因
      if (!shouldOfferGuide(e)) {
        showMessage(e instanceof Error ? e.message : String(e));
        return;
      }
      guideStart.current = { latitude: lat, longitude: lng };
      guideError.current = e;
      guideAttempts.setValue(0);
      guideStage.setValue("help");
    }
  }

  // ── 移动模拟 ──────────────────────────────────────────────────────

  /** 把地图系坐标推给设备，并同步界面上的「正在模拟」标记。 */
  async function pushCoordinate(handle: LocationSessionHandle, point: Coordinate): Promise<void> {
    const target = deviceCoordinate(point.latitude, point.longitude);
    await handle.update(target.latitude, target.longitude);
    lastPushed.current = point;
    markActive(point.latitude, point.longitude);
    /*
      恢复记录跟着实际下发的位置走。

      以前只在建会话时写一次，于是「上次的模拟没有正常结束 · 最后模拟到 X」
      里的 X 永远是**起点**——移动了一路、或者点过几次「更新坐标」之后崩掉，
      提示里给的还是出发地，用户照着判断就错了。
    */
    const nowMs = Date.now();
    if (nowMs - recoverySavedAt.current > RECOVERY_SAVE_MS) {
      recoverySavedAt.current = nowMs;
      saveRecovery({
        latitude: point.latitude,
        longitude: point.longitude,
        startedAt: recoveryStartedAt.current || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    void updateLiveActivity(point);
  }

  // ── 锁屏 / 灵动岛卡片 ──────────────────────────────────────────────

  /** 会话起始时间，卡片上的计时器由系统按它自己走。 */
  const sessionStartedAt = useRef(Date.now());

  /**
   * @param override 设置页刚改完、state 还没刷新时传进来的新设置。
   *                 不传就用当前 settings。
   */
  function liveActivityState(point: Coordinate, override?: AppSettings): SimulationState {
    /*
      这几个值一律读 ref，不读 state。

      卡片的每一拍都由移动定时器触发，而那个回调绑死在点「开始」的那一帧——
      读 state 就永远是定点的样子。见 movementKindRef 处的说明。
    */
    const conf = override ?? settingsRef.current;
    const kind = movementKindRef.current;
    const choice = selectionRef.current;
    const info = modeInfo(choice.mode);
    const moving = kind !== "none";
    // 摇杆是手推的，没有「总长」可言；沿路线/手绘才有进度。
    const walk = kind === "route" ? walker.value?.state : undefined;
    return {
      title: cardStatus(conf),
      place: cardTitle(conf),
      latitude: point.latitude,
      longitude: point.longitude,
      mode: moving ? (kind === "joystick" ? `摇杆 · ${info.label}` : info.label) : "",
      modeIcon: moving ? info.systemImage : "",
      speedKmh: moving ? choice.speed.metresPerSecond * 3.6 : 0,
      travelled: walk?.travelled ?? 0,
      total: walk?.total ?? 0,
      leg: (walk?.leg ?? 0) + 1,
      paused: walk?.paused ?? false,
      startedAt: sessionStartedAt.current,
      tint: conf.islandTint,
      compactIcon: islandIcon(moving ? info.systemImage : "", conf),
      compactIconIsEmoji: conf.islandIcon === "emoji",
      compactText: islandText(point, walk, conf),
      compactTimer: conf.islandText === "elapsed",
      restoreTint: conf.restoreTint,
    };
  }

  /**
   * 锁屏卡片的大标题。
   *
   * 留空时卡片那边只显示坐标，不会出现两行一模一样的坐标。
   * 地名要反向地理编码，开着本机隧道时经常查不到（见 resolvePlaceName），
   * 所以「地点名」实际上常常退回坐标——想固定显示别的就选自定义。
   */
  /**
   * 卡片与灵动岛的大标题。
   *
   * 返回空串表示「交给卡片自己按状态生成」——自定义模式下用户没填内容时
   * 也走这条，总比顶着一行空白强。
   */
  function cardStatus(conf: AppSettings): string {
    return conf.cardStatus === "custom" ? conf.cardCustomStatus.trim() : "";
  }

  function cardTitle(conf: AppSettings): string {
    switch (conf.cardTitle) {
      case "place":
        // 读 ref 不读 state：反查回来会立刻刷一次卡片，那时 state 还没更新
        return placeNameRef.current;
      case "coord":
        return "";
      case "custom":
        return conf.cardCustomTitle.trim();
    }
  }

  /** 收起态图标：按设置决定用方式图标、固定箭头、Emoji 还是不显示。 */
  function islandIcon(modeIcon: string, conf: AppSettings): string {
    switch (conf.islandIcon) {
      case "mode":
        return modeIcon || "location.fill";
      case "fixed":
        return "location.fill";
      case "emoji":
        return conf.islandEmoji.trim() || "📍";
      case "none":
        return "";
    }
  }

  /**
   * 收起态文字。
   *
   * 灵动岛那一条只有很窄一点宽度，所以这里都是短句，长了系统会截断。
   * 选了某项但当前场景没有对应数据（比如定点模拟选「速度」）时返回空串，
   * 卡片那边会直接不画，不会留一截空白。
   */
  function islandText(point: Coordinate, walk: WalkState | undefined, conf: AppSettings): string {
    const ratio = walk && walk.total > 0 ? walk.travelled / walk.total : null;
    /*
      收起态右侧只有六十来点宽，「39.918, 116.437」这种长度必然被砍成
      「39.918,…」——省略号顶着电池图标，什么也没说明。所以这里就按那个宽度
      来配：两位小数（约 1 km 精度，收起态本来也只是瞥一眼）、去掉空格。
      要精确坐标的话，卡片展开态和地图上都有完整的。
    */
    const shortCoord = `${point.latitude.toFixed(2)},${point.longitude.toFixed(2)}`;
    switch (conf.islandText) {
      case "elapsed":
        // 计时由卡片那边用系统计时器画（compactTimer），这里不出文字
        return "";
      case "status":
        return movementKindRef.current === "none" ? "模拟中" : walk?.paused ? "已暂停" : "移动中";
      case "place":
        // 地名放得下就用地名，放不下系统会按 minScaleFactor 缩，仍比坐标好认。
        // 同 cardTitle，读 ref 以拿到刚反查回来的那个值。
        return placeNameRef.current || shortCoord;
      case "coordinate":
        return shortCoord;
      case "speed":
        return movementKindRef.current === "none"
          ? ""
          : `${(selectionRef.current.speed.metresPerSecond * 3.6).toFixed(1)}`;
      case "progress":
        return ratio === null ? "" : `${Math.round(ratio * 100)}%`;
      case "custom":
        return conf.islandCustomText.trim();
      case "none":
        return "";
    }
  }

  /**
   * 起锁屏 / 灵动岛卡片。
   *
   * 起不来最常见的原因是系统里把实时活动关掉了（设置 → Scripting → 实时活动），
   * 这种情况 start() 直接抛错，只记日志的话用户永远不知道为什么没卡片，
   * 所以先问一次 areActivitiesEnabled 再明确提示。
   */
  async function startLiveActivity(point: Coordinate) {
    try {
      const allowed = await LiveActivity.areActivitiesEnabled();
      debugLog("liveactivity", `areActivitiesEnabled=${allowed}`);
      if (!allowed) {
        /*
          直接给跳转，别只扔一句提示。

          开关在「设置 → Scripting → 实时活动」，而用户多半不知道要去应用自己的
          设置页里找。深链跳不到系统设置的任何子页（实测全被重定向到 App 列表），
          但跳本应用这一页是官方支持的，而且开关就在那儿。
        */
        showMessage(
          "实时活动被关掉了\n锁屏卡片和灵动岛都不会显示。开关在 Scripting 的设置页里。",
          { tone: "info", action: { label: "去打开", run: () => void openAppSettings() } },
        );
        return;
      }
      /*
        开新卡之前先把旧卡全清掉。

        实时活动的生命周期独立于脚本：退出 Scripting、脚本被系统回收，
        卡片都还留在锁屏和通知中心里。再进来开一次模拟就多一张，
        几轮下来能堆好几条「定点模拟」，而且每张都带着各自那个时间点的坐标。

        手上这个 `liveActivity` 句柄只认得本进程起的那张，收不掉上一轮留下的，
        所以必须用静态的 endAllActivities。
      */
      await LiveActivity.endAllActivities({ dismissTimeInterval: 0 }).catch(() => undefined);
      /*
        每次都从工厂拿一个新实例。

        `LiveActivity.register` 返回的是工厂函数，而一个实例内部有 `_started`
        标志、`start()` 一生只许调一次（再调就是
        "this method must only be called once"）。整个会话复用同一个实例的话，
        第二次开模拟就永远起不来卡片——而且只记日志不报错，表现是「突然没灵动岛了」。
      */
      liveActivity.setValue(SimulationLiveActivity());
      await liveActivity.value.start(liveActivityState(point));
      debugLog("liveactivity", "卡片已启动");
    } catch (error) {
      debugLog("liveactivity", "实时活动启动失败", describeError(error));
      fireToast("锁屏卡片启动失败，不影响定位模拟");
    }
  }

  async function updateLiveActivity(point: Coordinate, override?: AppSettings) {
    try {
      await liveActivity.value.update(liveActivityState(point, override));
    } catch {
      // 卡片已被用户划掉时更新会失败，忽略即可。
    }
  }

  async function endLiveActivity() {
    try {
      // end 要求带一份最终状态，用当前位置凑一份即可——dismissTimeInterval 为 0，
      // 卡片立刻消失，这份内容不会被看到。
      const last = activeLoc.value;
      await liveActivity.value.end(
        liveActivityState({
          latitude: last?.latitude ?? 0,
          longitude: last?.longitude ?? 0,
        }),
        { dismissTimeInterval: 0 },
      );
    } catch {
      // 没开起来过就没什么好收的。
    }
  }

  function clearMovementTimer() {
    const timer = movementTimer.value;
    if (timer !== null) {
      clearInterval(timer);
      movementTimer.setValue(null);
    }
  }

  function stopMovement() {
    clearMovementTimer();
    walker.setValue(null);
    joystickVector.setValue({ dx: 0, dy: 0 });
    joystickPosition.setValue(null);
    updateMovementKind("none");
    setPaused(false);
  }

  /**
   * 移动结束、但会话还在：停掉推进，并把卡片切回定点的样子。
   *
   * 这一步不能省。卡片只在 start / update 时重算，而移动一停，驱动它的定时器
   * 也没了——不主动刷一次，锁屏上会一直停在「移动中 · 3.2/5.0 km」。
   * 以前看不出来是因为卡片根本没显示过移动状态（见 movementKindRef）。
   *
   * `stopMovement` 自己不带这个刷新：它还会在「开始新一段移动之前」和
   * 「整个会话停止时」被调用，那两处都不需要先刷回定点。
   */
  function finishMovement() {
    stopMovement();
    const loc = activeLoc.value;
    if (session.value && loc) void updateLiveActivity(loc);
  }

  /**
   * 暂停 / 继续。
   *
   * 定时器照常走，只是推进器不再前进——心跳仍在下发当前坐标，
   * 设备不会因为久不收坐标而把会话收掉。
   */
  function togglePaused() {
    const current = walker.value;
    if (!current) return;
    const next = !current.isPaused;
    current.setPaused(next);
    setPaused(next);
    fireToast(next ? "已暂停" : "继续移动");
  }

  /** 原地调头，当前位置不变。 */
  function reverseMovement() {
    const current = walker.value;
    if (!current) return;
    current.reverse();
    fireToast("已反向");
  }

  /**
   * 确保有一个活动会话，起点为给定坐标。
   *
   * 已经在模拟就直接复用——移动只是不断改坐标，没必要断开重连。
   */
  /**
   * 建立会话的那一段，拆出来是为了能被蜂窝引导的重试循环反复调用。
   *
   * 成功返回句柄，失败把错误原样抛出去——是报错还是转交引导，由调用方决定。
   */
  async function connectSession(
    start: Coordinate,
    /**
     * 「这一轮还算不算数」。引导的重试会传。
     *
     * 建会话整条链路可能跑得比调用方的耐心还久（引导一轮只等 10 秒），而
     * `withTimeout` 只是**不再等待**——底下这个流程照样会跑完，然后把会话
     * 写进状态、起卡片。于是引导还开着、界面却已经「模拟中」，更糟的是
     * 下一轮又建一条，先建的那个句柄没人持有却仍在每 4 秒重发假坐标。
     */
    stillWanted?: () => boolean,
  ): Promise<LocationSessionHandle> {
    const target = deviceCoordinate(start.latitude, start.longitude);
    const handle = await startLocationSession({
      record: pairingRef.current!,
      endpoint: endpointFromSettings(settingsRef.current),
      latitude: target.latitude,
      longitude: target.longitude,
      keepAlive: settingsRef.current.keepAlive,
      onStatus: (message) => {
        debugLog("status", message);
        setStatusMsg(message);
      },
      onFailure: (message) => {
        /*
          重连与否、重连到哪，都按**掉线那一刻**的实际状态定，不看建会话时的入口。

          以前这两件事由入口静态决定（定点入口允许重连、移动入口不允许），
          于是两头都不对：定点会话上后来开始移动，掉线会把人瞬移回原来那个定点；
          而移动入口建的会话，移动结束后变回定点状态，却永远不再重连。

          移动中确实不能重连——路径进度和往返计数都在 PathWalker 里，重建会话
          续不上，只能停掉如实报错。但那是「现在在移动」决定的，不是入口。
        */
        const moving = movementKindRef.current !== "none";
        if (moving) stopMovement();
        void handleSessionDropped(message, moving ? null : lastPushed.current);
      },
    });

    /*
      建好了，但这会儿还要不要它是另一回事。

      两种情况都得把它收掉，否则就是一条没人持有、却仍在每 4 秒重发假坐标的
      会话——用户点了停止也停不掉它，因为句柄已经丢了：

        1. 调用方已经放弃这一轮（引导超时）；
        2. 这期间别处已经建成了一条（比如用户自己又点了开始）。

      原生版同样要补这一手，见 LocalDeviceSessionCoordinator 起来后发现已取消
      就补一次 cancel。
    */
    const unwanted = (stillWanted && !stillWanted()) || session.value !== null;
    if (unwanted) {
      debugLog("ui", "会话建好时已不再需要，立即收掉", JSON.stringify({ expired: !!stillWanted && !stillWanted(), replaced: session.value !== null }));
      await handle.stop().catch(() => undefined);
      throw new Error("这一轮已经作废");
    }

    session.setValue(handle);
    setSessionState("active");
    // 建会话时就下发了 start，重连目标从这一刻起生效。
    lastPushed.current = start;
    markActive(start.latitude, start.longitude);
    const now = new Date().toISOString();
    recoveryStartedAt.current = now;
    recoverySavedAt.current = Date.now();
    saveRecovery({
      latitude: start.latitude,
      longitude: start.longitude,
      startedAt: now,
      updatedAt: now,
    });
    // 新一轮会话，保活的提醒重新计数。
    keepAliveWarned.current = false;
    void acquireKeepAlive();
    sessionStartedAt.current = Date.now();
    void startLiveActivity(start);
    /*
      收尾状态在这里设，不交给调用方。

      之前只有「开始位置模拟」那条路自己设了，引导重试成功的那条没设——
      于是界面一直停在 startLocationSession 报的最后一句「下发坐标…」上，
      底下却已经显示「模拟中」了，自相矛盾。
    */
    setStatusMsg(`模拟中 · ${start.latitude.toFixed(5)}, ${start.longitude.toFixed(5)}`);
    return handle;
  }

  async function ensureSession(start: Coordinate): Promise<LocationSessionHandle | null> {
    const existing = session.value;
    if (existing) {
      await pushCoordinate(existing, start);
      return existing;
    }

    if (!pairing) {
      showMessage("还没有配对。去「配对」页点「配对这台设备」，或导入已有的配对记录");
      return null;
    }
    const denied = missingAccess();
    if (denied) {
      showMessage(accessDeniedMessage(denied));
      return null;
    }

    setSessionState("connecting");
    setStatusMsg("准备中…");
    try {
      return await connectSession(start);
    } catch (e) {
      setSessionState("idle");
      setStatusMsg("");
      debugLog("ui", "启动失败", describeError(e));
      /*
        连不上先问一句，别直接甩错误。

        最常见的原因是在用蜂窝数据——mDNS 在蜂窝接口上找不到配对服务，而这个
        要用户临时开一下飞行模式才能绕过去，光报个 Connection refused 没人知道
        该干什么。网络类型现在读得到（Device.getNetworkState），引导第一页会
        直接说结论，不再反过来问用户。

        但**只对得上这一类错误**：配对记录失效、权限被拒、隧道握手失败都另有
        去处，弹这段讲蜂窝的说明只会误导。
      */
      if (!shouldOfferGuide(e)) {
        showMessage(e instanceof Error ? e.message : String(e));
        return null;
      }
      guideStart.current = start;
      guideError.current = e;
      guideAttempts.setValue(0);
      guideStage.setValue("help");
      return null;
    }
  }

  /*
    蜂窝数据引导。

    用户确认在用移动数据之后，这里每 4 秒重试一次建会话——他在控制中心切飞行
    模式、再切回应用的这段时间里，脚本自己在试，连上就自动进入「可以关掉了」。
    不这么做的话，用户每切一次都得回来手动点一次重试。
  */
  /*
    轮询间隔。

    这个流程对时机敏感——隧道重连上的那个窗口不长，错过就得等下一轮。
    每轮自带 10 秒超时、又有 busy 闸挡着重入，所以间隔可以压短，
    真正的节流是「上一轮没结束就不开新的」而不是这个数字。
  */
  /*
    两轮之间的喘息。

    不是「每隔这么久试一次」——真正决定节奏的是上一轮多快结束：失败立刻接下一轮，
    这个值只用来避免失败得太快时把 CPU 打满。隧道重连上的窗口很短，
    固定节拍很容易整个错过。
  */
  /*
    但它也不能压得太狠：真机日志里前三轮重试全撞在
    「A VPN control operation is already in progress」上——VPN 启动要几秒，
    500 ms 一轮等于不停打断它，第四轮才赶上空档，白白浪费十秒。
    VPN 那边现在有互斥兜底，这里也留足间隔，两道一起才稳。
  */
  const GUIDE_RETRY_MS = 1500;

  function stopGuideLoop() {
    // 轮次号往前推一格：已经发出去的那一轮即便迟到成功，也不会再改状态
    guideRun.current += 1;
    guideBusy.current = false;
    const timer = guideTimer.current;
    if (timer !== null) {
      clearTimeout(timer);
      guideTimer.current = null;
    }
  }

  /**
   * 在引导里跑一次建会话。轮询和「立刻重试」共用这一个。
   *
   * 成功就进第三阶段；失败什么都不做——用户还在切飞行模式，失败本来就是
   * 流程的一部分，弹个错只会打断他。
   */
  const GUIDE_ATTEMPT_TIMEOUT_MS = 10000;

  function attemptInGuide() {
    const start = guideStart.current;
    // 上一次还没跑完就跳过，免得几条建会话的流程叠在一起
    if (!start || guideBusy.current) return;
    guideBusy.current = true;
    const run = ++guideRun.current;
    guideAttempts.setValue(guideAttempts.value + 1);
    /*
      本轮作废的判据，交给 connectSession 在建成那一刻自查。

      光靠轮次号不够：`withTimeout` 掐掉这一轮之后、下一轮开始之前，
      `guideRun` 还没变，迟到的成功照样会写进状态。所以 catch 里立刻把
      `roundAborted` 置上——它和 withTimeout 的 reject 是同一拍。
    */
    let roundAborted = false;
    const stillWanted = () => !roundAborted && run === guideRun.current;
    /*
      每一轮都要能自己结束。

      JS 没法取消已经发出的 Promise，而底下任何一步挂死都会让这一轮永远不落地，
      `guideBusy` 跟着一直为真——后面每次重试都被静默跳过，用户看到的就是
      「已试 2 次」之后再无动静。包一层超时，到点就放弃这一轮、放开闸门，
      让下一轮能重新发起。原生那版靠 Task.cancel 做同样的事。
    */
    void withTimeout(
      connectSession(start, stillWanted),
      GUIDE_ATTEMPT_TIMEOUT_MS,
      "本轮超时",
    )
      .then(() => {
        // 过期那一轮迟到的成功不算数，否则会把已经收起的引导又翻出来
        if (run !== guideRun.current) return;
        stopGuideLoop();
        guideStage.setValue("airplaneOff");
      })
      .catch((error) => {
        // 这一拍和 withTimeout 的 reject 同时发生：立刻作废本轮，
        // 迟到的 connectSession 建成后会据此自己收掉。
        roundAborted = true;
        /*
          飞行模式开着的那几秒必然是 ENETUNREACH——隧道跟着断了。
          这是流程的一部分，不是故障，记一行短的就够；其他错误才值得记全。
        */
        const code = (error as { code?: string } | null)?.code ?? "";
        const message = error instanceof Error ? error.message : String(error);
        /*
          这一轮是被我们自己的计时器掐掉的，底下那次建隧道**还在跑**。

          轮次超时 10 秒 < 原生隧道超时 15 秒，所以放弃时它多半没结束；而
          `cancelRSDTunnelOpening()` 原本只在 openRSDTunnel 自己返回之后才调，
          那时已经晚了。1.5 秒后的下一轮会撞上这条还没放弃的隧道——文档写明
          同时只允许一条。所以这里主动收掉。
        */
        if (message.includes("本轮超时")) {
          void VPN.localDevVPN.cancelRSDTunnelOpening().catch(() => undefined);
          debugLog("guide", "本轮超时，已请求取消未完成的隧道打开");
        }
        if (code === "ENETUNREACH") {
          debugLog("guide", `第 ${guideAttempts.value} 次：网络不可达（飞行模式开着时正常）`);
        } else if (message.includes("只绑在回环地址上")) {
          /*
            这个状态在用户动手之前不会变，每轮都把那段十几行的操作指引整段记进
            日志毫无意义——真机日志里 282 条有八成是它刷出来的，真正有用的几行
            反而要翻半天才找得到。记一行短的，详情看第一次那条。
          */
          debugLog("guide", `第 ${guideAttempts.value} 次：配对服务仍只绑回环，等开关飞行模式`);
        } else {
          debugLog("guide", `第 ${guideAttempts.value} 次重试仍失败`, describeError(error));
        }
      })
      .finally(() => {
        if (run !== guideRun.current) return;
        guideBusy.current = false;
        /*
          这一轮刚落地就排下一轮。

          原先用 setInterval 按固定节拍打，一轮要是只花 200 ms 失败，也得干等到
          下一个节拍；而隧道重连上的窗口很短，很容易整段错过。现在是「结束即续」，
          快慢完全跟着上一轮走。
        */
        if (guideStage.value === "airplaneOn") {
          // 这里也走 ref：排下一轮时要用**那时**最新的版本，不是现在这份。
          guideTimer.current = setTimeout(() => attemptInGuideRef.current(), GUIDE_RETRY_MS);
        }
      });
  }

  /*
    给网络监听和定时器用的「当前版本」。

    `attemptInGuide` 每次渲染都会重新生成，它闭包里捏着 `pairing`、`settings`
    这些 state。只挂一次的 effect 直接引用就永远停在首帧——用户在本次运行里
    配好了对、或者改了隧道来源，重试统统看不见。
  */
  const attemptInGuideRef = useRef(attemptInGuide);
  attemptInGuideRef.current = attemptInGuide;

  function beginGuideLoop() {
    if (!guideStart.current) return;
    stopGuideLoop();
    guideAttempts.setValue(0);
    guideStage.setValue("airplaneOn");
    /*
      先立刻试一次，再开始轮询。

      setInterval 的第一次触发要等满一个间隔——用户点完「我正在使用移动数据」
      得先干等几秒才看到次数动，期间完全不知道它有没有在工作。
    */
    // 立刻开跑；后面每一轮由 attemptInGuide 自己接上
    attemptInGuide();
  }

  function dismissGuide(showError: boolean) {
    stopGuideLoop();
    guideStage.setValue(null);
    const error = guideError.current;
    guideStart.current = null;
    guideError.current = null;

    /*
      会话已经连上时，收起引导不能动状态。

      第三阶段的「完成」走的也是这里，而它原先无条件把 sessionState 打回 idle、
      清掉状态文案——界面于是从「更新坐标 / 恢复真实位置」变回「开始位置模拟」，
      看着像根本没连上，用户只好再开关一轮飞行模式，怎么都走不出去。
      连上了就只收起引导，其余一概不碰。
    */
    if (session.value) return;

    setSessionState("idle");
    setStatusMsg("");
    if (showError && error) {
      showMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function retryFromGuide() {
    const start = guideStart.current;
    if (!start) return;
    stopGuideLoop();
    guideStage.setValue(null);
    setSessionState("connecting");
    setStatusMsg("准备中…");
    try {
      await connectSession(start);
      guideStart.current = null;
      guideError.current = null;
    } catch (e) {
      debugLog("ui", "引导内重试失败", describeError(e));
      guideError.current = e;
      guideStage.setValue("help");
      setSessionState("idle");
      setStatusMsg("");
    }
  }

  /** 以给定坐标序列为路径开始移动（路线、GPX 共用）。 */
  async function startWalking(path: Coordinate[], choice: MovementSelection, label: string) {
    if (path.length < 2) {
      showMessage("路径至少需要两个点");
      return;
    }

    let instance: PathWalker;
    try {
      instance = new PathWalker(path, choice.speed.metresPerSecond, choice.lapPlan);
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e));
      return;
    }

    const handle = await ensureSession(path[0]);
    if (!handle) return;

    stopMovement();
    walker.setValue(instance);
    updateMovementKind("route");
    updateSelection(choice);

    const kmh = (choice.speed.metresPerSecond * 3.6).toFixed(1);
    setStatusMsg(`${label} · ${modeInfo(choice.mode).label} ${kmh} km/h`);

    let lastTick = Date.now();
    const timer = setInterval(() => {
      const current = walker.value;
      const active = session.value;
      if (!current || !active) return;

      // 按真实流逝的时间推进，不按定时器的标称间隔（它会被延迟、合并）。
      const now = Date.now();
      const elapsed = Math.min((now - lastTick) / 1000, MOVEMENT_MAX_STEP_S);
      lastTick = now;

      const state = current.advance(elapsed);
      void pushCoordinate(active, state.coordinate).catch((error) => {
        debugLog("ui", "移动中下发坐标失败", describeError(error));
      });

      const travelledKm = (state.travelled / 1000).toFixed(2);
      const totalKm = (state.total / 1000).toFixed(2);
      const legText = state.leg > 0 ? ` · 第 ${state.leg + 1} 趟` : "";
      const pauseText = state.paused ? " · 已暂停" : "";
      setStatusMsg(`${label} · ${travelledKm}/${totalKm} km${legText}${pauseText}`);

      if (state.finished) {
        finishMovement();
        setStatusMsg("已到达终点");
        fireToast("已到达终点");
      }
    }, MOVEMENT_TICK_MS);
    movementTimer.setValue(timer);
  }

  async function handlePlanRoute(choice: MovementSelection): Promise<void> {
    if (!coordReady.value) throw new Error("请先在地图上选择终点");

    const began = Date.now();
    const lap = (tag: string) => debugLog("route", `${tag}（累计 ${Date.now() - began}ms）`);

    let start = routeStart;
    if (start) {
      lap("起点已手动指定");
    } else if (activeLoc.value) {
      /*
        正在模拟时，「当前位置」就是我们自己下发的那个坐标，直接拿来用。

        不能去问 Location：模拟中它返回什么由系统说了算，实测会给一个几小时前的
        缓存——曾经出现过起点落在一千多公里外的陈旧位置上，然后用步行方式
        去规划，MapKit 自然算不出来。而且这还白等一次定位。
      */
      start = { latitude: activeLoc.value.latitude, longitude: activeLoc.value.longitude };
      lap("起点取自当前模拟位置");
    } else {
      /*
        没在模拟，才去问真实定位。

        这里坚持 `forceRequest`：缓存返回得快，但可能是上一个城市的，
        拿它当起点规划出来的路线完全是错的。宁可等，也有超时兜底。
      */
      setStatusMsg("定位起点…");
      lap("开始取当前位置");
      const gps = await withTimeout(
        Location.requestCurrent({ forceRequest: true }),
        12000,
        "取当前位置超时，请在「移动」面板里手动把选中的点设为起点",
      );
      lap(`取到当前位置 ${gps ? "成功" : "为空"}`);
      if (!gps) throw new Error("取不到当前位置，请手动指定起点");
      // GPS 是 WGS-84，而终点取自地图（地图系），规划前要统一到地图系。
      start = fromDeviceCoordinate(gps.latitude, gps.longitude);
    }

    const transport = modeInfo(choice.mode).transportType;
    const straight = distanceBetween(start, { latitude: coordLat.value, longitude: coordLng.value });
    debugLog(
      "route",
      `规划 ${transport}：${start.latitude.toFixed(5)}, ${start.longitude.toFixed(5)}` +
        ` → ${coordLat.value.toFixed(5)}, ${coordLng.value.toFixed(5)}，直线 ${(straight / 1000).toFixed(2)} km`,
    );

    // 步行方式在长距离上 MapKit 经常算很久甚至算不出来，先提醒一句。
    if (transport === "walking" && straight > 50_000) {
      debugLog("route", "注意：步行方式 + 超过 50 km，MapKit 很可能拒绝或极慢");
    }

    setStatusMsg("规划路线…");
    lap("调用 MapDirections.calculate");
    // 没有超时参数，自己包一层——不然算不出来会一直挂着，界面上看不出任何动静。
    const result = await withTimeout(
      MapDirections.calculate({
        source: { latitude: start.latitude, longitude: start.longitude },
        destination: { latitude: coordLat.value, longitude: coordLng.value },
        transportType: transport,
        requestsAlternateRoutes: true,
      }),
      30000,
      `路线规划超时（${modeInfo(choice.mode).label} · 直线 ${(straight / 1000).toFixed(0)} km）。` +
        "距离太远或该方式没有可用路线时会这样——换个交通方式，或者把起点终点拉近一点。",
    );
    lap(`calculate 返回 ${result.routes.length} 条`);

    const usable = result.routes
      .filter((item) => item.coordinates.length >= 2)
      .map((item) => ({
        name: item.name,
        coordinates: item.coordinates.map((c) => ({ latitude: c.latitude, longitude: c.longitude })),
        distance: item.distance,
        travelTime: item.expectedTravelTime,
      }));
    debugLog(
      "route",
      `可用 ${usable.length} 条：` +
        usable.map((r) => `${(r.distance / 1000).toFixed(2)}km/${Math.round(r.travelTime / 60)}min`).join("、"),
    );
    if (usable.length === 0) throw new Error("没有找到可用路线");

    // 路线换成别的来源了，手绘那几个编号点必须跟着清掉——
    // 不然地图上会同时出现「上一次手绘的 ①②③④」和「这次规划的折线」，
    // 看起来像是编号标错了位置。
    applyDrawnPath([]);
    setRoutes(usable);
    setRouteIndex(0);
    updateSelection(choice);
    setStatusMsg("");
    lap("完成");
  }

  function handleSelectRoute(index: number) {
    if (index >= 0 && index < routes.length) setRouteIndex(index);
  }

  function handleStartRoute(choice: MovementSelection) {
    const chosen = routes[routeIndex];
    if (!chosen) return;
    void startWalking(chosen.coordinates, choice, "沿路线移动");
  }

  // ── 起点与手绘路径 ────────────────────────────────────────────────

  function handleUseSelectionAsStart() {
    if (!coordReady.value) return;
    setRouteStart({ latitude: coordLat.value, longitude: coordLng.value });
    fireToast("已把选中的点设为起点");
  }

  function handleResetStart() {
    setRouteStart(null);
    fireToast("起点改回当前位置");
  }

  /** 点列变了就同步画出来——复用路线折线那条通道。 */
  function applyDrawnPath(next: Coordinate[]) {
    drawnRef.current = next;
    setDrawnPath(next);
    setRoutes(next.length > 0 ? [{ coordinates: next, distance: 0, travelTime: 0 }] : []);
    setRouteIndex(0);
  }

  function appendDrawnPoint(lat: number, lng: number) {
    const next = [...drawnRef.current, { latitude: lat, longitude: lng }];
    applyDrawnPath(next);
    fireToast(`已添加第 ${next.length} 个点`);
  }

  /** 进入手绘模式：收起面板，之后点地图就是落点。 */
  function handleBeginDrawing() {
    drawing.setValue(true);
    fireToast("手绘中：在地图上逐个点出要经过的位置");
  }

  /** 收笔。点够两个就直接把移动面板拉回来选速度，省得自己再找入口。 */
  function handleFinishDrawing() {
    drawing.setValue(false);
    if (drawnRef.current.length >= 2) openSheet("movement");
  }

  function handleAddDrawnPoint() {
    if (!coordReady.value) {
      showMessage("请先在地图上选择位置");
      return;
    }
    appendDrawnPoint(coordLat.value, coordLng.value);
  }

  function handleUndoDrawnPoint() {
    applyDrawnPath(drawnRef.current.slice(0, -1));
  }

  function handleClearDrawnPath() {
    applyDrawnPath([]);
  }

  function handleStartDrawnPath(choice: MovementSelection) {
    drawing.setValue(false);
    void startWalking(drawnRef.current, choice, "沿手绘路径移动");
  }

  async function handleImportGPX(choice: MovementSelection): Promise<void> {
    const files = await DocumentPicker.pickFiles({ types: ["public.data", "public.item"] });
    if (!files || files.length === 0) return;

    const track = parseGPX(FileManager.readAsStringSync(files[0]));
    // GPX 按规范是 WGS-84，转成地图系后画在地图上才对得上。
    const path = track.coordinates.map((point) => fromDeviceCoordinate(point.latitude, point.longitude));

    applyDrawnPath([]);
    setRoutes([{ coordinates: path, distance: 0, travelTime: 0 }]);
    setRouteIndex(0);
    await startWalking(path, choice, track.name ? `GPX · ${track.name}` : "GPX 轨迹");
  }

  async function handleStartJoystick(choice: MovementSelection) {
    if (!coordReady.value) {
      showMessage("请先在地图上选择起点");
      return;
    }

    const start: Coordinate = { latitude: coordLat.value, longitude: coordLng.value };
    const handle = await ensureSession(start);
    if (!handle) return;

    stopMovement();
    joystickPosition.setValue(start);
    updateMovementKind("joystick");
    updateSelection(choice);
    setStatusMsg(`摇杆 · ${modeInfo(choice.mode).label} ${(choice.speed.metresPerSecond * 3.6).toFixed(1)} km/h`);

    let lastJoystickTick = Date.now();
    const timer = setInterval(() => {
      const current = joystickPosition.value;
      const active = session.value;
      const vector = joystickVector.value;
      if (!current || !active) return;

      // 同路线推进：按真实流逝的时间，不按标称间隔。
      const now = Date.now();
      const elapsed = Math.min((now - lastJoystickTick) / 1000, MOVEMENT_MAX_STEP_S);
      lastJoystickTick = now;

      const next = joystickStep(
        current,
        vector.dx,
        vector.dy,
        choice.speed.metresPerSecond,
        elapsed,
      );
      if (next.latitude === current.latitude && next.longitude === current.longitude) return;

      joystickPosition.setValue(next);
      /*
        「当前坐标」要跟着摇杆走。

        底部卡片显示的是选中点，不同步的话推了半天卡片还停在起点，
        点「更新坐标」会直接把位置拽回出发地。
        这里只写坐标不反查地名——每 500 ms 反查一次纯属给自己找麻烦，
        地名留到松手停下时再更新。
      */
      coordLat.setValue(next.latitude);
      coordLng.setValue(next.longitude);
      void pushCoordinate(active, next).catch((error) => {
        debugLog("ui", "摇杆下发坐标失败", describeError(error));
      });
    }, MOVEMENT_TICK_MS);
    movementTimer.setValue(timer);
  }

  /**
   * 停止模拟。
   *
   * @param silent 由锁屏卡片的 intent 触发时传 true——那会儿用户在锁屏上，
   *               App 内的弹窗他看不见，失败原因由 intent 发通知告诉他。
   * @returns 失败原因；成功为 null
   */
  async function handleStopSession(silent = false): Promise<string | null> {
    try {
      return await stopSession(silent);
    } finally {
      /*
        保活留到真正收完才松手。

        停止失败时下面还要重连补发一次，慢的时候好几秒。这会儿要是保活已经撤了，
        用户正好锁屏，补发就连同整个 App 一起被挂起——停止指令永远送不到，
        而设备那头还停在假位置。
      */
      void releaseKeepAlive("session");
    }
  }

  /** `handleStopSession` 的正文；拆出来只为把保活的释放统一收进上面的 finally。 */
  async function stopSession(silent: boolean): Promise<string | null> {
    stopMovement();
    const handle = session.value;
    session.setValue(null);
    setSessionState("idle");
    setStatusMsg("");
    activeLoc.setValue(null);
    saveActiveCache(null);
    if (handle) {
      try {
        await handle.stop();
      } catch (e) {
        debugLog("ui", "停止失败，试着重连补发", describeError(e));
        /*
          别只报错，先自己补救一次。

          停止失败几乎都是隧道已经断了（锁屏掉线、网络切换），那条会话的通道
          没了，`handle.stop()` 自然发不出去——用户看到的是
          `RSDCDTunnelTransport.Failure 错误 7` 这种天书。

          而「不建会话、只连上去补发一次停止」本来就有现成的
          `restoreRealLocation`（上次没收尾时走的就是它）。隧道断了就重连一条，
          比让用户自己「重新连接后再停一次」靠谱得多。
        */
        const record = pairingRef.current;
        if (record) {
          /*
            补发期间别让界面装作没事。

            上面已经把 sessionState 设成了 idle，而这一段要连设备、建隧道，
            慢的时候好几秒。那期间按钮是「开始位置模拟」的样子，用户一点就
            又建一条隧道——而同时只允许一条。所以先回到 connecting，
            补完（成或败）再落回 idle。
          */
          setSessionState("connecting");
          setStatusMsg("连接已断开，正在重连补发停止…");
          try {
            await restoreRealLocation({
              record,
              endpoint: endpointFromSettings(settingsRef.current),
            });
            debugLog("ui", "重连补发停止成功");
            clearRecovery();
            void endLiveActivity();
            fireToast("已恢复真实位置");
            return null;
          } catch (retryError) {
            debugLog("ui", "重连补发也失败", describeError(retryError));
          } finally {
            setSessionState("idle");
            setStatusMsg("");
          }
        }

        // 补救也没成。卡片和恢复记录都留着：停止指令没送到，设备可能还在模拟，
        // 卡片得继续提醒，下次启动也要接着提示恢复。
        const message =
          "没能停止模拟\n" +
          `${e instanceof Error ? e.message : String(e)}\n\n` +
          "已自动重连补发过一次，仍然没送到。设备很可能还停在模拟位置——" +
          "回到这里重新连接一次再停，或者用锁屏卡片上的「恢复真实位置」。";
        if (!silent) showMessage(message);
        return message;
      }
    }
    clearRecovery();
    void endLiveActivity();
    fireToast("已恢复真实位置");
    return null;
  }

  async function handleUpdateCoord() {
    const handle = session.value;
    if (!handle || !coordReady.value) return;

    const lat = coordLat.value;
    const lng = coordLng.value;
    const target = deviceCoordinate(lat, lng);
    try {
      await handle.update(target.latitude, target.longitude);
      setStatusMsg(`模拟中 · ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      markActive(lat, lng);
      void updateLiveActivity({ latitude: lat, longitude: lng });
      fireToast("坐标已更新");
    } catch (e) {
      showMessage(`更新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 启动时那枚致谢条。
   *
   * 来源不止一处（界面基座、协议参考、搜索服务），一个按钮跳不了那么多链接，
   * 所以点开的是关于页里的完整名单，而不是其中某一个仓库。
   */
  function handleOpenCreditLink() {
    void Navigation.present({ element: <AboutPage /> });
  }

  function buildSheetContent(kind: SheetKind): VirtualNode | null {
    switch (kind) {
      case "settings":
        return <SettingsPage settings={settings} onChange={handleSettingsChange} onDone={closeSheet} />;
      case "favorites":
        return (
          <FavoritesPage
            favorites={favorites}
            history={history}
            active={activeLoc.value}
            onPick={(coord: Coordinate, name?: string) => handlePick(coord, name)}
            onDelete={handleDeleteFav}
            onClearAll={handleClearAllFav}
            onClearHistory={() => {
              clearHistory();
              setHistory([]);
              fireToast("已清空历史");
            }}
          />
        );
      case "search":
        return (
          <SearchPage
            globalEndpoint={settings.globalSearchEndpoint.trim() || DEFAULT_GLOBAL_ENDPOINT}
            onPick={(coord: Coordinate, name: string) => {
              handlePick(coord, name);
              if (name) fireToast(`已定位到：${name}`);
            }}
          />
        );
      case "movement":
        return (
          <MovementPanel
            initial={selection}
            routes={routes.map((item, index) => ({
              label: item.name?.trim() || `方案 ${index + 1}`,
              detail: describeRoute(item),
            }))}
            selectedRouteIndex={routeIndex}
            onSelectRoute={handleSelectRoute}
            hasDestination={coordReady.value}
            startLabel={
              routeStart
                ? `${routeStart.latitude.toFixed(4)}, ${routeStart.longitude.toFixed(4)}`
                : "当前真实位置"
            }
            drawnCount={drawnPath.length}
            onPlanRoute={handlePlanRoute}
            onStartRoute={handleStartRoute}
            onImportGPX={handleImportGPX}
            onStartJoystick={handleStartJoystick}
            onUseSelectionAsStart={handleUseSelectionAsStart}
            onResetStart={handleResetStart}
            onBeginDrawing={handleBeginDrawing}
            onAddDrawnPoint={handleAddDrawnPoint}
            onUndoDrawnPoint={handleUndoDrawnPoint}
            onClearDrawnPath={handleClearDrawnPath}
            onStartDrawnPath={handleStartDrawnPath}
          />
        );
      default:
        return null;
    }
  }

  function describeRoute(item: PlannedRoute): string {
    if (item.distance <= 0) return `${item.coordinates.length} 个点`;
    const km = (item.distance / 1000).toFixed(2);
    // 按所选速度自己算耗时——地图给的是按真实路况估的，与要走的速度对不上。
    const minutes = Math.max(1, Math.round(item.distance / selection.speed.metresPerSecond / 60));
    return `${km} km · 按当前速度约 ${minutes} 分钟`;
  }

  const sheetContent = buildSheetContent(sheetKind.value);
  const loc = activeLoc.value;

  const topBtnSize = 24;
  const topBtnPadding = 9;

  function topBtn(icon: string, tint: Color, action: () => void) {
    return (
      <Button action={action} glassEffect="circle">
        <Image
          systemName={icon}
          foregroundStyle={tint}
          frame={{ width: topBtnSize, height: topBtnSize }}
          padding={topBtnPadding}
        />
      </Button>
    );
  }

  /**
   * 展开时一个接一个弹出来，收起时倒着收回去。
   *
   * 这里必须用 `transition` 而不是 `scaleEffect` + `animation`：
   * 按钮是条件渲染的，展开那一刻才被插入视图树。`animation={{value}}` 动画的是
   * 「已存在的视图上某个值变了」，而这些按钮一出生 `open` 就是 true，没有变化
   * 可动画，`.delay()` 也就永远不会生效——会变成一起蹦出来。
   * `transition` 管的正是插入 / 移除本身，延迟挂在它上面才有波浪。
   *
   * index 是「离齿轮多远」，count 是这条扇形上一共几个；
   * anchor 让缩放朝着齿轮那一侧收，看起来像从齿轮里长出来。
   */
  function menuBtn(
    entry: MenuEntry,
    { index, count, anchor }: { index: number; count: number; anchor: KeywordPoint },
  ) {
    // 每次重新构造：`animation()` 是否原地修改没写明，共用一个实例可能被后一次覆盖
    const pop = () => Transition.scale(0.1, anchor).combined(Transition.opacity());
    return (
      <Button
        key={entry.icon}
        action={entry.action}
        glassEffect="circle"
        transition={Transition.asymmetric(
          // 展开：带回弹，从齿轮那头逐个往外推
          pop().animation(
            Animation.bouncy({ duration: 0.42, extraBounce: 0.32 }).delay(index * 0.055),
          ),
          // 收起：不回弹也更快，最远的先走，像被一路收回齿轮里
          pop().animation(Animation.easeIn(0.16).delay((count - 1 - index) * 0.035)),
        )}
      >
        <Image
          systemName={entry.icon}
          foregroundStyle={entry.tint}
          frame={{ width: topBtnSize, height: topBtnSize }}
          padding={topBtnPadding}
        />
      </Button>
    );
  }

  /*
    菜单落在哪个角。
    右上角是 MapKit 自带控件（定位、3D、指南针）的固定位置，`controls` 没有
    放置位置的参数，那三个挪不动，所以只开放另外三个角。
    扇形永远朝屏幕内侧展开：贴底就往上长，靠右就往左铺。
  */
  const atBottom = settings.menuCorner !== "topLeft";
  const atRight = settings.menuCorner === "bottomRight";
  /** 摇杆躲去菜单没占的那个底角，省得抢位置。 */
  const joystickOnRight = settings.menuCorner === "bottomLeft";

  const gearBtn = topBtn(
    menuOpen.value ? "xmark.circle.fill" : "gearshape",
    menuOpen.value ? "systemBlue" : "label",
    toggleMenu,
  );

  /** 竖排那组，从挨着齿轮的一个开始。 */
  const columnEntries: MenuEntry[] = [
    { icon: layerIcon(layer.value), tint: "label", action: cycleLayer },
    { icon: "location", tint: "systemBlue", action: () => withMenuClosed(handleCurrentLocation) },
    {
      icon: "personalhotspot",
      tint: pairing ? "systemGreen" : "systemOrange",
      action: () => withMenuClosed(openPairingPage),
    },
    { icon: "gearshape.2", tint: "label", action: () => withMenuClosed(() => openSheet("settings")) },
  ];

  /** 横排那组，同样从挨着齿轮的一个开始。 */
  const rowEntries: MenuEntry[] = [
    {
      icon: favorites.length > 0 ? "star.fill" : "star",
      tint: favorites.length > 0 ? "systemYellow" : "label",
      action: () => withMenuClosed(() => openSheet("favorites")),
    },
    { icon: "link", tint: "label", action: () => withMenuClosed(handleLinkParse) },
    { icon: "mappin.and.ellipse", tint: "label", action: () => withMenuClosed(handlePickFromMap) },
    { icon: "magnifyingglass", tint: "label", action: () => withMenuClosed(() => openSheet("search")) },
  ];

  /**
   * 铺开一组入口。
   *
   * `reversed` 只影响摆放顺序，动画序号仍按「离齿轮多远」算——
   * 波浪永远从齿轮那头往外扩散，四个方向观感一致。
   */
  function fanGroup(entries: MenuEntry[], reversed: boolean, axis: "row" | "column") {
    if (!menuOpen.value) return null;
    // 缩放锚点朝着齿轮，按钮看起来是从齿轮里挤出来的，不是凭空浮现
    const anchor: KeywordPoint =
      axis === "row" ? (reversed ? "trailing" : "leading") : reversed ? "bottom" : "top";
    const ordered = reversed ? [...entries].reverse() : entries;
    return (
      <>
        {ordered.map((entry, i, arr) =>
          menuBtn(entry, {
            index: reversed ? arr.length - 1 - i : i,
            count: arr.length,
            anchor,
          }),
        )}
      </>
    );
  }

  /*
    齿轮和竖排绑在同一个 VStack：竖排自动对齐到齿轮正上/正下方，
    不必按按钮直径去算边距——玻璃效果的实际直径由系统决定，算出来的值迟早会错位。
  */
  const gearStack = (
    <VStack spacing={8}>
      {atBottom ? fanGroup(columnEntries, true, "column") : null}
      {gearBtn}
      {atBottom ? null : fanGroup(columnEntries, false, "column")}
    </VStack>
  );

  const menuCluster = (
    <HStack
      alignment={atBottom ? "bottom" : "top"}
      spacing={8}
      frame={{ maxWidth: "infinity" }}
      padding={atBottom ? { bottom: 8 } : undefined}
    >
      {atRight ? <Spacer /> : null}
      {atRight ? fanGroup(rowEntries, true, "row") : null}
      {gearStack}
      {atRight ? null : fanGroup(rowEntries, false, "row")}
      {atRight ? null : <Spacer />}
    </HStack>
  );

  return (
    <ZStack
      sheet={
        sheetKind.value && sheetContent ? { content: sheetContent, isPresented: showSheet } : undefined
      }
      toast={
        toastMsg.value
          ? { message: toastMsg.value, isPresented: showToast, position: "top", duration: 2.5 }
          : undefined
      }
    >
      {/*
        提示浮层挂在这一层，不挂 ZStack。

        一个视图只能带一个 sheet，而 ZStack 那个已经给功能页（设置/收藏/搜索/移动）
        占着了。Group 是透明容器，不影响 ZStack 的层叠，正好拿来当第二个挂载点。
      */}
      <Group
        sheet={{
          content: (
            <MessageSheet
              message={errorMsg.value}
              tone={messageOptions.current.tone}
              confirm={
                messageOptions.current.action
                  ? {
                      label: messageOptions.current.action.label,
                      onConfirm: () => {
                        // 先收浮层再做事：动作可能是跳出应用，留着它会压在回来后的界面上
                        const run = messageOptions.current.action?.run;
                        showError.setValue(false);
                        run?.();
                      },
                    }
                  : undefined
              }
              dismissLabel={
                messageOptions.current.dismissLabel ?? (messageOptions.current.action ? "暂不" : undefined)
              }
              onDismiss={() => {
                const bye = messageOptions.current.onDismiss;
                showError.setValue(false);
                bye?.();
              }}
            />
          ),
          isPresented: showError,
        }}
      >
        <MapPage
          pendingCoord={pendingCoord}
          recenterCoord={recenterCoord}
          coordLat={coordLat}
          coordLng={coordLng}
          activeLoc={activeLoc}
          layer={layer}
          routes={routes.map((item) => item.coordinates)}
          selectedRouteIndex={routeIndex}
          jitterRadius={settings.jitterRadius}
          drawnPath={drawnPath}
          onCoordChange={handleCoordChange}
          onPickUnavailable={() => fireToast("地图还没准备好，稍等一下再点")}
        />
      </Group>

      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} alignment="leading">
        {/* 关闭键始终在左上角：它是退出，不该跟着惯用手跑来跑去 */}
        <HStack alignment="top" spacing={8} padding={{ top: 12, leading: 16, trailing: 16 }}>
          {/*
            首页 Tab 里没有「关闭」这回事：界面是常驻的，`dismiss()` 没有模态
            可关，按了什么也不会发生。少画一个按钮，也给菜单腾出位置。
          */}
          {IS_HOME_TAB ? null : topBtn("xmark", "systemRed", handleCloseApp)}
          {atBottom ? <Spacer /> : menuCluster}
        </HStack>
        <Spacer />
      </VStack>

      <VStack
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        alignment="leading"
        padding={{ leading: 16, trailing: 16, bottom: 0 }}
      >
        <Spacer />
        {/*
          手绘中的操作条。
          撤销 / 清空 / 完成都摆在地图上，是因为取点本来就在地图上发生——
          为了撤掉一个点去开一次面板，点不了几个就会放弃。
        */}
        {drawing.value ? (
          <HStack
            spacing={10}
            padding={{ vertical: 10, leading: 14, trailing: 14 }}
            frame={{ maxWidth: "infinity" }}
            glassEffect={{ type: "rect", cornerRadius: 18 }}
          >
            <Image systemName="scribble.variable" foregroundStyle="systemIndigo" font="subheadline" />
            <Text font="subheadline" foregroundStyle="label">
              {drawnPath.length > 0 ? `已点 ${drawnPath.length} 个` : "点地图落点"}
            </Text>
            <Spacer />
            <Button
              action={handleUndoDrawnPoint}
              disabled={drawnPath.length === 0}
              buttonStyle="borderless"
            >
              <Image systemName="arrow.uturn.backward" font="subheadline" />
            </Button>
            <Button
              action={handleClearDrawnPath}
              disabled={drawnPath.length === 0}
              buttonStyle="borderless"
            >
              <Image systemName="trash" foregroundStyle="systemRed" font="subheadline" />
            </Button>
            <Button action={handleFinishDrawing} buttonStyle="borderless">
              <Text font="subheadline" foregroundStyle="systemBlue">
                {drawnPath.length >= 2 ? "完成" : "退出"}
              </Text>
            </Button>
          </HStack>
        ) : null}
        {/*
          摇杆。
          必须和坐标卡同在这一层：顶部那层是另一个 ZStack 子节点，画在坐标卡
          下面，摇杆摆在那儿会被卡片整个盖住。
          左右跟着菜单走，占住菜单没用的那个底角。
        */}
        {movementKind === "joystick" ? (
          <HStack frame={{ maxWidth: "infinity" }} padding={{ bottom: 8 }}>
            {joystickOnRight ? <Spacer /> : null}
            <JoystickPad
              vector={joystickVector}
              cardOffset={joystickOffset}
              modeLabel={modeInfo(selection.mode).label}
              maxKmh={selection.speed.metresPerSecond * 3.6}
              onRecenter={() =>
                recenterCoord.setValue({ latitude: coordLat.value, longitude: coordLng.value })
              }
              onStop={() => {
                finishMovement();
                // 推的过程中只同步了坐标，地名还停在出发地——停下来补一次反查。
                void resolvePlaceName(coordLat.value, coordLng.value);
              }}
            />
            {joystickOnRight ? null : <Spacer />}
          </HStack>
        ) : null}
        {/*
          底角模式的菜单压在坐标卡正上方。
          排在摇杆下面，这样齿轮相对坐标卡的位置是固定的——
          放摇杆上面的话，一开摇杆齿轮就整体上移一截。
        */}
        {atBottom ? menuCluster : null}
        {showCredit ? (
          <Button action={handleOpenCreditLink}>
            <HStack
              spacing={6}
              padding={{ vertical: 8, leading: 12, trailing: 12 }}
              glassEffect={{ type: "rect", cornerRadius: 14 }}
            >
              <Text font="caption" foregroundStyle="secondaryLabel">致谢：</Text>
              <Text font="caption" foregroundStyle="systemBlue">wloc · BlackCCCat</Text>
            </HStack>
          </Button>
        ) : null}
        <VStack
          alignment="leading"
          spacing={12}
          padding={{ top: 16, bottom: 16, leading: 16, trailing: 16 }}
          frame={{ maxWidth: "infinity" }}
          glassEffect={{ type: "rect", cornerRadius: 24 }}
          shadow={{ color: "rgba(0,0,0,0.15)", radius: 20, y: -5 }}
          clipShape={{ type: "rect", cornerRadius: 24 }}
        >
          <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
            <Image
              systemName="personalhotspot"
              foregroundStyle={pairing ? "systemBlue" : "tertiaryLabel"}
              font="subheadline"
            />
            <Text font="subheadline" foregroundStyle="label">设备</Text>
            <Spacer />
            <Button action={openPairingPage}>
              <Text font="caption" foregroundStyle={pairing ? "systemGreen" : "systemOrange"}>
                {pairing ? `● ${pairing.deviceName || "已配对"}` : "● 未配对"}
              </Text>
            </Button>
          </HStack>

          <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
            <Image systemName="mappin.and.ellipse" foregroundStyle="systemRed" font="subheadline" />
            <Text font="headline" foregroundStyle="label">当前坐标</Text>
            <Spacer />
            {/*
              收藏相关的两个入口并排放在标题行。

              收藏放这儿，是因为它原先和「开始位置模拟」并排在底部，而那一排在模拟
              进行中会整个换成「更新坐标 / 恢复真实位置」——走到一个想记下来的地方
              时，收藏入口恰好不见了。它针对的本来就是上面这个坐标，挂在标题行才对。

              旁边补一个「收藏夹」：翻已存的地点比新增更常用，而它原先只在顶部菜单
              里，得先把菜单展开才看得到，比「收藏」这个低频动作还深一层。
              两个都用图标按钮，不带文字，省地方也不至于把标题挤掉。
            */}
            <Button
              buttonStyle="borderless"
              action={() => openSheet("favorites")}
            >
              <HStack spacing={4}>
                <Image systemName="list.star" foregroundStyle="systemBlue" font="caption" />
                <Text font="caption2" foregroundStyle="systemBlue">收藏夹</Text>
              </HStack>
            </Button>
            <Button
              buttonStyle="borderless"
              action={
                isCurrentCoordFavorited()
                  ? handleRemoveCurrentFavorite
                  : () => handleAddFavorite({ latitude: coordLat.value, longitude: coordLng.value })
              }
              disabled={!coordReady.value}
            >
              <HStack spacing={4}>
                <Image
                  systemName={isCurrentCoordFavorited() ? "star.fill" : "star"}
                  foregroundStyle={isCurrentCoordFavorited() ? "systemOrange" : "systemBlue"}
                  font="caption"
                />
                <Text
                  font="caption2"
                  foregroundStyle={isCurrentCoordFavorited() ? "systemOrange" : "systemBlue"}
                >
                  {isCurrentCoordFavorited() ? "已收藏" : "收藏"}
                </Text>
              </HStack>
            </Button>
          </HStack>

          {/*
            两套坐标并排列出。

            地图上点出来的是**地图系**（大陆 GCJ-02），而真正下发给设备、
            别处的 GPS 工具认的是 **WGS-84**，两者在国内差几百米。以前只显示
            前者，拿去和别的定位工具对账会以为脚本算错了——差值恰恰是对的证明。

            境外两系相同（`gcj02ToWgs84` 原样返回），那时只显示一行，
            不去无中生有地制造区别。

            `handlePickFromMap` 从整行移到了「精确选点」这个按钮上：行里现在有
            复制按钮，而 Button 套 Button 在 SwiftUI 里点击目标会打架（SKILL 2.3
            记的是 List 行内多按钮，同一个道理）。
          */}
          {coordReady.value ? (
            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity" }}>
              {coordReadoutRows()}
              <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
                <Text font="caption2" foregroundStyle="tertiaryLabel">纬度, 经度</Text>
                <Spacer />
                <Button buttonStyle="borderless" action={handlePickFromMap}>
                  <HStack spacing={4}>
                    <Image systemName="scope" foregroundStyle="systemBlue" font="caption" />
                    <Text font="caption2" foregroundStyle="systemBlue">精确选点</Text>
                  </HStack>
                </Button>
              </HStack>
            </VStack>
          ) : (
            <Button action={handlePickFromMap}>
              <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
                <Text font="subheadline" foregroundStyle="secondaryLabel">
                  在地图上点一下即可选点
                </Text>
                <Spacer />
                <Image systemName="scope" foregroundStyle="systemBlue" font="caption" />
                <Text font="caption2" foregroundStyle="systemBlue">精确选点</Text>
              </HStack>
            </Button>
          )}

          {!!statusMsg && (
            <Text font="caption" foregroundStyle={sessionState === "active" ? "systemGreen" : "secondaryLabel"}>
              {statusMsg}
            </Text>
          )}

          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            {/* 空闲时把当前方式与速度写在按钮上，省得为看一眼设置还要点进面板 */}
            <Button
              action={() => openSheet("movement")}
              frame={{ maxWidth: "infinity" }}
              background={{ style: movementKind === "none" ? "systemGray5" : "systemGreen", shape: "capsule" }}
              tint={movementKind === "none" ? "label" : "white"}
            >
              <HStack spacing={6} padding={{ vertical: 8, leading: 14, trailing: 16 }}>
                <Image systemName={modeInfo(selection.mode).systemImage} font="subheadline" />
                <Text font="subheadline" fontWeight="medium">
                  {movementKind === "none"
                    ? `移动 · ${modeInfo(selection.mode).label} ${(selection.speed.metresPerSecond * 3.6).toFixed(1)} km/h`
                    : movementKind === "joystick"
                      ? "摇杆中"
                      : "移动中"}
                </Text>
              </HStack>
            </Button>
            {movementKind === "route" ? (
              <Button
                action={togglePaused}
                frame={{ maxWidth: "infinity" }}
                background={{ style: paused ? "systemGreen" : "systemOrange", shape: "capsule" }}
                tint="white"
              >
                <HStack spacing={6} padding={{ vertical: 8, leading: 12, trailing: 14 }}>
                  <Image systemName={paused ? "play.fill" : "pause.fill"} font="subheadline" />
                  <Text font="subheadline" fontWeight="medium">{paused ? "继续" : "暂停"}</Text>
                </HStack>
              </Button>
            ) : null}
            {movementKind === "route" ? (
              <Button
                action={reverseMovement}
                frame={{ maxWidth: "infinity" }}
                background={{ style: "systemIndigo", shape: "capsule" }}
                tint="white"
              >
                <HStack spacing={6} padding={{ vertical: 8, leading: 12, trailing: 14 }}>
                  <Image systemName="arrow.uturn.backward" font="subheadline" />
                  <Text font="subheadline" fontWeight="medium">反向</Text>
                </HStack>
              </Button>
            ) : null}
            {movementKind !== "none" ? (
              <Button
                action={finishMovement}
                frame={{ maxWidth: "infinity" }}
                background={{ style: "systemRed", shape: "capsule" }}
                tint="white"
              >
                <HStack spacing={6} padding={{ vertical: 8, leading: 12, trailing: 14 }}>
                  <Image systemName="stop.fill" font="subheadline" />
                  <Text font="subheadline" fontWeight="medium">停止</Text>
                </HStack>
              </Button>
            ) : null}
          </HStack>

          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            {sessionState === "active" ? (
              <>
                <Button
                  action={handleUpdateCoord}
                  frame={{ maxWidth: "infinity" }}
                  background={{ style: "systemBlue", shape: "capsule" }}
                  tint="white"
                >
                  <HStack spacing={6} padding={{ vertical: 10, leading: 16, trailing: 20 }}>
                    <Image systemName="arrow.triangle.2.circlepath" font="subheadline" />
                    <Text font="subheadline" fontWeight="medium">更新坐标</Text>
                  </HStack>
                </Button>
                <Button
                  action={handleStopSession}
                  frame={{ maxWidth: "infinity" }}
                  background={{ style: "systemRed", shape: "capsule" }}
                  tint="white"
                >
                  <HStack spacing={6} padding={{ vertical: 10, leading: 16, trailing: 20 }}>
                    <Image systemName="location.slash" font="subheadline" />
                    <Text font="subheadline" fontWeight="medium">恢复真实位置</Text>
                  </HStack>
                </Button>
              </>
            ) : (
              <>
                <Button
                  action={handleStartSession}
                  disabled={sessionState === "connecting" || !pairing}
                  frame={{ maxWidth: "infinity" }}
                  background={{
                    style: sessionState === "connecting" ? "systemGray" : "systemIndigo",
                    shape: "capsule",
                  }}
                  tint="white"
                >
                  <HStack spacing={6} padding={{ vertical: 10, leading: 16, trailing: 20 }}>
                    <Image
                      systemName={sessionState === "connecting" ? "hourglass" : "location.fill"}
                      font="subheadline"
                    />
                    <Text font="subheadline" fontWeight="medium">
                      {sessionState === "connecting" ? "连接中…" : "开始位置模拟"}
                    </Text>
                  </HStack>
                </Button>
                {/*
                  重连期间给个叫停的出口。

                  五轮重连加上每轮的等待和超时，整段可能跑一分多钟，而那期间
                  「开始位置模拟」是灰的——用户除了干等没有别的选择。只有真在
                  重连时才出现，首次连接那几秒不必打扰。
                */}
                {sessionState === "connecting" && reconnecting.value ? (
                  <Button
                    action={() => {
                      reconnectCancelled.current = true;
                      setStatusMsg("正在取消重连…");
                    }}
                    background={{ style: "tertiarySystemFill", shape: "capsule" }}
                  >
                    <Text
                      font="subheadline"
                      foregroundStyle="label"
                      padding={{ vertical: 10, leading: 16, trailing: 16 }}
                    >
                      取消
                    </Text>
                  </Button>
                ) : null}
              </>
            )}
          </HStack>

          <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
            {loc ? (
              <>
                <Image systemName="checkmark.circle.fill" foregroundStyle="systemGreen" font="subheadline" />
                <Text font="subheadline" foregroundStyle="systemGreen">
                  模拟中 经度 {loc.longitude.toFixed(6)} 纬度 {loc.latitude.toFixed(6)}
                </Text>
              </>
            ) : (
              <>
                <Image systemName="location.slash" foregroundStyle="tertiaryLabel" font="subheadline" />
                <Text font="subheadline" foregroundStyle="tertiaryLabel">当前为真实位置</Text>
              </>
            )}
          </HStack>
        </VStack>
      </VStack>

      {/*
        蜂窝引导压在最上层，并且盖一层半透明背景——这期间要用户去控制中心切
        飞行模式，底下的地图和按钮都不该还能点。
      */}
      {guideStage.value !== null ? (
        <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <Rectangle fill="rgba(0,0,0,0.45)" frame={{ maxWidth: "infinity", maxHeight: "infinity" }} />
          <CellularGuide
            stage={guideStage.value}
            attempts={guideAttempts.value}
            onCellular={onCellular.value}
            onRetry={() => void retryFromGuide()}
            onRetryNow={attemptInGuide}
            onUseCellular={beginGuideLoop}
            onCancel={() => dismissGuide(true)}
            onDone={() => dismissGuide(false)}
          />
        </ZStack>
      ) : null}
    </ZStack>
  );
}

const run = async () => {
  await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" });
  Script.exit();
};

/*
  **只有从脚本列表直接运行时才自己呈现。**

  另外两个入口文件（`home_screen_default_ui.tsx`、`intent.tsx`）都要 import
  这个文件来拿 App，而 import 会把顶层代码整个求值一遍。它们各自已经把界面
  挂上或呈现了，这里再 present 一次就是平白多一层全屏模态；更要命的是后面
  那句 `Script.exit()`——它会终止整个实例，把那两个入口刚建立的东西一起带走
  （首页 Tab 上会只剩一个不再响应的界面，得手动 Reload 才能救回来）。

  所以这里按 env 精确判断，不要写成「非某某环境」——将来再多一个入口，
  那种写法会默默地又把这段跑起来。
*/
if (Script.env === "index") run();
