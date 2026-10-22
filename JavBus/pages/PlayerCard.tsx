// 内嵌播放器：只画画面的 AVPlayerView（layer 模式）+ 自绘的控制条（PlayerControls.tsx）+ 原版那一排快退 / 快进按钮。
// 放在详情页滚动区的外面、固定在顶部：往下读片名信息时画面还在。
// 外观跟封面海报一致（尺寸、圆角见 DetailParts），快进快退那一排是半透明白的小胶囊。
// 完整视频（source.full）可以搜字幕（迅雷字幕库 + 字幕猫），字幕画在画面上（SubtitleLayer），原版没有。字幕的状态在详情页上
// （useSubtitles），字幕按钮现在在控制条里（SubtitleMenu，样子是个圆钮）：这里收一个 sub，把字幕画出来、把字幕菜单摆进控制条。
// 横屏全屏是详情页管的（控制条里的「全屏」按钮 / 全屏里的「退出全屏」，强制转横屏，详情页换成整页让给播放器的布局）：
// 这里收一个 fullscreen 就把舞台撑满（不给死尺寸，有多大占多大）、藏掉快进快退那排。同一个 PlayerCard 一直挂着，只是大小变了，
// 所以转横屏按理不会重新载入视频。
//
// 为什么用 layer 模式：系统的控制器（controller 模式）样子和按钮都改不了，也没有我们要的倍速 / 画面比例 / 锁定 / 信息行。
// layer 模式只画画面，其余自己来；代价是系统控制器自带的东西没了——隔空播放（AirPlay）的按钮、锁屏 / 控制中心里的播放信息、
// 系统的全屏和画中画按钮（画中画改用 VideoPictureInPictureController 自己开）。
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
import { HIDE_AFTER_MS, clampTime, describeVideo, gravityLabel, nextGravity, type Gravity } from "../core/playerControls";
import { copyVideoLink, openInPlayer } from "../kit/externalPlayer";
import { showToast } from "../kit/toast";
import { loadVideoFacts } from "../kit/videoFacts";
import { STAGE_RADIUS, stageSize } from "./DetailParts";
import { Glyph, PlayerControls } from "./PlayerControls";
import { SubtitleLayer, SubtitleMenu } from "./SubtitleParts";
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
 * @param sub 字幕状态（在详情页上，见 useSubtitles）：这里只管把字幕画在画面上、把字幕菜单摆进控制条、把字幕地址带给 SenPlayer
 * @param avRef 把当前的 AVPlayer 交还给详情页：字幕搜索要用视频时长排序
 * @param title 全屏顶栏中间的片名（番号）
 * @param fullscreen 全屏（详情页横过来、整页让给播放器）：舞台撑满，不是平时贴在页面顶上的小舞台
 * @param onEnterFullscreen 控制条里的「全屏」按钮
 * @param onExitFullscreen 全屏里的「退出全屏」按钮
 * @param onOpenSubtitles 字幕菜单里的「字幕设置…」：打开字幕设置面板
 */
