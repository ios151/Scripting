// 字幕的界面：叠在播放器画面上的那一句（SubtitleLayer），和详情页小胶囊里的字幕菜单（SubtitleMenu）。状态与操作在 useSubtitles.ts，
// 颜色 / 字号 / 透明度 / 同步 / 位置的设置面板在 SubtitlePanel.tsx。
//
// 字幕是我们自己画的一层 Text，不是视频里的字幕轨：放在 `AVPlayerView` 上面的 ZStack 里，
// 小窗里和我们自己的全屏（详情页横过来、整页让给播放器）里都看得到；播放器自带的全屏、画中画是另一个视图控制器，这一层跟不过去。
// 外观（颜色 / 字号 / 文字和底条的透明度 / 双层）和位置（手指拖）存在设置里，所有影片共用，见 core/subtitleStyle.ts 和 kit/subtitleLook.ts。

import { Button, GeometryReader, Menu, Spacer, Text, VStack, useEffect, useState } from "scripting";

import { cueTextAt, subtitleMetrics, type SubtitleCue } from "../core/subtitle";
import { splitLayers } from "../core/subtitleLayers";
import { clampSubtitleShift, colorWithAlpha, shiftToRatio, subtitleFontSize } from "../core/subtitleStyle";
import { changeLook } from "../kit/subtitleLook";
import { PillLabel } from "./theme";
import { useSubtitleLook } from "./useSubtitleLook";
import type { Subtitles } from "./useSubtitles";

/** 多久对一次播放时间。一条字幕最短也有半秒，一秒 4 次够用；文字没变就不重绘。 */
const TICK_MS = 250;
/** 左右留的边：右缘有一列按钮（关闭 / 退出全屏 / 字幕 / 分享），字幕不要压到它们。 */
const SIDE_INSET = 52;
/** 底条里字和边之间的空隙（左右）。算一层放得下几个字时要扣掉。 */
const CHIP_PAD = 8;
/** 手指要划过这么多点才算拖（点一下字幕不算）；SwiftUI 的拖动从这个距离起算，开头会跳这么一小步。 */
const DRAG_MIN_DISTANCE = 3;
/** 拖动的可点范围比底条各边多出这么多点，手指不用精准按在字上（朋友的参考实现里也是放大了命中区域）。 */
const HIT_H = 10;
const HIT_V = 8;

/**
 * 当前这一句。自己持有「当前这一句」的状态：一句话变了只重绘这个小组件，不连累整个播放器；
 * 字号和离底边的距离按叠层的实际大小算（小窗和全屏差很多，见 core/subtitle.ts 的 subtitleMetrics）。
 *
 * 手指按在字幕上可以拖着挪位置，其余地方不接管触摸（点画面照样出系统控制条）；没有字幕时整层都不接触摸。
 * 位置存成占叠层宽 / 高的比例，竖屏小窗里拖好的位置到了横屏全屏里还在差不多的地方。
 * 一行放不下的长句拆成上下两层，每层一块自己的底条（core/subtitleLayers.ts，设置里可关）。
 */
