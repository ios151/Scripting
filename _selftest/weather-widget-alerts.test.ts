// 离线自测（Node 里跑，不碰 Scripting 的原生 API，也不联网）：天气小组件的「天气预警」。
//   npx -y -p tsx tsx _selftest/weather-widget-alerts.test.ts
//   类型检查：看仓库根的 tsconfig.json（只管脚本目录）；自测文件自己更严的那份 tsconfig 在作者本地，没放进仓库
//
// 预警数据来自彩云天气，和天气是同一次请求带回来的（`alert=true`），默认走内置的接口（001 提供）。
// 这里一次真实请求都没发过，内置接口的地址也不在测试里写出来（要用就从 caiyun.ts 里引用）：
//   · 返回的样子来自 weather-widget-golden/caiyun_alert_sample.json——按彩云文档的字段列表和示例值手搭的（文件里有说明），
//     不是真实返回。所以「有预警时真实返回读不读得懂」只能等接口真的返回预警了才知道，这里测的是：照文档写的结构，读得对不对；
//   · 预警的状态（从取天气的结果里推出来：关着、没取到、读懂了、用的是缓存、预览样式）每条分支各走一遍；
//   · 徽章：预警类型 → 图案、按级别上色的底色和图案的对比度；
//   · 卡片上和 App 页里说的话。
// 取天气本身（彩云返回的整理、地址、联网、来源设置、存储）在 weather-widget-caiyun.test.ts 里。
// 画面本身（徽章长什么样、放在哪）这里看不到，只能上真机。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { DEMO_ALERTS, GENERIC_SYMBOL, alertFieldMissing, alertSymbol, labelFromCode, labelFromTitle, levelFromCode, levelFromTitle, parseAlertResponse, parseStoredAlerts, rankOf, shortLabel, sortAlerts, type AlertItem } from "../天气小组件/core/alerts";
import { alertStateOf, type AlertState } from "../天气小组件/core/alertState";
import type { AlertSnapshot } from "../天气小组件/core/cache";
import { BUILTIN_HOST } from "../天气小组件/core/caiyun";
import { ALERT_CLOCK_SKEW_MS, ALERT_DEMO_MS, ALERT_MAX_AGE_MS } from "../天气小组件/core/config";
import { loadEverything, type EverythingDeps } from "../天气小组件/core/everything";
import { failureMessage, type Failure } from "../天气小组件/core/failure";
import { parseForecast } from "../天气小组件/core/forecast";
import type { Coord } from "../天气小组件/core/geo";
import type { Loaded } from "../天气小组件/core/load";
import { ALERT_BADGE, ALERT_INK, SKY } from "../天气小组件/core/palette";
import { alertStatusText, alertView, present, sourceTestMessage, whenText } from "../天气小组件/core/present";
import { defaultSettings } from "../天气小组件/core/settings";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean): void {
  if (ok) {
    passed++;
  } else {
    failed++;
    console.log("  ✗ " + name);
  }
}

function section(title: string): void {
  console.log("\n" + title);
}

const HERE = __dirname;
const SCRIPT_DIR = join(HERE, "..", "天气小组件");
const GOLDEN_DIR = join(HERE, "weather-widget-golden");

const SAMPLE: unknown = JSON.parse(readFileSync(join(GOLDEN_DIR, "caiyun_alert_sample.json"), "utf8"));
const FORECAST = parseForecast(JSON.parse(readFileSync(join(GOLDEN_DIR, "weather_fixture.json"), "utf8")));

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const BEIJING: Coord = { latitude: 39.976, longitude: 116.3176 };
const T0 = Date.UTC(2026, 10, 2, 4, 0);
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;

