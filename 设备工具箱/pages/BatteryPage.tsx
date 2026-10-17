// 电池健康：循环次数、设计 / 满充容量、温度、实时功率。系统设置里只给一个百分比。

import {
  Button,
  Chart,
  HStack,
  LineChart,
  List,
  NavigationLink,
  Picker,
  ProgressView,
  Section,
  Spacer,
  Text,
  Toggle,
  VStack,
  useEffect,
  useRef,
  useState,
  type Color,
} from "scripting";
import {
  METRIC_INFO,
  availableMetrics,
  appendSample,
  curveMarks,
  curveSummary,
  formatMetric,
  formatSpan,
  type CurveMetric,
  type CurveSample,
} from "../kit/batteryCurve";
import { debugLog, describeError } from "../core/debug";
import { deviceHub } from "../kit/hub";
import { monitorBattery, readBattery, type BatteryReport } from "../kit/services";
import { RawListPage } from "./RawListPage";
import { RawRow, TaskStateSection, ValueRow, useDeviceTask } from "./common";
import { shouldEndOnUnplug } from "../kit/batteryCard";
import { releaseKeepAlive, retainKeepAlive } from "../utils/keepalive";
import { BatteryLiveCard } from "./batteryLiveCard";

/** 实时模式的刷新间隔。每次是一条 IORegistry 查询，连接一直复用。 */
const LIVE_INTERVAL_MS = 2000;
const CARD_ENABLED_KEY = "batteryLiveCard";

const METRIC_COLOR: Record<CurveMetric, Color> = {
  power: "systemGreen",
  current: "systemBlue",
  temperature: "systemOrange",
  charge: "systemTeal",
};

function healthColor(percent: number): "systemGreen" | "systemOrange" | "systemRed" {
  // 苹果的「需要维修」提示线是 80%
  if (percent >= 85) return "systemGreen";
  if (percent >= 80) return "systemOrange";
  return "systemRed";
}

function chargeState(report: BatteryReport): string | null {
  if (report.fullyCharged) return "已充满";
  if (report.isCharging) return "充电中";
  if (report.externalConnected) return "已接电源，未充电";
  if (report.isCharging === false) return "使用电池";
  return null;
}

function powerText(report: BatteryReport): string | null {
  if (report.powerW === null) return null;
  if (report.powerW === 0) return "0 W";
  return `${Math.abs(report.powerW).toFixed(1)} W（${report.powerW > 0 ? "充入" : "放出"}）`;
}

function chargerText(report: BatteryReport): string | null {
  const charger = report.charger;
  /*
    没接电源时设备也会给 AdapterDetails，内容是「0 W · batt」——那不是充电器，
    是电池自己。只有真的接着电源、并且报了功率时才显示这一行。
  */
  if (!charger || report.externalConnected !== true) return null;
  if (!charger.watts && !charger.isWireless) return null;
  const parts = [
    charger.watts !== null ? `${charger.watts} W` : null,
    charger.isWireless ? "无线" : null,
    charger.name,
  ].filter((part): part is string => !!part);
  return parts.join(" · ");
}

function rows(report: BatteryReport): [string, string][] {
  const list: [string, string | null][] = [
    ["循环次数", report.cycleCount !== null ? `${report.cycleCount} 次` : null],
    ["设计容量", report.designCapacity !== null ? `${report.designCapacity} mAh` : null],
    // 标称和原始两个满充值都有时分开列，看得出健康度用的是哪个
    ...(report.nominalChargeCapacity !== null && report.rawMaxCapacity !== null
      ? ([
          ["满充容量（标称）", `${report.nominalChargeCapacity} mAh`],
          ["满充容量（原始）", `${report.rawMaxCapacity} mAh`],
        ] as [string, string][])
      : ([["当前满充容量", report.fullChargeCapacity !== null ? `${report.fullChargeCapacity} mAh` : null]] as [string, string | null][])),
    // 叫「剩余容量」不叫「剩余电量」：和下面的百分比不是一回事，系统显示的电量会预留余量
    ["剩余容量", report.remainingCapacity !== null ? `${report.remainingCapacity} mAh` : null],
    ["当前电量", report.chargePercent !== null ? `${report.chargePercent}%` : null],
    ["状态", chargeState(report)],
    ["功率", powerText(report)],
    ["电压", report.voltageV !== null ? `${report.voltageV.toFixed(3)} V` : null],
    ["电流", report.amperageMA !== null ? `${report.amperageMA} mA` : null],
    // 有的系统不给电池温度（见 parseBattery），明说出来，别让这一行凭空消失像是漏了
    ["温度", report.temperatureC !== null ? `${report.temperatureC.toFixed(1)} °C` : "设备未提供"],
    ["充电器", chargerText(report)],
    ["电池序列号", report.serial],
  ];
  return list.filter((entry): entry is [string, string] => entry[1] !== null);
}