export function SubtitleLayer({
  cues,
  syncOffset,
  getPlayer,
}: {
  cues: SubtitleCue[];
  /** 同步偏移（秒），正数 = 字幕提前出现。不叫 offset：和视图的通用属性 offset（位移）撞名，类型会冲突。 */
  syncOffset: number;
  getPlayer: () => AVPlayer | null;
}) {
  // 外观和已落定的位置在全局状态里（kit/subtitleLook.ts），设置面板里拖滑块时只有这一层和面板在重绘
  const look = useSubtitleLook();
  const [line, setLine] = useState("");
  // 位置 = 已落定的（比例）+ 手指正拖着的这一下（点）。放在同一个 state 里：松手时一次改完，不会先跳回原位再跳到新位
  const [place, setPlace] = useState({ x: look.x, y: look.y, dragX: 0, dragY: 0 });

  // 设置面板里「还原位置」改的是 look：跟过来
  useEffect(() => {
    setPlace({ x: look.x, y: look.y, dragX: 0, dragY: 0 });
  }, [look.x, look.y]);

  useEffect(() => {
    const tick = () => {
      const av = getPlayer();
      if (!av) return;
      const text = cueTextAt(cues, av.currentTime + syncOffset);
      setLine((prev) => (prev === text ? prev : text));
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [cues, syncOffset]);

  return (
    <GeometryReader frame={{ maxWidth: "infinity", maxHeight: "infinity" }} allowsHitTesting={line !== ""}>
      {({ size }) => {
        const metrics = subtitleMetrics(size.width, size.height);
        const fontSize = subtitleFontSize(metrics.fontSize, look.scale);
        const inside = (shift: { x: number; y: number }) => clampSubtitleShift(size, metrics.bottom, fontSize, shift);
        const at = inside({ x: place.x * size.width + place.dragX, y: place.y * size.height + place.dragY });
        // 一层放得下几个汉字那么宽：叠层宽度扣掉两边的留白和底条的内边距
        const capacity = (size.width - SIDE_INSET * 2 - CHIP_PAD * 2) / fontSize;
        const rows = look.layers ? splitLayers(line, capacity) : line.trim() ? [line] : [];
        return (
          <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} spacing={0}>
            <Spacer />
            <VStack padding={{ bottom: metrics.bottom - HIT_V, horizontal: SIDE_INSET - HIT_H }}>
              {rows.length > 0 ? (
                <VStack
                  spacing={2}
                  padding={{ horizontal: HIT_H, vertical: HIT_V }}
                  contentShape="rect"
                  offset={{ x: at.x, y: at.y }}
                  onDragGesture={{
                    minDistance: DRAG_MIN_DISTANCE,
                    // 字幕自己跟着手指在动，局部坐标系也跟着动，位移会被吃掉一部分；钉在全局坐标系上（WLOC 摇杆卡片踩过同一个坑）
                    coordinateSpace: "global",
                    onChanged: (drag) => {
                      const { width, height } = drag.translation;
                      // 手势坐标偶尔会是 NaN：丢掉这一帧，免得字幕飞出去再也拖不回来（朋友的参考实现里也加了这道守卫）
                      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
                      setPlace((p) => ({ ...p, dragX: width, dragY: height }));
                    },
                    onEnded: (drag) => {
                      const { width, height } = drag.translation;
                      if (!Number.isFinite(width) || !Number.isFinite(height)) {
                        setPlace((p) => ({ ...p, dragX: 0, dragY: 0 }));
                        return;
                      }
                      const end = inside({ x: place.x * size.width + width, y: place.y * size.height + height });
                      const ratio = shiftToRatio(end, size);
                      setPlace({ x: ratio.x, y: ratio.y, dragX: 0, dragY: 0 });
                      changeLook({ x: ratio.x, y: ratio.y });
                    },
                  }}
                >
                  {rows.map((row, i) => (
                    <Text
                      key={`${i}-${row}`}
                      font={fontSize}
                      fontWeight="semibold"
                      foregroundStyle={colorWithAlpha(look.color, look.opacity)}
                      multilineTextAlignment="center"
                      lineLimit={look.layers ? 2 : 3}
                      padding={{ horizontal: CHIP_PAD, vertical: 3 }}
                      background={
                        look.backdropOpacity > 0
                          ? { style: colorWithAlpha("#000000", look.backdropOpacity), shape: { type: "rect", cornerRadius: 5 } }
                          : undefined
                      }
                      shadow={look.backdropOpacity > 0 ? undefined : { color: colorWithAlpha("#000000", 0.95 * look.opacity), radius: 3, x: 0, y: 1 }}
                    >
                      {row}
                    </Text>
                  ))}
                </VStack>
              ) : null}
            </VStack>
          </VStack>
        );
      }}
    </GeometryReader>
  );
}

/** 同步偏移的几档：左 = 字幕更早出现，右 = 更晚。short 是设置面板里小按钮上的字。 */
export const SHIFT_STEPS: { title: string; short: string; icon: string; delta: number }[] = [
  { title: "字幕提前 5 秒", short: "‹‹ 5s", icon: "chevron.left.2", delta: 5 },
  { title: "字幕提前 0.5 秒", short: "‹ 0.5s", icon: "chevron.left", delta: 0.5 },
  { title: "字幕延后 0.5 秒", short: "0.5s ›", icon: "chevron.right", delta: -0.5 },
  { title: "字幕延后 5 秒", short: "5s ››", icon: "chevron.right.2", delta: -5 },
];

/**
 * 「分享 / 推荐影片」那一排小胶囊里的字幕按钮：还没有字幕时是「搜索」，有了以后是显示 / 隐藏、换一条、同步，
 * 再往下是「字幕设置…」（颜色 / 字号 / 透明度 / 位置，在 SubtitlePanel.tsx）。
 * 放在页面上、不放在播放器的角落里：第一版放在播放器右下角，正好在系统控制条上方，拖进度条、点「…」时总被误点。
 */
export function SubtitleMenu({ sub, onOpenPanel }: { sub: Subtitles; onOpenPanel: () => void }) {
  const hasCues = sub.cues !== null;
  return (
    <Menu
      label={
        <PillLabel
          icon={sub.busy ? "hourglass" : hasCues && sub.visible ? "captions.bubble.fill" : "captions.bubble"}
          text={sub.busy ? "查找中…" : "字幕"}
          active={hasCues && sub.visible && !sub.busy}
        />
      }
    >
      {sub.busy ? <Button title="正在查找 / 载入字幕…" systemImage="hourglass" disabled action={() => undefined} /> : null}
      {sub.summary ? <Button title={sub.summary} systemImage="captions.bubble" disabled action={() => undefined} /> : null}
      {!hasCues && !sub.busy ? <Button title="搜索字幕（迅雷字幕库）" systemImage="magnifyingglass" action={sub.search} /> : null}
      {hasCues ? (
        <Button title={sub.visible ? "隐藏字幕" : "显示字幕"} systemImage={sub.visible ? "eye.slash" : "eye"} action={sub.toggle} />
      ) : null}
      {sub.choiceCount > 1 ? (
        <Button title="换一条字幕" systemImage="arrow.triangle.2.circlepath" disabled={sub.busy} action={sub.next} />
      ) : null}
      {hasCues
        ? SHIFT_STEPS.map((step) => <Button key={step.title} title={step.title} systemImage={step.icon} action={() => sub.shift(step.delta)} />)
        : null}
      {hasCues && sub.offset !== 0 ? <Button title="还原同步" systemImage="arrow.counterclockwise" action={sub.resetOffset} /> : null}
      {hasCues ? <Button title="字幕设置…" systemImage="slider.horizontal.3" action={onOpenPanel} /> : null}
      {hasCues ? (
        <Button
          title="播放器自带的全屏里没有字幕，可以用播放器右下角分享菜单里的「SenPlayer 打开（带字幕）」"
          systemImage="info.circle"
          disabled
          action={() => undefined}
        />
      ) : null}
    </Menu>
  );
}
