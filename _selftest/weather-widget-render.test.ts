// 离线「画一遍」自测（Node 里跑，不碰 Scripting 的原生 API，也不联网）：天气小组件的画面层。
//   npx -y -p tsx tsx _selftest/weather-widget-render.test.ts
//   类型检查：看仓库根的 tsconfig.json（只管脚本目录）；自测文件自己更严的那份 tsconfig 在作者本地，没放进仓库
//
// 其余三份自测管的是数据；画面层（widget/*.tsx、pages/*.tsx）以前零覆盖。这里借一个假的 `scripting`（见 weather-widget-render.stub.ts）
// 把它们真的跑一遍：每个视图只是个带名字的节点，所以条件分支走没走对、传的参数对不对、卡片上到底写了什么字、
// 未来几天那一行的宽度加起来有没有超出内容区，都能查出来。
// 查不出来的：颜色好不好看、字有没有被截断、真实的行高、系统怎么摆——这些只能上真机。

import "./weather-widget-render.stub";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEMO_ALERTS } from "../天气小组件/core/alerts";
import type { AlertState } from "../天气小组件/core/alertState";
import { BUILTIN_HOST, OFFICIAL_HOST } from "../天气小组件/core/caiyun";
import { adaptCaiyun } from "../天气小组件/core/caiyunWeather";
import { defaultSource } from "../天气小组件/core/dataSource";
import { defaultDisplay, sameDisplay, type Display } from "../天气小组件/core/display";
import { FetchError, describeFailure } from "../天气小组件/core/failure";
import type { Coord } from "../天气小组件/core/geo";
import { ALERT_BADGE_RATIO, ALERT_GLYPH_RATIO, layoutVariant, metricsFor } from "../天气小组件/core/layout";
import type { Loaded } from "../天气小组件/core/load";
import { ALERT_BADGE, AQI_COLOR, BAR_FILL, BAR_TRACK, TEXT_PRIMARY } from "../天气小组件/core/palette";
import { LARGE_DAYS, NO_DATA, NO_LOCATION, present, type Card, type Content } from "../天气小组件/core/present";
import { AlertsSection } from "../天气小组件/pages/AlertsSection";
import { AirSection, DetailSection, LifeSection, SummarySection, WeekSection } from "../天气小组件/pages/DetailSections";
import { DisplaySection } from "../天气小组件/pages/DisplaySection";
import { LoadingCard, PreviewCard } from "../天气小组件/pages/Preview";
import { SourceSection } from "../天气小组件/pages/SourceSection";
import { bottomKind } from "../天气小组件/widget/bodies";
import { WidgetView } from "../天气小组件/widget/view";

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

// ---------------------------------------------------------------- 把 JSX 展开成一棵普通的树

type El = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type Node = { type: string; props: Record<string, unknown>; children: Array<Node | string> };

function isEl(value: unknown): value is El {
  return typeof value === "object" && value !== null && "type" in value && "props" in value && "children" in value && !Array.isArray(value);
}

function isNode(value: unknown): value is Node {
  return isEl(value) && typeof value.type === "string";
}

/** 展开成节点列表：函数组件现场调用，Fragment 拆开，空的（null / undefined / false）丢掉，数字当文字 */
function expand(value: unknown): Array<Node | string> {
  if (value === null || value === undefined || typeof value === "boolean") return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(expand);
  if (!isEl(value)) throw new Error("不认识的节点：" + JSON.stringify(value).slice(0, 80));
  if (typeof value.type === "function") return expand((value.type as (props: unknown) => unknown)({ ...value.props, children: value.children }));
  if (value.type === "Fragment") return value.children.flatMap(expand);
  const props: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(value.props)) {
    // header / footer / label 这类传进来的视图也展开
    props[key] = isEl(prop) ? expand(prop)[0] : prop;
  }
  return [{ type: String(value.type), props, children: value.children.flatMap(expand) }];
}

function render(element: unknown): Node {
  const nodes = expand(element);
  if (nodes.length !== 1 || typeof nodes[0] === "string") throw new Error("根上应当正好一个视图，实际 " + nodes.length);
  return nodes[0];
}

function walk(node: Node | string, visit: (node: Node) => void): void {
  if (typeof node === "string") return;
  visit(node);
  for (const child of node.children) walk(child, visit);
  for (const prop of Object.values(node.props)) if (isNode(prop)) walk(prop, visit);
}

