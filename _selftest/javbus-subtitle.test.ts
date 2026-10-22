// 离线自测：kit/subtitle.ts 的搜索与下载（fetch / Data 换成内存替身）。
//   npx -y -p tsx tsx _selftest/javbus-subtitle.test.ts
//
// 只验证我们自己的逻辑：几种搜法并发、合并去重、缓存策略、全部失败 / 部分失败、
// 下载时的编码（带 BOM 的 UTF-8 / GBK / 没有 BOM 的 UTF-16）、主链接失效换备用链接、解析不出字幕当失败。
// 不验证迅雷接口本身——接口返回的样子取自 2026-10-22 的实测，文件名保留、字幕内容换成中性文字。

import type { SubtitleChoice } from "../JavBus/core/subtitle";
import { loadSubtitle, searchSubtitles } from "../JavBus/kit/subtitle";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

// ———— Scripting 运行时替身 ————

type Route = { status?: number; body?: string | Uint8Array; fail?: boolean };
const routes = new Map<string, Route>();
const calls: string[] = [];
/** 每次请求带的头（kit 里字幕猫的请求要带浏览器 UA）。 */
const sentHeaders: Record<string, unknown>[] = [];

(globalThis as any).fetch = async (url: string, init?: { headers?: Record<string, unknown> }): Promise<any> => {
  calls.push(url);
  sentHeaders.push(init?.headers ?? {});
  const route = routes.get(url) ?? { status: 404, body: "" };
  if (route.fail) throw new Error("网络错误");
  const raw = route.body ?? "";
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  return {
    status: route.status ?? 200,
    text: async () => new TextDecoder().decode(bytes),
    bytes: async () => bytes,
  };
};

/** Data.fromUint8Array / toRawString：系统解不开返回 null（用 fatal 解码器模拟），toDecodedString 把坏字节换成替换符。 */
(globalThis as any).Data = {
  fromUint8Array(bytes: Uint8Array) {
    if (bytes.length === 0) return null;
    const labels: Record<string, string> = { "utf-8": "utf-8", utf16LittleEndian: "utf-16le", utf16BigEndian: "utf-16be", gb18030: "gb18030" };
    return {
      toRawString(encoding = "utf-8") {
        try {
          return new TextDecoder(labels[encoding], { fatal: true }).decode(bytes);
        } catch {
          return null;
        }
      },
      toDecodedString() {
        return new TextDecoder("utf-8").decode(bytes);
      },
    };
  },
};

const API = "https://api-shoulei-ssl.xunlei.com/oracle/subtitle?name=";
const api = (query: string) => `${API}${encodeURIComponent(query)}`;
/** 只数迅雷接口的请求（搜索现在也会发字幕猫的请求，那些另外验）。 */
const apiCalls = (): string[] => calls.filter((u) => u.startsWith(API));
const catSearch = (query: string) => `https://www.subtitlecat.com/index.php?search=${encodeURIComponent(query)}`;
const listBody = (items: object[]) => JSON.stringify({ code: 0, data: items, result: "ok" });
const entry = (gcid: string, name: string, seconds: number) => ({
  gcid,
  cid: gcid,
  url: `https://subtitle.example/${gcid}.srt`,
  ext: "srt",
  name,
  duration: seconds * 1000,
});
const choice = (...urls: string[]): SubtitleChoice => ({ name: "x.srt", ext: "srt", duration: 0, copies: urls.length, urls });
const rejection = (promise: Promise<unknown>): Promise<string | null> => promise.then(() => null, (e: Error) => e.message);

function reset(): void {
  routes.clear();
  calls.length = 0;
  sentHeaders.length = 0;
}

const BOM = [0xef, 0xbb, 0xbf];
const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));
const THREE_CUES =
  "1\n00:00:01,000 --> 00:00:02,000\n这是一条用来测试的中文字幕，文字够多。\n\n" +
  "2\n00:00:03,000 --> 00:00:04,000\n这是一条用来测试的中文字幕，文字够多。\n\n" +
  "3\n00:00:05,000 --> 00:00:06,000\n这是一条用来测试的中文字幕，文字够多。\n";
const NO_SUCH_KEY = '<?xml version="1.0" encoding="UTF-8"?>\n<Error>\n  <Code>NoSuchKey</Code>\n  <Message>The specified key does not exist.</Message>\n</Error>';

// ———— 字幕猫的页面（结构取自 2026-10-22 的实测，名字和字幕内容换成中性的） ————

