// 离线自测（Node 里跑，不碰 Scripting 的原生 API）。
//   npx -y -p tsx tsx _selftest/toolbox.test.ts
//
// 样本一律虚构：序列号、UDID、ECID 都是一眼看得出是编的那种。

import { encodeBplist } from "../设备工具箱/core/bplist";
import { utf8 } from "../设备工具箱/core/bytes";
import { PlistServiceClient, LockdownServiceError } from "../设备工具箱/kit/lockdown";
import { decodePlist, decodeXmlPlist, encodeXmlPlist, isPlistDict } from "../设备工具箱/kit/plist";
import {
  collectBundleIds,
  parseBattery,
  readBattery,
  readDeviceInfo,
  readHomeLayout,
  readIcons,
} from "../设备工具箱/kit/services";
import { isTunnelDropped, type DeviceSession } from "../设备工具箱/kit/session";
import { clearDebugLog, debugEcho, debugLog, debugLogCount, debugLogText } from "../设备工具箱/core/debug";
import { DEFAULT_HOST, normalizeHost, normalizeSettings } from "../设备工具箱/kit/settings";
import { LINK_LABEL, classifyLink, linkHint, needsAttention, type LinkKind } from "../设备工具箱/kit/network";
import {
  allKeys,
  arrangementKey,
  clonePlist,
  compareLayouts,
  dockKeys,
  dockToPage,
  moveInDock,
  withWidgetIdentifiers,
} from "../设备工具箱/kit/homeEdit";
import { applyPlan, collectFolderApps, collectLooseApps, colorFolderLayout, dissolveFolders, reorderLooseApps, sanitizePlan, sortLooseApps } from "../设备工具箱/kit/homeOrganize";
import { COLOR_BUCKETS, colorBucket, colorKey, compareColorKeys } from "../设备工具箱/kit/colorSort";
import {
  askOrganizer,
  extractJson,
  OUTPUT_FORMAT,
  ReplyFormatError,
  StoppedError,
  type AskControl,
  buildPrompt,
  DEFAULT_STYLE_PROMPT,
  FIXED_PROTOCOL,
  isCustomStylePrompt,
  loadStylePrompt,
  organizerErrorText,
  parseReply,
  resetStylePrompt,
  resolvePlan,
  saveStylePrompt,
  transientReason,
  STYLE_PROMPT_LIMIT,
} from "../设备工具箱/kit/aiOrganize";
import type { PlistValue } from "../设备工具箱/core/bplist";
import {
  appListText,
  classifyApp,
  formatAge,
  isScriptingItself,
  loadSizeCache,
  installTimes,
  parseApps,
  readAppSizes,
  readApps,
  saveSizeCache,
  sinceText,
  sortApps,
  uninstallApp,
  versionText,
  withSizes,
  type AppEntry,
  type AppSizes,
} from "../设备工具箱/kit/apps";
import {
  DEFAULT_ROW_ACTIONS,
  ROW_ACTIONS,
  findRowAction,
  moveRowAction,
  rowActionText,
  sanitizeRowActions,
  toggleRowAction,
  type RowActionId,
} from "../设备工具箱/kit/rowActions";
import {
  appsForProfile,
  expiryState,
  extractProfilePlist,
  parseProfile,
  readProfiles,
  removeProfile,
  sortProfiles,
} from "../设备工具箱/kit/profiles";
import { flattenSorted, formatBytes, isGestaltKey, powerAction, readMobileGestalt } from "../设备工具箱/kit/services";
import { readImageStatus } from "../设备工具箱/kit/imageMounter";
import { inferPageSize, memoryBreakdown, parseSample } from "../设备工具箱/kit/sysmon";
import { EVENT_GROUPS, EVENT_KINDS, describeEvent, watchEvents } from "../设备工具箱/kit/notifications";
import {
  appIdMatches,
  diagnose,
  extraEntitlements,
  groupBySigner,
  pickProfile,
  reportText,
  subjectOf,
  summarize,
  type DeviceEnv,
} from "../设备工具箱/kit/signCheck";
import { earliestCertificate, type ProfileEntry } from "../设备工具箱/kit/profiles";
import { parseCertTime, parseCertificate } from "../设备工具箱/kit/x509";
import { clockLabel, clockOffsetDays, isClockShifted, resetClock, shiftClock, simulatedNow } from "../设备工具箱/kit/testClock";
import { entitlementsOf, readAppDetail, urlSchemes } from "../设备工具箱/kit/apps";
import { deviceHub } from "../设备工具箱/kit/hub";
import { cacheSizeText, totalCacheBytes } from "../设备工具箱/kit/cache";
import {
  clearStoreLinkCache,
  countriesFor,
  findStoreLinks,
  genreName,
  lookupUrl,
  parseLookup,
  shareText,
} from "../设备工具箱/kit/appStore";
import {
  CURVE_LIMIT,
  appendSample,
  availableMetrics,
  curveMarks,
  curveSummary,
  formatMetric,
  formatSpan,
  type CurveSample,
} from "../设备工具箱/kit/batteryCurve";
import {
  HISTORY_LIMIT,
  cardState,
  cardTone,
  compactText,
  pushHistory,
  shouldEndOnUnplug,
  sparkHeights,
  statusText,
} from "../设备工具箱/kit/batteryCard";
import type { BatteryReport } from "../设备工具箱/kit/services";
import { suspiciousValues, widgetDiff, widgetEntries } from "../设备工具箱/kit/layoutCheck";
import { PReal } from "../设备工具箱/core/bplist";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

// ── 帧：4 字节大端长度 + XML plist ─────────────────────────────────────────