export function BatteryPage() {
  const task = useDeviceTask((session) => readBattery(session));
  const [liveReport, setLiveReport] = useState<BatteryReport | null>(null);
  const [live, setLive] = useState(false);
  const [liveError, setLiveError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  /** 充电曲线的点。停掉实时之后留着看，离开页面才清。 */
  const [samples, setSamples] = useState<CurveSample[]>([]);
  const [metric, setMetric] = useState<CurveMetric>("power");
  /** 实时刷新时要不要开锁屏 / 灵动岛卡片。默认开，记住用户的选择。 */
  const [cardEnabled, setCardEnabled] = useState(() => Storage.get<boolean>(CARD_ENABLED_KEY) !== false);
  const [cardNote, setCardNote] = useState("");
  /** 实时循环读这个 ref 决定要不要停——循环跨很多次渲染，读 state 只会拿到开始那一刻的值。 */
  const liveRef = useRef(false);

  // 离开页面时停掉实时循环，别让它在后台一直占着连接
  useEffect(() => {
    return () => {
      liveRef.current = false;
    };
  }, []);

  async function startLive() {
    if (liveRef.current) return;
    liveRef.current = true;
    setLive(true);
    setLiveError("");
    setCardNote("");
    const card = cardEnabled ? new BatteryLiveCard() : null;
    // 锁屏卡片要靠后台保活续命：在前台就申请，一直持有到停。
    // 不开卡片时只在页面里看，不申请，免得白耗电。
    if (card) {
      const kept = await retainKeepAlive("session").catch((error) => {
        debugLog("keepalive", "电池实时保活申请失败", describeError(error));
        return false;
      });
      if (!kept) setCardNote("后台保活没申请到：切走或锁屏后，卡片可能几分钟就停在最后一个数。");
    }
    let cardOpening: Promise<void> | null = null;
    try {
      const session = await deviceHub.get();
      await monitorBattery(
        session,
        (report) => {
          setLiveReport(report);
          setSamples((list) => appendSample(list, report));
          setUpdatedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
          if (!card) return;
          if (!cardOpening) {
            cardOpening = card.start(report).then((problem) => {
              if (problem) setCardNote(problem);
            });
            return;
          }
          void cardOpening.then(() => card.update(report));
          if (card.startedPluggedIn !== null && shouldEndOnUnplug(card.startedPluggedIn, report)) {
            liveRef.current = false;
            setCardNote("充电器已拔出，实时刷新和锁屏卡片已停止。");
          }
        },
        () => !liveRef.current,
        LIVE_INTERVAL_MS,
      );
    } catch (error) {
      setLiveError(`实时刷新中断：${describeError(error)}`);
    } finally {
      liveRef.current = false;
      setLive(false);
      await cardOpening;
      if (card) {
        await card.end();
        await releaseKeepAlive("session");
      }
    }
  }

  function changeCardEnabled(value: boolean) {
    setCardEnabled(value);
    Storage.set(CARD_ENABLED_KEY, value);
  }

  function toggleLive() {
    if (liveRef.current) liveRef.current = false;
    else void startLive();
  }

  const report = liveReport ?? task.data;
  const health = report?.healthPercent ?? null;
  const metrics = availableMetrics(samples, report?.temperatureC ?? null);
  // 选着「温度」但设备不给温度时退回功率
  const shownMetric = metrics.includes(metric) ? metric : "power";
  const marks = curveMarks(samples, shownMetric);
  const summary = curveSummary(samples, shownMetric);

  return (
    <List
      navigationTitle="电池健康"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      refreshable={task.reload}
      toolbar={{
        topBarTrailing: (
          <Button
            title={live ? "停止实时" : "实时刷新"}
            systemImage={live ? "pause.circle.fill" : "play.circle"}
            action={toggleLive}
          />
        ),
      }}
    >
      <TaskStateSection task={task} />

      {report ? (
        <Section
          footer={
            <Text foregroundStyle="tertiaryLabel">
              {report.healthSource === "system"
                ? "设备没给满充容量，这里显示的是系统自己算的最大容量百分比。"
                : `健康度 = 满充容量 ÷ 设计容量${report.fullChargeSource ? `（满充取自 ${report.fullChargeSource}）` : ""}。` +
                  "系统设置里的「最大容量」会做平滑处理，两者差一两个点是正常的；低于 80% 时苹果建议更换电池。"}
            </Text>
          }
        >
          <VStack alignment="leading" spacing={10} padding={{ vertical: 6 }}>
            <HStack alignment="lastTextBaseline">
              {/* 和系统一样封顶 100%；超出的部分在下面单独说明，不藏起来 */}
              <Text font={44} fontWeight="semibold" foregroundStyle={health !== null ? healthColor(health) : "label"}>
                {health !== null ? `${Math.min(health, 100)}%` : "—"}
              </Text>
              <Spacer />
              {report.healthSource === "computed" && report.systemHealthPercent !== null ? (
                <Text foregroundStyle="secondaryLabel">{`系统给的：${report.systemHealthPercent}%`}</Text>
              ) : null}
            </HStack>
            {health !== null ? (
              <ProgressView value={Math.min(health, 100)} total={100} tint={healthColor(health)} />
            ) : (
              <Text foregroundStyle="secondaryLabel">这台设备没有给出满充容量，健康度暂时算不出来。</Text>
            )}
            {health !== null && health > 100 ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {`满充容量比设计容量还高 ${Math.round((health - 100) * 10) / 10}%（实测 ${health}%）。新电池常见，电量计会随使用慢慢校准，系统设置里也会显示 100%。`}
              </Text>
            ) : null}
          </VStack>
        </Section>
      ) : null}

      {report ? (
        <Section
          header={<Text>充电曲线</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              {summary
                ? `${formatSpan(summary.spanMs)} · 最低 ${formatMetric(summary.min, shownMetric)} · 最高 ${formatMetric(summary.max, shownMetric)} · 当前 ${formatMetric(summary.latest, shownMetric)}`
                : "打开右上角的实时刷新开始记录，每 2 秒一个点，最多留一小时。插上充电器看功率曲线，能看出什么时候开始降速。"}
            </Text>
          }
        >
          <Picker
            title="指标"
            pickerStyle="segmented"
            value={shownMetric}
            onChanged={(value: string) => setMetric(value as CurveMetric)}
          >
            {metrics.map((key) => (
              <Text key={key} tag={key}>
                {METRIC_INFO[key].title}
              </Text>
            ))}
          </Picker>
          {marks.length >= 2 ? (
            <Chart frame={{ height: 200 }} chartXAxis={{ gridLine: false, valueLabel: true }}>
              <LineChart marks={marks.map((mark) => ({ ...mark, foregroundStyle: METRIC_COLOR[shownMetric] }))} />
            </Chart>
          ) : (
            <Text foregroundStyle="tertiaryLabel">{live ? "记录中，再等几秒就有曲线…" : "还没有数据"}</Text>
          )}
          {samples.length > 0 && !live ? (
            <Button title="清空曲线" systemImage="trash" role="destructive" action={() => setSamples([])} />
          ) : null}
          <Toggle
            title="实时刷新时显示锁屏 / 灵动岛卡片"
            value={cardEnabled}
            onChanged={changeCardEnabled}
            disabled={live}
          />
          {cardNote ? (
            <Text font="footnote" foregroundStyle="systemOrange">
              {cardNote}
            </Text>
          ) : null}
        </Section>
      ) : null}

      {report ? (
        <Section
          header={<Text>详情</Text>}
          footer={
            <Text foregroundStyle={liveError ? "systemRed" : "tertiaryLabel"}>
              {liveError ||
                (live
                  ? `实时刷新中，每 ${LIVE_INTERVAL_MS / 1000} 秒一次${updatedAt ? ` · 更新于 ${updatedAt}` : ""}`
                  : "点一行复制。右上角开实时刷新，或下拉刷新一次。")}
            </Text>
          }
        >
          {rows(report).map(([label, value]) => (
            <ValueRow key={label} label={label} value={value} />
          ))}
        </Section>
      ) : null}

      {report && report.capacityFields.length > 0 ? (
        <Section
          header={<Text>容量相关字段</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              健康度没算出来，这些是设备返回的、看起来和容量有关的字段。截图发给开发者就能照着补上。
            </Text>
          }
        >
          {report.capacityFields.map(([label, value]) => (
            <RawRow key={label} label={label} value={value} />
          ))}
        </Section>
      ) : null}

      {report ? (
        <Section>
          <NavigationLink destination={<RawListPage title="原始电池数据" rows={report.raw} />}>
            <Text>{`原始数据（${report.raw.length} 项）`}</Text>
          </NavigationLink>
        </Section>
      ) : null}
    </List>
  );
}
