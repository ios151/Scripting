// 播放器自绘控制条的纯逻辑：时间显示、倍速档、画面比例、视频信息行、进度条和秒数的换算。
// 不碰 Scripting 全局，Node 里能直接自测；界面在 pages/PlayerControls.tsx，读视频信息的网络部分在 kit/videoFacts.ts。

/** 控制条停多久自动淡掉（只在播放中才淡；暂停时一直亮着）。 */
export const HIDE_AFTER_MS = 3500;

/** 快进 / 快退一格（秒）：控制条中间那两个按钮。 */
export const SKIP_SECONDS = 10;

// ———— 时间 ————

/**
 * 进度条两头的时间：`01:35`，一小时以上是 `1:02:03`。
 * 不是有限数（直播、还没量出时长）或负数都显示 `00:00`。
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** 时长是不是能拿来画进度条：有限数而且大于 0（直播和还没就绪的视频不是）。 */
export function hasDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0;
}

/** 当前位置占整段的比例，限制在 0 到 1；时长不可用返回 0。 */
export function progressOf(time: number, duration: number): number {
  if (!hasDuration(duration) || !Number.isFinite(time)) return 0;
  return Math.min(1, Math.max(0, time / duration));
}

/** 把一个秒数限制在 [0, 时长] 里；时长不可用时只保证不小于 0。 */
export function clampTime(time: number, duration: number): number {
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  return hasDuration(duration) ? Math.min(duration, t) : t;
}

// ———— 倍速 ————

/** 倍速菜单里的几档。 */
export const SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** 菜单里和按钮上写的倍速：`1x`、`1.5x`、`0.75x`。 */
export function speedLabel(rate: number): string {
  return `${rate}x`;
}

// ———— 画面比例 ————

/** 和 AVPlayerView 的 videoGravity 一致。 */
export type Gravity = "resizeAspect" | "resizeAspectFill" | "resize";

/** 点一下「画面比例」按钮依次切换：适应 → 填充 → 拉伸 → 适应。 */
export const GRAVITIES: { value: Gravity; label: string }[] = [
  { value: "resizeAspect", label: "适应" },
  { value: "resizeAspectFill", label: "填充（裁掉多出的边）" },
  { value: "resize", label: "拉伸" },
];

export function nextGravity(current: Gravity): Gravity {
  const index = GRAVITIES.findIndex((g) => g.value === current);
  return GRAVITIES[(index + 1) % GRAVITIES.length].value;
}

/** 切换后提示一句话用的名字。 */
export function gravityLabel(gravity: Gravity): string {
  return GRAVITIES.find((g) => g.value === gravity)?.label ?? "适应";
}

// ———— 视频信息行 ————

/** 从视频轨读出来的几个数（读不到的是 0）。 */
export interface VideoFacts {
  width: number;
  height: number;
  /** 帧率（帧 / 秒）。 */
  fps: number;
  /** 码率（比特 / 秒）。 */
  bitrate: number;
}

/** 清晰度标签：取宽高里小的那条边，1920×1080 → `1080p`、3840×2160 → `2160p`、竖屏视频也按短边算。 */
export function qualityLabel(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return "";
  return `${Math.round(Math.min(width, height))}p`;
}

/** 码率：1 Mbps 以上写 `14.6mbps`，不到的写 `800kbps`；读不到是空串。 */
export function bitrateLabel(bitsPerSecond: number): string {
  if (!(bitsPerSecond > 0)) return "";
  const kbps = Math.round(bitsPerSecond / 1000);
  // 四舍五入到 1000 kbps 的也写成 mbps，不出现「1000kbps」
  if (kbps >= 1000) return `${(bitsPerSecond / 1_000_000).toFixed(1)}mbps`;
  return `${kbps}kbps`;
}

/**
 * 控制条下面那一行小字：`1080p · 30FPS · 4.2mbps`。读不到的项直接省掉，一项都没有就是空串（这一行不画）。
 * 只有分辨率、帧率、码率：编码（HEVC）和动态范围（HDR）、解码方式、实时网速，Scripting 的 API 读不到。
 */
export function describeVideo(facts: VideoFacts | null): string {
  if (!facts) return "";
  const parts = [
    qualityLabel(facts.width, facts.height),
    facts.fps >= 1 ? `${Math.round(facts.fps)}FPS` : "",
    bitrateLabel(facts.bitrate),
  ];
  return parts.filter(Boolean).join(" · ");
}
