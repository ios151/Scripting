// 常量：域名、UA、类目标题、配色、推荐服务地址。
//
// 凡是原版写死的值都照搬，改之前先看注释里写的出处。

import type { SiteKind } from "./types";

/** 本脚本版本；对标的 JSBox 原版是 9.2。 */
export const VERSION = "1.0.0";
export const ORIGIN_VERSION = "9.2";

export const HOMEPAGE: Record<SiteKind, string> = {
  censored: "https://www.javbus.com/",
  uncensored: "https://www.javbus.com/uncensored/",
  western: "https://www.javbus.org/",
};

export const SITE_ORIGIN = "https://www.javbus.com";

/** Missav 官方站：原版 9.2 起从 missav.ai 换成 missav.ws（完整视频、HLS 的 Referer、「获取」菜单都用它）。 */
export const MISSAV_ORIGIN = "https://missav.ws";

/** 搜不到番号、也没有日期可写时的占位日期（原版 9.2 兜底详情就是这么写的）。 */
export const UNKNOWN_DATE = "0000-00-00";

/** 原版给图片请求用的 UA（iOS Safari），页面请求我们也用它，免得被当成脚本。 */
export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/**
 * 电脑版 Safari 的 UA，只给 MissAV 的隐藏页用：用户反馈电脑 UA 下 MissAV 能出 1080p、而且免费。
 * 选 macOS Safari 而不是 Windows Chrome：隐藏页本来就是 WebKit，UA 和引擎一致，不容易被 Cloudflare 看出是冒充的。
 */
export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/** 迅雷字幕库的搜索接口：按文件名模糊匹配网友上传的字幕，GET ?name=…（用法与实测见 core/subtitle.ts）。 */
export const SUBTITLE_API = "https://api-shoulei-ssl.xunlei.com/oracle/subtitle";

/** 原版 Timeout = 10（秒）。 */
export const REQUEST_TIMEOUT = 10;

type Hex = `#${string}`;

/** 原版的 15 组渐变色（前 12 组用于随机配色）。 */
export const GRADIENTS: [Hex, Hex][] = [
  ["#fd354a", "#da0a6f"],
  ["#f97227", "#f52156"],
  ["#edb319", "#e47b18"],
  ["#eecb01", "#e8a400"],
  ["#7ace1e", "#5aba23"],
  ["#25c578", "#3ab523"],
  ["#24d59a", "#24bb9d"],
  ["#00c0c8", "#00a0ca"],
  ["#12b7de", "#2193e6"],
  ["#2f74e0", "#5d44e0"],
  ["#825af6", "#6251f5"],
  ["#cc3ec8", "#9f0cdd"],
  ["#f66295", "#cf30a0"],
  ["#728199", "#54617e"],
  ["#1f436a", "#003268"],
];

/** 详情页里没有头像的演员用这张占位图（原版同一个地址）。 */
export const NO_AVATAR = "https://pics.dmm.co.jp/mono/actjpgs/nowprinting.gif";

/** 搜不到 JavBus 条目、但 Missav / Jable 有片源时，兜底详情用的两张图（原版托管在作者的 gitlab）。 */
export const FALLBACK_THUMB = "https://gitlab.com/Nicked639/javrev/-/raw/master/missav1.jpeg";
export const FALLBACK_COVER = "https://gitlab.com/Nicked639/javrev/-/raw/master/missav2.jpeg";

/**
 * 社区推荐服务（javbus-community：Cloudflare Worker + D1，带管理后台，大家一起维护）的地址，不带末尾斜杠。
 * 这是出厂默认值：没改过设置的用户直接用它；设置里清空这一项也会回到它（见 kit/settings.ts 的 sanitize）。
 * 改成空串 = 不用社区服务，所有列表都用下面原作者的列表和上传服务。
 *
 * 为什么要有它：原作者那边的网友推荐上传服务已经失效（GitLab 令牌过期，上传一律失败），而且只有他一个人能维护。
 */
export const COMMUNITY_URL = "https://javbus-community.javbuss.workers.dev";

/**
 * 社区服务接管哪几份推荐列表：列表、提交、撤销、举报都按这个分。现在只接管网友推荐——
 * 作者精选原作者还在更新（2026-10-23 下载到的最新一条是 10-19 推的），继续读他的列表、用他的上传服务。
 * 以后想把作者精选也搬到社区服务，把 "author" 加进来即可；设置页的说明（core/texts.ts 的 COMMUNITY_FOOTER）要跟着改。
 */
export const COMMUNITY_CHANNELS: readonly ("user" | "author")[] = ["user"];

/** 推荐列表（原作者维护的 JSON）。不归社区服务管的列表用它（现在是作者精选）；设置页可改。 */
export const REC_URL_AUTHOR = "https://gitlab.com/Nicked639/javrev/raw/master/Rec";
export const REC_URL_USER = "https://gitlab.com/Nicked639/javrev/raw/master/RecBot";

/**
 * 推荐上传服务（原作者的 Google Apps Script）。不归社区服务管的列表用它（现在是作者精选）。
 * 「作者推荐」那条要作者密码，别人用不了；保留是为了功能对齐，设置页可换成自己的。
 */
export const REC_UPLOAD_AUTHOR =
  "https://script.google.com/macros/s/AKfycbynfzXOh3y-YMPhRPN7PeIonY572s6GCEnoDL1d4IY79Gh2w_SgbtdbIPQuJ_-2UEDoNg/exec";
export const REC_UPLOAD_USER =
  "https://script.google.com/macros/s/AKfycbydyi_yn5jQ61_Rm9o89BmuM_7vmI7kvtDviylakKkbi6jCHEXlUQ5eIZZjLRW110Wi/exec";

/**
 * 以前版本的默认地址。设置里存着这些值的，说明用户没动过它，升级时换成当前默认：
 * 作者通道的 Apps Script 在原版 9.2 换了新部署，旧的那份不再是官方地址。
 */
export const RETIRED_SERVICE_URLS: string[] = [
  "https://script.google.com/macros/s/AKfycbzXY0KoniPf3_MN1BxE4EAVZsoakuAhemDZ_gQvGp-ZZkaqKH36KbL-y8xnOJvVJldwBA/exec",
];

/** 原版「更新说明」读的远程 README（现已 404，保留作首选来源，失败退回内置文案）。 */
export const README_URL = "https://raw.githubusercontent.com/Nicked639/xteko/master/JavBus/Readme.txt";

/** JavLibrary 高分榜：原版在「推荐」页下拉时打开。 */
export const JAVLIB_BEST_URL = "http://www.javlibrary.com/cn/vl_bestrated.php";

/** 作者署名。 */
export const AUTHOR_TG = "https://t.me/ios151";
