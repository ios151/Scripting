// 离线自测：core/playerControls.ts——播放器自绘控制条的纯逻辑（时间显示、进度换算、倍速、画面比例、视频信息行）。
//   npx -y -p tsx tsx _selftest/javbus-controls.test.ts
//
// 只验证换算和文案。控制条画出来是什么样、拖进度条跟不跟手、淡入淡出、点哪里出控制条，都要真机才知道。

import {
  GRAVITIES,
  HIDE_AFTER_MS,
  SKIP_SECONDS,
  SPEEDS,
  bitrateLabel,
  clampTime,
  describeVideo,
  formatClock,
  gravityLabel,
  hasDuration,
  nextGravity,
  progressOf,
  qualityLabel,
  speedLabel,
  type Gravity,
} from "../JavBus/core/playerControls";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("时间显示");
{
  check("不到一小时：分:秒，补零", formatClock(95) === "01:35", formatClock(95));
  check("截图里的 53:20", formatClock(53 * 60 + 20) === "53:20");
  check("0 秒", formatClock(0) === "00:00");
  check("小数向下取整", formatClock(59.9) === "00:59" && formatClock(60.2) === "01:00");
  check("一小时以上：时:分:秒", formatClock(3723) === "1:02:03", formatClock(3723));
  check("整一小时", formatClock(3600) === "1:00:00");
  check("超过十小时也不乱", formatClock(11 * 3600 + 5) === "11:00:05");
  check("负数 / NaN / 无穷（直播、没量出时长）都是 00:00", formatClock(-5) === "00:00" && formatClock(NaN) === "00:00" && formatClock(Infinity) === "00:00");
}

console.log("进度换算");
{
  check("hasDuration：正的有限数才算", hasDuration(60) && !hasDuration(0) && !hasDuration(NaN) && !hasDuration(Infinity) && !hasDuration(-1));
  check("一半", progressOf(30, 60) === 0.5);
  check("起点和终点", progressOf(0, 60) === 0 && progressOf(60, 60) === 1);
  check("超出范围夹住", progressOf(90, 60) === 1 && progressOf(-3, 60) === 0);
  check("时长不可用 → 0（不除以零）", progressOf(10, 0) === 0 && progressOf(10, NaN) === 0 && progressOf(10, Infinity) === 0);
  check("当前时间是 NaN → 0", progressOf(NaN, 60) === 0);
  check("clampTime：夹在 0 和时长之间", clampTime(-5, 60) === 0 && clampTime(75, 60) === 60 && clampTime(30, 60) === 30);
  check("clampTime：时长不可用时只保证不小于 0（直播里往后拖不被夹成 0）", clampTime(500, 0) === 500 && clampTime(-1, NaN) === 0 && clampTime(NaN, 60) === 0);
}

console.log("倍速");
{
  check("档位升序、含 1 倍", SPEEDS.every((v, i) => i === 0 || v > SPEEDS[i - 1]) && SPEEDS.includes(1));
  check("最慢 0.5、最快 3", SPEEDS[0] === 0.5 && SPEEDS[SPEEDS.length - 1] === 3);
  check("写法：1x / 1.5x / 0.75x", speedLabel(1) === "1x" && speedLabel(1.5) === "1.5x" && speedLabel(0.75) === "0.75x");
  check("快进快退一格是 10 秒", SKIP_SECONDS === 10);
}

console.log("画面比例");
{
  const order: Gravity[] = ["resizeAspect", "resizeAspectFill", "resize"];
  check("三档，和 videoGravity 的取值一致", GRAVITIES.map((g) => g.value).join() === order.join());
  check("适应 → 填充 → 拉伸 → 回到适应", nextGravity("resizeAspect") === "resizeAspectFill" && nextGravity("resizeAspectFill") === "resize" && nextGravity("resize") === "resizeAspect");
  check("转一圈回到原点", nextGravity(nextGravity(nextGravity("resizeAspect"))) === "resizeAspect");
  check("提示用的名字", gravityLabel("resizeAspect") === "适应" && gravityLabel("resize") === "拉伸" && gravityLabel("resizeAspectFill").startsWith("填充"));
}

console.log("视频信息行");
{
  check("1920×1080 → 1080p；3840×2160 → 2160p", qualityLabel(1920, 1080) === "1080p" && qualityLabel(3840, 2160) === "2160p");
  check("取短边：竖屏视频、2.39:1 宽银幕", qualityLabel(1080, 1920) === "1080p" && qualityLabel(1920, 800) === "800p");
  check("尺寸读不到 → 空", qualityLabel(0, 0) === "" && qualityLabel(1920, 0) === "" && qualityLabel(NaN, 1080) === "");
  check("码率：1 Mbps 以上一位小数", bitrateLabel(14_600_000) === "14.6mbps" && bitrateLabel(1_000_000) === "1.0mbps");
  check("码率：不到 1 Mbps 写 kbps", bitrateLabel(800_000) === "800kbps" && bitrateLabel(999_400) === "999kbps");
  check("码率：四舍五入到 1000 kbps 的写成 1.0mbps，不写「1000kbps」", bitrateLabel(999_999) === "1.0mbps", bitrateLabel(999_999));
  check("码率读不到 → 空", bitrateLabel(0) === "" && bitrateLabel(NaN) === "" && bitrateLabel(-1) === "");
  check(
    "完整一行（截图里的那种）",
    describeVideo({ width: 3840, height: 2160, fps: 59.94, bitrate: 14_600_000 }) === "2160p · 60FPS · 14.6mbps",
    describeVideo({ width: 3840, height: 2160, fps: 59.94, bitrate: 14_600_000 }),
  );
  check("30 帧 / 4.2 Mbps", describeVideo({ width: 1920, height: 1080, fps: 30, bitrate: 4_200_000 }) === "1080p · 30FPS · 4.2mbps");
  check("读不到的项省掉，其余照写", describeVideo({ width: 1920, height: 1080, fps: 0, bitrate: 0 }) === "1080p" && describeVideo({ width: 0, height: 0, fps: 24, bitrate: 0 }) === "24FPS");
  check("一项都没有 → 空串（这一行不画）", describeVideo({ width: 0, height: 0, fps: 0, bitrate: 0 }) === "" && describeVideo(null) === "");
  check("不足 1 帧的帧率不写", describeVideo({ width: 1280, height: 720, fps: 0.5, bitrate: 0 }) === "720p");
}

console.log("自动隐藏");
{
  check("停留时间在几秒的量级（太短来不及点、太长挡画面）", HIDE_AFTER_MS >= 2000 && HIDE_AFTER_MS <= 6000, String(HIDE_AFTER_MS));
}

console.log(`\n${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
