// 字幕设置面板：玻璃质感的深色卡片，和全 App 的胶囊、分段是同一个语气（theme.tsx）。
// 竖屏时浮在画面下方，全屏时贴在画面右侧、让出右缘那一列按钮，调的时候字幕和画面都看得见。
// 所有字幕相关的操作这里都有（搜索 / 显示隐藏 / 换一条 / 颜色 / 字号 / 文字和底色的透明度 / 双层 / 同步 / 位置）：
// 全屏时详情页上的字幕菜单看不到，得靠它。搜索、同步的状态与操作在 useSubtitles.ts；
// 外观（颜色 / 字号 / 透明度 / 双层 / 位置）在 kit/subtitleLook.ts 的全局状态里，面板自己订阅，拖滑块时只有面板和字幕层在重绘。
//
// 宽度都是算死的：Button / Menu 的 label 里写弹性宽度在真机上不撑开（见 theme.tsx 的 columnWidth），所以滑块的宽度由调用方给的总宽算出来。

import { Button, Circle, HStack, Image, Slider, Spacer, Text, VStack, ZStack, type VirtualNode } from "scripting";

import {
  DEFAULT_SUBTITLE_STYLE,
  OPACITY_MIN,
  OPACITY_STEP,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
  SUBTITLE_COLORS,
  contrastInk,
  parseHexColor,
  type HexColor,
} from "../core/subtitleStyle";
import { changeLook } from "../kit/subtitleLook";
import { showError } from "../kit/toast";
import { SHIFT_STEPS } from "./SubtitleParts";
import { GLASS, INK, PillLabel } from "./theme";
import { useSubtitleLook } from "./useSubtitleLook";
import type { Subtitles } from "./useSubtitles";

/** 卡片的内边距。 */
const PAD = 14;
/** 每一行左边那个小标题的宽度（最长的是「文字透明度」五个字）。 */
const LABEL_W = 62;
/** 小标题和控件之间、控件和它右边的数值之间的空隙。 */
const GAP = 8;
/** 滑块右边那个百分比的宽度。 */
const VALUE_W = 42;
/** 色块的直径（选中的外面还有一圈环）。 */
const SWATCH = 22;
const SWATCH_RING = 30;

/** 一行：左边小标题，右边是控件。 */
function Row({ label, children }: { label: string; children: VirtualNode }) {
  return (
    <HStack spacing={GAP}>
      <Text font="caption" foregroundStyle={INK.soft} frame={{ width: LABEL_W, alignment: "leading" }}>
        {label}
      </Text>
      {children}
      <Spacer />
    </HStack>
  );
}

/** 一行滑块 + 右边的数值。width 是这一行控件区的总宽（卡片宽度扣掉内边距和小标题）。 */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  valueText,
  width,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  valueText: string;
  width: number;
  onChange: (value: number) => void;
}) {
  return (
    <Row label={label}>
      <HStack spacing={GAP}>
        <Slider min={min} max={max} step={step} value={value} onChanged={onChange} tint="white" frame={{ width: width - VALUE_W - GAP }} />
        <Text font="caption" foregroundStyle={INK.body} lineLimit={1} frame={{ width: VALUE_W, alignment: "trailing" }}>
          {valueText}
        </Text>
      </HStack>
    </Row>
  );
}

/** 色块：选中的外面套一圈白环。 */
function Swatch({ fill, selected, onPress, children }: { fill: HexColor | typeof GLASS; selected: boolean; onPress: () => void; children?: VirtualNode }) {
  return (
    <Button buttonStyle="plain" action={onPress}>
      <ZStack frame={{ width: SWATCH_RING, height: SWATCH_RING }}>
        {selected ? <Circle stroke={{ shapeStyle: "white", strokeStyle: { lineWidth: 2 } }} frame={{ width: SWATCH_RING, height: SWATCH_RING }} /> : null}
        <Circle fill={fill} frame={{ width: SWATCH, height: SWATCH }} />
        {children}
      </ZStack>
    </Button>
  );
}

/** 开关：开着是蓝底（和一排小胶囊里「预览」亮起来的样子一致）。 */
function SwitchPill({ on, text, onPress }: { on: boolean; text: string; onPress: () => void }) {
  return (
    <Button buttonStyle="plain" action={onPress}>
      <PillLabel icon={on ? "checkmark" : undefined} text={text} active={on} />
    </Button>
  );
}

