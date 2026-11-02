// 日出日落和白天黑夜，按经纬度和日期自己算（NOAA 的太阳位置算法，误差一两分钟）。
//
// 为什么要自己算：彩云的接口返回里没有日出日落（文档里有，实测没有），晚上九点还会把天气现象写成「晴（白天）」，
// 不能拿它判断昼夜。算出来的日出日落用来在逐小时那一行里夹日出日落，也用来决定图标用太阳还是月亮、背景用白天还是夜里的天空色。
// Open-Meteo 自带日出日落和昼夜标记，不走这里。
//
// 纯函数。经度东正西负，纬度北正南负；时间一律是 UTC 毫秒，当地日期由调用方按查询地点的时区偏移算好传进来。

export type SunTimes = {
  /** 日出、日落（UTC 毫秒）；极昼极夜时是 null */
  readonly sunrise: number | null;
  readonly sunset: number | null;
  /** 这一天没有日出日落时，是一整天都是白天（极昼）还是一整天都是黑夜（极夜） */
  readonly polar: "day" | "night" | null;
};

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const DAY_MS = 86_400_000;

/** 儒略日（当天 UTC 正午） */
function julianDayAtNoon(year: number, month: number, day: number): number {
  const noon = Date.UTC(year, month - 1, day, 12, 0, 0);
  return noon / DAY_MS + 2440587.5;
}

/**
 * 某个当地日期（年月日）在这个地点的日出日落。
 * 日期按「UTC 日期 = 当地日期」去算：当地正午的太阳大致在 UTC 正午前后，差几个小时对赤纬和时差的影响在秒的量级。
 */
export function sunTimes(latitude: number, longitude: number, year: number, month: number, day: number): SunTimes {
  const t = (julianDayAtNoon(year, month, day) - 2451545.0) / 36525.0;

  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center =
    Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly * RAD) * 0.000289;
  const trueLongitude = meanLongitude + center;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLongitude * RAD));

  const y = Math.tan((obliquity * RAD) / 2) ** 2;
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * meanLongitude * RAD) -
      2 * eccentricity * Math.sin(meanAnomaly * RAD) +
      4 * eccentricity * y * Math.sin(meanAnomaly * RAD) * Math.cos(2 * meanLongitude * RAD) -
      0.5 * y * y * Math.sin(4 * meanLongitude * RAD) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * RAD));

  // 太阳上沿碰到地平线（含大气折射）：天顶角 90.833°
  const cosHourAngle =
    Math.cos(90.833 * RAD) / (Math.cos(latitude * RAD) * Math.cos(declination)) - Math.tan(latitude * RAD) * Math.tan(declination);
  if (cosHourAngle > 1) return { sunrise: null, sunset: null, polar: "night" };
  if (cosHourAngle < -1) return { sunrise: null, sunset: null, polar: "day" };

  const hourAngle = Math.acos(cosHourAngle) * DEG;
  const midnight = Date.UTC(year, month - 1, day);
  const minutesAt = (angle: number): number => 720 - 4 * (longitude + angle) - equationOfTime;
  return {
    sunrise: midnight + Math.round(minutesAt(hourAngle) * 60_000),
    sunset: midnight + Math.round(minutesAt(-hourAngle) * 60_000),
    polar: null,
  };
}

/** 某个时刻在这个地点的当地日期（年月日） */
export function localDate(epoch: number, utcOffsetSeconds: number): { year: number; month: number; day: number } {
  const wall = new Date(epoch + utcOffsetSeconds * 1000);
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

/** 这个时刻，这个地点是白天吗（太阳在地平线以上） */
export function isDaylight(latitude: number, longitude: number, epoch: number, utcOffsetSeconds: number): boolean {
  const { year, month, day } = localDate(epoch, utcOffsetSeconds);
  const sun = sunTimes(latitude, longitude, year, month, day);
  if (sun.polar !== null) return sun.polar === "day";
  if (sun.sunrise === null || sun.sunset === null) return true;
  return epoch >= sun.sunrise && epoch < sun.sunset;
}
