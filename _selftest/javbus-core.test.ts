// 离线自测（Node 里跑，不碰 Scripting 的原生 API）。
//   npx -y -p tsx tsx _selftest/javbus-core.test.ts
//
// 覆盖 JavBus 脚本 core/ 下的纯逻辑：番号归一化与识别、站点地址、页面解析、收藏库、推荐载荷、格式化。
// 解析用的 HTML 夹具按真实页面的结构手写（标题换成中性文字）：真实结构取自 Wayback 存档的
// javbus.com / javbus.org 列表页、演员列表、分类页和详情页，开发时已经对着整页存档跑过一遍。

import { COMMUNITY_CHANNELS, COMMUNITY_URL, FALLBACK_THUMB, RETIRED_SERVICE_URLS, REC_UPLOAD_AUTHOR, UNKNOWN_DATE } from "../JavBus/core/constants";
import { formatLength, hashIndex, pad2, releaseLine, safeFileName, todayString } from "../JavBus/core/format";
import { detectCode, hasLink, normalizeCodeArg, normalizeKeyword, shortCodeOf } from "../JavBus/core/keyword";
import {
  addActress,
  addFavorite,
  addNamed,
  archiveMovie,
  emptyLibrary,
  findArchived,
  hasActress,
  hasNamed,
  libraryCounts,
  looksLikeBackup,
  mergeLibrary,
  movieStatus,
  normalizeLibrary,
  pickState,
  pickedMovies,
  removeArchived,
  removeFavorite,
  removeNamed,
  setPicked,
} from "../JavBus/core/library";
import {
  BLANK_ACTRESS_INFO,
  decodeHtml,
  findMissavHls,
  is404,
  isAgeGate,
  isJavdbBlocked,
  isNoResult,
  looksLikeHtml,
  magnetName,
  parseActressInfo,
  parseDetail,
  parseGenreSections,
  parseJableHls,
  parseJableSearch,
  parseJavdbCards,
  parseMagnetParams,
  parseMagnets,
  parseMovieList,
  parseScoreText,
  parseStars,
  pickJavdbRating,
  stripTags,
  visibleText,
} from "../JavBus/core/parse";
import { initialPhase, nextPhase } from "../JavBus/core/phase";
import { EXTERNAL_PLAYERS, encodeQueryValue, hasPlaceholder, launchUrl } from "../JavBus/core/player";
import { isProbing, pickBestSource, playSubline, type Previews } from "../JavBus/core/playback";
import {
  REPORT_REASONS,
  buildPayload,
  buildReport,
  channelUsesCommunity,
  cleanRecList,
  communityEndpoints,
  describeMeta,
  describeReportResult,
  describeUploadResult,
  normalizeCommunityUrl,
  pickServiceUrl,
  resolveServiceUrls,
} from "../JavBus/core/recommend";
import { fallbackRef, favMovieOf, refFromCode, refFromFav, refFromItem, refFromRec } from "../JavBus/core/refs";
import {
  actressListUrl,
  coverFromThumb,
  fallbackOrder,
  genreIndexUrl,
  isBigCover,
  isUncensoredLink,
  kindOfLink,
  listUrl,
  movieUrl,
  namedLink,
  namedShortCode,
  pagedUrl,
  resolveUrl,
  searchUrl,
  starLink,
  thumbFromCover,
} from "../JavBus/core/site";
import {
  buildChoices,
  cueTextAt,
  decodeUtf16,
  detectLanguage,
  durationFit,
  durationGapLabel,
  formatClock,
  isValidUtf8,
  matchesCode,
  offsetLabel,
  parseSubtitle,
  parseXunleiItems,
  shiftOffset,
  sniffEncoding,
  subtitleMetrics,
  subtitleQueries,
  type SubtitleItem,
} from "../JavBus/core/subtitle";
import { splitLayers, textUnits } from "../JavBus/core/subtitleLayers";
import {
  catChoices,
  catQueries,
  catSearchUrl,
  catToChoice,
  choiceLabel,
  parseCatDetail,
  parseCatSearch,
  pickCatUrls,
  type CatEntry,
} from "../JavBus/core/subtitlecat";
import {
  DEFAULT_SUBTITLE_STYLE,
  OPACITY_MIN,
  SCALE_MAX,
  SCALE_MIN,
  SUBTITLE_COLORS,
  clampSubtitleShift,
  colorWithAlpha,
  contrastInk,
  normalizeSubtitleStyle,
  parseHexColor,
  shiftToRatio,
  subtitleFontSize,
} from "../JavBus/core/subtitleStyle";
import type { DetailContext, FavMovie, MovieDetail } from "../JavBus/core/types";

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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ———— 夹具 ————

const LIST_HTML = `
<div id="waterfall">
  <div class="item">
    <a class="movie-box" href="https://www.javbus.com/TST-001">
      <div class="photo-frame"><img src="/pics/thumb/abcd.jpg" title="测试影片一" class="img"></div>
      <div class="photo-info">
        <span>测试影片一<br />
        <div style="white-space:normal;">
          <button class="btn btn-xs btn-primary" disabled="disabled" title="包含高清HD的磁力連結">高清</button>
          <button class="btn btn-xs btn-warning" disabled="disabled" title="包含字幕的磁力連結">字幕</button>
        </div>
        <date>TST-001</date> / <date>2021-09-09</date></span>
      </div>
    </a>
  </div>
  <div class="item">
    <a class="movie-box" href="https://www.javbus.com/uncensored/TST-002">
      <div class="photo-frame"><img src="https://img.example.com/t2.jpg" title="带字幕二字的标题 &amp; 其他"></div>
      <div class="photo-info">
        <span>带字幕二字的标题 &amp; 其他<br />
        <div style="white-space:normal;"><button class="btn btn-xs btn-success " disabled="disabled" title="包含最新出種的磁力連結">上週新種</button></div>
        <date>TST-002</date> / <date>2021-9-1</date></span>
      </div>
    </a>
  </div>
  <a title="同類影片" class="movie-box" href="https://www.javbus.com/REL-001" style="display:inline-block">
    <div class="photo-frame"><img src="/pics/thumb/rel.jpg"></div>
    <div class="photo-info"><span>没有 date 标签的卡片</span></div>
  </a>
</div>
<ul class="pagination pagination-lg"><li class="active"><a href="/page/1">1</a></li></ul>`;

const STAR_HTML = `
<div class="item"><a class="avatar-box text-center" href="https://www.javbus.com/star/okq">
  <div class="photo-frame"><img src="/pics/actress/okq_a.jpg" title="演员甲"></div>
  <div class="photo-info"><span>演员甲</span></div></a></div>
<div class="item"><a class="avatar-box text-center" href="https://www.javbus.com/star/zzz">
  <div class="photo-frame"><img src="" title="演员乙"></div>
  <div class="photo-info"><span>演员乙</span></div></a></div>`;

const ACTRESS_INFO_HTML = `
<div class="row"><div class="col-md-3"><div class="photo-frame"><img src="/a.jpg"></div></div>
<div class="col-md-9 photo-info">
  <p>生日: 1993-08-16</p><p>年齡: 30</p><p>身高: 159cm</p><p>罩杯: D</p><p>胸圍: 83cm</p><p>腰圍: 58cm</p><p>臀圍: 85cm</p><p>出生地: 日本</p>
</div></div>`;

const GENRE_HTML = `
<h4>主題</h4>
<div class="row genre-box">
  <a class="col-lg-2 col-md-2 col-sm-3 col-xs-6 text-center" href="https://www.javbus.com/genre/62">折磨</a>
  <a class="col-lg-2 col-md-2 col-sm-3 col-xs-6 text-center" href="https://www.javbus.com/genre/5g">嘔吐</a>
</div>
<h4>角色</h4>
<div class="row genre-box">
  <a class="col-lg-2" href="/genre/aa">老師</a>
</div>
<h4 class="modal-title" id="contactModalLab">聯絡我們</h4>`;

const DETAIL_HTML = `
<script>
	var gid = 47432801251;
	var uc = 0;
	var img = '/pics/cover/8fdr_b.jpg';
	var lang = 'zh';
</script>
<div class="container">
  <h3>TST-014 测试影片十四</h3>
  <div class="row movie">
    <div class="col-md-9 screencap">
      <a class="bigImage" href="/pics/cover/8fdr_b.jpg"><img src="/pics/cover/8fdr_b.jpg" title="测试影片十四"></a>
    </div>
    <div class="col-md-3 info">
      <p><span class="header">識別碼:</span> <span style="color:#CC0000;">TST-014</span>
      </p>
      <p><span class="header">發行日期:</span> 2021-09-09</p>
      <p><span class="header">長度:</span> 128分鐘</p>
      <p><span class="header">導演:</span> <a href="https://www.javbus.com/director/2ni">导演甲</a></p>
      <p><span class="header">製作商:</span> <a href="https://www.javbus.com/studio/2z">制作商甲</a>
      </p>
      <p><span class="header">發行商:</span> <a href="https://www.javbus.com/label/31">发行商甲</a>
      </p>
      <p><span class="header">系列:</span> <a href="https://www.javbus.com/series/q44">系列甲</a>
      </p>
      <p class="header">類別:<span id="genre-toggle" class="glyphicon glyphicon-plus"></span></p>
      <p>
        <span class="genre"><label><input type="checkbox" name="gr_sel" value="4o"><a href="https://www.javbus.com/genre/4o">类别一</a></label></span>
        <span class="genre"><label><input type="checkbox" name="gr_sel" value="10"><a href="https://www.javbus.com/genre/10">类别二</a></label></span>
        <span class="genre"><button id="gr_btn" type="button" class="btn">多選提交</button></span>
      </p>
    </div>
  </div>
  <div id="avatar-waterfall">
    <a class="avatar-box" href="https://www.javbus.com/star/um7"><div class="photo-frame"><img src="/pics/actress/um7_a.jpg" title="演员甲"></div><span>演员甲</span></a>
    <a class="avatar-box" href="https://www.javbus.com/star/w21"><div class="photo-frame"><img src="https://pics.dmm.co.jp/mono/actjpgs/nowprinting.gif" title="演员乙"></div><span>演员乙</span></a>
  </div>
  <div id="sample-waterfall">
    <a class="sample-box" href="https://pics.dmm.co.jp/digital/video/tst00014/tst00014jp-1.jpg"><div class="photo-frame"><img src="/pics/sample/8fdr_1.jpg" title="样品 1"></div></a>
    <a class="sample-box" href="/pics/sample/8fdr_2_big.jpg"><div class="photo-frame"><img src="/pics/sample/8fdr_2.jpg" title="样品 2"></div></a>
  </div>
</div>`;

// 旧版页面：标题在 <a class="bigImage" title=…> 上；缺导演 / 系列 / 长度
const OLD_DETAIL_HTML = `
<h3>OLD-001 旧版标题</h3>
<a class="bigImage" href="https://images.javbus.org/cover/x_b.jpg" title="旧版标题"><img src="https://images.javbus.org/cover/x_b.jpg"></a>
<p><span class="header">識別碼:</span> <span style="color:#CC0000;">OLD-001</span></p>
<p><span class="header">發行日期:</span> 2015-04-24</p>`;

const MAGNET_HTML = `
<tr onmouseover="this.style.backgroundColor='#e6e6e6'" onmouseout="this.style.backgroundColor=''">
<td width="70%" onclick="window.open('magnet:?xt=urn:btih:AAAA&amp;dn=TST-014-C%20%E4%B8%AD%E6%96%87')">
<a style="color:#CC0000" href="magnet:?xt=urn:btih:AAAA&amp;dn=TST-014-C%20%E4%B8%AD%E6%96%87">
TST-014-C 中文
</a>
<a class="btn btn-mini-new btn-primary disabled" title="包含高清HD的磁力連結" href="https://www.javbus.com/genre/hd">高清</a>
<a class="btn btn-mini-new btn-warning disabled" title="包含字幕的磁力連結" href="https://www.javbus.com/genre/sub">字幕</a>
</td>
<td style="text-align:center;white-space:nowrap"><a style="color:#CC0000" href="magnet:?xt=urn:btih:AAAA">4.62GB</a></td>
<td style="text-align:center;white-space:nowrap"><a style="color:#CC0000" href="magnet:?xt=urn:btih:AAAA"> 2021-10-03 </a></td>
</tr>
<tr onmouseover="x" onmouseout="y">
<td width="70%" onclick="window.open('magnet:?xt=urn:btih:BBBB')">
<a style="color:#CC0000" href="magnet:?xt=urn:btih:BBBB">  无 dn 参数  </a>
</td>
<td><a href="magnet:?xt=urn:btih:BBBB">1.2 GB</a></td>
<td><a href="magnet:?xt=urn:btih:BBBB">2020-01-01</a></td>
</tr>
<tr style="font-weight:bold;"><td>磁力名稱</td><td>檔案大小</td><td>分享日期</td></tr>`;

const JABLE_HTML = `<h6>共 3 部影片</h6>
<div class="video-img-box"><a href="https://jable.tv/videos/tst-014/"><img data-preview="https://assets-cdn.jable.tv/x/tst-014_preview.mp4"></a></div>
<div class="detail"><a href="https://jable.tv/videos/tst-014/">TST-014</a></div>`;