async function main(): Promise<void> {
  const parsed = parseAlertResponse(SAMPLE);
  if (parsed === null) throw new Error("样例读不出来");
  // 单独声明成确定的数组：下面的函数声明里用得到（函数声明里看不到上面那次判空）
  const items: AlertItem[] = parsed;

  // ---------------------------------------------------------------- 读返回
  section("读彩云的返回（照文档的字段）");
  {
    check("样例能读出来", items.length > 0);
    check("已解除的、重复的 ID 都去掉了：7 条里剩 5 条", items.length === 5);
    check("排序：红 > 橙 > 黄 > 蓝，同级发布得晚的在前", items.map((i) => i.level).join() === "red,orange,yellow,blue,blue" && items[3].label === "大雾蓝色预警" && items[4].label === "大风蓝色预警");
    check("短名字从标题里取：大风 / 暴雨 / 高温 / 雷电 / 大雾", items.map((i) => i.label).join() === "雷电红色预警,暴雨橙色预警,高温黄色预警,大雾蓝色预警,大风蓝色预警");
    check("没有代码的那条，级别从标题里读（红）", items[0].code === "" && items[0].level === "red");
    check("时间戳写成字符串的也读得出来（秒 → 毫秒）", items[3].publishedAt === 1640740000 * 1000);
    check("文档示例那条：标题、来源、地点、描述原样留着", items[4].title === "海淀区气象台发布大风蓝色预警[IV/一般]" && items[4].source === "国家预警信息发布中心" && items[4].location === "北京市海淀区" && items[4].description.startsWith("海淀区气象台29日07时25分"));
    check("预警 ID 原样留着（用来去重）", items[4].id === "11010841600000_20211229072633");

    check("没读懂和没有预警分得开：状态不是 ok → null", parseAlertResponse({ ...(SAMPLE as object), status: "failed" }) === null);
    check("没有 result / alert / content、或 content 不是数组 → null", [null, undefined, 3, "x", [], {}, { status: "ok" }, { status: "ok", result: {} }, { status: "ok", result: { alert: {} } }, { status: "ok", result: { alert: { content: "x" } } }].every((value) => parseAlertResponse(value) === null));
    check("返回读得懂、只是 result 里没有 alert（或 alert 是 null）：和「没读懂」分开，单独认出来", alertFieldMissing({ status: "ok", result: {} }) && alertFieldMissing({ status: "ok", result: { alert: null } }) && alertFieldMissing({ status: "ok", result: { realtime: {} } }));
    check("别的情况不算「没带 alert」：带了 alert（哪怕是空对象）、状态不是 ok、没有 result、不是对象", !alertFieldMissing({ status: "ok", result: { alert: {} } }) && !alertFieldMissing({ status: "ok", result: { alert: { content: [] } } }) && !alertFieldMissing({ status: "failed", result: {} }) && !alertFieldMissing({ status: "ok" }) && !alertFieldMissing({ status: "ok", result: "x" }) && !alertFieldMissing(null) && !alertFieldMissing(undefined) && !alertFieldMissing("x"));
    check("content 为空数组 → 读懂了、现在没有预警（空数组，不是 null）", (() => { const result = parseAlertResponse({ status: "ok", result: { alert: { status: "ok", content: [] } } }); return result !== null && result.length === 0; })());
    check("条目里什么都没有（没标题没描述）、不是对象的，丢掉", parseAlertResponse({ status: "ok", result: { alert: { content: [{}, null, 3, "x", { title: "", description: "" }, { title: "有标题" }] } } })?.length === 1);
    check("只有描述没有标题：用描述的前 40 字当标题", parseAlertResponse({ status: "ok", result: { alert: { content: [{ description: "海淀区气象台发布大风蓝色预警，请注意防范。", code: "0501" }] } } })?.[0].title.startsWith("海淀区气象台发布大风") === true);
    check("状态里写了解除 / 取消的丢掉，没写状态的留着", parseAlertResponse({ status: "ok", result: { alert: { content: [{ title: "甲", status: "已取消" }, { title: "乙", status: "解除" }, { title: "丙" }, { title: "丁", status: "预警中" }] } } })?.map((i) => i.title).join() === "丙,丁");
    check("没有预警 ID 时用 代码-时间-标题 拼一个，两条一样的算重复", parseAlertResponse({ status: "ok", result: { alert: { content: [{ title: "甲", code: "0501", pubtimestamp: 5 }, { title: "甲", code: "0501", pubtimestamp: 5 }] } } })?.length === 1);

    // 时间戳
    const at = (value: unknown) => parseAlertResponse({ status: "ok", result: { alert: { content: [{ title: "甲", pubtimestamp: value }] } } })?.[0].publishedAt;
    check("时间戳：秒、毫秒、带引号的数字都收；0、负数、乱写是 null", at(1640733900) === 1640733900000 && at(1640733900000) === 1640733900000 && at("1640733900") === 1640733900000 && at(0) === null && at(-5) === null && at("abc") === null && at(null) === null && at("") === null);
  }

  // ---------------------------------------------------------------- 级别与名字
  section("级别与短名字");
  {
    check("代码后两位：01 蓝、02 黄、03 橙、04 红、05 白", ["0501", "0502", "0503", "0504", "0505"].map(levelFromCode).join() === "blue,yellow,orange,red,white");
    check("代码不是 4 位数字、级别不认识：unknown", ["", "05", "05011", "abcd", "0500", "0599", "0 01"].every((code) => levelFromCode(code) === "unknown"));
    check("标题里的「X色预警」：蓝黄橙红白", ["蓝", "黄", "橙", "红", "白"].map((c) => levelFromTitle("某气象台发布大风" + c + "色预警")).join() === "blue,yellow,orange,red,white");
    check("标题里没有颜色：unknown", levelFromTitle("某气象台发布大风预警") === "unknown" && levelFromTitle("") === "unknown");
    check("级别排序：红 > 橙 > 黄 = 读不出级别的 > 蓝 > 白", ["red", "orange", "yellow", "blue", "white", "unknown"].map((l) => rankOf(l as AlertItem["level"])).join() === "4,3,2,1,0,2");
    check("读不出级别的按黄色算：排在蓝色前面、橙红后面，不会被蓝色的盖住", (() => {
      const make = (id: string, level: AlertItem["level"]): AlertItem => ({ ...items[4], id, level, publishedAt: 1 });
      const mixed = sortAlerts([make("blue", "blue"), make("unknown", "unknown"), make("orange", "orange")]).map((i) => i.id).join();
      return mixed === "orange,unknown,blue" && alertView({ kind: "ok", items: [make("blue", "blue"), make("unknown", "unknown")], fetchedAt: T0, failure: null }, T0)?.level === "unknown";
    })());

    check("标题取名：切掉前面的单位名和「发布」", labelFromTitle("海淀区气象台发布大风蓝色预警[IV/一般]") === "大风蓝色预警" && labelFromTitle("北京市气象台发布暴雨橙色预警信号") === "暴雨橙色预警");
    check("标题取名：写了升级的，取最后一处（现在的）", labelFromTitle("北京市气象台将暴雨黄色预警升级为暴雨橙色预警") === "暴雨橙色预警" && levelFromTitle("北京市气象台将暴雨黄色预警升级为暴雨橙色预警") === "orange");
    check("标题取名：继续发布 / 更新为", labelFromTitle("某气象台继续发布高温红色预警") === "高温红色预警" && labelFromTitle("某气象台更新为寒潮橙色预警") === "寒潮橙色预警");
    check("标题取名：前面带年月日的", labelFromTitle("海淀区气象台2021年12月29日07时25分发布大风蓝色预警") === "大风蓝色预警");
    check("标题取名：四个字的类型（道路结冰、森林火险、雷雨大风）", labelFromTitle("某县气象台发布道路结冰黄色预警") === "道路结冰黄色预警" && labelFromTitle("某县气象台发布森林火险橙色预警") === "森林火险橙色预警" && labelFromTitle("某县气象台发布雷雨大风橙色预警") === "雷雨大风橙色预警");
    check("标题取名：切不出类型名（前面只有单位名）、没有「X色预警」→ null", labelFromTitle("某气象台发布红色预警") === null && labelFromTitle("大风预警") === null && labelFromTitle("") === null);
    check("标题取名：前面的字太长切不干净（没有「发布」这类字眼）→ null，退回代码取名", labelFromTitle("北京市海淀区近期持续高温黄色预警") === null && shortLabel("北京市海淀区近期持续高温黄色预警", "0702") === "高温黄色预警");
    check("代码取名：0501 → 大风蓝色预警；1604 → 雷雨大风红色预警", labelFromCode("0501") === "大风蓝色预警" && labelFromCode("1604") === "雷雨大风红色预警" && labelFromCode("0203") === "暴雨橙色预警");
    check("代码取名：认不得的类型 / 级别 / 格式 → null", labelFromCode("9901") === null && labelFromCode("0599") === null && labelFromCode("") === null && labelFromCode("05") === null);
    check("短名字：标题读得出用标题的（标题和代码不一致时听标题的）", shortLabel("海淀区气象台发布大风蓝色预警", "0204") === "大风蓝色预警");
    check("短名字：标题读不出、用代码", shortLabel("关于大风的预警提示", "0502") === "大风黄色预警");
    check("短名字：都读不出、用标题原文，太长截成 10 个字加省略号", shortLabel("提示", "") === "提示" && shortLabel("这是一段很长很长很长的预警提示文字", "") === "这是一段很长很长很长…");
    check("排序：级别高的在前；同级发布晚的在前；不改原数组", (() => {
      const a: AlertItem = { ...items[4], id: "a" };
      const b: AlertItem = { ...items[0], id: "b" };
      const input = [a, b];
      return sortAlerts(input)[0].id === "b" && input[0].id === "a";
    })());
  }

  // ---------------------------------------------------------------- 图案
  section("预警类型 → 图案（SF Symbols）");
  {
    const types = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16"];
    check("代码表里的 16 种类型每一种都有专门的图案（不是通用的）", types.every((type) => alertSymbol("", type + "01") !== GENERIC_SYMBOL && alertSymbol(labelFromCode(type + "01") ?? "", "") !== GENERIC_SYMBOL));
    check("16 种类型的图案各自不同的有 12 种以上（暴雪 / 冰雹这类相近的可以撞）", new Set(types.map((type) => alertSymbol("", type + "01"))).size >= 12);
    check("名字优先：暴雨、大风、台风、雷电、高温、寒潮、霜冻、大雾、霾、沙尘暴", [
      ["暴雨橙色预警", "cloud.heavyrain.fill"],
      ["大风蓝色预警", "wind"],
      ["台风红色预警", "hurricane"],
      ["雷电黄色预警", "cloud.bolt.fill"],
      ["高温橙色预警", "thermometer.sun.fill"],
      ["寒潮蓝色预警", "thermometer.snowflake"],
      ["霜冻蓝色预警", "snowflake"],
      ["大雾黄色预警", "cloud.fog.fill"],
      ["霾黄色预警", "smoke.fill"],
      ["沙尘暴橙色预警", "sun.dust.fill"],
    ].every(([label, symbol]) => alertSymbol(label, "") === symbol));
    check("说得更具体的排前面：雷雨大风不被「大风」「雷电」抢走，台风不被「大风」抢走", alertSymbol("雷雨大风橙色预警", "") === "cloud.bolt.rain.fill" && alertSymbol("海上雷雨大风黄色预警", "") === "cloud.bolt.rain.fill" && alertSymbol("台风橙色预警", "") === "hurricane");
    check("道路结冰 / 道路冰雪 / 森林火险 / 暴雪 / 冰雹 / 干旱", alertSymbol("道路结冰黄色预警", "") === "snowflake" && alertSymbol("道路冰雪蓝色预警", "") === "snowflake" && alertSymbol("森林火险橙色预警", "") === "flame.fill" && alertSymbol("暴雪红色预警", "") === "cloud.snow.fill" && alertSymbol("冰雹橙色预警", "") === "cloud.hail.fill" && alertSymbol("干旱黄色预警", "") === "sun.max.fill");
    check("名字里没有「风」字乱匹配：地质灾害气象风险 → 通用图案，不是大风的", alertSymbol("地质灾害气象风险黄色预警", "") === GENERIC_SYMBOL && alertSymbol("山洪灾害气象风险橙色预警", "") === "cloud.heavyrain.fill");
    check("示例预警的名字带「示例·」前缀，照样认得出图案", alertSymbol("示例·暴雨橙色预警", "0203") === "cloud.heavyrain.fill" && alertSymbol("示例·大风蓝色预警", "0501") === "wind");
    check("名字认不出就看代码前两位的类型；都认不出是通用图案", alertSymbol("某某提示", "0501") === "wind" && alertSymbol("某某提示", "") === GENERIC_SYMBOL && alertSymbol("某某提示", "9901") === GENERIC_SYMBOL && alertSymbol("", "") === GENERIC_SYMBOL);
    check("通用图案不是三角形（不再用那个像 emoji 的警告符号）", !GENERIC_SYMBOL.includes("triangle"));
    check("所有图案名都是合法的 SF Symbols 写法（小写字母、数字、点）", [GENERIC_SYMBOL, ...types.map((type) => alertSymbol("", type + "01"))].every((name) => /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(name)));
    check("徽章里的图案跟着预警走：最高的那条是雷电红色预警 → 闪电云", alertView({ kind: "ok", items, fetchedAt: T0, failure: null }, T0)?.symbol === "cloud.bolt.fill");
  }

  // ---------------------------------------------------------------- 缓存里读回来
  section("存下来的预警读回来");
  {
    check("存了再读：每一项一字不差", JSON.stringify(parseStoredAlerts(JSON.parse(JSON.stringify(items)))) === JSON.stringify(items));
    check("不是数组：null；数组里坏的条目丢掉、好的留着", parseStoredAlerts(null) === null && parseStoredAlerts({}) === null && parseStoredAlerts([null, 3, { id: "" }, { id: "x", title: "" }, { id: "x", title: "甲" }])?.length === 1);
    check("读回来的级别不认识：unknown；没有短名字：重新算", (() => {
      const [one] = parseStoredAlerts([{ id: "x", title: "海淀区气象台发布大风蓝色预警", level: "purple", code: "0501" }]) ?? [];
      return one !== undefined && one.level === "unknown" && one.label === "大风蓝色预警";
    })());
  }

  // ---------------------------------------------------------------- 预警状态
  section("预警的状态：从取天气的结果里推出来");
  {
    if (FORECAST === null) throw new Error("天气样例读不出来");
    const snapshot = (list: AlertItem[] | null, failure: Failure | null = null): AlertSnapshot => ({
      items: list,
      failure: failure === null ? null : { at: T0, reason: failure.reason, message: failure.message },
    });
    const loaded = (alerts: AlertSnapshot | null, overrides: Partial<Extract<Loaded, { kind: "ok" }>> = {}): Loaded => ({
      kind: "ok",
      forecast: FORECAST,
      extras: null,
      alerts,
      provider: "caiyun",
      fetchedAt: T0,
      place: "北京市",
      source: "live",
      refreshFailed: false,
      failure: null,
      ...overrides,
    });
    const okState = (state: AlertState) => (state.kind === "ok" ? state : null);

    const withItems = okState(alertStateOf(loaded(snapshot(items)), T0, 0));
    check("读懂了、有预警：ok，条目和取到的时刻都是缓存里的", withItems !== null && withItems.items.length === 5 && withItems.fetchedAt === T0 && withItems.failure === null);
    const none = okState(alertStateOf(loaded(snapshot([])), T0, 0));
    check("读懂了、现在没有预警：ok 且条目为空（不是 failed，也不是 off）", none !== null && none.items.length === 0 && none.failure === null);
    const stale = okState(alertStateOf(loaded(snapshot(items), { refreshFailed: true, failure: { reason: "network", message: "联网失败" } }), T0 + minutes(40), 0));
    check("这次刷新没成功、用的是缓存里的预警：ok，带着「联网失败」", stale !== null && stale.items.length === 5 && stale.failure !== null && stale.failure.reason === "network" && stale.fetchedAt === T0);
    const staleToken = okState(alertStateOf(loaded(snapshot(items), { refreshFailed: true, failure: { reason: "token", message: failureMessage("token") } }), T0 + minutes(40), 0));
    check("这次没成功的原因是 token 无效：预警状态里也说 token 无效（不一律说联网失败）", staleToken !== null && staleToken.failure !== null && staleToken.failure.reason === "token" && staleToken.failure.message === failureMessage("token"));
    const staleUnknown = okState(alertStateOf(loaded(snapshot(items), { refreshFailed: true, failure: null }), T0 + minutes(40), 0));
    check("没成功、但没记下原因：当联网失败", staleUnknown !== null && staleUnknown.failure !== null && staleUnknown.failure.reason === "network");
    const missing = alertStateOf(loaded(snapshot(null, { reason: "missing", message: failureMessage("missing") })), T0, 0);
    check("接口没给预警字段：failed，原因是 missing，说「接口没有返回预警数据」", missing.kind === "failed" && missing.failure.reason === "missing" && missing.failure.message === "接口没有返回预警数据");
    const unreadable = alertStateOf(loaded(snapshot(null, { reason: "format", message: failureMessage("format") })), T0, 0);
    check("有预警字段但读不懂：failed，原因是 format", unreadable.kind === "failed" && unreadable.failure.reason === "format");
    check("既没有条目、也没有失败记录（缓存被改坏）：当读不懂，别当成没有预警", (() => { const s = alertStateOf(loaded({ items: null, failure: null }), T0, 0); return s.kind === "failed" && s.failure.reason === "format"; })());

    check("备用来源（Open-Meteo）没有预警：off", alertStateOf(loaded(null, { provider: "openmeteo" }), T0, 0).kind === "off" && alertStateOf(loaded(snapshot(items), { provider: "openmeteo" }), T0, 0).kind === "off");
    check("彩云来源但缓存里没有预警这一项（老缓存）：off", alertStateOf(loaded(null), T0, 0).kind === "off");
    check("没位置 / 没数据：off", alertStateOf({ kind: "noLocation" }, T0, 0).kind === "off" && alertStateOf({ kind: "noData", source: "live", place: null, failure: null }, T0, 0).kind === "off");

    // 预览预警样式
    const demo = okState(alertStateOf({ kind: "noLocation" }, T0, T0 + ALERT_DEMO_MS));
    check("预览样式开着：不管有没有位置、用的是哪个来源，都给两条写着「示例」的预警", demo !== null && demo.items.length === 2 && demo.items.every((item) => item.label.startsWith("示例")) && demo.fetchedAt === T0);
    check("预览样式对备用来源也生效（好在真机上看徽章）", okState(alertStateOf(loaded(null, { provider: "openmeteo" }), T0, T0 + minutes(5)))?.items.length === 2);
    check("差一毫秒到点：还在预览；到点（含整点）就关", alertStateOf(loaded(snapshot([])), T0, T0 + 1).kind === "ok" && okState(alertStateOf(loaded(snapshot([])), T0, T0 + 1))?.items.length === 2 && okState(alertStateOf(loaded(snapshot([])), T0, T0))?.items.length === 0);
    check("预览时长是 10 分钟", ALERT_DEMO_MS === 10 * 60 * 1000);
    check("示例预警：来源写着示例数据、描述说明不是真的、名字前写着「示例」，不会和真的搞混", DEMO_ALERTS.length === 2 && DEMO_ALERTS.every((item) => item.source === "示例数据" && item.description.includes("不是真的") && item.title.startsWith("示例") && item.label.startsWith("示例")));
    check("示例预警：一橙一蓝（徽章会亮橙的，还带「+1」）", alertView({ kind: "ok", items: DEMO_ALERTS.slice(), fetchedAt: T0, failure: null }, T0)?.text === "示例·暴雨橙色预警 +1");
    check("示例预警的级别和代码对得上", DEMO_ALERTS.every((item) => levelFromCode(item.code) === item.level));

    // 和天气一起取
    const deps = (alerts: AlertSnapshot | null, demoUntil: number, provider: "caiyun" | "openmeteo" = "caiyun"): EverythingDeps => ({
      now: () => T0,
      readCache: () => null,
      writeCache: () => undefined,
      readLocation: () => null,
      writeLocation: () => undefined,
      liveLocation: async () => BEIJING,
      provider: () => provider,
      fetchWeather: async () => ({ forecast: clone(FORECAST), extras: null, alerts }),
      reverseName: async () => "北京市",
      demoUntil: () => demoUntil,
    });
    const input = { settings: defaultSettings(), parameter: null, force: false };
    const both = await loadEverything(deps(snapshot(items), 0), input);
    check("一次取到天气和预警：天气 ok、预警 ok、条目是同一次请求带回来的", both.weather.kind === "ok" && both.alerts.kind === "ok" && both.alerts.items.length === 5);
    const missingBoth = await loadEverything(deps(snapshot(null, { reason: "missing", message: failureMessage("missing") }), 0), input);
    check("预警没取到不牵连天气：天气照常，预警是 failed", missingBoth.weather.kind === "ok" && missingBoth.alerts.kind === "failed");
    const demoBoth = await loadEverything(deps(snapshot([]), T0 + ALERT_DEMO_MS), input);
    check("预览样式在这一步接进来", demoBoth.alerts.kind === "ok" && demoBoth.alerts.items.length === 2);
    const backup = await loadEverything(deps(null, 0, "openmeteo"), input);
    check("备用来源：天气照常，预警 off", backup.weather.kind === "ok" && backup.alerts.kind === "off");
    const lost = await loadEverything({ ...deps(snapshot(items), 0), liveLocation: async () => null }, input);
    check("没有位置：天气是 noLocation，预警是 off", lost.weather.kind === "noLocation" && lost.alerts.kind === "off");
  }

  // ---------------------------------------------------------------- 卡片上说什么
  section("卡片上的预警");
  {
    const okAlerts = (list: readonly AlertItem[], fetchedAt: number, failure: Failure | null = null): AlertState => ({ kind: "ok", items: list.slice(), fetchedAt, failure });
    const view = alertView(okAlerts(items, T0), T0 + minutes(5));
    check("亮出级别最高的一条：红色、雷电红色预警，另外还有 4 条", view !== null && view.level === "red" && view.label === "雷电红色预警" && view.more === 4 && view.text === "雷电红色预警 +4");
    check("只有一条时不带 +N", alertView(okAlerts([items[4]], T0), T0)?.text === "大风蓝色预警");
    check("传进来顺序乱的，也亮级别最高的", alertView(okAlerts(items.slice().reverse(), T0), T0)?.label === "雷电红色预警");
    check("没有预警（空）、off、failed：不亮", alertView(okAlerts([], T0), T0) === null && alertView({ kind: "off" }, T0) === null && alertView({ kind: "failed", failure: { reason: "network", message: "联网失败" } }, T0) === null);
    check("取到的时刻超过 3 小时：不亮（几个小时前的预警随时可能已经解除）", alertView(okAlerts(items, T0), T0 + ALERT_MAX_AGE_MS) === null && alertView(okAlerts(items, T0), T0 + ALERT_MAX_AGE_MS - 1000) !== null);
    check("取到的时刻在未来（时钟被往回拨过）：不亮", alertView(okAlerts(items, T0 + hours(1)), T0) === null);
    check("取到的时刻只比「现在」晚几秒（取数据和画出来是两次读时钟）：照样亮；晚满一分钟才当成时钟被拨过", alertView(okAlerts(items, T0 + 5000), T0) !== null && alertView(okAlerts(items, T0 + ALERT_CLOCK_SKEW_MS - 1), T0) !== null && alertView(okAlerts(items, T0 + ALERT_CLOCK_SKEW_MS), T0) === null);
    check("联网失败退回缓存（带着失败）：缓存够新就照样亮", alertView(okAlerts(items, T0, { reason: "network", message: "联网失败" }), T0 + hours(1)) !== null);

    if (FORECAST === null) throw new Error("天气样例读不出来");
    const loaded: Loaded = { kind: "ok", forecast: FORECAST, extras: null, alerts: null, provider: "caiyun", fetchedAt: T0, place: "北京市", source: "live", refreshFailed: false, failure: null };
    const withAlert = present(loaded, T0, "compact", okAlerts(items, T0));
    const without = present(loaded, T0, "compact");
    check("present 带上预警：卡片里有 alert，含图案", withAlert.kind === "weather" && withAlert.alert !== null && withAlert.alert.label === "雷电红色预警" && withAlert.alert.symbol === "cloud.bolt.fill");
    check("不传预警（老写法）：alert 是 null，其余一字不差", without.kind === "weather" && without.alert === null && JSON.stringify({ ...without, alert: null }) === JSON.stringify({ ...(withAlert as object), alert: null }));
    check("预警取不到（不管哪种原因，包括接口没返回预警数据）：卡片上没有 alert，也不会冒出「没有预警」之类的话", (["token", "quota", "network", "server", "format", "missing"] as const).every((reason) => {
      const failedCard = present(loaded, T0, "compact", { kind: "failed", failure: { reason, message: failureMessage(reason) } });
      return failedCard.kind === "weather" && failedCard.alert === null && !JSON.stringify(failedCard).includes("没有预警");
    }));

    check("时间文字：今天只写钟点，昨天写「昨天」，更早带日期", (() => {
      const local = (y: number, m: number, d: number, h: number, mi: number) => new Date(y, m - 1, d, h, mi).getTime();
      return whenText(local(2026, 11, 2, 7, 25), local(2026, 11, 2, 20, 0)) === "07:25" && whenText(local(2026, 11, 1, 23, 59), local(2026, 11, 2, 0, 1)) === "昨天 23:59" && whenText(local(2026, 10, 28, 7, 0), local(2026, 11, 2, 8, 0)) === "10-28 07:00";
    })());

    const failureNote: Failure = { reason: "token", message: failureMessage("token") };
    check("状态行：备用来源说一声「备用来源没有预警」（不管之前取到过什么）", alertStatusText(null, false, T0) === "备用来源没有预警" && alertStatusText({ kind: "off" }, false, T0) === "备用来源没有预警" && alertStatusText(okAlerts(items, T0), false, T0) === "备用来源没有预警");
    check("状态行：预览期间写「正在预览示例预警（到 …）」，优先于「备用来源没有预警」", alertStatusText(null, false, T0, T0 + minutes(10)).startsWith("正在预览示例预警（到 ") && alertStatusText(null, false, T0, T0 - 1) === "备用来源没有预警");
    check("状态行：正在取 / 没有位置 / 取不到说原因", alertStatusText(null, true, T0) === "正在取…" && alertStatusText({ kind: "off" }, true, T0) === "没有位置，查不了" && alertStatusText({ kind: "failed", failure: failureNote }, true, T0) === "token 无效，或者没开通");
    check("状态行：接口没返回预警数据时就这么说，不说「没有预警」", (() => {
      const text = alertStatusText({ kind: "failed", failure: { reason: "missing", message: failureMessage("missing") } }, true, T0);
      return text === "接口没有返回预警数据" && !text.includes("没有预警");
    })());
    check("状态行：读懂了没有预警 / 有 N 条，带更新时间", alertStatusText(okAlerts([], T0), true, T0).startsWith("现在没有预警（") && alertStatusText(okAlerts(items, T0), true, T0).startsWith("5 条预警（"));
    check("状态行：用缓存时说清楚「这次没取成功」和原因", alertStatusText(okAlerts(items, T0, failureNote), true, T0 + minutes(5)).includes("这次没取成功：token 无效"));

    check("测试结果的话：没位置 / 没取成功 / 这次没取成功 / 预警没取到 / 没有预警 / 有 N 条 / 备用来源", (() => {
      const good: Loaded = { ...loaded };
      return (
        sourceTestMessage({ kind: "noLocation" }, { kind: "off" }).includes("没有位置") &&
        sourceTestMessage({ kind: "noData", source: "live", place: null, failure: failureNote }, { kind: "off" }) === "没取成功\ntoken 无效，或者没开通" &&
        sourceTestMessage({ kind: "noData", source: "live", place: null, failure: null }, { kind: "off" }) === "没取成功\n联网失败" &&
        sourceTestMessage({ ...good, refreshFailed: true, failure: failureNote }, okAlerts(items, T0)).startsWith("这次没取成功\ntoken") &&
        sourceTestMessage(good, { kind: "failed", failure: { reason: "missing", message: failureMessage("missing") } }) === "天气取到了，预警没取成功\n接口没有返回预警数据" &&
        sourceTestMessage(good, okAlerts([], T0)) === "接口可用\n当前位置现在没有预警" &&
        sourceTestMessage(good, okAlerts(items, T0)) === "接口可用\n当前位置有 5 条预警" &&
        sourceTestMessage({ ...good, provider: "openmeteo" }, { kind: "off" }) === "接口可用"
      );
    })());
  }

  // ---------------------------------------------------------------- 配色
  section("预警徽章的配色：图案压在底色上");
  {
    const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
    const rgb = (hex: string): [number, number, number] => [channel(hex, 0), channel(hex, 1), channel(hex, 2)];
    const linear = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const ratio = (a: [number, number, number], b: [number, number, number]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const levels = Object.keys(ALERT_BADGE) as Array<keyof typeof ALERT_BADGE>;
    check("六种级别（蓝黄橙红白、读不出）都有底色", levels.length === 6 && ["blue", "yellow", "orange", "red", "white", "unknown"].every((level) => level in ALERT_BADGE));
    check("颜色都是 #RRGGBB", levels.every((level) => [ALERT_BADGE[level].top, ALERT_BADGE[level].bottom, ALERT_BADGE[level].glyph].every((hex) => /^#[0-9A-F]{6}$/.test(hex))));
    let worstGlyph = Infinity;
    for (const level of levels) {
      const { top, bottom, glyph } = ALERT_BADGE[level];
      worstGlyph = Math.min(worstGlyph, ratio(rgb(glyph), rgb(top)), ratio(rgb(glyph), rgb(bottom)));
    }
    check(`图案压在每一种底色的上端和下端 ≥ 3:1（图形元素的最低要求；最差 ${worstGlyph.toFixed(2)}）`, worstGlyph >= 3);
    check("底色上浅下深（竖着一点渐变）：每一级的上端都不比下端暗", levels.every((level) => luminance(rgb(ALERT_BADGE[level].top)) >= luminance(rgb(ALERT_BADGE[level].bottom))));
    check("红底用白色图案、其余用近黑色（和国内预警信号的样子一致，也是对比度最高的选法）", ALERT_BADGE.red.glyph === "#FFFFFF" && ALERT_BADGE.blue.glyph === ALERT_INK && ALERT_BADGE.yellow.glyph === ALERT_INK && ALERT_BADGE.orange.glyph === ALERT_INK && ALERT_BADGE.white.glyph === ALERT_INK);
    check("读不出级别的用黄色（排序也按黄色，颜色和排名对得上）", JSON.stringify(ALERT_BADGE.unknown) === JSON.stringify(ALERT_BADGE.yellow) && rankOf("unknown") === rankOf("yellow"));
    check("蓝色用浅蓝：压在晴天的蓝色天空上，底色的亮度要比天空的亮度高出一截（≥ 1.8:1），不会融进去", (() => {
      const blue = rgb(ALERT_BADGE.blue.bottom);
      return Object.values(SKY).every((pair) => Object.values(pair).every(([topHex, bottomHex]) => ratio(blue, rgb(topHex)) >= 1.8 && ratio(blue, rgb(bottomHex)) >= 1.8));
    })());
    let worstEdge = Infinity;
    for (const level of levels) {
      for (const pair of Object.values(SKY)) {
        for (const [topHex, bottomHex] of Object.values(pair)) {
          worstEdge = Math.min(worstEdge, ratio(rgb(ALERT_BADGE[level].bottom), rgb(topHex)), ratio(rgb(ALERT_BADGE[level].bottom), rgb(bottomHex)));
        }
      }
    }
    console.log(`    · 徽章底色（下端）和天空色的亮度比：最小 ${worstEdge.toFixed(2)}:1（边缘还有一圈淡淡的亮线托着）`);
    check("各级别的底色彼此分得开：蓝、黄、橙、红两两不同", new Set([ALERT_BADGE.blue.bottom, ALERT_BADGE.yellow.bottom, ALERT_BADGE.orange.bottom, ALERT_BADGE.red.bottom]).size === 4);
  }

  // ---------------------------------------------------------------- 源码扫描
  section("源码扫描：token 不进脚本、不进日志，内置接口的地址只写一处");
  {
    const files = sourceFiles(SCRIPT_DIR);
    const read = (file: string) => readFileSync(file, "utf8");
    const all = files.map(read).join("\n");
    const code = files
      .map((file) => read(file).split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n"))
      .join("\n");

    check("没有把彩云文档页上的演示 token 写进脚本", !all.includes("TAkhjf8d1nlSlspN"));
    check("没有任何看着像 token 的字符串字面量（16 位字母数字，混了大小写和数字）", !/["'`][A-Za-z0-9]{16}["'`]/.test(code.replace(/["'`](?:[a-z]+|[A-Z]+|\d+)["'`]/g, "")));
    check("脚本里没有 console.log / console.info（token 和位置不进日志）", !/console\.(log|info|debug|warn|error)/.test(code));
    check("彩云官方的地址只在 caiyun.ts 的代码里写一次（别处用 OFFICIAL_HOST）", files.filter((file) => /api\.caiyunapp\.com/.test(read(file).split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n"))).length === 1);
    check("没有用文档 servers 里那套 singer.caiyunhub.com（只在注释里解释过为什么不用）", !/singer\.caiyunhub\.com/.test(code));

    // 内置接口的地址：只写在 caiyun.ts 里一处，界面、文档、自测、对拍数据里都不出现
    const hostName = BUILTIN_HOST.replace(/^https:\/\//, "");
    const caiyunSource = read(join(SCRIPT_DIR, "core", "caiyun.ts"));
    check("内置接口的地址只在 caiyun.ts 里写一次（一个源码文件、一处）", files.filter((file) => read(file).includes(hostName)).length === 1 && caiyunSource.split(hostName).length - 1 === 1);
    // 工作区里有 README / NOTICE / tsconfig；发布到公开仓库后 README 和 NOTICE 不在脚本目录里，改成 docs/天气小组件.md。有哪份就扫哪份
    const candidates = [join(SCRIPT_DIR, "README.md"), join(SCRIPT_DIR, "NOTICE.md"), join(SCRIPT_DIR, "script.json"), join(HERE, "..", "docs", "天气小组件.md"), join(HERE, "weather-widget.test.ts"), join(HERE, "weather-widget-alerts.test.ts"), join(HERE, "weather-widget-caiyun.test.ts"), join(HERE, "weather-widget-render.test.ts"), join(HERE, "weather-widget-render.stub.ts"), join(HERE, "weather-widget.tsconfig.json"), ...readdirSync(GOLDEN_DIR).filter((name) => name !== "golden.json").map((name) => join(GOLDEN_DIR, name))];
    const others = candidates.filter((file) => existsSync(file));
    check("README / NOTICE / 文档页、script.json、四份自测（含画面层那份和它的假环境）、对拍数据里都没有内置接口的地址（用户要求不写出来）", others.length >= 7 && others.every((file) => !readFileSync(file, "utf8").includes(hostName)));

    const widgetFiles = files.filter((file) => /[\\/](widget\.tsx|widget[\\/][^\\/]+)$/.test(file));
    const widgetCode = widgetFiles.map(read).join("\n");
    check("小组件那条路上没有读写数据来源、没有写存储的调用（它只通过 core 取数据）", !/readDataSource|writeDataSource|Storage\./.test(widgetCode));
    check("widget.tsx：「现在」是查完之后才读的（先读的话刚取到的预警会被当成在未来、徽章不亮）", (() => {
      const entry = read(join(SCRIPT_DIR, "widget.tsx"));
      return entry.indexOf("await loadEverything(") >= 0 && entry.indexOf("Date.now()") > entry.indexOf("await loadEverything(");
    })());
    check("自定义组件的 prop 不叫 `alert`（和视图通用属性撞名，类型会变成交叉）", !/\balert=\{/.test(widgetCode) && !/\{\s*alert\s*,/.test(widgetCode) && !/\{\s*alert:\s*AlertView/.test(widgetCode));
    check("没有预警时底部不提彩云：卡片底部不写署名、不写更新时间（用户嫌不好看）", !/Open-Meteo\.com|预警 彩云天气|更新/.test(widgetCode.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));

    const partsCode = read(join(SCRIPT_DIR, "widget", "parts.tsx"));
    const badgeCode = read(join(SCRIPT_DIR, "widget", "badge.tsx"));
    const bodiesCode = read(join(SCRIPT_DIR, "widget", "bodies.tsx"));
    const alertsPage = read(join(SCRIPT_DIR, "pages", "AlertsSection.tsx"));
    const sourcePage = read(join(SCRIPT_DIR, "pages", "SourceSection.tsx"));
    const indexCode = read(join(SCRIPT_DIR, "index.tsx"));
    const codeOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
    check("徽章不用 widgetBackground（染色模式下它会被藏起来）；用圆角方块 + 渐变填充 + 一圈淡亮线", !/widgetBackground/.test(codeOf(badgeCode)) && /RoundedRectangle/.test(badgeCode) && /alertBadge\(level\)/.test(badgeCode) && /ALERT_RIM/.test(badgeCode));
    check("徽章、预警行里没有三角形警告符号（不再用那个像 emoji 的图标）", !/triangle/.test(codeOf(partsCode)) && !/triangle/.test(codeOf(badgeCode)) && !/triangle/.test(codeOf(alertsPage)));
    check("锁屏：只有圆形里还用三角（单色、通用的警告符号，圆形里没地方写字）", (read(join(SCRIPT_DIR, "widget", "accessory.tsx")).match(/exclamationmark\.triangle/g) ?? []).length === 1);
    // bodies.tsx：小号（换最高最低）、大号有详细数据、大号没有详细数据（都在地名那一行）；中号的右上那一行在 parts.tsx 的 TopLine 里，两种样式各一处
    check("徽章放的位置：小号换最高最低、中号换右上那一行里的降水概率（或风和湿度）、大号在地名那一行", (bodiesCode.match(/<AlertChip/g) ?? []).length === 3 && (partsCode.match(/<AlertChip/g) ?? []).length === 2);
    check("来源有三个选项：内置、自己的、Open-Meteo（备用）", /tag="builtin"/.test(sourcePage) && /tag="custom"/.test(sourcePage) && /tag="openmeteo"/.test(sourcePage));
    check("只在选了「自己的」时才出现地址和 token 输入框", /custom \? \(\s*<TextField/.test(sourcePage) && /custom \? \(\s*<SecureField/.test(sourcePage));
    check("数据来源里写了「001 提供 API 接口」，没有写地址", /001 提供 API 接口/.test(indexCode) && !indexCode.includes(hostName) && !sourcePage.includes(hostName) && !alertsPage.includes(hostName));
    check("彩云文档的出处写了：小麦（Telegram @GetSomeTriticum）", /彩云相关文档来自小麦/.test(indexCode) && /@GetSomeTriticum/.test(indexCode));
    check("Open-Meteo 的限制写了：只能非商用、每分钟 600 / 每小时 5000 / 每天 10000 / 每月 30 万次", /只能非商用/.test(indexCode) && /每分钟 600 次/.test(indexCode) && /每小时 5000 次/.test(indexCode) && /每天 10000 次/.test(indexCode) && /每月 30 万次/.test(indexCode));
    check("天气来源那一节写了「001 提供」，内置的不多解释", /001 提供/.test(sourcePage));
  }

  console.log("\n" + passed + " 项通过，" + failed + " 项失败");
  if (failed > 0) process.exit(1);
}

void main();