/** 同步那一排的小按钮：比 PillLabel 紧凑，四档 + 还原一行放得下。 */
function MiniPill({ text, icon }: { text?: string; icon?: string }) {
  return (
    <HStack spacing={3} padding={{ horizontal: 9, vertical: 6 }} background={{ style: GLASS, shape: "capsule" }}>
      {icon ? <Image systemName={icon} font={11} foregroundStyle={INK.icon} /> : null}
      {text ? (
        <Text font={11} foregroundStyle={INK.strong} lineLimit={1}>
          {text}
        </Text>
      ) : null}
    </HStack>
  );
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * @param width 卡片的总宽（含内边距）：竖屏是内容列宽，全屏是一个固定的窄卡片
 * @param onClose 右上角的关闭
 */
export function SubtitlePanel({ sub, width, onClose }: { sub: Subtitles; width: number; onClose: () => void }) {
  const look = useSubtitleLook();
  const hasCues = sub.cues !== null;
  const inner = width - PAD * 2;
  const controlW = inner - LABEL_W - GAP;
  const moved = look.x !== 0 || look.y !== 0;
  const isPreset = SUBTITLE_COLORS.some((c) => c.value === look.color);

  /** 自己填色值：弹一个输入框，填 #FFE14A 这样的（三位也行），不合格式就提示、不改。 */
  const askColor = async () => {
    const input = await Dialog.prompt({
      title: "字幕颜色",
      message: "填 # 开头的色值，比如 #FFE14A；三位的 #FC0 也行",
      placeholder: "#FFE14A",
      defaultValue: look.color,
      selectAll: true,
      confirmLabel: "好",
      cancelLabel: "取消",
      keyboardType: "asciiCapable",
    });
    if (input === null) return;
    const color = parseHexColor(input);
    if (!color) {
      showError("色值不对，要像 #FFE14A 这样（3 位或 6 位十六进制）");
      return;
    }
    changeLook({ color });
  };

  return (
    <VStack
      alignment="leading"
      spacing={10}
      padding={PAD}
      frame={{ width }}
      background={{ style: "rgba(22,24,30,0.92)", shape: { type: "rect", cornerRadius: 20 } }}
      shadow={{ color: "rgba(0,0,0,0.45)", radius: 16, y: 6 }}
    >
      <HStack spacing={8}>
        <Image systemName="captions.bubble.fill" font={14} foregroundStyle={INK.icon} />
        <Text font="headline" foregroundStyle={INK.strong}>
          字幕设置
        </Text>
        <Spacer />
        {hasCues ? (
          <Button buttonStyle="plain" action={() => changeLook({ ...DEFAULT_SUBTITLE_STYLE })}>
            <MiniPill icon="arrow.counterclockwise" text="恢复默认" />
          </Button>
        ) : null}
        <Button buttonStyle="borderless" action={onClose}>
          <Image systemName="xmark.circle.fill" font={22} foregroundStyle={INK.soft} />
        </Button>
      </HStack>
      <Text font="caption2" foregroundStyle={INK.faint} lineLimit={2} multilineTextAlignment="leading" frame={{ width: inner, alignment: "leading" }}>
        {sub.summary || (sub.busy ? "正在查找字幕…" : "还没有载入字幕")}
      </Text>

      <HStack spacing={8}>
        {sub.busy ? <PillLabel icon="hourglass" text="查找中…" /> : null}
        {!hasCues && !sub.busy ? (
          <Button buttonStyle="plain" action={sub.search}>
            <PillLabel icon="magnifyingglass" text="搜索字幕" />
          </Button>
        ) : null}
        {hasCues ? (
          <Button buttonStyle="plain" action={sub.toggle}>
            <PillLabel icon={sub.visible ? "eye.slash" : "eye"} text={sub.visible ? "隐藏" : "显示"} />
          </Button>
        ) : null}
        {sub.choiceCount > 1 ? (
          <Button buttonStyle="plain" disabled={sub.busy} action={sub.next}>
            <PillLabel icon="arrow.triangle.2.circlepath" text="换一条" />
          </Button>
        ) : null}
        <Spacer />
      </HStack>

      {hasCues ? (
        <Row label="颜色">
          <HStack spacing={GAP}>
            {SUBTITLE_COLORS.map((c) => (
              <Swatch key={c.value} fill={c.value} selected={look.color === c.value} onPress={() => changeLook({ color: c.value })} />
            ))}
            {/* 第六个：自己填色值。选的不是预设色时它就是当前色（里面的 # 按亮暗换黑白，看得清） */}
            <Swatch fill={isPreset ? GLASS : look.color} selected={!isPreset} onPress={() => void askColor()}>
              <Text font={12} fontWeight="bold" foregroundStyle={isPreset ? INK.strong : contrastInk(look.color)}>
                #
              </Text>
            </Swatch>
          </HStack>
        </Row>
      ) : null}
      {hasCues ? (
        <SliderRow
          label="字号"
          value={look.scale}
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={SCALE_STEP}
          valueText={percent(look.scale)}
          width={controlW}
          onChange={(scale) => changeLook({ scale }, "later")}
        />
      ) : null}
      {hasCues ? (
        <SliderRow
          label="文字透明度"
          value={look.opacity}
          min={OPACITY_MIN}
          max={1}
          step={OPACITY_STEP}
          valueText={percent(look.opacity)}
          width={controlW}
          onChange={(opacity) => changeLook({ opacity }, "later")}
        />
      ) : null}
      {hasCues ? (
        <SliderRow
          label="底色透明度"
          value={look.backdropOpacity}
          min={0}
          max={1}
          step={OPACITY_STEP}
          valueText={look.backdropOpacity === 0 ? "无" : percent(look.backdropOpacity)}
          width={controlW}
          onChange={(backdropOpacity) => changeLook({ backdropOpacity }, "later")}
        />
      ) : null}
      {hasCues ? (
        <Row label="同步">
          <HStack spacing={5}>
            {SHIFT_STEPS.map((step) => (
              <Button key={step.title} buttonStyle="plain" action={() => sub.shift(step.delta)}>
                <MiniPill text={step.short} />
              </Button>
            ))}
            {sub.offset !== 0 ? (
              <Button buttonStyle="plain" action={sub.resetOffset}>
                <MiniPill icon="arrow.counterclockwise" />
              </Button>
            ) : null}
          </HStack>
        </Row>
      ) : null}
      {hasCues ? (
        <Row label="排版">
          <HStack spacing={8}>
            <SwitchPill on={look.layers} text="双层" onPress={() => changeLook({ layers: !look.layers })} />
            <Button buttonStyle="plain" disabled={!moved} action={() => changeLook({ x: 0, y: 0 })}>
              <PillLabel icon="arrow.counterclockwise" text="还原位置" />
            </Button>
            <Text font="caption" foregroundStyle={INK.faint}>
              直接拖字幕
            </Text>
          </HStack>
        </Row>
      ) : null}
    </VStack>
  );
}