// JavDB 搜索页：第一张卡片不是要找的片（搜索是模糊的），第三张没人评分
const JAVDB_HTML = `<div class="movie-list h cols-4 vcols-8">
  <div class="item">
    <a href="/v/aaa" class="box" title="测试一">
      <div class="cover "><img loading="lazy" src="https://c0.example.com/aaa.jpg" /></div>
      <div class="video-title"><strong>TST-101</strong> 测试标题一</div>
      <div class="score">
        <span class="value"><span class="score-stars"><i class="icon-star"></i><i class="icon-star gray"></i></span>
          &nbsp;
        4.13分, 由594人評價</span>
      </div>
      <div class="meta">2021-06-19</div>
    </a>
  </div>
  <div class="item">
    <a href="/v/bbb" class="box" title="测试二">
      <div class="video-title"><strong>TST-014</strong> 测试标题二</div>
      <div class="score">
        <span class="value"><span class="score-stars"><i class="icon-star"></i></span>
          &nbsp;
        4.57分, 由4217人評價</span>
      </div>
      <div class="meta">2021-02-19</div>
    </a>
  </div>
  <div class="item">
    <a href="/v/ccc" class="box" title="测试三">
      <div class="video-title"><strong>TST-015</strong> 没人评分的片</div>
      <div class="meta">2021-03-01</div>
    </a>
  </div>
</div>`;

// Google Apps Script 的错误页（真机上 toast 里整页塞进去的就是这种）：开头是一大段 ppConfig 脚本，要读的话在 body 里
const GOOGLE_ERROR_HTML = `<!DOCTYPE html><html lang="en"><head><script nonce="abc">window['ppConfig'] = {productName: '26981ed0d57bbad37e728ff58134270c', deleteIsEnforced:  false , heartbeatRate:  0.5 };(function(){var x = "<b>不是正文</b>";})();</script><meta charset="utf-8"><title>Page not found</title><style type="text/css">body {background-color: #fff;} .errorMessage {font-size: 12pt;}</style></head><body><div id="outerContainer"><div align="center"><p class="errorMessage">Sorry, unable to open the file at present.</p><p> Please check the address and try again.</p></div></div></body></html>`;

