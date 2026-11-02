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
import { FetchError, describeFailure } from "../天气小组件/core/failure";
import type { Coord } from "../天气小组件/core/geo";
import { ALERT_BADGE_RATIO, ALERT_GLYPH_RATIO, metricsFor } from "../天气小组件/core/layout";
import type { Loaded } from "../天气小组件/core/load";
import { ALERT_BADGE, AQI_COLOR, BAR_FILL, BAR_TRACK } from "../天气小组件/core/palette";
import { LARGE_DAYS, NO_DATA, NO_LOCATION, present, type Card, type Content } from "../天气小组件/core/present";
import { AlertsSection } from "../天气小组件/pages/AlertsSection";
import { AirSection, DetailSection, LifeSection, SummarySection, WeekSection } from "../天气小组件/pages/DetailSections";
import { LoadingCard, PreviewCard } from "../天气小组件/pages/Preview";
import { SourceSection } from "../天气小组件/pages/SourceSection";
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
