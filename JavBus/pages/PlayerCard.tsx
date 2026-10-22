// 内嵌播放器：系统 AVPlayerView 控制器 + 原版那一排快退 / 快进按钮 + 关闭 + 分享。
// 放在详情页滚动区的外面、固定在顶部：往下读片名信息时画面还在。
// 外观跟封面海报一致（尺寸、圆角见 DetailParts），快进快退那一排是半透明白的小胶囊。
// 完整视频（source.full）可以搜迅雷字幕库，字幕画在画面上（SubtitleLayer），原版没有。字幕的状态和按钮都在详情页上
// （useSubtitles / SubtitleMenu，按钮在小胶囊那一排）：这里只收一个 sub 把字幕画出来。按钮不放在播放器角落里——
// 角落正好在系统控制条上方，拖进度条、点「…」时总被误点。
// 播放器自己的按钮（关闭 / 退出全屏 / 字幕 / 分享）收在右缘中间一列，不压系统控制条占的左上、右上、正中和底部（真机截图里叠在一起了）。
// 横屏全屏也是详情页管的（点小胶囊里的「全屏」强制转横屏，详情页换成整页让给播放器的布局）：这里收一个 fullscreen
// 就把舞台撑满（不给死尺寸，有多大占多大）、藏掉快进快退那排，右上角换成「退出全屏」。同一个 PlayerCard 一直挂着，只是大小变了，
// 所以转横屏按理不会重新载入视频。
// 播放器组件用 AVPlayerView（有 pipStatus，画中画开着时能保活）；试过 VideoPlayer + overlay 想让系统全屏里也有字幕，
// 有了自己的全屏就用不上，撤掉了。
//
// 原版是 `video` 视图盖在封面上，右上角 X 关闭，右下角 ↗ 弹「nplayer 打开 / 分享链接」（这里在 nPlayer 之外加了
// Infuse / SenPlayer / VLC / 自定义链接 / 复制视频链接，见 core/player.ts），
// 封面下面一排按钮：<< 1m、< 10s、< 5s、5s >、30s >、1m >、3m >>（9.2 起最后一档是 3 分钟，9.1 是 10 分钟）。照样子做，
// 区别在于快进快退这里是真的改 AVPlayer.currentTime（原版对 video 视图调 web 视图的 eval，
// 那个方法 video 视图没有）。

import {
  AVPlayerView,
  Button,
  HStack,
  Image,
  Menu,
  ProgressView,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useObservable,
  useRef,
  useState,
  type MutableRefObject,
  type PIPStatus,
} from "scripting";

import { MISSAV_ORIGIN } from "../core/constants";
import { EXTERNAL_PLAYERS } from "../core/player";
import { copyVideoLink, openInPlayer } from "../kit/externalPlayer";
import { STAGE_RADIUS, stageSize } from "./DetailParts";
import { SubtitleLayer } from "./SubtitleParts";
import { GLASS, INK } from "./theme";
import type { Subtitles } from "./useSubtitles";

export interface PlayerSource {
  url: string;
  /** 来源名，左上角显示（MissAV 预览 / Jable 完整视频…）。 */
  label: string;
  /** 是完整视频（不是预览 / 预告）：只有完整视频才有字幕按钮。 */
  full?: boolean;
}

/** 原版快退 / 快进的七个档位（秒）。 */
const BACK_STEPS: [string, number][] = [
  ["<< 1m", -60],
  ["< 10s", -10],
  ["< 5s", -5],
];
const FORWARD_STEPS: [string, number][] = [
  ["5s >", 5],
  ["30s >", 30],
  ["1m >", 60],
  ["3m >>", 180],
];

/**
 * 这些 CDN 对没有 Referer 的 HLS 请求会拒绝。第一次不带头（和原版一样），失败了再带上
 * 来源站的 Referer 重试一次——两种情况都有人遇到过，所以不武断地选一边。
 */
function refererFor(url: string): string | null {
  if (/surrit\.com|missav/i.test(url)) return `${MISSAV_ORIGIN}/`;
  if (/jable|mushroom|hls/i.test(url)) return "https://jable.tv/";
  return null;
}

/** 来源标签亮多久。 */
const LABEL_SHOWN_MS = 4000;
/** 右缘那一列按钮的直径。 */
const OVERLAY_SIZE = 36;

/** 叠在视频上的按钮的样子：深色半透明的圆底 + 白色图标，亮暗的画面上都看得清。 */
function OverlayIcon({ icon }: { icon: string }) {
  return (
    <Image
      systemName={icon}
      font={15}
      foregroundStyle="white"
      frame={{ width: OVERLAY_SIZE, height: OVERLAY_SIZE }}
      background={{ style: "rgba(0,0,0,0.5)", shape: "circle" }}
    />
  );
}

function StepButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Button buttonStyle="borderless" action={onPress}>
      <Text
        font={11}
        foregroundStyle={INK.body}
        padding={{ horizontal: 9, vertical: 5 }}
        background={{ style: GLASS, shape: "capsule" }}
      >
        {label}
      </Text>
    </Button>
  );
}

/**
 * @param sub 字幕状态（在详情页上，见 useSubtitles）：这里只管把字幕画在画面上、把字幕地址带给 SenPlayer
 * @param avRef 把当前的 AVPlayer 交还给详情页：字幕搜索要用视频时长排序
 * @param fullscreen 全屏（详情页横过来了、整页让给播放器）：舞台撑满，不是平时贴在页面顶上的小舞台
 * @param onExitFullscreen 全屏里的「退出全屏」按钮
 * @param onOpenSubtitles 全屏里的「字幕」按钮：打开字幕设置面板（全屏时页面上的小胶囊看不到）
 */
export function PlayerCard({
  source,
  sub,
  avRef,
  fullscreen,
  onExitFullscreen,
  onOpenSubtitles,
  onClose,
}: {
  source: PlayerSource;
  sub: Subtitles;
  avRef: MutableRefObject<AVPlayer | null>;
  fullscreen: boolean;
  onExitFullscreen: () => void;
  onOpenSubtitles: () => void;
  onClose: () => void;
}) {
  const [player, setPlayer] = useState<AVPlayer | null>(null);
  const [error, setError] = useState("");
  // 来源标签亮几秒就淡掉（PlayerCard 按片源地址挂载，换片源会重新亮一次）
  const [labelShown, setLabelShown] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setLabelShown(false), LABEL_SHOWN_MS);
    return () => clearTimeout(timer);
  }, []);
  const pip = useObservable<PIPStatus>();
  const ctl = useRef<{ av: AVPlayer | null; retried: boolean }>({ av: null, retried: false });
  // 被子页面盖住时是在播的，盖住的页面退掉以后接着播
  const resumeOnAppear = useRef(false);
  const stage = stageSize();
  const radius = fullscreen ? 0 : STAGE_RADIUS;
  const subtitleLayer =
    source.full && sub.cues && sub.visible ? (
      <SubtitleLayer cues={sub.cues} syncOffset={sub.offset} getPlayer={() => ctl.current.av} />
    ) : null;

  useEffect(() => {
    let alive = true;
    const c = ctl.current;
    const av = new AVPlayer();
    c.av = av;
    avRef.current = av;
    c.retried = false;
    av.numberOfLoops = -1; // 原版 loop: true

    av.onReadyToPlay = () => {
      if (alive) av.play();
    };
    av.onError = (message) => {
      if (!alive) return;
      const referer = refererFor(source.url);
      if (referer && !c.retried) {
        c.retried = true;
        av.setSource(source.url, { headers: { Referer: referer } });
        return;
      }
      setError(message || "播放失败");
    };

    void (async () => {
      try {
        await SharedAudioSession.setCategory("playback", []);
        await SharedAudioSession.setActive(true);
      } catch {
        /* 没配好只影响后台 / 静音开关下有没有声音，不影响出画面 */
      }
      if (!alive) return;
      if (!av.setSource(source.url)) {
        setError("没有可播放的地址");
        return;
      }
      setPlayer(av);
    })();

    return () => {
      alive = false;
      c.av = null;
      if (avRef.current === av) avRef.current = null;
      const release = () => {
        av.stop();
        av.dispose();
      };
      // 画中画还开着时不能销毁播放器，等它结束再释放
      if (pip.value === "didStart" || pip.value === "willStart") {
        const onPip = (v: PIPStatus) => {
          if (v === "didStop") {
            pip.unsubscribe(onPip);
            release();
          }
        };
        pip.subscribe(onPip);
      } else {
        release();
      }
    };
  }, [source.url]);

  const seekBy = (seconds: number) => {
    const av = ctl.current.av;
    if (!av) return;
    const target = av.currentTime + seconds;
    const limit = av.duration > 0 ? av.duration : Number.POSITIVE_INFINITY;
    av.currentTime = Math.max(0, Math.min(limit, target));
  };

  return (
    <VStack
      spacing={8}
      buttonStyle="borderless"
      frame={fullscreen ? { maxWidth: "infinity", maxHeight: "infinity" } : undefined}
      onAppear={() => {
        if (!resumeOnAppear.current) return;
        resumeOnAppear.current = false;
        ctl.current.av?.play();
      }}
      onDisappear={() => {
        // 磁链 / 演员 / 类目这些子页面把详情页盖住时停住：默认进页就自动播放，不停的话几层详情叠起来会同时出声。
        // 画中画开着时不动它
        const av = ctl.current.av;
        if (!av || pip.value === "didStart" || pip.value === "willStart") return;
        resumeOnAppear.current = av.rate > 0;
        av.pause();
      }}
    >
      <ZStack
        frame={fullscreen ? { maxWidth: "infinity", maxHeight: "infinity" } : { width: stage.width, height: stage.height }}
        background={{ style: "black", shape: { type: "rect", cornerRadius: radius } }}
        clipShape={{ type: "rect", cornerRadius: radius }}
      >
        {player ? (
          <AVPlayerView
            player={player}
            pipStatus={pip}
            renderingMode="controller"
            showsPlaybackControls
            allowsPictureInPicturePlayback
            videoGravity="resizeAspect"
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          />
        ) : error ? null : (
          <ProgressView progressViewStyle="circular" tint="white" />
        )}
        {error ? (
          <Text font="footnote" foregroundStyle="white" padding={16} multilineTextAlignment="center">
            {error}
          </Text>
        ) : null}
        {subtitleLayer}
        {/* 额外的按钮都收在右缘中间一列：系统控制条占着左上（全屏 / 画中画 / 隔空播放）、右上（音量）、正中（快退 / 暂停 / 快进）
            和底部（进度条），这些地方都不放，才不会叠在一起。这一列只占一个手指宽，叠在画面右缘 */}
        <HStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <Spacer />
          <VStack spacing={10} padding={{ trailing: 8 }}>
            {/* 全屏里只留「退出全屏」：先退出再关，免得在横着的时候把页面换成海报 */}
            {fullscreen ? (
              <Button buttonStyle="borderless" action={onExitFullscreen}>
                <OverlayIcon icon="arrow.down.right.and.arrow.up.left" />
              </Button>
            ) : (
              <Button buttonStyle="borderless" action={onClose}>
                <OverlayIcon icon="xmark" />
              </Button>
            )}
            {/* 全屏时页面上那一排小胶囊看不到，字幕设置从这里开 */}
            {fullscreen && source.full ? (
              <Button buttonStyle="borderless" action={onOpenSubtitles}>
                <OverlayIcon icon="captions.bubble" />
              </Button>
            ) : null}
            <Menu label={<OverlayIcon icon="square.and.arrow.up" />}>
              {/* 外部播放器只拿到一个地址，带不了请求头；这类 CDN 要 Referer，内置播放器会补，外部的未必 */}
              {refererFor(source.url) ? (
                <Button title="这个地址要 Referer，外部播放器可能播不了" systemImage="exclamationmark.triangle" disabled action={() => undefined} />
              ) : null}
              {/* 载入了字幕、而且这个播放器接了外挂字幕（SenPlayer）：带上字幕地址，字幕由它自己渲染，全屏 / 画中画里也有 */}
              {EXTERNAL_PLAYERS.map((p) => {
                const withSubtitle = !!p.subtitle && sub.url !== "";
                return (
                  <Button
                    key={p.id}
                    title={p.id === "custom" ? "自定义播放器" : `${p.title} 打开${withSubtitle ? "（带字幕）" : ""}`}
                    systemImage="arrow.up.forward.app"
                    action={() => void openInPlayer(p.id, source.url, withSubtitle ? sub.url : "")}
                  />
                );
              })}
              <Button title="复制视频链接" systemImage="doc.on.doc" action={() => void copyVideoLink(source.url)} />
              <Button title="分享链接" systemImage="square.and.arrow.up" action={() => void ShareSheet.present([source.url])} />
            </Menu>
          </VStack>
        </HStack>
        {/* 来源标签：小窗里亮几秒就淡掉，全屏里不显示（页面上的播放胶囊本来就写着「正在播放 · …」）。
            放右上角：左上角被导航栏的返回按钮盖住，中间被标题盖住 */}
        {fullscreen ? null : (
          <VStack
            frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" }}
            padding={{ top: 6, trailing: 8 }}
            allowsHitTesting={false}
          >
            <Text
              font={11}
              foregroundStyle="white"
              padding={{ horizontal: 6, vertical: 2 }}
              background={{ style: "rgba(0,0,0,0.45)", shape: "capsule" }}
              opacity={labelShown ? 1 : 0}
              animation={{ animation: Animation.smooth({ duration: 0.4 }), value: labelShown ? 1 : 0 }}
            >
              {source.label}
            </Text>
          </VStack>
        )}
      </ZStack>

      {fullscreen ? null : (
        <HStack spacing={6}>
          {BACK_STEPS.map(([label, seconds]) => (
            <StepButton key={label} label={label} onPress={() => seekBy(seconds)} />
          ))}
          <Spacer />
          {FORWARD_STEPS.map(([label, seconds]) => (
            <StepButton key={label} label={label} onPress={() => seekBy(seconds)} />
          ))}
        </HStack>
      )}
    </VStack>
  );
}
