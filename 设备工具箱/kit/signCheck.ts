// 签名诊断：把 App、描述文件、设备环境对起来，逐条给结论。
//
// 面向「这个自签的包为什么装不上 / 打不开」。数据都来自已有的几处：
//   - App 的证书、Team、App ID、entitlements  → kit/apps.ts（readAppDetail 拿整份）
//   - 设备上装的描述文件                      → kit/profiles.ts（misagent CopyAll）
//   - 本机 UDID、开发者模式、镜像状态         → kit/services.ts、kit/imageMounter.ts
//
// 这里只做判断，不碰设备，方便离线测。每条结论都写清「依据是什么」，
// 拿不准的一律记 unknown，不猜——报告是拿去排查的，猜错比不说更费事。

import { isPlistDict, type PlistDict } from "./plist";
import { earliestCertificate, expiryState, type ProfileEntry } from "./profiles";
import { simulatedNow } from "./testClock";

export type CheckLevel = "ok" | "warn" | "fail" | "unknown";

export interface CheckItem {
  level: CheckLevel;
  title: string;
  detail: string;
}

export interface SignSubject {
  name: string;
  bundleId: string;
  /** 签名证书名（SignerIdentity）。 */
  signer: string;
  /** entitlements 里的 application-identifier，形如 TEAMID.com.example.app。 */
  appIdentifier: string;
  teamId: string;
  entitlements: PlistDict;
}

export interface DeviceEnv {
  /** 本机 UDID，全小写。拿不到为 null。 */
  udid: string | null;
  developerMode: boolean | null;
  imageMounted: boolean | null;
}

/** 从 readAppDetail 的整份字典里取出诊断要用的部分。 */
export function subjectOf(name: string, bundleId: string, detail: PlistDict): SignSubject {
  const entitlements = isPlistDict(detail.Entitlements) ? detail.Entitlements : {};
  const appIdentifier = typeof entitlements["application-identifier"] === "string" ? entitlements["application-identifier"] : "";
  const dot = appIdentifier.indexOf(".");
  return {
    name,
    bundleId,
    signer: typeof detail.SignerIdentity === "string" ? detail.SignerIdentity : "",
    appIdentifier,
    teamId:
      (typeof entitlements["com.apple.developer.team-identifier"] === "string"
        ? entitlements["com.apple.developer.team-identifier"]
        : "") || (dot > 0 ? appIdentifier.slice(0, dot) : ""),
    entitlements,
  };
}

/** App ID 对不对得上：描述文件可能带通配（TEAMID.*）。 */
export function appIdMatches(profileAppId: string, appId: string): boolean {
  if (!profileAppId || !appId) return false;
  if (profileAppId.endsWith("*")) return appId.startsWith(profileAppId.slice(0, -1));
  return profileAppId === appId;
}

/**
 * 给这个 App 挑最合适的描述文件：先要 App ID 对得上，然后优先精确匹配，
 * 再优先没过期的，最后取到期最晚的。一台设备上同一个 App ID 常有好几份。
 */
export function pickProfile(subject: SignSubject, profiles: ProfileEntry[], now = simulatedNow()): ProfileEntry | null {
  const matched = profiles.filter((profile) => appIdMatches(profile.appIdentifier, subject.appIdentifier));
  if (matched.length === 0) return null;
  const score = (profile: ProfileEntry) => {
    const exact = profile.appIdentifier.endsWith("*") ? 0 : 1;
    const alive = expiryState(profile.expires, now).level === "expired" ? 0 : 1;
    return exact * 2 + alive;
  };
  const expiresAt = (profile: ProfileEntry) => {
    const at = profile.expires ? Date.parse(profile.expires) : NaN;
    return Number.isNaN(at) ? -Infinity : at;
  };
  return [...matched].sort((a, b) => score(b) - score(a) || expiresAt(b) - expiresAt(a))[0];
}

/** 这些键由系统自己带，不是描述文件授权的，不参与「超范围」比对。 */
const IGNORED_ENTITLEMENTS = new Set([
  "application-identifier",
  "com.apple.developer.team-identifier",
  "keychain-access-groups",
]);

/** App 用了、描述文件里没有的 entitlements。这类包常常装得上但一打开就闪退。 */
export function extraEntitlements(subject: SignSubject, profile: ProfileEntry): string[] {
  const allowed = new Set(profile.entitlementKeys);
  return Object.keys(subject.entitlements)
    .filter((key) => !IGNORED_ENTITLEMENTS.has(key) && !allowed.has(key))
    .sort();
}

