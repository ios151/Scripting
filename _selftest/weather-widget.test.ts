// 离线自测（Node 里跑，不碰 Scripting 的原生 API）。
//   npx -y -p tsx tsx _selftest/weather-widget.test.ts
//   类型检查：看仓库根的 tsconfig.json（只管脚本目录）；自测文件自己更严的那份 tsconfig 在作者本地，没放进仓库
//
// 覆盖「天气小组件」里的纯逻辑（天气小组件/core/）：
//   · 天气代码表、查询参数、坐标取整：和 RoamControl 的 Swift 源码对拍（golden.json 里是从 Swift 源码读出来的值）
//   · 逐小时拼装：weather_fixture.json（真实接口返回）上的 281 个变体，和 Python 移植 weather_port.py 的结果逐项对拍
//   · 格数可选（大号 10 格）：和一份不看实现、只会「摊平、排序、取前几个」的独立模型对拍
//   · 接口返回的解析：必需的键缺了 / 类型对不上整份当解不开
//   · 刷新规则、取天气的整条退路（用假的定位 / 联网 / 存储把每条分支跑一遍）
//   · 要说的话、版式尺寸、配色对比度、源码里几条「设备上会炸」的写法
// 画面本身（卡片版式、多色图标、渐变）这里看不到，只能上真机。
// 对拍数据（weather-widget-golden/golden.json）由作者本地的 Python 移植生成；生成脚本读的是本机的文件，没放进仓库，这里只留结果。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseCache, parseStoredLocation, type Cache, type StoredLocation } from "../天气小组件/core/cache";
import type { Provider } from "../天气小组件/core/dataSource";
import type { Extras } from "../天气小组件/core/extras";
import { FetchError } from "../天气小组件/core/failure";
import { conditionFor, knownCodes } from "../天气小组件/core/condition";
import { parseForecast, type Forecast } from "../天气小组件/core/forecast";
import { distanceMeters, isValidCoord, type Coord } from "../天气小组件/core/geo";
import { defaultDisplay, type Display } from "../天气小组件/core/display";
import { ALERT_BADGE_RATIO, CONTENT_MARGIN, familyOf, layoutVariant, metricsFor } from "../天气小组件/core/layout";
import { loadWeather, type Deps, type Input, type Loaded } from "../天气小组件/core/load";
import { ENDPOINT, ForecastError, buildURL, fetchForecast, roundedForRequest } from "../天气小组件/core/openmeteo";
import { AQI_COLOR, RAIN_TEXT, SKY, TEXT_SECONDARY_ALPHA } from "../天气小组件/core/palette";
import { LARGE_DAYS, NO_DATA, NO_LOCATION, present, rangeText, updatedText } from "../天气小组件/core/present";
import { DISTRICT_NAME_THRESHOLD_M, FRESHNESS_MS, MOVE_THRESHOLD_M, isFresh, nameStillApplies } from "../天气小组件/core/refresh";
import { nextReloadAt } from "../天气小组件/core/schedule";
import { defaultSettings, parseParameter, parseSettings, type PlaceLevel, type Settings } from "../天气小组件/core/settings";
import { SLOT_COUNT, buildSnapshot, localParts, parseLocalTime, roundAway, type Snapshot } from "../天气小组件/core/snapshot";
import { cityName, districtName, pickPlace, placeLabel, placeParts, type PlacemarkLike } from "../天气小组件/core/place";
import { RELOAD_AFTER_MS, RELOAD_RETRY_MS } from "../天气小组件/core/config";
import { fetchWeatherWithin, findPlace, reverseName, withTimeout } from "../天气小组件/core/system";

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

type Patch = [(string | number)[], unknown];
type GoldenSlot = {
  kind: string;
  date: string;
  temperature: number | null;
  condition: [string, string];
  label: string;
  caption: string | null;
};
type GoldenSnapshot = {
  temperature: number;
  condition: [string, string];
  high: number;
  low: number;
  rainChance: number | null;
  slots: GoldenSlot[];
};
type Golden = {
  slotCount: number;
  conditionTable: Record<string, [string, string, string]>;
  conditionDefault: [string, string];
  conditionProbe: Array<[number, boolean, string, string]>;
  query: { endpoint: string; items: Record<string, string>; slotCount: number };
  coordinateProbe: Array<[number, string]>;
  scenarios: Array<{ name: string; patches: Patch[]; expected: GoldenSnapshot | null }>;
};

const FIXTURE: unknown = JSON.parse(readFileSync(join(GOLDEN_DIR, "weather_fixture.json"), "utf8"));
const GOLDEN: Golden = JSON.parse(readFileSync(join(GOLDEN_DIR, "golden.json"), "utf8"));

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyPatches(base: unknown, patches: Patch[]): unknown {
  const out = clone(base) as Record<string, unknown>;
  for (const [path, value] of patches) {
    let node: any = out;
    for (const key of path.slice(0, -1)) node = node[key];
    node[path[path.length - 1]] = clone(value);
  }
  return out;
}

/** 当地时间字符串 `yyyy-MM-ddTHH:mm`（把 UTC 毫秒按偏移挪成当地钟点再读） */
function localString(epoch: number, offsetSeconds: number): string {
  return new Date(epoch + offsetSeconds * 1000).toISOString().slice(0, 16);
}