export function PlayerCard({
  source,
  sub,
  avRef,
  title,
  fullscreen,
  onEnterFullscreen,
  onExitFullscreen,
  onOpenSubtitles,
  onClose,
}: {
  source: PlayerSource;
  sub: Subtitles;
  avRef: MutableRefObject<AVPlayer | null>;
  title: string;
  fullscreen: boolean;
  onEnterFullscreen: () => void;
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

  // 控制条：亮着没有 / 锁定 / 在播吗 / 在缓冲吗 / 倍速 / 画面比例 / 信息行。
  // playing、speed 在 ref 里也存一份：定时器和播放器的回调里要读最新值，不能读闭包里旧的
  const [shown, setShown] = useState(true);
  const [locked, setLocked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [gravity, setGravity] = useState<Gravity>("resizeAspect");
  const [info, setInfo] = useState("");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pip = useObservable<PIPStatus>();
  // 画中画：layer 模式下要自己拿一个控制器。不支持（或建不出来）就没有这个按钮
  const pipCtl = useRef<VideoPictureInPictureController | null | undefined>(undefined);
  if (pipCtl.current === undefined) {
    try {
      pipCtl.current = VideoPictureInPictureController.isSupported() ? new VideoPictureInPictureController() : null;
    } catch {
      pipCtl.current = null;
    }
  }
  const ctl = useRef<{ av: AVPlayer | null; retried: boolean; playing: boolean; speed: number }>({
    av: null,
    retried: false,
    playing: false,
    speed: 1,
  });
  // 被子页面盖住时是在播的，盖住的页面退掉以后接着播
  const resumeOnAppear = useRef(false);
  const stage = stageSize();
  const radius = fullscreen ? 0 : STAGE_RADIUS;
  const subtitleLayer =
    source.full && sub.cues && sub.visible ? (
      <SubtitleLayer cues={sub.cues} syncOffset={sub.offset} getPlayer={() => ctl.current.av} />
    ) : null;

  /** 让控制条亮起来，并从头计时：播放中停几秒就淡掉，暂停时一直亮着。 */
  const bump = () => {
    setShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (ctl.current.playing) setShown(false);
    }, HIDE_AFTER_MS);
  };
  /** 点一下画面：亮着就收起来，灭着就亮起来。 */
  const toggleControls = () => {
    if (shown) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setShown(false);
    } else {
      bump();
    }
  };
  const markPlaying = (value: boolean) => {
    ctl.current.playing = value;
    setPlaying(value);
  };

  useEffect(() => {
    bump();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const c = ctl.current;
    const av = new AVPlayer();
    c.av = av;
    avRef.current = av;
    c.retried = false;
    av.numberOfLoops = -1; // 原版 loop: true

    av.onReadyToPlay = () => {
      if (!alive) return;
      av.play(c.speed);
      markPlaying(true);
      bump();
    };
    // 播放 / 暂停 / 缓冲的变化（包括系统那边触发的，比如来电打断）。缓冲 = 状态是「等数据」(1)；
    // 用数字比，不依赖运行时有没有 TimeControlStatus 这个枚举对象
    av.onTimeControlStatusChanged = (status) => {
      if (!alive) return;
      markPlaying(av.rate > 0);
      setBuffering(Number(status) === 1);
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

    // 信息行（分辨率 · 帧率 · 码率）：只给完整视频读，预览片段用不上。另开一个 AVAsset 去读，读不到就不画
    if (source.full) {
      const referer = refererFor(source.url);
      void loadVideoFacts(source.url, referer ? { Referer: referer } : undefined).then((facts) => {
        if (alive) setInfo(describeVideo(facts));
      });
    }

    return () => {
      alive = false;
      c.av = null;
      if (avRef.current === av) avRef.current = null;
      // 画中画的控制器跟着播放器一起放掉。PlayerCard 按片源地址挂载（key），这个 effect 只在卸载时才会走到清理。
      // 只放一次：下面画中画结束有两条路都会来调它
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        av.stop();
        av.dispose();
        pipCtl.current?.dispose();
      };
      // 画中画还开着时不能销毁播放器，等它结束再释放
      if (pip.value === "didStart" || pip.value === "willStart" || pipCtl.current?.isActive === true) {
        const onPip = (v: PIPStatus) => {
          if (v === "didStop") {
            pip.unsubscribe(onPip);
            release();
          }
        };
        pip.subscribe(onPip);
        // 双保险：视图卸载以后，pip 这个 Observable 还收不收得到「结束」没法确认；
        // 控制器自己的状态回调是它自己的，不随视图消失（失败也算结束，免得播放器一直不放掉、后台还在出声）
        const controller = pipCtl.current;
        if (controller) {
          controller.onStateChanged = (state) => {
            if (state === "didStop" || state === "failedToStart") {
              pip.unsubscribe(onPip);
              release();
            }
          };
        }
      } else {
        release();
      }
    };
  }, [source.url]);

  const seekBy = (seconds: number) => {
    const av = ctl.current.av;
    if (!av) return;
    av.currentTime = clampTime(av.currentTime + seconds, av.duration);
  };
  const seekTo = (seconds: number) => {
    const av = ctl.current.av;
    if (!av) return;
    av.currentTime = clampTime(seconds, av.duration);
  };
  const togglePlay = () => {
    const av = ctl.current.av;
    if (!av) return;
    if (av.rate > 0) {
      av.pause();
      markPlaying(false);
    } else {
      av.play(ctl.current.speed);
      markPlaying(true);
    }
    bump();
  };
  /** 换倍速：正在播就立刻生效；暂停着只记下，下次播放按这个速度（直接改 rate 会让暂停的视频自己播起来）。 */
  const changeSpeed = (rate: number) => {
    ctl.current.speed = rate;
    setSpeed(rate);
    const av = ctl.current.av;
    if (av) {
      av.defaultRate = rate;
      if (av.rate > 0) av.rate = rate;
    }
  };
  const changeGravity = () => {
    const next = nextGravity(gravity);
    setGravity(next);
    showToast(`画面：${gravityLabel(next)}`);
  };

  // 分享菜单：外部播放器、复制链接、分享。原来在右缘那一列按钮里，现在是控制条里的一个圆钮
  const shareMenu = (
    <Menu label={<Glyph icon="square.and.arrow.up" size={fullscreen ? 38 : 32} />}>
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
  );

  // 字幕菜单：只有完整视频有；图标跟着状态变（查找中 / 已载入且显示 / 其它）
  const hasCues = sub.cues !== null;
  const subtitleMenu = source.full ? (
    <SubtitleMenu
      sub={sub}
      onOpenPanel={onOpenSubtitles}
      label={<Glyph icon={sub.busy ? "hourglass" : hasCues && sub.visible ? "captions.bubble.fill" : "captions.bubble"} size={fullscreen ? 38 : 32} />}
    />
  ) : null;

  return (
    <VStack
      spacing={8}
      buttonStyle="borderless"
      frame={fullscreen ? { maxWidth: "infinity", maxHeight: "infinity" } : undefined}
      onAppear={() => {
        if (!resumeOnAppear.current) return;
        resumeOnAppear.current = false;
        ctl.current.av?.play(ctl.current.speed);
        markPlaying(true);
      }}
      onDisappear={() => {
        // 磁链 / 演员 / 类目这些子页面把详情页盖住时停住：默认进页就自动播放，不停的话几层详情叠起来会同时出声。
        // 画中画开着时不动它
        const av = ctl.current.av;
        if (!av || pip.value === "didStart" || pip.value === "willStart") return;
        resumeOnAppear.current = av.rate > 0;
        av.pause();
        markPlaying(false);
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
            renderingMode="layer"
            pictureInPictureController={pipCtl.current ?? undefined}
            videoGravity={gravity}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          />
        ) : error ? null : (
          <ProgressView progressViewStyle="circular" tint="white" />
        )}
        {/* 接点击的一层：点画面亮 / 灭控制条。放在字幕层和控制条的下面——字幕只在文字上接触摸（拖着挪位置），控制条只在按钮上接 */}
        <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} contentShape="rect" onTapGesture={toggleControls} />
        {error ? (
          <Text font="footnote" foregroundStyle="white" padding={16} multilineTextAlignment="center" allowsHitTesting={false}>
            {error}
          </Text>
        ) : null}
        {subtitleLayer}
        {player ? (
          <PlayerControls
            getPlayer={() => ctl.current.av}
            shown={shown}
            locked={locked}
            playing={playing}
            buffering={buffering}
            speed={speed}
            fullscreen={fullscreen}
            full={!!source.full}
            title={title}
            info={info}
            canPip={pipCtl.current != null}
            onInteract={bump}
            onTogglePlay={togglePlay}
            onSkip={seekBy}
            onSeekTo={seekTo}
            onSpeed={changeSpeed}
            onGravity={changeGravity}
            onLock={() => {
              setLocked((v) => !v);
              bump();
            }}
            onPip={() => {
              pipCtl.current?.start();
            }}
            onClose={onClose}
            onEnterFullscreen={onEnterFullscreen}
            onExitFullscreen={onExitFullscreen}
            subtitleSlot={subtitleMenu}
            shareSlot={shareMenu}
          />
        ) : null}
        {/* 来源标签：小窗里亮几秒就淡掉，全屏里不显示（页面上的播放胶囊本来就写着「正在播放 · …」）。
            放在右上角、关闭按钮的左边：左上角被导航栏的返回按钮盖住，中间被标题盖住 */}
        {fullscreen ? null : (
          <VStack
            frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" }}
            padding={{ top: 14, trailing: 50 }}
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