function textOf(node: Node | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

function find(root: Node, test: (node: Node) => boolean): Node[] {
  const out: Node[] = [];
  walk(root, (node) => {
    if (test(node)) out.push(node);
  });
  return out;
}

/** 树里所有 Text 的文字，按出现的先后 */
function texts(root: Node): string[] {
  return find(root, (node) => node.type === "Text").map(textOf);
}

/** 树里所有 SF Symbols 的名字（Image 的 systemName、Label 的 systemImage） */
function symbols(root: Node): string[] {
  const out: string[] = [];
  walk(root, (node) => {
    if (node.type === "Image" && typeof node.props.systemName === "string") out.push(node.props.systemName);
    if (node.type === "Label" && typeof node.props.systemImage === "string") out.push(node.props.systemImage);
  });
  return out;
}

/** `needles` 是不是按这个先后顺序（中间可以隔着别的）都出现在 `haystack` 里 */
function inOrder(haystack: string[], needles: string[]): boolean {
  let at = 0;
  for (const needle of needles) {
    const found = haystack.indexOf(needle, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

type Frame = { width?: number; height?: number };
const frameOf = (node: Node): Frame => (typeof node.props.frame === "object" && node.props.frame !== null ? (node.props.frame as Frame) : {});

// ---------------------------------------------------------------- 数据：真实样例（北京，晚上九点多）

const HERE = __dirname;
const SAMPLE = JSON.parse(readFileSync(join(HERE, "weather-widget-golden", "caiyun_weather_sample.json"), "utf8")) as Record<string, unknown>;
const BEIJING: Coord = { latitude: 39.9, longitude: 116.4 };
const NOW = (SAMPLE.server_time as number) * 1000;

const adapted = adaptCaiyun(SAMPLE, { coord: BEIJING, now: NOW, previous: null });
if (adapted === null) throw new Error("样例应该读得出来");

const loaded: Extract<Loaded, { kind: "ok" }> = { kind: "ok", forecast: adapted.forecast, extras: adapted.extras, alerts: adapted.alerts, provider: "caiyun", fetchedAt: NOW, place: "北京市", source: "live", refreshFailed: false, failure: null };
const plainLoaded: Loaded = { ...loaded, extras: null, alerts: null, provider: "openmeteo" };
const sampleExtras = adapted.extras;
const demo: AlertState = { kind: "ok", items: DEMO_ALERTS.slice(), fetchedAt: NOW, failure: null };

function card(content: Content): Card {
  if (content.kind !== "weather") throw new Error("应该是天气卡");
  return content;
}

const c = {
  compact: card(present(loaded, NOW, "compact")),
  compactAlert: card(present(loaded, NOW, "compact", demo)),
  compactPlain: card(present(plainLoaded, NOW, "compact")),
  compactStored: card(present({ ...loaded, source: "stored" }, NOW, "compact")),
  compactFailed: card(present({ ...loaded, refreshFailed: true, failure: describeFailure(new FetchError("server")) }, NOW, "compact")),
  compactRain: card(present({ ...loaded, extras: { ...adapted.extras, rainNote: "30 分钟后开始下雨" } }, NOW, "compact")),
  large: card(present(loaded, NOW, "large")),
  largeAlert: card(present(loaded, NOW, "large", demo)),
  largePlain: card(present(plainLoaded, NOW, "large")),
  largeFailed: card(present({ ...loaded, refreshFailed: true, failure: describeFailure(new FetchError("server")) }, NOW, "large")),
};

const TAP = "scripting://run/%E5%A4%A9%E6%B0%94";
const SIZES: Record<string, [string, number, number]> = {
  small: ["systemSmall", 158, 158],
  medium: ["systemMedium", 338, 158],
  large: ["systemLarge", 338, 354],
  circular: ["accessoryCircular", 76, 76],
  rectangular: ["accessoryRectangular", 172, 76],
  inline: ["accessoryInline", 234, 26],
};

function view(size: keyof typeof SIZES, content: Content, override?: { width: number; height: number }): Node {
  const [family, width, height] = SIZES[size];
  return render(WidgetView({ family, width: override?.width ?? width, height: override?.height ?? height, content, tapURL: TAP }));
}

const FORBIDDEN_ON_CARD = /更新|Open-Meteo|彩云|天气数据/;

function main(): void {
  // ---------------------------------------------------------------- 每个尺寸、每种内容都能画出来
  section("每个尺寸 × 每种内容：都画得出来，不抛错");
  {
    const contents: Array<[string, Content]> = [
      ["彩云、有详细数据", c.compact], ["彩云、有预警", c.compactAlert], ["备用来源", c.compactPlain], ["上次定位处", c.compactStored], ["没刷新成功", c.compactFailed],
      ["下雨的说明", c.compactRain], ["大号：详细", c.large], ["大号：有预警", c.largeAlert], ["大号：备用来源", c.largePlain], ["大号：没刷新成功", c.largeFailed],
      ["还没有位置", NO_LOCATION], ["暂时取不到", NO_DATA],
    ];
    let drawn = 0;
    let problems = "";
    for (const size of Object.keys(SIZES)) {
      for (const [name, content] of contents) {
        try {
          const root = view(size, content);
          drawn++;
          if (texts(root).length === 0 && symbols(root).length === 0) problems += `${size}/${name}：画出来是空的；`;
        } catch (error) {
          problems += `${size}/${name}：${String(error).slice(0, 60)}；`;
        }
      }
    }
    check(`6 个尺寸 × ${contents.length} 种内容共 ${drawn} 张都画得出来、不是空的${problems === "" ? "" : "：" + problems}`, problems === "" && drawn === 6 * contents.length);
    check("超大（iPad 的横向、iOS 27 的竖向）借中号 / 大号画，不抛错", (() => {
      const wide = render(WidgetView({ family: "systemExtraLarge", width: 716, height: 346, content: c.compact, tapURL: TAP }));
      const tall = render(WidgetView({ family: "systemExtraLarge", width: 400, height: 700, content: c.large, tapURL: TAP }));
      return texts(wide).includes("北京市") && texts(tall).includes("北京市");
    })());
    check("读不到实际尺寸（0、NaN）也画得出来，不抛错", [[0, 0], [Number.NaN, Number.NaN], [-5, 10]].every(([width, height]) => texts(render(WidgetView({ family: "systemMedium", width, height, content: c.compact, tapURL: undefined }))).length > 0));
  }

  // ---------------------------------------------------------------- 卡片上不写更新时间和署名
  section("卡片底部：不写更新时间，不写数据署名");
  {
    let bad = "";
    for (const size of Object.keys(SIZES)) {
      for (const content of [c.compact, c.compactAlert, c.compactPlain, c.compactStored, c.compactFailed, c.compactRain, c.large, c.largeAlert, c.largePlain, c.largeFailed, NO_DATA, NO_LOCATION]) {
        const hit = texts(view(size, content)).find((text) => FORBIDDEN_ON_CARD.test(text));
        if (hit !== undefined) bad += `${size}：「${hit}」；`;
      }
    }
    check("所有尺寸、所有内容里，没有「更新」「Open-Meteo」「彩云」「天气数据」" + (bad === "" ? "" : "：" + bad), bad === "");
    check("也没有作者 / 频道（Telegram、t.me）", ["small", "medium", "large"].every((size) => !texts(view(size, c.large)).some((text) => /Telegram|t\.me|@/.test(text))));
  }

  // ---------------------------------------------------------------- 小号
  section("小号");
  {
    const root = view("small", c.compact);
    const t = texts(root);
    check("地名、气温、天气、最高最低都在", t.includes("北京市") && t.includes(c.compact.temperature) && t.includes(c.compact.condition.text) && t.includes(c.compact.range));
    check("没有逐小时那一排、没有详细数据", !t.includes("现在") && !t.some((text) => text === "体感" || text === "湿度"));
    const withAlert = texts(view("small", c.compactAlert));
    check("有预警：最高最低那一行换成预警徽章（名字 +1）", !withAlert.includes(c.compactAlert.range) && withAlert.includes("示例·暴雨橙色预警") && withAlert.includes("+1"));
    check("徽章里的图案是这条预警的类型图案", c.compactAlert.alert !== null && symbols(view("small", c.compactAlert)).includes(c.compactAlert.alert.symbol));
    check("跟着定位走：地名前有定位箭头", symbols(root).includes("location.fill"));
    check("点一下打开本脚本：根上挂着 widgetURL", root.props.widgetURL === TAP);
    check("根上锁成深色（多色图标里的云才是白的，不跟着系统亮暗走）", (root.props.environments as { colorScheme?: string } | undefined)?.colorScheme === "dark");
    check("固定城市不画定位箭头", !symbols(view("small", card(present({ ...loaded, source: "fixed" }, NOW, "compact")))).includes("location.fill"));
    check("只有一条预警：徽章后面不带「+N」", (() => {
      const one = card(present(loaded, NOW, "compact", { kind: "ok", items: DEMO_ALERTS.slice(0, 1), fetchedAt: NOW, failure: null }));
      const text = texts(view("small", one));
      return one.alert !== null && one.alert.more === 0 && text.includes(one.alert.label) && !text.some((item) => item.startsWith("+"));
    })());
    check("根视图是满尺寸（背景才能铺到边），背景用 widgetBackground", frameOf(root).width === 158 && frameOf(root).height === 158 && typeof root.props.widgetBackground === "object" && root.props.widgetBackground !== null);
  }

  // ---------------------------------------------------------------- 中号
  section("中号");
  {
    const root = view("medium", c.compact);
    const t = texts(root);
    const stats = c.compact.detail === null ? [] : c.compact.detail.stats.flatMap((stat) => [stat.label, stat.value]);
    check("左栏：地名、气温、最高最低；右栏：天气、降水概率", t.includes("北京市") && t.includes(c.compact.temperature) && t.includes(c.compact.range) && t.includes(c.compact.condition.text) && (c.compact.rainShort === null || t.includes(c.compact.rainShort)));
    check("逐小时 5 格，第一格是「现在」", c.compact.slots.length === 5 && inOrder(t, c.compact.slots.map((slot) => slot.label)) && t[t.indexOf("现在")] === "现在");
    check("底部一行：体感、湿度、风、空气（标签和值依次写出来）", stats.length === 8 && inOrder(t, stats) && t.lastIndexOf(stats[0]) > t.indexOf(c.compact.slots[4].label));
    check("空气质量前面有个分级的小圆点（Circle）：填的是这一级的颜色，外面一圈白边", (() => {
      const dots = find(root, (node) => node.type === "Circle");
      return dots.length === 2 && dots[0].props.fill === AQI_COLOR[0] && typeof dots[1].props.stroke === "object";
    })());
    check("逐小时一排恰好 5 格", (() => {
      const strips = find(root, (node) => node.type === "HStack" && node.props.alignment === "top" && node.props.spacing === 0);
      return strips.length === 1 && strips[0].children.length === 5;
    })());
    const outer = (node: Node) => find(node, (n) => n.type === "VStack" && n.props.alignment === "leading" && n.children.some((child) => typeof child !== "string" && child.type === "HStack" && child.props.alignment === "top"))[0];
    check("有底部那一行：两栏靠上（顶上不放 Spacer）、那一行靠下", (() => {
      const first = outer(root).children[0];
      return typeof first !== "string" && first.type === "HStack";
    })());
    check("没有底部那一行（备用来源）：两栏摆在正中间（顶上放个 Spacer）", (() => {
      const first = outer(view("medium", c.compactPlain)).children[0];
      return typeof first !== "string" && first.type === "Spacer";
    })());
    const rain = texts(view("medium", c.compactRain));
    check("未来两小时有雨：底部写那句话，不写四项数据", rain.includes("30 分钟后开始下雨") && !rain.includes("体感"));
    const failed = texts(view("medium", c.compactFailed));
    check("没刷新成功：底部写短的那句，不写四项数据", failed.includes("没刷新成功，显示旧数据") && !failed.includes("体感"));
    const stored = texts(view("medium", c.compactStored));
    check("上次定位处：底部写「上次定位处的天气」", stored.includes("上次定位处的天气") && !stored.includes("体感"));
    check("提醒比下雨说明优先", (() => {
      const both = card(present({ ...loaded, source: "stored", extras: { ...sampleExtras, rainNote: "30 分钟后开始下雨" } }, NOW, "compact"));
      const text = texts(view("medium", both));
      return text.includes("上次定位处的天气") && !text.includes("30 分钟后开始下雨");
    })());
    const plain = texts(view("medium", c.compactPlain));
    check("备用来源：没有底部那一行（不留空位也不写别的）", !plain.includes("体感") && !plain.includes("湿度") && plain.includes("北京市"));
    const alert = texts(view("medium", c.compactAlert));
    check("有预警：天气文字后面是预警徽章，降水概率让位", alert.includes("示例·暴雨橙色预警") && alert.includes("+1") && (c.compactAlert.rainShort === null || !alert.includes(c.compactAlert.rainShort)));
    check("中号的左栏宽度来自版式（metricsFor），右栏占满剩下的", find(root, (node) => node.type === "VStack" && frameOf(node).width === metricsFor("medium", 338, 158).leftWidth).length === 1);
  }

  // ---------------------------------------------------------------- 大号
  section("大号");
  {
    const root = view("large", c.large);
    const t = texts(root);
    const m = metricsFor("large", 338, 354);
    const days = c.large.detail === null ? [] : c.large.detail.days;
    check("逐小时 6 格、一排", c.large.slots.length === 6 && inOrder(t, c.large.slots.map((slot) => slot.label)));
    check(`明天起的 ${LARGE_DAYS} 天：星期、最低、最高都写出来；多出来的天不画`, days.length === LARGE_DAYS && inOrder(t, days.flatMap((day) => [day.weekday, day.low, day.high])) && !t.includes("周六"));
    check("每一天一行，行高是版式里的 dayRow", find(root, (node) => node.type === "HStack" && frameOf(node).height === m.dayRow).length === LARGE_DAYS);
    check("逐小时一排恰好 6 格；备用来源两排各 5 格", (() => {
      const strips = (node: Node) => find(node, (n) => n.type === "HStack" && n.props.alignment === "top" && n.props.spacing === 0);
      const detailed = strips(root);
      const plain = strips(view("large", c.largePlain));
      return detailed.length === 1 && detailed[0].children.length === 6 && plain.length === 2 && plain.every((strip) => strip.children.length === 5);
    })());
    check("底部一行详细数据在未来几天的后面", c.large.detail !== null && t.lastIndexOf("体感") > t.lastIndexOf(days[LARGE_DAYS - 1].high));
    check("大号的天气、最高最低、气温、地名都在", t.includes("北京市") && t.includes(c.large.temperature) && t.includes(c.large.range) && t.includes(c.large.condition.text));
    const alert = texts(view("large", c.largeAlert));
    check("有预警：徽章放在地名那一行右边（写在地名后面）", alert.indexOf("示例·暴雨橙色预警") > alert.indexOf("北京市") && alert.includes("+1"));
    const plain = view("large", c.largePlain);
    const plainTexts = texts(plain);
    check("备用来源：老样子，两排逐小时共 10 格，没有未来几天和详细数据", c.largePlain.slots.length === 10 && inOrder(plainTexts, c.largePlain.slots.map((slot) => slot.label)) && !plainTexts.some((text) => /^(明天|后天|周.)$/.test(text)) && !plainTexts.includes("体感"));
    check("备用来源：右栏的气温和最高最低按内容定宽、不折行", find(plain, (node) => node.type === "VStack" && typeof node.props.fixedSize === "object").length === 1);
    check("备用来源：有降水概率时写在天气下面", c.largePlain.rain === null || plainTexts.includes(c.largePlain.rain));
    const failed = texts(view("large", c.largeFailed));
    check("没刷新成功：底部写完整的那句", failed.includes("刚才没刷新成功，显示的是之前的数据") && !failed.includes("体感"));
  }

  // ---------------------------------------------------------------- 未来几天那一行的宽度
  section("未来几天：每一行各列的宽度加起来，放得进内容区");
  {
    let worst = Infinity;
    let problems = "";
    const sizes: Array<[number, number]> = [[338, 354], [321, 324], [364, 382], [300, 300], [676, 708]];
    for (const [width, height] of sizes) {
      const m = metricsFor("large", width, height);
      const root = view("large", c.large, { width, height });
      const rows = find(root, (node) => node.type === "HStack" && frameOf(node).height === m.dayRow);
      if (rows.length !== LARGE_DAYS) problems += `${width}×${height}：只有 ${rows.length} 行；`;
      for (const row of rows) {
        const spacing = typeof row.props.spacing === "number" ? row.props.spacing : 0;
        const cells = row.children.filter((child): child is Node => typeof child !== "string");
        const widths = cells.map((cell) => frameOf(cell).width ?? 0);
        const total = widths.reduce((sum, value) => sum + value, 0) + spacing * (cells.length - 1);
        worst = Math.min(worst, m.contentWidth - total);
        if (cells.length !== 6 || total > m.contentWidth + 0.01) problems += `${width}×${height}：这一行 ${total.toFixed(1)} > ${m.contentWidth}；`;
        // 温度条：白色那一段落在轨道里面，不冲出去
        const bar = cells[4];
        const barWidth = frameOf(bar).width ?? 0;
        const fill = bar.children.filter((child): child is Node => typeof child !== "string")[1];
        const offset = (fill.props.offset as { x: number } | undefined)?.x ?? 0;
        const length = frameOf(fill).width ?? 0;
        if (barWidth < m.bar * 4 || offset < -0.01 || offset + length > barWidth + 0.01 || length <= 0) problems += `${width}×${height}：温度条 ${offset.toFixed(1)}+${length.toFixed(1)} / ${barWidth.toFixed(1)}；`;
      }
    }
    check("温度条：底是半透明白的轨道（BAR_TRACK），这一天那一段是亮白（BAR_FILL）", (() => {
      const bars = find(view("large", c.large), (node) => node.type === "Capsule");
      return bars.length === 2 * LARGE_DAYS && bars.every((capsule, index) => capsule.props.fill === (index % 2 === 0 ? BAR_TRACK : BAR_FILL));
    })());
    check(`5 种尺寸（参考、小屏、大屏、很小、超大）上每一行都放得下，温度条不冲出轨道（最紧的一行还剩 ${worst.toFixed(1)}pt）${problems === "" ? "" : "：" + problems}`, problems === "" && worst >= 0);
  }

  // ---------------------------------------------------------------- 预警徽章
  section("预警徽章：方块、底色、图案");
  {
    const root = view("medium", c.compactAlert);
    const squares = find(root, (node) => node.type === "ZStack" && node.children.filter((child) => typeof child !== "string" && child.type === "RoundedRectangle").length === 2);
    check("方块只有一个，是正方形，边长是旁边字号的 ALERT_BADGE_RATIO 倍", squares.length === 1 && frameOf(squares[0]).width === frameOf(squares[0]).height && frameOf(squares[0]).width === metricsFor("medium", 338, 158).rain * ALERT_BADGE_RATIO);
    const square = squares[0];
    const [fillShape, rimShape] = find(square, (node) => node.type === "RoundedRectangle");
    const alert = c.compactAlert.alert;
    check("底色是这一级的渐变（上浅下深），外面一圈细描边", alert !== null && (fillShape.props.fill as { colors: string[] }).colors.join() === [ALERT_BADGE[alert.level].top, ALERT_BADGE[alert.level].bottom].join() && typeof rimShape.props.stroke === "object");
    const glyph = find(square, (node) => node.type === "Image")[0];
    check("图案的大小是边长的 ALERT_GLYPH_RATIO 倍，颜色是这一级配的（橙色用深色图案）", alert !== null && glyph.props.font === (frameOf(square).width ?? 0) * ALERT_GLYPH_RATIO && glyph.props.foregroundStyle === ALERT_BADGE[alert.level].glyph);
    check("圆角是边长的一定比例（不是直角、不是圆）", (() => {
      const radius = fillShape.props.cornerRadius;
      const side = frameOf(square).width ?? 0;
      return typeof radius === "number" && radius > 0 && radius < side / 2;
    })());
    check("红色预警用白色图案，蓝 / 黄 / 橙用深色图案", ALERT_BADGE.red.glyph === "#FFFFFF" && [ALERT_BADGE.blue, ALERT_BADGE.yellow, ALERT_BADGE.orange].every((style) => style.glyph !== "#FFFFFF"));
  }

  // ---------------------------------------------------------------- 锁屏
  section("锁屏三种");
  {
    const circular = view("circular", c.compact);
    check("圆形：天气图标和气温", symbols(circular).includes(c.compact.condition.symbol) && texts(circular).includes(c.compact.temperature));
    const circularAlert = view("circular", c.compactAlert);
    check("圆形、有预警：天气图标换成三角（圆形里写不下字），气温还在", symbols(circularAlert).includes("exclamationmark.triangle.fill") && !symbols(circularAlert).includes(c.compact.condition.symbol) && texts(circularAlert).includes(c.compact.temperature));
    const rect = view("rectangular", c.compact);
    check("矩形：地名、气温和天气、最高最低", texts(rect).includes("北京市") && texts(rect).includes(c.compact.temperature + " " + c.compact.condition.text) && texts(rect).includes(c.compact.range));
    const rectAlert = texts(view("rectangular", c.compactAlert));
    check("矩形、有预警：第三行换成预警（带 +1）", rectAlert.includes("示例·暴雨橙色预警 +1") && !rectAlert.includes(c.compact.range));
    const inline = view("inline", c.compact);
    check("单行：「天气 气温 最低~最高」，前面带图标", inline.type === "Label" && inline.props.title === c.compact.inline && inline.props.systemImage === c.compact.condition.symbol);
    const inlineAlert = view("inline", c.compactAlert);
    check("单行、有预警：换成预警短名，图标是这条预警的图案", inlineAlert.props.title === "示例·暴雨橙色预警 +1" && c.compactAlert.alert !== null && inlineAlert.props.systemImage === c.compactAlert.alert.symbol);
    check("锁屏三种都挂着点一下打开本脚本", [circular, rect, inline].every((root) => root.props.widgetURL === TAP || find(root, (node) => node.props.widgetURL === TAP).length > 0));
    check("没有数据的锁屏：写标题（单行 / 矩形）或图标（圆形）", texts(view("inline", NO_DATA)).includes(NO_DATA.title) && symbols(view("circular", NO_DATA)).includes(NO_DATA.symbol) && texts(view("rectangular", NO_LOCATION)).includes(NO_LOCATION.title));
  }

  // ---------------------------------------------------------------- 没有数据
  section("没有位置 / 没有数据");
  {
    for (const [name, content] of [["没有位置", NO_LOCATION], ["暂时取不到", NO_DATA]] as const) {
      for (const size of ["small", "medium", "large"] as const) {
        const t = texts(view(size, content));
        check(`${name}（${size}）：标题和两句人话都在，有图标`, t.includes(content.title) && content.lines.every((line) => t.includes(line)) && symbols(view(size, content)).includes(content.symbol));
      }
    }
  }

  // ---------------------------------------------------------------- 显示样式
  section("显示样式：中号的三处、大号的底部，选了什么就画什么");
  {
    const d = (display: Partial<Display>): Display => ({ ...defaultDisplay(), ...display });
    const cardWith = (display: Partial<Display>, size: "compact" | "large" = "compact", from: Loaded = loaded, alerts?: AlertState): Card => card(present(from, NOW, size, alerts, d(display)));
    const variantOf = (content: Card) => layoutVariant("medium", content.display);
    const mediumM = (content: Card) => metricsFor("medium", 338, 158, variantOf(content));

    // 每一种组合、每一种情况、每一个尺寸都画得出来
    let drawn = 0;
    let problems = "";
    const situations: Array<[string, Loaded, AlertState | undefined]> = [
      ["默认", loaded, undefined],
      ["有预警", loaded, demo],
      ["上次定位处", { ...loaded, source: "stored" }, undefined],
      ["备用来源", plainLoaded, undefined],
    ];
    for (const strip of ["hourly", "daily"] as const) {
      for (const top of ["condition", "windHumidity"] as const) {
        for (const bottom of ["stats", "headline", "none"] as const) {
          for (const [name, from, alerts] of situations) {
            for (const size of ["compact", "large"] as const) {
              const content = present(from, NOW, size, alerts, { strip, top, bottom, headline: "auto" });
              for (const family of size === "compact" ? ["small", "medium", "circular", "rectangular", "inline"] : ["large"]) {
                try {
                  const root = view(family, content);
                  drawn++;
                  if (texts(root).length === 0 && symbols(root).length === 0) problems += `${strip}/${top}/${bottom}/${name}/${family}：画出来是空的；`;
                } catch (error) {
                  problems += `${strip}/${top}/${bottom}/${name}/${family}：${String(error).slice(0, 60)}；`;
                }
              }
            }
          }
        }
      }
    }
    check(`12 种组合 × 4 种情况 × 6 个尺寸共 ${drawn} 张都画得出来、不是空的${problems === "" ? "" : "：" + problems}`, problems === "" && drawn === 12 * 4 * 6);

    // 中间那一排选了「未来几天」
    const dailyCard = cardWith({ strip: "daily" });
    const daily = view("medium", dailyCard);
    const dailyTexts = texts(daily);
    const strips = (root: Node) => find(root, (node) => node.type === "HStack" && node.props.alignment === "top" && node.props.spacing === 0);
    check("中间一排选「未来几天」：每列的星期、最高、最低依次写出来，明天、后天、周四、周五、周六", dailyCard.dayColumns.length === 5 && inOrder(dailyTexts, dailyCard.dayColumns.flatMap((column) => [column.label, column.high, column.low])) && dailyCard.dayColumns.map((column) => column.label).join() === "明天,后天,周四,周五,周六");
    check("选了「未来几天」就没有逐小时那一排（没有「现在」）", !dailyTexts.includes("现在") && !dailyTexts.some((text) => /^\d+时$/.test(text)));
    check("「未来几天」那一排：一排 5 列，每列四行（星期、图标、最高、最低）", (() => {
      const found = strips(daily);
      if (found.length !== 1 || found[0].children.length !== 5) return false;
      return found[0].children.every((column) => typeof column !== "string" && column.type === "VStack" && column.children.length === 4);
    })());
    check("「未来几天」里最高的字比最低的粗、亮（最低是淡的次要文字）", (() => {
      const stripNode = strips(daily)[0];
      const highs = find(stripNode, (node) => node.type === "Text" && node.props.fontWeight === "semibold" && dailyCard.dayColumns.some((column) => column.high === textOf(node)));
      const lows = find(stripNode, (node) => node.type === "Text" && node.props.fontWeight === undefined && dailyCard.dayColumns.some((column) => column.low === textOf(node)));
      return highs.length === 5 && lows.length === 5 && highs.every((node) => node.props.foregroundStyle === TEXT_PRIMARY) && lows.every((node) => node.props.foregroundStyle !== TEXT_PRIMARY);
    })());

    // 右上那一行选了「风和湿度」
    const windyCard = cardWith({ top: "windHumidity" });
    const windy = view("medium", windyCard);
    const windyTexts = texts(windy);
    const windyM = mediumM(windyCard);
    check("右上选「风和湿度」：写「西南风 1级」「湿度」「25%」，不写天气文字和降水概率", windyTexts.includes("西南风 1级") && windyTexts.includes("湿度") && windyTexts.includes("25%") && !windyTexts.includes(windyCard.condition.text) && (windyCard.rainShort === null || !windyTexts.includes(windyCard.rainShort)));
    check("右上选「风和湿度」：天气图标挪到气温旁边（左栏里，字号是 bigIcon）；右上那一行没有图标", (() => {
      const bigIcons = find(windy, (node) => node.type === "Image" && node.props.font === windyM.bigIcon && node.props.systemName === windyCard.condition.symbol);
      const iconsInTopLine = find(windy, (node) => node.type === "Image" && node.props.font === windyM.icon && node.props.systemName === windyCard.condition.symbol);
      return bigIcons.length === 1 && iconsInTopLine.length === 0;
    })());
    check("默认的右上那一行：天气图标、天气、降水概率；气温旁边没有大图标", (() => {
      const standard = view("medium", c.compact);
      const m = metricsFor("medium", 338, 158);
      return find(standard, (node) => node.type === "Image" && node.props.font === m.bigIcon).length === 0 && texts(standard).includes(c.compact.condition.text);
    })());
    check("风是粗体白字、湿度是「淡标签 + 粗体值」", (() => {
      const wind = find(windy, (node) => node.type === "Text" && textOf(node) === "西南风 1级")[0];
      const humidity = find(windy, (node) => node.type === "Text" && textOf(node) === "25%")[0];
      const label = find(windy, (node) => node.type === "Text" && textOf(node) === "湿度")[0];
      return wind.props.fontWeight === "semibold" && wind.props.foregroundStyle === TEXT_PRIMARY && humidity.props.fontWeight === "semibold" && label.props.foregroundStyle !== TEXT_PRIMARY;
    })());
    const windyAlert = texts(view("medium", cardWith({ top: "windHumidity" }, "compact", loaded, demo)));
    const countOf = (list: string[], text: string) => list.filter((item) => item === text).length;
    check("右上选「风和湿度」时有预警：右上那一行换成预警徽章，风和湿度改写在底部（各只写一次）", windyAlert.includes("示例·暴雨橙色预警") && windyAlert.includes("+1") && countOf(windyAlert, "西南风 1级") === 1 && countOf(windyAlert, "25%") === 1 && windyAlert.includes("体感"));
    check("右上写了风和湿度、底部是几项数据：底部不再重复写风和湿度，只剩体感和空气", countOf(windyTexts, "西南风 1级") === 1 && countOf(windyTexts, "25%") === 1 && windyTexts.includes("体感") && windyTexts.includes("空气") && countOf(windyTexts, "湿度") === 1);
    check("右上写了风和湿度、底部选了「一句话」：风和湿度只在右上写一次", (() => {
      const t = texts(view("medium", cardWith({ top: "windHumidity", bottom: "headline" })));
      return countOf(t, "西南风 1级") === 1 && countOf(t, "25%") === 1 && !t.includes("体感");
    })());
    check("风和湿度只读到一项：只写那一项", (() => {
      const onlyHumidity = cardWith({ top: "windHumidity" }, "compact", { ...loaded, extras: { ...sampleExtras, wind: null } });
      const t = texts(view("medium", onlyHumidity));
      return onlyHumidity.display.top === "windHumidity" && t.includes("25%") && !t.includes("西南风 1级");
    })());

    // 底部选了「一句话」
    const headlineCard = cardWith({ bottom: "headline" });
    const headlineView = view("medium", headlineCard);
    const headlineTexts = texts(headlineView);
    check("底部选「一句话」：一句话、日出（晚上写明早的）、空气，依次写出来；没有体感、湿度那几项", inOrder(headlineTexts, ["今日多云，气温适宜", "日出", "06:45", "空气", "优 50"]) && !headlineTexts.includes("体感") && !headlineTexts.includes("湿度"));
    check("一句话是大字粗体白字，日落是小字；空气写成「标签、圆点、值」的顺序", (() => {
      const m = mediumM(headlineCard);
      const sentence = find(headlineView, (node) => node.type === "Text" && textOf(node) === "今日多云，气温适宜")[0];
      const sunTime = find(headlineView, (node) => node.type === "Text" && textOf(node) === "06:45")[0];
      const airItem = find(headlineView, (node) => node.type === "HStack" && node.children.some((child) => typeof child !== "string" && child.type === "Text" && textOf(child) === "空气"))[0];
      const kinds = airItem.children.map((child) => (typeof child === "string" ? "字符串" : child.type === "ZStack" ? "圆点" : textOf(child)));
      return sentence.props.font === m.headline && sentence.props.fontWeight === "semibold" && sunTime.props.font === m.item && kinds.join() === "空气,圆点,优 50";
    })());
    check("一句话缩得比日落和空气早（日落和空气的优先级高）", (() => {
      const sentence = find(headlineView, (node) => node.type === "Text" && textOf(node) === "今日多云，气温适宜")[0];
      const items = find(headlineView, (node) => node.type === "HStack" && typeof node.props.layoutPriority === "number" && node.props.layoutPriority > 0);
      return sentence.props.layoutPriority === 0 && sentence.props.minScaleFactor !== undefined && items.length === 2;
    })());
    check("一句话换成「明日气温变化」：写「明日气温和今天差不多」", texts(view("medium", cardWith({ bottom: "headline", headline: "change" }))).includes("明日气温和今天差不多"));
    check("自动 + 明天冷了 10.5°：写「明日平均降温 11°C」", texts(view("medium", cardWith({ bottom: "headline" }, "compact", { ...loaded, extras: { ...sampleExtras, days: sampleExtras.days.map((day, index) => (index === 1 ? { ...day, high: 5, low: 1 } : day)) } }))).includes("明日平均降温 11°C"));
    check("出了状况（用的是上次的位置）：底部写那句提醒，一句话让位", (() => {
      const stored = cardWith({ bottom: "headline" }, "compact", { ...loaded, source: "stored" });
      const t = texts(view("medium", stored));
      return t.includes("上次定位处的天气") && !t.includes("今日多云，气温适宜");
    })());
    check("一句话没有、日落和空气有：日落和空气靠右（一句话那一块不画）", (() => {
      const noSentence = cardWith({ bottom: "headline", headline: "keypoint" }, "compact", { ...loaded, extras: { ...sampleExtras, keypoint: null } });
      const t = texts(view("medium", noSentence));
      return noSentence.headline !== null && noSentence.headline.text === null && t.includes("06:45") && t.includes("优 50") && !t.includes("今日多云，气温适宜");
    })());

    // 底部选了「不显示」
    const noneCard = cardWith({ bottom: "none" });
    const noneTexts = texts(view("medium", noneCard));
    check("底部选「不显示」：没有体感、湿度、一句话，也没有日落和空气；两栏摆在正中间（顶上放个 Spacer）", !noneTexts.includes("体感") && !noneTexts.includes("空气") && !noneTexts.includes("今日多云，气温适宜") && (() => {
      const outer = find(view("medium", noneCard), (node) => node.type === "VStack" && node.props.alignment === "leading" && node.children.some((child) => typeof child !== "string" && child.type === "HStack" && child.props.alignment === "top"))[0];
      const first = outer.children[0];
      return typeof first !== "string" && first.type === "Spacer";
    })());
    check("底部选「不显示」时，出了状况的提醒还是要写（用的是旧数据，得让人知道）", texts(view("medium", cardWith({ bottom: "none" }, "compact", { ...loaded, refreshFailed: true, failure: describeFailure(new FetchError("server")) }))).includes("没刷新成功，显示旧数据"));
    check("底部选「不显示」时，未来两小时有雨的说明也不写", (() => {
      const rainy = cardWith({ bottom: "none" }, "compact", { ...loaded, extras: { ...sampleExtras, rainNote: "25 分钟后开始下雨" } });
      return !texts(view("medium", rainy)).includes("25 分钟后开始下雨");
    })());
    check("默认的底部：未来两小时有雨就写雨，没有雨写体感湿度风空气", texts(view("medium", cardWith({}, "compact", { ...loaded, extras: { ...sampleExtras, rainNote: "25 分钟后开始下雨" } }))).includes("25 分钟后开始下雨") && texts(view("medium", c.compact)).includes("体感"));

    // 选了哪套字号，就真的用哪套
    check("字号：默认、右上选「风和湿度」、底部选「不显示」用原来那套（气温 44）；选「未来几天」或「一句话」用紧凑那套（气温 40）", (() => {
      const temperatureFont = (content: Card) => find(view("medium", content), (node) => node.type === "Text" && textOf(node) === content.temperature)[0].props.font;
      const standard = metricsFor("medium", 338, 158).temp;
      const compact = metricsFor("medium", 338, 158, "compact").temp;
      return standard === 44 && compact === 40 && temperatureFont(cardWith({})) === standard && temperatureFont(cardWith({ top: "windHumidity" })) === standard && temperatureFont(cardWith({ bottom: "none" })) === standard && temperatureFont(cardWith({ strip: "daily" })) === compact && temperatureFont(cardWith({ bottom: "headline" })) === compact && temperatureFont(cardWith({ strip: "daily", bottom: "headline", top: "windHumidity" })) === compact;
    })());
    check("备用来源选了「未来几天」「一句话」：按默认的样子、用原来那套字号画", (() => {
      const backup = cardWith({ strip: "daily", bottom: "headline", top: "windHumidity" }, "compact", plainLoaded);
      const font = find(view("medium", backup), (node) => node.type === "Text" && textOf(node) === backup.temperature)[0].props.font;
      return font === metricsFor("medium", 338, 158).temp && layoutVariant("medium", backup.display) === "standard";
    })());
    check("App 里的卡片预览也用同一套：选了「未来几天」，预览里气温是紧凑那套的字号", (() => {
      const width = 358;
      const height = Math.round(width * (158 / 338));
      const expected = metricsFor("medium", width, height, "compact").temp;
      const preview = render(PreviewCard({ content: dailyCard, width }));
      return find(preview, (node) => node.type === "Text" && textOf(node) === dailyCard.temperature)[0].props.font === expected && expected !== metricsFor("medium", width, height).temp;
    })());

    // 大号的底部
    const largeHeadline = cardWith({ bottom: "headline" }, "large");
    const largeTexts = texts(view("large", largeHeadline));
    check("大号底部选「一句话」：一句话、日出、空气写在最下面一行，没有体感湿度那几项；字号是 15", inOrder(largeTexts, ["今日多云，气温适宜", "日出", "06:45", "空气", "优 50"]) && !largeTexts.includes("体感") && find(view("large", largeHeadline), (node) => node.type === "Text" && textOf(node) === "今日多云，气温适宜")[0].props.font === metricsFor("large", 338, 354).headline);
    check("大号的未来几天、逐小时不受影响（选了「一句话」照样有 4 行、6 格）", (() => {
      const root = view("large", largeHeadline);
      const m = metricsFor("large", 338, 354);
      return find(root, (node) => node.type === "HStack" && frameOf(node).height === m.dayRow).length === LARGE_DAYS && strips(root).length === 1 && strips(root)[0].children.length === 6;
    })());
    check("大号底部选「不显示」：最下面没有那一行；出了状况的提醒还在", (() => {
      const none = texts(view("large", cardWith({ bottom: "none" }, "large")));
      const failed = texts(view("large", cardWith({ bottom: "none" }, "large", { ...loaded, refreshFailed: true, failure: describeFailure(new FetchError("server")) })));
      return !none.includes("体感") && !none.includes("空气") && failed.includes("刚才没刷新成功，显示的是之前的数据");
    })());
    check("大号没有中间一排和右上那一行可换：选了也不变", (() => {
      const wide = view("large", cardWith({ strip: "daily", top: "windHumidity" }, "large"));
      const t = texts(wide);
      return t.includes("现在") && t.includes(c.large.condition.text);
    })());

    check("底部几项平分整行（每一项撑满平分）；一句话那一行里的日落和空气只占自己的宽度，不撑开", (() => {
      const labels = ["体感", "湿度", "风", "空气"];
      const hasLabel = (node: Node, wanted: string[]) => node.type === "HStack" && node.children.some((child) => typeof child !== "string" && child.type === "Text" && wanted.includes(textOf(child)));
      const maxWidthOf = (node: Node) => (node.props.frame as { maxWidth?: string } | undefined)?.maxWidth;
      const statItems = find(view("medium", cardWith({})), (node) => hasLabel(node, labels));
      const headlineItems = find(view("medium", cardWith({ bottom: "headline" })), (node) => hasLabel(node, ["空气", "日出"]));
      return statItems.length === 4 && statItems.every((node) => maxWidthOf(node) === "infinity") && headlineItems.length === 2 && headlineItems.every((node) => node.props.frame === undefined);
    })());
    check("右上写了风和湿度，而底部本来只有风和湿度可写（体感、空气读不到）：底部什么也不剩，那一行不画，两栏摆在正中间", (() => {
      const only = cardWith({ top: "windHumidity" }, "compact", { ...loaded, extras: { ...sampleExtras, apparent: null, aqi: null } });
      const outer = find(view("medium", only), (node) => node.type === "VStack" && node.props.alignment === "leading" && node.children.some((child) => typeof child !== "string" && child.type === "HStack" && child.props.alignment === "top"))[0];
      const first = outer.children[0];
      return only.bottomStats.length === 0 && bottomKind(only) === "none" && typeof first !== "string" && first.type === "Spacer";
    })());

    // 横向的几处写法（真机上才看得出效果，这里至少守住写法没被改掉）
    const isSpacer = (node: Node | string) => typeof node !== "string" && node.type === "Spacer";
    const rowWith = (root: Node, firstText: string) => find(root, (node) => node.type === "HStack" && node.children.some((child) => typeof child !== "string" && textOf(child) === firstText))[0];
    check("右上默认那一行（图标、天气、降水概率）：末尾有 Spacer、开头没有，内容靠左，不被拉开", (() => {
      const row = rowWith(view("medium", c.compact), c.compact.condition.text);
      return isSpacer(row.children[row.children.length - 1]) && !isSpacer(row.children[0]);
    })());
    check("右上选「风和湿度」：前后各一个 Spacer、中间依次是风和湿度，整行在右栏里居中（真机上看着靠左不对称）", (() => {
      const row = rowWith(windy, "西南风 1级");
      const kinds = row.children.map((child) => (isSpacer(child) ? "空白" : textOf(child)));
      return kinds.join() === "空白,西南风 1级,湿度25%,空白";
    })());
    check("右上选「风和湿度」时有预警：徽章还是靠左（开头不是 Spacer、末尾有 Spacer），不跟着居中", (() => {
      const root = view("medium", cardWith({ top: "windHumidity" }, "compact", loaded, demo));
      const rows = find(root, (node) => {
        const [first, second] = node.children;
        return node.type === "HStack" && node.children.length === 2 && typeof first !== "string" && texts(first).includes("示例·暴雨橙色预警") && isSpacer(second);
      });
      return rows.length === 1;
    })());
    check("「未来几天」里最高、最低的气温都是等宽数字（各列的数字才对得齐）", (() => {
      const stripNode = strips(daily)[0];
      const numbers = find(stripNode, (node) => node.type === "Text" && dailyCard.dayColumns.some((column) => column.high === textOf(node) || column.low === textOf(node)));
      return numbers.length === 10 && numbers.every((node) => node.props.monospacedDigit === true);
    })());
    check("右上选「风和湿度」时气温旁边有图标：气温一行不折行、放不下就缩（lineLimit 1、minScaleFactor），图标不大于气温字号的 0.75 倍", (() => {
      const temperature = find(windy, (node) => node.type === "Text" && textOf(node) === windyCard.temperature)[0];
      return temperature.props.lineLimit === 1 && typeof temperature.props.minScaleFactor === "number" && windyM.bigIcon <= windyM.temp * 0.75 && windyM.bigIcon > 0;
    })());
    check("气温旁边的图标：两套字号里都不大于气温字号的 0.75 倍（不然把气温挤小）", (["standard", "compact"] as const).every((variant) => {
      const m = metricsFor("medium", 338, 158, variant);
      return m.bigIcon > 0 && m.bigIcon <= m.temp * 0.75;
    }));
    check("一句话、风、湿度、日落、空气都是一行（lineLimit 1），不会折成两行把竖向撑高", (() => {
      const headlineRoot = view("medium", cardWith({ bottom: "headline" }));
      const oneLine = (root: Node, wanted: string[]) => find(root, (node) => node.type === "Text" && wanted.includes(textOf(node))).every((node) => node.props.lineLimit === 1);
      return oneLine(headlineRoot, ["今日多云，气温适宜", "日出", "06:45", "空气", "优 50"]) && oneLine(windy, ["西南风 1级", "湿度", "25%"]);
    })());

    // bottomKind：底部那一行画什么
    check("bottomKind：提醒永远先；其次看选的样式（不显示 / 一句话），默认的是有雨说雨、否则几项数据；备用来源什么都没有", (() => {
      const kind = (content: Card) => bottomKind(content);
      const stored = cardWith({}, "compact", { ...loaded, source: "stored" });
      const rainy = { ...loaded, extras: { ...sampleExtras, rainNote: "25 分钟后开始下雨" } };
      return kind(cardWith({})) === "stats" && kind(cardWith({ bottom: "none" })) === "none" && kind(cardWith({ bottom: "headline" })) === "headline" && kind(cardWith({}, "compact", rainy)) === "rain" && kind(cardWith({ bottom: "headline" }, "compact", rainy)) === "headline" && kind(cardWith({ bottom: "none" }, "compact", rainy)) === "none" && kind(stored) === "note" && kind(cardWith({ bottom: "none" }, "compact", { ...loaded, source: "stored" })) === "note" && kind(cardWith({ bottom: "headline" }, "compact", { ...loaded, source: "stored" })) === "note" && kind(cardWith({}, "compact", plainLoaded)) === "none" && kind(cardWith({ bottom: "headline" }, "compact", plainLoaded)) === "none";
    })());
  }

  // ---------------------------------------------------------------- 设置页里的「显示样式」
  section("App 页：显示样式一节");
  {
    const make = (display: Display, onChange: (next: Display) => void = () => undefined) => render(DisplaySection({ display, onChange }));
    const pickers = (root: Node) => find(root, (node) => node.type === "Picker");
    const def = defaultDisplay();
    check("默认样式：三个选择器（中间一排、右上一行、底部一行），没有「恢复默认样式」", pickers(make(def)).length === 3 && !texts(make(def)).includes("恢复默认样式"));
    check("底部选了「一句话」才多出第四个选择器：一句话写什么", pickers(make({ ...def, bottom: "headline" })).length === 4 && pickers(make({ ...def, bottom: "none" })).length === 3);
    check("选项都在：逐小时 / 未来几天；天气和降水概率 / 风和湿度；体感湿度风空气 / 一句话日落空气 / 不显示；自动 / 彩云的一句话 / 明天比今天冷还是暖", (() => {
      const all = texts(make({ ...def, bottom: "headline" }));
      return ["逐小时", "未来几天", "天气和降水概率", "风和湿度", "体感、湿度、风、空气", "一句话、日落、空气", "不显示", "自动", "彩云的一句话", "明天比今天冷还是暖"].every((text) => all.includes(text));
    })());
    check("选项的 tag 就是存下来的值", (() => {
      const root = make({ ...def, bottom: "headline" });
      const tags = find(root, (node) => node.type === "Text" && typeof node.props.tag === "string").map((node) => node.props.tag);
      return ["hourly", "daily", "condition", "windHumidity", "stats", "headline", "none", "auto", "keypoint", "change"].every((tag) => tags.includes(tag));
    })());
    check("改一个选择器：只改它那一项，别的项不变", (() => {
      const seen: Display[] = [];
      const root = make({ ...def, top: "windHumidity" }, (next) => seen.push(next));
      const [strip, top, bottom] = pickers(root);
      (strip.props.onChanged as (value: string) => void)("daily");
      (top.props.onChanged as (value: string) => void)("condition");
      (bottom.props.onChanged as (value: string) => void)("none");
      return seen.length === 3 && JSON.stringify(seen[0]) === JSON.stringify({ ...def, top: "windHumidity", strip: "daily" }) && seen[1].top === "condition" && seen[1].strip === "hourly" && seen[2].bottom === "none";
    })());
    check("选择器停在现在的值上", (() => {
      const root = make({ strip: "daily", top: "windHumidity", bottom: "headline", headline: "keypoint" });
      return pickers(root).map((node) => node.props.value).join() === "daily,windHumidity,headline,keypoint";
    })());
    check("不是默认的样式才有「恢复默认样式」，点了交出默认的样式", (() => {
      const seen: Display[] = [];
      const root = make({ ...def, strip: "daily" }, (next) => seen.push(next));
      const reset = find(root, (node) => node.type === "Button")[0];
      (reset.props.action as () => void)();
      return texts(root).includes("恢复默认样式") && seen.length === 1 && sameDisplay(seen[0], def);
    })());
    check("说明文字：一句一行，写了默认的样子和备用来源的情况", (() => {
      const footer = make(def).props.footer;
      const text = isNode(footer) ? textOf(footer) : "";
      return text.split("\n").length >= 4 && text.includes("默认：逐小时、天气和降水概率、体感湿度风空气") && text.includes("备用来源（Open-Meteo）没有这些数据，会按默认的样子画");
    })());
  }

  // ---------------------------------------------------------------- 预览卡片
  section("App 页里的卡片预览");
  {
    const preview = render(PreviewCard({ content: c.compact, width: 358 }));
    check("预览卡片用的是中号那一套：同样的字，背景用 background（不是 widgetBackground）", texts(preview).includes("北京市") && inOrder(texts(preview), c.compact.slots.map((slot) => slot.label)) && preview.props.widgetBackground === undefined && typeof preview.props.background === "object");
    check("预览卡片里也没有更新时间和署名", !texts(preview).some((text) => FORBIDDEN_ON_CARD.test(text)));
    check("取数据的占位卡片：写「正在取天气…」", texts(render(LoadingCard({ width: 358 }))).includes("正在取天气…"));
  }

  // ---------------------------------------------------------------- App 页的几节
  section("App 页：概况、未来几天、详细数据、空气质量、生活指数");
  {
    const detail = c.compact.detail;
    check("备用来源（没有详细数据）：这几节都不出现", [SummarySection, WeekSection, DetailSection, AirSection, LifeSection].every((part) => expand(part({ detail: null })).length === 0));
    if (detail === null) throw new Error("应该有详细数据");

    const summary = render(SummarySection({ detail }));
    check("概况：三句话（节标题「概况」之外）", summary.type === "Section" && summary.children.map(textOf).join("|") === "今日多云，气温适宜|未来24小时多云，气温适中|未来2小时无降水" && textOf(summary.props.header as Node) === "概况");
    check("概况：读不到的那句不写；全都没有就整节不出现", render(SummarySection({ detail: { ...detail, dayOutlook: null } })).children.length === 2 && expand(SummarySection({ detail: { ...detail, keypoint: null, dayOutlook: null, rainOutlook: null } })).length === 0);

    const week = render(WeekSection({ detail }));
    check("未来几天：今天起 6 天，每天写天气气温，第二行小字写风 / 湿度 / 空气 / 紫外线", find(week, (node) => node.type === "VStack").length === 6 && texts(week).filter((text) => text.includes("湿度") && text.includes("紫外线")).length === 6 && inOrder(texts(week), ["今天", "明天", "后天", "周四", "周五", "周六"]));
    check("未来几天：某一天没有第二行的数据就只有一行", (() => {
      const lines = detail.week.map((day, index) => (index === 2 ? { ...day, extra: null } : day));
      const node = render(WeekSection({ detail: { ...detail, week: lines } }));
      return texts(node).filter((text) => text.includes("紫外线")).length === 5;
    })());

    const stats = render(DetailSection({ detail }));
    check("详细数据：8 行，标签和值各一个", find(stats, (node) => node.type === "HStack").length === 8 && inOrder(texts(stats), detail.all.flatMap((stat) => [stat.label, stat.value])));
    const air = render(AirSection({ detail }));
    check("空气质量：7 行（指数加六项污染物）", find(air, (node) => node.type === "HStack").length === 7 && texts(air).includes("PM2.5") && texts(air).includes("35 μg/m³") && texts(air).includes("1 mg/m³"));
    const life = render(LifeSection({ detail }));
    check("生活指数：4 行", find(life, (node) => node.type === "HStack").length === 4 && texts(life).includes("薄外套"));
  }

  // ---------------------------------------------------------------- 预警一节
  section("App 页：天气预警一节");
  {
    const alertsOf = (state: AlertState | null, provider: "caiyun" | "openmeteo", demoUntil = 0) => render(AlertsSection({ alertState: state, provider, now: NOW, demoUntil, startDemo: () => undefined, stopDemo: () => undefined }));
    const ok = alertsOf({ kind: "ok", items: DEMO_ALERTS.slice(), fetchedAt: NOW, failure: null }, "caiyun");
    check("有预警：状态行写几条，每条一个徽章加标题", texts(ok).some((text) => text.startsWith("2 条预警")) && DEMO_ALERTS.every((item) => texts(ok).includes(item.title)));
    check("按钮：没开预览是「预览预警样式（10 分钟）」，开着是「结束预览」", texts(ok).includes("预览预警样式（10 分钟）") && texts(alertsOf(null, "caiyun", NOW + 5 * 60_000)).includes("结束预览"));
    check("按钮接的函数：没开预览点了是开始，开着点了是结束", (() => {
      const start = () => undefined;
      const stop = () => undefined;
      const press = (demoUntil: number) => find(render(AlertsSection({ alertState: null, provider: "caiyun", now: NOW, demoUntil, startDemo: start, stopDemo: stop })), (node) => node.type === "Button")[0].props.action;
      return press(0) === start && press(NOW + 1000) === stop;
    })());
    check("备用来源：状态行写「备用来源没有预警」", texts(alertsOf(null, "openmeteo")).includes("备用来源没有预警"));
    check("没取到（接口没给预警）：状态行写原因，不画任何一条预警", (() => {
      const node = alertsOf({ kind: "failed", failure: describeFailure(new FetchError("missing")) }, "caiyun");
      return texts(node).includes("接口没有返回预警数据") && find(node, (n) => n.type === "ZStack").length === 0;
    })());
    check("最要紧的两句放在最后：预警仅供参考、没看到不等于没有", (() => {
      const footer = ok.props.footer;
      return isNode(footer) && textOf(footer).includes("预警仅供参考，以官方发布为准") && textOf(footer).includes("没看到预警，不等于没有预警");
    })());
  }

  // ---------------------------------------------------------------- 天气来源一节
  section("App 页：天气来源一节");
  {
    const base = { source: defaultSource(), loaded, now: NOW, hostText: "", tokenText: "", busy: false, onChoice: () => undefined, setHostText: () => undefined, setTokenText: () => undefined, saveCustom: () => undefined, clearCustom: () => undefined };
    const builtin = render(SourceSection({ ...base, choice: "builtin" }));
    check("内置：选择器三项、状态行；没有地址 / token 输入框", find(builtin, (node) => node.type === "Picker").length === 1 && find(builtin, (node) => node.type === "Text" && node.props.tag !== undefined).length === 3 && find(builtin, (node) => node.type === "TextField" || node.type === "SecureField").length === 0);
    const custom = render(SourceSection({ ...base, choice: "custom" }));
    check("自己的：多出服务地址、token 两个输入框和「保存并测试」；服务地址的示范是彩云官方的", find(custom, (node) => node.type === "TextField").length === 1 && find(custom, (node) => node.type === "SecureField").length === 1 && texts(custom).includes("保存并测试") && find(custom, (node) => node.type === "TextField")[0].props.prompt === OFFICIAL_HOST);
    check("选了 Open-Meteo：没有输入框", find(render(SourceSection({ ...base, choice: "openmeteo" })), (node) => node.type === "TextField").length === 0);
    check("填过自己的设置才有「清除自己的设置」", !texts(custom).includes("清除自己的设置") && texts(render(SourceSection({ ...base, choice: "custom", source: { mode: "custom", host: "https://weather.example.com", token: "abc" } }))).includes("清除自己的设置"));
    check("说明文字（页脚）写了三种来源各是什么，一句一行", (() => {
      const footer = builtin.props.footer;
      return isNode(footer) && textOf(footer).includes("内置：") && textOf(footer).includes("自己的：") && textOf(footer).includes("Open-Meteo：备用");
    })());
    check("状态行：取到了写几点更新；没取成功写原因", texts(builtin).some((text) => text.endsWith(" 更新")) && texts(render(SourceSection({ ...base, choice: "builtin", loaded: { kind: "noData", source: "live", place: null, failure: describeFailure(new FetchError("token")) } }))).includes("token 无效，或者没开通"));
  }

  // ---------------------------------------------------------------- 内置接口的地址不出现在任何界面上
  section("内置接口的地址：画出来的任何一个字里都没有");
  {
    const host = new URL(BUILTIN_HOST).hostname;
    const everything: string[] = [];
    for (const size of Object.keys(SIZES)) {
      for (const content of [c.compact, c.compactAlert, c.compactPlain, c.compactFailed, c.large, c.largeAlert, c.largePlain, NO_DATA, NO_LOCATION]) everything.push(...texts(view(size, content)));
    }
    const base = { source: defaultSource(), loaded, now: NOW, hostText: "", tokenText: "", busy: false, onChoice: () => undefined, setHostText: () => undefined, setTokenText: () => undefined, saveCustom: () => undefined, clearCustom: () => undefined };
    for (const choice of ["builtin", "custom", "openmeteo"] as const) {
      const node = render(SourceSection({ ...base, choice }));
      everything.push(...texts(node));
      if (isNode(node.props.footer)) everything.push(textOf(node.props.footer));
      walk(node, (n) => {
        if (typeof n.props.prompt === "string") everything.push(n.props.prompt);
      });
    }
    check("所有尺寸的卡片、天气来源一节（三种选择，含输入框的提示）里都没有内置地址", everything.length > 100 && everything.every((text) => !text.includes(host) && !text.includes(BUILTIN_HOST)));
  }

  console.log("\n" + passed + " 项通过，" + failed + " 项失败");
  if (failed > 0) process.exit(1);
}

main();
