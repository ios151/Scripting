// 离线自测（Node 里跑，不碰 Scripting 的原生 API，也不联网）：天气小组件的彩云数据层。
//   npx -y -p tsx tsx _selftest/weather-widget-caiyun.test.ts
//   类型检查：看仓库根的 tsconfig.json（只管脚本目录）；自测文件自己更严的那份 tsconfig 在作者本地，没放进仓库
//
// 默认的天气来源是内置的彩云接口（001 提供）：一次请求带回实况、逐小时、每天、空气质量、生活指数和预警。
//   · 样例 weather-widget-golden/caiyun_weather_sample.json 是拿内置接口实测取来的一份真实返回（北京，2026-11-02 晚上九点多）；
//     它和文档有几处对不上（晚上也写「晴（白天）」、没有每天的日出日落、今天的最高最低只算剩下的几个小时、逐小时的时间不在整点），
//     整理那一步（core/caiyunWeather.ts）把这几处兜住了，这里每一处都有用例；
//   · 日出日落和昼夜按经纬度自己算：拿 Open-Meteo 给的日出日落和几个已知的日子对过；
//   · 联网换成假的 fetch：状态码、错误说明、解析失败各走一遍；一次真实请求都没发过；
//   · 数据来源的设置、存储（假的 Storage）、详细数据怎么说成人话（风力等级、空气质量、未来几天）。
// 预警本身（读返回、级别、排序、状态、徽章）在 weather-widget-alerts.test.ts 里。
// 画面（版式、图标）这里看不到，只能上真机。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { adaptCaiyun, formatLocal } from "../天气小组件/core/caiyunWeather";
import { BUILTIN_HOST, BUILTIN_TOKEN, OFFICIAL_HOST, buildWeatherURL, cleanHost, cleanToken, fetchCaiyun, type Endpoint } from "../天气小组件/core/caiyun";
import { SKY } from "../天气小组件/core/palette";
import { codeForSkycon, conditionFor, extensionCodes, knownCodes, knownSkycons } from "../天气小组件/core/condition";
import { defaultSource, endpointOf, parseSource, providerOf, type DataSource } from "../天气小组件/core/dataSource";
import { aqiBand, aqiName, aqiShortName, emptyExtras, parseExtras, windDirectionName, windLevel, type DayForecast, type Extras } from "../天气小组件/core/extras";
import { FAILURE_REASONS, FetchError, classifyFailure, describeFailure, failureMessage } from "../天气小组件/core/failure";
import type { Forecast } from "../天气小组件/core/forecast";
import type { Coord } from "../天气小组件/core/geo";
import type { Loaded } from "../天气小组件/core/load";
import { DEMO_ALERTS } from "../天气小组件/core/alerts";
import { LARGE_DAYS, MEDIUM_DAYS, detailOf, effectiveDisplay, present, sourceStatusText, updatedText, visibilityText, weekdayOf, windText, type Content } from "../天气小组件/core/present";
import { defaultDisplay, parseDisplay, sameDisplay, type Display } from "../天气小组件/core/display";
import { FOLD_IDS, parseFolds, setFold, type Folds } from "../天气小组件/core/folds";
import { NOTABLE_CHANGE, changeText, headlineText, nextSunEvent, temperatureChange } from "../天气小组件/core/headline";
import { layoutVariant } from "../天气小组件/core/layout";
import { buildSnapshot } from "../天气小组件/core/snapshot";
import { clearData, clearDemo, loadDisplay, loadFolds, readCache, readDataSource, readDemoUntil, readLocation, writeCache, writeDataSource, saveDisplay, saveFolds, writeDemoUntil, writeLocation } from "../天气小组件/core/store";
import { isDaylight, localDate, sunTimes } from "../天气小组件/core/sun";

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