function toGolden(snapshot: Snapshot, offsetSeconds: number): GoldenSnapshot {
  return {
    temperature: snapshot.temperature,
    condition: [snapshot.condition.text, snapshot.condition.symbol],
    high: snapshot.high,
    low: snapshot.low,
    rainChance: snapshot.rainChance,
    slots: snapshot.slots.map((slot) => ({
      kind: slot.kind,
      date: localString(slot.date, offsetSeconds),
      temperature: slot.temperature,
      condition: [slot.condition.text, slot.condition.symbol],
      label: slot.label,
      caption: slot.caption,
    })),
  };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function mustParse(value: unknown): Forecast {
  const forecast = parseForecast(value);
  if (forecast === null) throw new Error("样例解不开");
  return forecast;
}

async function main(): Promise<void> {
  const base = mustParse(FIXTURE);

  // ---------------------------------------------------------------- 天气代码表
  section("天气代码表（对 Swift 源码）");
  {
    const table = GOLDEN.conditionTable;
    check("代码集合和 Swift 的 28 个一致", JSON.stringify(knownCodes().sort((a, b) => a - b)) === JSON.stringify(Object.keys(table).map(Number).sort((a, b) => a - b)));
    check("一共 28 个代码", knownCodes().length === 28);
    let mismatches = 0;
    for (const [code, isDay, text, symbol] of GOLDEN.conditionProbe) {
      const got = conditionFor(code, isDay);
      if (got.text !== text || got.symbol !== symbol) mismatches++;
    }
    check(`${GOLDEN.conditionProbe.length} 条探针（-1 ~ 120，昼夜各一）文案和图标全部一致`, mismatches === 0);
    check("不认识的代码是「未知」+ 云，不冒充晴", conditionFor(999, true).text === GOLDEN.conditionDefault[0] && conditionFor(-1, false).symbol === GOLDEN.conditionDefault[1]);
    const nightOnly = [0, 1, 2, 80, 81];
    check("只有这几个代码区分昼夜", knownCodes().every((code) => (conditionFor(code, true).symbol !== conditionFor(code, false).symbol) === nightOnly.includes(code)));
    check("每个代码都有天空色", knownCodes().every((code) => conditionFor(code, true).sky in SKY));
    check("晴是 clear、阴是 overcast、雷暴是 storm、小雪是 snow", conditionFor(0, true).sky === "clear" && conditionFor(3, true).sky === "overcast" && conditionFor(95, true).sky === "storm" && conditionFor(71, true).sky === "snow");
  }

  // ---------------------------------------------------------------- 查询参数
  section("查询参数与坐标取整（对 Swift 源码）");
  {
    check("接口地址一致", GOLDEN.query.endpoint === ENDPOINT);
    check("逐小时格数一致（slotCount = 5）", GOLDEN.query.slotCount === SLOT_COUNT && GOLDEN.slotCount === SLOT_COUNT);
    const url = new URL(buildURL(31.2749, 121.49648));
    check("路径是预报接口", url.origin + url.pathname === ENDPOINT);
    const got = Object.fromEntries(url.searchParams.entries());
    const { latitude, longitude, ...items } = got;
    check("五个查询项和 Swift 一字不差", JSON.stringify(items) === JSON.stringify(GOLDEN.query.items));
    check("纬度经度各取两位小数", latitude === "31.27" && longitude === "121.50");
    check("查询项顺序和 Swift 一致", buildURL(0, 0).split("?")[1].split("&").map((part) => part.split("=")[0]).join(",") === "latitude,longitude," + Object.keys(GOLDEN.query.items).join(","));
    check("逗号不转义（和 URLComponents 一样）", buildURL(0, 0).includes("current=temperature_2m,weather_code,is_day"));
    let coordinateMismatch = 0;
    for (const [value, expected] of GOLDEN.coordinateProbe) if (roundedForRequest(value).toFixed(2) !== expected) coordinateMismatch++;
    check(`${GOLDEN.coordinateProbe.length} 个坐标取整结果和 Python 一致`, coordinateMismatch === 0);
    check("负坐标取整远离零：-122.4194 → -122.42", roundedForRequest(-122.4194) === -122.42);
    check("取整不会冒出 -0.00", buildURL(-0.0001, -0.0001).includes("latitude=0.00&longitude=0.00"));
  }

  // ---------------------------------------------------------------- 拼装对拍
  section("逐小时拼装：和 Python 移植逐项对拍");
  {
    check("样例能解开", parseForecast(FIXTURE) !== null);
    let compared = 0;
    let mismatched: string[] = [];
    for (const scenario of GOLDEN.scenarios) {
      const patched = applyPatches(FIXTURE, scenario.patches);
      const forecast = parseForecast(patched);
      if (forecast === null) {
        mismatched.push(scenario.name + "（解析失败）");
        continue;
      }
      const snapshot = buildSnapshot(forecast, 0);
      const actual = snapshot === null ? null : toGolden(snapshot, forecast.utc_offset_seconds);
      compared++;
      if (JSON.stringify(actual) !== JSON.stringify(scenario.expected)) mismatched.push(scenario.name);
    }
    check(`${compared} 个变体全部对得上`, mismatched.length === 0 && compared === GOLDEN.scenarios.length);
    for (const name of mismatched.slice(0, 8)) console.log("    · 不一致：" + name);

    const nullScenarios = GOLDEN.scenarios.filter((s) => s.expected === null).length;
    check("预期为空的变体都真的返回了 null（最高 / 最低缺失、时间解不开）", nullScenarios >= 8);

    // 把几个关键点再人工钉死一遍，免得对拍数据和实现一起错
    const at = (time: string) => buildSnapshot(mustParse(applyPatches(FIXTURE, [[["current", "time"], time]])), 0);
    const labels = (snapshot: Snapshot | null) => (snapshot === null ? [] : snapshot.slots.map((s) => s.label));
    check("15:30 → 现在、16时、17时、17:55 日落、18时", JSON.stringify(labels(at("2026-10-31T15:30"))) === JSON.stringify(["现在", "16时", "17时", "17:55", "18时"]));
    check("23:30 跨午夜 → 0时、1时、2时、3时", JSON.stringify(labels(at("2026-10-31T23:30"))) === JSON.stringify(["现在", "0时", "1时", "2时", "3时"]));
    check("05:10 日出前 → 6时、06:55 日出、7时、8时", JSON.stringify(labels(at("2026-10-31T05:10"))) === JSON.stringify(["现在", "6时", "06:55", "7时", "8时"]));
    check("夜里 20:00 不混入次日日出", JSON.stringify(labels(at("2026-10-31T20:00"))) === JSON.stringify(["现在", "21时", "22时", "23时", "0时"]));
    const sunset = at("2026-10-31T15:30")?.slots[3];
    check("日落那一格：没有气温、说明是「日落」、图标是 sunset.fill", sunset !== undefined && sunset.temperature === null && sunset.caption === "日落" && sunset.condition.symbol === "sunset.fill");
    const noon = at("2026-10-31T15:30");
    check("18.5° 进位成 19°（不是银行家舍入的 18）", noon !== null && noon.temperature === 19 && noon.slots[0].temperature === 19);
    check("降水概率取当前所在整点（15 时 = 56%）", noon !== null && noon.rainChance === 56);
    check("今日最高最低 19 / 17", noon !== null && noon.high === 19 && noon.low === 17);
    check("fetchedAt 原样带出", buildSnapshot(base, 123456)?.fetchedAt === 123456);
    check("白天标记：样例是白天", noon !== null && noon.isDay);
  }

  section("取整与时间解析");
  {
    check("取整平局远离零", roundAway(18.5) === 19 && roundAway(-0.5) === -1 && roundAway(-3.5) === -4 && roundAway(0.5) === 1 && roundAway(-3.4) === -3);
    check("取整不返回 -0", Object.is(roundAway(-0.4), 0) && Object.is(roundAway(-0), 0));
    check("解当地时间：东八区 15:30 = UTC 07:30", parseLocalTime("2026-10-31T15:30", 28800) === Date.UTC(2026, 9, 31, 7, 30));
    check("解当地时间：西五区 15:30 = UTC 20:30", parseLocalTime("2026-10-31T15:30", -18000) === Date.UTC(2026, 9, 31, 20, 30));
    check("不存在的日期 / 越界钟点 / 格式不对都是 null", ["2026-02-30T10:00", "2026-13-01T10:00", "2026-10-31T24:00", "2026-10-31T10:60", "2026-10-31 15:30", "2026-10-31T15:30:00", "2026-10-31T5:30", "", "x"].every((text) => parseLocalTime(text, 0) === null));
    check("闰日有效、平年没有", parseLocalTime("2028-02-29T00:00", 0) !== null && parseLocalTime("2027-02-29T00:00", 0) === null);
    check("缺失（null / undefined）是 null", parseLocalTime(null, 0) === null && parseLocalTime(undefined, 0) === null);
    const epoch = parseLocalTime("2026-10-31T17:55", 19800);
    const parts = epoch === null ? null : localParts(epoch, 19800);
    check("当地钟点往返不变（含半小时时区）", parts !== null && parts.hour === 17 && parts.minute === 55);
  }

  // ---------------------------------------------------------------- 独立模型（格数可选）
  section("格数可选：和独立模型对拍");
  {
    /** 不看实现的写法：把「现在之后的所有事件」摊平、排序、取前 n-1 个。时间一律当「当地钟点」直接比，不碰时区 */
    function model(forecast: Forecast, count: number): Array<[string, number | null, string | null]> {
      const stamp = (text: string) => Date.parse(text + ":00Z");
      const now = stamp(forecast.current.time);
      const events: Array<{ when: number; order: number; label: string; temp: number | null; caption: string | null }> = [];
      forecast.hourly.time.forEach((text, index) => {
        const when = stamp(text);
        const temp = forecast.hourly.temperature_2m[index];
        if (when > now && temp !== null && temp !== undefined) {
          events.push({ when, order: 0, label: new Date(when).getUTCHours() + "时", temp: Math.sign(temp) * Math.floor(Math.abs(temp) + 0.5), caption: null });
        }
      });
      for (const [key, caption] of [["sunrise", "日出"], ["sunset", "日落"]] as const) {
        for (const text of forecast.daily[key]) {
          if (text === null) continue;
          const when = stamp(text);
          if (when > now) events.push({ when, order: 1, label: text.slice(11), temp: null, caption });
        }
      }
      events.sort((a, b) => a.when - b.when || a.order - b.order);
      return events.slice(0, count - 1).map((e) => [e.label, e.temp, e.caption]);
    }

    let mismatches = 0;
    let runs = 0;
    for (const count of [1, 2, 4, 5, 6, 10, 12]) {
      for (let minute = 0; minute < 24 * 60; minute += 15) {
        const time = "2026-10-31T" + String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
        const forecast = mustParse(applyPatches(FIXTURE, [[["current", "time"], time]]));
        const snapshot = buildSnapshot(forecast, 0, count);
        runs++;
        if (snapshot === null) {
          mismatches++;
          continue;
        }
        const got = snapshot.slots.slice(1).map((slot) => [slot.label, slot.temperature, slot.caption]);
        if (JSON.stringify(got) !== JSON.stringify(model(forecast, count)) || snapshot.slots.length !== Math.min(count, 1 + model(forecast, 99).length)) mismatches++;
      }
    }
    check(`7 种格数 × 96 个时刻 = ${runs} 次，和独立模型一致（含日落夹在整点之间）`, mismatches === 0);
    check("格数默认 5", buildSnapshot(base, 0)?.slots.length === 5);
    check("大号 10 格：现在 + 9 个", buildSnapshot(base, 0, 10)?.slots.length === 10);
    check("格数 1 只有「现在」", buildSnapshot(base, 0, 1)?.slots.length === 1);
    check("格数 0 或负数不崩，至少有「现在」", buildSnapshot(base, 0, 0)?.slots.length === 1 && buildSnapshot(base, 0, -3)?.slots.length === 1);
    const ten = buildSnapshot(base, 0, 10);
    check("10 格的时间不倒退", ten !== null && ten.slots.every((slot, i, all) => i === 0 || slot.date >= all[i - 1].date));
  }

  // ---------------------------------------------------------------- 解析严格度
  section("接口返回的解析");
  {
    const raw = FIXTURE as Record<string, any>;
    const broken = (mutate: (copy: Record<string, any>) => void): unknown => {
      const copy = clone(raw);
      mutate(copy);
      return copy;
    };
    check("样例解得开", parseForecast(raw) !== null);
    check("不是对象的一律解不开", [null, undefined, 3, "x", true, []].every((value) => parseForecast(value) === null));
    check("缺 utc_offset_seconds 解不开", parseForecast(broken((c) => delete c.utc_offset_seconds)) === null);
    check("utc_offset_seconds 不是整数解不开", parseForecast(broken((c) => (c.utc_offset_seconds = 28800.5))) === null && parseForecast(broken((c) => (c.utc_offset_seconds = "28800"))) === null);
    check("缺 current / hourly / daily 解不开", ["current", "hourly", "daily"].every((key) => parseForecast(broken((c) => delete c[key])) === null));
    check("current 里字段类型不对解不开", [["time", 1], ["temperature_2m", "18"], ["weather_code", null], ["is_day", true]].every(([key, value]) => parseForecast(broken((c) => (c.current[key as string] = value))) === null));
    check("hourly 缺任何一组数组解不开", ["time", "temperature_2m", "weather_code", "precipitation_probability", "is_day"].every((key) => parseForecast(broken((c) => delete c.hourly[key])) === null));
    check("hourly.time 里混进数字解不开", parseForecast(broken((c) => (c.hourly.time[3] = 5))) === null);
    check("数组里混进字符串数字解不开（Swift 的 Double? 也不收）", parseForecast(broken((c) => (c.hourly.temperature_2m[3] = "17.1"))) === null);
    check("daily 缺任何一组数组解不开", ["temperature_2m_max", "temperature_2m_min", "sunrise", "sunset"].every((key) => parseForecast(broken((c) => delete c.daily[key])) === null));
    check("日出里混进数字解不开", parseForecast(broken((c) => (c.daily.sunrise[0] = 655))) === null);
    check("数组里的 null 是允许的（预报尽头常有）", parseForecast(broken((c) => { c.hourly.temperature_2m[47] = null; c.hourly.weather_code[47] = null; c.daily.sunset[1] = null; })) !== null);
    check("数字写成 3 还是 3.0 一样", parseForecast(broken((c) => (c.current.weather_code = 3.0))) !== null);
    check("温度是 NaN / Infinity 解不开", parseForecast({ ...raw, current: { ...raw.current, temperature_2m: Number.NaN } }) === null && parseForecast({ ...raw, current: { ...raw.current, temperature_2m: Infinity } }) === null);
    const parsed = parseForecast(raw);
    check("多余的字段不带进缓存（只留用得到的）", parsed !== null && JSON.stringify(Object.keys(parsed)) === JSON.stringify(["utc_offset_seconds", "current", "hourly", "daily"]) && Object.keys(parsed.current).length === 4);
    check("解出来的是新对象，改它不会改到原件", parsed !== null && parsed.hourly.time !== raw.hourly.time);
    const roundTrip = parseForecast(JSON.parse(JSON.stringify(parsed)));
    check("缓存存了再读，一字不差（读缓存走同一个函数）", JSON.stringify(roundTrip) === JSON.stringify(parsed));
  }

  // ---------------------------------------------------------------- 位置与刷新规则
  section("距离与刷新规则");
  {
    const beijing: Coord = { latitude: 39.9, longitude: 116.4 };
    const north = (degrees: number): Coord => ({ latitude: beijing.latitude + degrees, longitude: beijing.longitude });
    const km = distanceMeters(beijing, north(0.05)) / 1000;
    check("纬度差 0.05° ≈ 5.56 公里", km > 5.5 && km < 5.6);
    check("纬度差 0.04° ≈ 4.45 公里（不到 5 公里）", distanceMeters(beijing, north(0.04)) < MOVE_THRESHOLD_M);
    check("同一点距离是 0；对称", distanceMeters(beijing, beijing) === 0 && distanceMeters(beijing, north(0.3)) === distanceMeters(north(0.3), beijing));
    check("跨经线 / 跨半球不出 NaN", Number.isFinite(distanceMeters({ latitude: -33.9, longitude: 179.9 }, { latitude: -33.9, longitude: -179.9 })) && distanceMeters({ latitude: -33.9, longitude: 179.9 }, { latitude: -33.9, longitude: -179.9 }) < 20_000);
    check("北京到上海约 1060 公里", Math.abs(distanceMeters({ latitude: 39.9042, longitude: 116.4074 }, { latitude: 31.2304, longitude: 121.4737 }) / 1000 - 1068) < 15);
    check("坐标合法性：越界 / 非数字 / 缺字段都不合法", !isValidCoord({ latitude: 91, longitude: 0 }) && !isValidCoord({ latitude: 0, longitude: 181 }) && !isValidCoord({ latitude: "1", longitude: 2 }) && !isValidCoord({ latitude: 1 }) && !isValidCoord(null) && isValidCoord({ latitude: -90, longitude: 180 }));

    const T0 = Date.UTC(2026, 9, 31, 7, 30);
    const cached = { fetchedAt: T0, anchor: beijing };
    check("没有缓存不新", !isFresh(null, beijing, T0));
    check("刚取的是新的", isFresh(cached, beijing, T0));
    check("14 分 59 秒还新、15 分整就旧了（15 分钟界线）", isFresh(cached, beijing, T0 + FRESHNESS_MS - 1000) && !isFresh(cached, beijing, T0 + FRESHNESS_MS));
    check("时间新但位置挪出 5 公里就旧了", !isFresh(cached, north(0.05), T0 + 60_000) && isFresh(cached, north(0.04), T0 + 60_000));
    check("取到的时刻在未来（时钟被往回拨过）算旧", !isFresh({ fetchedAt: T0 + 3_600_000, anchor: beijing }, beijing, T0));
    check("地名：没名字 / 没锚点不适用", !nameStillApplies(beijing, null, beijing) && !nameStillApplies(beijing, "", beijing) && !nameStillApplies(null, "北京", beijing));
    check("地名：5 公里内适用、超过不适用", nameStillApplies(beijing, "北京", north(0.04)) && !nameStillApplies(beijing, "北京", north(0.05)));
    check("地名写到区县：2 公里内适用、超过不适用；写到城市还是 5 公里", nameStillApplies(beijing, "海淀区", north(0.017), "district") && !nameStillApplies(beijing, "海淀区", north(0.019), "district") && nameStillApplies(beijing, "北京", north(0.019), "city") && nameStillApplies(beijing, "北京", north(0.019)) && DISTRICT_NAME_THRESHOLD_M === 2000 && DISTRICT_NAME_THRESHOLD_M < MOVE_THRESHOLD_M);
    check("地名写到区县：没名字 / 没锚点照样不适用", !nameStillApplies(beijing, null, beijing, "district") && !nameStillApplies(beijing, "", beijing, "district") && !nameStillApplies(null, "海淀区", beijing, "district"));
  }

  // ---------------------------------------------------------------- 取天气的整条退路
  section("取天气：位置顺序、缓存、失败退路");
  {
    const beijing: Coord = { latitude: 39.9, longitude: 116.4 };
    const north = (degrees: number): Coord => ({ latitude: beijing.latitude + degrees, longitude: beijing.longitude });
    const T0 = Date.UTC(2026, 9, 31, 7, 30);
    const minutes = (n: number) => n * 60_000;
    const auto: Input = { settings: defaultSettings(), parameter: null, force: false };

    type World = {
      now: number;
      live: Coord | null | "throw";
      fetchMode: "ok" | "fail" | "throw";
      name: string | null | "throw";
      /** 反查时系统给的区县名（默认没有） */
      district: string | null;
      cache: Cache | null;
      location: StoredLocation | null;
      calls: { live: number; fetch: number; name: number; writeCache: number };
      lastFetchAt: Coord | null;
      /** 反查最后一次是对着哪个位置查的 */
      lastNameAt: Coord | null;
      /** 现在用哪个来源；彩云的返回带详细数据和预警，Open-Meteo 的没有 */
      provider: Provider;
      /** 联网那一步最后一次收到的「上一次的预报」 */
      lastPrevious: Forecast | null;
    };

    const EXTRAS: Extras = {
      apparent: 6, humidity: 28, wind: { kmh: 11.9, direction: 193 }, pressure: 1020, visibility: 24.1, cloud: 10, dewpoint: -3,
      aqi: { value: 50, text: "优" }, pollutants: { pm25: 35, pm10: 50, o3: 100, no2: 40, so2: 20, co: 1 }, uv: { index: 0, text: "低" },
      keypoint: "今日多云，气温适宜", dayOutlook: "未来24小时多云，气温适中", rainOutlook: "未来2小时无降水", rainNote: null,
      life: { dressing: "薄外套", carWashing: "适宜", comfort: "冷", coldRisk: "较易发" },
      days: [{ date: "2026-10-31", high: 19, low: 17, code: 3, rainChance: 20, wind: null, humidity: null, aqi: null, uv: null }],
    };

    function world(overrides: Partial<World> = {}): { w: World; deps: Deps } {
      const w: World = { now: T0, live: beijing, fetchMode: "ok", name: "北京", district: null, cache: null, location: null, calls: { live: 0, fetch: 0, name: 0, writeCache: 0 }, lastFetchAt: null, lastNameAt: null, provider: "openmeteo", lastPrevious: null, ...overrides };
      const deps: Deps = {
        now: () => w.now,
        readCache: () => w.cache,
        writeCache: (cache) => {
          w.calls.writeCache++;
          w.cache = clone(cache);
        },
        readLocation: () => w.location,
        writeLocation: (location) => {
          w.location = clone(location);
        },
        liveLocation: async () => {
          w.calls.live++;
          if (w.live === "throw") throw new Error("没权限");
          return w.live;
        },
        provider: () => w.provider,
        fetchWeather: async (coord, previous) => {
          w.calls.fetch++;
          w.lastFetchAt = coord;
          w.lastPrevious = previous === null ? null : clone(previous);
          if (w.fetchMode === "throw") throw new Error("没网");
          if (w.fetchMode === "fail") throw new FetchError("server", "HTTP 500");
          return w.provider === "caiyun"
            ? { forecast: clone(base), extras: clone(EXTRAS), alerts: { items: [], failure: null } }
            : { forecast: clone(base), extras: null, alerts: null };
        },
        reverseName: async (coord) => {
          w.calls.name++;
          w.lastNameAt = coord;
          if (w.name === "throw") throw new Error("反查失败");
          return w.name === null ? null : { city: w.name, district: w.district };
        },
      };
      return { w, deps };
    }

    function ok(loaded: Loaded): Extract<Loaded, { kind: "ok" }> {
      if (loaded.kind !== "ok") throw new Error("应该取到天气，实际是 " + loaded.kind);
      return loaded;
    }

    // a. 什么位置都没有
    {
      const { w, deps } = world({ live: null });
      const loaded = await loadWeather(deps, auto);
      check("a 没定位也没存过：没有位置", loaded.kind === "noLocation" && w.calls.fetch === 0);
    }
    // b. 第一次：现场定位 → 联网 + 反查 → 写缓存、存定位
    const first = world();
    {
      const loaded = ok(await loadWeather(first.deps, auto));
      check("b 第一次：联网一次、反查一次", first.w.calls.fetch === 1 && first.w.calls.name === 1);
      check("b 地名是反查来的，来源是现场定位", loaded.place === "北京" && loaded.source === "live" && !loaded.refreshFailed);
      check("b 缓存写进去了，带着地名和锚点", first.w.cache !== null && first.w.cache.place === "北京" && first.w.cache.placeAnchor !== null && first.w.cache.fetchedAt === T0);
      check("b 现场定位顺手存下来了（给下次现场定位不成时退回）", first.w.location !== null && first.w.location.at === T0);
      check("b 缓存存了再读得回来", parseCache(first.w.cache) !== null);
    }
    // c. 5 分钟后：还新，不联网不反查
    {
      first.w.now = T0 + minutes(5);
      const loaded = ok(await loadWeather(first.deps, auto));
      check("c 5 分钟后：缓存还新，不联网、不反查", first.w.calls.fetch === 1 && first.w.calls.name === 1);
      check("c 显示的是缓存里那次取到的时刻", loaded.fetchedAt === T0 && loaded.place === "北京");
    }
    // d. 16 分钟后：重查天气，但地名不用重查
    {
      first.w.now = T0 + minutes(16);
      const loaded = ok(await loadWeather(first.deps, auto));
      check("d 16 分钟后：重新联网，地名沿用（没挪远）", first.w.calls.fetch === 2 && first.w.calls.name === 1 && loaded.fetchedAt === T0 + minutes(16));
    }
    // e. 挪了 3 公里（数据还新）→ 不重查；挪了 6 公里 → 重查天气和地名
    {
      first.w.live = north(0.027);
      first.w.now = T0 + minutes(18);
      await loadWeather(first.deps, auto);
      check("e 挪 3 公里、数据还新：不重查", first.w.calls.fetch === 2);
      first.w.live = north(0.054);
      first.w.name = "通州";
      first.w.now = T0 + minutes(19);
      const loaded = ok(await loadWeather(first.deps, auto));
      check("e 挪 6 公里：天气和地名都重查，换成新地名", first.w.calls.fetch === 3 && first.w.calls.name === 2 && loaded.place === "通州");
      check("e 联网用的是新位置", first.w.lastFetchAt !== null && first.w.lastFetchAt.latitude === north(0.054).latitude);
    }
    // f. 联网失败：留着旧缓存和旧地名，提示刷新没成功
    {
      const { w, deps } = world();
      await loadWeather(deps, auto);
      w.now = T0 + minutes(30);
      w.fetchMode = "fail";
      const loaded = ok(await loadWeather(deps, auto));
      check("f 联网失败：显示旧数据 + 刷新没成功", loaded.refreshFailed && loaded.fetchedAt === T0 && loaded.place === "北京");
      check("f 失败时缓存原样不动", w.cache !== null && w.cache.fetchedAt === T0);
      w.fetchMode = "throw";
      check("f 联网抛错同样处理", ok(await loadWeather(deps, auto)).refreshFailed);
      const cold = world({ fetchMode: "fail" });
      const none = await loadWeather(cold.deps, auto);
      check("f 没缓存又联网失败：没有数据", none.kind === "noData");
    }
    // g. 现场定位不成：退回上次存下的定位，来源是 stored
    {
      const { w, deps } = world({ live: null, location: { coord: beijing, at: T0 - minutes(90) } });
      const loaded = ok(await loadWeather(deps, auto));
      check("g 定位不成：用上次存下的位置，来源 stored", loaded.source === "stored" && w.calls.fetch === 1);
      const thrown = world({ live: "throw", location: { coord: beijing, at: T0 } });
      check("g 定位抛错同样退回", ok(await loadWeather(thrown.deps, auto)).source === "stored");
      check("g 退回上次定位时，底部写「上次定位处的天气」", present(loaded, T0, "compact").kind === "weather" && (present(loaded, T0, "compact") as { note: string | null }).note === "上次定位处的天气");
    }
    // h. 挪远后反查失败：不能让旧城市名配着新位置的天气
    {
      const { w, deps } = world();
      await loadWeather(deps, auto);
      w.now = T0 + minutes(20);
      w.live = north(0.1);
      w.name = null;
      const loaded = ok(await loadWeather(deps, auto));
      check("h 挪远后反查不到：地名退回空（显示「当前位置」），不沿用旧地名", loaded.place === null && w.cache !== null && w.cache.place === null && w.cache.placeAnchor === null);
      w.name = "throw";
      w.now = T0 + minutes(40);
      w.live = north(0.2);
      check("h 反查抛错同样不崩", ok(await loadWeather(deps, auto)).place === null);
    }
    // i. 缓存还新但上次没反查到地名：趁这次补上
    {
      const { w, deps } = world({ name: null });
      const firstLoad = ok(await loadWeather(deps, auto));
      check("i 第一次没反查到地名", firstLoad.place === null && w.calls.name === 1);
      w.name = "北京";
      w.now = T0 + minutes(3);
      const second = ok(await loadWeather(deps, auto));
      check("i 缓存还新：不联网天气，只补反查地名并写回", w.calls.fetch === 1 && w.calls.name === 2 && second.place === "北京" && w.cache?.place === "北京");
    }
    // j. 固定城市：不定位、不反查
    {
      const fixed: Settings = { ...defaultSettings(), mode: "fixed", fixed: { name: "北京", latitude: 39.9042, longitude: 116.4074 } };
      const { w, deps } = world();
      const loaded = ok(await loadWeather(deps, { ...auto, settings: fixed }));
      check("j 固定城市：不现场定位、不反查，用设置里的名字", w.calls.live === 0 && w.calls.name === 0 && loaded.place === "北京" && loaded.source === "fixed");
      check("j 联网用的是固定城市的坐标", w.lastFetchAt !== null && Math.abs(w.lastFetchAt.latitude - 39.9042) < 1e-9);
      check("j 固定城市不画定位箭头", present(loaded, T0, "compact").kind === "weather" && (present(loaded, T0, "compact") as { followsLocation: boolean }).followsLocation === false);
    }
    // k. 小组件参数 > 固定城市；没带名字就要反查
    {
      const fixed: Settings = { ...defaultSettings(), mode: "fixed", fixed: { name: "北京", latitude: 39.9042, longitude: 116.4074 } };
      const named = world();
      const a = ok(await loadWeather(named.deps, { settings: fixed, parameter: { latitude: 31.23, longitude: 121.47, name: "上海" }, force: false }));
      check("k 参数优先于固定城市，带名字就不反查", a.place === "上海" && a.source === "param" && named.w.calls.name === 0 && named.w.calls.live === 0);
      const unnamed = world({ name: "浦东" });
      const b = ok(await loadWeather(unnamed.deps, { settings: fixed, parameter: { latitude: 31.23, longitude: 121.47, name: null }, force: false }));
      check("k 参数没带名字：反查一个", b.place === "浦东" && unnamed.w.calls.name === 1);
    }
    // l. 强制刷新
    {
      const { w, deps } = world();
      await loadWeather(deps, auto);
      w.now = T0 + minutes(1);
      await loadWeather(deps, { ...auto, force: true });
      check("l 强制刷新：缓存再新也重查天气（地名不重查）", w.calls.fetch === 2 && w.calls.name === 1);
    }
    // m. 时钟被往回拨
    {
      const { w, deps } = world();
      await loadWeather(deps, auto);
      w.now = T0 - minutes(60);
      await loadWeather(deps, auto);
      check("m 取到的时刻在未来：当过期，重查", w.calls.fetch === 2);
    }
    // n. 缓存里的数据拼不出结果（接口给了一份最高最低都是空的）
    {
      const broken = clone(base);
      broken.daily.temperature_2m_max = [];
      const loaded: Loaded = { kind: "ok", forecast: broken, extras: null, alerts: null, provider: "openmeteo", fetchedAt: T0, place: "北京", source: "live", refreshFailed: false, failure: null };
      const content = present(loaded, T0, "compact");
      check("n 缓存里的数据拼不出结果：说「天气暂时取不到」，不留空白", content === NO_DATA);
    }
    // o. 换了来源：别的来源写的缓存不认
    {
      const { w, deps } = world();
      await loadWeather(deps, auto);
      w.provider = "caiyun";
      w.now = T0 + minutes(1);
      const loaded = ok(await loadWeather(deps, auto));
      check("o 换了来源：别的来源写的缓存不认，重新联网", w.calls.fetch === 2 && loaded.provider === "caiyun" && loaded.extras !== null);
      check("o 地名和来源无关，照用（不重新反查）", w.calls.name === 1 && loaded.place === "北京");
      check("o 缓存里记着新来源，详细数据和预警一起存了", w.cache !== null && w.cache.provider === "caiyun" && w.cache.extras !== null && w.cache.alerts !== null);
      w.now = T0 + minutes(2);
      const again = ok(await loadWeather(deps, auto));
      check("o 同一个来源的缓存还新就用，不联网；详细数据也跟着缓存出来", w.calls.fetch === 2 && again.extras !== null && again.alerts !== null && again.provider === "caiyun");
      w.provider = "openmeteo";
      w.now = T0 + minutes(3);
      const back = ok(await loadWeather(deps, auto));
      check("o 换回 Open-Meteo：彩云写的缓存也不认，详细数据和预警没有", w.calls.fetch === 3 && back.provider === "openmeteo" && back.extras === null && back.alerts === null);
    }
    // p. 联网失败要带着原因；彩云的缓存退回时详细数据和预警也一起留着
    {
      const { w, deps } = world({ provider: "caiyun" });
      await loadWeather(deps, auto);
      w.now = T0 + minutes(30);
      w.fetchMode = "fail";
      const loaded = ok(await loadWeather(deps, auto));
      check("p 联网失败：原因带出来（接口出错了）", loaded.refreshFailed && loaded.failure !== null && loaded.failure.reason === "server");
      check("p 退回缓存时详细数据和预警也一起留着", loaded.extras !== null && loaded.alerts !== null && loaded.provider === "caiyun" && loaded.fetchedAt === T0);
      w.fetchMode = "throw";
      check("p 抛的不是 FetchError（普通的 Error）：当联网失败", ok(await loadWeather(deps, auto)).failure?.reason === "network");
      const cold = world({ fetchMode: "fail", provider: "caiyun" });
      const none = await loadWeather(cold.deps, auto);
      check("p 没缓存又联网失败：没有数据，也带着原因", none.kind === "noData" && none.failure !== null && none.failure.reason === "server");
      w.fetchMode = "ok";
      const recovered = ok(await loadWeather(deps, auto));
      check("p 再联网成功：失败记录清空", !recovered.refreshFailed && recovered.failure === null);
    }
    // q. 累计今天的最高最低要用到上一次的预报
    {
      const { w, deps } = world({ provider: "caiyun" });
      await loadWeather(deps, auto);
      check("q 第一次没有上一次的预报", w.lastPrevious === null);
      w.now = T0 + minutes(16);
      await loadWeather(deps, auto);
      check("q 第二次把缓存里的预报交给联网那一步", w.lastPrevious !== null && JSON.stringify(w.lastPrevious) === JSON.stringify(base));
      w.provider = "openmeteo";
      w.now = T0 + minutes(40);
      await loadWeather(deps, auto);
      check("q 换了来源之后，缓存是别的来源的，不交过去（交 null）", w.lastPrevious === null);
    }
    // r. 上一次的预报要是同一个地方的才拿去累计（坐车从一座城市到另一座，别把前一座的最高气温算进新城市）
    {
      const { w, deps } = world({ provider: "caiyun" });
      await loadWeather(deps, auto);
      w.now = T0 + minutes(16);
      w.live = north(0.027);
      await loadWeather(deps, auto);
      check("r 挪了 3 公里、数据过期要重查：还在同一个地方，上一次的预报交过去", w.lastPrevious !== null);
      w.now = T0 + minutes(40);
      w.live = north(0.1);
      await loadWeather(deps, auto);
      check("r 挪出 5 公里再重查：上一次的预报是另一个地方的，不交过去（交 null）", w.lastPrevious === null);
      w.now = T0 + minutes(60);
      w.live = north(0.1);
      await loadWeather(deps, { ...auto, force: true });
      check("r 在新地方强制刷新：上一次的预报就是新地方的，又交过去", w.lastPrevious !== null);
    }
    // s. 地名写到哪一级（城市 / 区县）
    {
      const byDistrict: Input = { ...auto, settings: { ...defaultSettings(), placeLevel: "district" } };
      const hai = (overrides: Partial<World> = {}) => world({ name: "北京市", district: "海淀区", ...overrides });
      // 写到区县：标题写区县，缓存里城市和区县各记各的
      {
        const { w, deps } = hai();
        const loaded = ok(await loadWeather(deps, byDistrict));
        check("s 写到区县：标题写区县；缓存里城市和区县各记各的", loaded.place === "海淀区" && w.calls.name === 1 && w.cache !== null && w.cache.place === "北京市" && w.cache.district === "海淀区");
        w.now = T0 + minutes(1);
        const back = ok(await loadWeather(deps, auto));
        check("s 换回城市：缓存里本来就有，不联网、不再反查，标题改写城市", back.place === "北京市" && w.calls.fetch === 1 && w.calls.name === 1);
        const again = ok(await loadWeather(deps, byDistrict));
        check("s 再换成区县：同样不联网、不反查", again.place === "海淀区" && w.calls.fetch === 1 && w.calls.name === 1);
      }
      // 系统没给区县：退回城市，而且记下「反查过、没有」，不会每次都再查
      {
        const { w, deps } = hai({ district: null });
        const loaded = ok(await loadWeather(deps, byDistrict));
        check("s 写到区县、系统没给区县：标题退回城市；缓存里区县是 null（反查过、没有）", loaded.place === "北京市" && w.cache !== null && w.cache.district === null);
        w.now = T0 + minutes(1);
        const again = ok(await loadWeather(deps, byDistrict));
        check("s 反查过没有区县的：缓存还新时不再反查", again.place === "北京市" && w.calls.name === 1);
      }
      // 老版本写的缓存没有区县这一项：改成写到区县时补查一次
      {
        const { w, deps } = hai();
        await loadWeather(deps, auto);
        if (w.cache !== null) delete w.cache.district;
        w.now = T0 + minutes(1);
        const loaded = ok(await loadWeather(deps, byDistrict));
        check("s 缓存没有区县这一项（旧版本写的）、改成写到区县：补查一次地名，不联网天气", loaded.place === "海淀区" && w.calls.name === 2 && w.calls.fetch === 1 && w.cache !== null && w.cache.district === "海淀区");
        if (w.cache !== null) delete w.cache.district;
        w.now = T0 + minutes(30);
        const refetch = ok(await loadWeather(deps, byDistrict));
        check("s 缓存过期要重查、又没有区县这一项：天气和地名一起重查", refetch.place === "海淀区" && w.calls.name === 3 && w.calls.fetch === 2);
      }
      // 挪出 3 公里：写到区县要重新反查（区县的边界近），写到城市不用
      {
        const inDistrict = hai();
        await loadWeather(inDistrict.deps, byDistrict);
        inDistrict.w.now = T0 + minutes(16);
        inDistrict.w.live = north(0.027);
        inDistrict.w.district = "西城区";
        const moved = ok(await loadWeather(inDistrict.deps, byDistrict));
        check("s 写到区县：挪出 3 公里（天气过期了要重查）就重新反查，换成新区县", inDistrict.w.calls.name === 2 && moved.place === "西城区" && inDistrict.w.cache?.district === "西城区");
        check("s 重查路径上反查也是对着现在的位置查的", inDistrict.w.lastNameAt !== null && Math.abs(inDistrict.w.lastNameAt.latitude - north(0.027).latitude) < 1e-9);
        const inCity = hai();
        await loadWeather(inCity.deps, auto);
        inCity.w.now = T0 + minutes(16);
        inCity.w.live = north(0.027);
        inCity.w.district = "西城区";
        const stays = ok(await loadWeather(inCity.deps, auto));
        check("s 写到城市：同样挪 3 公里不重新反查（城市的界线是 5 公里）", inCity.w.calls.name === 1 && stays.place === "北京市");
        const near = hai();
        await loadWeather(near.deps, byDistrict);
        near.w.now = T0 + minutes(16);
        near.w.live = north(0.009);
        await loadWeather(near.deps, byDistrict);
        check("s 写到区县：只挪了 1 公里不重新反查", near.w.calls.name === 1);
        near.w.now = T0 + minutes(17);
        const next = ok(await loadWeather(near.deps, byDistrict));
        check("s 重查了天气、地名沿用的那一次，缓存里的区县也沿用：下一次不用补查", next.place === "海淀区" && near.w.calls.name === 1 && near.w.cache?.district === "海淀区");
      }
      // 固定城市：名字是设置里存的，不反查；区县跟着设置走
      {
        const fixedInput = (placeLevel: PlaceLevel, withDistrict: boolean): Input => ({
          ...auto,
          settings: { mode: "fixed", fixed: withDistrict ? { name: "北京市", district: "海淀区", latitude: 39.99, longitude: 116.31 } : { name: "北京市", latitude: 39.9, longitude: 116.4 }, placeLevel },
        });
        const city = hai();
        const district = hai();
        const none = hai();
        const a = ok(await loadWeather(city.deps, fixedInput("city", true)));
        const b = ok(await loadWeather(district.deps, fixedInput("district", true)));
        const c2 = ok(await loadWeather(none.deps, fixedInput("district", false)));
        check("s 固定城市带着区县：写到城市写城市，写到区县写区县；都不反查", a.place === "北京市" && b.place === "海淀区" && city.w.calls.name === 0 && district.w.calls.name === 0);
        check("s 固定城市没有区县名：写到区县也只能写城市", c2.place === "北京市" && none.w.calls.name === 0);
        district.w.now = T0 + minutes(1);
        const bAgain = ok(await loadWeather(district.deps, fixedInput("district", true)));
        city.w.now = T0 + minutes(1);
        const aAgain = ok(await loadWeather(city.deps, fixedInput("city", true)));
        check("s 固定城市缓存还新时（不联网）：标题也按选的那一级", bAgain.place === "海淀区" && aAgain.place === "北京市" && district.w.calls.fetch === 1 && city.w.calls.fetch === 1);
        const cold = hai({ fetchMode: "fail" });
        const noData = await loadWeather(cold.deps, fixedInput("district", true));
        check("s 固定城市联网失败又没有缓存：「天气暂时取不到」带的地名也按选的那一级", noData.kind === "noData" && noData.place === "海淀区");
        check("s 固定城市自带名字：缓存里记着城市级的名字和它带的区县（和反查来的存法一样）；没有区县的就不记这一项", district.w.cache !== null && district.w.cache.place === "北京市" && district.w.cache.district === "海淀区" && none.w.cache !== null && none.w.cache.place === "北京市" && !("district" in none.w.cache));
        // 固定城市写到区县之后换成跟着定位：就在固定城市旁边，写到城市时标题是城市，不能一直是区县
        {
          const sw = hai();
          await loadWeather(sw.deps, fixedInput("district", true));
          sw.w.live = { latitude: 39.99, longitude: 116.31 };
          sw.w.now = T0 + minutes(20);
          const cityAgain = ok(await loadWeather(sw.deps, auto));
          check("s 固定城市（写到区县）换成跟着定位、写到城市：标题是城市不是区县，不用反查", cityAgain.place === "北京市" && sw.w.calls.name === 0);
          sw.w.now = T0 + minutes(40);
          const districtAgain = ok(await loadWeather(sw.deps, byDistrict));
          check("s 同一个地方写到区县：固定城市带着的区县名就当查过了，不再反查", districtAgain.place === "海淀区" && sw.w.calls.name === 0);
          const bare = hai();
          await loadWeather(bare.deps, fixedInput("district", false));
          bare.w.live = { latitude: 39.9, longitude: 116.4 };
          bare.w.now = T0 + minutes(20);
          const looked = ok(await loadWeather(bare.deps, byDistrict));
          check("s 固定城市没带区县名、换成跟着定位写到区县：缓存里没有区县这一项，补查一次", looked.place === "海淀区" && bare.w.calls.name === 1);
        }
      }
      // 小组件参数自带名字：不受影响
      {
        const { w, deps } = hai();
        const loaded = ok(await loadWeather(deps, { settings: { ...defaultSettings(), placeLevel: "district" }, parameter: { latitude: 31.23, longitude: 121.47, name: "上海" }, force: false }));
        check("s 小组件参数自带名字：不管写到哪一级都照写", loaded.place === "上海" && w.calls.name === 0);
      }
      // 联网失败：退回缓存时，标题也按选的那一级
      {
        const { w, deps } = hai();
        await loadWeather(deps, byDistrict);
        w.now = T0 + minutes(30);
        w.fetchMode = "fail";
        const district = ok(await loadWeather(deps, byDistrict));
        const city = ok(await loadWeather(deps, auto));
        check("s 联网失败退回缓存：标题按选的那一级（区县 / 城市）", district.refreshFailed && district.place === "海淀区" && city.refreshFailed && city.place === "北京市");
      }
      // 第一次没反查到，缓存还新时补上：城市和区县一起补
      {
        const { w, deps } = hai({ name: null });
        const first = ok(await loadWeather(deps, byDistrict));
        w.name = "北京市";
        w.now = T0 + minutes(3);
        const second = ok(await loadWeather(deps, byDistrict));
        check("s 第一次没反查到、缓存还新：补查时城市和区县一起补上并写回，不联网天气", first.place === null && second.place === "海淀区" && w.cache?.place === "北京市" && w.cache?.district === "海淀区" && w.calls.fetch === 1);
      }
      // 只有区县、没有城市（系统很少这么给）：写到城市也不留空
      {
        const { deps } = hai();
        const onlyDistrict: Deps = { ...deps, reverseName: async () => ({ city: null, district: "海淀区" }) };
        const loaded = ok(await loadWeather(onlyDistrict, auto));
        check("s 系统只给了区县、没给城市：写到城市也不留空，用区县顶上", loaded.place === "海淀区");
      }

      // 缓存还新（快路径）：人挪出 2 公里，写到区县就补查（对着现在的位置查）；写到城市还是 5 公里
      {
        const inDistrict = hai();
        await loadWeather(inDistrict.deps, byDistrict);
        inDistrict.w.now = T0 + minutes(5);
        inDistrict.w.live = north(0.027);
        inDistrict.w.district = "西城区";
        const moved = ok(await loadWeather(inDistrict.deps, byDistrict));
        check("s 缓存还新、写到区县：人挪出 3 公里，补查一次（不联网天气），标题换成新区县", moved.place === "西城区" && inDistrict.w.calls.name === 2 && inDistrict.w.calls.fetch === 1);
        check("s 补查对着现在的位置查（不是缓存里老的那个位置）", inDistrict.w.lastNameAt !== null && Math.abs(inDistrict.w.lastNameAt.latitude - north(0.027).latitude) < 1e-9);
        check("s 补查对着现在的位置：缓存里地名的锚点跟着挪过来", (() => {
          const anchor = inDistrict.w.cache?.placeAnchor;
          return anchor !== null && anchor !== undefined && Math.abs(anchor.latitude - north(0.027).latitude) < 1e-9;
        })());
        inDistrict.w.now = T0 + minutes(6);
        await loadWeather(inDistrict.deps, byDistrict);
        check("s 再来一次就不用补查了", inDistrict.w.calls.name === 2);
        const inCity = hai();
        await loadWeather(inCity.deps, auto);
        inCity.w.now = T0 + minutes(5);
        inCity.w.live = north(0.027);
        const stays = ok(await loadWeather(inCity.deps, auto));
        check("s 缓存还新、写到城市：挪 3 公里不补查", stays.place === "北京市" && inCity.w.calls.name === 1);
      }
      // 固定城市换成跟着定位：两处相距 3 公里，写到区县时标题不能直接用固定城市带的区县
      {
        const { w, deps } = hai({ district: "朝阳区" });
        const fixedHere: Input = { ...auto, settings: { mode: "fixed", fixed: { name: "北京市", district: "海淀区", latitude: 39.9, longitude: 116.4 }, placeLevel: "city" } };
        await loadWeather(deps, fixedHere);
        w.live = north(0.027);
        w.now = T0 + minutes(5);
        const loaded = ok(await loadWeather(deps, byDistrict));
        check("s 固定城市（带区县）换成跟着定位、写到区县，两处相距 3 公里：对着现在的位置查，不用固定城市的区县", loaded.place === "朝阳区" && w.calls.name === 1);
      }
      // 反查没成功：城市名还适用就留着
      {
        const { w, deps } = hai();
        await loadWeather(deps, auto);
        if (w.cache !== null) delete w.cache.district;
        w.now = T0 + minutes(20);
        w.name = null;
        const kept = ok(await loadWeather(deps, byDistrict));
        check("s 写到区县、缓存缺区县这一项、重查路径上反查没成功：城市名还适用，留着（不退成「当前位置」）；区县记「没查过」", kept.place === "北京市" && w.cache !== null && w.cache.place === "北京市" && w.cache.placeAnchor !== null && !("district" in w.cache));
        w.name = "北京市";
        w.now = T0 + minutes(21);
        const again = ok(await loadWeather(deps, byDistrict));
        check("s 下一次反查成功：补上区县", again.place === "海淀区" && w.cache?.district === "海淀区");
        const far = hai();
        await loadWeather(far.deps, byDistrict);
        far.w.now = T0 + minutes(20);
        far.w.live = north(0.027);
        far.w.name = null;
        const stillCity = ok(await loadWeather(far.deps, byDistrict));
        check("s 写到区县、挪出 3 公里、反查没成功：城市名还适用（5 公里内），留着", stillCity.place === "北京市" && far.w.cache?.place === "北京市" && far.w.cache?.placeAnchor !== null);
        const gone = hai();
        await loadWeather(gone.deps, byDistrict);
        gone.w.now = T0 + minutes(20);
        gone.w.live = north(0.1);
        gone.w.name = null;
        const lost = ok(await loadWeather(gone.deps, byDistrict));
        check("s 写到区县、挪出 11 公里、反查没成功：城市名也不适用了，退回「当前位置」", lost.place === null && gone.w.cache?.place === null && gone.w.cache?.placeAnchor === null);
      }
    }
    // 排程
    {
      const healthy: Loaded = { kind: "ok", forecast: base, extras: null, alerts: null, provider: "openmeteo", fetchedAt: T0, place: null, source: "live", refreshFailed: false, failure: null };
      check("排程：取成功隔 20 分钟再来", nextReloadAt(healthy, T0) === T0 + RELOAD_AFTER_MS);
      check("排程：刷新没成功 / 没数据 / 没位置，早一点再来", nextReloadAt({ ...healthy, refreshFailed: true }, T0) === T0 + RELOAD_RETRY_MS && nextReloadAt({ kind: "noData", source: "live", place: null, failure: null }, T0) === T0 + RELOAD_RETRY_MS && nextReloadAt({ kind: "noLocation" }, T0) === T0 + RELOAD_RETRY_MS);
      check("排程：重试比正常间隔短", RELOAD_RETRY_MS < RELOAD_AFTER_MS);
    }
  }

  // ---------------------------------------------------------------- 超时包装
  section("超时包装（定位 / 反查最多等多久）");
  {
    const later = <T,>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    check("来得及：拿到值", (await withTimeout(() => later("ok", 5), 500)) === "ok");
    check("来不及：当没有（null）", (await withTimeout(() => later("ok", 300), 20)) === null);
    check("出错：照样往外抛，由 load.ts 兜底", await withTimeout(() => Promise.reject(new Error("没权限")), 500).then(() => false, (error: Error) => error.message === "没权限"));
    check("发起时就抛（同步出错）：也往外抛", await withTimeout(() => { throw new Error("同步炸"); }, 500).then(() => false, (error: Error) => error.message === "同步炸"));
    check("超时之后才出的错不会冒成未处理的拒绝", (await withTimeout(() => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("太晚了")), 60)), 10)) === null);
    await later(null, 100);
    const globals = globalThis as unknown as { setTimeout?: unknown };
    const timer = globals.setTimeout;
    let started = false;
    globals.setTimeout = undefined;
    const noTimer = await withTimeout(() => { started = true; return Promise.resolve("x"); }, 10);
    globals.setTimeout = timer;
    check("没有 setTimeout 的环境：不问了，当没有，连请求都不发（宁可少一次定位也别把小组件卡成空白）", noTimer === null && !started);
    globals.setTimeout = undefined;
    const ran = await withTimeout(() => Promise.resolve("联网照常发起"), 10, "run");
    const ranThrow = await withTimeout(() => { throw new Error("同步炸"); }, 10, "run").then(() => false, (error: Error) => error.message === "同步炸");
    globals.setTimeout = timer;
    check("没有 setTimeout、但选了 run（联网用）：照常发起、老实等；同步出错照样往外抛", ran === "联网照常发起" && ranThrow);

    // 联网：用假的 fetch 把状态码、解析、超时兜底都跑一遍
    const realFetch = (globalThis as unknown as { fetch: unknown }).fetch;
    const fake = (impl: (url: string, init?: { timeout?: number }) => Promise<unknown>) => {
      (globalThis as unknown as { fetch: unknown }).fetch = impl;
    };
    let seen: { url: string; timeout: number | undefined } | null = null;
    fake(async (url, init) => {
      seen = { url, timeout: init?.timeout };
      return { status: 200, json: async () => clone(FIXTURE) };
    });
    const ok = await fetchForecast(39.9, 116.4, 6);
    const seenNow = seen as { url: string; timeout: number | undefined } | null;
    check("联网：200 解开了，带着查询地址和超时（秒）", ok.utc_offset_seconds === 28800 && seenNow !== null && seenNow.url === buildURL(39.9, 116.4) && seenNow.timeout === 6);
    fake(async () => ({ status: 500, json: async () => ({}) }));
    check("联网：非 200 抛 ForecastError", await fetchForecast(1, 2).then(() => false, (error: unknown) => error instanceof ForecastError));
    fake(async () => ({ status: 200, json: async () => ({ hello: 1 }) }));
    check("联网：200 但解不开也抛 ForecastError", await fetchForecast(1, 2).then(() => false, (error: unknown) => error instanceof ForecastError));
    fake(() => new Promise(() => undefined));
    const began = Date.now();
    const OPEN_METEO = { mode: "openmeteo" as const, host: "", token: "" };
    const near = { latitude: 1, longitude: 2 };
    const timedOut = await fetchWeatherWithin(OPEN_METEO, near, null, 0.02, 0, 30).then(() => "没抛", (error: Error) => error.message);
    check("联网：原生超时万一没掐断，外面这层兜得住（按「联网失败」抛，没有一直挂着）", timedOut.startsWith("联网失败") && Date.now() - began < 1000);
    fake(async () => {
      await later(null, 40);
      return { status: 200, json: async () => clone(FIXTURE) };
    });
    const slow = await fetchWeatherWithin(OPEN_METEO, near, null, 0.02, 0, 200).then((fetched) => fetched.forecast.utc_offset_seconds, () => -1);
    check("联网：在「自带超时 + 宽限」之内回来的，外面这层不误杀", slow === 28800);
    const plain = await fetchWeatherWithin(OPEN_METEO, near, null, 6, 0).catch(() => null);
    check("联网：Open-Meteo 来源只有预报，没有详细数据和预警", plain !== null && plain.extras === null && plain.alerts === null);
    fake(async () => { throw new Error("没网"); });
    check("联网：fetch 自己抛错也往外抛", await fetchWeatherWithin(OPEN_METEO, near, null, 6, 0).then(() => false, (error: Error) => error.message === "没网"));
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  }

  // ---------------------------------------------------------------- 反查地名（系统那一层）
  section("反查地名：城市和区县两级");
  {
    const globals = globalThis as unknown as { Location?: unknown };
    const original = globals.Location;
    const fakeLocation = (reverse: unknown, geocode: unknown = async () => null) => {
      globals.Location = { reverseGeocode: reverse, geocodeAddress: geocode };
    };
    const beijing: Coord = { latitude: 39.9, longitude: 116.4 };
    let seen: unknown = null;
    fakeLocation(async (options: unknown) => {
      seen = options;
      return [{ locality: "北京市", subLocality: "海淀区", administrativeArea: "北京市" }];
    });
    check("反查：城市和区县两级都带回来", JSON.stringify(await reverseName(beijing, 500)) === JSON.stringify({ city: "北京市", district: "海淀区" }));
    check("反查：请求里带着坐标和中文区域（地名才是中文）", JSON.stringify(seen) === JSON.stringify({ latitude: 39.9, longitude: 116.4, locale: "zh-CN" }));
    fakeLocation(async () => [{ locality: "北京市" }]);
    check("反查：系统没给区县，区县是 null", JSON.stringify(await reverseName(beijing, 500)) === JSON.stringify({ city: "北京市", district: null }));
    fakeLocation(async () => [{ subLocality: "海淀区" }]);
    check("反查：只有区县也带回来", JSON.stringify(await reverseName(beijing, 500)) === JSON.stringify({ city: null, district: "海淀区" }));
    fakeLocation(async () => [{}]);
    check("反查：一个名字都没有是 null", (await reverseName(beijing, 500)) === null);
    fakeLocation(async () => []);
    check("反查：空结果是 null", (await reverseName(beijing, 500)) === null);
    fakeLocation(async () => null);
    check("反查：系统回 null 就是 null", (await reverseName(beijing, 500)) === null);
    fakeLocation(() => new Promise(() => undefined));
    check("反查：等不到就当没有", (await reverseName(beijing, 30)) === null);
    fakeLocation(async () => {
      throw new Error("没网");
    });
    check("反查：出错照样往外抛，由 load.ts 兜底", await reverseName(beijing, 500).then(() => false, (error: Error) => error.message === "没网"));

    fakeLocation(async () => null, async () => [{ locality: "北京市", subLocality: "海淀区", location: { latitude: 39.99, longitude: 116.31 } }]);
    const found = await findPlace("海淀区");
    check("找地点：名字是城市、区县一起带上", found !== null && found.name === "北京市" && found.district === "海淀区" && found.latitude === 39.99);
    fakeLocation(async () => null, async () => null);
    check("找地点：找不到是 null；空白不用问系统", (await findPlace("不存在")) === null && (await findPlace("   ")) === null);
    if (original === undefined) delete globals.Location;
    else globals.Location = original;
  }

  // ---------------------------------------------------------------- 存储里读出来的东西
  section("存储：读出来的东西不信任");
  {
    const beijing: Coord = { latitude: 39.9, longitude: 116.4 };
    const good: Cache = { version: 1, fetchedAt: 1, anchor: beijing, provider: "openmeteo", forecast: base, extras: null, alerts: null, place: "北京", placeAnchor: beijing };
    check("好缓存读得回来", parseCache(clone(good)) !== null);
    check("各种垃圾都当没有", [null, undefined, 3, "x", [], {}, { version: 2 }, { ...good, version: 2 }, { ...good, fetchedAt: "1" }, { ...good, fetchedAt: Number.NaN }, { ...good, anchor: { latitude: 99, longitude: 0 } }, { ...good, forecast: {} }].every((value) => parseCache(value) === null));
    const noAnchor = parseCache({ ...clone(good), placeAnchor: null });
    check("有地名却没有「在哪反查的」：地名作废，缓存本身还能用", noAnchor !== null && noAnchor.place === null && noAnchor.placeAnchor === null);
    check("地名为空串当没有", parseCache({ ...clone(good), place: "" })?.place === null);
    check("区县名：字符串、null（反查过没有）读得回来；没这一项（旧版本写的）、被改坏的当「没查过」", (() => {
      const read = (district: unknown) => parseCache({ ...clone(good), district });
      const old = parseCache(clone(good));
      return read("海淀区")?.district === "海淀区" && read(" 海淀区 ")?.district === "海淀区" && read(null)?.district === null && old !== null && old.district === undefined && !("district" in old) && read(5)?.district === undefined && read("  ")?.district === undefined;
    })());
    check("没有「在哪反查的」时区县名跟着地名一起作废；带区县的缓存整体读得回来", (() => {
      const voided = parseCache({ ...clone(good), placeAnchor: null, district: "海淀区" });
      const { place, placeAnchor, ...rest } = good;
      const withDistrict = clone({ ...rest, place, district: "海淀区", placeAnchor });
      return voided !== null && voided.place === null && voided.district === undefined && JSON.stringify(parseCache(clone(withDistrict))) === JSON.stringify(withDistrict);
    })());
    const rich = clone({ ...good, provider: "caiyun", extras: { apparent: 6, humidity: 28, wind: null, pressure: null, visibility: null, cloud: 40, dewpoint: -2, aqi: null, pollutants: { pm25: 35, pm10: null, o3: null, no2: null, so2: null, co: 0.8 }, uv: null, keypoint: "今日多云", dayOutlook: "未来24小时多云", rainOutlook: "未来2小时无降水", rainNote: null, life: null, days: [] }, alerts: { items: [], failure: null } });
    check("彩云的缓存带着详细数据和预警，读得回来", JSON.stringify(parseCache(clone(rich))) === JSON.stringify(rich));
    check("1.1.0 存下的详细数据（没有云量、露点、污染物、几句话，每天也没有风和湿度）读回来：新增的几项是 null，别的不变", (() => {
      const old = { apparent: 6, humidity: 28, wind: null, pressure: null, visibility: null, aqi: null, uv: null, keypoint: "今日多云", rainNote: null, life: null, days: [{ date: "2026-10-31", high: 19, low: 17, code: 3, rainChance: 20 }] };
      const c = parseCache({ ...clone(rich), extras: old });
      if (c === null || c.extras === null) return false;
      const e = c.extras;
      return e.cloud === null && e.dewpoint === null && e.pollutants === null && e.dayOutlook === null && e.rainOutlook === null && e.apparent === 6 && e.keypoint === "今日多云" &&
        e.days.length === 1 && e.days[0].high === 19 && e.days[0].wind === null && e.days[0].humidity === null && e.days[0].aqi === null && e.days[0].uv === null;
    })());
    const { provider: _unused, ...oldCache } = clone(good);
    check("老版本的缓存没有来源这一项：当是 Open-Meteo 写的，详细数据和预警是空的", (() => { const c = parseCache(oldCache); return c !== null && c.provider === "openmeteo" && c.extras === null && c.alerts === null; })());
    check("来源写了不认识的：整份当没有", parseCache({ ...clone(good), provider: "weird" }) === null);
    check("详细数据读坏了：当没有，缓存本身还能用", (() => { const c = parseCache({ ...clone(rich), extras: "坏的" }); return c !== null && c.extras === null && c.forecast.utc_offset_seconds === 28800; })());
    check("预警读坏了：当没有，缓存本身还能用", (() => { const c = parseCache({ ...clone(rich), alerts: 7 }); return c !== null && c.alerts === null; })());
    check("预警没读到（接口没给）：失败记录读得回来，原因认不得的丢掉", (() => {
      const missing = parseCache({ ...clone(rich), alerts: { items: null, failure: { at: 5, reason: "missing", message: "接口没有返回预警数据" } } });
      const weird = parseCache({ ...clone(rich), alerts: { items: null, failure: { at: 5, reason: "boom", message: "x" } } });
      return missing !== null && missing.alerts !== null && missing.alerts.items === null && missing.alerts.failure?.reason === "missing" && weird !== null && weird.alerts === null;
    })());
    check("上次定位：好的读得回来、坏的是 null", parseStoredLocation({ coord: beijing, at: 5 })?.at === 5 && parseStoredLocation({ coord: beijing }) === null && parseStoredLocation({ coord: { latitude: 1 }, at: 1 }) === null && parseStoredLocation(null) === null);
  }

  // ---------------------------------------------------------------- 设置与参数
  section("设置与小组件参数");
  {
    check("默认跟着当前定位走、地名写到城市", defaultSettings().mode === "current" && defaultSettings().fixed === null && defaultSettings().placeLevel === "city");
    const fixed = { mode: "fixed", fixed: { name: "北京", latitude: 39.9, longitude: 116.4 }, placeLevel: "city" };
    check("固定城市读得回来", JSON.stringify(parseSettings(fixed)) === JSON.stringify(fixed));
    check("垃圾设置回到默认", [null, undefined, 3, "x", []].every((value) => JSON.stringify(parseSettings(value)) === JSON.stringify(defaultSettings())));
    check("说是固定、却没有可用的城市：按跟着定位走", parseSettings({ mode: "fixed" }).mode === "current" && parseSettings({ mode: "fixed", fixed: { name: "", latitude: 1, longitude: 1 } }).mode === "current" && parseSettings({ mode: "fixed", fixed: { name: "x", latitude: 100, longitude: 1 } }).mode === "current");
    check("城市名过长会截断到 24 个字", parseSettings({ mode: "fixed", fixed: { name: "长".repeat(40), latitude: 1, longitude: 1 } }).fixed?.name.length === 24);
    check("设置没选固定时，留着的固定城市不丢", parseSettings({ mode: "current", fixed: fixed.fixed }).fixed?.name === "北京");

    const place = parseParameter("39.9,116.4,北京");
    check("参数：纬度,经度,名称", place !== null && place.latitude === 39.9 && place.longitude === 116.4 && place.name === "北京");
    check("参数：只有纬度,经度也行，没有名称", parseParameter("39.9,116.4")?.name === null);
    check("参数：中文逗号和多余空格也行", parseParameter(" 39.9 ， 116.4 ， 北京市 ")?.name === "北京市");
    check("参数：负坐标", parseParameter("-33.87,151.21,悉尼")?.latitude === -33.87);
    check("参数：名称里再有逗号，原样留着", parseParameter("1,2,a,b")?.name === "a,b");
    check("参数：名称留空当没有名称", parseParameter("1,2,   ")?.name === null && parseParameter("1,2,")?.name === null);
    check("参数：不是这个格式都当没填", ["", "  ", "北京", "39.9", "39.9;116.4", "a,b", "39.9,116.4x", "{\"lat\":1}"].every((text) => parseParameter(text) === null));
    check("参数：越界当没填", parseParameter("91,0") === null && parseParameter("0,181") === null);
    check("参数：undefined / null 当没填", parseParameter(undefined) === null && parseParameter(null) === null);
    check("反查结果挑城市：市 > 地区 > 省 > 国家", cityName({ locality: "杭州市", subAdministrativeArea: "杭州地区", administrativeArea: "浙江省" }) === "杭州市" && cityName({ subAdministrativeArea: "杭州地区", administrativeArea: "浙江省" }) === "杭州地区" && cityName({ administrativeArea: "浙江省", country: "中国" }) === "浙江省" && cityName({ country: "中国" }) === "中国");
    check("反查结果挑城市：空串 / 空白 / 没有都跳过", cityName({ locality: "  ", subAdministrativeArea: "" }) === null && cityName(undefined) === null && cityName(null) === null && cityName({ locality: " 北京市 " }) === "北京市");

    const found = pickPlace([{ locality: "北京市", administrativeArea: "北京市", location: { latitude: 39.9, longitude: 116.4 } }], "北京");
    check("找城市：用结果里的城市名和坐标", found !== null && found.name === "北京市" && found.latitude === 39.9 && found.longitude === 116.4);
    check("找城市：结果里没有城市名就用输入的字", pickPlace([{ location: { latitude: 1, longitude: 2 } }], " 某地 ")?.name === "某地");
    check("找城市：跳过没有坐标 / 坐标越界的结果，取第一个能用的", pickPlace([{ locality: "甲" }, { locality: "乙", location: { latitude: 99, longitude: 0 } }, { locality: "丙", location: { latitude: 3, longitude: 4 } }], "x")?.name === "丙");
    check("找城市：什么都没有是 null", pickPlace([], "x") === null && pickPlace(null, "x") === null && pickPlace(undefined, "x") === null && pickPlace([{ locality: "甲" }], "x") === null);
    check("找城市：名字超过 24 字截断", pickPlace([{ location: { latitude: 1, longitude: 2 } }], "长".repeat(40))?.name.length === 24);
    check("找城市：结果能直接当固定城市存、再读回来", (() => {
      const place = pickPlace([{ locality: "北京市", location: { latitude: 39.9, longitude: 116.4 } }], "北京");
      return place !== null && parseSettings(clone({ mode: "fixed", fixed: place })).mode === "fixed";
    })());

    // ---- 地名写到哪一级
    check("设置：地名写到哪一级，选了区县读得回来，别的值回到城市", parseSettings({ placeLevel: "district" }).placeLevel === "district" && parseSettings({ placeLevel: "city" }).placeLevel === "city" && ["town", "", null, 3, undefined].every((value) => parseSettings({ placeLevel: value }).placeLevel === "city"));
    check("设置：写到区县的选择和带区县的固定城市整体读得回来", (() => {
      const mine = { mode: "fixed", fixed: { name: "北京市", district: "海淀区", latitude: 39.9, longitude: 116.4 }, placeLevel: "district" };
      return JSON.stringify(parseSettings(clone(mine))) === JSON.stringify(mine);
    })());
    check("固定城市的区县名：空白、不是字符串都丢掉，过长截到 24 个字，两头的空白去掉", (() => {
      const withDistrict = (district: unknown) => parseSettings({ mode: "fixed", fixed: { name: "北京市", district, latitude: 1, longitude: 1 } }).fixed;
      return withDistrict("  ")?.district === undefined && withDistrict(5)?.district === undefined && withDistrict(null)?.district === undefined && withDistrict("长".repeat(40))?.district?.length === 24 && withDistrict(" 海淀区 ")?.district === "海淀区";
    })());
    check("区县名：取系统给的 subLocality，空白 / 没有是 null，不拿道路名凑", districtName({ locality: "北京市", subLocality: "海淀区" }) === "海淀区" && districtName({ subLocality: " 海淀区 " }) === "海淀区" && districtName({ subLocality: "  " }) === null && districtName({ locality: "北京市" }) === null && districtName(undefined) === null && districtName(null) === null && districtName({ locality: "北京市", thoroughfare: "中关村大街" } as PlacemarkLike) === null);
    check("反查结果拆成两级：城市和区县各挑各的", JSON.stringify(placeParts({ locality: "北京市", subLocality: "海淀区", administrativeArea: "北京市" })) === JSON.stringify({ city: "北京市", district: "海淀区" }) && JSON.stringify(placeParts({ administrativeArea: "浙江省" })) === JSON.stringify({ city: "浙江省", district: null }) && JSON.stringify(placeParts(undefined)) === JSON.stringify({ city: null, district: null }));
    check("标题里写的名字：写到区县有区县就写区县，没有就退回城市；写到城市写城市（城市也没有才退到区县）", (() => {
      const table: Array<[PlaceLevel, string | null, string | null | undefined, string | null]> = [
        ["city", "北京市", "海淀区", "北京市"],
        ["district", "北京市", "海淀区", "海淀区"],
        ["district", "北京市", null, "北京市"],
        ["district", "北京市", undefined, "北京市"],
        ["district", null, "海淀区", "海淀区"],
        ["city", null, "海淀区", "海淀区"],
        ["city", null, null, null],
        ["district", null, undefined, null],
      ];
      return table.every(([level, city, district, want]) => placeLabel(level, city, district) === want);
    })());
    check("找城市：结果里有区县名就一起带上；区县和城市同名、没有区县就不带；过长截到 24 个字", (() => {
      const loc = { latitude: 39.9, longitude: 116.4 };
      const withDistrict = pickPlace([{ locality: "北京市", subLocality: "海淀区", location: loc }], "海淀区");
      const same = pickPlace([{ locality: "海淀区", subLocality: "海淀区", location: loc }], "x");
      const none = pickPlace([{ locality: "北京市", location: loc }], "北京");
      const tooLong = pickPlace([{ locality: "北京市", subLocality: "长".repeat(40), location: loc }], "x");
      return withDistrict !== null && JSON.stringify(withDistrict) === JSON.stringify({ name: "北京市", district: "海淀区", latitude: 39.9, longitude: 116.4 }) && same !== null && !("district" in same) && none !== null && !("district" in none) && tooLong?.district?.length === 24;
    })());
    check("找城市：带区县的结果能直接存成固定城市、再读回来", (() => {
      const found2 = pickPlace([{ locality: "北京市", subLocality: "海淀区", location: { latitude: 39.9, longitude: 116.4 } }], "海淀区");
      const saved = parseSettings(clone({ mode: "fixed", fixed: found2, placeLevel: "district" }));
      return saved.mode === "fixed" && saved.fixed?.district === "海淀区" && saved.placeLevel === "district";
    })());
  }

  // ---------------------------------------------------------------- 要说的话
  section("界面上的文字");
  {
    const T = Date.UTC(2026, 9, 31, 7, 30);
    const forecast = mustParse(applyPatches(FIXTURE, [[["current", "time"], "2026-10-31T15:30"]]));
    const loaded: Loaded = { kind: "ok", forecast, extras: null, alerts: null, provider: "openmeteo", fetchedAt: T, place: "北京", source: "live", refreshFailed: false, failure: null };
    const content = present(loaded, T, "compact");
    if (content.kind !== "weather") throw new Error("应该是天气卡");
    check("地名、气温、天气", content.place === "北京" && content.temperature === "19°" && content.condition.text === "阴");
    check("最高最低照 RoamControl 的写法", content.range === "最高 19° 最低 17°" && rangeText(5, -3) === "最高 5° 最低 -3°");
    check("降水概率：长句和短句", content.rain === "降水概率：56%" && content.rainShort === "降水 56%");
    check("逐小时五格：标签、图标、下面那行", JSON.stringify(content.slots.map((s) => [s.label, s.text])) === JSON.stringify([["现在", "19°"], ["16时", "19°"], ["17时", "19°"], ["17:55", "日落"], ["18时", "18°"]]));
    check("只有第一格是「现在」", content.slots.map((s) => s.isNow).join() === "true,false,false,false,false");
    check("日落那一格的图标是 sunset.fill", content.slots[3].symbol === "sunset.fill");
    check("每一格的 key 不重复", new Set(content.slots.map((s) => s.key)).size === content.slots.length);
    check("没有提醒时底部不写", content.note === null && content.noteShort === null);
    check("跟着定位走时画定位箭头", content.followsLocation);
    check("锁屏单行：天气 气温 最低~最高", content.inline === "阴 19° 17~19°");
    check("背景用的天空色来自当前天气和昼夜", content.sky === "overcast" && content.isDay);

    const failed = present({ ...loaded, refreshFailed: true }, T, "compact");
    check("刷新没成功：长短两句", failed.kind === "weather" && failed.note === "刚才没刷新成功，显示的是之前的数据" && failed.noteShort === "没刷新成功，显示旧数据");
    const stored = present({ ...loaded, source: "stored", refreshFailed: true }, T, "compact");
    check("两种提醒都有时，先说上次定位处（照 RoamControl 的先后）", stored.kind === "weather" && stored.note === "上次定位处的天气");
    check("没有地名显示「当前位置」", (present({ ...loaded, place: null }, T, "compact") as { place: string }).place === "当前位置");
    check("大号没有详细数据（备用来源）：取 10 格，两排各 5 格", (() => { const card = present(loaded, T, "large"); return card.kind === "weather" && card.slots.length === 10 && card.columns === 5 && card.detail === null; })());
    check("没位置、没数据各有一句人话", NO_LOCATION.lines.length === 2 && NO_DATA.lines.length === 2 && NO_LOCATION.title !== "" && NO_DATA.title !== "");
    check("没位置 / 没数据用 present 画出来", present({ kind: "noLocation" }, T, "compact") === NO_LOCATION && present({ kind: "noData", source: "live", place: null, failure: null }, T, "compact") === NO_DATA);

    const local = (y: number, m: number, d: number, h: number, mi: number) => new Date(y, m - 1, d, h, mi).getTime();
    check("更新时间：今天只写钟点", updatedText(local(2026, 10, 31, 9, 5), local(2026, 10, 31, 20, 0)) === "09:05 更新");
    check("更新时间：昨天要写「昨天」", updatedText(local(2026, 10, 30, 23, 59), local(2026, 10, 31, 0, 1)) === "昨天 23:59 更新");
    check("更新时间：更早带日期", updatedText(local(2026, 10, 28, 7, 0), local(2026, 10, 31, 8, 0)) === "10-28 07:00 更新");
    check("更新时间：跨月的昨天", updatedText(local(2026, 9, 30, 12, 0), local(2026, 10, 1, 8, 0)) === "昨天 12:00 更新");
    check("更新时间：个位数的月、日、钟点都补零", updatedText(local(2026, 3, 5, 7, 4), local(2026, 3, 20, 8, 0)) === "03-05 07:04 更新");
  }

  // ---------------------------------------------------------------- 版式
  section("版式尺寸");
  {
    check("Widget.family 对应的版面", familyOf("systemSmall", 158, 158) === "small" && familyOf("systemMedium", 338, 158) === "medium" && familyOf("systemLarge", 338, 354) === "large" && familyOf("accessoryCircular", 76, 76) === "circular" && familyOf("accessoryRectangular", 172, 76) === "rectangular" && familyOf("accessoryInline", 234, 26) === "inline");
    check("超大没单独设计：横的借中号、竖的借大号", familyOf("systemExtraLarge", 628, 300) === "medium" && familyOf("systemExtraLargePortrait", 300, 628) === "large");
    check("不认识的 family 按宽高猜", familyOf("whatever", 158, 158) === "small");

    for (const [family, width, height] of [["small", 158, 158], ["medium", 338, 158], ["large", 338, 354]] as const) {
      const m = metricsFor(family, width, height);
      check(`${family}：参考尺寸上缩放比是 1`, m.scale === 1);
      check(`${family}：所有数都是有限的正数（左栏宽度除外）`, Object.entries(m).every(([key, value]) => Number.isFinite(value) && (["leftWidth", "stat", "day", "dayIcon", "dayRow", "dayGap", "bar", "top", "headline", "item", "dayHigh", "dayLow", "bigIcon"].includes(key) ? value >= 0 : value > 0)));
    }
    check("内缩 = 16pt 乘缩放比（缩放比最小 0.7，所以最小是 11）；取的是 iPhone 上系统默认的内容边距", CONTENT_MARGIN === 16 && metricsFor("small", 158, 158).inset === 16 && metricsFor("medium", 338, 158).inset === 16 && metricsFor("small", 79, 79).inset === 11 && metricsFor("large", 676, 708).inset === 32);
    check("中号才有左栏", metricsFor("medium", 338, 158).leftWidth > 0 && metricsFor("small", 158, 158).leftWidth === 0 && metricsFor("large", 338, 354).leftWidth === 0);
    const se = metricsFor("small", 148, 148);
    check("小屏上整体按比例缩小", se.scale < 1 && se.temp < metricsFor("small", 158, 158).temp);
    check("大屏上整体按比例放大", metricsFor("small", 170, 170).temp > metricsFor("small", 158, 158).temp);
    check("中号按宽高里更吃紧的那个缩：窄而高的不会放大", metricsFor("medium", 338, 200).scale === 1 && metricsFor("medium", 300, 158).scale < 1);
    check("超大放大有上限（2.4 倍）", metricsFor("medium", 2000, 1000).scale === 2.4);
    check("缩得太小也有下限（0.7 倍）", metricsFor("large", 50, 50).scale === 0.7);
    check("拿到的尺寸不可信（0、负数、NaN）就当参考尺寸", [0, -5, Number.NaN, Infinity].every((bad) => metricsFor("small", bad, bad).scale === 1 || (bad === Infinity && metricsFor("small", bad, bad).scale === 2.4)));
    check("字号不会缩到 8 以下", Object.entries(metricsFor("large", 50, 50)).every(([key, value]) => !["stat", "day", "slotLabel", "range"].includes(key) || value >= 8));
    check("内容区宽度 = 宽 − 两边内缩；只有大号的未来几天用它算温度条", metricsFor("large", 338, 354).contentWidth === 338 - 2 * 16 && metricsFor("medium", 338, 158).contentWidth === 306);
    // 中号：左栏之外的宽度平分给逐小时的 5 格，每格至少要放得下「-12°」（13pt 半粗等宽数字约 30pt）
    check("中号右栏每格宽度 ≥ 32pt：各种常见宽度（小屏 321 到大屏 364）、两套字号都放得下", (["standard", "compact"] as const).every((variant) => [300, 321, 338, 364].every((width) => {
      const medium = metricsFor("medium", width, 158, variant);
      return (medium.contentWidth - medium.leftWidth - medium.gap * 4) / 5 >= 32;
    })));

    // 竖向预算：按参考尺寸把每个版面从上到下的行高加一遍，要放得进「高 − 系统边距 32」里，还要留 8pt 余量。
    // 行高按字号的倍数估：带汉字的行 1.4（苹方的行高比拉丁文高得多），纯数字 / 图标 1.2。估大一点比估小一点安全。
    const CJK = 1.4;
    const LATIN = 1.2;
    const SLACK = 8;
    const contentHeight = (height: number) => height - 2 * CONTENT_MARGIN;
    const small = metricsFor("small", 158, 158);
    const smallNeed =
      Math.max(small.place * CJK, small.icon * LATIN) + small.temp * LATIN + small.cond * CJK + small.range * CJK + small.gap * 3;
    check(`小号竖向预算：${smallNeed.toFixed(0)} + ${SLACK} ≤ ${contentHeight(158)}`, smallNeed + SLACK <= contentHeight(158));
    // 有预警时徽章占一个现成的位置（小号换掉最高最低那行，中号换掉天气文字后面的降水概率，大号放在地名那一行里）。
    // 徽章是一个比旁边字略高的方块（边长 = 字号 × ALERT_BADGE_RATIO），那一行取两者里高的
    const chipHeight = (size: number) => Math.max(size * CJK, size * ALERT_BADGE_RATIO);
    const smallChipNeed = smallNeed - small.range * CJK + chipHeight(small.range);
    check(`小号带预警徽章的竖向预算：${smallChipNeed.toFixed(1)} + ${SLACK} ≤ ${contentHeight(158)}`, smallChipNeed + SLACK <= contentHeight(158));

    // 中号：上面两栏，下面一行（详细数据 / 提醒）。有底行时两栏靠上、底行靠下，VStack 的间距加在三个子项（两栏、Spacer、底行）之间共 2 处
    const medium = metricsFor("medium", 338, 158);
    const mediumStrip = medium.slotLabel * CJK + medium.slotGap + medium.slotIconBox + medium.slotGap + medium.slotText * CJK;
    const mediumLeft = medium.place * CJK + medium.temp * LATIN + medium.range * CJK + medium.gap * 2;
    const summaryRow = Math.max(medium.cond * CJK, medium.icon * LATIN);
    const mediumRight = summaryRow + 0.5 + mediumStrip + medium.gap * 2 * 2;
    const mediumNeed = Math.max(mediumLeft, mediumRight) + medium.gap * 2 + medium.stat * CJK;
    check(`中号竖向预算：${mediumNeed.toFixed(0)} + ${SLACK} ≤ ${contentHeight(158)}`, mediumNeed + SLACK <= contentHeight(158));
    const mediumRightChip = mediumRight - summaryRow + Math.max(summaryRow, chipHeight(medium.rain));
    const mediumChipNeed = Math.max(mediumLeft, mediumRightChip) + medium.gap * 2 + medium.stat * CJK;
    check(`中号带预警徽章的竖向预算：${mediumChipNeed.toFixed(1)} + ${SLACK} ≤ ${contentHeight(158)}`, mediumChipNeed + SLACK <= contentHeight(158));

    // 大号有详细数据：地名行、天气和气温、细线、逐小时一排、细线、明天起的几天（LARGE_DAYS，接口给 5 天也只画这么多）、底行；VStack 的间距在 8 个子项（含一个 Spacer）之间共 7 处
    const large = metricsFor("large", 338, 354);
    const largeStrip = large.slotLabel * CJK + large.slotGap + large.slotIconBox + large.slotGap + large.slotText * CJK;
    const largeCurrent = Math.max(
      Math.max(large.cond * CJK, large.icon * LATIN) + large.gap + large.range * CJK,
      large.temp * LATIN,
    );
    const DAYS = LARGE_DAYS;
    const largeDays = DAYS * large.dayRow + (DAYS - 1) * large.dayGap;
    const largeDetailed = large.place * CJK + largeCurrent + 0.5 + largeStrip + 0.5 + largeDays + large.stat * CJK + large.rowGap * 7;
    check(`大号（有详细数据）竖向预算：${largeDetailed.toFixed(0)} + ${SLACK} ≤ ${contentHeight(354)}`, largeDetailed + SLACK <= contentHeight(354));
    check("大号每一天那一行放得下它自己的字和图标", large.dayRow >= large.day * CJK && large.dayRow >= large.dayIcon * LATIN);
    check("大号的徽章在地名那一行里，不比地名那行高（不额外占竖向）", chipHeight(large.rain) <= large.place * CJK);

    // 大号没有详细数据（备用来源）：老样子，两排逐小时、底下只有出了状况才有的提醒
    const largeHead =
      large.place * CJK + large.gap + Math.max(large.temp * LATIN + 2 + large.range * CJK, Math.max(large.cond * CJK, large.icon * LATIN) + large.gap + large.rain * CJK);
    const largePlain = largeHead + 0.5 + largeStrip * 2 + large.stat * CJK + large.rowGap * 5;
    check(`大号（备用来源）竖向预算：${largePlain.toFixed(0)} + ${SLACK} ≤ ${contentHeight(354)}`, largePlain + SLACK <= contentHeight(354));
    console.log(`    · 竖向预算（行高估法见上）：小号 ${smallNeed.toFixed(1)}（带徽章 ${smallChipNeed.toFixed(1)}） / ${contentHeight(158)}，中号 ${mediumNeed.toFixed(1)}（带徽章 ${mediumChipNeed.toFixed(1)}） / ${contentHeight(158)}，大号 ${largeDetailed.toFixed(1)}（备用来源 ${largePlain.toFixed(1)}） / ${contentHeight(354)}`);

    // 显示样式：中号 12 种组合（中间一排 × 右上那一行 × 底部那一行，有没有预警各算一遍），竖向都要放得下，还要留 8pt 余量。
    // 用的是 layoutVariant 选出的那套字号（选了「未来几天」或「一句话」的用紧凑的）；有预警时右上那一行换成徽章（比字略高）
    const mediumNeedFor = (display: Display, withChip: boolean): number => {
      const m = metricsFor("medium", 338, 158, layoutVariant("medium", display));
      const windy = display.top === "windHumidity";
      const left = m.place * CJK + Math.max(m.temp * LATIN, windy ? m.bigIcon * LATIN : 0) + m.range * CJK + m.gap * 2;
      const chip = withChip ? chipHeight(m.rain) : 0;
      const topRow = windy ? Math.max(m.top * CJK, chip) : Math.max(m.cond * CJK, m.icon * LATIN, chip);
      const strip =
        display.strip === "daily"
          ? m.slotLabel * CJK + m.slotGap + m.slotIconBox + m.slotGap + m.dayHigh * LATIN + m.slotGap + m.dayLow * LATIN
          : m.slotLabel * CJK + m.slotGap + m.slotIconBox + m.slotGap + m.slotText * CJK;
      const right = topRow + 0.5 + strip + m.gap * 2 * 2;
      const bottom = display.bottom === "stats" ? m.stat * CJK : display.bottom === "headline" ? Math.max(m.headline * CJK, m.item * CJK) : 0;
      return Math.max(left, right) + (bottom > 0 ? m.gap * 2 + bottom : 0);
    };
    let worstMedium = 0;
    const tooTall: string[] = [];
    for (const strip of ["hourly", "daily"] as const) {
      for (const top of ["condition", "windHumidity"] as const) {
        for (const bottom of ["stats", "headline", "none"] as const) {
          for (const chip of [false, true]) {
            const need = mediumNeedFor({ strip, top, bottom, headline: "auto" }, chip);
            worstMedium = Math.max(worstMedium, need);
            if (need + SLACK > contentHeight(158)) tooTall.push(`${strip}/${top}/${bottom}${chip ? "/预警" : ""}：${need.toFixed(1)}`);
          }
        }
      }
    }
    check(`中号 12 种显示样式组合（含有预警的）竖向都放得下：最高的一种 ${worstMedium.toFixed(1)} + ${SLACK} ≤ ${contentHeight(158)}${tooTall.length === 0 ? "" : "；放不下的：" + tooTall.join("、")}`, tooTall.length === 0);
    check("默认样式（逐小时、天气和降水概率、体感湿度风空气）还是原来的字号和高度", mediumNeedFor(defaultDisplay(), false) === mediumNeed);
    const largeHeadline = largeDetailed - large.stat * CJK + Math.max(large.headline * CJK, large.item * CJK);
    check(`大号底部选「一句话」竖向预算：${largeHeadline.toFixed(1)} + ${SLACK} ≤ ${contentHeight(354)}`, largeHeadline + SLACK <= contentHeight(354));
    console.log(`    · 显示样式的竖向预算：中号 12 种组合里最高的 ${worstMedium.toFixed(1)} / ${contentHeight(158)}，大号底部选「一句话」${largeHeadline.toFixed(1)} / ${contentHeight(354)}`);
    check("紧凑版只有中号有：小号、大号要紧凑版也还是原来的字号；中号的紧凑版字号都不比原来的大", JSON.stringify(metricsFor("large", 338, 354, "compact")) === JSON.stringify(metricsFor("large", 338, 354)) && JSON.stringify(metricsFor("small", 158, 158, "compact")) === JSON.stringify(metricsFor("small", 158, 158)) && (() => {
      const standard = metricsFor("medium", 338, 158);
      const compact = metricsFor("medium", 338, 158, "compact");
      return compact.temp < standard.temp && compact.place <= standard.place && compact.slotLabel <= standard.slotLabel && compact.slotText <= standard.slotText && compact.gap <= standard.gap && compact.leftWidth === standard.leftWidth;
    })());
    check("紧凑版里要用到的字号都有：一句话、日落和空气、未来几天的最高最低；原来的那套里没有（用不到）", (() => {
      const compact = metricsFor("medium", 338, 158, "compact");
      const standard = metricsFor("medium", 338, 158);
      return compact.headline > 0 && compact.item > 0 && compact.dayHigh > 0 && compact.dayLow > 0 && compact.top > 0 && compact.bigIcon > 0 && standard.headline === 0 && standard.dayHigh === 0 && standard.top > 0 && standard.bigIcon > 0;
    })());
  }

  // ---------------------------------------------------------------- 配色
  section("配色对比度");
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
    const over = (alpha: number, background: [number, number, number]): [number, number, number] =>
      background.map((v) => 255 * alpha + v * (1 - alpha)) as [number, number, number];
    const mix = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
      a.map((v, i) => (v + b[i]) / 2) as [number, number, number];
    const white: [number, number, number] = [255, 255, 255];

    let worst = Infinity;
    const problems: string[] = [];
    for (const [sky, pair] of Object.entries(SKY)) {
      for (const [phase, [topHex, bottomHex]] of Object.entries(pair)) {
        const top = rgb(topHex);
        const bottom = rgb(bottomHex);
        const middle = mix(top, bottom);
        const primary = Math.min(ratio(white, top), ratio(white, middle), ratio(white, bottom));
        const secondary = Math.min(ratio(over(TEXT_SECONDARY_ALPHA, middle), middle), ratio(over(TEXT_SECONDARY_ALPHA, bottom), bottom));
        worst = Math.min(worst, primary, secondary);
        if (primary < 4.5 || secondary < 4.5) problems.push(`${sky}/${phase}: ${primary.toFixed(2)} ${secondary.toFixed(2)}`);
      }
    }
    check(`16 对天空色：白字 100% / 80% 都 ≥ 4.5:1（最差 ${worst.toFixed(2)}）`, problems.length === 0);
    for (const line of problems) console.log("    · " + line);
    // 未来几天的降水概率（淡蓝字）压在中间和下端 ≥ 4.5:1；空气质量的小圆点外面有一圈白边（半透明白），白边压在各套天空色上 ≥ 3:1（图形元素的最低要求）
    let worstRain = Infinity;
    let worstDot = Infinity;
    for (const pair of Object.values(SKY)) {
      for (const [topHex, bottomHex] of Object.values(pair)) {
        const top = rgb(topHex);
        const bottom = rgb(bottomHex);
        const middle = mix(top, bottom);
        worstRain = Math.min(worstRain, ratio(rgb(RAIN_TEXT), middle), ratio(rgb(RAIN_TEXT), bottom));
        for (const background of [top, middle, bottom]) worstDot = Math.min(worstDot, ratio(over(0.85, background), background));
      }
    }
    check(`降水概率的淡蓝字压在 16 套天空色的中间和下端 ≥ 4.5:1（最差 ${worstRain.toFixed(2)}）`, worstRain >= 4.5);
    check(`空气质量小圆点的白边压在 16 套天空色的上、中、下 ≥ 3:1（最差 ${worstDot.toFixed(2)}）`, worstDot >= 3);
    check("空气质量的 6 种颜色各不相同、都是 #RRGGBB", AQI_COLOR.length === 6 && new Set(AQI_COLOR).size === 6 && AQI_COLOR.every((hex) => /^#[0-9A-F]{6}$/.test(hex)));
    check("每种天空都有白天和夜里两套", Object.keys(SKY).length === 8 && Object.values(SKY).every((pair) => pair.day.length === 2 && pair.night.length === 2));
    check("颜色都是 #RRGGBB", Object.values(SKY).every((pair) => [...pair.day, ...pair.night].every((hex) => /^#[0-9A-F]{6}$/.test(hex))));
  }

  // ---------------------------------------------------------------- 源码扫描
  section("源码扫描");
  {
    const files = sourceFiles(SCRIPT_DIR);
    check("文件都在", files.length >= 16);

    // 设备上的转译把 .ts 也当 TSX 解析，`async <T>(x) =>` 里的 <T> 会被当成 JSX 标签，整个脚本起不来。
    const genericArrow = /(?:^|[^<\w])<([A-Z]\w*)>\s*\(/;
    const offenders = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.split("\n").some((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && genericArrow.test(line) && !/\btype\b|\binterface\b/.test(line));
    });
    check("没有裸的泛型箭头函数", offenders.length === 0);
    // 尖括号类型断言 `<Foo>value` 在 TSX 里同样会被当成 JSX
    const angleCast = /=\s*<[A-Za-z][\w.]*>\s*[\w(]/;
    check("没有尖括号写法的类型断言", files.every((file) => !angleCast.test(readFileSync(file, "utf8").split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n"))));

    const all = files.map((file) => readFileSync(file, "utf8")).join("\n");
    const code = all.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
    check("没有用 readAsBytes（真机回的是 ArrayBuffer）", !/readAsBytes/.test(code));
    check("没有拿 Dialog.prompt 的结果判 === null（真机回 undefined）", !/prompt[\s\S]{0,160}===\s*null/.test(code));
    check("没有 destructive 的左滑按钮", !/swipeActions/.test(code));

    const widgetFiles = files.filter((file) => /[\\/](widget\.tsx|widget[\\/][^\\/]+)$/.test(file));
    const widgetCode = widgetFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    check("找到了小组件文件", widgetFiles.length >= 3);
    const viewCode = readFileSync(join(SCRIPT_DIR, "widget", "view.tsx"), "utf8");
    const frameCode = readFileSync(join(SCRIPT_DIR, "widget", "frame.tsx"), "utf8");
    check("根视图撑成 displaySize 的满尺寸，内容走 fullFrame（背景才能铺到边）", /frame=\{\{ width, height \}\}/.test(viewCode) && /fullFrame\(width, height, m\.inset/.test(viewCode));
    check("fullFrame：里层写死满尺寸，内缩层用 infinity（padding 和 frame 谁先谁后都一样）", /frame=\{\{ width, height \}\}/.test(frameCode) && /maxWidth: "infinity", maxHeight: "infinity"/.test(frameCode) && !/padding=\{inset\}[^>]*frame=\{\{ width/.test(frameCode));
    check("小组件里没有 Link（有 Link 的话 widgetURL 会被忽略，点一下就打不开 App 了）", !/<Link\b/.test(widgetCode));
    check("背景走 widgetBackground，不是 background（染色模式下才会自己藏起来）", /widgetBackground/.test(widgetCode));
    check("多色图标", /symbolRenderingMode="multicolor"/.test(widgetCode));
    check("小组件点一下打开本脚本（widgetURL）", /widgetURL/.test(widgetCode));
    check("小组件里没有 Hooks（小组件是一次性渲染，不生效）", !/\buse(State|Effect|Memo|Ref|Callback|Reducer)\b/.test(widgetCode));
    check("小组件调 Widget.present 只在 widget.tsx 里一处", files.filter((file) => /Widget\.present\(/.test(readFileSync(file, "utf8"))).length === 1);

    const core = files.filter((file) => /[\\/]core[\\/]/.test(file));
    const pure = core.filter((file) => !/[\\/](store|system)\.ts$/.test(file));
    check("纯逻辑文件里不碰 Storage / Location / Widget / Script", pure.every((file) => !/\b(Storage|Location|Widget|Script)\./.test(readFileSync(file, "utf8").split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n"))));
    // 数据署名只在 App 页里（Open-Meteo 的数据是 CC BY 4.0，要署名）；小组件卡片上不画（用户嫌不好看，另见 alerts 自测里的源码扫描）
    check("署名：App 页里有 Open-Meteo.com 和链接", /Open-Meteo\.com/.test(readFileSync(join(SCRIPT_DIR, "index.tsx"), "utf8")) && /https:\/\/open-meteo\.com/.test(readFileSync(join(SCRIPT_DIR, "index.tsx"), "utf8")));
    check("没有作者 / 频道的页脚：文件没了、没人引用、也没有 Telegram 链接（用户要求去掉）", !files.some((file) => /AuthorFooter/.test(file)) && !/AuthorFooter|t\.me\//.test(all));
  }

  console.log("\n" + passed + " 项通过，" + failed + " 项失败");
  if (failed > 0) process.exit(1);
}

void main();