function udidCheck(profile: ProfileEntry, env: DeviceEnv): CheckItem {
  if (profile.deviceCount === null) {
    return { level: "ok", title: "设备限制", detail: "这份描述文件不限设备（企业证书），不需要登记 UDID。" };
  }
  if (!env.udid) {
    return { level: "unknown", title: "设备限制", detail: `描述文件限定 ${profile.deviceCount} 台设备，但没读到本机 UDID，没法比对。` };
  }
  if (profile.devices.includes(env.udid)) {
    return { level: "ok", title: "设备限制", detail: `本机 UDID 在列表里（共 ${profile.deviceCount} 台）。` };
  }
  return {
    level: "fail",
    title: "设备限制",
    detail: `本机 UDID 不在这份描述文件的 ${profile.deviceCount} 台设备里。这台装不上，要把 UDID 加进去重新签。`,
  };
}

/**
 * 跑一遍检查。`profiles` 传设备上装的全部描述文件，函数自己挑匹配的那份。
 * 返回的顺序就是报告里的顺序：先结论性的，再环境类的。
 */
export function diagnose(subject: SignSubject, profiles: ProfileEntry[], env: DeviceEnv, now = simulatedNow()): CheckItem[] {
  const items: CheckItem[] = [];
  const canDebug = subject.entitlements["get-task-allow"] === true;

  items.push(
    subject.signer
      ? { level: "ok", title: "签名证书", detail: subject.signer }
      : { level: "unknown", title: "签名证书", detail: "设备没有返回证书名。" },
  );
  items.push(
    subject.appIdentifier
      ? { level: "ok", title: "App ID", detail: `${subject.appIdentifier}（Team ${subject.teamId || "未知"}）` }
      : { level: "unknown", title: "App ID", detail: "entitlements 里没有 application-identifier。" },
  );

  const profile = pickProfile(subject, profiles, now);
  if (!profile) {
    items.push({
      level: "fail",
      title: "描述文件",
      detail: subject.appIdentifier
        ? `设备上没有和 ${subject.appIdentifier} 对得上的描述文件。App Store 和 TestFlight 的包本来就不需要；自签的包缺了它装不上。`
        : "没法匹配描述文件：这个 App 没有 App ID。",
    });
  } else {
    items.push({
      level: "ok",
      title: "描述文件",
      detail: `${profile.name}（${profile.appIdentifier}${profile.appIdentifier.endsWith("*") ? "，通配" : ""}）`,
    });

    const expiry = expiryState(profile.expires, now);
    items.push({
      level: expiry.level === "expired" ? "fail" : expiry.level === "soon" ? "warn" : expiry.level === "unknown" ? "unknown" : "ok",
      title: "描述文件有效期",
      detail: expiry.level === "expired" ? `${expiry.text}，需要重新签名。` : expiry.text,
    });

    items.push(udidCheck(profile, env));

    /*
      证书有效期单独查一次。它和描述文件的有效期是两回事：免费账号的证书 7 天、
      企业证书一年，而描述文件常常更长。证书先过期时，描述文件看着还好好的，
      包却已经打不开了——这正是最容易看岔的地方。
    */
    const cert = earliestCertificate(profile);
    if (!cert) {
      items.push({ level: "unknown", title: "证书有效期", detail: "描述文件里没有读出证书。" });
    } else {
      const certExpiry = expiryState(cert.notAfter, now);
      const who = cert.subject || cert.organization || "未知证书";
      items.push({
        level: certExpiry.level === "expired" ? "fail" : certExpiry.level === "soon" ? "warn" : certExpiry.level === "unknown" ? "unknown" : "ok",
        title: "证书有效期",
        detail:
          certExpiry.level === "expired"
            ? `${who}：${certExpiry.text}，要换证书重签。`
            : `${who}：${certExpiry.text}`,
      });
      // 证书比描述文件先过期时，光看描述文件会以为还能用
      const certAt = cert.notAfter ? Date.parse(cert.notAfter) : NaN;
      const profileAt = profile.expires ? Date.parse(profile.expires) : NaN;
      if (!Number.isNaN(certAt) && !Number.isNaN(profileAt) && certAt < profileAt && certExpiry.level !== "expired") {
        items.push({
          level: "warn",
          title: "先到期的是证书",
          detail: `证书比描述文件早到期，实际能用到 ${certExpiry.text.replace("还剩 ", "")}后。只看描述文件会算多。`,
        });
      }
    }

    const extra = extraEntitlements(subject, profile);
    items.push(
      extra.length === 0
        ? { level: "ok", title: "权限范围", detail: "App 的 entitlements 都在描述文件允许范围内。" }
        : {
            level: "warn",
            title: "权限范围",
            detail: `App 用了描述文件里没有的权限：${extra.join("、")}。这类包常常装得上，但一打开就闪退。`,
          },
    );
  }

  items.push({
    level: "ok",
    title: "可调试",
    detail: canDebug ? "带 get-task-allow，是开发签的包。" : "没有 get-task-allow，是分发签的包。",
  });

  // 开发者模式只影响开发签的包；分发签的包不需要开
  if (canDebug) {
    items.push(
      env.developerMode === true
        ? { level: "ok", title: "开发者模式", detail: "已开启。" }
        : env.developerMode === false
          ? { level: "fail", title: "开发者模式", detail: "没开。开发签的包需要它才能运行：设置 → 隐私与安全性 → 开发者模式。" }
          : { level: "unknown", title: "开发者模式", detail: "查不到（老系统没有这个开关）。" },
    );
  }

  return items;
}

