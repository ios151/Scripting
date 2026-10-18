// 设备工具箱 —— 用开发者通道读本机的设备信息、电池健康、主屏布局、应用与描述文件，外加电源操作
// Copyright (C) 2026 ios151
//
// core/ 是协议层：RemotePairing、RSD、plist、DTX。改它之前先读文件头的注释，
// 那里记着每一处为什么是现在这个写法。
//
// 链路：本机隧道 → RemotePairing 握手 → pair-verify → RSD 隧道 → RSD 服务表
//      → 各服务：RSDCheckin 之后收发 XML plist（kit/lockdown.ts）

import {
  Button,
  HStack,
  Image,
  List,
  LiveActivity,
  Navigation,
  NavigationLink,
  NavigationStack,
  ProgressView,
  Script,
  Spacer,
  Text,
  VStack,
  useEffect,
  useState,
  type Color,
  type VirtualNode,
} from "scripting";
import { describeError } from "./core/debug";
import { loadPairing } from "./core/pairing";
import { deviceHub } from "./kit/hub";
import { LINK_LABEL, linkHint, needsAttention, watchLink, type LinkKind } from "./kit/network";
import { AppsPage } from "./pages/AppsPage";
import { ConfigProfilesPage } from "./pages/ConfigProfilesPage";
import { BatteryPage } from "./pages/BatteryPage";
import { CacheSection } from "./pages/CacheSection";
import { EventsPage } from "./pages/EventsPage";
import { LowLevelPage } from "./pages/LowLevelPage";
import { HomeScreenPage } from "./pages/HomeScreenPage";
import { InfoPage } from "./pages/InfoPage";
import { PairingPage } from "./pages/PairingPage";
import { FoldableSection, SectionLabel } from "./pages/common";
import { PowerSection } from "./pages/PowerSection";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { BeepPage } from "./pages/BeepPage";
import { SignCheckPage } from "./pages/SignCheckPage";
import { SysmonPage } from "./pages/SysmonPage";

function FeatureRow({ title, subtitle, systemImage, color }: { title: string; subtitle: string; systemImage: string; color: Color }) {
  return (
    <HStack spacing={12}>
      <Image systemName={systemImage} foregroundStyle={color} font="title3" frame={{ width: 30 }} />
      <VStack alignment="leading" spacing={2}>
        <Text>{title}</Text>
        <Text font="caption" foregroundStyle="secondaryLabel">
          {subtitle}
        </Text>
      </VStack>
    </HStack>
  );
}

/**
 * 这次是作为 Scripting 的首页 Tab 在跑，不是从脚本列表点开的一次运行。
 *
 * 差别不只是入口：Tab 上的实例**常驻**（切走再切回来状态还在），
 * 没有可以关的模态，也不该调 `Script.exit()`。
 */
const IS_HOME_TAB = Script.env === "home_screen";

