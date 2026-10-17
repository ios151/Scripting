// 坐标解析与转换：从地图链接（苹果/高德/Google/百度）或纯文本提取经纬度，
// 并提供 GCJ-02 ↔ WGS-84 互转。移植自 wloc worker 的 parse.js。

import type { ParsedCoord } from "../types";
import { isInsideChina } from "../constants";

/** 安全解码 URL 组件 */
function safeDecode(s: string | null | undefined): string {
  if (!s) return "";
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch {
    return String(s);
  }
}

/** 保留 6 位小数 */
function round6(n: number): number {
  return Math.round(Number(n) * 1e6) / 1e6;
}

/**
 * 从一段字符串里提取经纬度+名称。兼容：
 *  - 苹果地图 coordinate=/ll=/sll=纬度,经度（名称在 name=...）
 *  - 高德 ?p=POIID,纬度,经度,名称,城市
 *  - 高德 ?q=纬度,经度,名称（新版分享链）
 *  - Google Maps ll=/@/center=
 *  - 纯文本 纬度,经度
 */
function extractFromString(s: string): ParsedCoord | null {
  if (!s) return null;
  const str = String(s);
  let m: RegExpMatchArray | null;

  /*
    先认百度，因为它的参数名（`location=` / `latlng=`）会被后面那条通用规则
    抢走，而两者的坐标系差着约 500 米。

    判据是域名：只有确实来自 `map.baidu.com` / `api.map.baidu.com` 的链接才
    按 BD-09 处理——别处的 `location=` 参数不是百度坐标。
    百度这两个参数都是「纬度,经度」顺序。
  */
  if (/(?:^|\/\/|\.)(?:api\.)?map\.baidu\.com/i.test(str)) {
    m = str.match(/(?:location|latlng)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
    if (m) {
      const nm = str.match(/[?&](?:title|name)=([^&]+)/i);
      return {
        latitude: +m[1],
        longitude: +m[2],
        name: nm ? safeDecode(nm[1]) : "",
        src: "baidu",
      };
    }
  }

  /*
    链接自己声明了坐标系就照它说的办。

    高德、腾讯的部分接口支持 `coord_type=wgs84`、`datum=wgs84` 这类参数，
    带上了就说明给的是真实坐标，不换算会偏几百米。
  */
  if (/(?:datum|coord_?type|coordsys)=wgs ?-?84/i.test(str)) {
    // 有 `coord_type=wgs84` 这种强信号，小数位要求可以放到 3 位（约 100 米精度，
    // 真实链接的下限），但不能更松，否则会匹配上版本号一类的数字对。
    m = str.match(/(-?\d{1,3}\.\d{3,})(?:,|%2C)(-?\d{1,3}\.\d{3,})/);
    if (m) {
      const a = +m[1];
      const b = +m[2];
      // 纬度不可能超过 90，据此判顺序
      const flipped = Math.abs(a) > 90 && Math.abs(b) <= 90;
      return {
        latitude: flipped ? b : a,
        longitude: flipped ? a : b,
        src: "wgs84",
      };
    }
  }

  // 苹果地图 coordinate=/ll=/sll=纬度,经度
  m = str.match(/(?:coordinate|ll|sll)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) {
    const nm = str.match(/[?&]name=([^&]+)/i);
    return { latitude: +m[1], longitude: +m[2], name: nm ? safeDecode(nm[1]) : "", src: "apple" };
  }

  // 高德 ?p=POIID,纬度,经度,名称,城市
  m = str.match(
    /[?&]p=[^,&%]*(?:,|%2C)(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i,
  );
  if (m) return { latitude: +m[1], longitude: +m[2], name: m[3] ? safeDecode(m[3]) : "", src: "amap" };

  // 高德 ?q=纬度,经度,名称
  m = str.match(
    /[?&]q=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i,
  );
  if (m) return { latitude: +m[1], longitude: +m[2], name: m[3] ? safeDecode(m[3]) : "", src: "amap" };

  // Google Maps ll=纬度,经度 / lnglat=经度,纬度
  m = str.match(/ll=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m) return { latitude: +m[1], longitude: +m[2], src: "google" };
  m = str.match(/lnglat=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m) return { latitude: +m[2], longitude: +m[1], src: "amap" };

  // @纬度,经度（Google Maps / 高德常见）
  m = str.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m) return { latitude: +m[1], longitude: +m[2], src: "google" };

  // location=/center=经度,纬度（部分格式）
  m = str.match(/(?:location|center)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/i);
  if (m) return { latitude: +m[2], longitude: +m[1], src: "text" };

  // 纯文本 纬度,经度（自动判断顺序）
  m = str.match(/(-?\d{1,3}\.\d{4,})\s*(?:,|%2C|\s)\s*(-?\d{1,3}\.\d{4,})/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    if (a <= 90 && b > 90) return { latitude: a, longitude: b, src: "text" };
    if (b <= 90 && a > 90) return { latitude: b, longitude: a, src: "text" };
    return { latitude: a, longitude: b, src: "text" };
  }
  return null;
}


/**
 * 展开短链接：对疑似短链发 fetch 请求，跟踪 302 重定向后
 * 返回最终落地 URL。非链接或展开失败则原样返回。
 */
async function expandShortUrl(raw: string): Promise<string> {
  const urlMatch = raw.match(/https?:\/\/[^\s'"<>]+/i);
  if (!urlMatch) return raw;
  const url = urlMatch[0];
  // 判断是否需要做网络展开：已知短链域名 / 任何不含坐标参数的 URL
  const isKnownShort = /surl\.amap\.com|amap\.com\/s\/|bit\.ly|t\.cn|dwz\.cn|url\.cn|tinyurl|j\.mp|b23\.tv|outu\.in/i.test(url);
  const hasCoordParam = /[?&](p=|q=|ll=|coordinate=|sll=|lnglat=)/i.test(url);
  // 已含坐标参数的长链无需展开；已知短链或任何无坐标参数的链接都尝试展开
  if (!isKnownShort && hasCoordParam) return raw;
  try {
    const resp = await fetch(url, {
      method: "GET",
      allowInsecureRequest: true,
      timeout: 8,
    });
    const finalUrl = resp.url;
    // 若最终 URL 与输入不同，说明发生了重定向，返回展开后的 URL
    if (finalUrl && finalUrl !== url) return finalUrl;
  } catch {
    // 网络失败则静默回退，继续尝试同步正则
  }
  return raw;
}

/**
 * 解析输入，返回坐标。异步版本：
 * 先尝试同步正则，失败后展开短链再重试。
 */
async function parseCoordsAsync(raw: string): Promise<ParsedCoord> {
  // 第一步：同步正则快速路径
  const text = String(raw || "").trim();
  if (!text) throw new Error("空输入");

  const urlMatch = text.match(/https?:\/\/[^\s'"<>]+/i);
  const target = urlMatch ? urlMatch[0] : text;
  const hit = extractFromString(target);
  if (hit) return hit;

  // 第二步：同步正则失败 → 尝试展开短链后重试
  const expanded = await expandShortUrl(raw);
  if (expanded !== raw) {
    const expUrlMatch = expanded.match(/https?:\/\/[^\s'"<>]+/i);
    const expTarget = expUrlMatch ? expUrlMatch[0] : expanded;
    const hit2 = extractFromString(expTarget);
    if (hit2) return hit2;
  }

  throw new Error("未能从链接中解析出经纬度，请确认链接是否有效");
}

// ── GCJ-02 ↔ WGS-84 转换 ──────────────────────────────────────────

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function gcjDeltaLat(x: number, y: number): number {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function gcjDeltaLon(x: number, y: number): number {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return r;
}

/** WGS-84 → GCJ-02（正向偏移），与高德/苹果中国所用偏移一致 */
function wgs84ToGcj02(lat: number, lon: number): { latitude: number; longitude: number } {
  if (!isInsideChina(lon, lat)) return { latitude: lat, longitude: lon };
  let dLat = gcjDeltaLat(lon - 105.0, lat - 35.0);
  let dLon = gcjDeltaLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { latitude: lat + dLat, longitude: lon + dLon };
}

/** GCJ-02 → WGS-84（迭代反算，亚米级精度） */
function gcj02ToWgs84(lat: number, lon: number): { latitude: number; longitude: number } {
  if (!isInsideChina(lon, lat)) return { latitude: lat, longitude: lon };
  let wgsLat = lat;
  let wgsLon = lon;
  for (let i = 0; i < 6; i++) {
    const g = wgs84ToGcj02(wgsLat, wgsLon);
    const errLat = g.latitude - lat;
    const errLon = g.longitude - lon;
    if (Math.abs(errLat) < 1e-9 && Math.abs(errLon) < 1e-9) break;
    wgsLat -= errLat;
    wgsLon -= errLon;
  }
  return { latitude: wgsLat, longitude: wgsLon };
}

/**
 * 解析链接（异步版），结果按应用内的地图系返回。
 *
 * 地图链接给出的本来就是地图系坐标（中国大陆为 GCJ-02，境外即 WGS-84），
 * 原样留着才能落在地图上的正确位置；下发给设备时由 toDeviceCoordinate 统一转回。
 * 内部调用 parseCoordsAsync，支持短链 302 重定向展开。
 */
/** 经纬度在不在合法值域内。解析出来的东西一律先过这一关。 */
function inRange(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

/**
 * BD-09（百度坐标系）→ GCJ-02。
 *
 * 百度在 GCJ-02 之上又加了一层自己的偏移，不换算差约 500 米。注释和界面提示
 * 一直写着支持百度链接，实际上**从来没有这段换算**——解析出来的 BD-09 被当成
 * 地图系直接用了。
 */
function bd09ToGcj02(lat: number, lon: number): { latitude: number; longitude: number } {
  const X_PI = (Math.PI * 3000) / 180;
  const x = lon - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { latitude: z * Math.sin(theta), longitude: z * Math.cos(theta) };
}

export async function parseAndConvert(raw: string): Promise<ParsedCoord> {
  const hit = await parseCoordsAsync(raw);
  if (!inRange(hit.latitude, hit.longitude)) {
    throw new Error(
      `解析出的坐标超出合法范围（${hit.latitude}, ${hit.longitude}）。换个链接或直接填经纬度试试。`,
    );
  }

  /*
    统一成应用内的地图系（大陆为 GCJ-02）再交出去。

    - `baidu`：BD-09，必须换算，否则差约 500 米。
    - `wgs84`：链接里明确标了 `datum=wgs84` / `coord=wgs84` 之类，按真实坐标
      换进地图系。
    - `apple` / `amap`：本来就是 GCJ-02，原样。
    - `google` / `text`：**无从判断**。Google 在大陆显示 GCJ-02、国际版是
      WGS-84，而 `@lat,lng` 这种写法两家都在用；纯文本更是什么都可能。
      维持「当作地图系」的旧行为——猜错了至少和以前一致，不会突然把老用户
      常用的链接挪到别处去。
  */
  let { latitude, longitude } = hit;
  if (hit.src === "baidu") {
    ({ latitude, longitude } = bd09ToGcj02(latitude, longitude));
  } else if (hit.src === "wgs84") {
    ({ latitude, longitude } = wgs84ToGcj02(latitude, longitude));
  }

  if (!inRange(latitude, longitude)) {
    throw new Error("坐标换算后超出合法范围，这个链接的坐标系可能不是预期的那种。");
  }
  return { ...hit, latitude: round6(latitude), longitude: round6(longitude) };
}

// ── 应用内坐标系 ↔ 设备坐标系 ────────────────────────────────────

/**
 * 应用内坐标（地图系）→ 下发给设备的 WGS-84。
 *
 * 国内 iPhone 的地图数据源是高德，点在地图上的坐标是 GCJ-02，而
 * DVT 的定位模拟接受的是真实 WGS-84，不换算会偏差数百米。境外两者相同。
 */
export function toDeviceCoordinate(lat: number, lon: number): { latitude: number; longitude: number } {
  return gcj02ToWgs84(lat, lon);
}

/** 设备 GPS / 境外来源的 WGS-84 → 应用内地图系。 */
export function fromDeviceCoordinate(lat: number, lon: number): { latitude: number; longitude: number } {
  return wgs84ToGcj02(lat, lon);
}

/** 同一个点在两套坐标系下的值。 */
export type CoordinateReadout = {
  /** 应用内地图系：中国大陆是 GCJ-02，境外本身就是 WGS-84。 */
  map: { latitude: number; longitude: number };
  /** 真正下发给设备的 WGS-84。 */
  wgs84: { latitude: number; longitude: number };
  /**
   * 两者是否一致。
   *
   * GCJ-02 的偏移只存在于中国境内，境外 `gcj02ToWgs84` 原样返回。那时并排列出
   * 两行一模一样的数字、还各自标一个坐标系名，是在无中生有地制造区别——
   * 调用方据此只显示一行。
   */
  same: boolean;
};

/**
 * 取当前点在两套坐标系下的值，给界面展示用。
 *
 * **不带扰动。** `deviceCoordinate()` 在换算之后还会按设置加随机偏移，那个值
 * 每次下发都不一样，显示出来既对不上地图也复制不走，只会让人以为算错了。
 * 这里要回答的是「这个点的真实坐标是多少」，扰动是另一回事。
 */
export function coordinateReadout(lat: number, lon: number): CoordinateReadout {
  const map = { latitude: round6(lat), longitude: round6(lon) };
  const converted = toDeviceCoordinate(lat, lon);
  const wgs84 = { latitude: round6(converted.latitude), longitude: round6(converted.longitude) };
  return {
    map,
    wgs84,
    same: map.latitude === wgs84.latitude && map.longitude === wgs84.longitude,
  };
}

/**
 * 「纬度, 经度」，六位小数。
 *
 * 顺序照通行写法（Apple 地图、Google 地图、各类坐标拾取器都是纬在前），
 * 复制出去能直接粘进别处。界面上另有一行小字点明顺序，免得和脚本里
 * 「经度 … 纬度 …」的旧写法打架。
 */
export function formatLatLng(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/**
 * 位置扰动：在半径内随机偏移，让静止时的轨迹更像真机。
 *
 * 半径为 0 时原样返回。面积均匀分布，所以半径取平方根。
 */
export function applyJitter(
  lat: number,
  lon: number,
  radiusMetres: number,
): { latitude: number; longitude: number } {
  if (!radiusMetres || radiusMetres <= 0) return { latitude: lat, longitude: lon };

  const distance = radiusMetres * Math.sqrt(Math.random());
  const bearing = Math.random() * 2 * Math.PI;
  const deltaLat = (distance * Math.cos(bearing)) / 111320;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const deltaLon = Math.abs(cosLat) < 1e-6 ? 0 : (distance * Math.sin(bearing)) / (111320 * cosLat);

  return { latitude: lat + deltaLat, longitude: lon + deltaLon };
}