const LEVEL_TEXT: Record<CheckLevel, string> = { ok: "通过", warn: "注意", fail: "有问题", unknown: "查不到" };

/** 一句话结论：有 fail 说 fail，否则有 warn 说 warn。 */
export function summarize(items: CheckItem[]): { level: CheckLevel; text: string } {
  const fail = items.filter((item) => item.level === "fail");
  if (fail.length > 0) return { level: "fail", text: `${fail.length} 项有问题：${fail.map((item) => item.title).join("、")}` };
  const warn = items.filter((item) => item.level === "warn");
  if (warn.length > 0) return { level: "warn", text: `${warn.length} 项要注意：${warn.map((item) => item.title).join("、")}` };
  const unknown = items.filter((item) => item.level === "unknown");
  if (unknown.length > 0) return { level: "unknown", text: `没发现问题，${unknown.length} 项查不到` };
  return { level: "ok", text: "全部通过" };
}

/** 复制出去的报告。不含设备 UDID 和序列号。 */
export function reportText(subject: SignSubject, items: CheckItem[], deviceLine: string): string {
  return [
    `签名诊断：${subject.name}`,
    `Bundle ID：${subject.bundleId}`,
    deviceLine,
    "",
    ...items.map((item) => `[${LEVEL_TEXT[item.level]}] ${item.title}：${item.detail}`),
    "",
    `结论：${summarize(items).text}`,
  ].join("\n");
}

// ── 按证书分组 ────────────────────────────────────────────────────────────

export interface SignerGroup {
  signer: string;
  bundleIds: string[];
  /** 这一组里最早到期的那份描述文件的时间；没有匹配的描述文件为 null。 */
  earliestExpiry: string | null;
}

/**
 * 按签名证书分组。一台机器上常有免费号、企业证书、Ad Hoc 混着，
 * 分组后能一眼看出「这一批什么时候集体失效」。
 */
export function groupBySigner(
  apps: { bundleId: string; signer: string; appIdentifier: string }[],
  profiles: ProfileEntry[],
): SignerGroup[] {
  const groups = new Map<string, SignerGroup>();
  for (const app of apps) {
    const key = app.signer || "（没有证书名）";
    const group = groups.get(key) ?? { signer: key, bundleIds: [], earliestExpiry: null };
    group.bundleIds.push(app.bundleId);
    const profile = profiles.find((item) => appIdMatches(item.appIdentifier, app.appIdentifier));
    if (profile?.expires) {
      const at = Date.parse(profile.expires);
      const current = group.earliestExpiry ? Date.parse(group.earliestExpiry) : Infinity;
      if (!Number.isNaN(at) && at < current) group.earliestExpiry = profile.expires;
    }
    groups.set(key, group);
  }
  // 快到期的排前面，没有到期信息的垫底
  return [...groups.values()].sort((a, b) => {
    const left = a.earliestExpiry ? Date.parse(a.earliestExpiry) : Infinity;
    const right = b.earliestExpiry ? Date.parse(b.earliestExpiry) : Infinity;
    return left - right || b.bundleIds.length - a.bundleIds.length;
  });
}
