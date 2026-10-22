// 屏幕方向：点「全屏」时转成横屏，退出时转回来。
//
// 2026-10-22 真机实测（诊断按钮的弹窗）：`Device.supportedInterfaceOrientations = ["landscape"]` 能把界面转过去——
// 手机还是竖着拿的（设备方向 portrait、isLandscape = false），屏幕尺寸照样从 440 × 956 变成 956 × 440；
// 读回来的允许方向是 ["landscape", "landscapeLeft", "landscapeRight"]（设成 "all" 时读回来是展开的七项）。
// 而光「放开」（官方文档示例的 ["all"]）没转成：真机反馈是横不了（当时方向锁定开没开没问，原因没查清）。
// 所以全屏靠强制：横屏只留 landscape；退出时只留 portrait，把界面转回竖屏——光把允许的方向放宽不够，
// 当前的横屏方向仍然允许，界面不会自己转回去；转完再还原成用户自己配的方向（文档的写法：`Device.userConfiguredInterfaceOrientations`）。
//
// 「转没转过去」要自己看，Scripting 不通知页面：Device.screen 是活的，旋转以后读到的就是新的大小（诊断时在定时器里读到了 956 × 440），
// 但页面渲染时读到的是旧值，所以在定时器里读（waitForLandscape）。第一版靠 GeometryReader 量页面大小来确认，真机上界面转了几秒
// 就被兜底的 1.5 秒超时判成「转不了」、又转了回去——那条路 1.5 秒内没给出横着的大小（原因不明），别再靠它。

/** 退出横屏后等多久再还原成用户配置：要等界面先转回竖屏。 */
const RESTORE_DELAY_MS = 800;
/** 等界面转过去，最长等多久、每隔多久看一眼。iPhone 上转一下不到一秒；等得太短会把慢的误判成转不了。 */
const ROTATE_TIMEOUT_MS = 2500;
const ROTATE_POLL_MS = 100;

let restoreTimer: ReturnType<typeof setTimeout> | undefined;

function setOrientations(value: typeof Device.supportedInterfaceOrientations): void {
  try {
    Device.supportedInterfaceOrientations = value;
  } catch {
    /* iPad 等不支持的设备（类型定义写明只有 iPhone 有效）：转不了就算了，调用方会发现界面没转 */
  }
}

function cancelRestore(): void {
  if (restoreTimer !== undefined) {
    clearTimeout(restoreTimer);
    restoreTimer = undefined;
  }
}

/** 转成横屏：只许左右横屏。 */
export function enterLandscape(): void {
  cancelRestore();
  setOrientations(["landscape"]);
}

/** 转回竖屏：先只许竖屏，等界面转回来再还原成用户配置。delayMs 给自测用。 */
export function exitLandscape(delayMs: number = RESTORE_DELAY_MS): void {
  cancelRestore();
  setOrientations(["portrait"]);
  restoreTimer = setTimeout(() => {
    restoreTimer = undefined;
    setOrientations(Device.userConfiguredInterfaceOrientations);
  }, delayMs);
}

/** 立刻还原成用户自己配的方向，不转界面。 */
export function restoreOrientation(): void {
  cancelRestore();
  setOrientations(Device.userConfiguredInterfaceOrientations);
}

/** 界面现在是横的吗：当场读 Device.screen（读不出来当竖的）。 */
export function isLandscapeNow(): boolean {
  try {
    return Device.screen.width > Device.screen.height;
  } catch {
    return false;
  }
}

/**
 * 等界面转到想要的方向（landscape = true 等横的，false 等竖的）：转到了返回 true，到点还没转到返回 false。
 * 超时和间隔给自测用。
 */
export function waitForLandscape(
  landscape: boolean,
  timeoutMs: number = ROTATE_TIMEOUT_MS,
  pollMs: number = ROTATE_POLL_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      if (isLandscapeNow() === landscape) resolve(true);
      else if (Date.now() - started >= timeoutMs) resolve(false);
      else setTimeout(look, pollMs);
    };
    look();
  });
}
