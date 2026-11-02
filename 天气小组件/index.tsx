// 在 App 里打开脚本时的页面：看现在的天气和详细数据、立即刷新、选看哪里的天气、选数据从哪里来（内置 / 自己的 / 备用）、
// 天气预警、预览各种尺寸的小组件、数据来源。
//
// 小组件里弹不了授权框，所以定位的授权要在这里给：第一次打开会问；这里取到的位置也会存下来，
// 小组件里现场定位不成时就退回它。卡片预览用的是小组件那一套（widget/bodies.tsx），看到的样子就是主屏幕上的样子。

import {
  Button,
  Device,
  HStack,
  List,
  Menu,
  Navigation,
  NavigationStack,
  Picker,
  Script,
  Section,
  Spacer,
  Text,
  TextField,
  Widget,
  useEffect,
  useRef,
  useState,
  type WidgetFamily,
} from "scripting";
import type { AlertState } from "./core/alertState";
import { cleanHost, cleanToken } from "./core/caiyun";
import { ALERT_DEMO_MS } from "./core/config";
import { defaultSource, providerOf, type DataSource, type SourceMode } from "./core/dataSource";
import { loadEverything, type Everything } from "./core/everything";
import type { Loaded, Source } from "./core/load";
import { present, sourceTestMessage, updatedText, type Content } from "./core/present";
import type { Settings } from "./core/settings";
import { clearData, clearDemo, loadSettings, readDataSource, readDemoUntil, saveSettings, writeDataSource, writeDemoUntil } from "./core/store";
import { findPlace, systemDeps } from "./core/system";
import { AlertsSection } from "./pages/AlertsSection";
import { AirSection, DetailSection, LifeSection, SummarySection, WeekSection } from "./pages/DetailSections";
import { LoadingCard, PreviewCard } from "./pages/Preview";
import { SourceSection } from "./pages/SourceSection";

const PREVIEWS: ReadonlyArray<{ family: WidgetFamily; title: string }> = [
  { family: "systemSmall", title: "小号" },
  { family: "systemMedium", title: "中号" },
  { family: "systemLarge", title: "大号" },
  { family: "accessoryRectangular", title: "锁屏 · 矩形" },
  { family: "accessoryCircular", title: "锁屏 · 圆形" },
  { family: "accessoryInline", title: "锁屏 · 单行" },
];

const SOURCE_TEXT: Readonly<Record<Source, string>> = {
  live: "当前定位",
  stored: "上次定位",
  fixed: "固定城市",
  param: "小组件参数",
};

/** 「地点」那一行：没有数据时说原因，有数据时说地点 */
function placeLine(loaded: Loaded | null): string {
  if (loaded === null) return "正在取…";
  if (loaded.kind === "noLocation") return "没拿到位置";
  if (loaded.kind === "noData") return "天气暂时取不到";
  return loaded.place ?? "当前位置";
}

function Row({ title, value }: { title: string; value: string }) {
  return (
    <HStack>
      <Text>{title}</Text>
      <Spacer />
      <Text foregroundStyle="secondaryLabel" lineLimit={1}>
        {value}
      </Text>
    </HStack>
  );
}

