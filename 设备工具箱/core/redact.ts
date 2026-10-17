// 日志脱敏：交出去之前把隐私打码。
//
// 日志是要发给陌生人的——贴进 issue、丢进聊天窗口。而里面躺着用户此刻的实际
// 位置、住处附近的街道名、设备标识符、自建服务的域名。让用户自己逐行删不现实，
// 所以导出和复制时统一过一遍这里。
//
// 原则是**保留可排查性**：差多远、是不是同一个地址、查到没查到，这些都还看得出；
// 但看不出具体在哪个胡同、是哪台设备。打码过头的日志等于没有日志。
//
// 内存缓冲区里存的始终是原文，接 scripting-cli 时终端也是原文——只有要交出去的
// 那一刻才打码。

type Rule = [RegExp, string | ((substring: string, ...groups: string[]) => string)];

const RULES: Rule[] = [
  /*
    base64 大块。
    VPN 状态里的 expectedState 就是一个——解出来是 JSON，含回环地址。
    32 位以上才算，免得吃掉短 token 之外的正常文字。
  */
  [/[A-Za-z0-9+/]{32,}={0,2}/g, "…"],

  /*
    UUID（配对记录标识、VPN 配置 ID）。
    留前 8 位：同一份日志里还能看出「是不是同一个」，但凑不出完整的设备标识。
  */
  [/\b([0-9A-Fa-f]{8})-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g, "$1-…"],

  /*
    经纬度。
    降到 1 位小数（≈11 km）。排查路线和移动要的是「差多远」「是不是跨区了」，
    不是「在哪个胡同」。4 位以上小数才动，`1271.85 km` 这类距离不受影响。
  */
  [/-?\d{1,3}\.\d{4,}/g, (m: string) => `${Number(m).toFixed(1)}…`],

  /*
    IPv6（隧道两端地址）。留第一段。
    前瞻要求整体含至少一个 a-f，否则 `20:12:07` 这种时间戳也会被当成 IPv6 吃掉。
  */
  [/\b(?=[0-9a-f:]*[a-f])([0-9a-f]{1,4})(?::[0-9a-f]{0,4}){2,}\b/gi, "$1:…"],

  /*
    IPv4（对端回环地址）。留前两段——能看出是不是同一个网段、配没配对，
    这正是代理模式排查要的，而完整地址没必要给。
  */
  [/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x"],

  /*
    自建的搜索服务地址，域名本身就能指向个人。

    结束符不能用 `\S+`：日志里的 URL 多半躺在 JSON 里，后面紧跟着 `","nextKey":…`
    而中间没有空格，`\S+` 会把这一行剩下的全吃掉。
  */
  [/\bhttps?:\/\/[^\s"'<>,)\]}]+/gi, "https://…"],

  /*
    反查出来的地名。
    `[xx:geocode] 31.2…, 121.5… → 示例大街 1 号` —— 箭头后面就是用户所在的街道或楼。
    只针对 geocode 那一行：route 的日志也有箭头，但后面跟的是坐标和直线距离，
    整段打掉就把最有用的信息也埋了。
  */
  [/(\[[a-z]+:geocode\][^\n]*→ ).+$/gm, "$1***"],

  // 设置里这几项是用户自己写的文本，什么都可能有。
  [/"(cardCustomTitle|islandCustomText|islandEmoji|deviceHost|searchWorkerUrl)":"[^"]*"/g, '"$1":"***"'],
];

/** 把一段日志文本脱敏。规则见上面各条的注释。 */
export function redactLog(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = typeof replacement === "string"
      ? out.replace(pattern, replacement)
      : out.replace(pattern, replacement as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}
