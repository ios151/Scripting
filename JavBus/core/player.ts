// 外部播放器：把视频直链交给别的播放器 App 去播（Infuse / SenPlayer / VLC / nPlayer，或自定义的 URL Scheme）。
// 纯逻辑，只管拼启动地址；真正「打开」在 kit/externalPlayer.ts。
//
// 原版（JSBox，9.1 / 9.2 都一样）只有 nPlayer：`$app.openURL("nplayer-" + url)`。这里把另外三个常见的播放器和
// 自定义也接上，写法照用户自己的 One-ipa（Core/Media/ExternalPlayer.swift）。

export type ExternalPlayerId = "infuse" | "senplayer" | "vlc" | "nplayer" | "custom";

/**
 * subtitle：这个播放器的启动地址接了外挂字幕（`&sub=`）。现在只有 SenPlayer：内嵌播放器的字幕是叠在小窗上的一层，
 * 系统全屏、画中画里看不到，交给 SenPlayer 由它自己渲染就都有了。Infuse 的文档里也有 sub，没接。
 */
export const EXTERNAL_PLAYERS: { id: ExternalPlayerId; title: string; subtitle?: boolean }[] = [
  { id: "infuse", title: "Infuse" },
  { id: "senplayer", title: "SenPlayer", subtitle: true },
  { id: "vlc", title: "VLC" },
  { id: "nplayer", title: "nPlayer" },
  { id: "custom", title: "自定义" },
];

/**
 * 自定义模板输入框里的占位文字，也是界面上唯一的例子：演示 `{url}` 放在哪儿。
 * SenPlayer 其实是内置的，这里只是借它的写法讲清楚；别的播放器照着换 scheme 和路径。
 */
export const PLAYER_TEMPLATE_EXAMPLE = "senplayer://x-callback-url/play?url={url}";

/** 模板里有没有 `{url}` 或 `{raw}`。一个都没有就没地方放视频地址：写死一个地址的话，每部片打开的都是同一个视频。 */
export function hasPlaceholder(template: string): boolean {
  return /\{(?:url|raw)\}/.test(template);
}

/**
 * 作为查询参数的值：除了字母数字和 `-._~` 全部百分号编码（连 `:` `/` 也编码，播放器那头会解回来）。
 * encodeURIComponent 还放过了 `! ' ( ) *`，这里补上。
 */
export function encodeQueryValue(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 这个播放器的启动地址。media 是视频直链，subtitle 是外挂字幕的地址（没有就不传）。
 * SenPlayer：有字幕时多一个 `&sub=<编码后的字幕地址>`（写法是用户给的 SenPlayer URL Scheme 文档里的；
 * 它的 scheme 公开资料里只见到 url / name / ua / sub / saveURL，没有 Referer 或自定义请求头）。其他播放器忽略 subtitle。
 * 自定义：template 里的 `{url}` 换成编码后的地址、`{raw}` 换成原样地址（出现几次换几次）；没有占位符返回 null。
 */
export function launchUrl(player: ExternalPlayerId, media: string, template = "", subtitle = ""): string | null {
  const encoded = encodeQueryValue(media);
  switch (player) {
    case "infuse":
      return `infuse://x-callback-url/play?url=${encoded}`;
    case "senplayer":
      return `senplayer://x-callback-url/play?url=${encoded}${subtitle ? `&sub=${encodeQueryValue(subtitle)}` : ""}`;
    case "vlc":
      return `vlc-x-callback://x-callback-url/stream?url=${encoded}`;
    case "nplayer":
      // nPlayer 的写法：在原地址前面加 nplayer- 前缀（https://… 变成 nplayer-https://…），不编码
      return `nplayer-${media}`;
    case "custom": {
      const text = template.trim();
      if (!hasPlaceholder(text)) return null;
      // 用函数做替换：地址里的 `$&` 之类不会被当成替换模式
      return text.replace(/\{(url|raw)\}/g, (_whole, key: string) => (key === "url" ? encoded : media));
    }
  }
}
