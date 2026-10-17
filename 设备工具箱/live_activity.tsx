// 电池实时卡片：锁屏 + 灵动岛。电池页开「实时刷新」时起，停掉或拔掉充电器时收。
//
// 按系统要求，注册代码必须单独成文件；一个脚本也只注册这一个 Live Activity
// （注册两个的话应用分不清用哪个 builder，灵动岛上直接显示「错误」）。
// 数据怎么拼、颜色怎么定见 kit/batteryCard.ts。

import {
  Capsule,
  Circle,
  HStack,
  Image,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedBottom,
  Spacer,
  Text,
  TimerIntervalLabel,
  VStack,
  ZStack,
  type Color,
  type LiveActivityUIBuilder,
} from "scripting";
import {
  cardTone,
  compactText,
  powerText,
  sparkHeights,
  statusText,
  type BatteryCardState,
  type CardTone,
} from "./kit/batteryCard";

const TONE_COLOR: Record<CardTone, Color> = {
  charging: "systemGreen",
  warm: "systemOrange",
  hot: "systemRed",
  idle: "systemBlue",
};

/** 「已监测」计时的终点。TimerIntervalLabel 必须给区间，一天足够。 */
const TIMER_SPAN_MS = 24 * 3600 * 1000;
const SPARK_HEIGHT = 22;

function accent(state: BatteryCardState): Color {
  return TONE_COLOR[cardTone(state)];
}

function iconName(state: BatteryCardState): string {
  if (state.fullyCharged) return "battery.100percent.bolt";
  return state.charging || state.pluggedIn ? "bolt.fill" : "battery.75percent";
}

/** 实心圆底 + 白图标。淡色底配彩图标在黑岛上糊成一团，实心才立得住。 */
function RoundIcon({ state }: { state: BatteryCardState }) {
  return (
    <ZStack frame={{ width: 36, height: 36 }}>
      <Circle fill={accent(state)} frame={{ width: 36, height: 36 }} />
      <Image systemName={iconName(state)} foregroundStyle="white" font="subheadline" />
    </ZStack>
  );
}

/**
 * 最近一分钟的功率，一根根细柱子，前面带一句说明——不带的话真机上被当成了进度条。
 * 高度看的是起伏（见 sparkHeights），功率稳定时是一排齐平的半高柱子。系统不画图表时这样最稳。
 */
function Sparkline({ state }: { state: BatteryCardState }) {
  const heights = sparkHeights(state.history);
  return (
    <HStack alignment="bottom" spacing={8} frame={{ maxWidth: "infinity", height: SPARK_HEIGHT, alignment: "bottomLeading" }}>
      <Text font="caption2" foregroundStyle="secondaryLabel">
        近 1 分钟功率
      </Text>
      <HStack alignment="bottom" spacing={3}>
        {heights.map((height, index) => (
          <Capsule
            key={index}
            fill={accent(state)}
            opacity={index === heights.length - 1 ? 1 : 0.55}
            frame={{ width: 4, height: Math.max(2, height * SPARK_HEIGHT) }}
          />
        ))}
      </HStack>
      <Spacer minLength={0} />
    </HStack>
  );
}

function detailText(state: BatteryCardState): string {
  const parts: string[] = [];
  if (state.amperageMA !== null) parts.push(`${Math.abs(state.amperageMA)} mA`);
  if (state.temperatureC !== null) parts.push(`${state.temperatureC.toFixed(1)}°C`);
  return parts.join(" · ");
}

function footText(state: BatteryCardState): string {
  const parts: string[] = [];
  if (state.healthPercent !== null) parts.push(`健康 ${state.healthPercent}%`);
  if (state.adapterW !== null && state.pluggedIn) parts.push(`充电器 ${state.adapterW} W`);
  return parts.join(" · ");
}

/**
 *   [⚡] 充电中 18.5 W                 82%
 *        1530 mA · 39.2°C          已监测 3:20
 *   近 1 分钟功率 ▂▃▅▆▇▇▆▅▅▄▄▃▃▂
 *   健康 98% · 充电器 20 W
 *
 * 锁屏和灵动岛展开态共用这一份。颜色用语义色，灵动岛恒为深色、锁屏跟随系统，两边都不用单独配。
 * 早先底行带「更新于 HH:mm:ss」，真机上反馈看着像时间不对、又没什么用，去掉了。
 */
function BatteryCard({ state }: { state: BatteryCardState }) {
  return (
    <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={10}>
        <RoundIcon state={state} />
        <VStack alignment="leading" spacing={1}>
          <Text font="subheadline" fontWeight="semibold" lineLimit={1}>
            {`${statusText(state)} ${powerText(state)}`}
          </Text>
          <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>
            {detailText(state)}
          </Text>
        </VStack>
        <Spacer minLength={8} />
        <VStack alignment="trailing" spacing={1}>
          <Text font="title3" fontWeight="bold" foregroundStyle={accent(state)}>
            {state.chargePercent === null ? "—" : `${state.chargePercent}%`}
          </Text>
          <HStack spacing={2}>
            <Text font="caption2" foregroundStyle="secondaryLabel">已监测</Text>
            <TimerIntervalLabel
              from={new Date(state.startedAt)}
              to={new Date(state.startedAt + TIMER_SPAN_MS)}
              countsDown={false}
              font="caption2"
              foregroundStyle="secondaryLabel"
              multilineTextAlignment="trailing"
              frame={{ width: 44, alignment: "trailing" }}
            />
          </HStack>
        </VStack>
      </HStack>
      <Sparkline state={state} />
      <Text font="caption2" foregroundStyle="secondaryLabel" lineLimit={1}>
        {footText(state)}
      </Text>
    </VStack>
  );
}

/*
  展开态整张卡片放进 ExpandedBottom：leading / trailing 贴在摄像头两侧、
  center 在摄像头下方，分开放会上下错开一截。底部垫 8pt：展开态的裁切是圆角矩形，
  底部两角约 17pt 的弧会削掉最后一行的字，左右缩进治不了，只能抬高。锁屏没有这层裁切。
*/
const builder: LiveActivityUIBuilder<BatteryCardState> = (state) => (
  <LiveActivityUI
    keylineTint={accent(state)}
    dynamicIslandContentMargins={{ expanded: { horizontal: 20, bottom: 16 } }}
    content={
      <VStack padding={{ vertical: 14, horizontal: 16 }} activityBackgroundTint={{ light: "clear", dark: "clear" }}>
        <BatteryCard state={state} />
      </VStack>
    }
    compactLeading={<Image systemName={iconName(state)} foregroundStyle={accent(state)} />}
    compactTrailing={
      <Text font="caption" fontWeight="medium" foregroundStyle={accent(state)} lineLimit={1} minScaleFactor={0.6}>
        {compactText(state)}
      </Text>
    }
    minimal={<Image systemName={iconName(state)} foregroundStyle={accent(state)} />}
  >
    <LiveActivityUIExpandedBottom>
      <VStack padding={{ bottom: 8 }}>
        <BatteryCard state={state} />
      </VStack>
    </LiveActivityUIExpandedBottom>
  </LiveActivityUI>
);

export const BatteryLiveActivity = LiveActivity.register("ToolboxBattery", builder);