function frame(value: PlistValue): Uint8Array {
  const body = encodeXmlPlist(value);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** 假的隧道连接：预置回包，按很小的块吐出来，逼读取器跨块拼帧。 */
class FakeConnection {
  written: Uint8Array[] = [];
  closed = false;
  private pending: Uint8Array;
  constructor(replies: Uint8Array[], private readonly chunk = 7) {
    const total = replies.reduce((n, r) => n + r.length, 0);
    this.pending = new Uint8Array(total);
    let offset = 0;
    for (const reply of replies) {
      this.pending.set(reply, offset);
      offset += reply.length;
    }
  }
  async read(max = 16384): Promise<Uint8Array | null> {
    if (this.pending.length === 0) return null;
    const take = Math.min(this.chunk, max, this.pending.length);
    const out = this.pending.slice(0, take);
    this.pending = this.pending.subarray(take);
    return out;
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length > 16384) throw new Error("单次写入超过 16384");
    this.written.push(bytes.slice());
  }
  async end(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeTunnel(connection: FakeConnection): VPNRSDTunnel {
  return {
    getState: async () => ({}) as VPNRSDState,
    connect: async () => connection as unknown as VPNRSDConnection,
    close: async () => {},
  };
}

/** 把写出去的字节按帧拆开，解成 plist。 */
function sentMessages(connection: FakeConnection): PlistValue[] {
  const total = connection.written.reduce((n, w) => n + w.length, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const w of connection.written) {
    all.set(w, offset);
    offset += w.length;
  }
  const messages: PlistValue[] = [];
  let cursor = 0;
  while (cursor < all.length) {
    const length = new DataView(all.buffer, cursor, 4).getUint32(0, false);
    messages.push(decodePlist(all.subarray(cursor + 4, cursor + 4 + length)));
    cursor += 4 + length;
  }
  return messages;
}

async function main() {
  console.log("XML plist");
  {
    const sample: PlistValue = {
      Request: "GetValue",
      Label: "a<b & c>d",
      Count: 42,
      Ratio: 1.5,
      Flag: true,
      Off: false,
      Blob: new Uint8Array([0, 1, 2, 250, 255]),
      Nested: { List: [1, "two", { three: 3 }], Empty: [] },
    };
    const round = decodeXmlPlist(new TextDecoder().decode(encodeXmlPlist(sample)));
    check("往返后字典结构一致", isPlistDict(round) && round.Request === "GetValue" && round.Count === 42);
    check("特殊字符转义往返", isPlistDict(round) && round.Label === "a<b & c>d", JSON.stringify(isPlistDict(round) ? round.Label : null));
    check("浮点与布尔", isPlistDict(round) && round.Ratio === 1.5 && round.Flag === true && round.Off === false);
    check(
      "data 往返",
      isPlistDict(round) && round.Blob instanceof Uint8Array && Array.from(round.Blob).join(",") === "0,1,2,250,255",
    );
    const nested = isPlistDict(round) && isPlistDict(round.Nested) ? round.Nested : null;
    check("嵌套数组/空数组", Array.isArray(nested?.List) && nested!.List.length === 3 && Array.isArray(nested?.Empty));

    const device = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>UniqueChipID</key>
	<integer>1234567890123456789</integer>
	<key>Name</key>
	<string>Tom&apos;s &amp;lt;Phone&#x21;</string>
	<key>When</key>
	<date>2026-01-02T03:04:05Z</date>
	<key>Empty</key>
	<string/>
	<key>Raw</key>
	<data>
	AAEC
	/w==
	</data>
</dict>
</plist>`;
    const parsed = decodeXmlPlist(device);
    check("超出安全整数的 integer 保留为十进制字符串", isPlistDict(parsed) && parsed.UniqueChipID === "1234567890123456789");
    check("实体反转义（&amp; 最后换）", isPlistDict(parsed) && parsed.Name === "Tom's &lt;Phone!", JSON.stringify(isPlistDict(parsed) ? parsed.Name : null));
    check("date 读成字符串", isPlistDict(parsed) && parsed.When === "2026-01-02T03:04:05Z");
    check("自闭合 <string/>", isPlistDict(parsed) && parsed.Empty === "");
    check(
      "带换行的 base64",
      isPlistDict(parsed) && parsed.Raw instanceof Uint8Array && Array.from(parsed.Raw).join(",") === "0,1,2,255",
    );
    check("二进制 plist 也认", (decodePlist(encodeBplist({ a: 1 })) as Record<string, unknown>).a === 1);
    check("坏数据抛错", (await rejects(Promise.resolve().then(() => decodeXmlPlist("<plist><dict><key>a</key></dict></plist>")))) instanceof Error);

    console.log("XML plist：<data> 在字节层面解");
    const sameBytes = (a: unknown, b: Uint8Array) =>
      a instanceof Uint8Array && a.length === b.length && a.every((value, index) => value === b[index]);

    const fromBytes = decodePlist(utf8(device));
    check(
      "字节入口与字符串入口结果一致",
      isPlistDict(fromBytes) && sameBytes(fromBytes.Raw, new Uint8Array([0, 1, 2, 255])) && fromBytes.Name === "Tom's &lt;Phone!",
    );

    let paddingOk = true;
    for (let size = 0; size <= 7; size++) {
      const blob = new Uint8Array(size).map((_, index) => (index * 97 + 13) & 0xff);
      const back = decodePlist(encodeXmlPlist({ d: blob }));
      if (!isPlistDict(back) || !sameBytes(back.d, blob)) paddingOk = false;
    }
    check("0–7 字节各种填充长度都对", paddingOk);

    // 空白不落在 4 字符组边界上：快路和逐字符的慢路要能来回切。
    const odd = new Uint8Array(301).map((_, index) => (index * 31 + 7) & 0xff);
    const oddText = Buffer.from(odd).toString("base64").replace(/.{5}/g, "$&\n ");
    const oddBack = decodePlist(utf8(`<plist><data>${oddText}</data></plist>`));
    check("空白切在组中间也能还原", sameBytes(oddBack, odd));

    const first = new Uint8Array([9, 8, 7, 6, 5]);
    const second = new Uint8Array(300).map((_, index) => index & 0xff);
    const mixed = decodePlist(encodeXmlPlist({ 名字: "测试机📱", A: first, 列表: [second, "尾巴"], s: "@0" }));
    const list = isPlistDict(mixed) && Array.isArray(mixed.列表) ? mixed.列表 : [];
    check("多个 <data>、前后夹中文和 emoji", isPlistDict(mixed) && mixed.名字 === "测试机📱" && sameBytes(mixed.A, first));
    check("数组里的 <data> 和后面的字符串", sameBytes(list[0], second) && list[1] === "尾巴");
    check("<string>@0</string> 不会被当成占位", isPlistDict(mixed) && mixed.s === "@0");

    const empties = decodePlist(utf8("<plist><dict><key>a</key><data></data><key>b</key><data/></dict></plist>"));
    check(
      "空的 <data></data> 与 <data/>",
      isPlistDict(empties) && sameBytes(empties.a, new Uint8Array(0)) && sameBytes(empties.b, new Uint8Array(0)),
    );
    check(
      "非法 base64 抛错",
      (await rejects(Promise.resolve().then(() => decodePlist(utf8("<plist><data>AA*A</data></plist>"))))) instanceof Error,
    );
    check(
      "<data> 没闭合抛错",
      (await rejects(Promise.resolve().then(() => decodePlist(utf8("<plist><dict><key>a</key><data>AAAA"))))) instanceof Error,
    );

    // 照 misagent CopyAll 的样子：Payload 数组里几十段描述文件，base64 按 CF 的排版每行 68 字符。
    const blobs = Array.from({ length: 60 }, (_, n) =>
      new Uint8Array(24 * 1024).map((_, index) => ((index + n) * 2654435761) >>> 24),
    );
    const payload = blobs
      .map((blob) => `\t\t<data>\n${Buffer.from(blob).toString("base64").replace(/.{68}/g, "\t\t$&\n")}\n\t\t</data>`)
      .join("\n");
    const copyAll = utf8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Payload</key>\n\t<array>\n${payload}\n\t</array>\n\t<key>Status</key>\n\t<integer>0</integer>\n</dict>\n</plist>\n`,
    );
    const started = performance.now();
    const decoded = decodePlist(copyAll);
    const elapsed = performance.now() - started;
    const got = isPlistDict(decoded) && Array.isArray(decoded.Payload) ? decoded.Payload : [];
    check(
      `misagent 样式 ${(copyAll.length / 1048576).toFixed(1)} MB、60 段 <data> 原样还原（${elapsed.toFixed(0)} ms）`,
      got.length === 60 && got.every((blob, index) => sameBytes(blob, blobs[index])) && isPlistDict(decoded) && decoded.Status === 0,
    );
    check("解出来的数组不带多余底层 buffer", got[0] instanceof Uint8Array && got[0].buffer.byteLength === got[0].length);
  }

  console.log("RSDCheckin 与收发");
  {
    const connection = new FakeConnection([
      frame({ Request: "RSDCheckin" }),
      frame({ Request: "StartService" }),
      frame({ Request: "GetValue", Value: { DeviceName: "测试机" } }),
      frame({ Error: "MissingValue", ErrorString: "no such key" }),
    ]);
    const client = await PlistServiceClient.open(fakeTunnel(connection), "com.example.shim.remote", 1234);
    const sent = sentMessages(connection);
    check("先发 RSDCheckin", isPlistDict(sent[0]) && sent[0].Request === "RSDCheckin" && sent[0].ProtocolVersion === "2");
    const reply = await client.request({ Label: "", Request: "GetValue" });
    check("跨小块拼帧读出回包", isPlistDict(reply.Value) && reply.Value.DeviceName === "测试机");
    const error = await rejects(client.request({ Label: "", Request: "GetValue", Key: "Nope" }));
    check(
      "Error 字段转成异常并带上 ErrorString",
      error instanceof LockdownServiceError && error.code === "MissingValue" && error.message.includes("no such key"),
    );
    await client.close();
    check("关闭连接", connection.closed);

    const bad = new FakeConnection([frame({ Request: "Nope" })]);
    const failure = await rejects(PlistServiceClient.open(fakeTunnel(bad), "x", 1));
    check("签到回包不对时报错并关连接", failure instanceof Error && bad.closed);

    const big = new FakeConnection([frame({ Request: "RSDCheckin" }), frame({ Request: "StartService" })]);
    const bigClient = await PlistServiceClient.open(fakeTunnel(big), "x", 1);
    await bigClient.send({ pngData: new Uint8Array(50_000) });
    check("大消息按 16384 切块写", big.written.every((chunk) => chunk.length <= 16384) && big.written.length > 3);
  }

  console.log("服务解析");
  {
    /** 假会话：按服务名把请求交给对应的应答函数。 */
    function fakeSession(
      handlers: Record<string, (message: Record<string, PlistValue>) => PlistValue>,
      properties: Record<string, unknown> = {},
    ): DeviceSession {
      const client = {
        request: async (message: Record<string, PlistValue>) => handlers.request(message) as Record<string, PlistValue>,
        requestValue: async (message: Record<string, PlistValue>) => handlers.request(message),
        send: async () => {},
      };
      return {
        properties,
        hasService: () => true,
        withService: async (_name: string, use: (c: typeof client) => Promise<unknown>) => use(client),
      } as unknown as DeviceSession;
    }

    const battery = await readBattery(
      fakeSession({
        request: (message) =>
          message.Request === "IORegistry"
            ? {
                Status: "Success",
                Diagnostics: {
                  IORegistry: {
                    CycleCount: 321,
                    DesignCapacity: 3279,
                    AppleRawMaxCapacity: 2850,
                    AppleRawCurrentCapacity: 1425,
                    MaxCapacity: 100,
                    CurrentCapacity: 50,
                    Temperature: 3125,
                    Voltage: 3850,
                    InstantAmperage: "18446744073709551266",
                    IsCharging: false,
                    ExternalConnected: false,
                    BatteryData: { MaximumCapacityPercent: 88 },
                  },
                },
              }
            : {},
      }),
    );
    check("健康度 = 满充 ÷ 设计", battery.healthPercent === 86.9, String(battery.healthPercent));
    check("MaxCapacity 是百分比时不当成 mAh", battery.fullChargeCapacity === 2850);
    check("电量取 CurrentCapacity 百分比", battery.chargePercent === 50);
    check("系统健康度来自 BatteryData", battery.systemHealthPercent === 88);
    check("温度换算成 °C", battery.temperatureC === 31.25);
    check("电流的补码转成负数", battery.amperageMA === -350, String(battery.amperageMA));
    check("循环次数", battery.cycleCount === 321);

    const oldStyle = await readBattery(
      fakeSession({
        request: () => ({
          Status: "Success",
          Diagnostics: { IORegistry: { DesignCapacity: 1810, MaxCapacity: 1500, CurrentCapacity: 750 } },
        }),
      }),
    );
    check("老系统 MaxCapacity 是 mAh", oldStyle.fullChargeCapacity === 1500 && oldStyle.healthPercent === 82.9, String(oldStyle.healthPercent));
    check("老系统电量按 mAh 算", oldStyle.chargePercent === 50);

    check("功率 = 电压 × 电流，放电为负", battery.powerW === -1.3, String(battery.powerW));
    check("算得出健康度时不列容量诊断字段", battery.capacityFields.length === 0 && battery.healthSource === "computed");

    // 照真机截图（iOS 27）的形状：顶层没有 AppleRaw*、没有 Temperature，充电中
    const ios27 = parseBattery({
      CycleCount: 85,
      DesignCapacity: 4768,
      MaxCapacity: 100,
      CurrentCapacity: 37,
      Voltage: 4017,
      InstantAmperage: 5254,
      IsCharging: true,
      AdapterDetails: { Watts: 20, Description: "pd charger", IsWireless: false },
      BatteryData: { NominalChargeCapacity: 4300, Temperature: 3050, Qmax: [4400] },
    });
    check("满充容量从 BatteryData 里找到", ios27.fullChargeCapacity === 4300 && ios27.healthPercent === 90.2, String(ios27.healthPercent));
    check("温度从 BatteryData 里找到", ios27.temperatureC === 30.5);
    check("充电功率 4.017 V × 5.254 A ≈ 21.1 W", ios27.powerW === 21.1, String(ios27.powerW));
    check("充电器信息", ios27.charger?.watts === 20 && ios27.charger?.name === "pd charger" && ios27.charger?.isWireless === false);

    // 真机截图的情况：原始值比设计值高（新电池），标称值正常
    const both = parseBattery({ DesignCapacity: 4768, AppleRawMaxCapacity: 4884, NominalChargeCapacity: 4700, MaxCapacity: 100 });
    check("标称和原始都有时用标称算健康度", both.fullChargeCapacity === 4700 && both.fullChargeSource === "NominalChargeCapacity" && both.healthPercent === 98.6, String(both.healthPercent));
    check("两个满充值都保留给界面列出", both.nominalChargeCapacity === 4700 && both.rawMaxCapacity === 4884);
    const rawOnly = parseBattery({ DesignCapacity: 4768, AppleRawMaxCapacity: 4884, MaxCapacity: 100 });
    check("只有原始值时用原始值，并注明出处", rawOnly.healthPercent === 102.4 && rawOnly.fullChargeSource === "AppleRawMaxCapacity", String(rawOnly.healthPercent));

    const systemOnly = parseBattery({ DesignCapacity: 4768, MaxCapacity: 100, BatteryData: { MaximumCapacityPercent: 91, Qmax: [4500] } });
    check("没有满充容量时退用系统百分比", systemOnly.healthPercent === 91 && systemOnly.healthSource === "system");
    check("算不出健康度时列出容量相关字段", systemOnly.capacityFields.some(([key]) => key === "BatteryData.Qmax"), JSON.stringify(systemOnly.capacityFields));

    const emptyFailure = await rejects(readBattery(fakeSession({ request: () => ({ Status: "Success", Diagnostics: { IORegistry: {} } }) })));
    check("拿不到电池数据时报错", emptyFailure instanceof Error);

    const info = await readDeviceInfo(
      fakeSession(
        {
          request: (message) =>
            message.Domain === "com.apple.disk_usage"
              ? { Value: { TotalDiskCapacity: 256_000_000_000, AmountDataAvailable: 64_000_000_000 } }
              : { Value: { DeviceName: "测试机", ProductVersion: "27.0", SerialNumber: "TESTSERIAL00" } },
        },
        { ProductType: "iPhone16,2", UniqueChipID: BigInt("1234567890123456789"), BuildVersion: "24A000" },
      ),
    );
    const flat = new Map(info.sections.flatMap((s) => s.items.map((item) => [item.label, item] as const)));
    check("机型映射成市售名", flat.get("机型")?.value === "iPhone 15 Pro Max");
    check("lockdown 优先于 RSD 属性", flat.get("版本")?.value === "27.0");
    check("存储换算", flat.get("总容量")?.value === "256.0 GB" && flat.get("已用")?.value.startsWith("192.0 GB") === true);
    check("ECID 显示十六进制且不丢位", flat.get("ECID")?.value === "0x112210F47DE98115（1234567890123456789）", flat.get("ECID")?.value);
    check("序列号标为敏感", flat.get("序列号")?.sensitive === true);
    check("全部属性带出处前缀", info.raw.some(([key]) => key === "RSD · ProductType") && info.raw.some(([key]) => key === "lockdown · DeviceName"));

    const layoutSession = fakeSession({
      request: (message) => {
        if (message.command === "getIconState") {
          return [
            [{ displayName: "电话", bundleIdentifier: "com.apple.mobilephone" }],
            [
              { displayName: "相机", bundleIdentifier: "com.apple.camera" },
              {
                displayName: "工具",
                listType: "folder",
                iconLists: [[{ displayName: "计算器", bundleIdentifier: "com.apple.calculator" }], [{ displayName: "相机", bundleIdentifier: "com.apple.camera" }]],
              },
              { iconType: "custom", gridSize: "small", containerBundleIdentifier: "com.apple.weather" },
              { displayName: "某网页", webClipIdentifier: "ABC" },
            ],
          ];
        }
        if (message.command === "getIconPNGData") {
          if (message.bundleId === "com.apple.calculator") return { Error: "NotFound" };
          return { pngData: new Uint8Array([137, 80, 78, 71]) };
        }
        return {};
      },
    });
    const layout = await readHomeLayout(layoutSession);
    check("第一项是 Dock", layout.dock.length === 1 && layout.dock[0].bundleId === "com.apple.mobilephone");
    check("文件夹识别并保留多页", layout.pages[0][1].kind === "folder" && layout.pages[0][1].pages?.length === 2);
    check("小组件与网页快捷方式", layout.pages[0][2].kind === "widget" && layout.pages[0][3].kind === "webclip");
    const ids = collectBundleIds(layout);
    check("bundle ID 摊平去重（含文件夹内）", ids.length === 3 && ids.includes("com.apple.calculator"), ids.join(","));
    const icons = await readIcons(layoutSession, ids);
    check("单个图标失败不影响其余", icons.size === 2 && !icons.has("com.apple.calculator"));
  }

  console.log("Dock 编辑");
  {
    const app = (id: string): PlistValue => ({ displayName: id, bundleIdentifier: id, iconModDate: "x" });
    const widget: PlistValue = { iconType: "custom", gridSize: "medium", elements: [{ bundleIdentifier: "w.inner" }] };
    const original: PlistValue = [
      [app("d1"), app("d2"), app("d3")],
      [widget, app("p1"), { displayName: "夹", listType: "folder", iconLists: [[app("f1")]] }],
      [app("q1")],
    ];
    const snapshot = JSON.stringify(original);
    const pages = (raw: PlistValue) => raw as PlistValue[][];

    const moved = moveInDock(original, 0, 2);
    check("Dock 内调顺序", dockKeys(moved).join(",") === "d2,d3,d1");
    check("原布局不被修改", JSON.stringify(original) === snapshot);

    check("越界报错", (await rejects(Promise.resolve().then(() => moveInDock(original, 0, 5)))) instanceof Error);

    const out = dockToPage(original, 1, 1);
    check(
      "从 Dock 移到第 2 页末尾",
      dockKeys(out).join(",") === "d1,d3" && JSON.stringify(pages(out)[2].slice(-1)[0]) === JSON.stringify(app("d2")),
    );

    check("小组件内部结构保留", JSON.stringify(pages(moved)[1][0]) === JSON.stringify(widget));
    check(
      "排列指纹：没改相同、改了不同",
      arrangementKey(clonePlist(original)) === arrangementKey(original) && arrangementKey(moved) !== arrangementKey(original),
    );

    const same = compareLayouts(moved, clonePlist(moved));
    check("核对：一致", same.dockMatches && same.nothingLost);
    const rejected = compareLayouts(moved, original);
    check("核对：设备没采纳时 Dock 不一致", !rejected.dockMatches && rejected.nothingLost);
    const lost = compareLayouts(original, [[app("d1")], [app("p1")]]);
    check("核对：能发现丢了哪些", !lost.nothingLost && lost.missing.includes("d2") && lost.missing.includes("f1"), lost.missing.join(","));
    check("非法布局拒绝修改", (await rejects(Promise.resolve().then(() => moveInDock({ a: 1 }, 0, 0)))) instanceof Error);
  }

  console.log("AI 整理");
  {
    const app = (id: string): PlistValue => ({ displayName: `名-${id}`, bundleIdentifier: id, iconModDate: "x" });
    const widget: PlistValue = { iconType: "custom", gridSize: "medium" };
    const oldFolder: PlistValue = { displayName: "旧夹", listType: "folder", iconLists: [[app("f1")]] };
    const page2 = Array.from({ length: 12 }, (_, i) => app(`s${i}`));
    const raw: PlistValue = [
      [app("d1")],
      [widget, app("p1")],
      [...page2, oldFolder, { displayName: "网页", webClipIdentifier: "W" }],
      [app("t1"), app("t2")],
    ];
    const snapshot = JSON.stringify(raw);

    const loose = collectLooseApps(raw, [1, 2]);
    check("只收选中页上散放的 App", loose.length === 14 && !loose.some((a) => a.bundleId === "p1" || a.bundleId === "f1"), String(loose.length));
    check("名称取自 displayName", loose[0].name === "名-s0");

    const ids = loose.map((a) => a.bundleId);
    const plan = sanitizePlan(
      {
        folders: [
          { name: "  社交与通讯（名字特别特别长超过上限）  ", bundleIds: ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "fake.app"] },
          { name: "社交与通讯（名字特别特别长超过上限）", bundleIds: ["s0", "t1"] },
          { name: "", bundleIds: ["ghost"] },
          { name: "影音", bundleIds: ["t2", 42] },
        ],
      },
      ids,
    );
    check("编造的 ID 丢掉并计数", plan.dropped === 2, String(plan.dropped));
    check("重复出现的 App 只认第一次", plan.folders[1].bundleIds.join(",") === "t1");
    check("同名文件夹自动加序号", plan.folders[0].name !== plan.folders[1].name);
    check("文件夹名限长", plan.folders.every((f) => f.name.length <= 14), plan.folders.map((f) => f.name).join("|"));
    check("全是编造 ID 的文件夹被丢掉", plan.folders.length === 3);
    check("没分到的 App 列为不动", plan.unassigned.join(",") === "s11");
    check("非对象输入不崩", sanitizePlan("乱七八糟", ids).folders.length === 0 && sanitizePlan(null, ids).unassigned.length === ids.length);

    const next = applyPlan(raw, [1, 2], plan.folders);
    const pagesOf = (value: PlistValue) => value as PlistValue[][];
    check("原布局不被修改", JSON.stringify(raw) === snapshot);
    check("Dock 不动", JSON.stringify(pagesOf(next)[0]) === JSON.stringify(pagesOf(raw)[0]));
    check("没选的页原样保留", JSON.stringify(pagesOf(next)[1]) === JSON.stringify(pagesOf(raw)[1]));
    const target = pagesOf(next)[2];
    check(
      "已有文件夹、网页快捷方式留在原页",
      target.some((item) => JSON.stringify(item) === JSON.stringify(oldFolder)) && target.some((item) => isPlistDict(item) && item.webClipIdentifier === "W"),
    );
    check("没分到的 App 留在原位", target.some((item) => isPlistDict(item) && item.bundleIdentifier === "s11"));
    const created = target.filter((item) => isPlistDict(item) && item.listType === "folder" && item.displayName !== "旧夹") as Record<string, PlistValue>[];
    check("新文件夹接在第一个选中页后面", created.length === 3, String(created.length));
    const big = created[0].iconLists as PlistValue[][];
    check("文件夹按 9 个一页分页", big.length === 2 && big[0].length === 9 && big[1].length === 2, big.map((p) => p.length).join(","));
    check("搬进文件夹的条目字段原样保留", JSON.stringify(big[0][0]) === JSON.stringify(app("s0")));
    check("收空的选中页被去掉", pagesOf(next).length === 3, String(pagesOf(next).length));
    const verdict = compareLayouts(next, next);
    check("新布局自己核对一致", verdict.nothingLost && verdict.dockMatches);
    const allBefore = new Set(collectLooseApps(raw, [0, 1, 2]).map((a) => a.bundleId));
    const allAfter = JSON.stringify(next);
    check("一个 App 都没少", [...allBefore, "f1", "p1", "d1"].every((id) => allAfter.includes(`"${id}"`)));
    check("没选页时拒绝执行", (await rejects(Promise.resolve().then(() => applyPlan(raw, [], plan.folders)))) instanceof Error);
  }

  console.log("按名称排序 / 对话解析");
  {
    const named = (id: string, name: string): PlistValue => ({ displayName: name, bundleIdentifier: id });
    const widget: PlistValue = { iconType: "custom", gridSize: "small" };
    const folder: PlistValue = { displayName: "夹", listType: "folder", iconLists: [[named("f", "里面")]] };
    const raw: PlistValue = [
      [named("dock", "电话")],
      [named("w", "微信"), widget, named("a", "Apple Store"), folder],
      [named("z", "支付宝"), named("b", "百度"), named("n9", "App 10"), named("n2", "App 2")],
    ];
    const sorted = sortLooseApps(raw, [0, 1]);
    const layout = sorted as PlistValue[][];
    const names = (page: PlistValue[]) => page.map((item) => (isPlistDict(item) ? item.displayName : ""));
    check("小组件、文件夹原地不动", JSON.stringify(layout[1][1]) === JSON.stringify(widget) && JSON.stringify(layout[1][3]) === JSON.stringify(folder));
    check("Dock 不动", JSON.stringify(layout[0]) === JSON.stringify((raw as PlistValue[][])[0]));
    check("每页格子数不变", layout[1].length === 4 && layout[2].length === 4);
    const order = [layout[1][0], layout[1][2], ...layout[2]].map((item) => (isPlistDict(item) ? item.displayName : ""));
    check("数字按数值、英文在前、中文按拼音", order.join(",") === "App 2,App 10,Apple Store,百度,微信,支付宝", order.join(","));
    const desc = sortLooseApps(raw, [0, 1], true) as PlistValue[][];
    check("倒序", (isPlistDict(desc[1][0]) ? desc[1][0].displayName : "") === "支付宝", String(names(desc[1])));
    check("一个都没少", JSON.stringify(sorted).match(/bundleIdentifier/g)?.length === JSON.stringify(raw).match(/bundleIdentifier/g)?.length);

    const g = parseReply({ reply: "分好了", action: "GROUP", folders: [{ name: "社交", bundleIds: ["w"] }], descending: false });
    check("action 大小写不敏感，带上方案", g.action === "group" && Array.isArray((g.rawPlan as { folders: unknown[] }).folders));
    const weird = parseReply({ reply: "", action: "delete_all" });
    check("不认识的 action 当 none，空回复兜底", weird.action === "none" && weird.rawPlan === null && weird.reply.length > 0);
    check("sort 带倒序标记", parseReply({ reply: "好", action: "sort", descending: true }).descending === true);
    check("非对象输入不崩", parseReply(null).action === "none");
    check("color 动作被认出", parseReply({ reply: "好", action: "color", descending: false }).action === "color");
  }

  console.log("按颜色排序");
  {
    const c = (red: number, green: number, blue: number, fraction: number) => ({ red, green, blue, fraction });
    const white = c(1, 1, 1, 0.7);

    const calendar = colorKey([white, c(0.95, 0.2, 0.2, 0.15)]);
    check("白底图标取次要的彩色", calendar?.chromatic === true && calendar.hex === "#f23333", calendar?.hex);
    const tinyAccent = colorKey([white, c(0.2, 0.4, 1, 0.03)]);
    check("占比太小的彩色不当代表色", tinyAccent?.chromatic === false);
    const gray = colorKey([c(0.5, 0.5, 0.5, 0.9)]);
    check("灰色算黑白灰", gray?.chromatic === false);
    const nearBlack = colorKey([c(0.05, 0.02, 0.08, 0.9)]);
    check("太暗的颜色算黑白灰", nearBlack?.chromatic === false);
    check("没取到图标返回 null", colorKey([]) === null);

    const keyOf = (r: number, g: number, b: number) => colorKey([c(r, g, b, 1)]);
    const rainbow = {
      red: keyOf(0.9, 0.1, 0.1),
      crimson: keyOf(0.95, 0.1, 0.22),
      pink: keyOf(0.95, 0.1, 0.35),
      orange: keyOf(1, 0.55, 0.1),
      yellow: keyOf(1, 0.85, 0.1),
      green: keyOf(0.2, 0.75, 0.3),
      cyan: keyOf(0.1, 0.75, 0.85),
      blue: keyOf(0.1, 0.4, 0.95),
      purple: keyOf(0.55, 0.25, 0.85),
      white: keyOf(0.98, 0.98, 0.98),
      black: keyOf(0.1, 0.1, 0.1),
    };
    const shuffled = Object.entries(rainbow).reverse();
    shuffled.push(["missing", null]);
    const order = shuffled.sort((a, b) => compareColorKeys(a[1], b[1])).map(([name]) => name);
    check(
      "彩虹顺序：345° 以上的红绕回最前，粉排在紫后，黑白灰在后（白在黑前），取不到的垫底",
      order.join(",") === "crimson,red,orange,yellow,green,cyan,blue,purple,pink,white,black,missing",
      order.join(","),
    );

    const named = (id: string): PlistValue => ({ displayName: id, bundleIdentifier: id });
    const widget: PlistValue = { iconType: "custom", gridSize: "small" };
    const raw: PlistValue = [[], [named("b"), widget, named("r"), named("g")]];
    const keys: Record<string, ReturnType<typeof colorKey>> = { r: rainbow.red, g: rainbow.green, b: rainbow.blue };
    const sorted = reorderLooseApps(raw, [0], (x, y) => compareColorKeys(keys[x.bundleId], keys[y.bundleId])) as PlistValue[][];
    const ids = sorted[1].map((item) => (isPlistDict(item) ? item.bundleIdentifier ?? "widget" : ""));
    check("按颜色重排只换 App 的格子，小组件原地", ids.join(",") === "r,widget,g,b", ids.join(","));
    const stable = reorderLooseApps(raw, [0], () => 0) as PlistValue[][];
    check("比较相等时保持原顺序", JSON.stringify(stable) === JSON.stringify(raw));
  }

  console.log("自定义提示词");
  {
    // Storage 是 Scripting 的全局对象，这里用一个内存版顶替
    const memory = new Map<string, unknown>();
    (globalThis as unknown as { Storage: unknown }).Storage = {
      get: (key: string) => (memory.has(key) ? memory.get(key) : null),
      set: (key: string, value: unknown) => (memory.set(key, value), true),
      remove: (key: string) => void memory.delete(key),
    };
    const apps = [{ page: 0, bundleId: "com.example.a", name: "甲" }];
    const history = [{ role: "user" as const, text: "整理一下" }];

    const byDefault = buildPrompt(apps, history, null);
    check("默认提示词里带风格段和固定规则", byDefault.startsWith(DEFAULT_STYLE_PROMPT) && byDefault.includes(FIXED_PROTOCOL));
    check("没改过时读到默认", loadStylePrompt() === DEFAULT_STYLE_PROMPT && !isCustomStylePrompt());

    saveStylePrompt("只分两个文件夹：工作和娱乐");
    check("保存后生效并标为自定义", loadStylePrompt() === "只分两个文件夹：工作和娱乐" && isCustomStylePrompt());
    const custom = buildPrompt(apps, history, null, loadStylePrompt());
    check("自定义只替换风格段", custom.startsWith("只分两个文件夹") && !custom.includes(DEFAULT_STYLE_PROMPT));
    check("固定规则永远在自定义段之后", custom.indexOf(FIXED_PROTOCOL) > custom.indexOf("只分两个文件夹"));
    check("App 列表和对话仍然带上", custom.includes("1 | 甲 | com.example.a | 第 1 页") && custom.includes("用户：整理一下"));

    saveStylePrompt("   ");
    check("存空白等于恢复默认", !isCustomStylePrompt() && loadStylePrompt() === DEFAULT_STYLE_PROMPT);
    saveStylePrompt(DEFAULT_STYLE_PROMPT);
    check("存一份和默认一样的不算自定义", !isCustomStylePrompt());
    saveStylePrompt("长".repeat(STYLE_PROMPT_LIMIT + 50));
    check("超长截断到上限", loadStylePrompt().length === STYLE_PROMPT_LIMIT);
    resetStylePrompt();
    check("恢复默认", !isCustomStylePrompt());
    check("风格段为空时用默认兜底", buildPrompt(apps, history, null, "  ").startsWith(DEFAULT_STYLE_PROMPT));
  }

  console.log("文件夹内部排序");
  {
    const named = (id: string, name: string): PlistValue => ({ displayName: name, bundleIdentifier: id });
    const folder: PlistValue = {
      displayName: "工具",
      listType: "folder",
      iconLists: [
        [named("z", "指南针"), named("j", "计算器"), { displayName: "网页", webClipIdentifier: "W" }],
        [named("a", "Apple Store"), named("b", "备忘录")],
      ],
    };
    const otherPageFolder: PlistValue = { displayName: "别页", listType: "folder", iconLists: [[named("y", "邮件"), named("c", "Clips")]] };
    const raw: PlistValue = [[], [named("w", "微信"), folder, named("q", "QQ")], [otherPageFolder]];

    const plain = sortLooseApps(raw, [0]) as PlistValue[][];
    check("默认不碰文件夹内部", JSON.stringify(plain[1][1]) === JSON.stringify(folder));

    const deep = sortLooseApps(raw, [0], false, true) as PlistValue[][];
    const inner = (deep[1][1] as Record<string, PlistValue>).iconLists as PlistValue[][];
    const names = inner.map((list) => list.map((item) => (isPlistDict(item) ? item.displayName : "")).join("/"));
    check("文件夹内跨页按名称排，每页个数不变，网页快捷方式原地", names.join(" | ") === "Apple Store/备忘录/网页 | 计算器/指南针", names.join(" | "));
    check("文件夹本身留在原格子", isPlistDict(deep[1][1]) && deep[1][1].displayName === "工具");
    check("散放 App 照样排", (deep[1][0] as Record<string, PlistValue>).displayName === "QQ" && (deep[1][2] as Record<string, PlistValue>).displayName === "微信");
    check("没选的页上的文件夹不动", JSON.stringify(deep[2]) === JSON.stringify((raw as PlistValue[][])[2]));
    check("文件夹里的 App 一个没少", JSON.stringify(deep).match(/bundleIdentifier/g)?.length === JSON.stringify(raw).match(/bundleIdentifier/g)?.length);

    const ids = collectFolderApps(raw, [0]).map((app) => app.bundleId).join(",");
    check("只收选中页文件夹里的 App（不含网页快捷方式）", ids === "z,j,a,b", ids);
  }

  console.log("应用管理 / 描述文件 / 电源");
  {
    type Message = Record<string, PlistValue>;
    /** 假会话：request 直接回一条；send 之后 receiveDict 依次吐出预置的几条。 */
    function scriptedSession(reply: (message: Message) => PlistValue | PlistValue[]) {
      const sent: Message[] = [];
      let queue: PlistValue[] = [];
      const client = {
        request: async (message: Message) => {
          sent.push(message);
          return reply(message) as Message;
        },
        send: async (message: Message) => {
          sent.push(message);
          const value = reply(message);
          queue = Array.isArray(value) ? [...value] : [value];
        },
        receiveDict: async () => {
          const next = queue.shift();
          if (next === undefined) throw new Error("没有更多回包");
          return next as Message;
        },
      };
      const session = {
        hasService: () => true,
        withService: async (_name: string, use: (c: typeof client) => Promise<unknown>) => use(client),
      } as unknown as DeviceSession;
      return { session, sent };
    }

    const APPLE = "Apple iPhone OS Application Signing";
    check("TestFlight：带 beta-reports-active（即使是 Apple 签名）", classifyApp({ SignerIdentity: APPLE, Entitlements: { "beta-reports-active": true } }) === "testFlight");
    check("App Store：Apple 签名", classifyApp({ SignerIdentity: APPLE, Entitlements: {} }) === "appStore");
    check("开发签：get-task-allow", classifyApp({ SignerIdentity: "Apple Development: someone", ProfileValidated: true, Entitlements: { "get-task-allow": true } }) === "development");
    check("企业 / Ad Hoc：分发证书", classifyApp({ SignerIdentity: "iPhone Distribution: Example Ltd" }) === "distribution");
    check("企业 / Ad Hoc：有描述文件但不可调试", classifyApp({ ProfileValidated: true, Entitlements: {} }) === "distribution");
    check("都对不上归为其他", classifyApp({}) === "other");

    const lookup: PlistValue = {
      "com.example.big": {
        CFBundleIdentifier: "com.example.big",
        CFBundleDisplayName: "微信",
        CFBundleShortVersionString: "8.0.50",
        CFBundleVersion: "8.0.50.1",
        StaticDiskUsage: 400_000_000,
        DynamicDiskUsage: 2_000_000_000,
        SignerIdentity: APPLE,
        Entitlements: { "application-identifier": "AAAA111111.com.example.big" },
      },
      "com.example.mid": {
        CFBundleName: "备忘录助手",
        CFBundleShortVersionString: "1.2",
        CFBundleVersion: "1.2",
        StaticDiskUsage: 50_000_000,
        DynamicDiskUsage: 1_000_000,
        SignerIdentity: "Apple Development: someone",
        Entitlements: { "application-identifier": "TEAM123456.com.example.mid", "get-task-allow": true },
      },
      "com.example.tiny": { StaticDiskUsage: 500_000, Entitlements: { "application-identifier": "TEAM123456.com.example.tiny", "get-task-allow": true } },
      broken: "不是字典",
    };
    const apps = parseApps(lookup);
    check("解析出 3 个 App，坏条目跳过", apps.length === 3, String(apps.length));
    check("默认按占用空间从大到小", apps.map((app) => app.bundleId).join(",") === "com.example.big,com.example.mid,com.example.tiny");
    check("名称回退：DisplayName → Name → Bundle ID", apps[1].name === "备忘录助手" && apps[2].name === "com.example.tiny");
    check("Team ID 从 application-identifier 前缀取", apps[1].teamId === "TEAM123456");
    check(
      "按名称排：中英混排按拼音首字母",
      sortApps(apps, "name").map((app) => app.name).join(",") === "备忘录助手,com.example.tiny,微信",
      sortApps(apps, "name").map((app) => app.name).join(","),
    );
    check("清单里版本带构建号", appListText(apps).includes("8.0.50（8.0.50.1）"));
    check("小于 1 MB 显示成 KB", formatBytes(500_000) === "500 KB");
    check("认得出 Scripting 自己", isScriptingItself({ ...apps[0], name: "Scripting" }) && !isScriptingItself(apps[0]));

    const appsCall = scriptedSession(() => ({ LookupResult: lookup, Status: "Complete" }));
    const read = await readApps(appsCall.session);
    const lookupSent = appsCall.sent[0];
    const options = isPlistDict(lookupSent.ClientOptions) ? lookupSent.ClientOptions : {};
    check("Lookup 只要用户 App", lookupSent.Command === "Lookup" && options.ApplicationType === "User" && read.length === 3);
    check(
      "列表的 Lookup 不要占用空间（真机上带着它十几秒不回包）",
      Array.isArray(options.ReturnAttributes) && options.ReturnAttributes.includes("Entitlements") && !options.ReturnAttributes.includes("StaticDiskUsage"),
    );

    // 占用空间：按 bundle ID 分组 Lookup，假设备按请求里的 BundleIDs 回大小
    const ids = Array.from({ length: 25 }, (_, index) => `com.example.app${index}`);
    const sizeReply = (message: Message): PlistValue => {
      const options = isPlistDict(message.ClientOptions) ? message.ClientOptions : {};
      const wanted = Array.isArray(options.BundleIDs) ? (options.BundleIDs as string[]) : [];
      const result: Message = {};
      for (const id of wanted) result[id] = id.endsWith("7") ? { StaticDiskUsage: 1000 } : { StaticDiskUsage: 1000, DynamicDiskUsage: 2000 };
      return { Status: "Complete", LookupResult: result };
    };
    const sizeCall = scriptedSession(sizeReply);
    const merged = new Map<string, AppSizes>();
    const progress2: number[] = [];
    await readAppSizes(sizeCall.session, ids, (batch, done) => {
      progress2.push(done);
      for (const [id, size] of batch) merged.set(id, size);
    });
    const firstOptions = isPlistDict(sizeCall.sent[0].ClientOptions) ? sizeCall.sent[0].ClientOptions : {};
    check(
      "每组最多 10 个 bundle ID，只要大小",
      sizeCall.sent.length === 3 &&
        Array.isArray(firstOptions.BundleIDs) && firstOptions.BundleIDs.length === 10 &&
        Array.isArray(firstOptions.ReturnAttributes) && firstOptions.ReturnAttributes.includes("DynamicDiskUsage"),
    );
    check("25 个全部拿到，进度最后到 25", merged.size === 25 && progress2[progress2.length - 1] === 25, `${merged.size} / ${progress2.join(",")}`);
    check("缺的字段记 null", merged.get("com.example.app7")?.dataSize === null && merged.get("com.example.app8")?.dataSize === 2000);
    check("没取到大小的 App 原样保留", withSizes(apps[0], undefined) === apps[0]);

    let calls = 0;
    const flaky = scriptedSession((message) => {
      calls++;
      if (calls === 1) throw new Error("第一组失败");
      return sizeReply(message);
    });
    const flakyMerged = new Map<string, AppSizes>();
    const flakyError = await rejects(
      readAppSizes(flaky.session, ids, (batch) => batch.forEach((size, id) => flakyMerged.set(id, size))),
    );
    check("一路出错，另一路照样做完再报错", flakyError instanceof Error && flakyMerged.size === 15, String(flakyMerged.size));

    const cached = new Map<string, AppSizes>([["com.a", { appSize: 1, dataSize: null }]]);
    saveSizeCache(cached, 1000);
    const loaded = loadSizeCache();
    check("缓存存取往返", loaded?.savedAt === 1000 && loaded.sizes.get("com.a")?.appSize === 1 && loaded.sizes.get("com.a")?.dataSize === null);
    check("几分钟前 / 几小时前 / 几天前", formatAge(30_000) === "刚刚" && formatAge(180_000) === "3 分钟前" && formatAge(7_200_000) === "2 小时前" && formatAge(3 * 86_400_000) === "3 天前");
    check("没有 LookupResult 抛错", (await rejects(readApps(scriptedSession(() => ({ Status: "Complete" })).session))) instanceof Error);

    const progress: number[] = [];
    const uninstallCall = scriptedSession(() => [
      { Status: "RemovingApplication", PercentComplete: 40 },
      { Status: "RemovingApplication", PercentComplete: 90 },
      { Status: "Complete" },
    ]);
    await uninstallApp(uninstallCall.session, "com.example.mid", (percent) => progress.push(percent));
    check("卸载命令带 Bundle ID", uninstallCall.sent[0].Command === "Uninstall" && uninstallCall.sent[0].ApplicationIdentifier === "com.example.mid");
    check("卸载进度依次回报，Complete 收尾", progress.join(",") === "40,90");
    const uninstallError = await rejects(
      uninstallApp(scriptedSession(() => [{ PercentComplete: 10 }, { ErrorDescription: "设备拒绝" }]).session, "x"),
    );
    check("ErrorDescription 转成异常", uninstallError instanceof Error && uninstallError.message === "设备拒绝");

    // 描述文件：真实的是 CMS 签名的 DER，这里用前后夹乱码的 XML 模拟
    const profileXml = (extra: string, expires: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Name</key><string>iOS Team Provisioning Profile: 测试</string>
  <key>AppIDName</key><string>测试 App</string>
  <key>TeamName</key><string>Example Team</string>
  <key>TeamIdentifier</key><array><string>TEAM123456</string></array>
  <key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
  <key>CreationDate</key><date>2026-10-10T00:00:00Z</date>
  <key>ExpirationDate</key><date>${expires}</date>
  ${extra}
</dict></plist>`;
    const wrap = (xml: string) => {
      const body = utf8(xml);
      const out = new Uint8Array(body.length + 64);
      out.fill(0x30, 0, 32); // 冒充 DER 头
      out.set(body, 32);
      out.fill(0xa0, 32 + body.length); // 冒充签名尾巴
      return out;
    };
    const devXml = profileXml(
      "<key>Entitlements</key><dict><key>application-identifier</key><string>TEAM123456.*</string><key>get-task-allow</key><true/></dict><key>ProvisionedDevices</key><array><string>a</string><string>b</string></array>",
      "2026-10-20T00:00:00Z",
    );
    const devDict = extractProfilePlist(wrap(devXml));
    check("从 CMS 包里取出内嵌 plist", devDict !== null && devDict.Name === "iOS Team Provisioning Profile: 测试");
    check("取不到 plist 返回 null", extractProfilePlist(new Uint8Array([1, 2, 3, 60, 63])) === null);
    const dev = parseProfile(devDict!);
    check("开发描述文件：类型、设备数、Team", dev.kind === "development" && dev.deviceCount === 2 && dev.teamId === "TEAM123456");
    check("到期时间读成 ISO 字符串", dev.expires === "2026-10-20T00:00:00Z");
    const enterprise = parseProfile({ ProvisionsAllDevices: true, Entitlements: {} });
    check("企业描述文件：不限设备", enterprise.kind === "enterprise" && enterprise.deviceCount === null);
    check("Ad Hoc：限定设备、不可调试", parseProfile({ ProvisionedDevices: ["a"], Entitlements: {} }).kind === "adHoc");

    const now = Date.parse("2026-10-17T12:00:00Z");
    const hours = (value: number) => new Date(now + value * 3600000).toISOString();
    check("还剩 3 天算快到期", expiryState(hours(72), now).level === "soon" && expiryState(hours(72), now).text === "还剩 3 天");
    check("还剩 10 天算正常", expiryState(hours(240), now).level === "ok");
    check("不到 1 天显示小时", expiryState(hours(5), now).text === "5 小时后到期");
    check("过期 2.5 天", expiryState(hours(-60), now).level === "expired" && expiryState(hours(-60), now).text === "已过期 2 天");
    check("过期不到 1 天", expiryState(hours(-1), now).text === "今天已过期");
    check("没有到期时间", expiryState(null, now).level === "unknown");

    const exact = parseProfile({ Entitlements: { "application-identifier": "TEAM123456.com.example.mid" } });
    check("精确 App ID 只对上一个", appsForProfile(exact, apps).map((app) => app.bundleId).join(",") === "com.example.mid");
    check(
      "通配 App ID 对上同团队的自签 App",
      appsForProfile(dev, apps).map((app) => app.bundleId).join(",") === "com.example.mid,com.example.tiny",
    );
    const storeWildcard = parseProfile({ Entitlements: { "application-identifier": "AAAA111111.*" } });
    check("App Store 的 App 不算在描述文件头上", appsForProfile(storeWildcard, apps).length === 0);
    check(
      "按到期从早到晚，没有到期时间的放最后",
      sortProfiles([enterprise, dev]).map((profile) => profile.kind).join(",") === "development,enterprise",
    );

    const laterXml = profileXml("<key>ProvisionsAllDevices</key><true/>", "2027-01-01T00:00:00Z");
    const profilesCall = scriptedSession(() => ({ Payload: [wrap(laterXml), new Uint8Array([9, 9, 9]), wrap(devXml)], Status: 0 }));
    const profiles = await readProfiles(profilesCall.session);
    check("CopyAll 请求格式", profilesCall.sent[0].MessageType === "CopyAll" && profilesCall.sent[0].ProfileType === "Provisioning");
    check("坏的一段跳过，其余按到期排好", profiles.map((profile) => profile.kind).join(",") === "development,enterprise");

    const removeCall = scriptedSession(() => ({ Status: 0 }));
    await removeProfile(removeCall.session, dev.uuid);
    check("Remove 带 UUID", removeCall.sent[0].MessageType === "Remove" && removeCall.sent[0].ProfileID === dev.uuid);
    check("Status 非 0 抛错", (await rejects(removeProfile(scriptedSession(() => ({ Status: 1 })).session, "x"))) instanceof Error);

    const notices: boolean[] = [];
    const unsubscribe = deviceHub.subscribe((connected) => notices.push(connected));
    await deviceHub.disconnect();
    check("没有会话时断开不发通知", notices.length === 0);
    unsubscribe();
    check("取消订阅返回的是函数且可重复调用", (unsubscribe(), true));

    const powerCall = scriptedSession(() => ({ Status: "Success" }));
    await powerAction(powerCall.session, "Restart");
    check("重启命令", powerCall.sent[0].Request === "Restart");
    check("设备没回 Success 抛错", (await rejects(powerAction(scriptedSession(() => ({ Status: "Failure" })).session, "Sleep"))) instanceof Error);
  }

  console.log("充电曲线 / 电池实时卡片");
  {
    const report = (patch: Partial<BatteryReport>): BatteryReport =>
      ({
        powerW: 18.5,
        amperageMA: 1530,
        temperatureC: 36.2,
        chargePercent: 62,
        healthPercent: 102.4,
        isCharging: true,
        externalConnected: true,
        fullyCharged: false,
        charger: { watts: 20, name: null, isWireless: false },
        ...patch,
      }) as BatteryReport;

    let samples: CurveSample[] = [];
    for (let i = 0; i < CURVE_LIMIT + 5; i++) samples = appendSample(samples, report({ powerW: i }), i * 2000);
    check("曲线最多留 CURVE_LIMIT 个点，丢最早的", samples.length === CURVE_LIMIT && samples[0].powerW === 5);

    const few = [
      appendSample([], report({ powerW: 10, temperatureC: null }), 0)[0],
      appendSample([], report({ powerW: null, temperatureC: 37 }), 2000)[0],
      appendSample([], report({ powerW: 20, temperatureC: 39 }), 64000)[0],
    ];
    check("缺值的点不画", curveMarks(few, "power").length === 2 && curveMarks(few, "temperature").length === 2);
    const summary = curveSummary(few, "power");
    check("最低 / 最高 / 当前 / 时长", summary?.min === 10 && summary.max === 20 && summary.latest === 20 && summary.spanMs === 64000);
    check("没数据时没有统计", curveSummary([], "charge") === null);
    check("时长说法", formatSpan(45_000) === "45 秒" && formatSpan(200_000) === "3 分 20 秒" && formatSpan(3_900_000) === "1 小时 5 分");
    check("数值带单位和位数", formatMetric(18.46, "power") === "18.5 W" && formatMetric(1530.4, "current") === "1530 mA");
    const noTemperature = appendSample([], report({ temperatureC: null }), 0);
    check("设备不给温度时不放「温度」选项", !availableMetrics(noTemperature, null).includes("temperature") && availableMetrics(noTemperature, null).length === 3);
    check("有温度时四项都在", availableMetrics(noTemperature, 36.5).length === 4 && availableMetrics(few, null).includes("temperature"));

    let history: number[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) history = pushHistory(history, i);
    check("柱状图最多留 HISTORY_LIMIT 个点", history.length === HISTORY_LIMIT && history[0] === 3);
    check("缺值不进柱状图", pushHistory([1], null).length === 1);

    const state = cardState(report({}), [5, 10], 1000);
    check("卡片健康度和系统一样封顶 100", state.healthPercent === 100);
    check("充电器功率带上", state.adapterW === 20 && state.pluggedIn && state.charging);
    check("状态文字：充电中 / 已充满 / 接电不充 / 放电中",
      statusText(state) === "充电中" &&
        statusText({ ...state, fullyCharged: true }) === "已充满" &&
        statusText({ ...state, charging: false }) === "已接电源，暂停充电" &&
        statusText({ ...state, charging: false, pluggedIn: false }) === "放电中");
    check("收起态：插着电显示功率，没插电显示电量",
      compactText(state) === "18.5 W" && compactText({ ...state, charging: false, pluggedIn: false }) === "62%");
    check("色档：温度优先",
      cardTone({ ...state, temperatureC: 43 }) === "hot" &&
        cardTone({ ...state, temperatureC: 39 }) === "warm" &&
        cardTone(state) === "charging" &&
        cardTone({ ...state, charging: false, pluggedIn: false }) === "idle");
    const heights = sparkHeights([0, 5, -10]);
    check("柱高按最低到最高归一，负数取绝对值", heights[2] === 1 && heights[0] === 0.15 && Math.abs(heights[1] - 0.575) < 1e-9, heights.join(","));
    check("功率稳定（波动不到 5%）时是一排齐平的半高柱子，不再像进度条", sparkHeights([8.3, 8.3, 8.32]).every((value) => value === 0.5));
    check("全是 0 时都是细线", sparkHeights([0, 0]).every((value) => value === 0.05));
    check("没有点时没有柱子", sparkHeights([]).length === 0);
    check("开卡时插着电，拔线才收", shouldEndOnUnplug(true, report({ externalConnected: false })) && !shouldEndOnUnplug(true, report({})));
    check("开卡时没插电，拔插都不收", !shouldEndOnUnplug(false, report({ externalConnected: false })));
  }

  console.log("写回布局的小组件排查");
  {
    const layoutBefore: PlistValue = [
      [{ bundleIdentifier: "a", displayName: "A", iconModDate: new PReal(1.7e12) }],
      [
        { iconType: "custom", gridSize: "medium", widgetIdentifier: "w1", uniqueIdentifier: "U-1" },
        { elementType: "stack", gridSize: "small", elements: [{ iconType: "custom", gridSize: "small", widgetIdentifier: "w2", uniqueIdentifier: "U-2" }] },
        { bundleIdentifier: "b", big: 2 ** 60 },
      ],
    ];
    check("小组件（含叠放里的）都能找出来", widgetEntries(layoutBefore).length === 3);
    const suspicious = suspiciousValues(layoutBefore);
    check("像毫秒时间戳的浮点数和超大整数都会被列出", suspicious.some((line) => line.includes("iconModDate")) && suspicious.some((line) => line.includes("big")));
    const layoutAfter = clonePlist(layoutBefore) as PlistValue[][];
    ((layoutAfter[1][0] as Record<string, PlistValue>).uniqueIdentifier) = "U-9";
    const diff = widgetDiff(layoutBefore, layoutAfter);
    check("写入后小组件标识变了能看出来", diff[0] === "小组件 3 → 3 个" && diff.some((line) => line.includes("uniqueIdentifier: U-1 → U-9")), diff.join(" | "));
    check("没变就只有一行个数", widgetDiff(layoutBefore, clonePlist(layoutBefore)).length === 1);

    // 照用户导出的真机布局的形状（ID 换成编的）：叠放里每个小组件有 uniqueIdentifier，单独摆放的没有
    const stack: PlistValue = {
      iconType: "custom",
      gridSize: "small",
      displayIdentifier: "STACK-0001",
      userSelectedElementIdentifier: "ELEM-0001",
      iconLists: [],
      elements: [
        { elementType: "widget", widgetIdentifier: "com.apple.weather", uniqueIdentifier: "ELEM-0001", bundleIdentifier: "com.apple.weather.widget" },
        { elementType: "widget", widgetIdentifier: "com.apple.Maps", uniqueIdentifier: "ELEM-0002", bundleIdentifier: "com.apple.Maps.GeneralMapsWidget" },
      ],
    };
    const lone: PlistValue = {
      iconType: "custom",
      elementType: "widget",
      widgetIdentifier: "RunScript",
      containerBundleIdentifier: "com.scripting.ios",
      bundleIdentifier: "com.scripting.ios.WidgetExtension",
      displayIdentifier: "LONE-0001",
      userSelectedElementIdentifier: "ELEM-0009",
      gridSize: "small",
      iconLists: [],
    };
    const already: PlistValue = { ...(lone as Record<string, PlistValue>), uniqueIdentifier: "KEEP-ME", userSelectedElementIdentifier: "ELEM-0010" };
    const app: PlistValue = { bundleIdentifier: "com.example.app", displayName: "App", iconModDate: new PReal(1.7e12) };
    const original: PlistValue = [[app], [stack, lone], [already]];
    const snapshot = JSON.stringify(original);
    const { layout: prepared, patched } = withWidgetIdentifiers(original);
    const pages = prepared as Record<string, PlistValue>[][];
    check("单独摆放的小组件补上 uniqueIdentifier = userSelectedElementIdentifier", pages[1][1].uniqueIdentifier === "ELEM-0009");
    check("只补了缺的那一个", patched === 1);
    check("叠放本身不加，叠放里的小组件原样", pages[1][0].uniqueIdentifier === undefined && JSON.stringify(pages[1][0]) === JSON.stringify(stack));
    check("已经有 uniqueIdentifier 的不改", pages[2][0].uniqueIdentifier === "KEEP-ME");
    check("App 条目原样，日期等字段保留", JSON.stringify(pages[0][0]) === JSON.stringify(app));
    check("传进来的原始布局一个字段都没动", JSON.stringify(original) === snapshot);
    check("条目标识不受影响，写后核对照常", allKeys(prepared).join(",") === allKeys(original).join(","));
  }

  console.log("解散文件夹 + 按颜色建文件夹");
  {
    const keyOf = (red: number, green: number, blue: number) => colorKey([{ red, green, blue, fraction: 1 }]);
    const buckets = [
      colorBucket(keyOf(1, 0, 0)),
      colorBucket(keyOf(1, 0.55, 0)),
      colorBucket(keyOf(1, 0.9, 0)),
      colorBucket(keyOf(0, 0.8, 0.2)),
      colorBucket(keyOf(0, 0.8, 0.8)),
      colorBucket(keyOf(0, 0.4, 1)),
      colorBucket(keyOf(0.6, 0.2, 1)),
      colorBucket(keyOf(1, 0.2, 0.6)),
    ];
    check("八种彩色各归各组", buckets.join(",") === "红色,橙色,黄色,绿色,青色,蓝色,紫色,粉色", buckets.join(","));
    check("偏紫的红也算红", colorBucket(keyOf(1, 0, 0.15)) === "红色");
    check("白色归黑白灰，取不到颜色不归组", colorBucket(keyOf(1, 1, 1)) === "黑白灰" && colorBucket(null) === null);

    const app = (id: string): PlistValue => ({ bundleIdentifier: id, displayName: id });
    const ids = (items: PlistValue[]) => items.map((item) => (isPlistDict(item) ? (item.bundleIdentifier ?? item.displayName ?? "?") : "?")).join(",");
    const raw: PlistValue = [
      [app("dock1")],
      [app("p1a")],
      [app("r1"), { listType: "folder", displayName: "旧文件夹", iconLists: [[app("r2"), app("b1")], [app("b2")]] }, app("g1"), app("x1"), { iconType: "custom", gridSize: "small", elementType: "widget" }],
    ];
    const dissolved = dissolveFolders(raw, [1]);
    const page2 = (dissolved.layout as PlistValue[][])[2];
    check("拆文件夹：里面的东西按原顺序放回原位", ids(page2.slice(0, 5)) === "r1,r2,b1,b2,g1", ids(page2));
    check("拆了 1 个，放出 3 个", dissolved.folders === 1 && dissolved.released === 3);
    check("没选的页和 Dock 不动", ids((dissolved.layout as PlistValue[][])[1]) === "p1a" && ids((dissolved.layout as PlistValue[][])[0]) === "dock1");
    check("原布局不变", JSON.stringify(raw).includes("旧文件夹"));

    const bucketOf = (id: string) =>
      id.startsWith("r") ? "红色" : id.startsWith("b") ? "蓝色" : id.startsWith("g") ? "绿色" : null;
    const result = colorFolderLayout(raw, [1], bucketOf, { dissolve: true, order: COLOR_BUCKETS });
    check("按组建文件夹，按给定顺序", result.plan.map((folder) => `${folder.name}:${folder.bundleIds.join("+")}`).join(" | ") === "红色:r1+r2 | 蓝色:b1+b2");
    check("同色只有 1 个、取不到颜色的留在原位", result.leftLoose === 2);
    const after = (result.layout as PlistValue[][])[2];
    const folderNames = after.filter((item) => isPlistDict(item) && item.listType === "folder").map((item) => (item as Record<string, PlistValue>).displayName);
    check("页上是新的两个文件夹，旧文件夹没了", folderNames.join(",") === "红色,蓝色", folderNames.join(","));
    check("留下的 App 和小组件还在页上", ids(after).includes("g1") && ids(after).includes("x1") && after.some((item) => isPlistDict(item) && item.gridSize === "small"));
    check("Dock 不动", ids((result.layout as PlistValue[][])[0]) === "dock1");

    const kept = colorFolderLayout(raw, [1], bucketOf, { dissolve: false, order: COLOR_BUCKETS });
    const keptNames = (kept.layout as PlistValue[][])[2]
      .filter((item) => isPlistDict(item) && item.listType === "folder")
      .map((item) => (item as Record<string, PlistValue>).displayName);
    check("不拆时已有文件夹不动，里面的 App 不参与", kept.dissolved === 0 && kept.plan.length === 0 && keptNames.join(",") === "旧文件夹");

    const parsed = parseReply({ reply: "好", action: "colorFolders", descending: false, dissolveFolders: true, folders: [] });
    check("认得 colorFolders，带上「解散」开关", parsed.action === "colorFolders" && parsed.dissolveFolders);
    check("别的动作就算填了 dissolveFolders 也不当真", !parseReply({ reply: "好", action: "color", dissolveFolders: true }).dissolveFolders);
    check("提示词里告诉 AI 文件夹里还有多少个", buildPrompt([], [{ role: "user", text: "整理" }], null, DEFAULT_STYLE_PROMPT, 207).includes("207 个 App"));
    check("固定规则里写了 colorFolders", FIXED_PROTOCOL.includes("colorFolders"));
  }

  console.log("AI 方案用编号 + 页码");
  {
    const listed = [
      { page: 1, bundleId: "com.tencent.xin", name: "微信" },
      { page: 1, bundleId: "com.tencent.mqq", name: "QQ" },
      { page: 3, bundleId: "com.netease.music", name: "网易云音乐" },
    ];
    const prompt = buildPrompt(listed, [{ role: "user", text: "只整理第二页" }], null);
    check("列表每行带编号、名称、bundle ID、页码", prompt.includes("1 | 微信 | com.tencent.xin | 第 2 页") && prompt.includes("3 | 网易云音乐 | com.netease.music | 第 4 页"));
    check("固定规则讲了编号和按页整理", FIXED_PROTOCOL.includes("编号") && FIXED_PROTOCOL.includes("只把那几页的 App 放进文件夹"));

    const resolved = resolvePlan({ folders: [{ name: "社交", apps: [1, "2", 99] }, { name: "音乐", apps: [3] }] }, listed);
    check("编号换回 bundle ID，数字字符串也认", resolved.folders[0].bundleIds.slice(0, 2).join(",") === "com.tencent.xin,com.tencent.mqq" && resolved.folders[1].bundleIds[0] === "com.netease.music");
    const cleaned = sanitizePlan(resolved, listed.map((app) => app.bundleId));
    check("超出范围的编号被丢掉并计数", cleaned.dropped === 1 && cleaned.folders[0].bundleIds.length === 2);
    check("模型还回 bundle ID 字符串也照常校验", resolvePlan({ folders: [{ name: "旧", bundleIds: ["com.tencent.xin"] }] }, listed).folders[0].bundleIds[0] === "com.tencent.xin");
    check("没有 folders 时给空方案", resolvePlan(null, listed).folders.length === 0);

    check("超出输出上限给中文提示", organizerErrorText(new Error("Response exceeded the output token limit.")).includes("少选几页"));
    check("别的错误照原样带上", organizerErrorText(new Error("-1009 离线")).startsWith("没连上 AI："));
    check(
      "重试原因分得清超时、断线、离线",
      transientReason(new Error("The request timed out. (-1001)")) === "请求超时" &&
        transientReason(new Error("The network connection was lost. (-1005)")) === "连接中断" &&
        transientReason(new Error("-1009")) === "没有网络" &&
        transientReason(new Error("network weird")) === "网络出错",
    );
  }

  console.log("App Store 链接");
  {
    check("地区：先本机再美区", countriesFor("zh_CN").join(",") === "cn,us" && countriesFor("en_US").join(",") === "us");
    check("没有地区的 locale 只查美区", countriesFor("zh-Hans").join(",") === "us");
    check("一次查多个用逗号连", lookupUrl(["com.a", "com.b"], "cn") === "https://itunes.apple.com/lookup?bundleId=com.a,com.b&country=cn&entity=software");

    // 照真机返回的形状（2026-10-18 实测），字段只留用得到的
    const sample = {
      resultCount: 3,
      results: [
        { bundleId: "com.tencent.xin", trackName: "微信", primaryGenreName: "Social Networking", trackViewUrl: "https://apps.apple.com/cn/app/%E5%BE%AE%E4%BF%A1/id414478124?uo=4" },
        { bundleId: "com.netease.cloudmusic", trackName: "网易云音乐", primaryGenreName: "Music", trackViewUrl: "https://apps.apple.com/cn/app/x/id590338362?uo=4" },
        { trackName: "缺 bundleId 的条目" },
      ],
    };
    const parsedLinks = parseLookup(sample, "cn");
    check("解析：按 bundle ID 对上，缺字段的丢掉", parsedLinks.size === 2 && parsedLinks.get("com.tencent.xin")?.name === "微信");
    check("链接去掉统计参数", parsedLinks.get("com.tencent.xin")?.url === "https://apps.apple.com/cn/app/%E5%BE%AE%E4%BF%A1/id414478124");
    check("分类翻成中文，不认识的原样", parsedLinks.get("com.netease.cloudmusic")?.genre === "音乐" && genreName("Something New") === "Something New");
    check("返回不是对象也不崩", parseLookup(null, "cn").size === 0);

    clearStoreLinkCache();
    const requested: string[] = [];
    const many = Array.from({ length: 60 }, (_, index) => `com.app${index}`);
    const fakeFetcher = async (url: string) => {
      requested.push(url);
      const country = /country=(\w+)/.exec(url)![1];
      const ids = /bundleId=([^&]+)/.exec(url)![1].split(",");
      // 国区只有偶数号，美区再补上 1 号
      const hit = ids.filter((id) => (country === "cn" ? Number(id.slice(7)) % 2 === 0 : id === "com.app1"));
      return { results: hit.map((id) => ({ bundleId: id, trackName: id, primaryGenreName: "Utilities", trackViewUrl: `https://apps.apple.com/${country}/app/${id}?uo=4` })) };
    };
    const found = await findStoreLinks(many, { locale: "zh_CN", fetcher: fakeFetcher });
    check("按 50 个一批：国区 2 次，剩下的美区 1 次", requested.filter((url) => url.includes("country=cn")).length === 2 && requested.filter((url) => url.includes("country=us")).length === 1, requested.length.toString());
    check("国区查不到的再查美区", found.get("com.app1")?.country === "us" && found.get("com.app2")?.country === "cn");
    check("哪儿都没有的不在结果里", !found.has("com.app3") && found.size === 31, String(found.size));
    const before = requested.length;
    const again = await findStoreLinks(["com.app2", "com.app3"], { locale: "zh_CN", fetcher: fakeFetcher });
    check("查过的走缓存，不再发请求（查不到的也记住）", requested.length === before && again.has("com.app2") && !again.has("com.app3"));

    const text = shareText([
      { name: "微信", link: parsedLinks.get("com.tencent.xin")! },
      { name: "网易云", link: parsedLinks.get("com.netease.cloudmusic")! },
    ]);
    check("文字清单按分类分组", text.startsWith("【社交】\n微信  https://apps.apple.com/") && text.includes("\n\n【音乐】\n网易云  "));
  }

  console.log("AI 流式请求");
  {
    const plan = '{"reply":"好","action":"group","descending":false,"dissolveFolders":false,"folders":[{"name":"代理工具","apps":[1,2]}]}';
    check("纯 JSON", (extractJson(plan) as Record<string, unknown>).action === "group");
    check("代码块包着、前后多了话也能抠出来", (extractJson(`好的，方案如下：\n\`\`\`json\n${plan}\n\`\`\`\n希望有帮助`) as Record<string, unknown>).reply === "好");
    check("不是 JSON 抛格式错误", (await rejects(Promise.resolve().then(() => extractJson("我不知道")))) instanceof ReplyFormatError);
    check("超时的提示建议少选几页", organizerErrorText(new Error("AI 超过 90 秒没有动静")).includes("少选几页"));

    const listedApps = [
      { page: 1, bundleId: "com.v2ray", name: "V2Box" },
      { page: 1, bundleId: "com.surge", name: "Surge" },
    ];
    const streamOf = (chunks: { type: string; content: string }[]) =>
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    let calls = 0;
    (globalThis as unknown as { Assistant: unknown }).Assistant = {
      isAvailable: true,
      requestStreaming: async () => {
        calls++;
        // 第一次回一句不是 JSON 的话，第二次才给方案：考验重试
        return calls === 1
          ? streamOf([{ type: "text", content: "嗯……" }])
          : streamOf([
              { type: "reasoning", content: "先找代理类的" },
              { type: "text", content: plan.slice(0, 40) },
              { type: "text", content: plan.slice(40) },
            ]);
      },
    };
    const retries: string[] = [];
    const progress: number[] = [];
    const answer = await askOrganizer(listedApps, [{ role: "user", text: "把代理工具放一个文件夹" }], null, null, {
      onRetry: (_, reason) => retries.push(reason),
      onProgress: ({ textChars, reasoningChars }) => progress.push(textChars + reasoningChars),
    });
    check("流式收完拼起来解析出方案", answer.action === "group" && sanitizePlan(resolvePlan(answer.rawPlan, listedApps), listedApps.map((app) => app.bundleId)).folders[0].bundleIds.length === 2);
    check("格式不对时重试一次，提示说清原因", calls === 2 && retries.join(",") === "回复格式不对");
    check("有进度回报", progress.length > 0);

    // 一直不来数据的流：点「停止等待」应该立刻结束，而且算停止、不算出错
    (globalThis as unknown as { Assistant: unknown }).Assistant = {
      isAvailable: true,
      requestStreaming: async () => new ReadableStream({ pull: () => new Promise<void>(() => {}) }),
    };
    const control: AskControl = {};
    const pending = askOrganizer(listedApps, [{ role: "user", text: "整理" }], null, null, { control });
    await new Promise((resolve) => setTimeout(resolve, 50));
    control.cancel?.();
    const stopped = await rejects(pending);
    check("停止等待：抛 StoppedError，不重试", stopped instanceof StoppedError);
    check("固定规则里写了只放用户要的那一类", FIXED_PROTOCOL.includes("只放那一类"));
    check("输出格式要求只给 JSON", OUTPUT_FORMAT.includes("只输出一个 JSON 对象"));
  }

  console.log("底层查询 / App 配置");
  {
    type Message = Record<string, PlistValue>;
    function serviceSession(reply: (message: Message) => PlistValue) {
      const sent: Message[] = [];
      const client = {
        request: async (message: Message) => {
          sent.push(message);
          return reply(message) as Message;
        },
        send: async (message: Message) => void sent.push(message),
      };
      const session = {
        hasService: () => true,
        withService: async (_name: string, use: (c: typeof client) => Promise<unknown>) => use(client),
      } as unknown as DeviceSession;
      return { session, sent };
    }

    check("键名校验：挡住空格和标点", isGestaltKey("ProductType") && isGestaltKey("Device-Supports_X") && !isGestaltKey("Product Type") && !isGestaltKey("1Bad") && !isGestaltKey(""));

    const gestaltCall = serviceSession(() => ({
      Status: "Success",
      Diagnostics: { MobileGestalt: { ProductType: "iPhone16,2", MainScreenScale: 3, Status: "Success" } },
    }));
    const gestalt = await readMobileGestalt(gestaltCall.session, ["ProductType", "MainScreenScale", "NotAKey", "bad key"]);
    check("请求格式照 idevice：MobileGestaltKeys", gestaltCall.sent[0].Request === "MobileGestalt" && Array.isArray(gestaltCall.sent[0].MobileGestaltKeys));
    check("非法键名不发出去", (gestaltCall.sent[0].MobileGestaltKeys as string[]).join(",") === "ProductType,MainScreenScale,NotAKey");
    check("取 Diagnostics.MobileGestalt，回包里的 Status 不算结果", gestalt.size === 2 && gestalt.get("ProductType") === "iPhone16,2" && !gestalt.has("Status"));
    check("设备没给的键不出现", !gestalt.has("NotAKey"));
    check("查完发 Goodbye", gestaltCall.sent.some((message) => message.Request === "Goodbye"));
    const flatGestalt = serviceSession(() => ({ Status: "Success", Diagnostics: { ProductType: "iPhone16,2" } }));
    check("个别系统直接放在 Diagnostics 下也认", (await readMobileGestalt(flatGestalt.session, ["ProductType"])).get("ProductType") === "iPhone16,2");
    check("设备拒绝时抛错", (await rejects(readMobileGestalt(serviceSession(() => ({ Status: "Failure" })).session, ["ProductType"]))) instanceof Error);
    check("没有合法键时不发请求", (await readMobileGestalt(serviceSession(() => ({})).session, ["bad key"])).size === 0);

    // 开发者磁盘镜像：先问 Personalized，没有再问 Developer
    const ddiCall = serviceSession((message) =>
      message.Command === "LookupImage"
        ? message.ImageType === "Personalized"
          ? { ImageSignature: [] }
          : { ImageSignature: [new Uint8Array(128)] }
        : { DeveloperModeStatus: true },
    );
    const status = await readImageStatus(ddiCall.session);
    check("两种镜像类型都问，取有签名的那个", status.mounted === "Developer" && status.signatureBytes === 128);
    check("开发者模式状态读出来", status.developerMode === true);
    const emptyDdi = await readImageStatus(serviceSession(() => ({ ImageSignature: [] })).session);
    check("都没挂时如实报未挂载，开发者模式查不到记 null", emptyDdi.mounted === null && emptyDdi.developerMode === null);

    // App 完整信息
    const detailDict: PlistValue = {
      CFBundleIdentifier: "com.example.app",
      CFBundleShortVersionString: "2.1",
      MinimumOSVersion: "16.0",
      UIBackgroundModes: ["audio", "fetch"],
      CFBundleURLTypes: [
        { CFBundleURLSchemes: ["myapp", "myapp-dev"] },
        { CFBundleURLSchemes: ["myapp"] },
        { 没有schemes: true },
      ],
      Entitlements: { "aps-environment": "development", "application-identifier": "TEAM.com.example.app" },
    };
    const detailCall = serviceSession(() => ({ LookupResult: { "com.example.app": detailDict } }));
    const detail = await readAppDetail(detailCall.session, "com.example.app");
    const options = isPlistDict(detailCall.sent[0].ClientOptions) ? detailCall.sent[0].ClientOptions : {};
    check("查单个 App 时不限定字段，整份 Info.plist 都要", options.ReturnAttributes === undefined && Array.isArray(options.BundleIDs));
    check("拿到整份字典", detail.MinimumOSVersion === "16.0" && isPlistDict(detail.Entitlements));
    check("URL scheme 去重、跳过没有 schemes 的条目", urlSchemes(detail).join(",") === "myapp,myapp-dev");
    check("没有 CFBundleURLTypes 时给空数组", urlSchemes({ CFBundleIdentifier: "x" }).length === 0);
    check("entitlements 取出来", entitlementsOf(detail)["aps-environment"] === "development" && Object.keys(entitlementsOf({})).length === 0);
    check("设备没返回这个 App 时抛错", (await rejects(readAppDetail(serviceSession(() => ({ LookupResult: {} })).session, "com.example.app"))) instanceof Error);

    const rows = flattenSorted(detailDict);
    check("摊平后按键名排好，嵌套用点连起来", rows[0][0] < rows[1][0] && rows.some(([key]) => key === "Entitlements.aps-environment"));
  }

  console.log("签名诊断");
  {
    const now = Date.parse("2026-10-18T00:00:00Z");
    const days = (n: number) => new Date(now + n * 86400000).toISOString();
    const makeProfile = (patch: Partial<ProfileEntry>): ProfileEntry => ({
      uuid: "U-1",
      name: "测试描述文件",
      appIdName: "测试",
      teamName: "Example",
      teamId: "TEAM123456",
      appIdentifier: "TEAM123456.com.example.app",
      created: days(-30),
      expires: days(30),
      kind: "adHoc",
      deviceCount: 2,
      devices: ["aaaa1111bbbb2222cccc3333", "dddd4444eeee5555ffff6666"],
      entitlementKeys: ["application-identifier", "aps-environment", "get-task-allow"],
      entitlements: { "application-identifier": "TEAM123456.com.example.app", "aps-environment": "development", "get-task-allow": true },
      // 证书比描述文件晚到期，这样基准情形不会触发证书相关的提醒
      certificates: [
        { subject: "Apple Development: Test (X1)", organization: "Example Ltd", issuer: "Apple WWDR", notBefore: days(-30), notAfter: days(60) },
      ],
      ...patch,
    });
    const makeSubject = (entitlements: Record<string, unknown>) =>
      subjectOf("测试 App", "com.example.app", {
        SignerIdentity: "Apple Development: someone (ABC123)",
        Entitlements: entitlements as never,
      });
    const base = { "application-identifier": "TEAM123456.com.example.app", "get-task-allow": true };
    const env: DeviceEnv = { udid: "aaaa1111bbbb2222cccc3333", developerMode: true, imageMounted: true };

    check("App ID 精确与通配都认", appIdMatches("TEAM.com.a", "TEAM.com.a") && appIdMatches("TEAM.*", "TEAM.com.a") && !appIdMatches("TEAM.com.b", "TEAM.com.a") && !appIdMatches("", "TEAM.com.a"));
    const subject = makeSubject(base);
    check("从整份字典里取出证书、App ID、Team", subject.signer.startsWith("Apple Development") && subject.teamId === "TEAM123456");

    const wildcard = makeProfile({ uuid: "U-2", appIdentifier: "TEAM123456.*", expires: days(60) });
    const exact = makeProfile({ uuid: "U-3" });
    check("优先精确匹配，哪怕通配的到期更晚", pickProfile(subject, [wildcard, exact], now)?.uuid === "U-3");
    const expired = makeProfile({ uuid: "U-4", expires: days(-1) });
    check("同样精确时优先没过期的", pickProfile(subject, [expired, exact], now)?.uuid === "U-3");
    check("对不上就是没有", pickProfile(makeSubject({ "application-identifier": "OTHER.com.x" }), [exact], now) === null);

    const good = diagnose(subject, [exact], env, now);
    check("全通过时结论是通过", summarize(good).level === "ok", summarize(good).text);
    check("设备在列表里", good.find((item) => item.title === "设备限制")?.level === "ok");

    const otherDevice = diagnose(subject, [exact], { ...env, udid: "9999zzzz8888yyyy7777xxxx" }, now);
    const udidItem = otherDevice.find((item) => item.title === "设备限制");
    check("本机不在设备列表里要报错", udidItem?.level === "fail" && udidItem.detail.includes("重新签"));
    check("读不到 UDID 时记查不到，不瞎猜", diagnose(subject, [exact], { ...env, udid: null }, now).find((item) => item.title === "设备限制")?.level === "unknown");
    check("企业描述文件不限设备", diagnose(subject, [makeProfile({ deviceCount: null, devices: [] })], { ...env, udid: null }, now).find((item) => item.title === "设备限制")?.level === "ok");

    check("描述文件过期要报错", diagnose(subject, [expired], env, now).find((item) => item.title === "描述文件有效期")?.level === "fail");
    check("快到期提醒", diagnose(subject, [makeProfile({ expires: days(3) })], env, now).find((item) => item.title === "描述文件有效期")?.level === "warn");
    check("没有匹配的描述文件", diagnose(subject, [], env, now).find((item) => item.title === "描述文件")?.level === "fail");

    const extra = makeSubject({ ...base, "com.apple.developer.healthkit": true, "keychain-access-groups": ["x"] });
    const extraItems = diagnose(extra, [exact], env, now);
    const scope = extraItems.find((item) => item.title === "权限范围");
    check("超出描述文件范围的权限要点名", scope?.level === "warn" && scope.detail.includes("healthkit"));
    check("系统自带的键不算超范围", !scope!.detail.includes("keychain-access-groups"));
    check("直接比对也一致", extraEntitlements(extra, exact).join(",") === "com.apple.developer.healthkit");

    const noDevMode = diagnose(subject, [exact], { ...env, developerMode: false }, now);
    check("开发签 + 开发者模式没开要报错", noDevMode.find((item) => item.title === "开发者模式")?.level === "fail");
    const distribution = makeSubject({ "application-identifier": "TEAM123456.com.example.app" });
    check("分发签的包不检查开发者模式", !diagnose(distribution, [exact], { ...env, developerMode: false }, now).some((item) => item.title === "开发者模式"));

    const report = reportText(subject, otherDevice, "设备：iPhone16,2 · iOS 26.0（23A1）");
    check("报告带结论、不含 UDID", report.includes("结论：") && report.includes("[有问题] 设备限制") && !report.includes(env.udid!));

    const groups = groupBySigner(
      [
        { bundleId: "com.a", signer: "证书甲 (X1)", appIdentifier: "TEAM123456.com.example.app" },
        { bundleId: "com.b", signer: "证书甲 (X1)", appIdentifier: "TEAM123456.com.example.app" },
        { bundleId: "com.c", signer: "证书乙 (Y2)", appIdentifier: "OTHER.com.x" },
      ],
      [exact],
    );
    check("按证书分组，快到期的排前面", groups.length === 2 && groups[0].signer === "证书甲 (X1)" && groups[0].bundleIds.length === 2);
    check("这一组最早的到期时间", groups[0].earliestExpiry === exact.expires && groups[1].earliestExpiry === null);
  }

  console.log("证书解析");
  {
    /*
      真证书，openssl 生成（2026-10-18）：
        CN=Apple Development: Test User (ABC123XYZ), O=Example Ltd, OU=TEAM123456
        notBefore=2026-10-17T17:37:04Z  notAfter=2026-10-24T17:37:04Z（7 天，照免费账号的样子）
      自签，所以颁发者和主体一样。不手工拼 DER：拼出来的只能证明解析器和我理解一致。
    */
    const sampleDer = new Uint8Array(
      Buffer.from(
        "MIIDnTCCAoWgAwIBAgIUH8Z3J5UnYLS9WG68dbg5+WBYBD8wDQYJKoZIhvcNAQELBQAwXjExMC8GA1UEAwwoQXBwbGUgRGV2ZWxvcG1lbnQ6IFRlc3QgVXNlciAoQUJDMTIzWFlaKTEUMBIGA1UECgwLRXhhbXBsZSBMdGQxEzARBgNVBAsMClRFQU0xMjM0NTYwHhcNMjYxMDE3MTczNzA0WhcNMjYxMDI0MTczNzA0WjBeMTEwLwYDVQQDDChBcHBsZSBEZXZlbG9wbWVudDogVGVzdCBVc2VyIChBQkMxMjNYWVopMRQwEgYDVQQKDAtFeGFtcGxlIEx0ZDETMBEGA1UECwwKVEVBTTEyMzQ1NjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANnvuMIjRvuqVQcdAX9FSodo/GFR5rAVs97flsxwN1Ry9q3kkYmDob7X3iISGyoU3qyjsTJSVCIZJYj/3Ji78UC5GybJrdC4uf4gRkgVAXDi11BV05TK6FCHVAo607cLnSeCbR6pboLCuupqzcLRS0Lh6FtQbkeBZ+NylRI0AWj+i4LvCxtFW2ja+0yNpM9Hchr/6KHhdwRDvGQS+3qj4XiH4iKynITEsCv/JhsBa35kSlZhjelMI3Zc6QIVZtqf4qEn3LAZ7J37DTXEPgbfvI+ohU/q3dl4iRozCM9WiUCBD6+L7AVOsIG4dDdo/Bsg7cY+oBYQXDBEeGCoZJavT4ECAwEAAaNTMFEwHQYDVR0OBBYEFCVDLED5xNFmChWqZTCs+5PsrWkYMB8GA1UdIwQYMBaAFCVDLED5xNFmChWqZTCs+5PsrWkYMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAD5ZD8VSONYTJ1sV59aEd2RqORP6xYXZ26rM1RENpZRE5dlhRYz67ktkHcUYn3HuErGi2TByMgdFKi3yOOUVlweLqxLCa6IvpVaItl67A9iwATg96+qAqiiq9QXPMT/kjAvqKCwd+ymq9TRR+VQ6e92xStFPAWeXQ9V5oCrvNZzkEOyFLfS1Ne/QCrUTuP34hWXr96S1gQGzfvYRRSuutbIQXWCCRHpsm35okIGqzJVTNSFKorgW2RfFnDsg7WcTp1m/REb27424noSp4vmZV2IikxgXlTQylOW/pPBcakdiWrRGt8NK4VBnk3wQF8FRfxSMdX+SwFx1gNSg3aRaTD0=",
        "base64",
      ),
    );
    const cert = parseCertificate(sampleDer);
    check("主体通用名", cert?.subject === "Apple Development: Test User (ABC123XYZ)", String(cert?.subject));
    check("组织与部门", cert?.organization === "Example Ltd");
    check("颁发者", cert?.issuer === "Apple Development: Test User (ABC123XYZ)");
    check("有效期（UTCTime 两位年）", cert?.notBefore === "2026-10-17T17:37:04.000Z" && cert?.notAfter === "2026-10-24T17:37:04.000Z", `${cert?.notBefore} → ${cert?.notAfter}`);
    check("坏数据返回 null，不抛错", parseCertificate(new Uint8Array([0x30, 0x80, 0x01])) === null && parseCertificate(new Uint8Array(0)) === null);
    check("截断的证书也不抛错", parseCertificate(sampleDer.subarray(0, 50)) === null);
    check("UTCTime 的 50 年分界", parseCertTime(0x17, "960101000000Z")?.startsWith("1996") === true && parseCertTime(0x17, "260101000000Z")?.startsWith("2026") === true);
    check("GeneralizedTime 四位年", parseCertTime(0x18, "20491231235959Z")?.startsWith("2049") === true);
    check("不是时间标签返回 null", parseCertTime(0x02, "20491231235959Z") === null);

    // 证书比描述文件先过期：最容易看岔的情况
    const nowAt = Date.parse("2026-10-18T00:00:00Z");
    const profileWithCert: ProfileEntry = {
      uuid: "U-9",
      name: "免费号描述文件",
      appIdName: "测试",
      teamName: "Example",
      teamId: "TEAM123456",
      appIdentifier: "TEAM123456.com.example.app",
      created: "2026-10-17T00:00:00Z",
      expires: "2027-10-17T00:00:00Z",
      kind: "development",
      deviceCount: null,
      devices: [],
      entitlementKeys: ["application-identifier", "get-task-allow"],
      entitlements: { "application-identifier": "TEAM123456.com.example.app", "get-task-allow": true },
      certificates: [cert!],
    };
    check("取最早到期的证书", earliestCertificate(profileWithCert)?.notAfter === cert?.notAfter);
    const certSubject = subjectOf("测试 App", "com.example.app", {
      SignerIdentity: "Apple Development: Test User (ABC123XYZ)",
      Entitlements: { "application-identifier": "TEAM123456.com.example.app", "get-task-allow": true } as never,
    });
    const certItems = diagnose(certSubject, [profileWithCert], { udid: null, developerMode: true, imageMounted: true }, nowAt);
    const certItem = certItems.find((item) => item.title === "证书有效期");
    check("证书只剩几天要提醒", certItem?.level === "warn" && certItem.detail.includes("Test User"), certItem?.detail);
    check("描述文件还有一年，所以不报它", certItems.find((item) => item.title === "描述文件有效期")?.level === "ok");
    check("点出「先到期的是证书」", certItems.some((item) => item.title === "先到期的是证书"));
    check("没有证书时记查不到", diagnose(certSubject, [{ ...profileWithCert, certificates: [] }], { udid: null, developerMode: true, imageMounted: true }, nowAt).find((item) => item.title === "证书有效期")?.level === "unknown");
  }

  console.log("模拟时间");
  {
    const realNow = Date.now();
    check("默认用真实时间", !isClockShifted() && Math.abs(simulatedNow() - realNow) < 5000 && clockLabel() === "");

    shiftClock(30);
    check("往后拨 30 天", isClockShifted() && clockOffsetDays() === 30 && simulatedNow() - realNow > 29 * 86400000);
    check("提示条带日期和天数", clockLabel().startsWith("模拟时间：") && clockLabel().includes("+30 天"), clockLabel());

    /*
      拨过之后，到期判断跟着变——这正是拿来测显示的那条路。
      多给一小时余量：剩余天数是向下取整的，正好卡在整天上时，
      跑到这一行花掉的几毫秒就会让 10 天变成 9 天。
    */
    const in40Days = new Date(realNow + 40 * 86400000 + 3600000).toISOString();
    check("拨之前还剩 40 天，拨之后只剩 10 天", expiryState(in40Days).level === "ok" && expiryState(in40Days).text === "还剩 10 天", expiryState(in40Days).text);
    const in20Days = new Date(realNow + 20 * 86400000).toISOString();
    check("拨过头就显示已过期", expiryState(in20Days).level === "expired");

    shiftClock(-10);
    check("也能往前拨", clockOffsetDays() === -10 && simulatedNow() < realNow);

    resetClock();
    check("恢复后回到真实时间", !isClockShifted() && clockLabel() === "" && expiryState(in40Days).level === "ok" && expiryState(in20Days).level === "ok");
    check("显式传时间的调用不受时钟影响", expiryState(in40Days, realNow).text === "还剩 40 天", expiryState(in40Days, realNow).text);
  }

  console.log("实时性能采样");
  {
    // sysmontap 一条消息里混着几种行，按 key 认；进程是按 procAttrs 顺序排的数组
    const procAttrs = ["pid", "cpuUsage", "physFootprint"];
    const sysAttrs = ["physMemSize", "vmFreeCount", "vmUsedCount", "vmExtPageCount", "vmPurgeableCount"];
    const names = new Map([
      [100, "SpringBoard"],
      [200, "Scripting"],
    ]);
    const payload = [
      { SystemCPUUsage: { CPU_TotalLoad: 37.25, CPU_UserLoad: 20, CPU_SystemLoad: 17.25 } },
      {
        Processes: {
          "100": [100, 12.34, 500_000_000],
          "200": [200, 55.5, 120_000_000],
          "300": [300, null, 1_000],
          坏的: "不是数组",
        },
        System: [8_000_000_000, 100_000, 400_000, 7_000, 9_000],
      },
    ];
    const sample = parseSample(payload, procAttrs, sysAttrs, names, 1700)!;
    check("取到全机 CPU", sample.cpuPercent === 37.3, String(sample.cpuPercent));
    check("进程按 CPU 从高到低", sample.processes.map((p) => p.pid).join(",") === "200,100,300", sample.processes.map((p) => p.pid).join(","));
    check("pid 换成进程名，没有的留 pid", sample.processes[0].name === "Scripting" && sample.processes[2].name === "pid 300");
    check("按 procAttrs 顺序取值", sample.processes[0].cpuPercent === 55.5 && sample.processes[0].memoryBytes === 120_000_000);
    check("取不到的字段记 null，不猜", sample.processes[2].cpuPercent === null);
    check("不是数组的条目跳过", sample.processes.length === 3);
    check("系统字段按名字收好，不是下标", sample.memory.get("physMemSize") === 8_000_000_000 && sample.memory.get("vmUsedCount") === 400_000);
    check("sysAttrs 没覆盖到的值丢掉，不编名字", sample.memory.size === 5);
    check("采样时间带上", sample.at === 1700);

    // 只有 CPU 那一行也要能用：不同系统版本给的行不一样
    const cpuOnly = parseSample([{ SystemCPUUsage: { CPU_TotalLoad: 10 } }], procAttrs, sysAttrs, names, 1)!;
    check("只有 CPU 行也成立", cpuOnly.cpuPercent === 10 && cpuOnly.processes.length === 0);
    check("没有 TotalLoad 时用 User + System 相加", parseSample([{ SystemCPUUsage: { CPU_UserLoad: 10, CPU_SystemLoad: 5.5 } }], procAttrs, sysAttrs, names, 1)!.cpuPercent === 15.5);
    check("一行都不认识时返回 null", parseSample([{ 别的: 1 }], procAttrs, sysAttrs, names, 1) === null && parseSample(null, procAttrs, sysAttrs, names, 1) === null);

    // physFootprint 不在时退到 memResidentSize
    const fallback = parseSample(
      [{ Processes: { "100": [100, 1, 999] } }],
      ["pid", "cpuUsage", "memResidentSize"],
      sysAttrs,
      names,
      1,
    )!;
    check("没有 physFootprint 就用 memResidentSize", fallback.processes[0].memoryBytes === 999);

    // 采样只给页数、不给页大小，得按总量反推
    check("8 GB / 50 万页 → 16K 页", inferPageSize(8e9, 500_000) === 16384);
    check("2 GB / 50 万页 → 4K 页", inferPageSize(2e9, 500_000) === 4096);
    check("两个都对不上就认输，不硬凑", inferPageSize(8e9, 10) === null);
    check("总量或页数是 0 时返回 null", inferPageSize(0, 500_000) === null && inferPageSize(8e9, 0) === null);

    const breakdown = memoryBreakdown(sample)!;
    check("内存换算成字节", breakdown.used === 400_000 * 16384 && breakdown.free === 100_000 * 16384);
    check("总量原样用，不乘页大小", breakdown.total === 8_000_000_000);
    check("可清除也换算", breakdown.purgeable === 9_000 * 16384);
    check("写明用的哪种页大小", breakdown.pageSize === 16384);
    check("缺字段时返回 null，不显示半截数", memoryBreakdown(cpuOnly) === null);
  }

  console.log("安装 / 更新时间");
  {
    // 照真机布局的形状：App 条目带 iconModDate，文件夹里的也带
    const layout: PlistValue = [
      [{ bundleIdentifier: "com.dock.a", displayName: "A", iconModDate: new PReal(1_700_000_000_000) }],
      [
        { bundleIdentifier: "com.new", displayName: "新", iconModDate: new PReal(1_790_000_000_000) },
        {
          listType: "folder",
          displayName: "夹",
          iconLists: [[{ bundleIdentifier: "com.infolder", displayName: "夹里", iconModDate: new PReal(1_780_000_000_000) }]],
        },
        { bundleIdentifier: "com.nodate", displayName: "没时间" },
        { iconType: "custom", gridSize: "small", elementType: "widget" },
      ],
    ];
    const times = installTimes(layout);
    check("Dock、页面、文件夹里的都收到", times.size === 3 && times.has("com.dock.a") && times.has("com.infolder"));
    check("没有 iconModDate 的不收", !times.has("com.nodate"));
    check("时间值对得上", times.get("com.new") === 1_790_000_000_000);

    const apps = [
      { bundleId: "com.nodate", name: "没时间" },
      { bundleId: "com.infolder", name: "夹里" },
      { bundleId: "com.new", name: "新" },
    ] as AppEntry[];
    const sorted = sortApps(apps, "installed", times);
    check("新的在前，没时间的垫底", sorted.map((app) => app.bundleId).join(",") === "com.new,com.infolder,com.nodate", sorted.map((app) => app.bundleId).join(","));
    check("没传时间表时不崩", sortApps(apps, "installed").length === 3);

    const now = Date.parse("2026-10-18T12:00:00Z");
    const ago = (days: number) => now - days * 86400000;
    check("今天 / 昨天 / 几天前", sinceText(ago(0), now) === "今天" && sinceText(ago(1), now) === "昨天" && sinceText(ago(5), now) === "5 天前");
    check("几个月前 / 几年前", sinceText(ago(60), now) === "2 个月前" && sinceText(ago(400), now) === "1 年前");
    check("没有时间显示横杠", sinceText(undefined, now) === "—");
    check("时间在未来时不说负数", sinceText(now + 10000, now) === "刚刚");
  }

  console.log("缓存");
  {
    const entries = [
      { name: "App 图标", detail: "147 个", bytes: 3_000_000 },
      { name: "App 占用空间", detail: "147 个", bytes: null },
    ];
    check("总大小只算得出来的那部分", totalCacheBytes(entries) === 3_000_000 && cacheSizeText(entries) === "3.0 MB");
    check("一个都算不出来时显示横杠", cacheSizeText([{ name: "x", detail: "y", bytes: null }]) === "—");

    // 链接缓存：查过的记住，查不到的也记住，清掉之后两者都没了
    const memory = new Map<string, unknown>();
    (globalThis as unknown as { Storage: unknown }).Storage = {
      get: (key: string) => (memory.has(key) ? memory.get(key) : null),
      set: (key: string, value: unknown) => (memory.set(key, value), true),
      remove: (key: string) => void memory.delete(key),
    };
    clearStoreLinkCache();
    let hits = 0;
    const fetcher = async (url: string) => {
      hits++;
      const ids = /bundleId=([^&]+)/.exec(url)![1].split(",");
      return { results: ids.filter((id) => id === "com.yes").map((id) => ({ bundleId: id, trackName: id, primaryGenreName: "Utilities", trackViewUrl: `https://apps.apple.com/cn/app/${id}` })) };
    };
    await findStoreLinks(["com.yes", "com.no"], { locale: "zh_CN", fetcher });
    const firstRound = hits;
    check("查完写进 Storage", memory.has("storeLinks"));
    await findStoreLinks(["com.yes", "com.no"], { locale: "zh_CN", fetcher });
    check("再查走缓存，不再发请求", hits === firstRound);
    clearStoreLinkCache();
    check("清掉后 Storage 里也没了", !memory.has("storeLinks"));
    await findStoreLinks(["com.yes"], { locale: "zh_CN", fetcher });
    check("清掉后会重新查", hits > firstRound);
  }

  console.log("系统事件");
  {
    check("事件名不重复", new Set(EVENT_KINDS.map((kind) => kind.name)).size === EVENT_KINDS.length);
    check("分组从事件表里推出来", EVENT_GROUPS.includes("应用") && EVENT_GROUPS.includes("屏幕"));
    check("认识的名字给中文说法", describeEvent("com.apple.mobile.application_installed", 5).label === "装了一个 App");
    check("不认识的名字原样显示，不编", describeEvent("com.apple.something.unknown", 5).label === "com.apple.something.unknown");
    check("带上收到的时间", describeEvent("x", 1234).at === 1234);

    type Message = Record<string, PlistValue>;
    function eventSession(queue: PlistValue[]) {
      const sent: Message[] = [];
      const pending = [...queue];
      const client = {
        send: async (message: Message) => void sent.push(message),
        receiveDict: async () => {
          const next = pending.shift();
          if (next === undefined) throw new Error("没有更多事件");
          return next as Message;
        },
      };
      const session = {
        hasService: () => true,
        withService: async (_name: string, use: (c: typeof client) => Promise<unknown>) => use(client),
      } as unknown as DeviceSession;
      return { session, sent };
    }

    const got: string[] = [];
    let ready = false;
    const call = eventSession([
      { Command: "RelayNotification", Name: "com.apple.mobile.application_installed" },
      { Command: "别的东西" },
      { Command: "RelayNotification" },
      { Command: "RelayNotification", Name: "com.apple.language.changed" },
    ]);
    let left = 4;
    await watchEvents(call.session, {
      names: ["com.apple.mobile.application_installed", "com.apple.language.changed", "com.apple.mobile.application_installed"],
      onReady: () => (ready = true),
      onEvent: (event) => got.push(event.label),
      shouldStop: () => left-- <= 0,
    });
    const subscribes = call.sent.filter((message) => message.Command === "ObserveNotification");
    check("逐个订阅，重复的只订一次", subscribes.length === 2 && subscribes[0].Name === "com.apple.mobile.application_installed");
    check("订阅完回调一次", ready);
    check("只认 RelayNotification，缺名字的跳过", got.join(",") === "装了一个 App,语言或地区变了", got.join(","));
    check("收工发 Shutdown", call.sent.some((message) => message.Command === "Shutdown"));
    check("一个都没选时拒绝", (await rejects(watchEvents(eventSession([]).session, { names: ["  "], onEvent: () => {}, shouldStop: () => true }))) instanceof Error);
  }

  console.log("长按菜单自定义");
  {
    check("动作 id 不重复", new Set(ROW_ACTIONS.map((action) => action.id)).size === ROW_ACTIONS.length);
    check("默认项都是认识的", DEFAULT_ROW_ACTIONS.every((id) => findRowAction(id) !== undefined));
    check("只有卸载是红的", ROW_ACTIONS.filter((action) => action.destructive).map((action) => action.id).join() === "uninstall");

    check("没存过给默认", sanitizeRowActions(undefined).join() === DEFAULT_ROW_ACTIONS.join());
    check("存成空数组也给默认", sanitizeRowActions([]).join() === DEFAULT_ROW_ACTIONS.join());
    check("存的全是不认识的，退回默认", sanitizeRowActions(["copy-xyz", 7, null]).join() === DEFAULT_ROW_ACTIONS.join());
    check("不认识的剔掉，认识的保序", sanitizeRowActions(["uninstall", "没这项", "copy-name"]).join() === "uninstall,copy-name");
    check("重复的去掉", sanitizeRowActions(["copy-name", "copy-name", "uninstall"]).join() === "copy-name,uninstall");
    check("不是数组也不炸", sanitizeRowActions("copy-name").join() === DEFAULT_ROW_ACTIONS.join());

    const base: RowActionId[] = ["copy-bundle", "copy-name", "uninstall"];
    check("勾上加到末尾", toggleRowAction(base, "copy-team", true).join() === "copy-bundle,copy-name,uninstall,copy-team");
    check("已经有了不重复加", toggleRowAction(base, "copy-name", true).join() === base.join());
    check("取消就拿掉", toggleRowAction(base, "copy-name", false).join() === "copy-bundle,uninstall");
    check("上移", moveRowAction(base, "copy-name", -1).join() === "copy-name,copy-bundle,uninstall");
    check("下移", moveRowAction(base, "copy-name", 1).join() === "copy-bundle,uninstall,copy-name");
    check("到顶了不动", moveRowAction(base, "copy-bundle", -1).join() === base.join());
    check("到底了不动", moveRowAction(base, "uninstall", 1).join() === base.join());
    check("不在列表里的不动", moveRowAction(base, "store-open", 1).join() === base.join());
    check("移动不改原数组", base.join() === "copy-bundle,copy-name,uninstall");

    const app: AppEntry = {
      bundleId: "com.example.app",
      name: "示例",
      version: "1.2",
      build: "34",
      appSize: 1024 * 1024,
      dataSize: 1024 * 1024,
      source: "development",
      signer: "iPhone Developer: 甲 (X1)",
      appIdentifier: "TEAM123456.com.example.app",
      teamId: "TEAM123456",
    };
    check("版本和 build 不同时带括号", versionText(app) === "1.2（34）");
    check("build 和版本一样时不重复写", versionText({ ...app, build: "1.2" }) === "1.2");
    check("两个都没有给横杠", versionText({ ...app, version: "", build: "" }) === "—");
    check("复制 Bundle ID", rowActionText("copy-bundle", app) === "com.example.app");
    check("复制 Team ID", rowActionText("copy-team", app) === "TEAM123456");
    check("整行带名称、来源和占用", rowActionText("copy-line", app) === "示例 · com.example.app · 1.2（34） · 开发签 · 2.1 MB", rowActionText("copy-line", app) ?? "");
    check("占用还没算出来时写横杠", rowActionText("copy-line", { ...app, appSize: null, dataSize: null })?.endsWith(" · —") === true);
    check("没有这一项时给空串，不是 null", rowActionText("copy-team", { ...app, teamId: "" }) === "");
    check("不是复制类的给 null", rowActionText("uninstall", app) === null && rowActionText("store-open", app) === null);
    check("每个复制类动作都有内容可复制", ROW_ACTIONS.filter((action) => action.id.startsWith("copy-")).every((action) => rowActionText(action.id, app)));
  }

  console.log("连接设置");
  {
    check("默认是内置隧道和默认地址", normalizeSettings(null).source === "builtIn" && normalizeSettings(null).host === DEFAULT_HOST);
    check("认得 proxyApp", normalizeSettings({ source: "proxyApp" }).source === "proxyApp");
    check("不认识的来源退回 builtIn", normalizeSettings({ source: "乱填" } as never).source === "builtIn");
    check("地址非法就退回默认", normalizeSettings({ host: "我不是地址" }).host === DEFAULT_HOST);
    check("地址合法就留着", normalizeSettings({ host: " 10.7.0.9 " }).host === "10.7.0.9");
    check("段超过 255 不算合法", normalizeHost("10.7.0.999") === DEFAULT_HOST);
  }

  console.log("调试日志");
  {
    clearDebugLog();
    check("清空后是 0 条", debugLogCount() === 0);
    debugLog("自测", "一行");
    check("前缀是本脚本的，不是别的脚本的", debugLogText().includes("[toolbox:自测]"), debugLogText());
    debugLog("自测", "一行");
    debugLog("自测", "一行");
    check("连着刷的同一行折叠成一条", debugLogCount() === 1 && debugLogText().includes("×3"), debugLogText());
    debugLog("自测", "另一行");
    check("换了内容就另起一条", debugLogCount() === 2);
    clearDebugLog();
    check("清空按钮真的清干净", debugLogCount() === 0 && debugLogText() === "");
    // Node 里没有 Storage，开关读不到就当关着，不能把 debugLog 带崩
    check("拿不到 Storage 时开关当关着", debugEcho() === false);
  }

  console.log("链路判断");
  {
    const state = (status: string, interfaces: string[]) =>
      ({ status, interfaces, isExpensive: false, isConstrained: false }) as unknown as Parameters<typeof classifyLink>[0];
    check("WiFi", classifyLink(state("satisfied", ["wifi"])) === "wifi");
    check("蜂窝", classifyLink(state("satisfied", ["cellular"])) === "cellular");
    check("两个都在时算 WiFi，默认路径走的是它", classifyLink(state("satisfied", ["cellular", "wifi"])) === "wifi");
    check("有线", classifyLink(state("satisfied", ["wiredEthernet"])) === "wired");
    check("没网", classifyLink(state("unsatisfied", [])) === "offline");
    check("说满足却没列接口，当未知而不是没网", classifyLink(state("satisfied", [])) === "unknown");
    check("拿不到状态算未知", classifyLink(null) === "unknown" && classifyLink(undefined) === "unknown");
    check("接口字段坏了也不炸", classifyLink({ status: "satisfied" } as never) === "unknown");

    check("只有蜂窝和没网要提醒", needsAttention("cellular") && needsAttention("offline"));
    check("WiFi、有线、未知不提醒", !needsAttention("wifi") && !needsAttention("wired") && !needsAttention("unknown"));
    check("蜂窝的提示讲飞行模式", linkHint("cellular").includes("飞行模式"));
    check("WiFi 没有提示", linkHint("wifi") === "");
    check("每种链路都有中文名", (["wifi", "cellular", "wired", "offline", "unknown"] as LinkKind[]).every((kind) => LINK_LABEL[kind]));
  }

  console.log("断线识别");
  {
    check(
      "隧道被收掉认出来",
      isTunnelDropped("未能完成操作。(Scripting.RSDCDTunnelTransport.Failure 错误 7。) code=RSD_NETWORK_FAILURE networkErrorCode=53 stage=transport-read"),
    );
    check("只给 networkErrorCode=53 也算", isTunnelDropped("networkErrorCode=53"));
    check("真出错的不误判", !isTunnelDropped("Lookup 回包解析失败：缺少 LookupResult"));
    check("空的不误判", !isTunnelDropped(undefined) && !isTunnelDropped(new Error("配对失败")));
  }

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

void main();