type Json = Record<string, unknown>;
const SAMPLE = JSON.parse(readFileSync(join(GOLDEN_DIR, "caiyun_weather_sample.json"), "utf8")) as Json;
const ALERT_SAMPLE = JSON.parse(readFileSync(join(GOLDEN_DIR, "caiyun_alert_sample.json"), "utf8")) as Json;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 一天的预报；风、湿度、空气、紫外线不写就是接口没给 */
function dayOf(date: string, high: number, low: number, code: number | null, rainChance: number | null, more: Partial<DayForecast> = {}): DayForecast {
  return { date, high, low, code, rainChance, wind: null, humidity: null, aqi: null, uv: null, ...more };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const BEIJING: Coord = { latitude: 39.9, longitude: 116.4 };
/** 样例取到的时刻：接口的 server_time（秒）→ 毫秒，当地是 2026-11-02 21:22:55 */
const NOW = (SAMPLE.server_time as number) * 1000;
const OFFSET = SAMPLE.tzshift as number;
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;

/** 在样例的副本上动手脚 */
function variant(change: (copy: { result: Json } & Json) => void): Json {
  const copy = clone(SAMPLE) as { result: Json } & Json;
  change(copy);
  return copy;
}

function adapt(raw: unknown, overrides: { coord?: Coord; now?: number; previous?: Forecast | null } = {}) {
  return adaptCaiyun(raw, { coord: overrides.coord ?? BEIJING, now: overrides.now ?? NOW, previous: overrides.previous ?? null });
}

function adaptOk(raw: unknown, overrides: { coord?: Coord; now?: number; previous?: Forecast | null } = {}) {
  const adapted = adapt(raw, overrides);
  if (adapted === null) throw new Error("应该读得出来");
  return adapted;
}

type Fake = (url: string, init?: { timeout?: number }) => Promise<unknown>;
function withFetch(impl: Fake): void {
  (globalThis as unknown as { fetch: unknown }).fetch = impl;
}
function reply(status: number, body: unknown): Fake {
  return async () => ({ status, json: async () => clone(body) });
}

async function main(): Promise<void> {
  const realFetch = (globalThis as unknown as { fetch: unknown }).fetch;
  const base = adaptOk(SAMPLE);

  // ---------------------------------------------------------------- 天气现象
  section("天气现象：彩云的 skycon → 这边的代码、文字、图标");
  {
    const DOC = ["CLEAR_DAY", "CLEAR_NIGHT", "PARTLY_CLOUDY_DAY", "PARTLY_CLOUDY_NIGHT", "CLOUDY", "LIGHT_HAZE", "MODERATE_HAZE", "HEAVY_HAZE", "LIGHT_RAIN", "MODERATE_RAIN", "HEAVY_RAIN", "STORM_RAIN", "FOG", "LIGHT_SNOW", "MODERATE_SNOW", "HEAVY_SNOW", "STORM_SNOW", "DUST", "SAND", "WIND"];
    check("文档里的 20 种天气现象每一种都认得", DOC.every((skycon) => codeForSkycon(skycon) !== null) && DOC.every((skycon) => knownSkycons().includes(skycon)));
    check("每一种都对得到一个有名字的天气（不是「未知」）", DOC.every((skycon) => conditionFor(codeForSkycon(skycon) as number, true).text !== "未知"));
    const text = (skycon: string) => conditionFor(codeForSkycon(skycon) as number, true).text;
    check("文字：晴、多云、阴、雾、大风、浮尘、沙尘", text("CLEAR_DAY") === "晴" && text("PARTLY_CLOUDY_NIGHT") === "多云" && text("CLOUDY") === "阴" && text("FOG") === "雾" && text("WIND") === "大风" && text("DUST") === "浮尘" && text("SAND") === "沙尘");
    check("文字：小雨 中雨 大雨 暴雨、小雪 中雪 大雪 暴雪", ["LIGHT_RAIN", "MODERATE_RAIN", "HEAVY_RAIN", "STORM_RAIN", "LIGHT_SNOW", "MODERATE_SNOW", "HEAVY_SNOW", "STORM_SNOW"].map(text).join() === "小雨,中雨,大雨,暴雨,小雪,中雪,大雪,暴雪");
    check("文字：霾分三级（轻度霾 中度霾 重度霾，不写「雾霾」，卡片上放得下）", ["LIGHT_HAZE", "MODERATE_HAZE", "HEAVY_HAZE"].map(text).join() === "轻度霾,中度霾,重度霾");
    check("晴和多云的白天 / 夜间写法是同一个代码，昼夜由调用方另外算", codeForSkycon("CLEAR_DAY") === codeForSkycon("CLEAR_NIGHT") && codeForSkycon("PARTLY_CLOUDY_DAY") === codeForSkycon("PARTLY_CLOUDY_NIGHT"));
    check("昼夜：晴白天是太阳、夜里是月亮；霾白天 / 夜里不同", conditionFor(0, true).symbol === "sun.max.fill" && conditionFor(0, false).symbol === "moon.stars.fill" && conditionFor(1001, true).symbol === "sun.haze.fill" && conditionFor(1001, false).symbol === "moon.haze.fill");
    check("老版本接口里有、文档里没有的几种也认：雷阵雨 / 冰雹 / 雨夹雪", conditionFor(codeForSkycon("THUNDER_SHOWER") as number, true).text === "雷阵雨" && conditionFor(codeForSkycon("HAIL") as number, true).text === "冰雹" && conditionFor(codeForSkycon("SLEET") as number, true).text === "雨夹雪");
    check("不认识的、不是字符串的、原型链上的名字：都是 null，不冒充晴", ["ALIEN", "", "clear_day", "toString", "__proto__", "constructor"].every((skycon) => codeForSkycon(skycon) === null) && [null, undefined, 0, {}, []].every((value) => codeForSkycon(value) === null));
    check("扩展代码都在 1000 以上、有名字、有天空色；和 Swift 对拍的 28 个 WMO 代码没混在一起", extensionCodes().every((code) => code >= 1000 && conditionFor(code, true).text !== "未知" && conditionFor(code, true).sky in SKY) && knownCodes().length === 28 && knownCodes().every((code) => code < 1000));
    check("1000 以下没有的代码、扩展里没有的代码，仍是「未知」", conditionFor(999, true).text === "未知" && conditionFor(1099, true).text === "未知");
    check("借用 WMO 的几个代码文字对得上彩云的叫法：61 小雨、63 中雨、65 大雨、45 雾、71 小雪、73 中雪、75 大雪", [61, 63, 65, 45, 71, 73, 75].map((code) => conditionFor(code, true).text).join() === "小雨,中雨,大雨,雾,小雪,中雪,大雪");
    // 天空色按天气类别选：雨雪雾雷各用各的，背景才和天气对得上（暴雪不能落到雨的天空上）
    check("扩展代码各用哪种天空：霾 / 浮尘 / 沙尘 → 雾，暴雨 / 雨夹雪 → 雨，暴雪 → 雪，大风 → 多云，雷阵雨 / 冰雹 → 雷暴", ([[1001, "fog"], [1002, "fog"], [1003, "fog"], [1004, "rain"], [1005, "snow"], [1006, "fog"], [1007, "fog"], [1008, "partly"], [1009, "storm"], [1010, "storm"], [1011, "rain"]] as const).every(([code, sky]) => conditionFor(code, true).sky === sky && conditionFor(code, false).sky === sky));
    check("彩云的天气现象各落在哪种天空：晴 / 多云 / 阴 / 雨 / 雪 / 雾", ([["CLEAR_DAY", "clear"], ["PARTLY_CLOUDY_DAY", "partly"], ["CLOUDY", "overcast"], ["LIGHT_RAIN", "rain"], ["HEAVY_RAIN", "rain"], ["LIGHT_SNOW", "snow"], ["HEAVY_SNOW", "snow"], ["STORM_SNOW", "snow"], ["FOG", "fog"]] as const).every(([skycon, sky]) => conditionFor(codeForSkycon(skycon) as number, true).sky === sky));
  }

  // ---------------------------------------------------------------- 日出日落
  section("日出日落和白天黑夜：按经纬度自己算");
  {
    const at = (epoch: number | null, offset: number) => (epoch === null ? Number.NaN : (epoch + offset * 1000) % 86_400_000 / 60_000);
    const near = (epoch: number | null, offset: number, hour: number, minute: number, tolerance: number) => Math.abs(at(epoch, offset) - (hour * 60 + minute)) <= tolerance;
    const cases: Array<[string, number, number, number, number, number, number, [number, number], [number, number], number]> = [
      ["天津 2026-11-02（Open-Meteo 给的：06:39 / 17:09）", 39.12, 117.2, 2026, 11, 2, 8 * 3600, [6, 39], [17, 9], 2],
      ["北京 夏至 2026-06-21（04:46 / 19:46）", 39.9, 116.4, 2026, 6, 21, 8 * 3600, [4, 46], [19, 46], 2],
      ["纽约 2026-11-02（UTC-5）", 40.71, -74.0, 2026, 11, 2, -5 * 3600, [6, 27], [16, 51], 2],
      ["悉尼 2026-11-02（UTC+11，南半球）", -33.87, 151.21, 2026, 11, 2, 11 * 3600, [5, 53], [19, 23], 3],
      ["赤道零度经线 春分 2026-03-20", 0, 0, 2026, 3, 20, 0, [6, 4], [18, 10], 4],
      ["奥克兰 2026-01-01（UTC+13，靠近日期变更线）", -36.85, 174.76, 2026, 1, 1, 13 * 3600, [6, 5], [20, 43], 3],
    ];
    for (const [name, latitude, longitude, year, month, day, offset, rise, set, tolerance] of cases) {
      const sun = sunTimes(latitude, longitude, year, month, day);
      check(`${name}：日出 ${rise.join(":")} 日落 ${set.join(":")}（误差 ≤ ${tolerance} 分钟）`, sun.polar === null && near(sun.sunrise, offset, rise[0], rise[1], tolerance) && near(sun.sunset, offset, set[0], set[1], tolerance));
    }
    const night = sunTimes(69.65, 18.96, 2026, 12, 21);
    const day = sunTimes(69.65, 18.96, 2026, 6, 21);
    check("极夜 / 极昼：没有日出日落，说明是整天黑夜还是整天白天", night.polar === "night" && night.sunrise === null && night.sunset === null && day.polar === "day" && day.sunrise === null);
    check("极夜里整天是黑夜，极昼里整天是白天", !isDaylight(69.65, 18.96, Date.UTC(2026, 11, 21, 11), 3600) && isDaylight(69.65, 18.96, Date.UTC(2026, 5, 21, 23), 7200));
    const local = (h: number, m: number) => Date.UTC(2026, 10, 2, h, m) - 8 * 3600 * 1000;
    check("天津 2026-11-02：21:15 是黑夜、12:00 是白天、日出前 06:30 是黑夜、日出后 06:45 是白天", !isDaylight(39.12, 117.2, local(21, 15), 8 * 3600) && isDaylight(39.12, 117.2, local(12, 0), 8 * 3600) && !isDaylight(39.12, 117.2, local(6, 30), 8 * 3600) && isDaylight(39.12, 117.2, local(6, 45), 8 * 3600));
    check("日落前后：17:05 还是白天、17:15 已是黑夜", isDaylight(39.12, 117.2, local(17, 5), 8 * 3600) && !isDaylight(39.12, 117.2, local(17, 15), 8 * 3600));
    check("午夜前后属于哪一天按当地算：UTC 16:30 在 UTC+8 已经是第二天凌晨", (() => { const d = localDate(Date.UTC(2026, 10, 2, 16, 30), 8 * 3600); return d.year === 2026 && d.month === 11 && d.day === 3; })());
    check("每个日期日出都早于日落、白天长度在 0~24 小时之间（抽样 12 个月 × 几个纬度）", (() => {
      for (const latitude of [-45, -10, 0, 23, 40, 55]) {
        for (let month = 1; month <= 12; month++) {
          const sun = sunTimes(latitude, 100, 2026, month, 15);
          if (sun.sunrise === null || sun.sunset === null || sun.sunset <= sun.sunrise || sun.sunset - sun.sunrise > hours(24)) return false;
        }
      }
      return true;
    })());
    check("北半球夏天白天长、冬天短；赤道上全年差不多 12 小时", (() => {
      const length = (lat: number, month: number) => { const s = sunTimes(lat, 0, 2026, month, 15); return (s.sunset as number) - (s.sunrise as number); };
      return length(40, 6) > length(40, 12) + hours(4) && Math.abs(length(0, 3) - hours(12)) < minutes(15) && Math.abs(length(0, 9) - hours(12)) < minutes(15);
    })());
  }

  // ---------------------------------------------------------------- 换算
  section("详细数据的换算：风力等级、风向、空气质量分级");
  {
    // 风力等级各级的下限（m/s）：0.3 1.6 3.4 5.5 8.0 10.8 13.9 17.2 20.8 24.5 28.5 32.7；样例里风速是 km/h，换成 m/s 要除以 3.6
    const floors = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
    check("风力等级：每一级的下限 km/h 刚好差一点是上一级、刚好到是这一级", floors.every((floor, index) => windLevel(floor * 3.6 - 0.01) === index && windLevel(floor * 3.6 + 0.01) === index + 1));
    check("风力等级：0 和很小的风是 0 级，特别大的封顶 12 级", windLevel(0) === 0 && windLevel(1) === 0 && windLevel(300) === 12 && windLevel(117.8) === 12);
    check("风向：八个方位，边界 22.5° 往东北走", ["北", "东北", "东", "东南", "南", "西南", "西", "西北"].every((name, index) => windDirectionName(index * 45) === name) && windDirectionName(22.4) === "北" && windDirectionName(22.5) === "东北" && windDirectionName(337.4) === "西北" && windDirectionName(337.5) === "北");
    check("风向：360 度、负数、超过一圈都折回来", windDirectionName(360) === "北" && windDirectionName(-45) === "西北" && windDirectionName(725) === "北" && windDirectionName(180) === "南");
    check("空气质量分级：50 优、100 良、150 轻度、200 中度、300 重度，再往上严重", [0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301, 500].map(aqiBand).join() === "0,0,1,1,2,2,3,3,4,4,5,5");
    check("空气质量短名（卡片底部那一行用，两个字）：优 良 轻度 中度 重度 严重", [30, 75, 120, 180, 250, 400].map(aqiShortName).join() === "优,良,轻度,中度,重度,严重");
    check("空气质量名字：接口没给文字时补", aqiName(30) === "优" && aqiName(75) === "良" && aqiName(120) === "轻度污染" && aqiName(180) === "中度污染" && aqiName(250) === "重度污染" && aqiName(400) === "严重污染");
    const full: Extras = {
      apparent: 6, humidity: 28, wind: { kmh: 11.9, direction: 193 }, pressure: 1020, visibility: 24.1, cloud: 35, dewpoint: -4,
      aqi: { value: 50, text: "优" }, pollutants: { pm25: 35, pm10: 50, o3: 100, no2: 40, so2: 20, co: 1.2 }, uv: { index: 0, text: "低" },
      keypoint: "今日多云", dayOutlook: "未来24小时多云", rainOutlook: "30 分钟后下雨", rainNote: "30 分钟后下雨",
      life: { dressing: "薄外套", carWashing: "适宜", comfort: "冷", coldRisk: "较易发" },
      days: [dayOf("2026-11-02", 14, 13, 0, 0, { wind: { kmh: 5.07, direction: 295.29 }, humidity: 26, aqi: 35, uv: "低" }), dayOf("2026-11-03", 17, 10, 3, 40, { wind: { kmh: 12, direction: 90 }, humidity: 60, aqi: 80, uv: "强" })],
    };
    check("存下来的详细数据读回来：一字不差", JSON.stringify(parseExtras(clone(full))) === JSON.stringify(full));
    check("存下来的污染物：六项都读不出来就整块当没有；读出几项留几项，别的是 null", parseExtras({ ...clone(full), pollutants: { pm25: "x", co: null } })?.pollutants === null && parseExtras({ ...clone(full), pollutants: {} })?.pollutants === null && parseExtras({ ...clone(full), pollutants: "x" })?.pollutants === null && JSON.stringify(parseExtras({ ...clone(full), pollutants: { pm25: 9, co: "x" } })?.pollutants) === JSON.stringify({ pm25: 9, pm10: null, o3: null, no2: null, so2: null, co: null }));
    check("垃圾当没有；空的详细数据读回来全是 null 和空数组", [null, undefined, 3, "x", []].every((value) => parseExtras(value) === null) && JSON.stringify(parseExtras({})) === JSON.stringify(emptyExtras()));
    check("单项读坏了只丢那一项，别的还在", (() => {
      const got = parseExtras({ ...clone(full), wind: { kmh: "快" }, aqi: 3, humidity: "湿", keypoint: 7, days: "x" });
      if (got !== null && parseExtras({ ...clone(full), wind: { kmh: 3 } })?.wind !== null) return false;
      if (got !== null && parseExtras({ ...clone(full), wind: { kmh: 3, direction: "北" } })?.wind !== null) return false;
      return got !== null && got.wind === null && got.aqi === null && got.humidity === null && got.keypoint === null && got.days.length === 0 && got.apparent === 6 && got.pressure === 1020 && got.life?.dressing === "薄外套";
    })());
    check("未来几天里坏的一天丢掉：日期写得不对、缺最高最低", (() => {
      const got = parseExtras({ ...clone(full), days: [{ date: "11-02", high: 1, low: 0 }, { date: "2026-11-03", high: 17 }, { date: "2026-11-04", high: 15, low: 9, code: "x", rainChance: null }] });
      return got !== null && got.days.length === 1 && got.days[0].date === "2026-11-04" && got.days[0].code === null && got.days[0].rainChance === null;
    })());
    check("文字项去掉首尾空白、空串当没有", parseExtras({ keypoint: "  今天晴  " })?.keypoint === "今天晴" && parseExtras({ keypoint: "   " })?.keypoint === null && parseExtras({ life: { dressing: " " } })?.life?.dressing === null);
  }

  // ---------------------------------------------------------------- 整理彩云的返回
  section("整理彩云的返回：用真实样例（北京，晚上九点多）");
  {
    const f = base.forecast;
    check("时区偏移取接口的 tzshift", f.utc_offset_seconds === 28800 && OFFSET === 28800);
    check("现在：气温 14°、晴、当地 21:22（用手机的时钟，写成 Open-Meteo 的样子）", f.current.temperature_2m === 14 && f.current.weather_code === 0 && f.current.time === "2026-11-02T21:22");
    check("晚上九点：接口写的是 CLEAR_DAY，这边按经纬度算出来是黑夜（is_day = 0），图标是月亮不是太阳", (SAMPLE.result as { realtime: { skycon: string } }).realtime.skycon === "CLEAR_DAY" && f.current.is_day === 0 && buildSnapshot(f, NOW, 5)?.condition.symbol === "moon.stars.fill");
    check("逐小时按整点归整：21:22、22:22 …… → 21:00、22:00 ……，第一格就是现在所在的整点", f.hourly.time[0] === "2026-11-02T21:00" && f.hourly.time[1] === "2026-11-02T22:00" && f.hourly.time.every((time) => time.endsWith(":00")) && f.hourly.time.length === 30);
    check("逐小时的气温、天气代码、降水概率一一对上", f.hourly.temperature_2m.slice(0, 4).join() === "14,13.52,12.95,12.25" && f.hourly.weather_code[0] === 0 && f.hourly.precipitation_probability[0] === 0 && f.hourly.temperature_2m.length === f.hourly.time.length && f.hourly.is_day.length === f.hourly.time.length);
    check("逐小时的昼夜按各自的时刻算：夜里 0、白天 1、傍晚日落后又是 0", (() => {
      const dayOf = (time: string) => f.hourly.is_day[f.hourly.time.indexOf(time)];
      return dayOf("2026-11-03T00:00") === 0 && dayOf("2026-11-03T05:00") === 0 && dayOf("2026-11-03T07:00") === 1 && dayOf("2026-11-03T16:00") === 1 && dayOf("2026-11-03T18:00") === 0;
    })());
    check("日出日落自己算：今天 06:44 / 17:11，明天 06:45 / 17:10（接口里没有 astro）", JSON.stringify(f.daily.sunrise) === JSON.stringify(["2026-11-02T06:44", "2026-11-03T06:45"]) && JSON.stringify(f.daily.sunset) === JSON.stringify(["2026-11-02T17:11", "2026-11-03T17:10"]) && !("astro" in ((SAMPLE.result as { daily: Json }).daily)));
    check("每天的最高最低：后面几天照接口的；今天至少包含现在的气温", f.daily.temperature_2m_max.join() === "14,17.25,13.85,16.26,10.45,10.37" && f.daily.temperature_2m_min.join() === "12.95,9.75,9.75,6.85,4.7,4.35");
    const snapshot = buildSnapshot(f, NOW, 6);
    check("拿去整理逐小时那一行：现在在最前、后面是整点；气温取整", snapshot !== null && snapshot.temperature === 14 && snapshot.slots.map((slot) => slot.label).join() === "现在,22时,23时,0时,1时,2时" && snapshot.slots.map((slot) => slot.temperature).join() === "14,14,13,12,12,11");
    check("今天的降水概率取当前所在整点的", snapshot !== null && snapshot.rainChance === 0);

    // 详细数据
    const e = base.extras;
    check("体感 14°、湿度 25%（接口给的是 0.25）、气压 1007 hPa（接口给的是 Pa）、能见度 24.1 km", e.apparent === 14 && e.humidity === 25 && e.pressure === 1007 && e.visibility === 24.1);
    check("风：5.11 km/h、236.53°；空气：国标 50 优；紫外线：低（指数 0）", e.wind !== null && e.wind.kmh === 5.11 && e.wind.direction === 236.53 && e.aqi !== null && e.aqi.value === 50 && e.aqi.text === "优" && e.uv !== null && e.uv.index === 0 && e.uv.text === "低");
    check("彩云那句话和生活指数", e.keypoint === "今日多云，气温适宜" && e.life !== null && e.life.dressing === "薄外套" && e.life.carWashing === "适宜" && e.life.comfort === "冷" && e.life.coldRisk === "较易发");
    check("未来两小时没有降水：不写「无降水」，rainNote 是 null", e.rainNote === null);
    check("未来几天：今天起 6 天，日期、最高最低、天气代码、降水概率", e.days.length === 6 && e.days[0].date === "2026-11-02" && e.days[5].date === "2026-11-07" && e.days.map((day) => day.high).join() === "14,17,14,16,10,10" && e.days.map((day) => day.low).join() === "13,10,10,7,5,4" && e.days.map((day) => day.code).join() === "0,0,3,0,0,3" && e.days.every((day) => day.rainChance === 0));
    check("云量 0%、露点 −6°（接口给的是 −5.93）", e.cloud === 0 && e.dewpoint === -6);
    check("污染物：PM2.5 35、PM10 50、臭氧 100、二氧化氮 40、二氧化硫 20（μg/m³）、一氧化碳 1（mg/m³）", JSON.stringify(e.pollutants) === JSON.stringify({ pm25: 35, pm10: 50, o3: 100, no2: 40, so2: 20, co: 1 }));
    check("彩云的几句话：今天、未来 24 小时、未来两小时（没有降水也读出来；卡片底部的 rainNote 才不写）", e.keypoint === "今日多云，气温适宜" && e.dayOutlook === "未来24小时多云，气温适中" && e.rainOutlook === "未来2小时无降水" && e.rainNote === null);
    check("每天的平均风 / 湿度 / 空气 / 紫外线：照接口里每天的 avg 读（11-02 风 5.07 km/h、湿度 26%、空气 35、紫外线 低；11-05 风 15 km/h）", e.days[0].wind?.kmh === 5.07 && e.days[0].wind.direction === 295.29 && e.days[0].humidity === 26 && e.days[0].aqi === 35 && e.days[0].uv === "低" && e.days[3].wind?.kmh === 15 && e.days[3].humidity === 29 && e.days[4].humidity === 15);
    check("样例里没有预警字段：预警是「没取到」，原因是接口没给，不是「没有预警」", base.alerts.items === null && base.alerts.failure !== null && base.alerts.failure.reason === "missing" && base.alerts.failure.at === NOW);

    // 今天的最高最低累计
    const earlier = (high: number, low: number, date = "2026-11-02", offset = 28800): Forecast => ({
      ...clone(f),
      utc_offset_seconds: offset,
      current: { ...f.current, time: date + "T07:00" },
      daily: { ...clone(f.daily), temperature_2m_max: [high], temperature_2m_min: [low] },
    });
    const merged = adaptOk(SAMPLE, { previous: earlier(18.4, 5.1) });
    check("今天白天已经取到过最高 18.4、最低 5.1：晚上取到的只剩 14 / 12.95，累计起来才是这一天的最高最低", merged.forecast.daily.temperature_2m_max[0] === 18.4 && merged.forecast.daily.temperature_2m_min[0] === 5.1 && merged.extras.days[0].high === 18 && merged.extras.days[0].low === 5);
    check("累计只往宽了走：上一次的范围比这次窄，用这次的", (() => { const m = adaptOk(SAMPLE, { previous: earlier(13, 13.5) }); return m.forecast.daily.temperature_2m_max[0] === 14 && m.forecast.daily.temperature_2m_min[0] === 12.95; })());
    check("上一次是昨天的、或者时区不一样：不拿来累计", adaptOk(SAMPLE, { previous: earlier(30, -5, "2026-11-01") }).forecast.daily.temperature_2m_max[0] === 14 && adaptOk(SAMPLE, { previous: earlier(30, -5, "2026-11-02", 3600) }).forecast.daily.temperature_2m_max[0] === 14);
    check("上一次预报里最高最低是空的（null）：当没有", (() => { const prior = earlier(0, 0); prior.daily.temperature_2m_max = [null]; prior.daily.temperature_2m_min = []; return adaptOk(SAMPLE, { previous: prior }).forecast.daily.temperature_2m_max[0] === 14; })());
    check("明天以后的几天不被累计影响", merged.forecast.daily.temperature_2m_max.slice(1).join() === "17.25,13.85,16.26,10.45,10.37");

    // 今天那一项（接口算的「剩下的时间」里的最高最低）和现在的气温比：取更宽的。样例是晚上取的，今天的最高最低就等于现在的气温，看不出取大还是取小，这里换成早上的数
    const withToday = (max: number, min: number) => adaptOk(variant((c) => { (c.result.daily as { temperature: Json[] }).temperature[0] = { date: "2026-11-02T00:00+08:00", max, min, avg: (max + min) / 2 }; })).forecast.daily;
    check("今天的最高最低比现在的气温宽（早上：最高 18.4、最低 6.2，现在 14）：用接口的", (() => { const d = withToday(18.4, 6.2); return d.temperature_2m_max[0] === 18.4 && d.temperature_2m_min[0] === 6.2; })());
    check("今天的最高最低比现在的气温窄（最高 13、最低 13.2，现在 14）：至少包含现在的气温", (() => { const d = withToday(13, 13.2); return d.temperature_2m_max[0] === 14 && d.temperature_2m_min[0] === 13.2; })());
    check("今天那一项只有最高、或只有最低：给了的那一边照用，缺的那一边用现在的气温", (() => {
      const only = (key: "max" | "min", value: number) => adaptOk(variant((c) => { (c.result.daily as { temperature: Json[] }).temperature[0] = { date: "2026-11-02T00:00+08:00", [key]: value, avg: 14 }; })).forecast.daily;
      return only("max", 20).temperature_2m_max[0] === 20 && only("max", 20).temperature_2m_min[0] === 14 && only("min", 5).temperature_2m_min[0] === 5 && only("min", 5).temperature_2m_max[0] === 14;
    })());
  }

  // ---------------------------------------------------------------- 读不全的返回
  section("整理彩云的返回：读不全、值不对的情况");
  {
    check("状态不是 ok、没有 result、不是对象：整份读不懂", [variant((c) => { c.status = "failed"; }), variant((c) => { delete (c as Json).result; }), null, undefined, 3, "x", []].every((raw) => adapt(raw) === null));
    check("没有 tzshift（没法还原当地时间）、tzshift 不是整数：整份读不懂", adapt(variant((c) => { delete c.tzshift; })) === null && adapt(variant((c) => { c.tzshift = 1.5; })) === null && adapt(variant((c) => { c.tzshift = "28800"; })) === null);
    check("没有实况、实况气温不是数字：整份读不懂（没法说「现在」）", adapt(variant((c) => { delete c.result.realtime; })) === null && adapt(variant((c) => { (c.result.realtime as Json).temperature = "14"; })) === null && adapt(variant((c) => { (c.result.realtime as Json).temperature = null; })) === null);
    const noHourly = adaptOk(variant((c) => { delete c.result.hourly; }));
    check("没有逐小时：用实况补出「现在」那一个整点，逐小时那一行只有「现在」", noHourly.forecast.hourly.time.length === 1 && noHourly.forecast.hourly.time[0] === "2026-11-02T21:00" && noHourly.forecast.hourly.temperature_2m[0] === 14 && buildSnapshot(noHourly.forecast, NOW, 5)?.slots[0].label === "现在");
    const later = adaptOk(SAMPLE, { now: NOW - hours(3) });
    check("逐小时从下一个整点才开始：现在所在的整点用实况补上，后面的照旧", later.forecast.hourly.time[0] === "2026-11-02T18:00" && later.forecast.hourly.time[1] === "2026-11-02T21:00" && later.forecast.hourly.temperature_2m[0] === 14);
    const ancient = adaptOk(SAMPLE, { now: NOW + hours(60) });
    check("逐小时都是更早的：丢掉，不拿过期的当后面几个小时", ancient.forecast.hourly.time.length === 1 && ancient.forecast.hourly.time[0] === formatLocal(NOW + hours(60), OFFSET).slice(0, 13) + ":00");
    check("两条落在同一个整点：只留第一条", (() => {
      const raw = variant((c) => {
        const hourly = c.result.hourly as { skycon: Json[]; temperature: Json[] };
        hourly.skycon.splice(1, 0, { datetime: "2026-11-02T21:50+08:00", value: "RAIN" });
        hourly.temperature.splice(1, 0, { datetime: "2026-11-02T21:50+08:00", value: 99 });
      });
      const got = adaptOk(raw);
      return got.forecast.hourly.time.filter((t) => t === "2026-11-02T21:00").length === 1 && !got.forecast.hourly.temperature_2m.includes(99);
    })());
    check("时间写得乱七八糟的条目丢掉，别的照常", (() => {
      const raw = variant((c) => {
        const hourly = c.result.hourly as { skycon: Json[] };
        hourly.skycon[2] = { datetime: "不是时间", value: "CLEAR_DAY" };
        // 不存在的日期（11 月没有 31 号）：Date 会悄悄进位成 12-01，必须丢掉；选在「现在」之后，不然早就被「过去的小时」那一关挡掉了
        hourly.skycon[3] = { datetime: "2026-11-31T10:00+08:00", value: "CLEAR_DAY" };
        hourly.skycon[4] = { value: "CLEAR_DAY" };
        hourly.skycon[5] = "x" as unknown as Json;
      });
      const got = adaptOk(raw);
      return got.forecast.hourly.time.length === 30 - 4 && got.forecast.hourly.time[0] === "2026-11-02T21:00";
    })());
    check("接口的时刻写成别的时区（Z、-05:00、+0800 不带冒号）也认：换算成同一个时刻，整理结果和原来一模一样", (() => {
      const inZone = (iso: string, zone: "Z" | "-05:00" | "+0800"): string => {
        const epoch = new Date(iso).getTime();
        if (zone === "Z") return new Date(epoch).toISOString().slice(0, 16) + "Z";
        if (zone === "-05:00") return new Date(epoch - 5 * 3_600_000).toISOString().slice(0, 16) + "-05:00";
        return new Date(epoch + 8 * 3_600_000).toISOString().slice(0, 16) + "+0800";
      };
      return (["Z", "-05:00", "+0800"] as const).every((zone) => {
        const raw = variant((c) => {
          const hourly = c.result.hourly as Record<string, Json[]>;
          for (const key of ["skycon", "temperature", "precipitation"]) for (const item of hourly[key]) item.datetime = inZone(item.datetime as string, zone);
        });
        return JSON.stringify(adaptOk(raw).forecast.hourly) === JSON.stringify(base.forecast.hourly);
      });
    })());
    check("某一小时没有气温 / 天气现象 / 降水概率：这一项是 null，别的项照在", (() => {
      const raw = variant((c) => {
        const hourly = c.result.hourly as { skycon: Json[]; temperature: Json[]; precipitation: Json[] };
        hourly.temperature.splice(1, 1);
        hourly.skycon[2] = { datetime: (hourly.skycon[2] as { datetime: string }).datetime, value: "ALIEN" };
        hourly.precipitation[3] = { datetime: (hourly.precipitation[3] as { datetime: string }).datetime };
      });
      const got = adaptOk(raw).forecast.hourly;
      return got.temperature_2m[1] === null && got.weather_code[2] === null && got.precipitation_probability[3] === null && got.temperature_2m[0] === 14;
    })());
    check("降水概率：大于 100 封顶、负数当没有、小数取整", (() => {
      const raw = variant((c) => {
        const precipitation = (c.result.hourly as { precipitation: Json[] }).precipitation;
        precipitation[0].probability = 180;
        precipitation[1].probability = -5;
        precipitation[2].probability = 33.4;
      });
      return adaptOk(raw).forecast.hourly.precipitation_probability.slice(0, 3).join() === "100,,33";
    })());
    check("天气现象不认识：当前天气代码是 -1（界面上是「未知」），不冒充晴", (() => {
      const got = adaptOk(variant((c) => { (c.result.realtime as Json).skycon = "ALIEN"; }));
      return got.forecast.current.weather_code === -1 && conditionFor(-1, true).text === "未知";
    })());

    // 单项的取值范围
    const withRealtime = (patch: Json) => adaptOk(variant((c) => { Object.assign(c.result.realtime as Json, patch); })).extras;
    check("湿度：0.25 → 25%、1 → 100%、已经是百分数的 25 → 25%；负数、超过 100 当没有", withRealtime({ humidity: 0.25 }).humidity === 25 && withRealtime({ humidity: 1 }).humidity === 100 && withRealtime({ humidity: 25 }).humidity === 25 && withRealtime({ humidity: -0.1 }).humidity === null && withRealtime({ humidity: 150 }).humidity === null && withRealtime({ humidity: "湿" }).humidity === null);
    check("气压：Pa 换成 hPa；已经是 hPa 的也认；离谱的当没有", withRealtime({ pressure: 100723.11 }).pressure === 1007 && withRealtime({ pressure: 1013 }).pressure === 1013 && withRealtime({ pressure: 30 }).pressure === null && withRealtime({ pressure: null }).pressure === null);
    check("能见度：保留一位小数；负数当没有", withRealtime({ visibility: 5.26 }).visibility === 5.3 && withRealtime({ visibility: 0 }).visibility === 0 && withRealtime({ visibility: -1 }).visibility === null);
    check("风：风速负数、风向不是数字：当没有", withRealtime({ wind: { speed: -1, direction: 10 } }).wind === null && withRealtime({ wind: { speed: 3, direction: "北" } }).wind === null && withRealtime({ wind: { speed: 0, direction: 0 } }).wind !== null);
    check("体感：取整；不是数字当没有", withRealtime({ apparent_temperature: 13.5 }).apparent === 14 && withRealtime({ apparent_temperature: "冷" }).apparent === null);
    check("空气质量：没有这一块、国标值缺了：当没有；文字没给就按分级补", withRealtime({ air_quality: undefined }).aqi === null && withRealtime({ air_quality: { aqi: {} } }).aqi === null && withRealtime({ air_quality: { aqi: { chn: 75 } } }).aqi?.text === "良" && withRealtime({ air_quality: { aqi: { chn: 75 }, description: { chn: "  " } } }).aqi?.text === "良" && withRealtime({ air_quality: { aqi: { chn: -3 } } }).aqi === null);
    check("紫外线：没有这一块、没有文字：当没有；指数读不出只丢指数", withRealtime({ life_index: undefined }).uv === null && withRealtime({ life_index: { ultraviolet: { index: "1" } } }).uv === null && withRealtime({ life_index: { ultraviolet: { index: "abc", desc: "强" } } }).uv?.index === null && withRealtime({ life_index: { ultraviolet: { index: "5", desc: "强" } } }).uv?.index === 5);

    check("云量：0.45 → 45%、1 → 100%、已经是百分数的 60 → 60%；负数、超过 100、不是数字当没有", withRealtime({ cloudrate: 0.45 }).cloud === 45 && withRealtime({ cloudrate: 1 }).cloud === 100 && withRealtime({ cloudrate: 60 }).cloud === 60 && withRealtime({ cloudrate: -1 }).cloud === null && withRealtime({ cloudrate: 101 }).cloud === null && withRealtime({ cloudrate: "多" }).cloud === null);
    check("露点：取整（负数远离零，−5.5 → −6）；不是数字、没有当没有", withRealtime({ dewpoint: -5.5 }).dewpoint === -6 && withRealtime({ dewpoint: 3.4 }).dewpoint === 3 && withRealtime({ dewpoint: "x" }).dewpoint === null && withRealtime({ dewpoint: undefined }).dewpoint === null);
    check("污染物：取整、一氧化碳留一位小数；负数、不是数字的那一项当没有；六项都没有就整块没有", (() => {
      const air = (patch: Json) => withRealtime({ air_quality: { aqi: { chn: 50 }, ...patch } }).pollutants;
      const got = air({ pm25: 34.6, pm10: "x", o3: -1, no2: 40.4, so2: 19.5, co: 0.86 });
      return got !== null && got.pm25 === 35 && got.pm10 === null && got.o3 === null && got.no2 === 40 && got.so2 === 20 && got.co === 0.9 && air({}) === null && withRealtime({ air_quality: undefined }).pollutants === null;
    })());
    check("未来 24 小时那句话：读 hourly.description，去掉首尾空白；没有、空串、不是文字当没有", adaptOk(variant((c) => { (c.result.hourly as Json).description = "  多云转晴  "; })).extras.dayOutlook === "多云转晴" && adaptOk(variant((c) => { delete (c.result.hourly as Json).description; })).extras.dayOutlook === null && adaptOk(variant((c) => { (c.result.hourly as Json).description = ""; })).extras.dayOutlook === null && adaptOk(variant((c) => { (c.result.hourly as Json).description = 5; })).extras.dayOutlook === null);

    // 分钟级降水那句话
    const withMinutely = (precipitation: unknown, description: unknown) => adaptOk(variant((c) => { c.result.minutely = { status: "ok", precipitation_2h: precipitation, description }; })).extras.rainNote;
    const calm = new Array<number>(120).fill(0);
    const rainy = calm.slice();
    rainy[25] = 0.4;
    check("未来两小时有降水（强度 ≥ 0.031）：写彩云那句话", withMinutely(rainy, "25 分钟后开始下雨") === "25 分钟后开始下雨");
    check("降水强度刚好 0.031：算有", withMinutely(calm.map((value, index) => (index === 3 ? 0.031 : value)), "有小雨") === "有小雨");
    check("降水强度太小（< 0.031，彩云降水强度表里算没有）：不写", withMinutely(calm.map((value, index) => (index === 3 ? 0.03 : value)), "有点毛毛雨") === null);
    check("没有降水 / 数据读不懂 / 没有那句话：不写（不写「无降水」）", withMinutely(calm, "未来2小时无降水") === null && withMinutely("x", "有雨") === null && withMinutely(rainy, "") === null && withMinutely(rainy, 7) === null);
    check("彩云那句话：空串当没有", adaptOk(variant((c) => { c.result.forecast_keypoint = ""; })).extras.keypoint === null && adaptOk(variant((c) => { c.result.forecast_keypoint = 5; })).extras.keypoint === null);

    const outlook = (precipitation: unknown, description: unknown) => adaptOk(variant((c) => { c.result.minutely = { status: "ok", precipitation_2h: precipitation, description }; })).extras.rainOutlook;
    check("未来两小时那句话（rainOutlook）：有没有降水都读出来，降水数据读不懂时也读；空串、不是文字当没有", outlook(calm, "未来2小时无降水") === "未来2小时无降水" && outlook("x", "有雨") === "有雨" && outlook(rainy, "25 分钟后开始下雨") === "25 分钟后开始下雨" && outlook(calm, "") === null && outlook(calm, 7) === null);
    check("没有分钟级那一块：两句（rainOutlook、rainNote）都没有，别的照常", (() => { const g = adaptOk(variant((c) => { delete c.result.minutely; })).extras; return g.rainOutlook === null && g.rainNote === null && g.apparent === 14; })());

    // 每天
    check("每天的平均风 / 湿度 / 空气 / 紫外线：缺了、读坏了的那一项是 null，别的天不受影响", (() => {
      const raw = variant((c) => {
        const daily = c.result.daily as Record<string, unknown>;
        (daily.wind as Json[])[1] = { date: "2026-11-03T00:00+08:00", avg: { speed: -1, direction: 10 } };
        delete (daily.humidity as Json[])[2].avg;
        ((daily.air_quality as Json).aqi as Json[])[3] = { date: "2026-11-05T00:00+08:00", avg: { chn: "x" } };
        delete ((daily.life_index as Json).ultraviolet as Json[])[4].desc;
      });
      const days = adaptOk(raw).extras.days;
      return days[1].wind === null && days[0].wind !== null && days[2].humidity === null && days[1].humidity === 26 && days[3].aqi === null && days[2].aqi === 35 && days[4].uv === null && days[3].uv === "低";
    })());
    check("整个没有每天的风、湿度、空气质量、生活指数这几组：每天这几项都是 null，最高最低照常，生活指数没有", (() => {
      const raw = variant((c) => {
        const daily = c.result.daily as Record<string, unknown>;
        delete daily.wind;
        delete daily.humidity;
        delete daily.air_quality;
        delete daily.life_index;
      });
      const got = adaptOk(raw).extras;
      return got.days.length === 6 && got.days.every((d) => d.wind === null && d.humidity === null && d.aqi === null && d.uv === null) && got.life === null && got.days[0].high === 14;
    })());
    const noDaily = adaptOk(variant((c) => { delete c.result.daily; }));
    check("没有每天的数据：今天的最高最低就是现在的气温，只有今天这一天，生活指数没有", noDaily.forecast.daily.temperature_2m_max.join() === "14" && noDaily.forecast.daily.temperature_2m_min.join() === "14" && noDaily.extras.days.length === 1 && noDaily.extras.life === null);
    const placeholder = adaptOk(variant((c) => {
      const temperature = (c.result.daily as { temperature: Json[] }).temperature;
      temperature[2] = { date: "2026-11-04T00:00+08:00", max: 0, min: 0, avg: 0 };
      delete temperature[3].max;
    }));
    check("全天都是 0 的（max、min、avg 同时为 0）是占位，缺最高 / 最低的也不要：这两天不画", placeholder.extras.days.map((day) => day.date).join() === "2026-11-02,2026-11-03,2026-11-06,2026-11-07" && placeholder.forecast.daily.temperature_2m_max.length === 4);
    check("今天那一项是占位（全 0）：不拿来当今天的最高最低", adaptOk(variant((c) => { ((c.result.daily as { temperature: Json[] }).temperature[0]) = { date: "2026-11-02T00:00+08:00", max: 0, min: 0, avg: 0 }; })).forecast.daily.temperature_2m_max[0] === 14);
    check("真的是 0 度的一天不当占位（最高 3、最低 0）", adaptOk(variant((c) => { ((c.result.daily as { temperature: Json[] }).temperature[1]) = { date: "2026-11-03T00:00+08:00", max: 3, min: 0, avg: 1 }; })).extras.days[1].low === 0);
    check("未来几天最多留 6 天", adaptOk(variant((c) => {
      for (const key of Object.keys(c.result.daily as Json)) {
        const series = (c.result.daily as Json)[key];
        if (Array.isArray(series)) {
          // 补到 9 天，看是不是只留 6 天
          for (let extra = 0; extra < 3; extra++) series.push({ ...(series[series.length - 1] as Json), date: "2026-11-" + (8 + extra).toString().padStart(2, "0") + "T00:00+08:00" });
        }
      }
    })).extras.days.length === 6);

    // 经纬度、时区
    const polar = adaptOk(SAMPLE, { coord: { latitude: 78, longitude: 15 }, now: Date.UTC(2026, 11, 21, 12) });
    check("极夜的地方：日出日落是 null，现在是黑夜", polar.forecast.daily.sunrise.every((value) => value === null) && polar.forecast.daily.sunset.every((value) => value === null) && polar.forecast.current.is_day === 0);
    const india = adaptOk(variant((c) => { c.tzshift = 19800; }), { coord: { latitude: 28.6, longitude: 77.2 } });
    check("半个小时偏移的时区（印度 +5:30）：逐小时按当地的整点归整，当地时间对得上", india.forecast.utc_offset_seconds === 19800 && india.forecast.current.time === "2026-11-02T18:52" && india.forecast.hourly.time[0] === "2026-11-02T18:00" && india.forecast.hourly.time.every((time) => time.endsWith(":00")));
    const west = adaptOk(variant((c) => { c.tzshift = -18000; }), { coord: { latitude: 40.7, longitude: -74 } });
    check("西半球（UTC-5）：当地时间、昼夜都对得上（纽约 08:22 是白天）", west.forecast.current.time === "2026-11-02T08:22" && west.forecast.current.is_day === 1);
    check("用的是手机的时钟，不是接口的 server_time", adaptOk(SAMPLE, { now: NOW + hours(2) }).forecast.current.time === "2026-11-02T23:22");

    // 昼夜用「现在」那一刻算，晴天白天用太阳
    const noon0 = adaptOk(variant((c) => { (c.result.realtime as Json).skycon = "CLEAR_NIGHT"; }), { now: Date.UTC(2026, 10, 2, 4, 0) });
    check("中午 12 点：接口写 CLEAR_NIGHT 也按白天算（图标用太阳）", noon0.forecast.current.is_day === 1 && buildSnapshot(noon0.forecast, Date.UTC(2026, 10, 2, 4, 0), 5)?.condition.symbol === "sun.max.fill");

    // 预警
    const withAlert = adaptOk(variant((c) => { c.result.alert = (ALERT_SAMPLE.result as { alert: unknown }).alert; }));
    check("返回里带了预警：一起读出来，不算失败", withAlert.alerts.items !== null && withAlert.alerts.items.length === 5 && withAlert.alerts.failure === null);
    check("带了空的预警（现在没有）：读懂了，条目是空数组", (() => { const g = adaptOk(variant((c) => { c.result.alert = { status: "ok", content: [] }; })); return g.alerts.items !== null && g.alerts.items.length === 0 && g.alerts.failure === null; })());
    check("预警字段读不懂：失败，原因是 format；没有预警字段：原因是 missing；天气都照常", (() => {
      const unreadable = adaptOk(variant((c) => { c.result.alert = { content: "x" }; }));
      const missing = adaptOk(variant((c) => { c.result.alert = null; }));
      return unreadable.alerts.failure?.reason === "format" && missing.alerts.failure?.reason === "missing" && unreadable.forecast.current.temperature_2m === 14 && missing.extras.apparent === 14;
    })());
  }

  // ---------------------------------------------------------------- 地址与校验
  section("请求地址、内置接口、服务地址与 token 的校验");
  {
    const custom: Endpoint = { host: "https://weather.example.com", token: "AbCd1234EfGh5678" };
    const builtin: Endpoint = { host: BUILTIN_HOST, token: BUILTIN_TOKEN };
    check("内置接口：https、没有结尾斜杠、不带路径；占位 token 过得了自己的校验（没有斜杠）", /^https:\/\/[^/]+$/.test(BUILTIN_HOST) && cleanHost(BUILTIN_HOST) === BUILTIN_HOST && cleanToken(BUILTIN_TOKEN) === BUILTIN_TOKEN);
    check("内置接口的 token 不是彩云真 token 的样子（16 位字母数字）", !/^[A-Za-z0-9]{16}$/.test(BUILTIN_TOKEN));
    check("地址：服务地址 / v2.6 / token / 经度,纬度 / weather / alert=true；经度在前纬度在后", buildWeatherURL(custom, { latitude: 39.976, longitude: 116.3176 }) === `${custom.host}/v2.6/${custom.token}/116.32,39.98/weather?alert=true&dailysteps=6&hourlysteps=24&lang=zh_CN`);
    check("内置接口走的是同一套路径：内置地址 / v2.6 / 占位 token / …", buildWeatherURL(builtin, BEIJING) === `${BUILTIN_HOST}/v2.6/${BUILTIN_TOKEN}/116.40,39.90/weather?alert=true&dailysteps=6&hourlysteps=24&lang=zh_CN`);
    check("彩云官方的地址也是这一套：官方地址 / v2.6 / token / …", buildWeatherURL({ host: OFFICIAL_HOST, token: custom.token }, BEIJING).startsWith(`${OFFICIAL_HOST}/v2.6/${custom.token}/116.40,39.90/weather?alert=true`));
    check("坐标取整到两位小数，负数远离零（和天气那边一致）", buildWeatherURL(custom, { latitude: -33.8688, longitude: -118.125 }).includes("/-118.13,-33.87/"));
    check("token 放进路径前会转义（带斜杠、空格、问号、井号也拼不出奇怪的地址）", buildWeatherURL({ host: custom.host, token: "a/b c?d#e" }, BEIJING).includes("/a%2Fb%20c%3Fd%23e/") && !buildWeatherURL({ host: custom.host, token: "a/b c" }, BEIJING).includes("a/b c"));
    check("中文 token 也转义得对", buildWeatherURL({ host: custom.host, token: "天气" }, BEIJING).includes("/%E5%A4%A9%E6%B0%94/"));
    check("hourlysteps 取文档里的最小值 24；dailysteps 取 6（今天加后面五天，文档里最大 15）", buildWeatherURL(custom, BEIJING).includes("hourlysteps=24") && buildWeatherURL(custom, BEIJING).includes("dailysteps=6"));

    check("token：任意文字都行（字母数字、横线、中文、符号），长度 1 到 128", ["a", "x".repeat(128), "TAkhjf8d1nlSlspN", "scripting-weather", "天气 token", "a?b#c%d", "a\\b"].every((value) => cleanToken(value) === value));
    check("token：空的、全是空白、带斜杠、带换行 / 制表 / 控制字符、超过 128 位，都不行", ["", "   ", "a/b", "/", "ab\ncd", "ab\tcd", "x".repeat(129), "\u0000a", "a\u007f"].every((value) => cleanToken(value) === null));
    check("粘贴进来的 token 去掉首尾空白", cleanToken("  AbCd1234EfGh5678\n") === "AbCd1234EfGh5678");

    check("服务地址：https 开头就行，带端口、带路径前缀也行", ["https://api.caiyunapp.com", "https://a.b-c.example.net", "https://example.com:8443", "https://example.com/proxy", "https://example.com/a/b-c_d.e", "https://192.168.1.2:8080"].every((value) => cleanHost(value) === value));
    check("服务地址：首尾空白、结尾斜杠、多写的 /v2.6 都去掉", cleanHost("  https://example.com/  ") === "https://example.com" && cleanHost("https://api.caiyunapp.com/v2.6") === "https://api.caiyunapp.com" && cleanHost("https://api.caiyunapp.com/v2.6/") === "https://api.caiyunapp.com" && cleanHost("https://example.com/proxy/v2.6") === "https://example.com/proxy" && cleanHost("https://example.com///") === "https://example.com" && cleanHost("https://example.com//v2.6") === "https://example.com");
    check("服务地址：不是 https、没主机名、带问号 / 井号 / 空格 / 反斜杠 / 用户名密码 / 中文，都不行", ["", "   ", "http://example.com", "example.com", "https://", "https:///x", "ftp://example.com", "https://exa mple.com", "https://example.com?x=1", "https://example.com/#a", "https://example.com\\x", "https://user:pw@example.com", "HTTPS://example.com", "https://中文.com", "https://.", "https://example.com/a b", "https://example.com:port"].every((value) => cleanHost(value) === null));
  }

  // ---------------------------------------------------------------- 联网
  section("联网：状态码、错误说明、读不懂（假的 fetch，没有真的请求）");
  {
    const custom: Endpoint = { host: "https://weather.example.com", token: "AbCd1234EfGh5678" };
    let seen: { url: string; timeout: number | undefined } | null = null;
    withFetch(async (url, init) => {
      seen = { url, timeout: init?.timeout };
      return { status: 200, json: async () => clone(SAMPLE) };
    });
    const got = await fetchCaiyun(custom, BEIJING, 6, NOW, null);
    const seenNow = seen as { url: string; timeout: number | undefined } | null;
    check("200：整理好了——预报、详细数据、预警；带着地址和超时（秒）", got.forecast.current.temperature_2m === 14 && got.extras.apparent === 14 && got.alerts.failure?.reason === "missing" && seenNow !== null && seenNow.url === buildWeatherURL(custom, BEIJING) && seenNow.timeout === 6);
    await fetchCaiyun({ host: BUILTIN_HOST, token: BUILTIN_TOKEN }, BEIJING, 6, NOW, null);
    const seenBuiltin = seen as { url: string; timeout: number | undefined } | null;
    check("用内置的：请求发到内置地址，路径里是占位 token", seenBuiltin !== null && seenBuiltin.url.startsWith(`${BUILTIN_HOST}/v2.6/${BUILTIN_TOKEN}/`));
    withFetch(reply(200, SAMPLE));
    const withPrevious = await fetchCaiyun(custom, BEIJING, 6, NOW, { ...clone(base.forecast), daily: { ...clone(base.forecast.daily), temperature_2m_max: [20], temperature_2m_min: [3] } });
    check("上一次的预报交给整理那一步，用来累计今天的最高最低", withPrevious.forecast.daily.temperature_2m_max[0] === 20 && withPrevious.forecast.daily.temperature_2m_min[0] === 3);

    const reasonOf = async (impl: Fake): Promise<string> => {
      withFetch(impl);
      return fetchCaiyun(custom, BEIJING, 6, NOW, null).then(
        () => "没抛",
        (error: unknown) => (error instanceof FetchError ? error.reason : "不是 FetchError"),
      );
    };
    check("400 + 文档里的示例「token is invalid」→ token", (await reasonOf(reply(400, { status: "failed", error: "token is invalid", api_version: "2.6" }))) === "token");
    check("403（另一套服务地址的 AUTH_MISSING）→ token", (await reasonOf(reply(403, { code: 4030, reason: "AUTH_MISSING", error: "token is missing" }))) === "token");
    check("401 → token；429 → quota；500（文档示例）→ server；502 → server", (await reasonOf(reply(401, {}))) === "token" && (await reasonOf(reply(429, {}))) === "quota" && (await reasonOf(reply(500, { status: "failed", error: "only length-1 arrays can be converted to Python scalars", api_version: "2.6" }))) === "server" && (await reasonOf(reply(502, {}))) === "server");
    check("400 但说明里没提 token → server", (await reasonOf(reply(400, { status: "failed", error: "invalid location", api_version: "2.6" }))) === "server");
    check("状态码不是 200、返回也不是 JSON：照状态码归类，不崩", (await reasonOf(async () => ({ status: 502, json: async () => { throw new Error("不是 JSON"); } }))) === "server");
    check("200 但状态是 failed、缺实况、缺 tzshift → format（天气都读不了）", (await reasonOf(reply(200, { status: "failed" }))) === "format" && (await reasonOf(reply(200, variant((c) => { delete c.result.realtime; })))) === "format" && (await reasonOf(reply(200, variant((c) => { delete c.tzshift; })))) === "format");
    check("200 但不是 JSON → format", (await reasonOf(async () => ({ status: 200, json: async () => { throw new Error("不是 JSON"); } }))) === "format");
    check("天气读得懂、只是没有预警字段：不算失败，照常返回（预警那一项记下原因）", (await reasonOf(reply(200, SAMPLE))) === "没抛");
    check("fetch 自己抛错 → network", (await reasonOf(async () => { throw new Error("没网"); })) === "network");
    check("失败说明是人话：6 种各一句，而且各不相同", (() => {
      const messages = FAILURE_REASONS.map((reason) => new FetchError(reason).message);
      return FAILURE_REASONS.length === 6 && messages.every((message) => message.length > 3) && new Set(messages).size === 6 && messages.every((message, index) => message === failureMessage(FAILURE_REASONS[index]));
    })());
    check("「没返回预警数据」的话里不出现「没有预警」（不能让人以为是平安无事）", !new FetchError("missing").message.includes("没有预警"));
    check("失败说明带上 HTTP 状态", new FetchError("server", "HTTP 500").message.includes("HTTP 500"));
    check("describeFailure：FetchError 原样、别的错当联网失败", describeFailure(new FetchError("quota")).reason === "quota" && describeFailure(new Error("x")).reason === "network" && describeFailure("字符串").reason === "network");
    check("classifyFailure：429 quota；401 / 403 / 说明里有 token → token；其余 server", classifyFailure(429, "") === "quota" && classifyFailure(401, "") === "token" && classifyFailure(403, "") === "token" && classifyFailure(400, "Token is invalid") === "token" && classifyFailure(500, "") === "server" && classifyFailure(404, "") === "server");
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  }

  // ---------------------------------------------------------------- 数据来源设置
  section("数据来源：内置 / 自己的 / Open-Meteo（备用）");
  {
    const mine: DataSource = { mode: "custom", host: "https://weather.example.com", token: "AbCd1234EfGh5678" };
    check("默认是内置：没存过、读不出来、乱写都是内置，自己的地址和 token 是空的", [null, undefined, 3, "x", [], {}, { mode: "weird" }, { mode: 1 }, { mode: "off" }].every((value) => {
      const source = parseSource(value);
      return source.mode === "builtin" && source.host === "" && source.token === "";
    }) && defaultSource().mode === "builtin");
    check("三种来源存了再读，一字不差", JSON.stringify(parseSource(clone(mine))) === JSON.stringify(mine) && parseSource({ mode: "openmeteo", host: "", token: "" }).mode === "openmeteo" && parseSource({ mode: "builtin", host: "", token: "" }).mode === "builtin");
    check("选了内置 / Open-Meteo：自己填过的地址和 token 也留着（来回切换不用重填）", JSON.stringify(parseSource({ ...mine, mode: "builtin" })) === JSON.stringify({ ...mine, mode: "builtin" }) && JSON.stringify(parseSource({ ...mine, mode: "openmeteo" })) === JSON.stringify({ ...mine, mode: "openmeteo" }));
    check("说是自己的、地址或 token 不合格或没填：不照着用，回到内置（填过的还留着，界面上看得到）", (() => {
      const bad = [{ mode: "custom", host: "", token: mine.token }, { mode: "custom", host: "http://example.com", token: mine.token }, { mode: "custom", host: mine.host, token: "a/b" }, { mode: "custom", host: mine.host }, { mode: "custom" }].map(parseSource);
      return bad.every((source) => source.mode === "builtin") && bad[2].host === mine.host && bad[0].token === mine.token;
    })());
    check("存着的地址、token 读回来也要再过一遍：不合格的丢成空；地址是整理过的（去掉结尾斜杠和多写的 /v2.6）", (() => {
      const source = parseSource({ mode: "builtin", host: "ftp://x", token: "a/b" });
      return source.host === "" && source.token === "" && parseSource({ mode: "custom", host: " https://example.com/v2.6/ ", token: mine.token }).host === "https://example.com";
    })());
    check("来源 → 实际取数的是谁：内置和自己的都是彩云，Open-Meteo 是 openmeteo", providerOf(defaultSource()) === "caiyun" && providerOf(mine) === "caiyun" && providerOf({ mode: "openmeteo", host: "", token: "" }) === "openmeteo");
    check("endpointOf：内置 → 内置的地址和占位 token；自己的 → 填的；Open-Meteo → null（不走彩云）", JSON.stringify(endpointOf(defaultSource())) === JSON.stringify({ host: BUILTIN_HOST, token: BUILTIN_TOKEN }) && JSON.stringify(endpointOf(mine)) === JSON.stringify({ host: mine.host, token: mine.token }) && endpointOf({ mode: "openmeteo", host: mine.host, token: mine.token }) === null);
    check("endpointOf：选了内置，不会用到自己填的地址", endpointOf({ mode: "builtin", host: mine.host, token: mine.token })?.host === BUILTIN_HOST);
    check("endpointOf：自己的但没填全 → null", endpointOf({ mode: "custom", host: "", token: "" }) === null && endpointOf({ mode: "custom", host: mine.host, token: "" }) === null && endpointOf({ mode: "custom", host: "", token: mine.token }) === null);
  }

  // ---------------------------------------------------------------- 存储
  section("存储：数据来源的存取、换来源时旧缓存作废（内存里的假 Storage）");
  {
    const memory = new Map<string, unknown>();
    let broken = false;
    const fake = {
      get: (key: string): unknown => {
        if (broken) throw new Error("存储炸了");
        if (!memory.has(key)) return undefined;
        const value = memory.get(key);
        // 数字原样给（NaN、Infinity 过一遍 JSON 就变成 null 了，测不到「读出来不是有限的数」）
        return typeof value === "object" && value !== null ? clone(value) : value;
      },
      set: (key: string, value: unknown): void => {
        memory.set(key, clone(value));
      },
      remove: (key: string): void => {
        memory.delete(key);
      },
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "Storage");
    Object.defineProperty(globalThis, "Storage", { value: fake, configurable: true, writable: true });

    check("没存过：默认是内置", readDataSource().mode === "builtin");
    const mine: DataSource = { mode: "custom", host: "https://weather.example.com", token: "AbCd1234EfGh5678" };
    writeDataSource(mine);
    check("存了「自己的」再读：一字不差", JSON.stringify(readDataSource()) === JSON.stringify(mine));
    const cache = { version: 1 as const, fetchedAt: NOW, anchor: BEIJING, provider: "caiyun" as const, forecast: base.forecast, extras: base.extras, alerts: base.alerts, place: "北京市", placeAnchor: BEIJING };
    writeCache(cache);
    check("缓存存得进、读得回：来源、详细数据、预警都在", (() => { const c = readCache(); return c !== null && c.provider === "caiyun" && c.extras !== null && c.extras.apparent === 14 && c.alerts !== null && c.alerts.failure?.reason === "missing"; })());
    writeDataSource({ mode: "openmeteo", host: mine.host, token: mine.token });
    check("换了来源：旧的缓存作废，新的来源存下了（自己填过的还留着）", readCache() === null && readDataSource().mode === "openmeteo" && readDataSource().token === mine.token);
    writeCache(cache);
    writeLocation({ coord: BEIJING, at: NOW });
    memory.set("weather.alerts.v1", { 老版本: true });
    memory.set("weather.alert-source.v1", { mode: "off" });
    memory.set("weather.settings.v1", { mode: "current", fixed: null });
    clearData();
    check("清空缓存：天气缓存、上次的定位、老版本留下的键都没了；数据来源和位置设置还在", readCache() === null && readLocation() === null && !memory.has("weather.alerts.v1") && !memory.has("weather.alert-source.v1") && readDataSource().mode === "openmeteo" && memory.has("weather.settings.v1"));
    check("显示样式：没存过是默认的；存了再读一字不差；清空缓存不动它；读坏了回默认", (() => {
      const mine: Display = { strip: "daily", top: "windHumidity", bottom: "headline", headline: "keypoint" };
      const fresh = sameDisplay(loadDisplay(), defaultDisplay());
      saveDisplay(mine);
      const saved = JSON.stringify(loadDisplay()) === JSON.stringify(mine);
      clearData();
      const kept = JSON.stringify(loadDisplay()) === JSON.stringify(mine);
      memory.set("weather.display.v1", "乱写的");
      const broken = sameDisplay(loadDisplay(), defaultDisplay());
      return fresh && saved && kept && broken;
    })());
    check("展开状态：没存过全收着；存了再读一字不差；清空缓存不动它；读坏了全收着", (() => {
      const mine: Folds = { display: true, source: true };
      const fresh = Object.keys(loadFolds()).length === 0;
      saveFolds(mine);
      const saved = JSON.stringify(loadFolds()) === JSON.stringify(mine);
      clearData();
      const kept = JSON.stringify(loadFolds()) === JSON.stringify(mine);
      memory.set("weather.folds.v1", "乱写的");
      return fresh && saved && kept && Object.keys(loadFolds()).length === 0;
    })());
    check("预览预警样式的截止时间：存得进、读得回、清得掉；读坏了是 0", (() => {
      writeDemoUntil(NOW + 5);
      const stored = readDemoUntil();
      clearDemo();
      const cleared = readDemoUntil();
      memory.set("weather.alert-demo.v1", "乱写的");
      return stored === NOW + 5 && cleared === 0 && readDemoUntil() === 0;
    })());
    check("预览截止时间：NaN、Infinity、字符串、对象、布尔、null 都当没开（0）", [Number.NaN, Number.POSITIVE_INFINITY, "5", {}, true, null].every((value) => { memory.set("weather.alert-demo.v1", value); return readDemoUntil() === 0; }));
    memory.set("weather.cache.v1", { ...clone(cache), alerts: { items: null, failure: { at: NOW, reason: "format", message: "字".repeat(300) } } });
    check("缓存里存的失败说明超长：读回来截成 120 字，不让坏数据撑爆界面", readCache()?.alerts?.failure?.message.length === 120);
    memory.set("weather.source.v1", "乱写的");
    check("存的东西读坏了：当默认（内置）", readDataSource().mode === "builtin");
    memory.set("weather.cache.v1", "乱写的");
    check("缓存读坏了：当没有", readCache() === null);
    broken = true;
    check("存储读不出来（抛错）：当默认（内置）、缓存当没有、位置当没有、预览当没开、显示样式回默认、展开状态全收着，不崩", readDataSource().mode === "builtin" && readCache() === null && readLocation() === null && readDemoUntil() === 0 && sameDisplay(loadDisplay(), defaultDisplay()) && Object.keys(loadFolds()).length === 0);
    broken = false;
    if (previous !== undefined) Object.defineProperty(globalThis, "Storage", previous);
    else delete (globalThis as unknown as { Storage?: unknown }).Storage;
  }

  // ---------------------------------------------------------------- 详细数据怎么说
  section("详细数据怎么说成人话；卡片和 App 页上的文字");
  {
    const e = base.extras;
    const detail = detailOf(e);
    check("一行放得下的四项：体感、湿度、风、空气", detail.stats.map((s) => s.label + " " + s.value).join(" | ") === "体感 14° | 湿度 25% | 风 西南风 1级 | 空气 优 50");
    check("只有空气质量带分级（0 优），别的项没有", detail.stats.map((s) => s.band).join() === ",,,0");
    check("App 页「详细数据」：体感、湿度、风、云量、露点、气压、能见度、紫外线（空气另有一节）", detail.all.map((s) => s.label).join() === "体感,湿度,风,云量,露点,气压,能见度,紫外线" && detail.all.map((s) => s.value).join("|") === "14°|25%|西南风 1级|0%|-6°|1007 hPa|24 km|低");
    check("App 页「空气质量」：国标指数（带分级）和六项污染物，单位跟着写", detail.air.map((s) => s.label).join() === "空气质量,PM2.5,PM10,臭氧,二氧化氮,二氧化硫,一氧化碳" && detail.air.map((s) => s.value).join("|") === "优 50|35 μg/m³|50 μg/m³|100 μg/m³|40 μg/m³|20 μg/m³|1 mg/m³" && detail.air[0].band === 0 && detail.air.slice(1).every((s) => s.band === null));
    check("污染物缺了哪项就不写哪项；整块没有时只剩国标指数；指数也没有就一行都没有", (() => {
      const some = detailOf({ ...clone(e), pollutants: { pm25: 12, pm10: null, o3: null, no2: null, so2: null, co: 0.5 } });
      const none = detailOf({ ...clone(e), pollutants: null });
      const nothing = detailOf({ ...clone(e), pollutants: null, aqi: null });
      return some.air.map((s) => s.label).join() === "空气质量,PM2.5,一氧化碳" && some.air[2].value === "0.5 mg/m³" && none.air.map((s) => s.label).join() === "空气质量" && nothing.air.length === 0;
    })());
    check("云量、露点缺了就不写；彩云的三句话原样带出来", (() => {
      const g = detailOf({ ...clone(e), cloud: null, dewpoint: null });
      return !g.all.some((s) => s.key === "cloud" || s.key === "dewpoint") && detail.keypoint === "今日多云，气温适宜" && detail.dayOutlook === "未来24小时多云，气温适中" && detail.rainOutlook === "未来2小时无降水";
    })());
    check("生活指数：穿衣、舒适度、感冒、洗车", detail.life.map((s) => s.label + " " + s.value).join(" | ") === "穿衣 薄外套 | 舒适度 冷 | 感冒 较易发 | 洗车 适宜");
    check("彩云那句话；没有下雨的说明", detail.keypoint === "今日多云，气温适宜" && detail.rainNote === null);
    check("缺的项不画：全空的详细数据一项都没有，也不崩", (() => { const none = detailOf(emptyExtras()); return none.stats.length === 0 && none.all.length === 0 && none.life.length === 0 && none.days.length === 0 && none.week.length === 0; })());
    check("风力：几级风说成「南风 3级」，0 级是「无风」", windText(12.5, 193) === "南风 3级" && windText(0.5, 90) === "无风" && windText(60, 45) === "东北风 7级");
    check("能见度：十公里以上不要小数", visibilityText(24.1) === "24 km" && visibilityText(10) === "10 km" && visibilityText(9.4) === "9.4 km" && visibilityText(0.8) === "0.8 km");
    check("星期：2026-11-02 是周一，11-04 是周三，11-08 是周日", weekdayOf("2026-11-02") === "周一" && weekdayOf("2026-11-04") === "周三" && weekdayOf("2026-11-08") === "周日" && weekdayOf("2026-02-28") === "周六");
    check("明天起的几天：明天、后天、然后是星期几；今天不在里面；大号竖向只放得下 4 天，数据里有 5 天也只取前 4 天", detail.days.map((d) => d.weekday).join() === "明天,后天,周四,周五" && detail.days.length === LARGE_DAYS && LARGE_DAYS === 4 && e.days.length - 1 > LARGE_DAYS);
    check("明天、后天按日期算，不按第几项：中间缺了一天，后面的不会错位；跨月、跨年也对", (() => {
      const make = (dates: string[]) => detailOf({ ...clone(e), days: dates.map((date) => dayOf(date, 10, 5, 0, 0)) });
      const gap = make(["2026-11-02", "2026-11-04", "2026-11-05"]);
      const month = make(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
      const year = make(["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
      return gap.days.map((d) => d.weekday).join() === "后天,周四" && gap.week.map((w) => w.title).join() === "今天,后天,周四" &&
        month.days.map((d) => d.weekday).join() === "明天,后天,周二" && year.days.map((d) => d.weekday).join() === "明天,后天,周日";
    })());
    check("每天一行的内容：图标、最低、最高", detail.days[0].low === "10°" && detail.days[0].high === "17°" && detail.days[0].symbol === "sun.max.fill" && detail.days[1].symbol === "cloud.fill");
    check("降水概率不到 10% 不写，到 10% 写出来", detail.days.every((d) => d.rain === null) && detailOf({ ...clone(e), days: [dayOf("2026-11-02", 1, 0, 0, 0), dayOf("2026-11-03", 5, 1, 61, 9), dayOf("2026-11-04", 5, 1, 61, 10), dayOf("2026-11-05", 5, 1, 61, 80), dayOf("2026-11-06", 5, 1, 61, null)] }).days.map((d) => d.rain).join() === ",10%,80%,");
    check("温度条：这几天的最低对应 0、最高对应 1，每一天的起止都在 0~1 之间且起点不晚于终点", (() => {
      const lows = detail.days.map((d) => d.from);
      const highs = detail.days.map((d) => d.to);
      return Math.min(...lows) === 0 && Math.max(...highs) === 1 && detail.days.every((d) => d.from >= 0 && d.to <= 1 && d.from <= d.to);
    })());
    check("几天温度一样：温度条不除以 0，整条铺满（起点 0、终点 1）", detailOf({ ...clone(e), days: [dayOf("2026-11-02", 9, 9, 0, 0), dayOf("2026-11-03", 9, 9, 0, 0)] }).days.every((d) => d.from === 0 && d.to === 1));
    check("App 页的未来几天：今天、明天、后天、周四、周五、周六，每天一句话", detail.week.map((w) => w.title).join() === "今天,明天,后天,周四,周五,周六" && detail.week[0].summary === "晴  13° ~ 14°" && detail.week[2].summary === "阴  10° ~ 14°");
    check("App 页的未来几天，每天第二行：风、湿度、空气、紫外线连成一行", detail.week[0].extra === "西北风 1级 · 湿度 26% · 空气 优 35 · 紫外线 低" && detail.week[3].extra === "西北风 3级 · 湿度 29% · 空气 优 35 · 紫外线 低");
    check("第二行缺了哪项就不写哪项；一项都没有就是 null；无风写「无风」", (() => {
      const make = (more: Partial<DayForecast>) => detailOf({ ...clone(e), days: [dayOf("2026-11-02", 9, 3, 0, 0, more)] }).week[0].extra;
      return make({}) === null && make({ humidity: 40 }) === "湿度 40%" && make({ uv: "强", aqi: 120 }) === "空气 轻度污染 120 · 紫外线 强" && make({ wind: { kmh: 0.5, direction: 90 } }) === "无风";
    })());
    check("空气质量分级带到每一项上", detailOf({ ...clone(e), aqi: { value: 180, text: "中度污染" } }).stats[3].band === 3);
    check("卡片底部那一行写短名（「中度 180」，四项平分一行，写全名会被截断）；App 页「空气质量」写接口给的全名（「中度污染 180」）", (() => {
      const polluted = detailOf({ ...clone(e), aqi: { value: 180, text: "中度污染" } });
      return polluted.stats[3].value === "中度 180" && polluted.air[0].value === "中度污染 180" && polluted.stats[3].label === "空气" && polluted.air[0].label === "空气质量";
    })());

    // 整张卡
    const loaded: Loaded = { kind: "ok", forecast: base.forecast, extras: base.extras, alerts: base.alerts, provider: "caiyun", fetchedAt: NOW, place: "北京市", source: "live", refreshFailed: false, failure: null };
    const compact = present(loaded, NOW, "compact");
    const large = present(loaded, NOW, "large");
    const plain = present({ ...loaded, extras: null, alerts: null, provider: "openmeteo" }, NOW, "large");
    if (compact.kind !== "weather" || large.kind !== "weather" || plain.kind !== "weather") throw new Error("应该是天气卡");
    check("小号 / 中号：5 格，一排 5 个；带详细数据", compact.slots.length === 5 && compact.columns === 5 && compact.detail !== null);
    check("大号有详细数据：一排 6 格（后面接未来几天）；未来几天画 LARGE_DAYS 天（weather-widget.test.ts 的竖向预算就是按这个数算的）", large.slots.length === 6 && large.columns === 6 && large.detail !== null && large.detail.days.length === LARGE_DAYS);
    check("大号没有详细数据（备用来源）：两排共 10 格，一排 5 个", plain.slots.length === 10 && plain.columns === 5 && plain.detail === null);
    check("晚上的卡片：天空用夜里的、图标是月亮（接口说白天，也不听）", compact.isDay === false && compact.condition.symbol === "moon.stars.fill" && compact.sky === "clear");
    check("出了状况才有提醒；正常时 note 是 null（卡片底部不写更新时间和署名）", compact.note === null && compact.noteShort === null && (present({ ...loaded, refreshFailed: true, failure: describeFailure(new FetchError("server")) }, NOW, "compact") as { note: string | null }).note === "刚才没刷新成功，显示的是之前的数据");
    check("预警字段没取到时，卡片上没有预警（不写「没有预警」）", compact.alert === null && !JSON.stringify(compact).includes("没有预警"));

    // 来源那一行的状态
    const failure = describeFailure(new FetchError("token"));
    check("状态行：没取过 / 没位置 / 没数据（带原因）/ 刷新没成功（带原因）/ 正常（几点更新）", sourceStatusText(null, NOW) === "正在取…" && sourceStatusText({ kind: "noLocation" }, NOW) === "没拿到位置" && sourceStatusText({ kind: "noData", source: "live", place: null, failure }, NOW) === "token 无效，或者没开通" && sourceStatusText({ kind: "noData", source: "live", place: null, failure: null }, NOW) === "天气暂时取不到" && sourceStatusText({ ...loaded, refreshFailed: true, failure }, NOW) === "这次没刷新成功：token 无效，或者没开通" && sourceStatusText({ ...loaded, refreshFailed: true, failure: null }, NOW) === "这次没刷新成功：联网失败" && sourceStatusText(loaded, NOW) === updatedText(NOW, NOW));
  }

  // ---------------------------------------------------------------- 显示样式
  section("显示样式：设置怎么读、一句话和日落怎么挑、卡片上带哪些数据");
  {
    // 设置
    const def = defaultDisplay();
    const everything: Display = { strip: "daily", top: "windHumidity", bottom: "headline", headline: "change" };
    check("默认：逐小时、天气和降水概率、体感湿度风空气、一句话自动（也就是原来的样子）", def.strip === "hourly" && def.top === "condition" && def.bottom === "stats" && def.headline === "auto");
    check("存了再读：一字不差", JSON.stringify(parseDisplay(clone(everything))) === JSON.stringify(everything));
    check("没存过、读不出来、乱写：都是默认的", [null, undefined, 3, "x", [], {}].every((value) => sameDisplay(parseDisplay(value), def)));
    check("某一项读不懂只丢那一项，别的项照用", (() => {
      const got = parseDisplay({ strip: "daily", top: "weird", bottom: 3, headline: "keypoint" });
      return got.strip === "daily" && got.top === "condition" && got.bottom === "stats" && got.headline === "keypoint";
    })());
    check("原型链上的名字、大小写不对的、空串都不认", ["constructor", "__proto__", "Daily", "", "toString"].every((value) => sameDisplay(parseDisplay({ strip: value, top: value, bottom: value, headline: value }), def)));
    check("sameDisplay：四项都一样才算一样", sameDisplay(def, defaultDisplay()) && !sameDisplay(def, { ...def, strip: "daily" }) && !sameDisplay(def, { ...def, top: "windHumidity" }) && !sameDisplay(def, { ...def, bottom: "none" }) && !sameDisplay(def, { ...def, headline: "change" }));
    check("字号用哪套：只有中号选了「未来几天」或「一句话」才用紧凑的；小号、大号、锁屏、没有样式都用原来的", layoutVariant("medium", def) === "standard" && layoutVariant("medium", { ...def, strip: "daily" }) === "compact" && layoutVariant("medium", { ...def, bottom: "headline" }) === "compact" && layoutVariant("medium", { ...def, bottom: "none" }) === "standard" && layoutVariant("medium", { ...def, top: "windHumidity" }) === "standard" && layoutVariant("large", everything) === "standard" && layoutVariant("small", everything) === "standard" && layoutVariant("circular", everything) === "standard" && layoutVariant("medium", null) === "standard");

    // 下一次日出 / 日落
    const sunAt = (offsetHours: number, coord: Coord = BEIJING) => nextSunEvent(adaptOk(SAMPLE, { now: NOW + hours(offsetHours), coord }).forecast);
    const said = (view: { label: string; time: string } | null) => (view === null ? "没有" : view.label + " " + view.time);
    check("晚上 21:22：下一次是明早的日出 06:45", said(sunAt(0)) === "日出 06:45");
    check("凌晨 04:22：下一次是今天的日出 06:44", said(sunAt(-17)) === "日出 06:44");
    check("中午 12:22：下一次是今天的日落 17:11", said(sunAt(-9)) === "日落 17:11");
    check("傍晚 17:22（日落之后）：下一次是明早的日出 06:45", said(sunAt(-4)) === "日出 06:45");
    check("正好是日落那一分钟：已经不算「接下来」，下一次是明早的日出", (() => {
      const forecast = adaptOk(SAMPLE, { now: Date.UTC(2026, 10, 2, 17, 11) - 8 * 3_600_000 }).forecast;
      return said(nextSunEvent(forecast)) === "日出 06:45";
    })());
    check("极夜 / 极昼的地方没有日出日落：null", nextSunEvent(adaptOk(SAMPLE, { coord: { latitude: 78, longitude: 15 }, now: Date.UTC(2026, 11, 21, 12) }).forecast) === null);
    check("日出日落读不出来（乱写的、空的）或当前时间读不出来：null", (() => {
      const broken = clone(base.forecast);
      broken.daily.sunrise = ["坏的", null];
      broken.daily.sunset = [];
      const noNow = clone(base.forecast);
      noNow.current.time = "不是时间";
      return nextSunEvent(broken) === null && nextSunEvent(noNow) === null;
    })());

    // 明天比今天冷还是暖
    const day = (high: number, low: number, date: string) => dayOf(date, high, low, 0, 0);
    check("明天比今天的平均气温：每天最高最低的中间值相减（10/0 → 5，2/-2 → 0，所以 −5）", temperatureChange([day(10, 0, "2026-11-02"), day(2, -2, "2026-11-03")]) === -5);
    check("暖了是正的；差半度也算", temperatureChange([day(10, 0, "2026-11-02"), day(11, 1, "2026-11-03")]) === 1 && temperatureChange([day(10, 1, "2026-11-02"), day(10, 2, "2026-11-03")]) === 0.5);
    check("没有天、只有一天、第二项不是明天（中间缺了一天）：null", temperatureChange([]) === null && temperatureChange([day(1, 0, "2026-11-02")]) === null && temperatureChange([day(1, 0, "2026-11-02"), day(1, 0, "2026-11-04")]) === null);
    check("跨月、跨年也算相邻", temperatureChange([day(5, 1, "2026-10-31"), day(3, 1, "2026-11-01")]) === -1 && temperatureChange([day(5, 1, "2026-12-31"), day(3, 1, "2027-01-01")]) === -1);
    check("样例里明天和今天的平均气温都是 13.5：没变化", base.extras.days.length >= 2 && temperatureChange(base.extras.days) === 0);
    check("变冷：「明日平均降温 N°C」，N 取整（6.5 → 7，平局远离零）", changeText(-6.5, false) === "明日平均降温 7°C" && changeText(-9, true) === "明日平均降温 9°C");
    check("变暖：「明日平均升温 N°C」", changeText(3, false) === "明日平均升温 3°C" && changeText(0.5, false) === "明日平均升温 1°C");
    check("不到 1°：总要写一句时写「明日气温和今天差不多」，否则不写；没有数据都不写", changeText(0.4, true) === "明日气温和今天差不多" && changeText(-0.4, true) === "明日气温和今天差不多" && changeText(0, true) === "明日气温和今天差不多" && changeText(0.4, false) === null && changeText(0, false) === null && changeText(null, true) === null && changeText(null, false) === null);

    // 那句话写什么
    const parts = { rainNote: "25 分钟后开始下雨", keypoint: "今日多云，气温适宜", delta: -6.5 };
    check("彩云的一句话：原样；读不到就是 null", headlineText("keypoint", parts) === parts.keypoint && headlineText("keypoint", { ...parts, keypoint: null }) === null);
    check("明日气温变化：总有一句（变化小也写「差不多」）；没有明天的数据就是 null", headlineText("change", parts) === "明日平均降温 7°C" && headlineText("change", { ...parts, delta: 0.2 }) === "明日气温和今天差不多" && headlineText("change", { ...parts, delta: null }) === null);
    check("自动：有雨先说雨", headlineText("auto", parts) === parts.rainNote);
    check("自动、没有雨：变化够大（≥ 3°，取整后算）就说变化，不够大用彩云的一句话", NOTABLE_CHANGE === 3 && headlineText("auto", { ...parts, rainNote: null }) === "明日平均降温 7°C" && headlineText("auto", { ...parts, rainNote: null, delta: -2.4 }) === parts.keypoint && headlineText("auto", { ...parts, rainNote: null, delta: -2.5 }) === "明日平均降温 3°C" && headlineText("auto", { ...parts, rainNote: null, delta: 3 }) === "明日平均升温 3°C" && headlineText("auto", { ...parts, rainNote: null, delta: null }) === parts.keypoint);
    check("自动：什么都没有就是 null", headlineText("auto", { rainNote: null, keypoint: null, delta: null }) === null && headlineText("auto", { rainNote: null, keypoint: null, delta: 1 }) === null);

    // 卡片上带哪些数据
    const loaded: Loaded = { kind: "ok", forecast: base.forecast, extras: base.extras, alerts: base.alerts, provider: "caiyun", fetchedAt: NOW, place: "北京市", source: "live", refreshFailed: false, failure: null };
    const plainLoaded: Loaded = { ...loaded, extras: null, alerts: null, provider: "openmeteo" };
    const asCard = (content: Content) => {
      if (content.kind !== "weather") throw new Error("应该是天气卡");
      return content;
    };
    const show = (display: Partial<Display>, size: "compact" | "large" = "compact", from: Loaded = loaded) => asCard(present(from, NOW, size, undefined, { ...def, ...display }));
    const withDays = (change: (days: DayForecast[]) => DayForecast[]): Loaded => ({ ...loaded, extras: { ...base.extras, days: change(clone(base.extras.days)) } });

    const plain = show({});
    check("默认样式：和原来一样，没有风湿度、没有几天、没有一句话", sameDisplay(plain.display, def) && plain.topItems.length === 0 && plain.dayColumns.length === 0 && plain.headline === null && plain.slots.length === 5);
    check("底部几项数据（bottomStats）：默认是体感、湿度、风、空气；备用来源没有", plain.bottomStats.map((item) => item.label).join() === "体感,湿度,风,空气" && show({}, "compact", plainLoaded).bottomStats.length === 0);
    check("detailOf 带出了这几样：5 列未来几天、风和湿度两项、明天比今天的气温差", (() => {
      const detail = detailOf(base.extras);
      return MEDIUM_DAYS === 5 && detail.dayColumns.length === 5 && detail.windHumidity.map((item) => item.label).join() === "风,湿度" && detail.tempChange === 0;
    })());

    const daily = show({ strip: "daily" });
    check("中间一排选「未来几天」：明天起 5 天，每天星期、图标、最高、最低", daily.display.strip === "daily" && daily.dayColumns.map((c) => c.label).join() === "明天,后天,周四,周五,周六" && daily.dayColumns.map((c) => c.high).join() === "17°,14°,16°,10°,10°" && daily.dayColumns.map((c) => c.low).join() === "10°,10°,7°,5°,4°" && daily.dayColumns.map((c) => c.symbol).join() === "sun.max.fill,cloud.fill,sun.max.fill,sun.max.fill,cloud.fill");
    check("选了「未来几天」，逐小时那几格还在（锁屏、小号照旧用）", daily.slots.length === 5 && daily.columns === 5);

    const windy = show({ top: "windHumidity" });
    check("右上选「风和湿度」：风（西南风 1级）和湿度（25%）两项", windy.display.top === "windHumidity" && windy.topItems.map((item) => item.label + " " + item.value).join("|") === "风 西南风 1级|湿度 25%");

    check("右上已经写了风和湿度：底部那几项不再重复写它们（只剩体感、空气）", windy.bottomStats.map((item) => item.label).join() === "体感,空气");
    check("右上选了「风和湿度」但有预警：右上那一行让给了徽章，风和湿度就还写在底部", (() => {
      const withAlert = asCard(present(loaded, NOW, "compact", { kind: "ok", items: DEMO_ALERTS.slice(), fetchedAt: NOW, failure: null }, { ...def, top: "windHumidity" }));
      return withAlert.alert !== null && withAlert.bottomStats.map((item) => item.label).join() === "体感,湿度,风,空气";
    })());
    check("风和湿度读不到、右上退回天气和降水概率：底部几项照旧", show({ top: "windHumidity" }, "compact", { ...loaded, extras: { ...base.extras, wind: null, humidity: null } }).bottomStats.map((item) => item.label).join() === "体感,空气");

    const headline = show({ bottom: "headline" });
    check("底部选「一句话」：自动 → 样例没有雨、气温没变化，写彩云的一句话；日出 06:45；空气 优 50（带分级 0）", headline.display.bottom === "headline" && headline.headline !== null && headline.headline.text === "今日多云，气温适宜" && said(headline.headline.sun) === "日出 06:45" && headline.headline.air !== null && headline.headline.air.label === "空气" && headline.headline.air.value === "优 50" && headline.headline.air.band === 0);
    check("一句话的三种写法：彩云的一句话 / 明日气温变化", show({ bottom: "headline", headline: "keypoint" }).headline?.text === "今日多云，气温适宜" && show({ bottom: "headline", headline: "change" }).headline?.text === "明日气温和今天差不多");
    check("自动：明天比今天冷了 10.5° 就写「明日平均降温 11°C」，暖了 3° 写「明日平均升温 3°C」", show({ bottom: "headline" }, "compact", withDays((days) => days.map((d, i) => (i === 1 ? { ...d, high: 5, low: 1 } : d)))).headline?.text === "明日平均降温 11°C" && show({ bottom: "headline" }, "compact", withDays((days) => days.map((d, i) => (i === 1 ? { ...d, high: 19, low: 14 } : d)))).headline?.text === "明日平均升温 3°C");
    check("自动：未来两小时有雨，先说雨", show({ bottom: "headline" }, "compact", { ...loaded, extras: { ...base.extras, rainNote: "25 分钟后开始下雨" } }).headline?.text === "25 分钟后开始下雨");
    check("底部选「不显示」：没有那一行的内容", show({ bottom: "none" }).display.bottom === "none" && show({ bottom: "none" }).headline === null);

    // 画不出来的就退回默认
    check("备用来源（没有详细数据）：选什么都按默认的样子画", (() => {
      const card = show({ strip: "daily", top: "windHumidity", bottom: "headline", headline: "change" }, "compact", plainLoaded);
      return sameDisplay(card.display, def) && card.topItems.length === 0 && card.dayColumns.length === 0 && card.headline === null;
    })());
    check("风和湿度都读不到：右上退回天气和降水概率；只缺一项：照样用风和湿度，只写读到的那项", (() => {
      const none = show({ top: "windHumidity" }, "compact", { ...loaded, extras: { ...base.extras, wind: null, humidity: null } });
      const half = show({ top: "windHumidity" }, "compact", { ...loaded, extras: { ...base.extras, wind: null } });
      return none.display.top === "condition" && none.topItems.length === 0 && half.display.top === "windHumidity" && half.topItems.map((item) => item.label).join() === "湿度";
    })());
    check("没有明天的数据：中间那一排退回逐小时", (() => {
      const card = show({ strip: "daily" }, "compact", withDays((days) => days.slice(0, 1)));
      return card.display.strip === "hourly" && card.dayColumns.length === 0;
    })());
    check("明天起不够 5 天：有几天画几天", show({ strip: "daily" }, "compact", withDays((days) => days.slice(0, 3))).dayColumns.map((c) => c.label).join() === "明天,后天");
    check("一句话、日落、空气三样都读不到：底部退回默认的几项数据", (() => {
      const polar = adaptOk(SAMPLE, { coord: { latitude: 78, longitude: 15 }, now: Date.UTC(2026, 11, 21, 12) });
      const card = show({ bottom: "headline", headline: "keypoint" }, "compact", { ...loaded, forecast: polar.forecast, extras: { ...base.extras, keypoint: null, aqi: null } });
      return card.display.bottom === "stats" && card.headline === null;
    })());
    check("大号：中间一排和右上那一行不管选什么都按默认的；底部那一行照选的画", (() => {
      const card = show({ strip: "daily", top: "windHumidity", bottom: "headline" }, "large");
      return card.display.strip === "hourly" && card.display.top === "condition" && card.display.bottom === "headline" && card.dayColumns.length === 0 && card.topItems.length === 0 && card.headline !== null && card.slots.length === 6;
    })());
    check("effectiveDisplay：没有详细数据就是默认的；选「一句话」但这一行画不出东西，底部退回默认", (() => {
      const detail = detailOf(base.extras);
      return sameDisplay(effectiveDisplay(everything, "compact", null, null), def) && effectiveDisplay(everything, "compact", detail, null).bottom === "stats" && effectiveDisplay(everything, "compact", detail, { text: null, sun: null, air: null }).bottom === "headline";
    })());
  }

  // ---------------------------------------------------------------- 展开 / 收起的记忆
  section("App 页的展开 / 收起：存下来的怎么读、怎么改");
  {
    check("没存过 / 垃圾：全收着", [null, undefined, 3, "x", [], true].every((value) => Object.keys(parseFolds(value)).length === 0));
    check("只认认得的组、只认 true：别的名字、false、字符串、数字都丢掉", JSON.stringify(parseFolds({ display: true, place: false, source: "true", alerts: 1, 不认识: true, week: true })) === JSON.stringify({ display: true, week: true }));
    check("每一组都读得回来", JSON.stringify(parseFolds(Object.fromEntries(FOLD_IDS.map((id) => [id, true])))) === JSON.stringify(Object.fromEntries(FOLD_IDS.map((id) => [id, true]))));
    check("组的 id 不重复，一共 12 组", new Set(FOLD_IDS).size === FOLD_IDS.length && FOLD_IDS.length === 12);
    check("展开一组：加上、不改传进来的；收起：去掉；重复展开不出错；收起没展开过的也不出错", (() => {
      const start: Folds = { place: true };
      const opened = setFold(start, "display", true);
      const closed = setFold(opened, "place", false);
      return JSON.stringify(start) === JSON.stringify({ place: true }) && JSON.stringify(opened) === JSON.stringify({ place: true, display: true }) && JSON.stringify(closed) === JSON.stringify({ display: true }) && JSON.stringify(setFold(opened, "display", true)) === JSON.stringify(opened) && Object.keys(setFold({}, "week", false)).length === 0;
    })());
  }

  // ---------------------------------------------------------------- 源码扫描
  section("源码扫描");
  {
    const files = sourceFiles(SCRIPT_DIR);
    const read = (file: string) => readFileSync(file, "utf8");
    const codeOf = (file: string) => read(file).split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
    check("数据来源的存储键只在 store.ts 里写一处；老版本的键只出现在清理名单里", files.filter((file) => /weather\.source\.v1/.test(read(file))).length === 1 && /weather\.source\.v1/.test(read(join(SCRIPT_DIR, "core", "store.ts"))) && files.filter((file) => /weather\.alert-source/.test(read(file))).length === 1);
    check("联网（fetch）只在 caiyun.ts 和 openmeteo.ts 里", files.filter((file) => /\bfetch\(/.test(codeOf(file))).map((file) => file.replace(/^.*[\\/]/, "")).sort().join() === "caiyun.ts,openmeteo.ts");
    check("碰存储（Storage.）只在 store.ts 里", files.filter((file) => /\bStorage\./.test(codeOf(file))).map((file) => file.replace(/^.*[\\/]/, "")).join() === "store.ts");
    check("彩云那一层的纯逻辑文件（整理、日出日落、详细数据、失败原因、来源设置、预警状态）不碰系统", ["caiyunWeather.ts", "sun.ts", "extras.ts", "failure.ts", "dataSource.ts", "alertState.ts", "display.ts", "headline.ts"].every((name) => !/\b(Storage|Location|Widget|Script|fetch)\b[.(]/.test(codeOf(join(SCRIPT_DIR, "core", name)))));
    check("时间一律用手机的时钟：整理那一步不读 Date.now()（由调用方传进来，自测才能固定时间）", !/Date\.now\(\)/.test(codeOf(join(SCRIPT_DIR, "core", "caiyunWeather.ts"))) && !/Date\.now\(\)/.test(codeOf(join(SCRIPT_DIR, "core", "sun.ts"))));
    const keys = [...read(join(SCRIPT_DIR, "core", "store.ts")).matchAll(/const (\w+_KEY) = "([^"]+)"/g)].map((match) => match[2]);
    check("存储的键都不一样（显示样式的键不能和别的撞）", keys.length >= 6 && new Set(keys).size === keys.length && keys.includes("weather.display.v1"));
    const widgetEntry = read(join(SCRIPT_DIR, "widget.tsx"));
    const indexCode = read(join(SCRIPT_DIR, "index.tsx"));
    check("显示样式接线：小组件读存下来的样式交给 present；脚本页的卡片预览用同一份；换样式时存下来、让小组件重画", /present\(loaded, now, size, alerts, loadDisplay\(\)\)/.test(widgetEntry) && /present\(loaded, now, "compact", alerts \?\? \{ kind: "off" \}, display\)/.test(indexCode) && /<DisplaySection display=\{display\} onChange=\{changeDisplay\} fold=\{foldOf\("display"\)\} \/>/.test(indexCode) && /function changeDisplay\(next: Display\): void \{[\s\S]{0,200}saveDisplay\(next\);[\s\S]{0,80}Widget\.reloadAll\(\);/.test(indexCode));
    check("脚本页分类和展开 / 收起的接线：三类标题（小组件设置 / 天气详情 / 其他）；每一组的 id 都在 foldOf(...) 里用到一次、不重复；点了展开 / 收起就存下来；页面组件自己不再套 Section", FOLD_IDS.every((id) => indexCode.split(`foldOf("${id}")`).length === 2) && (indexCode.match(/foldOf\("/g) ?? []).length === FOLD_IDS.length && /<Section header=\{<Text>小组件设置<\/Text>\}>/.test(indexCode) && /<Section header=\{<Text>天气详情<\/Text>\}>/.test(indexCode) && /<Section header=\{<Text>其他<\/Text>\}>/.test(indexCode) && /function foldOf\(id: FoldId\): FoldState \{[\s\S]{0,260}setFold\(folds, id, open\);[\s\S]{0,80}saveFolds\(next\);/.test(indexCode) && /hasDetail\(detail\) \? \(/.test(indexCode) && /open: folds\[id\] === true/.test(indexCode) && /<Fold title="位置" note=\{placeNote\} fold=\{foldOf\("place"\)\}/.test(indexCode) && /const placeNote = settings\.mode === "fixed" \? "固定城市：" \+ fixedLabel : "跟着当前定位";/.test(indexCode) && /useState<Folds>\(\(\) => loadFolds\(\)\)/.test(indexCode) && ["DisplaySection", "SourceSection", "AlertsSection", "DetailSections"].every((name) => !/<Section\b/.test(codeOf(join(SCRIPT_DIR, "pages", name + ".tsx")))));
    check("展开状态不碰网络、不碰存储（只有 store.ts 碰）：folds.ts 里没有 Storage / fetch", !/\b(Storage|fetch)\b/.test(codeOf(join(SCRIPT_DIR, "core", "folds.ts"))));
    check("显示样式不碰网络、不碰存储（只有 store.ts 碰）：display.ts、headline.ts 里没有 Storage / fetch", !/\b(Storage|fetch)\b/.test(codeOf(join(SCRIPT_DIR, "core", "display.ts"))) && !/\b(Storage|fetch)\b/.test(codeOf(join(SCRIPT_DIR, "core", "headline.ts"))));
    check("地名写到哪一级接线：脚本页「位置」里有选择器，换了就存下来并重取；选好固定城市时不丢这一项；place.ts / settings.ts / refresh.ts 不碰系统", /<PlaceLevelPicker level=\{settings\.placeLevel\} onChange=\{changePlaceLevel\} \/>/.test(indexCode) && /function changePlaceLevel\(next: PlaceLevel\): void \{[\s\S]{0,200}saveSettings\(saved\);[\s\S]{0,80}void refresh\(false, saved\);/.test(indexCode) && /const saved: Settings = \{ \.\.\.loadSettings\(\), mode: "fixed", fixed: place \};/.test(indexCode) && ["place.ts", "settings.ts", "refresh.ts"].every((name) => !/\b(Storage|Location|Widget|Script|fetch)\b[.(]/.test(codeOf(join(SCRIPT_DIR, "core", name)))));
  }

  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  console.log("\n" + passed + " 项通过，" + failed + " 项失败");
  if (failed > 0) process.exit(1);
}

void main();
