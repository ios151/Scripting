// JavBus 的 Cookie 罐。
//
// 自己管，不依赖系统的共享 Cookie 存储：每次请求显式写 `Cookie` 头，响应的 Set-Cookie 从
// `Response.cookies` 手动吸收（和 网易云音乐 同样的做法）。按 .com / .org 分两只罐，
// 欧美站的 cookie 不往有码站身上带。
//
// 罐子落盘：站点年龄验证只需要通过一次，下次启动还得认得。

type Group = "com" | "org";

const KEY = "javbus.cookies";

let jar: Record<Group, Record<string, string>> | null = null;

function load(): Record<Group, Record<string, string>> {
  if (jar) return jar;
  const stored = Storage.get<Partial<Record<Group, Record<string, string>>>>(KEY);
  jar = { com: { ...(stored?.com ?? {}) }, org: { ...(stored?.org ?? {}) } };
  return jar;
}

function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? "";
}

/** 这个地址属于哪只罐；不是 JavBus 的域名返回 null（别的站不带这些 cookie）。 */
export function groupOf(url: string): Group | null {
  const host = hostOf(url);
  if (host === "javbus.com" || host.endsWith(".javbus.com")) return "com";
  if (host === "javbus.org" || host.endsWith(".javbus.org")) return "org";
  return null;
}

/** 图片 CDN 也要带 cookie 吗：只给 javbus 自家域名带。 */
export function isJavbusUrl(url: string): boolean {
  return groupOf(url) !== null;
}

function groupOfDomain(domain: string): Group | null {
  const d = domain.replace(/^\./, "").toLowerCase();
  if (d === "javbus.com" || d.endsWith(".javbus.com")) return "com";
  if (d === "javbus.org" || d.endsWith(".javbus.org")) return "org";
  return null;
}

/** 吸收一批 cookie（响应的 Set-Cookie、或隐藏 web 视图里读出来的），只收 javbus 域名的。有变化才落盘。 */
export function absorb(cookies: Cookie[] | undefined | null): boolean {
  if (!cookies || cookies.length === 0) return false;
  const j = load();
  let changed = false;
  for (const c of cookies) {
    const group = groupOfDomain(c.domain ?? "");
    if (!group || !c.name) continue;
    if (j[group][c.name] !== c.value) {
      j[group][c.name] = c.value;
      changed = true;
    }
  }
  if (changed) Storage.set(KEY, j);
  return changed;
}

/** 拼 `Cookie` 头。`overrides` 优先于罐里的同名项（existmag 每次请求都要按「全部 / 收录」重写）。 */
export function cookieHeader(url: string, overrides: Record<string, string> = {}): string {
  const group = groupOf(url);
  if (!group) return "";
  const merged = { ...load()[group], ...overrides };
  return Object.entries(merged)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function clearCookies(): void {
  jar = { com: {}, org: {} };
  Storage.set(KEY, null);
}

/** 设置页展示用：各罐里有几个 cookie（不显示内容，cookie 当密码对待）。 */
export function cookieCounts(): { com: number; org: number } {
  const j = load();
  return { com: Object.keys(j.com).length, org: Object.keys(j.org).length };
}
