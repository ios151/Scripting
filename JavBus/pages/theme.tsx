// 全 App 共用的视觉语言：沿用详情页（照 One-ipa 的媒体中心风格）——深色沉浸，白色系的字，
// 半透明白的胶囊和卡片，选中的那一项是白底黑字（和详情页那个白色大「播放」同一个语气）。
//
// 整个脚本是深色设计，不管系统明暗：根视图锁成深色（preferredColorScheme），自己画的字和图标用明确的白色系（INK），
// 不用 label / secondaryLabel——它们跟系统明暗走，锁定一旦没生效就会变成深灰字落在深色底上。

import { Button, HStack, Image, Rectangle, Text, ZStack, type Color } from "scripting";

import { RemoteImage } from "./RemoteImage";

export const INK: Record<"strong" | "body" | "icon" | "soft" | "faint", Color> = {
  strong: "white",
  body: "rgba(255,255,255,0.82)",
  icon: "rgba(255,255,255,0.88)",
  soft: "rgba(255,255,255,0.62)",
  faint: "rgba(255,255,255,0.45)",
};

/** 小胶囊的底（半透明白）。 */
export const GLASS: Color = "rgba(255,255,255,0.16)";
/** 卡片的底。 */
export const CARD: Color = "rgba(255,255,255,0.10)";
/** 链接字：深色底上的系统蓝太暗，用浅一档的。 */
export const LINK: Color = "#7fb8ff";
/** 出错的字：深色底上的系统红太暗，用浅一档的。 */
export const DANGER: Color = "#ff8a8a";

/** 页面左右留白。 */
export const SIDE = 16;
/** 内容列的最大宽度：iPad 上是一条居中的窄列，不是整屏铺开。 */
export const COLUMN_MAX = 640;

/**
 * 内容列宽（去掉两侧留白）。
 * 需要定宽的胶囊 / 分段按它算死：Menu / Button 的 label 里写 `frame({ maxWidth: "infinity" })` 在真机上不撑开
 * （详情页第一版的底栏就栽在这），固定宽度不依赖这一点。
 */
export function columnWidth(): number {
  return Math.min(Device.screen.width, COLUMN_MAX) - SIDE * 2;
}

/** 每个 Tab 页背景顶端那一抹光的颜色：一个 Tab 一个色，一眼认得出自己在哪一页。 */
export const TINT: Record<"home" | "stars" | "genres" | "recommend" | "library" | "plain", Color> = {
  home: "rgba(204,51,68,0.26)",
  stars: "rgba(214,86,163,0.24)",
  genres: "rgba(64,132,255,0.22)",
  recommend: "rgba(246,139,31,0.22)",
  library: "rgba(255,90,110,0.24)",
  plain: "rgba(120,130,160,0.16)",
};

/**
 * 没有封面可糊的页面（列表、设置…）的背景：深色竖向渐变 + 顶端一抹带颜色的光。
 * 只用渐变不用 blur：整屏的大半径模糊每次转场都要 GPU 现算，页面进出会掉帧（One-ipa 里踩过）。
 */
export function PageBackdrop({ tint = TINT.plain }: { tint?: Color }) {
  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} ignoresSafeArea>
      <Rectangle fill={{ colors: ["#0C0E13", "#11141B", "#08090C"], startPoint: "top", endPoint: "bottom" }} />
      <Rectangle fill={{ colors: [tint, "rgba(0,0,0,0)"], startPoint: "top", endPoint: "center" }} />
    </ZStack>
  );
}

/**
 * 有封面的页面（影片详情、演员页）的背景：封面糊成一层暗色底，字放上去才看得清。
 * 糊法也是只解几十像素的小图再放大，双线性放大本身就是模糊，不花 GPU。
 */
export function CoverBackdrop({ cover }: { cover: string }) {
  // 背景图固定成整屏大小：fill 的图自己的比例会带进布局，没有固定 frame 会把根视图撑歪
  const { width, height } = Device.screen;
  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} ignoresSafeArea>
      <Rectangle fill="black" />
      {cover ? (
        <ZStack frame={{ width, height }} scaleEffect={1.4} opacity={0.6}>
          <RemoteImage url={cover} maxSide={48} mode="fill" width={width} height={height} background="black" interpolation="high" quiet />
        </ZStack>
      ) : null}
      {/* 顶端压得比 One-ipa 重一点（0.3）：导航栏上有标题，封面偏亮时白字要看得清 */}
      <Rectangle fill={{ colors: ["rgba(0,0,0,0.3)", "rgba(0,0,0,0.88)"], startPoint: "top", endPoint: "bottom" }} />
    </ZStack>
  );
}

/**
 * 一排小胶囊（获取 / 预览 / 磁链…）的外观：图标 + 小字，半透明白底。
 * active 用蓝色强调；tint 直接指定字和图标的颜色（评分获取失败时用红色）。
 */
export function PillLabel({
  icon,
  text,
  active = false,
  tint,
}: {
  icon?: string;
  text: string;
  active?: boolean;
  tint?: Color;
}) {
  const textColor: Color = tint ?? (active ? LINK : INK.strong);
  const iconColor: Color = tint ?? (active ? LINK : INK.icon);
  return (
    <HStack spacing={4} padding={{ horizontal: 12, vertical: 7 }} background={{ style: active ? "rgba(10,132,255,0.26)" : GLASS, shape: "capsule" }}>
      {icon ? <Image systemName={icon} font={12} foregroundStyle={iconColor} /> : null}
      <Text font="caption" foregroundStyle={textColor} lineLimit={2} multilineTextAlignment="leading">
        {text}
      </Text>
    </HStack>
  );
}

/**
 * 分段选择：一条半透明白的胶囊，选中的那一段是白底黑字。代替系统的分段控件——
 * 它在深色底上是一块灰，和整页的样子对不上。
 * 每段的宽度按总宽算死（Button 的 label 里写弹性宽度在真机上不撑开）；width 默认是整条内容列，
 * 两个分段并排时自己传。
 */
export function Segmented<K extends string>({
  items,
  selected,
  onSelect,
  width = columnWidth(),
}: {
  items: { key: K; label: string }[];
  selected: K;
  onSelect: (key: K) => void;
  width?: number;
}) {
  const inset = 3;
  const gap = 2;
  const segment = Math.floor((width - inset * 2 - gap * (items.length - 1)) / items.length);
  return (
    <HStack spacing={gap} padding={inset} frame={{ width }} background={{ style: GLASS, shape: "capsule" }}>
      {items.map((item) => {
        const on = item.key === selected;
        return (
          // 只在选中项变了才回调：系统分段控件就是这样，首页「重复点已选中的分区」不该把搜索结果清掉
          <Button key={item.key} buttonStyle="plain" action={() => (on ? undefined : onSelect(item.key))}>
            {/* contentShape：没选中的段没有背景，plain 按钮的点击区只有字形那么大，不加的话点在字旁边没反应 */}
            <Text
              font="subheadline"
              fontWeight={on ? "semibold" : "regular"}
              foregroundStyle={on ? "black" : INK.body}
              lineLimit={1}
              frame={{ width: segment, height: 32 }}
              contentShape="rect"
              background={on ? { style: "white", shape: "capsule" } : undefined}
            >
              {item.label}
            </Text>
          </Button>
        );
      })}
    </HStack>
  );
}
