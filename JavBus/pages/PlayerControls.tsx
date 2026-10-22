// 播放器自绘的控制条：叠在画面上的一层，系统控制器换成了「只画画面」的 layer 模式（见 PlayerCard.tsx），所以这些都得自己画。
//
// 两种样子，同一套按钮：
//   全屏（横屏）：顶栏 = 退出全屏 / 画面比例 / 画中画 … 片名 … 倍速 / 分享 / 字幕；底栏 = 信息行、进度条、锁定 + 快退 / 播放 / 快进（照参考截图的排法）
//   小窗（竖屏、贴在页面顶上）：右上角关闭；中间快退 / 播放 / 快进；底栏 = 一排小按钮（倍速 / 画面比例 / 画中画 / 字幕 / 分享 / 全屏）+ 进度条
// 亮和灭靠透明度：视图一直挂着，只改 opacity 和能不能点。这样 Menu 开着的时候控制条淡掉了，菜单也不会被摘掉。
// 进度条自己持有「当前时间」的状态、自己定时去读播放器：时间每 250 毫秒变一下，只重绘这一行，不连累画面和字幕。
// 锁定：只剩一个解锁按钮，别的都不响应，避免口袋里或横着拿时误触。
// 这些全是照类型定义和文档盲写的，没有在真机上看过——哪里排得挤、点不到，要真机反馈。

import { Button, HStack, Image, Menu, ProgressView, Slider, Spacer, Text, VStack, ZStack, useEffect, useRef, useState, type VirtualNode } from "scripting";

import { SKIP_SECONDS, SPEEDS, formatClock, hasDuration, speedLabel } from "../core/playerControls";

/** 叠在视频上的按钮的样子：深色半透明的圆底 + 白色图标，亮暗的画面上都看得清。 */
export function Glyph({ icon, size = 36 }: { icon: string; size?: number }) {
  return (
    <Image
      systemName={icon}
      font={size > 32 ? 15 : 13}
      foregroundStyle="white"
      frame={{ width: size, height: size }}
      background={{ style: "rgba(0,0,0,0.5)", shape: "circle" }}
    />
  );
}

/** 同样的圆底，里面写字（倍速不是 1 倍时，按钮上直接写 1.5x）。 */
function GlyphText({ text, size }: { text: string; size: number }) {
  return (
    <Text
      font={size > 32 ? 12 : 11}
      fontWeight="semibold"
      foregroundStyle="white"
      frame={{ width: size, height: size }}
      background={{ style: "rgba(0,0,0,0.5)", shape: "circle" }}
    >
      {text}
    </Text>
  );
}

/** 进度条两头时间的宽度：定死，数字变化时不左右抖（1:02:03 也放得下）。 */
const CLOCK_W = 54;
/** 松手跳转以后，最多这么久内进度条先停在松手的位置：HLS 上跳转要一会儿才落地，立刻去读会读到旧位置，滑块先弹回去再弹回来。 */
const SEEK_HOLD_MS = 2000;
/** 播放器的位置离松手的位置不到这么多秒，就认为跳转已经落地。 */
const SEEK_LANDED = 1.5;

/**
 * 进度条一行：当前时间 · 滑条 · 总时长。
 * 拖动时只记着手指的位置，松手才真的去跳（HLS 上每动一下就跳会反复缓冲）；点一下不动不算拖，不会跳。
 * 时长不可用（直播、还没就绪）时画不出滑条，只留两头的时间。
 */