function App() {
  const dismiss = Navigation.useDismiss();
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [choice, setChoice] = useState<Settings["mode"]>(() => loadSettings().mode);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [alerts, setAlerts] = useState<AlertState | null>(null);
  const [source, setSource] = useState<DataSource>(() => readDataSource());
  const [sourceChoice, setSourceChoice] = useState<SourceMode>(() => readDataSource().mode);
  const [hostText, setHostText] = useState(() => readDataSource().host);
  const [tokenText, setTokenText] = useState("");
  const [demoUntil, setDemoUntil] = useState(() => readDemoUntil());
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const latest = useRef(0);

  /** 取一次天气。快速连点、或者取的过程中又改了设置，只认最后一次的结果 */
  async function refresh(force: boolean, using: Settings): Promise<Everything | null> {
    const ticket = ++latest.current;
    setBusy(true);
    try {
      const result = await loadEverything(systemDeps("app", force), { settings: using, parameter: null, force });
      if (ticket !== latest.current) return null;
      setLoaded(result.weather);
      setAlerts(result.alerts);
      setNow(Date.now());
      Widget.reloadAll();
      return result;
    } finally {
      if (ticket === latest.current) setBusy(false);
    }
  }

  useEffect(() => {
    void refresh(false, settings);
  }, []);

  // 「预览预警样式」到点自己收：页面开着时 `now` 不会自己走，所以到点了要主动收掉、重新取一次（refresh 顺手让主屏幕的小组件也重画）
  useEffect(() => {
    const left = demoUntil - Date.now();
    if (left <= 0) return undefined;
    const timer = setTimeout(() => {
      clearDemo();
      setDemoUntil(0);
      void refresh(false, loadSettings());
    }, left + 500);
    return () => clearTimeout(timer);
  }, [demoUntil]);

  function changeChoice(next: Settings["mode"]): void {
    setChoice(next);
    // 选「固定城市」但还没选过城市：先显示输入框，等选好了再生效
    if (next === "fixed" && settings.fixed === null) return;
    const saved: Settings = { ...settings, mode: next };
    setSettings(saved);
    saveSettings(saved);
    void refresh(false, saved);
  }

  async function search(): Promise<void> {
    const text = query.trim();
    if (text === "" || busy) return;
    setBusy(true);
    // 交给 refresh 之后，「忙」就归它管（它只认最后一次）；这里再清的话，会把中途点了「立即刷新」的那一次也一并清掉
    let handedOver = false;
    try {
      const place = await findPlace(text);
      if (place === null) {
        await Dialog.alert({ message: "没找到这个地方\n换个写法试试，比如加上省或市" });
        return;
      }
      const saved: Settings = { mode: "fixed", fixed: place };
      setSettings(saved);
      setChoice("fixed");
      setQuery("");
      saveSettings(saved);
      handedOver = true;
      await refresh(true, saved);
    } catch (error) {
      await Dialog.alert({ message: "查找失败：" + String(error).slice(0, 80) });
    } finally {
      if (!handedOver) setBusy(false);
    }
  }

  /** 换数据来源：存下来、马上按新的来取一次 */
  function changeSourceChoice(next: SourceMode): void {
    setSourceChoice(next);
    // 选「自己的」但地址和 token 还没填过：先显示输入框，等点了「保存并测试」再生效
    if (next === "custom" && (source.host === "" || source.token === "")) return;
    const saved: DataSource = { ...source, mode: next };
    setSource(saved);
    writeDataSource(saved);
    // 存的时候旧的缓存已经清了，这次一定会按新来源去取，用不着再强制刷新定位
    void refresh(false, settings);
  }

  /** 填完自己的地址和 token 点「保存并测试」：存下来、立刻查一次（越过缓存），把结果直接告诉用户 */
  async function saveCustom(): Promise<void> {
    if (busy) return;
    const host = cleanHost(hostText);
    if (host === null) {
      await Dialog.alert({ message: "服务地址的格式不对\n要以 https:// 开头\n后面不要带问号和空格" });
      return;
    }
    // token 框空着：沿用已经存着的（只想改地址的时候不用重填）
    const typed = tokenText.trim();
    const token = typed !== "" ? cleanToken(typed) : source.token !== "" ? source.token : null;
    if (token === null) {
      await Dialog.alert({ message: typed === "" ? "还没填 token" : "token 的格式不对\n不能是空的，也不能带斜杠" });
      return;
    }
    const saved: DataSource = { mode: "custom", host, token };
    writeDataSource(saved);
    setSource(saved);
    setHostText(host);
    setTokenText("");
    // 「预览预警样式」开着的话，测出来的预警会是假的示例：先关掉，测的才是真接口
    clearDemo();
    setDemoUntil(0);
    const result = await refresh(true, settings);
    if (result !== null) await Dialog.alert({ message: sourceTestMessage(result.weather, result.alerts) });
  }

  async function clearCustom(): Promise<void> {
    const ok = await Dialog.confirm({
      title: "清除自己的设置？",
      message: "填过的地址和 token 会删掉。\n正在用自己的，就改回内置的。",
      confirmLabel: "清除",
    });
    if (!ok) return;
    // 选的是 Open-Meteo 就还是 Open-Meteo，只有正在用自己的才改回内置
    const saved: DataSource = { ...defaultSource(), mode: source.mode === "custom" ? "builtin" : source.mode };
    writeDataSource(saved);
    setSource(saved);
    setSourceChoice(saved.mode);
    setHostText("");
    setTokenText("");
    await refresh(true, settings);
  }

  /** 「预览预警样式」：10 分钟里给主屏幕和锁屏的小组件两条写着「示例」的假预警，好看看徽章长什么样 */
  async function startDemo(): Promise<void> {
    const until = Date.now() + ALERT_DEMO_MS;
    writeDemoUntil(until);
    setDemoUntil(until);
    await refresh(true, settings);
  }

  async function stopDemo(): Promise<void> {
    clearDemo();
    setDemoUntil(0);
    await refresh(true, settings);
  }

  async function preview(family: WidgetFamily): Promise<void> {
    try {
      await Widget.preview({ family });
    } catch (error) {
      await Dialog.alert({ message: "预览打不开：" + String(error).slice(0, 120) });
    }
  }

  async function reset(): Promise<void> {
    const ok = await Dialog.confirm({
      title: "清空缓存？",
      message: "天气缓存和上次存下的定位都会删掉，再重新取一次。\n位置设置和数据来源不动。",
      confirmLabel: "清空",
    });
    if (!ok) return;
    clearData();
    await refresh(true, settings);
  }

  const content: Content | null = loaded === null ? null : present(loaded, now, "compact", alerts ?? { kind: "off" });
  const detail = content !== null && content.kind === "weather" ? content.detail : null;
  const cardWidth = Math.min(Math.max(Device.screen.width - 32, 280), 420);

  return (
    <NavigationStack>
      <List
        navigationTitle="天气"
        navigationBarTitleDisplayMode="inline"
        toolbar={{ cancellationAction: <Button title="退出" action={() => dismiss()} /> }}
      >
        <Section listRowBackground={<></>} listRowSeparator="hidden">
          {content === null ? <LoadingCard width={cardWidth} /> : <PreviewCard content={content} width={cardWidth} />}
        </Section>

        <Section
          footer={
            loaded !== null && loaded.kind === "noLocation" ? (
              <Text>
                {"没拿到位置\n到「设置 → 隐私与安全性 → 定位服务 → Scripting」里打开定位\n或者在下面选一个固定城市"}
              </Text>
            ) : loaded !== null && loaded.kind === "noData" ? (
              <Text>{"天气暂时取不到\n检查一下网络，稍后再试\n原因在下面「天气来源」的状态里"}</Text>
            ) : undefined
          }
        >
          <Button action={() => void refresh(true, settings)}>
            <HStack>
              <Text foregroundStyle={busy ? "secondaryLabel" : "systemBlue"}>{busy ? "正在取…" : "立即刷新"}</Text>
              <Spacer />
            </HStack>
          </Button>
        </Section>

        <SummarySection detail={detail} />
        <WeekSection detail={detail} />
        <DetailSection detail={detail} />
        <AirSection detail={detail} />
        <LifeSection detail={detail} />

        <Section
          header={<Text>位置</Text>}
          footer={
            <Text>
              {"跟着当前定位：显示你所在位置的天气\n固定城市：不管你在哪，只看这个城市\n\n拿不到定位时，会用上次的位置\n小组件底部会写「上次定位处的天气」"}
            </Text>
          }
        >
          <Picker title="看哪里的天气" value={choice} onChanged={(value: string) => changeChoice(value as Settings["mode"])}>
            <Text tag="current">跟着当前定位</Text>
            <Text tag="fixed">固定城市</Text>
          </Picker>
          {choice === "fixed" ? <Row title="现在选的城市" value={settings.fixed === null ? "还没选" : settings.fixed.name} /> : null}
          {choice === "fixed" ? <TextField title="城市" value={query} prompt="比如 北京" onChanged={setQuery} /> : null}
          {choice === "fixed" ? (
            <Button action={() => void search()}>
              <Text foregroundStyle={query.trim() === "" || busy ? "secondaryLabel" : "systemBlue"}>查找并使用</Text>
            </Button>
          ) : null}
        </Section>

        <SourceSection
          source={source}
          choice={sourceChoice}
          loaded={loaded}
          now={now}
          hostText={hostText}
          tokenText={tokenText}
          busy={busy}
          onChoice={changeSourceChoice}
          setHostText={setHostText}
          setTokenText={setTokenText}
          saveCustom={() => void saveCustom()}
          clearCustom={() => void clearCustom()}
        />

        <AlertsSection
          alertState={alerts}
          provider={providerOf(source)}
          now={now}
          demoUntil={demoUntil}
          startDemo={() => void startDemo()}
          stopDemo={() => void stopDemo()}
        />

        <Section header={<Text>现在的情况</Text>}>
          <Row title="地点" value={placeLine(loaded)} />
          <Row title="位置来源" value={loaded !== null && loaded.kind !== "noLocation" ? SOURCE_TEXT[loaded.source] : "—"} />
          <Row title="天气更新时间" value={loaded !== null && loaded.kind === "ok" ? updatedText(loaded.fetchedAt, now) : "—"} />
        </Section>

        <Section
          header={<Text>小组件</Text>}
          footer={
            <Text>
              {"长按主屏幕空白处\n点左上角的加号\n找到 Scripting 添加一个小组件\n长按它选「编辑小组件」\n脚本选「天气小组件」\n\n点一下小组件：打开这里\n\n想让某个小组件固定看另一个城市：\n在「参数」里填 纬度,经度,名称\n比如 39.90,116.40,北京"}
            </Text>
          }
        >
          <Menu label={<Text foregroundStyle="systemBlue">预览小组件</Text>}>
            {PREVIEWS.map((item) => (
              <Button key={item.family} title={item.title} action={() => void preview(item.family)} />
            ))}
          </Menu>
        </Section>

        <Section
          header={<Text>数据来源</Text>}
          footer={
            <Text>
              {"天气和预警数据来自彩云天气，由 001 提供 API 接口\n彩云相关文档来自小麦（Telegram @GetSomeTriticum）\n\n备用来源 Open-Meteo：\nWeather data by Open-Meteo.com\n按 CC BY 4.0 提供，只用于个人非商用\n免费接口的限制：\n只能非商用，放了订阅或广告就不行\n每分钟 600 次，每小时 5000 次，每天 10000 次，每月 30 万次\n按 IP 和应用算，用得太凶会被封\n不保证一直能用，数据也不保证准\n小组件取天气最多每 15 分钟一次，几个小组件共用一份，远远用不到这些次数\n\n城市名由系统的地图服务反查，不经过上面任何一家"}
            </Text>
          }
        >
          <Button action={() => void Safari.openURL("https://www.caiyunapp.com/")}>
            <Text foregroundStyle="systemBlue">天气和预警 彩云天气</Text>
          </Button>
          <Button action={() => void Safari.openURL("https://open-meteo.com/")}>
            <Text foregroundStyle="systemBlue">备用来源 Open-Meteo.com</Text>
          </Button>
          <Button action={() => void Safari.openURL("https://creativecommons.org/licenses/by/4.0/")}>
            <Text foregroundStyle="systemBlue">数据许可 CC BY 4.0</Text>
          </Button>
        </Section>

        <Section>
          <Button role="destructive" action={() => void reset()}>
            <Text foregroundStyle="systemRed">清空缓存</Text>
          </Button>
        </Section>
      </List>
    </NavigationStack>
  );
}

async function run(): Promise<void> {
  await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" });
  Script.exit();
}

void run();