const CAT = "https://www.subtitlecat.com";
const catRow = (path: string, name: string, origin: string, o: { liked?: boolean; downloads?: number } = {}): string =>
  `<tr>\n<td><a href="${path}">${name}</a> (translated from ${origin})</td>\n` +
  `<td class="sub-table__stars">${o.liked ? '<span title="Rated good by users">👍</span>' : "&nbsp;"}</td>\n` +
  `<td class="sub-table__metric"><span class="sub-table__metric-label"> Size</span><span class="sub-table__metric-value">10 KB</span></td>\n` +
  `<td class="sub-table__metric"><span class="sub-table__metric-label"> Downloads</span><span class="sub-table__metric-value">${o.downloads ?? 1}<span class="sub-table__metric-unit"> downloads</span></span></td>\n` +
  `<td class="sub-table__metric"><span class="sub-table__metric-label"> Languages</span><span class="sub-table__metric-value">3<span class="sub-table__metric-unit"> languages</span></span></td>\n</tr>\n`;
const catSearchPage = (rows: string[]): string =>
  `<html><body><table class="table sub-table"><thead><tr><th colspan="2">${rows.length} subtitles found</th></tr></thead><tbody>${rows.join("")}</tbody></table></body></html>`;
/** 详情页：files 是有现成文件的语言（代码 → 下载路径），orig 是原文文件的名字和目录，其余语言挂「Translate」按钮。 */
const catDetailPage = (files: Record<string, string>, orig: { name: string; folder: string }): string =>
  "<html><body>" +
  Object.entries(files)
    .map(([lang, path]) => `<span><a id="download_${lang}"  onclick="log_download(1); show_voting('${lang}');" href="${path}" class="green-link">Download</a></span>`)
    .join("\n") +
  `<span><button id="af" onclick="translate_from_server_folder('af', '${orig.name}', '${orig.folder}')" class="yellow-link">Translate</button></span></body></html>`;
const catChoice = (page: string, origin: string): SubtitleChoice => ({ name: "x", ext: "srt", duration: 0, copies: 1, urls: [], cat: { page, origin } });
const catCalls = (): string[] => calls.filter((u) => u.startsWith(CAT));