function main(): void {
  console.log("番号归一化");
  {
    check("字母数字之间补 -", normalizeKeyword("ssis001") === "ssis-001");
    check("去掉空白", normalizeKeyword("ssis 001") === "ssis-001");
    check("已经有 - 不重复补", normalizeKeyword("SSIS-001") === "SSIS-001");
    check("数字后面跟字母也补", normalizeKeyword("001abc") === "001-abc");
    check("fc 后面不补（FC2）", normalizeKeyword("fc2ppv1234567") === "fc2-ppv-1234567");
    check("fc 大小写不敏感", normalizeKeyword("FC2PPV1234567") === "FC2-PPV-1234567");
    check("普通 c 结尾不受 fc 规则影响", normalizeKeyword("abc123") === "abc-123");
    check("空串", normalizeKeyword("  ") === "");
    check("含汉字的搜索词原样返回（不去空白）", normalizeKeyword("三上 悠亜") === "三上 悠亜");
    check("含假名的搜索词原样返回（也不补连字符）", normalizeKeyword("みかみ ゆあ ssis001") === "みかみ ゆあ ssis001");
  }

  console.log("番号识别");
  {
    check("优先匹配常见厂牌", detectCode("看看 ipz 123 这个").keyword === "ipz-123");
    check("通用规则抽 3~5 字母 + 3~4 数字", detectCode("推荐 ABCD1234").keyword === "ABCD-1234");
    check("识别出来 mode=search", detectCode("SSIS-001").mode === "search");
    check("没有番号就是 home", same(detectCode("今天天气不错"), { mode: "home", keyword: "" }));
    check("太短的不算", detectCode("ab12").mode === "home");
    check("hasLink：https", hasLink("看这个 https://example.com/a"));
    check("hasLink：www", hasLink("www.example.com"));
    check("hasLink：磁力链接也算（里面全是字母数字）", hasLink("magnet:?xt=urn:btih:abc123def456"));
    check("hasLink：普通文字不算", !hasLink("SSIS-001 很好看"));
    check("URL scheme 的 code：补全并大写", normalizeCodeArg("ssis001") === "SSIS-001");
    check("URL scheme 的 code：无效返回空", normalizeCodeArg("乱七八糟") === "");
    check("shortCodeOf 取最后一段", shortCodeOf("https://www.javbus.com/SSIS-001") === "SSIS-001");
    check("shortCodeOf 忽略查询与尾斜杠", shortCodeOf("https://www.javbus.com/SSIS-001/?a=1#b") === "SSIS-001");
  }

  console.log("站点地址");
  {
    check("最新列表", listUrl("censored", 2) === "https://www.javbus.com/page/2");
    check("无码最新列表", listUrl("uncensored", 1) === "https://www.javbus.com/uncensored/page/1");
    check("欧美最新列表", listUrl("western", 3) === "https://www.javbus.org/page/3");
    check("搜索 URL 编码中文", searchUrl("censored", "三上悠亜", 1) === `https://www.javbus.com/search/${encodeURI("三上悠亜")}/1`);
    check("搜索 URL：空格换成 +", searchUrl("censored", "三上 悠亜", 1) === `https://www.javbus.com/search/${encodeURIComponent("三上")}+${encodeURIComponent("悠亜")}/1`);
    check("搜索 URL：& 和 # 要转义（encodeURI 不转）", searchUrl("censored", "a&b#c", 2) === "https://www.javbus.com/search/a%26b%23c/2");
    check("搜索 URL：普通番号不变", searchUrl("western", "ssis-001", 1) === "https://www.javbus.org/search/ssis-001/1");
    check("演员列表", actressListUrl("uncensored", 4) === "https://www.javbus.com/uncensored/actresses/4");
    check("分类总览", genreIndexUrl("censored") === "https://www.javbus.com/genre" && genreIndexUrl("uncensored") === "https://www.javbus.com/uncensored/genre");
    check("翻页拼接去尾斜杠", pagedUrl("https://www.javbus.com/genre/62/", 3) === "https://www.javbus.com/genre/62/3");
    check("相对地址按域名解析（不带 uncensored 目录）", resolveUrl("/imgs/thumbs/x.jpg", "https://www.javbus.com/uncensored/page/1") === "https://www.javbus.com/imgs/thumbs/x.jpg");
    check("绝对地址原样", resolveUrl("https://a.com/x.jpg", "https://www.javbus.com/") === "https://a.com/x.jpg");
    check("空地址返回空", resolveUrl("  ", "https://www.javbus.com/") === "");
    check("类目链接：有码", namedLink("filmMaker", "2z") === "https://www.javbus.com/studio/2z");
    check("类目链接：发行商是 label", namedLink("filmEstab", "31") === "https://www.javbus.com/label/31");
    check("类目链接：无码来源还原", namedLink("series", "q44/uncensored") === "https://www.javbus.com/uncensored/series/q44");
    check("类目 shortCode：有码", namedShortCode("https://www.javbus.com/series/q44") === "q44");
    check("类目 shortCode：无码补后缀", namedShortCode("https://www.javbus.com/uncensored/series/q44") === "q44/uncensored");
    check("类目 shortCode 与链接可来回还原", namedLink("series", namedShortCode("https://www.javbus.com/uncensored/series/q44")) === "https://www.javbus.com/uncensored/series/q44");
    check("演员链接", starLink("okq", "") === "https://www.javbus.com/star/okq" && starLink("okq", "uncensored/") === "https://www.javbus.com/uncensored/star/okq");
    check("无码判断", isUncensoredLink("https://www.javbus.com/uncensored/star/x") && !isUncensoredLink("https://www.javbus.com/star/x"));
    check("分区推断", kindOfLink("https://www.javbus.org/X") === "western" && kindOfLink("https://www.javbus.com/uncensored/X") === "uncensored" && kindOfLink("https://www.javbus.com/X") === "censored");
    check("按番号拼详情页", movieUrl("SSIS-001") === "https://www.javbus.com/SSIS-001" && movieUrl("X-1", "western") === "https://www.javbus.org/X-1");
    check("封面反推缩略图（有码）", thumbFromCover("https://www.javbus.com/pics/cover/8fdr_b.jpg") === "https://www.javbus.com/pics/thumb/8fdr.jpg");
    check("封面反推缩略图（无码）", thumbFromCover("https://www.javbus.com/imgs/cover/1r0o_b.jpg") === "https://www.javbus.com/imgs/thumbs/1r0o.jpg");
    check("反推不出来就原样", thumbFromCover("https://images.javbus.org/cover/bjy_b.jpg") === "https://images.javbus.org/cover/bjy_b.jpg");
    check("缩略图推大图（有码）", coverFromThumb("https://www.javbus.com/pics/thumb/8fdr.jpg") === "https://www.javbus.com/pics/cover/8fdr_b.jpg");
    check("缩略图推大图（无码）", coverFromThumb("https://www.javbus.com/imgs/thumbs/1r0o.jpg") === "https://www.javbus.com/imgs/cover/1r0o_b.jpg");
    check(
      "缩略图推大图和大图推缩略图互为反向",
      ["https://www.javbus.com/pics/thumb/8fdr.jpg", "https://www.javbus.com/imgs/thumbs/1r0o.jpg"].every((t) => thumbFromCover(coverFromThumb(t)) === t),
    );
    check("推不出来给空串：已经是大图、欧美站的图床规则不一样、别的格式、空串", coverFromThumb("https://www.javbus.com/pics/cover/8fdr_b.jpg") === "" && coverFromThumb("https://images.javbus.org/thumb/bjy.jpg") === "" && coverFromThumb("https://x/y.png") === "" && coverFromThumb("") === "");
    check("认大封面地址：有码 / 无码 / 欧美都认，缩略图不算", isBigCover("https://www.javbus.com/pics/cover/8fdr_b.jpg") && isBigCover("https://www.javbus.com/imgs/cover/1r0o_b.jpg") && isBigCover("https://images.javbus.org/cover/bjy_b.jpg") && !isBigCover("https://www.javbus.com/pics/thumb/8fdr.jpg") && !isBigCover(""));
    check("搜索回退：有码 → 无码", same(fallbackOrder("censored"), ["censored", "uncensored"]));
    check("搜索回退：无码 → 有码", same(fallbackOrder("uncensored"), ["uncensored", "censored"]));
    check("搜索回退：欧美 → 无码 → 有码", same(fallbackOrder("western"), ["western", "uncensored", "censored"]));
  }

  console.log("HTML 工具");
  {
    check("解实体", decodeHtml("A &amp; B &lt;C&gt; &#039;D&#39; &quot;E&quot; &#x4e2d;") === `A & B <C> 'D' "E" 中`);
    check("未知实体原样", decodeHtml("&foo;") === "&foo;");
    check("去标签压空白", stripTags("<a>  你好 \n <b>世界</b></a>") === "你好 世界");
    check("页面状态：404", is404("<h1>404 Page Not Found</h1>"));
    check("页面状态：无结果", isNoResult("<div>沒有您要的結果</div>"));
    check("页面状态：年龄验证（按 URL）", isAgeGate("", "https://www.javbus.com/doc/driver-verify?referer=x"));
    check("页面状态：年龄验证（按内容）", isAgeGate('<div class="modal show" id="ageVerify">'));
    check("普通页面不是年龄验证", !isAgeGate(LIST_HTML, "https://www.javbus.com/page/1"));
  }

  console.log("影片列表解析");
  {
    const page = parseMovieList(LIST_HTML, "https://www.javbus.com/page/1");
    check("只取有 <date> 的卡片（同類影片那种不算）", page.items.length === 2);
    const a = page.items[0];
    check("番号、日期、链接", a.code === "TST-001" && a.date === "2021-09-09" && a.link === "https://www.javbus.com/TST-001");
    check("相对封面按域名解析", a.cover === "https://www.javbus.com/pics/thumb/abcd.jpg");
    check("标题取 img 的 title", a.title === "测试影片一");
    check("高清 / 字幕标签", a.hd && a.sub);
    const b = page.items[1];
    check("标题里带「字幕」二字不算字幕标签", b.sub === false && b.hd === false);
    check("标题解实体", b.title === "带字幕二字的标题 & 其他");
    check("绝对封面原样", b.cover === "https://img.example.com/t2.jpg");
    check("不补零的日期原样保留", b.date === "2021-9-1");
    check("非 404 非无结果", !page.ended && !page.noResult);
    check("404 页", parseMovieList("404 Page Not Found", "https://www.javbus.com/page/9").ended);
    check("无结果页", parseMovieList("沒有您要的結果", "https://www.javbus.com/search/x/1").noResult);
    check("空页不抛错", parseMovieList("", "https://www.javbus.com/").items.length === 0);
  }

  console.log("演员解析");
  {
    const stars = parseStars(STAR_HTML, "https://www.javbus.com/actresses/1");
    check("两位演员", stars.length === 2);
    check("名字、链接、头像", stars[0].name === "演员甲" && stars[0].link === "https://www.javbus.com/star/okq" && stars[0].avatar === "https://www.javbus.com/pics/actress/okq_a.jpg");
    check("没头像用占位图", stars[1].avatar === "https://pics.dmm.co.jp/mono/actjpgs/nowprinting.gif");
    const info = parseActressInfo(ACTRESS_INFO_HTML);
    check("资料各项", info.birthday === "1993-08-16" && info.age === "30岁" && info.height === "159cm" && info.cup === "D");
    check("三围", info.bust === "83cm" && info.waist === "58cm" && info.hip === "85cm");
    check("缺项用问号占位", same(parseActressInfo("<html></html>"), BLANK_ACTRESS_INFO));
  }

  console.log("分类解析");
  {
    const sections = parseGenreSections(GENRE_HTML, "https://www.javbus.com/genre");
    check("两个小节，h4 带 class 的（弹窗标题）不算", sections.length === 2 && sections[0].title === "主題" && sections[1].title === "角色");
    check("类目名与链接", sections[0].items[0].name === "折磨" && sections[0].items[0].link === "https://www.javbus.com/genre/62");
    check("相对链接解析", sections[1].items[0].link === "https://www.javbus.com/genre/aa");
  }

  console.log("详情解析");
  {
    const d = parseDetail(DETAIL_HTML, "https://www.javbus.com/TST-014");
    check("识別碼、标题（img title）", d.code === "TST-014" && d.title === "测试影片十四");
    check("封面解析为绝对地址", d.cover === "https://www.javbus.com/pics/cover/8fdr_b.jpg");
    check("日期与时长", d.date === "2021-09-09" && d.minutes === 128);
    check("导演 / 制作商 / 发行商 / 系列", d.director?.name === "导演甲" && d.filmMaker?.link === "https://www.javbus.com/studio/2z" && d.filmEstab?.name === "发行商甲" && d.series?.link === "https://www.javbus.com/series/q44");
    check("类别（「多選提交」按钮不算）", same(d.genres.map((g) => g.name), ["类别一", "类别二"]));
    check("参演与占位头像", d.stars.length === 2 && d.stars[1].avatar === "https://pics.dmm.co.jp/mono/actjpgs/nowprinting.gif");
    check("样品图：大图 + 缩略图都解析为绝对地址", d.samples.length === 2 && d.samples[0].full === "https://pics.dmm.co.jp/digital/video/tst00014/tst00014jp-1.jpg" && d.samples[0].thumb === "https://www.javbus.com/pics/sample/8fdr_1.jpg" && d.samples[1].full === "https://www.javbus.com/pics/sample/8fdr_2_big.jpg");
    check("磁链参数", same(d.magnetParams, { gid: "47432801251", uc: "0", img: "/pics/cover/8fdr_b.jpg", lang: "zh" }));
    check("详情 link 是传入地址", d.link === "https://www.javbus.com/TST-014");

    const old = parseDetail(OLD_DETAIL_HTML, "https://www.javbus.org/OLD-001");
    check("旧版：标题在 a 上", old.title === "旧版标题");
    check("缺字段给空值而不是抛错", old.director === null && old.series === null && old.minutes === null && old.genres.length === 0 && old.samples.length === 0);
    check("缺磁链参数为 null", old.magnetParams === null);

    const none = parseDetail("<html>nothing</html>", "https://www.javbus.com/ZZZ-999");
    check("整页都不是详情：不抛错，识别码退回链接", none.code === "ZZZ-999" && none.cover === "" && none.title === "");
    check("磁链参数：单引号 / 双引号都认", parseMagnetParams('var gid = 12; var img = "x.jpg"; var uc = 1;')?.img === "x.jpg");
  }

  console.log("磁链解析");
  {
    const magnets = parseMagnets(MAGNET_HTML);
    check("表头行跳过，两条磁链", magnets.length === 2);
    const m = magnets[0];
    check("磁链 &amp; 还原", m.link === "magnet:?xt=urn:btih:AAAA&dn=TST-014-C%20%E4%B8%AD%E6%96%87");
    check("名字取链接文字", m.name === "TST-014-C 中文");
    check("大小与日期按单元格取（标签带 href 也不错位）", m.size === "4.62GB" && m.date === "2021-10-03");
    check("高清 / 字幕", m.hd && m.sub);
    const n = magnets[1];
    check("没有 dn 参数不抛错", n.link === "magnet:?xt=urn:btih:BBBB" && n.name === "无 dn 参数");
    check("大小里的空格去掉", n.size === "1.2GB" && !n.hd && !n.sub);
    check("magnetName：dn 解码", magnetName("magnet:?xt=urn:btih:X&dn=%E4%B8%AD+%E6%96%87") === "中 文");
    check("magnetName：无 dn 用哈希", magnetName("magnet:?xt=urn:btih:abc123") === "abc123");
    check("空响应", parseMagnets("").length === 0);
    const nameOnly = parseMagnets(`<tr><td><a href="magnet:?xt=urn:btih:CCCC&dn=X-1-%E4%B8%AD%E6%96%87%E5%AD%97%E5%B9%95">X-1 中文字幕 高清版</a></td><td>1GB</td><td>2020-01-01</td></tr>`);
    check("名字里带「中文字幕 / 高清」但没有标签：不标", nameOnly.length === 1 && !nameOnly[0].hd && !nameOnly[0].sub);
    const tagged = parseMagnets(`<tr><td><a href="magnet:?xt=urn:btih:DDDD">普通名字</a> <a class="btn disabled" title="包含字幕的磁力連結">字幕</a></td><td>1GB</td><td>2020-01-01</td></tr>`);
    check("有标签按钮：标", tagged[0].sub === true && tagged[0].hd === false);
  }

  console.log("其他站点解析");
  {
    check("JavDB 评分文字", same(parseScoreText("4.36分, 由1234人評價"), { score: "4.36", count: "1234" }));
    check("JavDB 评分文字：没评分", parseScoreText("暂无评分") === null);
    const cards = parseJavdbCards(JAVDB_HTML);
    check("JavDB 卡片：按卡片切开，番号取标题里加粗的部分", same(cards.map((c) => c.code), ["TST-101", "TST-014", "TST-015"]));
    check("JavDB 卡片：评分取自己那张（带 &nbsp; 和星星图标）", same(cards[0].rating, { score: "4.13", count: "594" }) && same(cards[1].rating, { score: "4.57", count: "4217" }));
    check("JavDB 卡片：没评分的是 null，不借下一张的", cards[2].rating === null);
    check("JavDB 挑选：按番号精确匹配，不取第一张", same(pickJavdbRating(cards, "TST-014"), { score: "4.57", count: "4217" }));
    check("JavDB 挑选：大小写和连字符不敏感", same(pickJavdbRating(cards, "tst014"), { score: "4.57", count: "4217" }));
    check("JavDB 挑选：匹配到的那张没评分就是没评分", pickJavdbRating(cards, "TST-015") === null);
    check("JavDB 挑选：多张都对不上 = 没有，不显示成别的片的评分", pickJavdbRating(cards, "ZZZ-999") === null);
    check("JavDB 挑选：只有一张又对不上，用它（番号写法偶有差异）", same(pickJavdbRating([cards[1]], "TST-14"), { score: "4.57", count: "4217" }));
    check("JavDB 屏蔽页（异常行为）能认出来", isJavdbBlocked("<html><body>偵測到異常行為，請稍後再試</body></html>") && !isJavdbBlocked(JAVDB_HTML));
    check("JavDB 卡片：不是搜索页 = 没有卡片", parseJavdbCards("<html><title>Just a moment...</title></html>").length === 0);
    const jable = parseJableSearch(JABLE_HTML);
    check("Jable 搜索：播放页与预览", jable?.videoUrl === "https://jable.tv/videos/tst-014/" && jable?.preview === "https://assets-cdn.jable.tv/x/tst-014_preview.mp4");
    check("Jable 搜索：无「部影片」即无结果", parseJableSearch("<div>没有</div>") === null);
    check("Jable hls", parseJableHls("var hlsUrl = 'https://x.com/a/index.m3u8';") === "https://x.com/a/index.m3u8");
    check("Jable hls 缺失", parseJableHls("nothing") === null);
    check("Missav：明文清单地址", findMissavHls('x "https://surrit.com/12345678-1234-1234-1234-123456789abc/playlist.m3u8" y') === "https://surrit.com/12345678-1234-1234-1234-123456789abc/playlist.m3u8");
    check("Missav：packed 参数倒序拼 uuid", findMissavHls("a|m3u8|123456789abc|1234|1234|1234|12345678|com|surrit|https|video|b") === "https://surrit.com/12345678-1234-1234-1234-123456789abc/playlist.m3u8");
    check("Missav：找不到返回 null", findMissavHls("<html></html>") === null);
  }

  console.log("收藏库");
  {
    const movie = (code: string, extra: Partial<FavMovie> = {}): FavMovie => ({ code, src: `s-${code}`, info: `${code} | 2021-01-01`, shortCode: code, ...extra });
    let lib = emptyLibrary();
    lib = addFavorite(lib, movie("A-1"));
    lib = addFavorite(lib, movie("A-2"));
    check("新收藏排最前", lib.favorite[0].code === "A-2");
    check("重复收藏无效", addFavorite(lib, movie("A-2")).favorite.length === 2);
    check("状态：收藏", movieStatus(lib, "A-1") === "favorite");
    lib = archiveMovie(lib, movie("A-1"));
    check("归档：从收藏拿掉、进归档", movieStatus(lib, "A-1") === "archived" && lib.favorite.length === 1);
    check("没在收藏里的也能直接归档", movieStatus(archiveMovie(lib, movie("B-9")), "B-9") === "archived");
    lib = removeArchived(lib, "A-1");
    check("删除归档", movieStatus(lib, "A-1") === "none");
    lib = removeFavorite(lib, "A-2");
    check("取消收藏", lib.favorite.length === 0);

    // 旧数据里 shortCode 和番号对不上（原版有的入口把番号当 shortCode 存）：取消 / 归档必须两个都认
    const skewed = addFavorite(emptyLibrary(), movie("X-1", { shortCode: "x-1-tail" }));
    check("取消收藏：shortCode 对不上时凭番号也能删", removeFavorite(skewed, "X-1", "X-1").favorite.length === 0);
    check("取消收藏：只给 shortCode 时不误删别的", removeFavorite(skewed, "other").favorite.length === 1);
    const archivedSkew = archiveMovie(skewed, movie("X-1"));
    check("归档：凭番号把旧条目从收藏拿走，不留两份", archivedSkew.favorite.length === 0 && archivedSkew.archive.length === 1);
    check("删除归档：凭番号也能删", removeArchived(archivedSkew, "nope", "X-1").archive.length === 0);

    lib = addActress(lib, { src: "a", info: "演员甲", shortCode: "okq", un: "" });
    check("演员收藏 / 去重 / 取消", hasActress(lib, "okq") && addActress(lib, { src: "a", info: "x", shortCode: "okq", un: "" }).actress.length === 1);
    lib = addNamed(lib, "series", { name: "系列甲", shortCode: "q44" });
    check("类目收藏", hasNamed(lib, "series", "q44") && !hasNamed(lib, "director", "q44"));
    check("类目取消", !hasNamed(removeNamed(lib, "series", "q44"), "series", "q44"));

    const legacy = {
      favorite: [
        { code: "OLD-1", src: "x", info: "OLD-1 | 2020-1-1", shortCode: "OLD-1" },
        { code: "OLD-1", src: "dup", info: "dup", shortCode: "OLD-1" },
        { code: "NO-KEY" },
        "garbage",
      ],
      actress: [{ src: "a", source: { url: "a", header: {} }, info: "演员", shortCode: "aaa", un: "uncensored/" }],
      archive: [],
      director: [],
      filmMaker: [],
      filmEstab: [],
    };
    const cleaned = normalizeLibrary(legacy);
    check("原版备份：去重、丢坏条目", cleaned.favorite.length === 2 && cleaned.favorite[0].code === "OLD-1");
    check("缺 shortCode 的条目退回 code", cleaned.favorite[1].shortCode === "NO-KEY");
    check("原版备份没有 series：补空数组", Array.isArray(cleaned.series) && cleaned.series.length === 0);
    check("演员条目去掉多余的 source 字段", !("source" in cleaned.actress[0]) && cleaned.actress[0].un === "uncensored/");
    const htmlAvatar = normalizeLibrary({
      actress: [
        { shortCode: "a1", src: '<a class="avatar-box" href="x"><img src="https://img.example.com/a.jpg" title="n"></a>', info: "甲", un: "" },
        { shortCode: "a2", src: "<a>没有图</a>", info: "乙", un: "" },
        { shortCode: "a3", src: " https://img.example.com/ok.jpg ", info: "丙", un: "" },
      ],
    });
    check("旧备份里整段 HTML 的头像：能抠出 img 地址就用", htmlAvatar.actress[0].src === "https://img.example.com/a.jpg");
    check("抠不出就置空；正常地址去首尾空白", htmlAvatar.actress[1].src === "" && htmlAvatar.actress[2].src === "https://img.example.com/ok.jpg");
    check("非法 un 归一成空串", normalizeLibrary({ actress: [{ shortCode: "z", un: "weird" }] }).actress[0].un === "");
    check("垃圾输入得到空库", same(normalizeLibrary(null), emptyLibrary()) && same(normalizeLibrary("x"), emptyLibrary()));
    check("looksLikeBackup", looksLikeBackup(legacy) && !looksLikeBackup({ foo: 1 }) && !looksLikeBackup(null) && !looksLikeBackup([]));

    const mine = addFavorite(archiveMovie(emptyLibrary(), movie("ARC-1")), movie("FAV-1"));
    const theirs = normalizeLibrary({
      favorite: [movie("FAV-1"), movie("ARC-1"), movie("NEW-1")],
      archive: [movie("NEW-2")],
      actress: [{ src: "a", info: "x", shortCode: "okq", un: "" }],
    });
    const merged = mergeLibrary(mine, theirs);
    check("合并：本机已有的保持原位", merged.favorite[0].code === "FAV-1");
    check("合并：备份里新的追加在后", same(merged.favorite.map((m) => m.code), ["FAV-1", "NEW-1"]));
    check("合并：本机已归档的不会因备份又回到收藏", movieStatus(merged, "ARC-1") === "archived");
    check("合并：归档、演员也并入", merged.archive.some((m) => m.code === "NEW-2") && merged.actress.length === 1);

    // ———— 我的精选（picks）：归档里自己标的好片 ————
    let pl = emptyLibrary();
    pl = addFavorite(pl, movie("FAV-1"));
    for (const code of ["P-1", "P-2", "P-3"]) pl = archiveMovie(pl, movie(code));
    check("精选：空库、没标过 = 空", emptyLibrary().picks.length === 0 && pickState(pl, "P-1") === "off");
    check("精选：不在归档里的片（收藏里的、库外的）不能标", pickState(pl, "FAV-1") === "unavailable" && pickState(pl, "NOPE") === "unavailable" && setPicked(pl, "FAV-1", undefined, true) === pl && setPicked(pl, "NOPE", undefined, true) === pl);
    pl = setPicked(pl, "P-1", undefined, true);
    pl = setPicked(pl, "P-3", "P-3", true);
    check("精选：标上以后状态是 on，最近标的排最前", pickState(pl, "P-1") === "on" && pickState(pl, "P-2") === "off" && same(pl.picks, ["P-3", "P-1"]));
    check("精选：重复标 / 重复取消原样返回（不触发存盘）", setPicked(pl, "P-1", undefined, true) === pl && setPicked(pl, "P-2", undefined, false) === pl);
    check("精选：我的精选按标的先后排成归档里的片", same(pickedMovies(pl).map((m) => m.code), ["P-3", "P-1"]));
    check("精选：取消", same(setPicked(pl, "P-3", undefined, false).picks, ["P-1"]));
    check("精选：标记不动收藏和归档本身", pl.archive.length === 3 && pl.favorite.length === 1);
    const skewPick = archiveMovie(emptyLibrary(), movie("X-9", { shortCode: "x-9-tail" }));
    const skewPicked = setPicked(skewPick, "other", "X-9", true);
    check("精选：旧数据 shortCode 和番号对不上，凭番号也能标，存的是归档条目的 shortCode", same(skewPicked.picks, ["x-9-tail"]) && pickState(skewPicked, "x-9-tail") === "on" && pickState(skewPicked, "zzz", "X-9") === "on");
    check("精选：findArchived 两个都认", findArchived(skewPick, "x-9-tail")?.code === "X-9" && findArchived(skewPick, "zzz", "X-9")?.code === "X-9" && findArchived(skewPick, "zzz") === undefined);

    const afterDelete = removeArchived(pl, "P-1");
    check("精选：删除归档的同时精选也没了（再归档回来不会自己带着星）", same(afterDelete.picks, ["P-3"]) && pickState(archiveMovie(afterDelete, movie("P-1")), "P-1") === "off");
    check("精选：删除别的片，精选列表保持原引用", removeArchived(pl, "P-2").picks === pl.picks);
    check("精选：凭番号删除归档也会带走精选", removeArchived(skewPicked, "nope", "X-9").picks.length === 0);
    check("精选：重新归档同一部（shortCode 变了）也保持精选 ⊆ 归档", archiveMovie(skewPicked, movie("X-9", { shortCode: "x-9-new" })).picks.length === 0);

    const json = JSON.parse(JSON.stringify(pl));
    check("精选：导出（JSON）里带 picks，导入后原样还原", same(json.picks, ["P-3", "P-1"]) && same(normalizeLibrary(json).picks, ["P-3", "P-1"]));
    check("精选：原版备份没有 picks：补空；不是数组也补空", same(normalizeLibrary(legacy).picks, []) && same(normalizeLibrary({ archive: [movie("A")], picks: "A" }).picks, []));
    check(
      "精选：导入时洗掉不在归档里的、重复的、非字符串的、空白的",
      same(normalizeLibrary({ archive: [movie("A"), movie("B")], favorite: [movie("C")], picks: ["B", "B", "C", "zzz", 7, "  ", " A "] }).picks, ["B", "A"]),
    );
    const mergedPicks = mergeLibrary(
      pl,
      normalizeLibrary({ archive: [movie("P-1"), movie("Q-1"), movie("FAV-1")], picks: ["Q-1", "P-1", "FAV-1"] }),
    );
    check("精选：合并 = 本机的在前、备份里新的追加", same(mergedPicks.picks, ["P-3", "P-1", "Q-1"]), JSON.stringify(mergedPicks.picks));
    check("精选：合并时备份里因「本机以收藏为准」没进归档的片，它的精选也不要", !mergedPicks.picks.includes("FAV-1") && movieStatus(mergedPicks, "FAV-1") === "favorite");
    check("精选：计入各表条数", libraryCounts(pl).picks === 2 && libraryCounts(emptyLibrary()).picks === 0);
  }

  console.log("MovieRef 与收藏记录");
  {
    const item = { code: "TST-001", link: "https://www.javbus.com/TST-001", cover: "https://c/x.jpg", title: "t", date: "2021-09-09", hd: false, sub: false };
    const ref = refFromItem(item);
    check("列表 → ref", ref.info === "TST-001 | 2021-09-09" && ref.context === "browse" && !ref.guessed);
    const rec = refFromRec({ code: "R-1", info: "R-1 | 2026-6-11", src: "s", link: "https://www.javbus.com/R-1" });
    check("推荐 → ref", rec.context === "recommend" && rec.cover === "s");
    const legacyFav = refFromFav({ code: "L-1", src: "x", info: "L-1 | d", shortCode: "L-1" }, "favorites");
    check("旧收藏没链接：猜链接并标记", legacyFav.link === "https://www.javbus.com/L-1" && legacyFav.guessed === true);
    const newFav = refFromFav({ code: "N-1", src: "x", info: "i", shortCode: "N-1", link: "https://www.javbus.org/N-1" }, "archive");
    check("新收藏有链接：不是猜的", newFav.link === "https://www.javbus.org/N-1" && newFav.guessed === false && newFav.context === "archive");
    check("存着兜底封面的收藏还原成兜底详情", refFromFav({ code: "F-1", src: FALLBACK_THUMB, info: "i", shortCode: "F-1" }, "favorites").fallback === true);
    const byCode = refFromCode("SSIS-001");
    check("按番号直开：猜链接", byCode.link === "https://www.javbus.com/SSIS-001" && byCode.guessed === true);
    const fb = fallbackRef("xyz-123");
    check("兜底 ref：番号大写、日期未知写 0000-00-00", fb.fallback === true && fb.cover === FALLBACK_THUMB && fb.code === "XYZ-123" && fb.info === `XYZ-123 | ${UNKNOWN_DATE}` && UNKNOWN_DATE === "0000-00-00");
    check("兜底 ref：也可以指定日期", fallbackRef("XYZ-123", "2026-10-22").info === "XYZ-123 | 2026-10-22");

    const detail = { code: "TST-001", date: "2021-09-09", cover: "https://www.javbus.com/pics/cover/abcd_b.jpg" } as MovieDetail;
    const fav = favMovieOf(ref, detail);
    check("收藏记录：shortCode 取链接末段、带 link", fav.shortCode === "TST-001" && fav.link === "https://www.javbus.com/TST-001" && fav.src === "https://c/x.jpg");
    const actual = favMovieOf(refFromCode("TST-001"), { ...detail, link: "https://www.javbus.org/TST-001" });
    check("收藏记录：链接以详情页实际取到的地址为准（猜的 .com 取不到、换 .org 才成功时）", actual.link === "https://www.javbus.org/TST-001");
    check("收藏记录：日期以详情页为准", favMovieOf(rec, { ...detail, code: "R-1", date: "2020-02-02" }).info === "R-1 | 2020-02-02");
    check("没有列表封面就从大图反推缩略图", favMovieOf(refFromCode("TST-001"), detail).src === "https://www.javbus.com/pics/thumb/abcd.jpg");
    const fbFav = favMovieOf(fb, null);
    check("兜底详情的收藏：shortCode 是番号、不存 link", fbFav.shortCode === "XYZ-123" && fbFav.link === undefined && fbFav.src === FALLBACK_THUMB);
  }

  console.log("详情页「播放」按钮挑片源");
  {
    const none: Previews = { missav: null, jable: null, jableHls: null, missavFull: null };
    const p = (extra: Partial<Previews>): Previews => ({ ...none, ...extra });
    check("什么都没有 = null", pickBestSource(none) === null);
    check("只有 Jable 预览", same(pickBestSource(p({ jable: { videoUrl: "v", preview: "jp" } })), { url: "jp", label: "Jable 预览" }));
    check("MissAV 预览优先于 Jable 预览", pickBestSource(p({ missav: "mp", jable: { videoUrl: "v", preview: "jp" } }))?.url === "mp");
    check("完整视频优先于预览", pickBestSource(p({ missav: "mp", jableHls: "jh" }))?.label === "Jable 完整视频");
    check("MissAV 完整视频最优先", pickBestSource(p({ missavFull: "mf", jableHls: "jh", missav: "mp" }))?.label === "MissAV 完整视频");
    check(
      "完整视频带 full 标记、预览不带（只有完整视频才有字幕按钮）",
      pickBestSource(p({ missavFull: "mf" }))?.full === true && pickBestSource(p({ jableHls: "jh" }))?.full === true && pickBestSource(p({ missav: "mp" }))?.full === undefined,
    );
    check("Jable 命中但没有预览地址 = 没有预览", pickBestSource(p({ jable: { videoUrl: "v", preview: "" } })) === null);
    check("两路预览任何一路没回来 = 还在探测", isProbing({ ...none, missav: undefined }) && isProbing({ ...none, jable: undefined }));
    check("两路预览都有结果就不算探测中（完整视频的 undefined 不影响）", !isProbing({ missav: null, jable: null, jableHls: undefined, missavFull: undefined }));
    check("Jable 命中后取完整视频地址那一步也算探测中", isProbing({ missav: null, jable: { videoUrl: "v", preview: "" }, jableHls: undefined, missavFull: null }));
    check("Jable 完整视频地址取完（成功或没有）就不算探测中", !isProbing({ missav: null, jable: { videoUrl: "v", preview: "" }, jableHls: null, missavFull: null }) && !isProbing({ missav: null, jable: { videoUrl: "v", preview: "" }, jableHls: "jh", missavFull: null }));
    check("副标题：Jable 命中但完整视频地址还在取时写「正在探测」，不是 Fanza 退路", playSubline({ missav: null, jable: { videoUrl: "v", preview: "" }, jableHls: undefined, missavFull: null }, null) === "正在探测片源…");
    check("副标题：正在播放", playSubline(none, "MissAV 预览") === "正在播放 · MissAV 预览");
    check("副标题：点下去会放什么", playSubline(p({ missav: "mp" }), null) === "MissAV 预览");
    check("副标题：还在探测", playSubline({ missav: undefined, jable: undefined, jableHls: undefined, missavFull: undefined }, null) === "正在探测片源…");
    check("副标题：什么都没找到时的退路", playSubline(none, null) === "试试 Fanza 预告");
  }

  console.log("详情页主按钮阶段");
  {
    const phases = (context: DetailContext) => (["none", "favorite", "archived"] as const).map((status) => initialPhase(context, status));
    check("浏览入口：未收藏 → 收藏，已收藏 → 取消收藏，已归档 → 已归档", same(phases("browse"), ["add", "cancel", "archived"]));
    check("推荐入口同浏览：已收藏也先告诉你收藏了，不给「归档」", same(phases("recommend"), ["add", "cancel", "archived"]));
    check("收藏 Tab：已收藏给「归档」", same(phases("favorites"), ["add", "archive", "archived"]));
    check("归档 Tab：已归档给「删除」，其余说明已经删了", same(phases("archive"), ["deleted", "deleted", "delete"]));
    check("收藏 ⇄ 取消收藏 来回切；推荐页点「收藏」后是「取消收藏」，不是「归档」", initialPhase("recommend", "none") === "add" && nextPhase("add") === "cancel" && nextPhase("cancel") === "add");
    check("归档 → 已归档、删除 → 已删除，到头不再变", nextPhase("archive") === "archived" && nextPhase("delete") === "deleted" && nextPhase("archived") === "archived" && nextPhase("deleted") === "deleted");
  }

  console.log("推荐载荷");
  {
    const cleaned = cleanRecList([
      { code: "A-1", info: "A-1 | 2026-1-1", src: "s", link: "https://l/A-1" },
      { code: "A-1", info: "dup", src: "s", link: "https://l/A-1" },
      { code: "B-2", link: "https://l/B-2" },
      { code: "C-3" },
      "x",
    ]);
    check("清洗推荐列表：去重、丢缺字段、补默认", cleaned.length === 2 && cleaned[1].info === "B-2" && cleaned[1].src === "");
    check("非数组得到空列表", cleanRecList({ a: 1 }).length === 0);
    check("上传载荷（网友）", same(buildPayload("upload", { code: "A-1", info: "i", src: "s", link: "l" }), { av: { code: "A-1", info: "i", src: "s", link: "l" }, mode: "upload" }));
    check("删除载荷带密码", same(buildPayload("del", "A-1", "1234"), { av: "A-1", mode: "del", pw: "1234" }));
    check("返回码：成功", describeUploadResult("succeed").ok);
    check("返回码：格式错误", describeUploadResult("FE").message === "上传格式错误！");
    check("返回码：已在列表", describeUploadResult("RE").message === "该影片已在推荐列表！");
    check("返回码：密码错误", describeUploadResult("NA").message === "密码错误！");
    const unknown = describeUploadResult(" boom ");
    check("未知返回码：给出代码并要求复制", !unknown.ok && unknown.message === "错误代码：boom" && unknown.copy === "boom");
    check("服务地址：空串 / 空白退回默认", pickServiceUrl("", "D") === "D" && pickServiceUrl("   ", "D") === "D");
    check("服务地址：以前版本的默认地址（用户没动过）换成当前默认", RETIRED_SERVICE_URLS.length > 0 && RETIRED_SERVICE_URLS.every((u) => pickServiceUrl(u, REC_UPLOAD_AUTHOR) === REC_UPLOAD_AUTHOR) && !RETIRED_SERVICE_URLS.includes(REC_UPLOAD_AUTHOR));
    check("服务地址：用户自己填的原样保留（去首尾空白）", pickServiceUrl("  https://my.example/exec ", "D") === "https://my.example/exec");
    check("looksLikeHtml", looksLikeHtml("<!DOCTYPE html><html>") && looksLikeHtml("\n  <html lang='en'>") && !looksLikeHtml("succeed") && !looksLikeHtml("x <html>"));
    check("visibleText：去脚本、样式、标签，解实体", visibleText("<style>a{}</style><script>var a='<b>x</b>'</script><p>你好 &amp; 再见</p>") === "你好 & 再见");
    const page = describeUploadResult(GOOGLE_ERROR_HTML);
    check("服务端回错误页：提示是一句话，不把网页塞进去", !page.ok && page.message === "推荐服务返回了错误页");
    check("服务端回错误页：可见文字给出，脚本不在里面", !!page.serviceError?.includes("Sorry, unable to open the file at present.") && !page.serviceError.includes("ppConfig") && !page.serviceError.includes("productName") && !page.serviceError.includes("<"));
    check("服务端回错误页：剪贴板里只放可见文字", page.copy === page.serviceError);
    check("服务端回错误页：没有可读文字也有交代", describeUploadResult("<html><script>1</script></html>").serviceError === "（页面没有可读的文字）");
    const long = describeUploadResult("x".repeat(500));
    check("很长的未知返回码：提示截断、剪贴板完整", long.message === `错误代码：${"x".repeat(120)}` && long.copy?.length === 500 && long.serviceError === undefined);
  }

  console.log("社区推荐服务：地址、返回码、举报、测试连接");
  {
    check("地址规整：去首尾空白和末尾斜杠", normalizeCommunityUrl("  https://jc.example.workers.dev/// ") === "https://jc.example.workers.dev");
    check("地址规整：带路径前缀 / 端口 / http 都行", normalizeCommunityUrl("https://example.com/jc/") === "https://example.com/jc" && normalizeCommunityUrl("http://192.168.1.2:8787") === "http://192.168.1.2:8787");
    check(
      "地址规整：不是 http(s) 地址、带查询串 / 空格、只有协议头 → 空串（= 不用社区服务）",
      ["", "   ", "jc.example.workers.dev", "ftp://x.com", "https://x.com?a=1", "https://x.com/a b", "https://", "javascript:alert(1)"].every((v) => normalizeCommunityUrl(v) === ""),
    );
    const endpoints = communityEndpoints("https://jc.example.workers.dev");
    check(
      "四个接口地址都在 /api/v1 下",
      same(endpoints, {
        recAuthor: "https://jc.example.workers.dev/api/v1/rec/author",
        recUser: "https://jc.example.workers.dev/api/v1/rec/user",
        uploadAuthor: "https://jc.example.workers.dev/api/v1/upload/author",
        uploadUser: "https://jc.example.workers.dev/api/v1/upload/user",
      }),
    );
    const legacy = { communityUrl: "", recUrlAuthor: "A", recUrlUser: "B", uploadUrlAuthor: "C", uploadUrlUser: "D" };
    const legacyUrls = { recAuthor: "A", recUser: "B", uploadAuthor: "C", uploadUser: "D" };
    const withCommunity = { ...legacy, communityUrl: "https://jc.example.workers.dev/" };
    check("没填社区地址：用设置里的四个", same(resolveServiceUrls(legacy), legacyUrls));
    check(
      "填了社区地址：网友推荐的列表和上传走社区，作者精选照旧用设置里的（原作者的）",
      same(resolveServiceUrls(withCommunity), { recAuthor: "A", recUser: endpoints.recUser, uploadAuthor: "C", uploadUser: endpoints.uploadUser }),
    );
    check("以后把作者精选也交给社区服务：四个都走它", same(resolveServiceUrls(withCommunity, ["user", "author"]), endpoints));
    check("没有频道归社区服务管：填了地址也不用", same(resolveServiceUrls(withCommunity, []), legacyUrls));
    check("社区地址不合格当没填", same(resolveServiceUrls({ ...legacy, communityUrl: "nope" }), legacyUrls));
    check(
      "按频道判断走不走社区：网友推荐走、作者精选不走；地址为空或不合格都不走",
      channelUsesCommunity("user", "https://jc.example.workers.dev") &&
        !channelUsesCommunity("author", "https://jc.example.workers.dev") &&
        channelUsesCommunity("author", "https://jc.example.workers.dev", ["user", "author"]) &&
        !channelUsesCommunity("user", "") &&
        !channelUsesCommunity("user", "nope"),
    );
    check("出厂设置：社区服务只接管网友推荐", same(COMMUNITY_CHANNELS, ["user"]));
    check("出厂默认地址是部署好的那个，已经是规整过的样子（不带末尾斜杠）", COMMUNITY_URL === "https://javbus-community.javbuss.workers.dev" && normalizeCommunityUrl(COMMUNITY_URL) === COMMUNITY_URL);

    const pending = describeUploadResult("PD");
    check("返回码 PD：算成功，说明要等审核", pending.ok && pending.code === "PD" && pending.message.includes("审核"));
    check("返回码 RL / BN / OFF / NF / FULL：都不算成功，各有各的话", [
      ["RL", "太频繁"],
      ["BN", "封禁"],
      ["OFF", "暂停收稿"],
      ["NF", "没有找到"],
      ["FULL", "已满"],
    ].every(([code, word]) => {
      const outcome = describeUploadResult(code);
      return !outcome.ok && outcome.code === code && outcome.message.includes(word) && outcome.copy === undefined;
    }));
    check("NA：原作者的服务是「密码错误」，社区服务里还可能是「不是你提交的」", describeUploadResult("NA").message === "密码错误！" && describeUploadResult("NA", true).message.includes("不是你提交"));
    check("认得的返回码都带 code（界面据此决定下一步），不认识的没有", describeUploadResult("succeed").code === "succeed" && describeUploadResult("NA", true).code === "NA" && describeUploadResult("boom").code === undefined && describeUploadResult(GOOGLE_ERROR_HTML).code === undefined);
    check("社区服务也会回整页 HTML（比如反向代理的错误页），照样只给可见文字", describeUploadResult("<html><body>Bad gateway</body></html>", true).serviceError === "Bad gateway");

    check("举报原因：四种，顺序固定，每种有中文名", same(REPORT_REASONS.map((r) => r.reason), ["dead", "inappropriate", "duplicate", "other"]) && REPORT_REASONS.every((r) => r.label.length > 0));
    check("举报载荷", same(buildReport("user", "ABC-123", "dead"), { channel: "user", code: "ABC-123", reason: "dead" }));
    check("举报返回码：succeed 成功", describeReportResult("succeed").ok);
    check("举报返回码：NF / RL / BN / FE 各有提示且不算成功", ["NF", "RL", "BN", "FE"].every((code) => {
      const outcome = describeReportResult(code);
      return !outcome.ok && outcome.code === code && outcome.message.length > 0;
    }));
    check("举报返回码：不认识的给出代码并要求复制", describeReportResult(" ??? ").copy === "???");

    const meta = { name: "JavBus 社区推荐", version: "1.0.0", maintenance: false, autoApprove: true, channels: { user: 120, author: 35 } };
    check("测试连接：认得社区服务，给出名字和网友推荐的条数（作者精选不走它，不报）", same(describeMeta(meta), { ok: true, message: "连接成功：JavBus 社区推荐（网友推荐 120 条）" }));
    check("测试连接：两份都交给社区服务时两份都报", describeMeta(meta, ["user", "author"]).message === "连接成功：JavBus 社区推荐（网友推荐 120 条 · 作者精选 35 条）");
    check("测试连接：暂停收稿 / 要审核会提醒", describeMeta({ ...meta, maintenance: true }).message === "连接成功：JavBus 社区推荐（网友推荐 120 条，当前暂停收稿）" && describeMeta({ ...meta, autoApprove: false }).message.includes("需要审核"));
    check(
      "测试连接：不是社区服务返回的（别的网站、地址填错、空对象、数组）→ 不通过",
      [null, [], {}, "x", 42, { name: "x" }, { name: "x", version: "1", channels: null }, { message: "404: Not Found" }].every((raw) => {
        const result = describeMeta(raw);
        return !result.ok && result.message.includes("不是社区推荐服务");
      }),
    );
  }

  console.log("外部播放器");
  {
    const media = "http://192.168.31.8/video/test.mov";
    const encoded = "http%3A%2F%2F192.168.31.8%2Fvideo%2Ftest.mov";
    check("Infuse：url 参数整体编码", launchUrl("infuse", media) === `infuse://x-callback-url/play?url=${encoded}`);
    check("SenPlayer：同样的写法，换个 scheme", launchUrl("senplayer", media) === `senplayer://x-callback-url/play?url=${encoded}`);
    const subtitle = "http://192.168.31.8/video/subtitle.ass";
    check(
      "SenPlayer 带外挂字幕：多一个 &sub=，值和 url 一样整体编码",
      launchUrl("senplayer", media, "", subtitle) === `senplayer://x-callback-url/play?url=${encoded}&sub=http%3A%2F%2F192.168.31.8%2Fvideo%2Fsubtitle.ass`,
    );
    check("SenPlayer 没有字幕（空串）时和以前一模一样", launchUrl("senplayer", media, "", "") === launchUrl("senplayer", media));
    check("字幕地址里的 ? & = 也编码，不会串成别的参数", launchUrl("senplayer", media, "", "https://x/a.srt?k=1&t=2")?.endsWith("&sub=https%3A%2F%2Fx%2Fa.srt%3Fk%3D1%26t%3D2") === true);
    check(
      "别的播放器忽略字幕（只接了 SenPlayer）：Infuse / VLC / nPlayer / 自定义都和不带字幕时一样",
      launchUrl("infuse", media, "", subtitle) === launchUrl("infuse", media) &&
        launchUrl("vlc", media, "", subtitle) === launchUrl("vlc", media) &&
        launchUrl("nplayer", media, "", subtitle) === launchUrl("nplayer", media) &&
        launchUrl("custom", media, "nplayer-{raw}", subtitle) === "nplayer-http://192.168.31.8/video/test.mov",
    );
    check("只有 SenPlayer 标了接外挂字幕", same(EXTERNAL_PLAYERS.filter((p) => p.subtitle).map((p) => p.id), ["senplayer"]));    check("VLC：vlc-x-callback 的 stream", launchUrl("vlc", media) === `vlc-x-callback://x-callback-url/stream?url=${encoded}`);
    check("nPlayer：前缀 + 原地址，不编码", launchUrl("nplayer", media) === "nplayer-http://192.168.31.8/video/test.mov");
    check("自定义 {url}：和内置 SenPlayer 等价", launchUrl("custom", media, "senplayer://x-callback-url/play?url={url}") === launchUrl("senplayer", media));
    check("自定义 {raw}：原样", launchUrl("custom", media, "nplayer-{raw}") === "nplayer-http://192.168.31.8/video/test.mov");
    check("自定义：两种占位符混用，出现几次换几次", launchUrl("custom", "http://a/b", "x://{raw}?u={url}&v={url}") === "x://http://a/b?u=http%3A%2F%2Fa%2Fb&v=http%3A%2F%2Fa%2Fb");
    check("自定义：模板里没有占位符 = 不行（写死一个地址，每部片打开的都是同一个）", launchUrl("custom", media, "senplayer://x-callback-url/play?url=http://192.168.31.8/video/test.mov") === null && launchUrl("custom", media, "") === null);
    check("自定义：模板首尾空白去掉", launchUrl("custom", media, "  nplayer-{raw}\n") === "nplayer-http://192.168.31.8/video/test.mov");
    check("自定义：scheme 大小写原样保留（系统不区分）", launchUrl("custom", media, "SenPlayer://x-callback-url/play?url={url}") === `SenPlayer://x-callback-url/play?url=${encoded}`);
    check("编码：! ' ( ) * 也编码，只留字母数字和 -._~", encodeQueryValue("a!b'c(d)e*f~g-h_i.j") === "a%21b%27c%28d%29e%2Af~g-h_i.j");
    check("地址里的 $& 不会被当成替换模式", launchUrl("custom", "http://a/$&b", "x://{raw}") === "x://http://a/$&b");
    check("hasPlaceholder：大小写敏感、空串不算", hasPlaceholder("a{url}") && hasPlaceholder("{raw}") && !hasPlaceholder("a{URL}") && !hasPlaceholder(""));
    check("菜单里的播放器：Infuse / SenPlayer / VLC / nPlayer / 自定义", same(EXTERNAL_PLAYERS.map((p) => p.id), ["infuse", "senplayer", "vlc", "nplayer", "custom"]));
  }

  console.log("字幕：检索与挑选（样例取自 2026-10-22 对迅雷接口的实测，文件名保留、内容换成中性文字）");
  {
    check("搜法：带横杠、补零到 5 位、不带横杠", same(subtitleQueries("ssis-123"), ["SSIS-123", "SSIS00123", "SSIS123"]));
    check("搜法：数字已经够长就不重复", same(subtitleQueries("FC2-PPV-1234567"), ["FC2-PPV-1234567", "FC2PPV1234567"]));
    check("搜法：字母数字混合的系列", same(subtitleQueries("259LUXU-001"), ["259LUXU-001", "259LUXU00001", "259LUXU001"]));
    check("搜法：拆不开的日期式番号", same(subtitleQueries("082315_001"), ["082315_001", "082315-001"]));
    check("搜法：空串没有", same(subtitleQueries("  "), []));

    check("对得上：横杠写法", matchesCode("SSIS-123.srt", "SSIS-123"));
    check("对得上：不带横杠", matchesCode("SSIS123.HD 标题.srt", "SSIS-123"));
    check("对得上：补零成 5 位、前面有站名", matchesCode("hhd800.com@ssis00001hhb.srt", "SSIS-001"));
    check("对得上：大小写、后缀", matchesCode("mide-500.mp4_1545150077.srt", "MIDE-500") && matchesCode("MIDE-500J.srt", "MIDE-500"));
    check("对得上：中文紧跟在数字后面", matchesCode("SSNI001超级大乱交.srt", "SSNI-001"));
    check("对得上：分隔符是空格 / 下划线 / 点", matchesCode("ssis 123.srt", "SSIS-123") && matchesCode("SSIS_123.srt", "SSIS-123") && matchesCode("ssis.123.srt", "SSIS-123"));
    check("对不上：数字后面还有数字（123 不是 1234）", !matchesCode("SSIS-1234.srt", "SSIS-123"));
    check("对不上：系列前面是字母（ABP 不是 FABP）", !matchesCode("FABP-123.srt", "ABP-123"));
    check("对不上：只有一串数字（搜 MIDE001 带来的杂项）", !matchesCode("E001  100707 标题.ass", "MIDE-001") && !matchesCode("00001(1).srt", "SONE-001"));
    check("对不上：别的番号里恰好有这个数字", !matchesCode("[DASD-559]001OK.srt", "DASD-001"));
    check("对不上：哈希名（是另一份的转存件）", !matchesCode("E55844882C6382DABFB296962A92F0AC917D84E8.srt", "SSIS-123"));
    check(
      "长编号：文件名只剩数字也算（FC2），但不是更长数字的一部分",
      matchesCode("1234567.srt", "FC2-PPV-1234567") && matchesCode("FC2PPV-1234567.srt", "FC2-PPV-1234567") && !matchesCode("12345678.srt", "FC2-PPV-1234567"),
    );
    check("日期式番号：去掉分隔符后包含即可", matchesCode("carib-082315-001.srt", "082315_001") && !matchesCode("H-082315-955-en.srt", "082315_001"));

    const parsed = parseXunleiItems({
      code: 0,
      data: [
        { gcid: "G1", url: "http://subtitle.example/a/G1.srt", ext: "srt", name: "SSIS-123.srt", duration: 8855943 },
        { gcid: "G2", url: "https://subtitle.example/b/G2.ass", ext: "", name: "SSIS-123.ASS", duration: 0 },
        { url: "ftp://x/y.srt", name: "bad.srt" },
        { url: "https://x/z.srt" },
        null,
      ],
      result: "ok",
    });
    check(
      "接口 JSON：http 升 https、毫秒转秒、扩展名缺了从文件名取（小写）、坏条目丢掉",
      same(
        parsed.map((p) => [p.url, p.ext, p.duration, p.id]),
        [
          ["https://subtitle.example/a/G1.srt", "srt", 8856, "G1"],
          ["https://subtitle.example/b/G2.ass", "ass", 0, "G2"],
        ],
      ),
    );
    check("接口 JSON：data 不是数组、整个不是对象，都给空", same(parseXunleiItems({ data: "x" }), []) && same(parseXunleiItems(null), []) && same(parseXunleiItems("oops"), []));

    const item = (name: string, duration: number, url: string): SubtitleItem => ({
      url,
      name,
      ext: (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase(),
      duration,
      id: url,
    });
    const items: SubtitleItem[] = [
      item("SSIS-123.srt", 8856, "https://x/1.srt"), // 0
      item("SSIS123.HD 标题.srt", 8856, "https://x/2.srt"), // 1 另一种写法
      item("SSIS-123.srt", 0, "https://x/3.srt"), // 2 接口没给时长
      item("E55844882C6382DABFB296962A92F0AC917D84E8.srt", 8857, "https://x/4.srt"), // 3 转存件，文件名对不上
      item("SSIS-123 .srt", 1884, "https://x/5.srt"), // 4 只有 31 分钟，多半是预告
      item("SSIS-123.srt", 8967, "https://x/6.srt"), // 5 另一个剪辑版本
      item("SSIS-123.srt", 8967, "https://x/7.srt"), // 6 同上，又传了一遍
      item("SSIS-123.ass", 8858, "https://x/8.ass"), // 7 同名同时长，只是换了格式
      item("notes.txt", 8856, "https://x/9.txt"), // 8 格式不认
      item("FABP-123.srt", 8856, "https://x/10.srt"), // 9 别的番号
    ];
    const blind = buildChoices(items, "SSIS-123");
    check(
      "挑选：视频时长未知时，被传得多的靠前；转存件 / 别的番号 / 不认的格式都滤掉",
      same(blind.map((c) => c.urls[0]), ["https://x/1.srt", "https://x/6.srt", "https://x/2.srt", "https://x/3.srt", "https://x/5.srt"]),
    );
    check("挑选：同名同时长的并成一条，拷贝数与备用链接", blind[0].copies === 2 && same(blind[0].urls, ["https://x/1.srt", "https://x/8.ass"]) && blind[1].copies === 2);
    const known = buildChoices(items, "SSIS-123", 8856);
    check(
      "挑选：视频时长已知时，时长对得准的靠前，差五分钟以上的（预告）直接丢掉",
      same(known.map((c) => c.urls[0]), ["https://x/1.srt", "https://x/2.srt", "https://x/3.srt", "https://x/6.srt"]),
    );
    check("挑选：全都对不上时长也不丢光", buildChoices([item("SSIS-123.srt", 8856, "https://x/1.srt")], "SSIS-123", 100000).length === 1);
    check("挑选：最多 12 条", buildChoices(Array.from({ length: 20 }, (_, i) => item(`SSIS-123 v${i}.srt`, 0, `https://x/v${i}.srt`)), "SSIS-123").length === 12);
    check("挑选：srt 排在同条件的 ass 前面", buildChoices([item("SSIS-123.ass", 0, "https://x/a.ass"), item("SSIS-123 b.srt", 0, "https://x/b.srt")], "SSIS-123")[0].ext === "srt");
    check(
      "时长契合度：差 3 秒内 5、15 秒内 4、一分钟内 3、五分钟内 1、更远 0，不知道给中间值",
      durationFit(8856, 8856) === 5 && durationFit(8866, 8856) === 4 && durationFit(8906, 8856) === 3 && durationFit(9056, 8856) === 1 && durationFit(9856, 8856) === 0 && durationFit(0, 8856) === 2 && durationFit(8856, 0) === 2,
    );
  }

  console.log("字幕：编码识别");
  {
    const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));
    check("UTF-8 BOM：跳过 3 个字节", same(sniffEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, 0x31])), { encoding: "utf-8", skip: 3 }));
    check("UTF-16 BOM：LE / BE 各跳 2 个字节", same(sniffEncoding(Uint8Array.from([0xff, 0xfe, 0x31, 0])), { encoding: "utf16LittleEndian", skip: 2 }) && same(sniffEncoding(Uint8Array.from([0xfe, 0xff, 0, 0x31])), { encoding: "utf16BigEndian", skip: 2 }));
    check("纯 ASCII、合法的中文 UTF-8：都是 UTF-8", same(sniffEncoding(Uint8Array.from(ascii("1\n00:00:01,000 --> 00:00:02,000\nhi\n"))), { encoding: "utf-8", skip: 0 }) && sniffEncoding(new TextEncoder().encode("你好 00:00:01,000 --> 00:00:02,000")).encoding === "utf-8");
    check(
      "GBK 字节（C4 E3 BA C3 = 你好）不是合法 UTF-8，按 GB18030 解",
      same(sniffEncoding(Uint8Array.from([...ascii("1\n00:00:01,000 --> 00:00:02,000\n"), 0xc4, 0xe3, 0xba, 0xc3])), { encoding: "gb18030", skip: 0 }),
    );
    const wide = Buffer.from("[Script Info]\r\n; 测试 test", "utf16le");
    check("没有 BOM 的 UTF-16LE：每隔一个字节是 0", same(sniffEncoding(new Uint8Array(wide)), { encoding: "utf16LittleEndian", skip: 0 }));
    check("没有 BOM 的 UTF-16BE", same(sniffEncoding(new Uint8Array(Buffer.from(wide).swap16())), { encoding: "utf16BigEndian", skip: 0 }));
    check(
      "BOM 被转码弄坏的 UTF-16LE（开头 EF BF BD EF BF BD，实测真有）：从第 7 个字节起按 LE 解",
      same(sniffEncoding(Uint8Array.from([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd, ...wide])), { encoding: "utf16LittleEndian", skip: 6 }),
    );
    check("UTF-8 校验：过长编码 C0 80、孤立的续字节、代理区 ED A0 80 都不合法", !isValidUtf8(Uint8Array.from([0xc0, 0x80])) && !isValidUtf8(Uint8Array.from([0x80])) && !isValidUtf8(Uint8Array.from([0xed, 0xa0, 0x80])));
    check("UTF-8 校验：四字节字符合法，末尾被截断的半个字符放过", isValidUtf8(new TextEncoder().encode("😀 ok")) && isValidUtf8(Uint8Array.from([0x61, 0xe4, 0xbd])));

    const sample = "你好 abc😀 end";
    check("UTF-16 解码：LE / BE，含代理对", decodeUtf16(new Uint8Array(Buffer.from(sample, "utf16le")), true) === sample && decodeUtf16(new Uint8Array(Buffer.from(sample, "utf16le").swap16()), false) === sample);
    check("UTF-16 解码：落单的代理项照样进字符串、不抛错，前后的好字照常", decodeUtf16(new Uint8Array(Buffer.from("好\ud800字", "utf16le")), true) === "好\ud800字");
    check("UTF-16 解码：末尾多出的半个单元丢掉；空输入给空串", decodeUtf16(Uint8Array.from([0x61, 0, 0x62]), true) === "a" && decodeUtf16(new Uint8Array(0), true) === "");
    const long = "字".repeat(10_000);
    check("UTF-16 解码：超过一批（4096 个单元）的长文本也对", decodeUtf16(new Uint8Array(Buffer.from(long, "utf16le")), true) === long);
  }

  console.log("字幕：解析");
  {
    const srt =
      "\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n第一句\r\n<i>斜体</i>\r\n\r\n" +
      "2\r\n00:00:04.000 --> 00:00:06.250\r\n{\\an8}第二句 &amp; 其他\r\n\r\n" +
      "3\r\n00:01:00,000 --> 00:01:02,000\r\n第三句\r\n4\r\n00:01:05,000 --> 00:01:06,000\r\n没有空行隔开的下一条\r\n";
    check(
      "SRT：BOM / CRLF / 句点毫秒 / 标签与实体 / 序号行混进下一条之前",
      same(parseSubtitle(srt), [
        { start: 1, end: 3.5, text: "第一句\n斜体" },
        { start: 4, end: 6.25, text: "第二句 & 其他" },
        { start: 60, end: 62, text: "第三句" },
        { start: 65, end: 66, text: "没有空行隔开的下一条" },
      ]),
    );
    check("SRT：只有 \\r 换行、毫秒位数不一", same(parseSubtitle("1\r00:00:01,5 --> 00:00:02,25\r你好\r"), [{ start: 1.5, end: 2.25, text: "你好" }]));
    check("SRT：结束时间不比开始晚的，给 3 秒", same(parseSubtitle("1\n00:00:05,000 --> 00:00:04,000\n坏时间\n"), [{ start: 5, end: 8, text: "坏时间" }]));
    check("SRT：没有文字的条目丢掉；乱序的按开始时间排", same(parseSubtitle("1\n00:00:09,000 --> 00:00:10,000\n后\n\n2\n00:00:01,000 --> 00:00:02,000\n\n\n3\n00:00:03,000 --> 00:00:04,000\n先\n"), [{ start: 3, end: 4, text: "先" }, { start: 9, end: 10, text: "后" }]));

    const vtt = "WEBVTT\n\nNOTE 这是注释\n\nintro\n00:01.000 --> 00:02.500 line:90% align:center\n<c.yellow>你好</c>\n\n01:00:00.000 --> 01:00:01.000\n一小时后\n";
    check("WebVTT：头、注释块、条目标识、省略小时、行尾的定位设置", same(parseSubtitle(vtt), [{ start: 1, end: 2.5, text: "你好" }, { start: 3600, end: 3601, text: "一小时后" }]));

    const ass = [
      "[Script Info]",
      "Title: x",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname",
      "Style: Default,Arial",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,你好,世界\\N第二行",
      "Dialogue: 0,0:00:02.00,0:00:04.00,Sign,,0,0,0,,{\\an8\\b1}上方{\\r}字幕",
      "Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}",
      "Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,注释行",
      "Dialogue: 0,0:01:00.00,0:01:01.00,Default,,0,0,0,,最后一句",
    ].join("\r\n");
    check(
      "ASS：按 Format 取列、文本里的逗号保留、\\N 换行、样式标记剥掉、绘图与注释行跳过",
      same(parseSubtitle(ass), [
        { start: 1, end: 3.5, text: "你好,世界\n第二行" },
        { start: 2, end: 4, text: "上方字幕" },
        { start: 60, end: 61, text: "最后一句" },
      ]),
    );
    check("ASS：没有 Format 行时用默认列", same(parseSubtitle("[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,没有 Format 行\n"), [{ start: 1, end: 2, text: "没有 Format 行" }]));
    check(
      "ASS：连 [Events] 段头和 Format 行都丢了也照样解（实测 PopSub 生成的文件就是这样，305 条 Dialogue 都在）；样式段的 Format 行不会被当成事件列",
      same(parseSubtitle("[Script Info]\nTitle: x\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\nDialogue: 0,0:02:58.91,0:03:02.14,Default,,0,0,0,,丢了段头的一句\n"), [
        { start: 178.91, end: 182.14, text: "丢了段头的一句" },
      ]),
    );
    check("文本清理：残留的 NUL / 控制字符去掉，制表符换成空格，换行保留", same(parseSubtitle("1\n00:00:01,000 --> 00:00:02,000\n坏\u0000字\t幕\n第二行\n"), [{ start: 1, end: 2, text: "坏字 幕\n第二行" }]));
    check("格式按内容认：SRT 内容不会因为叫 .ass 就解析失败（解析器不看扩展名）", parseSubtitle(srt).length === 4);
    check("不是字幕的内容给空：OSS 的 NoSuchKey 页、乱码、空串", parseSubtitle('<?xml version="1.0" encoding="UTF-8"?>\n<Error>\n  <Code>NoSuchKey</Code>\n</Error>').length === 0 && parseSubtitle("乱码").length === 0 && parseSubtitle("").length === 0);
  }

  console.log("字幕：播放时取字幕、语言、显示");
  {
    const cues = [
      { start: 1, end: 3, text: "A" },
      { start: 2, end: 4, text: "B" },
      { start: 10, end: 12, text: "C" },
    ];
    check("取字幕：第一条之前没有", cueTextAt(cues, 0.5) === "" && cueTextAt(cues, 0) === "");
    check("取字幕：开始那一刻显示，结束那一刻不显示", cueTextAt(cues, 1) === "A" && cueTextAt(cues, 3) === "B");
    check("取字幕：重叠的叠成多行，按开始先后", cueTextAt(cues, 2.5) === "A\nB");
    check("取字幕：间隙里没有，最后一条之后没有", cueTextAt(cues, 5) === "" && cueTextAt(cues, 12) === "" && cueTextAt(cues, 99) === "");
    check("取字幕：空列表", cueTextAt([], 5) === "");

    const lines = (text: string, n: number) => Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1, text }));
    check("语言：中文", detectLanguage(lines("这是一段用来测试的中文字幕内容，长度足够超过阈值。", 3)) === "中文");
    check("语言：日文（假名占比高）", detectLanguage(lines("これは日本語の字幕のテストです。ありがとうございます。", 3)) === "日文");
    check("语言：英文", detectLanguage(lines("This is a test subtitle line for the language detector.", 2)) === "英文");
    check("语言：中英双语算中文", detectLanguage(lines("这是一段用来测试的中文字幕内容\nThis is a test subtitle line", 3)) === "中文");
    check("语言：样本太少不下结论", detectLanguage(lines("好", 3)) === "");

    check(
      "字幕的字号与离底边距离：小窗 ≈ 14 / 44，横屏全屏 ≈ 25 / 59，竖屏铺满 ≈ 15 / 64",
      same(subtitleMetrics(361, 242), { fontSize: 14, bottom: 44 }) &&
        same(subtitleMetrics(832, 419), { fontSize: 25, bottom: 59 }) &&
        same(subtitleMetrics(393, 852), { fontSize: 15, bottom: 64 }),
    );
    check("字幕的字号：再小也不低于 13，再大也不超过 28；离底边至少 44", same(subtitleMetrics(100, 60), { fontSize: 13, bottom: 44 }) && subtitleMetrics(3000, 3000).fontSize === 28);

    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
    check(
      "字幕外观默认值：白色、字号 100%、文字不透明、底条 55%、双层开着、没挪过位置",
      same(DEFAULT_SUBTITLE_STYLE, { color: "#FFFFFF", scale: 1, opacity: 1, backdropOpacity: 0.55, layers: true, x: 0, y: 0 }),
    );
    check(
      "预设色：五种、色值不重复、都是 #RRGGBB",
      SUBTITLE_COLORS.length === 5 && new Set(SUBTITLE_COLORS.map((c) => c.value)).size === 5 && SUBTITLE_COLORS.every((c) => /^#[0-9A-F]{6}$/.test(c.value)),
    );
    check(
      "滑块的范围：字号 60%~200%、文字透明度 20%~100%，默认值都在范围里",
      SCALE_MIN === 0.6 &&
        SCALE_MAX === 2 &&
        OPACITY_MIN === 0.2 &&
        DEFAULT_SUBTITLE_STYLE.scale >= SCALE_MIN &&
        DEFAULT_SUBTITLE_STYLE.scale <= SCALE_MAX &&
        DEFAULT_SUBTITLE_STYLE.opacity >= OPACITY_MIN,
    );
    check("字号：按倍数缩放取整", subtitleFontSize(20, 1) === 20 && subtitleFontSize(20, 0.85) === 17 && subtitleFontSize(20, 1.25) === 25 && subtitleFontSize(20, 2) === 40);
    check("字号：实际字号限制在 10~56 点（滑块拖到头也不会看不清、不会大得离谱）", subtitleFontSize(13, 0.6) === 10 && subtitleFontSize(28, 2) === 56 && subtitleFontSize(40, 2) === 56);
    check(
      "填色值：#FFE14A / FFE14A / 小写 / 两头有空白都认，统一成大写 #RRGGBB",
      parseHexColor("#FFE14A") === "#FFE14A" && parseHexColor("ffe14a") === "#FFE14A" && parseHexColor("  #ffe14a  ") === "#FFE14A",
    );
    check("填色值：三位的展开（#FC0 → #FFCC00）", parseHexColor("#fc0") === "#FFCC00" && parseHexColor("0F8") === "#00FF88");
    check(
      "填色值：位数不对 / 有非十六进制字符 / 空 → 不认（null）",
      parseHexColor("") === null &&
        parseHexColor("#") === null &&
        parseHexColor("#12345") === null &&
        parseHexColor("#GGGGGG") === null &&
        parseHexColor("#FFE14A80") === null &&
        parseHexColor("red") === null,
    );
    check(
      "带透明度的颜色：rgba(r,g,b,a)，透明度限制在 0~1、取两位小数",
      colorWithAlpha("#FFE14A", 0.5) === "rgba(255,225,74,0.5)" &&
        colorWithAlpha("#000000", 0.5499999) === "rgba(0,0,0,0.55)" &&
        colorWithAlpha("#FFFFFF", 2) === "rgba(255,255,255,1)" &&
        colorWithAlpha("#FFFFFF", -1) === "rgba(255,255,255,0)",
    );
    check(
      "色块上的字用黑还是白：亮色用黑、暗色用白",
      contrastInk("#FFE14A") === "black" && contrastInk("#FFFFFF") === "black" && contrastInk("#000000") === "white" && contrastInk("#2040C0") === "white",
    );
    check(
      "读存档：认得的字段原样留下（色值统一成大写）",
      same(normalizeSubtitleStyle({ color: "#ffe14a", scale: 1.5, opacity: 0.8, backdropOpacity: 0.3, layers: false, x: 0.1, y: -0.25 }), {
        color: "#FFE14A",
        scale: 1.5,
        opacity: 0.8,
        backdropOpacity: 0.3,
        layers: false,
        x: 0.1,
        y: -0.25,
      }),
    );
    check(
      "读存档：第一版存的档位名换成现在的写法（颜色 yellow、字号 large、底色开关 false → 底条 0）",
      same(normalizeSubtitleStyle({ color: "yellow", size: "large", backdrop: false, layers: false, x: 0.1, y: -0.25 }), {
        color: "#FFE14A",
        scale: 1.25,
        opacity: 1,
        backdropOpacity: 0,
        layers: false,
        x: 0.1,
        y: -0.25,
      }) && same(normalizeSubtitleStyle({ size: "small", backdrop: true }), { ...DEFAULT_SUBTITLE_STYLE, scale: 0.85 }),
    );
    check(
      "读存档：认不得的颜色 / 字号档、不是数的 / 不是布尔的，都退回默认值",
      same(normalizeSubtitleStyle({ color: "purple", size: "gigantic", scale: "big", opacity: "half", backdropOpacity: null, layers: 1 }), DEFAULT_SUBTITLE_STYLE) &&
        same(normalizeSubtitleStyle({ color: "constructor" }), DEFAULT_SUBTITLE_STYLE),
    );
    check(
      "读存档：没有这个字段（旧版本）/ null / 不是对象，都是默认外观",
      same(normalizeSubtitleStyle(undefined), DEFAULT_SUBTITLE_STYLE) &&
        same(normalizeSubtitleStyle(null), DEFAULT_SUBTITLE_STYLE) &&
        same(normalizeSubtitleStyle("白色"), DEFAULT_SUBTITLE_STYLE) &&
        same(normalizeSubtitleStyle({}), DEFAULT_SUBTITLE_STYLE),
    );
    check(
      "读存档：数值收进范围、取两位小数（字号 60%~200%、文字透明度不低于 20%、底条 0~100%、位移 ±1），不是有限数的当默认",
      same(normalizeSubtitleStyle({ scale: 9, opacity: 0, backdropOpacity: 3, x: 5, y: -9 }), { ...DEFAULT_SUBTITLE_STYLE, scale: 2, opacity: 0.2, backdropOpacity: 1, x: 1, y: -1 }) &&
        same(normalizeSubtitleStyle({ scale: 0.1, backdropOpacity: -1 }), { ...DEFAULT_SUBTITLE_STYLE, scale: 0.6, backdropOpacity: 0 }) &&
        same(normalizeSubtitleStyle({ scale: 1.2345, opacity: 0.55000000001 }), { ...DEFAULT_SUBTITLE_STYLE, scale: 1.23, opacity: 0.55 }) &&
        same(normalizeSubtitleStyle({ scale: Number.NaN, x: Number.POSITIVE_INFINITY, y: "0.3" }), DEFAULT_SUBTITLE_STYLE),
    );

    // 小窗 361 × 242：默认离底边 44、字号 14 → 左右各 120.5，往上 142，往下 38
    const box = { width: 361, height: 242 };
    check("字幕位移：范围内原样", same(clampSubtitleShift(box, 44, 14, { x: 30, y: -50 }), { x: 30, y: -50 }));
    check("字幕位移：往上最多到离顶边 4 行字高", same(clampSubtitleShift(box, 44, 14, { x: 0, y: -999 }), { x: 0, y: -142 }));
    check("字幕位移：往下最多到离底边 6 点", same(clampSubtitleShift(box, 44, 14, { x: 0, y: 999 }), { x: 0, y: 38 }));
    check(
      "字幕位移：左右最多到离边 60 点（居中，一半在画面里）",
      same(clampSubtitleShift(box, 44, 14, { x: 999, y: 0 }), { x: 120.5, y: 0 }) && same(clampSubtitleShift(box, 44, 14, { x: -999, y: 0 }), { x: -120.5, y: 0 }),
    );
    check("字幕位移：叠层矮到放不下时不让往上，也不出错", same(clampSubtitleShift({ width: 300, height: 60 }, 44, 14, { x: 0, y: -50 }), { x: 0, y: 0 }));
    check("字幕位移：叠层窄到装不下两边的空隙时不让左右动", same(clampSubtitleShift({ width: 100, height: 242 }, 44, 14, { x: 40, y: 0 }), { x: 0, y: 0 }));
    {
      const ratio = shiftToRatio({ x: 36.1, y: -48.4 }, box);
      check("位移折成比例：按叠层的宽 / 高", near(ratio.x, 0.1) && near(ratio.y, -0.2));
    }
    check("位移折成比例：叠层还没量出大小（宽或高是 0）时回到默认位置", same(shiftToRatio({ x: 10, y: 10 }, { width: 0, height: 0 }), { x: 0, y: 0 }) && same(shiftToRatio({ x: 10, y: 10 }, { width: 300, height: 0 }), { x: 0, y: 0 }));
    check("位移折成比例：限制在 ±1", same(shiftToRatio({ x: 9999, y: -9999 }, box), { x: 1, y: -1 }));
    {
      // 竖屏小窗里拖到的位置，换到横屏全屏的叠层上，离默认位置的比例不变
      const dragged = shiftToRatio({ x: -72.2, y: -60.5 }, box);
      const wide = { width: 832, height: 419 };
      check("位置存比例：小窗里拖好的位置，到全屏叠层上等比放大", near(dragged.x * wide.width, -166.4) && near(dragged.y * wide.height, -104.75));
    }

    // 双层字幕：一行放不下的句子拆成上下两层。capacity 以汉字宽度计（小窗约 17、横屏全屏约 28）
    const rowFits = (rows: string[], capacity: number): boolean => rows.every((row) => textUnits(row) <= capacity);
    const LONG_ZH = "我今天真的不想再继续这样下去了，你到底有没有在听我说话";
    check(
      "宽度估算：汉字 / 假名 / 全角符号各 1，拉丁字母 0.55，空格 0.3",
      near(textUnits("你好"), 2) && near(textUnits("あ，"), 2) && near(textUnits("Hello"), 2.75) && near(textUnits("a b"), 1.4) && near(textUnits("“好…”"), 4),
    );
    check("分层：放得下的一句不拆", same(splitLayers("这是一句不长的字幕", 17), ["这是一句不长的字幕"]));
    check("分层：原来就分行的（中日双语）一行一层，去掉空行和首尾空白", same(splitLayers(" 你好 \n\n こんにちは ", 17), ["你好", "こんにちは"]));
    check("分层：没有字幕 / 只有空白 → 没有层", same(splitLayers("", 17), []) && same(splitLayers(" \n ", 17), []));
    check("分层：长句优先断在标点之后（逗号留在上层末尾）", same(splitLayers(LONG_ZH, 17), ["我今天真的不想再继续这样下去了，", "你到底有没有在听我说话"]));
    {
      const text = "这个字幕实在是太长了所以需要被拆成上下两层来显示才行啊真的";
      const rows = splitLayers(text, 17);
      check("分层：没有标点的长句在中间附近硬断，两层都放得下、拼回去不丢字", rows.length === 2 && rows.join("") === text && rowFits(rows, 17));
    }
    {
      const text = "I really did not think that you would come all the way here tonight";
      const rows = splitLayers(text, 20);
      check("分层：英文只在空格处断，两层都放得下", rows.length === 2 && rows.join(" ") === text && rowFits(rows, 20));
    }
    {
      const text = "他说：「我走了」然后就离开了这个地方再也没有回来过";
      const rows = splitLayers(text, 14);
      check(
        "分层：不把闭引号 / 标点放到行首，也不把开引号放到行尾",
        rows.length === 2 && rows.join("") === text && !"」，。！？、ー".includes(rows[1][0]) && !"「（『".includes(rows[0].at(-1) ?? ""),
      );
    }
    check(
      "分层：没处可断的长串（网址）原样留着，让 Text 自己折",
      same(splitLayers("https://example.com/a/very/long/path/without/any/space", 10), ["https://example.com/a/very/long/path/without/any/space"]),
    );
    check("分层：不会断出一两个字的小尾巴", splitLayers("一二三四五六七八九十，好", 11).every((row) => textUnits(row) >= 3));
    check(
      "分层：每行各自拆，双语的两行都长就各拆成两层（共 4 层）",
      splitLayers(LONG_ZH + "\n我今日は本当にもうこれ以上続けたくない、あなたは私の話を聞いているの", 17).length === 4,
    );
    check(
      "分层：拆完超过 maxRows 层就不拆，一行一层、多出的行丢掉",
      same(splitLayers(`${LONG_ZH}\n${LONG_ZH}\n第三行`, 17, 4), [LONG_ZH, LONG_ZH, "第三行"]) &&
        same(splitLayers(`${LONG_ZH}\n${LONG_ZH}\n${LONG_ZH}`, 17, 2), [LONG_ZH, LONG_ZH]),
    );
    check("分层：容量不是正数（叠层还没量出大小）时不拆", same(splitLayers(LONG_ZH, 0), [LONG_ZH]) && same(splitLayers("一\n二", Number.NaN), ["一", "二"]));

    // 字幕猫（core/subtitlecat.ts）：搜索页 / 详情页的解析、挑选、排序。页面结构取自 2026-10-22 的实测，名字换成中性的
    const catRowHtml = (href: string, name: string, origin: string | null, liked: boolean, metrics: [string, string, string]): string =>
      `<tr>\n\t\t<td><a href="${href}">${name}</a>${origin === null ? "" : ` (translated from ${origin})`}</td>\n` +
      `\t\t<td class="sub-table__stars">${liked ? '<span title="Rated good by users">👍</span>' : "&nbsp;"}</td>\n` +
      metrics
        .map((m, i) => `\t\t<td class="sub-table__metric"><span class="sub-table__metric-label"> ${["Size", "Downloads", "Languages"][i]}</span><span class="sub-table__metric-value">${m}<span class="sub-table__metric-unit"> x</span></span></td>\n`)
        .join("") +
      "\t</tr>\n";
    {
      const html =
        "<table><thead><tr><th>3 subtitles found</th></tr></thead><tbody>" +
        catRowHtml("subs/1655/ABF-123%20jp.html", "ABF-123 jp", "Japanese", false, ["72 KB", "5", "5"]) +
        catRowHtml("/subs/765/ABF-123.V4.html", "ABF-123.V4 &amp; more", "English", true, ["10 KB", "1,234", "22"]) +
        catRowHtml("subs/9/带 空格.html", "没写语言的", null, false, ["1 KB", "x", "y"]) +
        "</tbody></table>";
      const entries = parseCatSearch(html);
      check("字幕猫搜索页：三行都解析出来，表头那行不算", entries.length === 3 && entries.map((e) => e.index).join() === "0,1,2");
      check(
        "字幕猫搜索页：详情页地址补成完整的（带不带开头的斜杠都行），已有的 %20 原样留着，空格和中文编码",
        entries[0].page === "https://www.subtitlecat.com/subs/1655/ABF-123%20jp.html" &&
          entries[1].page === "https://www.subtitlecat.com/subs/765/ABF-123.V4.html" &&
          entries[2].page === "https://www.subtitlecat.com/subs/9/%E5%B8%A6%20%E7%A9%BA%E6%A0%BC.html",
      );
      check(
        "字幕猫搜索页：名字去 HTML 转义、原始语言、点赞、下载数（带千分位）、语言数",
        entries[1].name === "ABF-123.V4 & more" && entries[1].origin === "English" && entries[1].liked && entries[1].downloads === 1234 && entries[1].languages === 22 && !entries[0].liked,
      );
      check("字幕猫搜索页：没写原始语言的是空串、数字读不出来的当 0", entries[2].origin === "" && entries[2].downloads === 0 && entries[2].languages === 0);
      check("字幕猫搜索页：不是结果页（没有表 / 空串）→ 没有条目", parseCatSearch("<html>nothing</html>").length === 0 && parseCatSearch("").length === 0);
    }
    {
      const e = (name: string, origin: string, liked: boolean, downloads: number, languages: number, index: number): CatEntry => ({
        page: `https://www.subtitlecat.com/subs/${index}/${name}.html`,
        name,
        origin,
        liked,
        downloads,
        languages,
        index,
      });
      const entries = [
        e("IPX-239__English-123", "English", true, 99, 9, 0), // 搜 IPX-123 带出来的无关项（239 和 123 是两个词）
        e("IPX-123.mt", "English", true, 50, 20, 1),
        e("IPX-123.chs", "Chinese", false, 7, 7, 2),
        e("IPX-123 [x.tumblr.com]", "Chinese", true, 18, 18, 3),
        e("IPX-123.chs", "Chinese", false, 7, 7, 2), // 同一个详情页出现两次（两种写法都搜到了）
        e("ipx-1234", "Chinese", true, 5, 5, 4), // 1234 不是 123
        e("IPX-123.ko", "Korean", false, 50, 22, 5),
      ];
      check(
        "字幕猫挑选：名字对不上番号的（IPX-239…-123、IPX-1234）滤掉，同一个详情页只留一条；中文原版 > 点过赞 > 下载多",
        catChoices(entries, "IPX-123").map((x) => x.name).join("|") === "IPX-123 [x.tumblr.com]|IPX-123.chs|IPX-123.mt|IPX-123.ko",
      );
      const many = Array.from({ length: 10 }, (_, i) => e(`IPX-123.v${i}`, "English", false, 1, 1, i));
      check("字幕猫挑选：最多留 6 条，条件一样的按原顺序", catChoices(many, "IPX-123").map((x) => x.name).join("|") === "IPX-123.v0|IPX-123.v1|IPX-123.v2|IPX-123.v3|IPX-123.v4|IPX-123.v5");
      check(
        "字幕猫挑选：别的条件一样时，下载多的、语言多的排前面",
        catChoices([e("A-1.a", "English", false, 1, 1, 0), e("A-1.b", "English", false, 9, 1, 1), e("A-1.c", "English", false, 9, 5, 2)], "A-1").map((x) => x.name).join("|") === "A-1.c|A-1.b|A-1.a",
      );

      const zh = e("X-1", "Chinese", false, 1, 1, 0);
      check(
        "来源标签：迅雷的没有；字幕猫的写明中文原版 / 机翻自哪种语言（认不得的原样）；没写语言就只写字幕猫",
        choiceLabel({ name: "a", ext: "srt", duration: 0, copies: 1, urls: ["u"] }) === "" &&
          choiceLabel(catToChoice(zh)) === "字幕猫 · 中文原版" &&
          choiceLabel(catToChoice({ ...zh, origin: "English" })) === "字幕猫 · 机翻自英文" &&
          choiceLabel(catToChoice({ ...zh, origin: "Japanese" })) === "字幕猫 · 机翻自日文" &&
          choiceLabel(catToChoice({ ...zh, origin: "Swahili" })) === "字幕猫 · 机翻自Swahili" &&
          choiceLabel(catToChoice({ ...zh, origin: "" })) === "字幕猫",
      );
      const asChoice = catToChoice(zh);
      check("字幕猫的条目转成候选：下载地址空着，记着详情页和原始语言", asChoice.urls.length === 0 && asChoice.ext === "srt" && asChoice.duration === 0 && asChoice.cat?.page === zh.page && asChoice.cat?.origin === "Chinese");
    }
    {
      const detail = parseCatDetail(
        '<span><a id="download_zh-CN"  onclick="log_download(3082571); show_voting(\'zh-CN\');" href="/subs/308/STARS-123-zh-CN.srt" class="green-link">Download</a></span>' +
          '<span><a id="download_zh-TW"  onclick="x" href="/subs/315/STARS-123-zh-TW.srt" class="green-link">Download</a></span>' +
          '<span><a id="download_en"  onclick="x" href="/subs/307/STARS-123 en.srt" class="green-link">Download</a></span>' +
          "<span><button id=\"af\" onclick=\"translate_from_server_folder('af', 'STARS-123-orig.srt', '/subs/307/')\" class=\"yellow-link\">Translate</button></span>",
      );
      const base = "https://www.subtitlecat.com/subs";
      check(
        "字幕猫详情页：现成文件按语言代码读出来（目录号各不相同），空格编码",
        detail.files.size === 3 &&
          detail.files.get("zh-CN") === `${base}/308/STARS-123-zh-CN.srt` &&
          detail.files.get("zh-TW") === `${base}/315/STARS-123-zh-TW.srt` &&
          detail.files.get("en") === `${base}/307/STARS-123%20en.srt`,
      );
      check("字幕猫详情页：原文文件从「Translate」按钮的参数里拼出来", detail.orig === `${base}/307/STARS-123-orig.srt`);
      check("字幕猫详情页：认不出结构 → 没有文件、没有原文", parseCatDetail("<html></html>").files.size === 0 && parseCatDetail("<html></html>").orig === "");
      check(
        "挑下载的文件：简体 > 繁体；机翻的只要中文，没有中文就是空",
        same(pickCatUrls(detail, "English"), [`${base}/308/STARS-123-zh-CN.srt`, `${base}/315/STARS-123-zh-TW.srt`]) &&
          pickCatUrls({ files: new Map([["en", "x"]]), orig: "o" }, "English").length === 0,
      );
      check(
        "挑下载的文件：中文原版最后再加原文",
        same(pickCatUrls(detail, "Chinese"), [`${base}/308/STARS-123-zh-CN.srt`, `${base}/315/STARS-123-zh-TW.srt`, `${base}/307/STARS-123-orig.srt`]) &&
          same(pickCatUrls({ files: new Map(), orig: "o" }, "Chinese"), ["o"]) &&
          same(pickCatUrls({ files: new Map(), orig: "" }, "Chinese"), []),
      );
      check(
        "字幕猫的搜索地址和查询写法：带横杠和紧凑两种，补零的不要",
        catSearchUrl("SSIS-123") === "https://www.subtitlecat.com/index.php?search=SSIS-123" &&
          catSearchUrl("A B") === "https://www.subtitlecat.com/index.php?search=A%20B" &&
          same(catQueries("ssis-123"), ["SSIS-123", "SSIS123"]) &&
          same(catQueries("082315_001"), ["082315_001", "082315-001"]) &&
          catQueries(" ").length === 0,
      );
    }

    check("时钟：3725 秒 → 1:02:05，605 秒 → 10:05，进位",formatClock(3725) === "1:02:05" && formatClock(605) === "10:05" && formatClock(0) === "00:00" && formatClock(59.6) === "01:00");
    check("偏移的说法：正数提前、负数延后、近零无偏移", offsetLabel(1.5) === "提前 1.5 秒" && offsetLabel(-2) === "延后 2 秒" && offsetLabel(0) === "无偏移" && offsetLabel(0.04) === "无偏移");
    check("偏移累加：按 0.1 秒取整、限制在 ±600 秒", shiftOffset(0, 0.5) === 0.5 && shiftOffset(0.5, -0.5) === 0 && shiftOffset(0.1, 0.2) === 0.3 && shiftOffset(599, 5) === 600 && shiftOffset(-599, -5) === -600);
    check(
      "时长差的说法",
      durationGapLabel(8856, 8856) === "时长吻合" && durationGapLabel(8856, 8859) === "时长吻合" && durationGapLabel(8860, 8856) === "时长长 4 秒" && durationGapLabel(8967, 8856) === "时长长 2 分钟" && durationGapLabel(1884, 8856) === "时长短 116 分钟" && durationGapLabel(0, 100) === "",
    );
  }

  console.log("格式化");
  {
    check("时长 128 分 → 02:08", formatLength(128) === "02:08");
    check("时长缺失", formatLength(null) === "???分钟");
    check("10 小时以上不拼出三位", formatLength(605) === "10:05");
    check("上映行", releaseLine("2021-09-09", 128) === "2021-09-09(02:08)" && releaseLine("", null) === "????-??-??(???分钟)");
    check("今天（月日不补零，和原版 nowTime 一致）", todayString(new Date(2026, 9, 2)) === "2026-10-2" && todayString(new Date(2026, 0, 9)) === "2026-1-9");
    check("序号补零", pad2(3) === "03" && pad2(12) === "12");
    check("文件名清理", safeFileName("a/b:c?") === "a_b_c_" && safeFileName("  ") === "未命名");
    check("哈希取色稳定且在范围内", hashIndex("折磨", 12) === hashIndex("折磨", 12) && hashIndex("折磨", 12) < 12);
  }

  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

main();