function ProgressRow({
  getPlayer,
  shown,
  onSeekTo,
  onInteract,
}: {
  getPlayer: () => AVPlayer | null;
  shown: boolean;
  onSeekTo: (seconds: number) => void;
  onInteract: () => void;
}) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const dragValue = useRef(0);
  const pending = useRef<{ target: number; until: number } | null>(null);

  // 只在控制条亮着时去读；拖动期间不覆盖手指的位置，松手后的一小段时间里也不让旧位置盖回去
  useEffect(() => {
    if (!shown) return;
    const tick = () => {
      if (dragging.current) return;
      const av = getPlayer();
      if (!av) return;
      const now = av.currentTime;
      const held = pending.current;
      if (held) {
        if (Date.now() < held.until && Math.abs(now - held.target) > SEEK_LANDED) {
          setDuration(av.duration);
          return;
        }
        pending.current = null;
      }
      setTime(now);
      setDuration(av.duration);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [shown]);

  const known = hasDuration(duration);
  return (
    <HStack spacing={8}>
      <Text font={12} foregroundStyle="white" lineLimit={1} frame={{ width: CLOCK_W, alignment: "leading" }}>
        {formatClock(drag ?? time)}
      </Text>
      {known ? (
        <Slider
          min={0}
          max={duration}
          step={1}
          value={drag ?? time}
          tint="white"
          frame={{ maxWidth: "infinity" }}
          onChanged={(value) => {
            moved.current = true;
            dragValue.current = value;
            setDrag(value);
            onInteract();
          }}
          onEditingChanged={(editing) => {
            dragging.current = editing;
            if (editing) {
              moved.current = false;
              return;
            }
            if (moved.current) {
              onSeekTo(dragValue.current);
              setTime(dragValue.current);
              pending.current = { target: dragValue.current, until: Date.now() + SEEK_HOLD_MS };
            }
            moved.current = false;
            setDrag(null);
            onInteract();
          }}
        />
      ) : (
        <Spacer />
      )}
      <Text font={12} foregroundStyle="white" lineLimit={1} frame={{ width: CLOCK_W, alignment: "trailing" }}>
        {formatClock(duration)}
      </Text>
    </HStack>
  );
}

export interface PlayerControlsProps {
  getPlayer: () => AVPlayer | null;
  /** 控制条亮着没有。 */
  shown: boolean;
  locked: boolean;
  playing: boolean;
  /** 在等数据（缓冲）：播放键的位置换成转圈。 */
  buffering: boolean;
  speed: number;
  fullscreen: boolean;
  /** 完整视频：才有全屏按钮和信息行（字幕按钮由 subtitleSlot 决定有没有）。 */
  full: boolean;
  /** 全屏顶栏中间的片名。 */
  title: string;
  /** 信息行（分辨率 · 帧率 · 码率），读不到是空串。 */
  info: string;
  canPip: boolean;
  /** 任何一次操作都报一声：控制条的自动淡出从头计时。 */
  onInteract: () => void;
  onTogglePlay: () => void;
  onSkip: (seconds: number) => void;
  onSeekTo: (seconds: number) => void;
  onSpeed: (rate: number) => void;
  onGravity: () => void;
  onLock: () => void;
  onPip: () => void;
  onClose: () => void;
  onEnterFullscreen: () => void;
  onExitFullscreen: () => void;
  /** 字幕按钮（SubtitleMenu，没有字幕功能的片源是 null）和分享菜单：内容在 PlayerCard 里组好，这里只管摆。 */
  subtitleSlot: VirtualNode | null;
  shareSlot: VirtualNode;
}

export function PlayerControls(props: PlayerControlsProps) {
  const { shown, locked, playing, buffering, speed, fullscreen, full, title, info, canPip, onInteract } = props;
  const size = fullscreen ? 38 : 32;
  const act = (fn: () => void) => () => {
    onInteract();
    fn();
  };

  const lockButton = (
    <Button buttonStyle="borderless" action={act(props.onLock)}>
      <Glyph icon={locked ? "lock.fill" : "lock.open.fill"} size={size} />
    </Button>
  );

  const speedMenu = (
    <Menu label={speed === 1 ? <Glyph icon="speedometer" size={size} /> : <GlyphText text={speedLabel(speed)} size={size} />}>
      {SPEEDS.map((rate) => (
        <Button
          key={rate}
          title={speedLabel(rate)}
          systemImage={rate === speed ? "checkmark" : undefined}
          action={act(() => props.onSpeed(rate))}
        />
      ))}
    </Menu>
  );

  const gravityButton = (
    <Button buttonStyle="borderless" action={act(props.onGravity)}>
      <Glyph icon="aspectratio" size={size} />
    </Button>
  );

  const pipButton = canPip ? (
    <Button buttonStyle="borderless" action={act(props.onPip)}>
      <Glyph icon="pip.enter" size={size} />
    </Button>
  ) : null;

  const transport = (
    <HStack spacing={fullscreen ? 40 : 30}>
      <Button buttonStyle="borderless" action={act(() => props.onSkip(-SKIP_SECONDS))}>
        <Image systemName="gobackward.10" font={fullscreen ? 28 : 24} foregroundStyle="white" shadow={{ radius: 3, color: "rgba(0,0,0,0.6)" }} />
      </Button>
      <Button buttonStyle="borderless" action={act(props.onTogglePlay)}>
        {buffering ? (
          <ProgressView progressViewStyle="circular" tint="white" frame={{ width: 44, height: 44 }} />
        ) : (
          <Image
            systemName={playing ? "pause.fill" : "play.fill"}
            font={fullscreen ? 34 : 30}
            foregroundStyle="white"
            frame={{ width: 44, height: 44 }}
            shadow={{ radius: 3, color: "rgba(0,0,0,0.6)" }}
          />
        )}
      </Button>
      <Button buttonStyle="borderless" action={act(() => props.onSkip(SKIP_SECONDS))}>
        <Image systemName="goforward.10" font={fullscreen ? 28 : 24} foregroundStyle="white" shadow={{ radius: 3, color: "rgba(0,0,0,0.6)" }} />
      </Button>
    </HStack>
  );

  const progress = <ProgressRow getPlayer={props.getPlayer} shown={shown} onSeekTo={props.onSeekTo} onInteract={onInteract} />;
  const infoLine = full && info ? (
    <Text font={12} foregroundStyle="rgba(255,255,255,0.85)" lineLimit={1}>
      {info}
    </Text>
  ) : null;

  let body: VirtualNode;
  if (locked) {
    // 锁定：只留解锁按钮，放在左下角
    body = (
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <Spacer />
        <HStack padding={{ horizontal: 14, bottom: 10 }}>
          {lockButton}
          <Spacer />
        </HStack>
      </VStack>
    );
  } else if (fullscreen) {
    body = (
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} spacing={0}>
        {/* 片名叠在正中间：左右两组按钮个数不一样（没有画中画时左边少一个），靠两个 Spacer 夹出来的「居中」会偏 */}
        <ZStack padding={{ horizontal: 14, vertical: 8 }} background="rgba(0,0,0,0.35)">
          <Text font={13} foregroundStyle="white" lineLimit={1} frame={{ maxWidth: 220 }} allowsHitTesting={false}>
            {title}
          </Text>
          <HStack spacing={10}>
            <Button buttonStyle="borderless" action={act(props.onExitFullscreen)}>
              <Glyph icon="arrow.down.right.and.arrow.up.left" size={size} />
            </Button>
            {gravityButton}
            {pipButton}
            <Spacer />
            {speedMenu}
            {props.shareSlot}
            {props.subtitleSlot}
          </HStack>
        </ZStack>
        <Spacer />
        <VStack alignment="leading" spacing={6} padding={{ horizontal: 16, top: 8, bottom: 10 }} background="rgba(0,0,0,0.35)">
          {infoLine}
          {progress}
          <HStack>
            {lockButton}
            <Spacer />
            {transport}
            <Spacer />
            {/* 右边放一块和左边的锁一样大的空位，让快退 / 播放 / 快进落在正中间 */}
            <VStack frame={{ width: size, height: size }} />
          </HStack>
        </VStack>
      </VStack>
    );
  } else {
    body = (
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} spacing={0}>
        <HStack padding={{ top: 8, trailing: 8 }}>
          <Spacer />
          <Button buttonStyle="borderless" action={act(props.onClose)}>
            <Glyph icon="xmark" size={size} />
          </Button>
        </HStack>
        <Spacer />
        {transport}
        <Spacer />
        <VStack spacing={6} padding={{ horizontal: 10, top: 6, bottom: 6 }} background="rgba(0,0,0,0.35)">
          <HStack spacing={8}>
            {/* 小窗放不下信息行（一排六个按钮已经占满了宽度），信息行只在全屏里画 */}
            <Spacer />
            {speedMenu}
            {gravityButton}
            {pipButton}
            {props.subtitleSlot}
            {props.shareSlot}
            {full ? (
              <Button buttonStyle="borderless" action={act(props.onEnterFullscreen)}>
                <Glyph icon="arrow.up.left.and.arrow.down.right" size={size} />
              </Button>
            ) : null}
          </HStack>
          {progress}
        </VStack>
      </VStack>
    );
  }

  return (
    <ZStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      opacity={shown ? 1 : 0}
      allowsHitTesting={shown}
      animation={{ animation: Animation.smooth({ duration: 0.25 }), value: shown ? 1 : 0 }}
    >
      {body}
    </ZStack>
  );
}