async function main(): Promise<void> {
  console.log("搜索：几种搜法并发、合并去重、缓存");
  {
    reset();
    routes.set(api("SSIS-123"), { body: listBody([entry("A", "SSIS-123.srt", 8856), entry("B", "00001(1).srt", 7000)]) });
    routes.set(api("SSIS00123"), { body: listBody([]) });
    routes.set(api("SSIS123"), { body: listBody([entry("A", "SSIS-123.srt", 8856), entry("C", "SSIS123.HD.srt", 8856)]) });
    const choices = await searchSubtitles("SSIS-123");
    check("迅雷：三种写法各请求一次，请求头里只有番号", apiCalls().length === 3 && [api("SSIS-123"), api("SSIS00123"), api("SSIS123")].every((u) => calls.includes(u)));
    check("合并后按 gcid 去重、文件名对不上番号的（00001(1).srt）滤掉", choices.map((c) => c.name).join("|") === "SSIS-123.srt|SSIS123.HD.srt");
    await searchSubtitles("SSIS-123", 8856);
    check("三路都成功：原始条目按番号缓存，再搜不再请求迅雷（换视频时长重新排序照样可以）", apiCalls().length === 3);
  }

  {
    reset();
    routes.set(api("ABC-001"), { fail: true });
    routes.set(api("ABC00001"), { body: listBody([entry("D", "abc00001hhb.srt", 7000)]) });
    routes.set(api("ABC001"), { status: 500, body: "" });
    const choices = await searchSubtitles("ABC-001");
    check("部分失败：用成功的那一路", choices.length === 1 && choices[0].name === "abc00001hhb.srt");
    await searchSubtitles("ABC-001");
    check("部分失败不缓存：下次整套重搜", apiCalls().length === 6);
  }

  {
    reset();
    routes.set(api("XYZ-9"), { fail: true });
    routes.set(api("XYZ00009"), { status: 500 });
    routes.set(api("XYZ9"), { body: "不是 JSON" });
    routes.set(catSearch("XYZ-9"), { fail: true });
    routes.set(catSearch("XYZ9"), { status: 503 });
    check("两个来源全部失败才报错", (await rejection(searchSubtitles("XYZ-9"))) === "连不上迅雷字幕库和字幕猫，检查一下网络");
    reset();
    check("空番号：不发请求，没有候选", (await searchSubtitles("  ")).length === 0 && calls.length === 0);
    routes.set(api("NONE-1"), { body: listBody([]) });
    routes.set(api("NONE00001"), { body: listBody([]) });
    routes.set(api("NONE1"), { body: listBody([]) });
    check("查得到接口但库里没有：空候选，不是错误", (await searchSubtitles("NONE-1")).length === 0);
  }

  console.log("下载：编码、备用链接、失效");
  {
    reset();
    routes.set("https://s/utf8.srt", { body: Uint8Array.from([...BOM, ...new TextEncoder().encode(THREE_CUES)]) });
    const result = await loadSubtitle(choice("https://s/utf8.srt"));
    check("带 BOM 的 UTF-8：三条，BOM 不进文本，语言认出中文", result.cues.length === 3 && result.cues[0].text.startsWith("这是") && result.language === "中文");
    check("记下实际下载成功的地址（给外部播放器当外挂字幕用）", result.url === "https://s/utf8.srt");
    await loadSubtitle(choice("https://s/utf8.srt"));
    check("解析好的字幕按主链接缓存，再取不发请求", calls.length === 1);
  }

  {
    reset();
    // C4 E3 BA C3 = GBK 的「你好」
    routes.set("https://s/gbk.srt", { body: Uint8Array.from([...ascii("1\n00:00:01,000 --> 00:00:02,000\n"), 0xc4, 0xe3, 0xba, 0xc3, 0x0a]) });
    const result = await loadSubtitle(choice("https://s/gbk.srt"));
    check("GBK：按 GB18030 解出「你好」", result.cues.length === 1 && result.cues[0].text === "你好");

    const ass = "[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,宽字符\r\n";
    routes.set("https://s/wide.ass", { body: new Uint8Array(Buffer.from(ass, "utf16le")) });
    const wide = await loadSubtitle(choice("https://s/wide.ass"));
    check("没有 BOM 的 UTF-16LE 的 ASS", wide.cues.length === 1 && wide.cues[0].text === "宽字符");

    // 实测的怪文件：BOM 被转码弄成了 EF BF BD EF BF BD，中间还有一截被弄坏（落单的代理项），段头和 Format 行都没了，只剩 Dialogue
    const damaged = "[Script Info]\r\n; 欢迎\ud800�\r\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,好句子\r\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,第二句\r\n";
    routes.set("https://s/damaged.ass", { body: Uint8Array.from([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd, ...Buffer.from(damaged, "utf16le")]) });
    const repaired = await loadSubtitle(choice("https://s/damaged.ass"));
    check("弄坏了一截的 UTF-16LE：宽松解码，好的那些条照样出来", repaired.cues.map((c) => c.text).join("|") === "好句子|第二句");
  }

  {
    reset();
    routes.set("https://s/dead.srt", { body: NO_SUCH_KEY });
    routes.set("https://s/gone.srt", { status: 404, body: "" });
    routes.set("https://s/ok.srt", { body: THREE_CUES });
    const result = await loadSubtitle(choice("https://s/dead.srt", "https://s/gone.srt", "https://s/ok.srt"));
    check("主链接是 NoSuchKey 页、第二条 404：顺次换到能用的备用链接", result.cues.length === 3 && calls.join(",") === "https://s/dead.srt,https://s/gone.srt,https://s/ok.srt");
    check("用了备用链接时，记下的是能用的那条而不是主链接", result.url === "https://s/ok.srt");
  }

  {
    reset();
    // 缓存按「候选的主链接」记：这一组用和上面不同的地址，免得读到上一组缓存下来的结果
    routes.set("https://s/dead-only.srt", { body: NO_SUCH_KEY });
    routes.set("https://s/net.srt", { fail: true });
    routes.set("https://s/big.srt", { body: new Uint8Array(3_000_001) });
    routes.set("https://s/empty.srt", { body: "" });
    check("文件里没有字幕：报「链接已失效」", ((await rejection(loadSubtitle(choice("https://s/dead-only.srt")))) ?? "").includes("没有字幕"));
    check("网络错误：带上原因", (await rejection(loadSubtitle(choice("https://s/net.srt")))) === "这条字幕打不开：网络错误");
    check("太大的文件当它不是字幕", ((await rejection(loadSubtitle(choice("https://s/big.srt")))) ?? "").includes("文件大小不对"));
    check("空文件", ((await rejection(loadSubtitle(choice("https://s/empty.srt")))) ?? "").includes("文件大小不对"));
    check("没有地址", ((await rejection(loadSubtitle(choice()))) ?? "").includes("没有可用的下载地址"));
    check("失败不缓存：同一条再取会重新请求", (await rejection(loadSubtitle(choice("https://s/dead-only.srt")))) !== null && calls.filter((u) => u === "https://s/dead-only.srt").length === 2);
  }

  console.log("字幕猫：搜索、挑选、合并进候选");
  {
    reset();
    routes.set(api("CAT-123"), { body: listBody([entry("A", "CAT-123.srt", 8856)]) });
    routes.set(api("CAT00123"), { body: listBody([]) });
    routes.set(api("CAT123"), { body: listBody([]) });
    routes.set(catSearch("CAT-123"), {
      body: catSearchPage([
        catRow("subs/10/CAT-123.mt.html", "CAT-123.mt", "English", { liked: true, downloads: 50 }),
        catRow("subs/11/CAT-999 chs.html", "CAT-999 chs", "Chinese"), // 站上的搜索是模糊的，名字对不上番号的要滤掉
        catRow("subs/12/CAT-123.chs.html", "CAT-123.chs", "Chinese", { downloads: 3 }),
      ]),
    });
    routes.set(catSearch("CAT123"), {
      body: catSearchPage([
        catRow("subs/12/CAT-123.chs.html", "CAT-123.chs", "Chinese", { downloads: 3 }),
        catRow("subs/13/CAT123.fhd.html", "CAT123.FHD", "Chinese", { liked: true }),
      ]),
    });
    const choices = await searchSubtitles("CAT-123");
    check(
      "字幕猫：带横杠和紧凑两种写法各搜一次（补零的写法在这个站上没用，不搜）",
      catCalls().length === 2 && calls.includes(catSearch("CAT-123")) && calls.includes(catSearch("CAT123")) && !calls.includes(catSearch("CAT00123")),
    );
    check(
      "迅雷的在前、字幕猫的在后；名字对不上的滤掉、同一个详情页只留一条、中文原版（点过赞的在前）排在机翻前面",
      choices.map((c) => c.name).join("|") === "CAT-123.srt|CAT123.FHD|CAT-123.chs|CAT-123.mt",
    );
    check(
      "字幕猫的候选：下载地址先空着，记着详情页和原始语言；迅雷的没有这个字段",
      choices[0].cat === undefined &&
        choices[1].urls.length === 0 &&
        choices[1].cat?.page === `${CAT}/subs/13/CAT123.fhd.html` &&
        choices[1].cat?.origin === "Chinese" &&
        choices[3].cat?.origin === "English",
    );
    check("字幕猫的搜索请求带浏览器 UA", catCalls().length > 0 && sentHeaders.filter((_, i) => calls[i].startsWith(CAT)).every((h) => typeof h["User-Agent"] === "string"));
    await searchSubtitles("CAT-123");
    check("两路都成功：字幕猫的搜索结果也按番号缓存，再搜不再请求", catCalls().length === 2);
  }

  {
    reset();
    for (const q of ["AAA-1", "AAA00001", "AAA1"]) routes.set(api(q), { fail: true });
    routes.set(catSearch("AAA-1"), { body: catSearchPage([catRow("subs/20/AAA-1.html", "AAA-1", "Chinese")]) });
    routes.set(catSearch("AAA1"), { body: catSearchPage([]) });
    const fromCat = await searchSubtitles("AAA-1");
    check("迅雷连不上：用字幕猫的，不报错", fromCat.length === 1 && fromCat[0].cat?.origin === "Chinese");

    reset();
    routes.set(api("BBB-1"), { body: listBody([entry("B", "BBB-1.srt", 5000)]) });
    routes.set(api("BBB00001"), { body: listBody([]) });
    routes.set(api("BBB1"), { body: listBody([]) });
    routes.set(catSearch("BBB-1"), { fail: true });
    routes.set(catSearch("BBB1"), { status: 503 });
    const fromXunlei = await searchSubtitles("BBB-1");
    check("字幕猫连不上：用迅雷的，不报错", fromXunlei.length === 1 && fromXunlei[0].name === "BBB-1.srt");

    reset();
    for (const q of ["DDD-1", "DDD00001", "DDD1"]) routes.set(api(q), { body: listBody([]) });
    routes.set(catSearch("DDD-1"), { body: catSearchPage([catRow("subs/30/DDD-1.html", "DDD-1", "Chinese")]) });
    routes.set(catSearch("DDD1"), { status: 500 });
    check("字幕猫有一种写法失败：用成功的那一路", (await searchSubtitles("DDD-1")).length === 1);
    await searchSubtitles("DDD-1");
    check("字幕猫部分失败不缓存：下次整套重搜", catCalls().length === 4);

    reset();
    for (const q of ["EEE-0", "EEE00000", "EEE0"]) routes.set(api(q), { body: listBody([]) });
    routes.set(catSearch("EEE-0"), { body: catSearchPage([catRow("subs/31/EEE-9.html", "EEE-9", "Chinese")]) });
    routes.set(catSearch("EEE0"), { body: catSearchPage([]) });
    check("两边都查得到，但库里没有对得上的：空候选，不是错误", (await searchSubtitles("EEE-0")).length === 0);
  }

  console.log("字幕猫：读详情页、挑中文文件、下载");
  {
    reset();
    const page = `${CAT}/subs/40/FFF-1.html`;
    routes.set(page, {
      body: catDetailPage(
        { "zh-CN": "/subs/41/FFF-1-zh-CN.srt", "zh-TW": "/subs/42/FFF-1-zh-TW.srt", ar: "/subs/43/FFF-1-ar.srt" },
        { name: "FFF-1-orig.srt", folder: "/subs/40/" },
      ),
    });
    routes.set(`${CAT}/subs/41/FFF-1-zh-CN.srt`, { body: THREE_CUES });
    const result = await loadSubtitle(catChoice(page, "English"));
    check(
      "机翻的：先读详情页拿到 zh-CN 的地址（目录号和原文的不是同一个），再下载那份",
      result.cues.length === 3 && result.language === "中文" && result.url === `${CAT}/subs/41/FFF-1-zh-CN.srt` && calls.join(",") === `${page},${CAT}/subs/41/FFF-1-zh-CN.srt`,
    );
    check("详情页和字幕文件的请求都带浏览器 UA", sentHeaders.length === 2 && sentHeaders.every((h) => typeof h["User-Agent"] === "string"));
    await loadSubtitle(catChoice(page, "English"));
    check("解析好的字幕按详情页地址缓存，再取不发请求", calls.length === 2);
  }

  {
    reset();
    const page = `${CAT}/subs/50/GGG-1.html`;
    routes.set(page, {
      body: catDetailPage({ "zh-CN": "/subs/51/GGG-1-zh-CN.srt", "zh-TW": "/subs/52/GGG-1-zh-TW.srt" }, { name: "GGG-1-orig.srt", folder: "/subs/50/" }),
    });
    routes.set(`${CAT}/subs/51/GGG-1-zh-CN.srt`, { status: 404 });
    routes.set(`${CAT}/subs/52/GGG-1-zh-TW.srt`, { body: THREE_CUES });
    const result = await loadSubtitle(catChoice(page, "Chinese"));
    check("简体的打不开就退到繁体", result.url === `${CAT}/subs/52/GGG-1-zh-TW.srt` && result.cues.length === 3);
  }

  {
    reset();
    const page = `${CAT}/subs/60/HHH-1.html`;
    routes.set(page, { body: catDetailPage({ "zh-CN": "/subs/61/HHH-1-zh-CN.srt" }, { name: "HHH-1-orig.srt", folder: "/subs/60/" }) });
    routes.set(`${CAT}/subs/61/HHH-1-zh-CN.srt`, { body: NO_SUCH_KEY });
    routes.set(`${CAT}/subs/60/HHH-1-orig.srt`, { body: THREE_CUES });
    const result = await loadSubtitle(catChoice(page, "Chinese"));
    check("中文原版：中文文件都打不开时最后退到原文（-orig.srt）", result.url === `${CAT}/subs/60/HHH-1-orig.srt` && result.cues.length === 3);

    reset();
    const noChinese = `${CAT}/subs/70/III-1.html`;
    routes.set(noChinese, { body: catDetailPage({ en: "/subs/70/III-1-en.srt" }, { name: "III-1-orig.srt", folder: "/subs/70/" }) });
    check(
      "机翻的没有中文文件：报「没有中文版本」，不去下英文或原文",
      (await rejection(loadSubtitle(catChoice(noChinese, "English")))) === "字幕猫上这条没有中文版本" && calls.length === 1,
    );

    reset();
    routes.set(`${CAT}/subs/80/JJJ-1.html`, { status: 503 });
    check("详情页打不开：报 HTTP 状态", ((await rejection(loadSubtitle(catChoice(`${CAT}/subs/80/JJJ-1.html`, "English")))) ?? "").includes("503"));
    check("没读到中文文件的不缓存：同一条再取会重新读详情页", (await rejection(loadSubtitle(catChoice(`${CAT}/subs/80/JJJ-1.html`, "English")))) !== null && calls.length === 2);
  }

  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

void main();