export function App() {
  const dismiss = Navigation.useDismiss();
  const [paired, setPaired] = useState(() => loadPairing() !== null);
  const [connected, setConnected] = useState(deviceHub.connected);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  // 连接状态以 hub 为准：功能页里自动连上、电源操作后断开，这里都跟着变
  useEffect(() => deviceHub.subscribe(setConnected), []);

  /*
    走蜂窝还是 WiFi。蜂窝下 mDNS 找不到配对服务，连之前就该提醒，而不是等它失败。
    已经连上之后不提：mDNS 只在建会话那一刻用得上，连上再切回蜂窝不受影响。
  */
  const [link, setLink] = useState<LinkKind>("unknown");
  useEffect(() => watchLink(setLink), []);

  const linkWarning = connected || busy ? "" : linkHint(link);

  // 启动时清掉上一轮留下的电池卡片：卡片的生命周期独立于脚本，划掉 App 后会停在
  // 最后一刻。刚启动时不可能有正在进行的实时刷新，在的卡片都是残留。
  useEffect(() => {
    void LiveActivity.endAllActivities({ dismissTimeInterval: 0 }).catch(() => undefined);
  }, []);

  /*
    首页 Tab 的界面是常驻的，切到别的 Tab 再回来，顶层代码不会重跑。
    这期间隧道可能已经被系统收掉了，所以切回来核对一次，别一直显示「已连接」。
    不是 Tab 的时候这个回调永远不会被调，注册一下也无妨。
  */
  useEffect(() => Script.onHomeTabEvent((event) => {
    if (event !== "selected") return;
    void deviceHub.refresh();
  }), []);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      await deviceHub.get(setStatus);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : describeError(failure));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  function refreshPairing() {
    setPaired(loadPairing() !== null);
  }

  /*
    功能列表写成数据：组标题上要显示「N 项」，摆成数组才数得出来，加减一项也只动一行。
    放在组件里每次渲染重建，和原先直接内联写 JSX 是一回事。
  */
  const features: {
    key: string;
    title: string;
    subtitle: string;
    systemImage: string;
    color: Color;
    page: VirtualNode;
  }[] = [
    { key: "info", title: "设备信息", subtitle: "型号、系统、存储、序列号", systemImage: "iphone", color: "systemBlue", page: <InfoPage /> },
    { key: "battery", title: "电池健康", subtitle: "循环次数、设计与满充容量、温度", systemImage: "battery.75percent", color: "systemGreen", page: <BatteryPage /> },
    { key: "home", title: "主屏布局", subtitle: "查看、备份、导出成图", systemImage: "square.grid.3x3.fill", color: "systemIndigo", page: <HomeScreenPage /> },
    { key: "apps", title: "应用管理", subtitle: "版本、占用空间、安装来源，卸载", systemImage: "square.stack.3d.up.fill", color: "systemOrange", page: <AppsPage /> },
    { key: "profiles", title: "签名到期", subtitle: "描述文件还剩几天，谁在用", systemImage: "checkmark.seal.fill", color: "systemTeal", page: <ProfilesPage /> },
    { key: "configs", title: "配置描述文件", subtitle: "VPN、根证书、桌面图标，设置里那些", systemImage: "doc.badge.gearshape", color: "systemBrown", page: <ConfigProfilesPage /> },
    { key: "signcheck", title: "签名检查", subtitle: "自签的包为什么装不上 / 打不开", systemImage: "signature", color: "systemPurple", page: <SignCheckPage /> },
    { key: "sysmon", title: "实时性能", subtitle: "CPU、内存、进程占用", systemImage: "speedometer", color: "systemRed", page: <SysmonPage /> },
    { key: "events", title: "系统事件", subtitle: "实时看系统内部在发什么事件", systemImage: "bolt.horizontal.circle.fill", color: "systemYellow", page: <EventsPage /> },
    { key: "lowlevel", title: "底层", subtitle: "硬件规格、硬件树、设备服务", systemImage: "cpu", color: "systemPink", page: <LowLevelPage /> },
    // speaker.slash 而不是 bell.slash：这页关的是「正在录音」的**播报声**，
    // 铃铛那个容易被当成通知静音。颜色也从 systemGray 换掉——整列就它最看不见。
    { key: "beep", title: "通话录音提示音", subtitle: "静音通话提示音（ios27-27b2）其他未测试", systemImage: "speaker.slash.fill", color: "systemMint", page: <BeepPage /> },
  ];

  return (
    <NavigationStack>
      <List
        navigationTitle="设备工具箱"
        listStyle="insetGroup"
        /*
          首页 Tab 上没有「退出」这回事：界面是常驻的，`dismiss()` 没有模态可关，
          按了什么也不会发生。少画一个按钮。
        */
        toolbar={IS_HOME_TAB ? undefined : { cancellationAction: <Button title="退出" action={() => dismiss()} /> }}
      >
        {/* 连接前要确认的东西都在这一组：连不连得上、走的什么网、配没配对、连接怎么设的。 */}
        <FoldableSection
          id="connect"
          label={
            <SectionLabel
              title="连接与设置"
              note={connected ? "已连接" : paired ? "未连接" : "未配对"}
              tint={connected ? "systemGreen" : paired ? "secondaryLabel" : "systemOrange"}
            />
          }
          footer={
            <Text foregroundStyle={error ? "systemRed" : linkWarning ? "systemOrange" : "tertiaryLabel"}>
              {error ||
                linkWarning ||
                "进功能页时会自动连接。整个 Scripting 同时只能有一条设备隧道：别的脚本正占着时，这里连不上，反之亦然。"}
            </Text>
          }
        >
          {busy ? (
            <HStack spacing={10}>
              <ProgressView />
              <Text foregroundStyle="secondaryLabel">{status || "连接设备…"}</Text>
            </HStack>
          ) : (
            <HStack>
              <Text>{connected ? "已连接" : paired ? "未连接" : "未配对"}</Text>
              <Spacer />
              {paired ? (
                connected ? (
                  <Button title="断开" action={() => void deviceHub.disconnect()} />
                ) : (
                  <Button title="连接" action={() => void connect()} />
                )
              ) : null}
            </HStack>
          )}
          {link === "unknown" ? null : (
            <HStack>
              <Text>网络</Text>
              <Spacer />
              <Text foregroundStyle={needsAttention(link) ? "systemOrange" : "secondaryLabel"}>{LINK_LABEL[link]}</Text>
            </HStack>
          )}
          <NavigationLink destination={<PairingPage onChanged={refreshPairing} />}>
            <HStack>
              <Text>配对</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{paired ? "已配对" : "未配对"}</Text>
            </HStack>
          </NavigationLink>
          <NavigationLink destination={<SettingsPage />}>
            <Text>连接设置</Text>
          </NavigationLink>
        </FoldableSection>

        <FoldableSection id="features" label={<SectionLabel title="功能" note={`${features.length} 项`} />}>
          {features.map((feature) => (
            <NavigationLink key={feature.key} destination={feature.page}>
              <FeatureRow
                title={feature.title}
                subtitle={feature.subtitle}
                systemImage={feature.systemImage}
                color={feature.color}
              />
            </NavigationLink>
          ))}
        </FoldableSection>

        {paired ? <PowerSection /> : null}

        <CacheSection />
      </List>
    </NavigationStack>
  );
}

/**
 * 从脚本列表点开的那一次运行：弹全屏，关掉时收尾。
 *
 * 首页 Tab 那条路**不走这里**——`home_screen_default_ui.tsx` 会 import 这个文件，
 * 顶层代码跟着跑一遍，不拦的话 Tab 上会再弹一层模态出来。
 */
async function run() {
  await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" });
  await LiveActivity.endAllActivities({ dismissTimeInterval: 0 }).catch(() => undefined);
  await deviceHub.disconnect();
  Script.exit();
}

if (!IS_HOME_TAB) run();
