// 天气小组件：能调的数都在这里，改了不用动别处。

/** 请系统多久之后重画一次。WidgetKit 只当它是提示，按预算给，通常不准点 */
export const RELOAD_AFTER_MS = 20 * 60 * 1000;

/** 上次没取成功（没网、没位置）时，请系统早一点再来 */
export const RELOAD_RETRY_MS = 10 * 60 * 1000;

/** 小组件里现场定位最多等多久。等不到就退回上次存下的位置 */
export const LIVE_LOCATION_TIMEOUT_MS = 3000;

/** 小组件里反查城市名最多等多久。等不到就先显示「当前位置」，下次再补 */
export const REVERSE_GEOCODE_TIMEOUT_MS = 3000;

/**
 * 小组件里请求天气的超时（秒）。小组件出图有总时长限制，比 App 里的 12 秒短一点。
 * 最坏情况：定位 3 秒 + 联网 6 秒（外面再多兜 2 秒，见 core/system.ts）≈ 11 秒；反查 3 秒和联网同时进行，不叠加。
 */
export const WIDGET_FETCH_TIMEOUT_SECONDS = 6;

/** App 里不赶时间，定位和反查多等一会儿 */
export const APP_LOCATION_TIMEOUT_MS = 10_000;
export const APP_GEOCODE_TIMEOUT_MS = 8000;

/**
 * 缓存里的预警最长还肯显示多久。预警是和天气同一次请求带回来的，联网失败时一起退回缓存，
 * 但超过这个时间就不显示预警了：预警随时可能解除，几个小时前的「红色预警」一直挂着比不显示更糟。
 */
export const ALERT_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** 预警的「取到的时刻」比「现在」晚这么一点点之内，不算在未来：取数据和画出来是两次读时钟，差几秒是常事 */
export const ALERT_CLOCK_SKEW_MS = 60 * 1000;

/** 「预览预警样式」开着的时长。到点自己关，免得忘了关、主屏幕上一直挂着个假预警 */
export const ALERT_DEMO_MS = 10 * 60 * 1000;
