// 按图标颜色排序：从主色里挑一个代表色，按色相排成彩虹，黑白灰放最后。
//
// 主色由原生的 `UIImage.dominantColors()` 给（dts：先缩小再分析，按占比从高到低），
// 这里只做纯计算，不碰 UIImage，方便离线测试。
//
// 「白底图标取次要彩色」：日历、备忘录、Chrome 这类白底图标，占比最高的颜色是白，
// 照它排就全挤在「白」里。所以按占比依次找第一个「有颜色」的；
// 占比太小的不算（一点点彩色描边不该决定整个图标的颜色）。

export interface ColorSample {
  red: number;
  green: number;
  blue: number;
  /** 这个颜色占采样像素的比例，0..1。 */
  fraction: number;
}

export interface ColorKey {
  /** 有颜色的排前面；黑白灰排后面。 */
  chromatic: boolean;
  /** 0..360，已经平移过：偏紫的红也算红，彩虹从红开始。 */
  hue: number;
  saturation: number;
  lightness: number;
  /** 代表色，界面上画个色块用。 */
  hex: string;
}

/** 饱和度低于它算灰。 */
const MIN_SATURATION = 0.25;
/** 太暗、太亮的颜色肉眼看就是黑、白，色相没意义。 */
const MIN_LIGHTNESS = 0.12;
const MAX_LIGHTNESS = 0.92;
/** 占比低于它的颜色不拿来当代表色。 */
const MIN_FRACTION = 0.08;
/** 色相平移量：345°–360° 的红挪到彩虹开头，不让它跑到紫色后面去。 */
const HUE_SHIFT = 15;

function toHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function hexOf(sample: ColorSample): string {
  const part = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${part(sample.red)}${part(sample.green)}${part(sample.blue)}`;
}

/** 从主色列表里挑代表色，算出排序键。列表为空返回 null（图标没取到）。 */
export function colorKey(samples: ColorSample[]): ColorKey | null {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((a, b) => b.fraction - a.fraction);
  for (const sample of ordered) {
    if (sample.fraction < MIN_FRACTION) continue;
    const { h, s, l } = toHsl(sample.red, sample.green, sample.blue);
    if (s >= MIN_SATURATION && l >= MIN_LIGHTNESS && l <= MAX_LIGHTNESS) {
      return { chromatic: true, hue: (h + HUE_SHIFT) % 360, saturation: s, lightness: l, hex: hexOf(sample) };
    }
  }
  // 一个有颜色的都没有：按占比最高的那个颜色算黑白灰
  const top = ordered[0];
  const { h, s, l } = toHsl(top.red, top.green, top.blue);
  return { chromatic: false, hue: h, saturation: s, lightness: l, hex: hexOf(top) };
}

/** 按颜色建文件夹时的分组，也是文件夹名和先后顺序（彩虹顺序，黑白灰最后）。 */
export const COLOR_BUCKETS = ["红色", "橙色", "黄色", "绿色", "青色", "蓝色", "紫色", "粉色", "黑白灰"] as const;
export type ColorBucket = (typeof COLOR_BUCKETS)[number];

/**
 * 颜色键归到哪一组。色相的分界是按肉眼的习惯定的（真实色相，度）：
 *   红 345–15，橙 15–45，黄 45–70，绿 70–165，青 165–195，蓝 195–255，紫 255–300，粉 300–345。
 * 没颜色的（黑、白、灰）归「黑白灰」；取不到颜色（null）不归组，由调用方留在原位。
 */
export function colorBucket(key: ColorKey | null): ColorBucket | null {
  if (!key) return null;
  if (!key.chromatic) return "黑白灰";
  // ColorKey 里的色相平移过 HUE_SHIFT，先还原成真实色相
  const hue = (key.hue - HUE_SHIFT + 360) % 360;
  if (hue >= 345 || hue < 15) return "红色";
  if (hue < 45) return "橙色";
  if (hue < 70) return "黄色";
  if (hue < 165) return "绿色";
  if (hue < 195) return "青色";
  if (hue < 255) return "蓝色";
  if (hue < 300) return "紫色";
  return "粉色";
}

/**
 * 排序规则：有颜色的按色相从红到紫；同色相附近（10° 以内算一段）亮的在前。
 * 黑白灰排在后面，从白到黑。取不到颜色的（null）垫底。
 */
export function compareColorKeys(a: ColorKey | null, b: ColorKey | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  if (a.chromatic !== b.chromatic) return a.chromatic ? -1 : 1;
  if (!a.chromatic) return b.lightness - a.lightness;
  const bandA = Math.floor(a.hue / 10);
  const bandB = Math.floor(b.hue / 10);
  return bandA - bandB || b.lightness - a.lightness || a.hue - b.hue;
}
