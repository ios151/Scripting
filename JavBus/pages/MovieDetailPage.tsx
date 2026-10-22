// 影片详情页（媒体中心风格，照 One-ipa 的详情页）：封面糊成背景；顶部固定一个舞台（点播放前是封面海报，
// 点了之后换成播放器）；下面的滚动区里依次是标题、大「播放」胶囊 + 收藏胶囊、一排小胶囊
// （获取 / 预览 / 磁链 / 样品图 / 分享 / 推荐）、片名信息卡片、参演的横向卡片。
//
// 对应原版 detailView + getDetail。原版进详情页就同时发出四路请求（fourhoi 预览、Jable、
// MissAV 完整视频的隐藏 web 视图、JavDB 评分），并在预览就绪时自动播放；这里同样，
// 自动播放和 MissAV 预取可以在设置里关。
//
// 原版固定在底部的「获取 / 预览 / 收藏」三个灰色方块和整页的样子对不上，换成了页面里的胶囊；
// 页面没有底栏了，Tab 栏仍然让出来（iOS 26 的 Tab 栏是浮在内容之上的玻璃胶囊，不让会压住内容）。
//
// 页面里要「推」出去的子页面（磁链、样品图、类目、演员）统一走一个 dest 状态 + navigationDestination：
// 菜单项里放不了 NavigationLink，而且这样整页只有一处导航出口。

import {
  Button,
  FlowLayout,
  HStack,
  Image,
  Menu,
  ProgressView,
  Rectangle,
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useRef,
  useState,
  type Color,
  type VirtualNode,
} from "scripting";

import { FALLBACK_COVER, MISSAV_ORIGIN } from "../core/constants";
import { releaseLine, safeFileName, todayString } from "../core/format";
import { shortCodeOf } from "../core/keyword";
import { initialPhase, nextPhase, type Phase } from "../core/phase";
import { isProbing, pickBestSource, playSubline, type Previews } from "../core/playback";
import { REPORT_REASONS, type UploadOutcome } from "../core/recommend";
import { favMovieOf } from "../core/refs";
import { coverFromThumb, isBigCover } from "../core/site";
import type { MovieDetail, MovieRef, NamedLink, RecItem, StarItem } from "../core/types";
import { loadDetail } from "../kit/detail";
import { describeError } from "../kit/http";
import { loadImage } from "../kit/images";
import { loadMagnets } from "../kit/magnets";
import { resolveMissavStream } from "../kit/missav";
import { enterLandscape, exitLandscape, restoreOrientation, waitForLandscape } from "../kit/orientation";
import {
  fanzaPreviewUrl,
  findJable,
  findJableHls,
  findJavdbRating,
  findMissavPreview,
  probeVideo,
  type RatingState,
} from "../kit/previews";
import { recKindOf, sendRecommendation, sendReport, useRecVersion, usesCommunity } from "../kit/recommend";
import { getSettings } from "../kit/settings";
import { buildShareLink, copyText, shareItems } from "../kit/share";
import { store, useLibrary } from "../kit/store";
import { showError, showToast } from "../kit/toast";
import { translateToChinese } from "../kit/translate";
import { ActressPage } from "./ActressPage";
import { CategoryMoviesPage, type CategoryKind } from "./CategoryMoviesPage";
import { COVER_THUMB_SIDE, cardStatus } from "./components";
import { CollectCapsule, PlayCapsule, STAGE_RADIUS, stageSize } from "./DetailParts";
import { MagnetPage } from "./MagnetPage";
import { PlayerCard, type PlayerSource } from "./PlayerCard";
import { RemoteImage } from "./RemoteImage";
import { SamplesPage } from "./SamplesPage";
import { SubtitlePanel } from "./SubtitlePanel";
import { SubtitleMenu } from "./SubtitleParts";
import { CARD, COLUMN_MAX, CoverBackdrop, DANGER, GLASS, INK, LINK, PillLabel, SIDE, columnWidth } from "./theme";
import { useSubtitles } from "./useSubtitles";

// ———— 原版收藏按钮的几个颜色（深色底上调亮了一档） ————

const COLOR_RED: Color = "#ff6b6b";
const COLOR_CYAN: Color = "#22bdcc";

/** 收藏胶囊的宽度：放得下「取消收藏」四个字加图标。 */
const COLLECT_WIDTH = 124;
/** 播放胶囊和收藏胶囊之间的间距。 */
const CAPSULE_GAP = 12;
/** 参演卡片上的头像边长。 */
const STAR_SIZE = 76;
/** 字幕设置面板在全屏里的宽度，和离右边的距离（要让出播放器右缘那一列按钮：8 边距 + 36 直径 + 一点空隙）。 */
const PANEL_WIDTH_FULLSCREEN = 352;
const PANEL_RIGHT_GAP = 60;

type Dest =
  | { type: "magnets" }
  | { type: "samples" }
  | { type: "category"; title: string; link: string; kind: CategoryKind }
  | { type: "star"; star: StarItem };

// ———— 收藏胶囊 ————

/**
 * 阶段怎么走在 core/phase.ts（收藏 ⇄ 取消收藏、归档 → 已归档、删除 → 已删除），这里只管每个阶段的外观。
 *
 * 原版取消收藏 / 归档 / 删除之后还会 `$ui.pop()` 退出详情页。这里不退：Scripting 里在推进来的页面上调
 * `Navigation.useDismiss()` 关掉的是整个脚本，不是返回一步（官方文档 navigation_stack 一节明说）。
 * 列表页订阅了库，返回时已经是新的。
 */
const PHASE_VIEW: Record<Phase, { title: string; icon: string; color: Color; disabled: boolean }> = {
  add: { title: "收藏", icon: "heart", color: INK.strong, disabled: false },
  cancel: { title: "取消收藏", icon: "heart.fill", color: COLOR_RED, disabled: false },
  archive: { title: "归档", icon: "archivebox", color: COLOR_CYAN, disabled: false },
  delete: { title: "删除", icon: "trash", color: COLOR_RED, disabled: false },
  archived: { title: "已归档", icon: "archivebox.fill", color: INK.faint, disabled: true },
  deleted: { title: "已删除", icon: "trash.fill", color: INK.faint, disabled: true },
};

// ———— 小部件 ————

/** 评分胶囊上的字。「没有评分」保持原版的 N/A 写法，「获取失败」写出原因。 */
function ratingLabel(rating: RatingState | undefined): string {
  if (rating === undefined) return "评分: …";
  if (rating.kind === "ok") return `评分: ${rating.score}   数量: ${rating.count}`;
  if (rating.kind === "none") return "评分:N/A   数量:N/A";
  const reason = rating.reason.length > 28 ? `${rating.reason.slice(0, 28)}…` : rating.reason;
  return `评分: 获取失败（${reason}）`;
}

function InfoRow({ label, children }: { label: string; children: VirtualNode }) {
  return (
    <HStack alignment="firstTextBaseline" spacing={8}>
      <Text font="subheadline" fontWeight="bold" foregroundStyle={INK.soft} frame={{ width: 64, alignment: "leading" }}>
        {label}
      </Text>
      {children}
      <Spacer />
    </HStack>
  );
}

function LinkText({ link, onTap }: { link: NamedLink | null; onTap: (link: NamedLink) => void }) {
  if (!link) {
    return (
      <Text font="subheadline" foregroundStyle={INK.faint}>
        未知
      </Text>
    );
  }
  return (
    <Button buttonStyle="plain" action={() => onTap(link)}>
      <Text font="subheadline" foregroundStyle={LINK} multilineTextAlignment="leading">
        {link.name}
      </Text>
    </Button>
  );
}

// ———— 页面 ————

export function MovieDetailPage({ movie }: { movie: MovieRef }) {
  const lib = useLibrary();
  // 推荐列表回来（从剪贴板 / URL 直接打开详情时它常常还没回来）之后，「推荐影片 / 已推荐」要跟着变
  useRecVersion();

  const [detail, setDetail] = useState<MovieDetail | null>(null);
  const [loading, setLoading] = useState(!movie.fallback);
  const [error, setError] = useState("");
  const [dest, setDest] = useState<Dest | null>(null);
  const [source, setSource] = useState<PlayerSource | null>(null);
  const [previews, setPreviews] = useState<Previews>({
    missav: undefined,
    jable: undefined,
    jableHls: undefined,
    missavFull: undefined,
  });
  const [rating, setRating] = useState<RatingState | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>(() =>
    initialPhase(movie.context, cardStatus(lib, { code: movie.code, link: movie.link })),
  );
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  // 用户自己点过播放（或关过播放器）之后，探测结果迟到也不再自动播放
  const userPicked = useRef(false);

  const code = movie.code;
  // 字幕的状态放在页面上：字幕按钮在下面那排小胶囊里，播放器（PlayerCard）只负责把字幕画出来；
  // 搜索时要拿视频时长排序，所以播放器把自己的 AVPlayer 放进 playerRef
  const playerRef = useRef<AVPlayer | null>(null);
  const sub = useSubtitles(code, () => playerRef.current);
  // 全屏：整页让给播放器（横屏）。点「全屏」先换布局、同时请求转横屏，转没转过去再用 Device.screen 确认（见 kit/orientation.ts）；
  // 布局不依赖「量出来的页面大小」——第一版靠 GeometryReader 量，真机上界面转了几秒就被判成转不了、转了回去
  const [fullscreen, setFullscreen] = useState(false);
  // 字幕设置面板开着没有（SubtitlePanel：竖屏里从字幕菜单开，全屏里从播放器右缘那列按钮开）
  const [panelOpen, setPanelOpen] = useState(false);
  // 我们把界面转成了横屏、还没转回来（离开页面时要转回去）
  const landscapeOn = useRef(false);
  // 每次点进入 / 退出领一个序号：等转屏的过程中又点了别的，旧的那次不再动页面
  const rotateToken = useRef(0);
  const shortCode = movie.fallback ? code : shortCodeOf(movie.link);
  const phaseView = PHASE_VIEW[phase];
  // 评分每次请求领一个序号，只认最新那次：换片、点「重新获取评分」、离开页面，旧结果都作废
  const ratingSeq = useRef(0);
  const loadRating = () => {
    const seq = ++ratingSeq.current;
    setRating(undefined);
    void findJavdbRating(code).then((r) => {
      if (seq === ratingSeq.current) setRating(r);
    });
  };
  useEffect(() => {
    loadRating();
    return () => {
      ratingSeq.current++;
    };
  }, [code]);

  // 加载详情 + 后台预取磁链
  useEffect(() => {
    if (movie.fallback) return;
    let alive = true;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const loaded = await loadDetail(movie);
        if (!alive) return;
        setDetail(loaded);
        loadMagnets(loaded.link, loaded.magnetParams).catch(() => undefined);
      } catch (e) {
        if (alive) setError(describeError(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [movie.link]);

  // 预览探测、MissAV 完整视频；探测完按设置决定要不要自动播放
  useEffect(() => {
    let alive = true;
    const patch = (p: Partial<Previews>) => {
      if (alive) setPreviews((prev) => ({ ...prev, ...p }));
    };
    const missavTask = findMissavPreview(code);
    const jableTask = findJable(code);
    void missavTask.then((url) => patch({ missav: url }));
    void jableTask.then(async (found) => {
      patch({ jable: found });
      if (found) patch({ jableHls: await findJableHls(found.videoUrl) });
    });
    if (getSettings().prefetchMissav) {
      void resolveMissavStream(code, () => !alive).then((url) => patch({ missavFull: url }));
    }
    // 自动播放：MissAV 预览一到就播；Jable 只在 MissAV 没有时才补（不用等 Jable 慢吞吞的探测）
    const mayAutoplay = () => alive && !userPicked.current && getSettings().autoPreview;
    void missavTask.then(async (missav) => {
      if (!mayAutoplay()) return;
      if (missav) {
        setSource({ url: missav, label: "MissAV 预览" });
        return;
      }
      const jable = await jableTask;
      if (mayAutoplay() && jable?.preview) setSource({ url: jable.preview, label: "Jable 预览" });
    });
    return () => {
      alive = false;
    };
  }, [code]);

  const play = (src: PlayerSource) => {
    userPicked.current = true;
    HapticFeedback.lightImpact();
    setSource(src);
  };

  const closePlayer = () => {
    userPicked.current = true;
    setPanelOpen(false);
    setSource(null);
  };

  /** 点「全屏」：换成全屏布局、请求转横屏；等一会儿界面还是竖的，说明这台设备转不了，退回平时的样子。 */
  const enterFullscreen = () => {
    const token = ++rotateToken.current;
    landscapeOn.current = true;
    enterLandscape();
    setPanelOpen(false); // 面板在竖屏和全屏里摆的位置不一样，换布局时先收起来
    setFullscreen(true);
    void waitForLandscape(true).then((rotated) => {
      if (rotated || token !== rotateToken.current) return;
      landscapeOn.current = false;
      restoreOrientation();
      setFullscreen(false);
      showError("这台设备转不了横屏");
    });
  };

  /**
   * 退出全屏：转回竖屏（先只许竖屏，转完再还原成用户配置），界面转回来以后才换回平时的布局——
   * 横着的时候就换，会闪一下在横屏里排错了的竖屏页面。
   */
  const exitFullscreen = () => {
    const token = ++rotateToken.current;
    exitLandscape();
    setPanelOpen(false);
    void waitForLandscape(false).then(() => {
      if (token !== rotateToken.current) return;
      landscapeOn.current = false;
      setFullscreen(false);
    });
  };

  // 播放器关了、或换成了预览片段（没有字幕了）：字幕面板收起来，还在全屏的话退出来
  useEffect(() => {
    if (source?.full) return;
    setPanelOpen(false);
    if (fullscreen) exitFullscreen();
  }, [source?.full]);
  // 离开页面：转过横屏的话转回竖屏、还原方向，免得上一页被带成横的
  useEffect(
    () => () => {
      rotateToken.current++;
      if (landscapeOn.current) exitLandscape();
    },
    [],
  );

  // ———— 动作 ————

  const runPrimary = () => {
    if (phaseView.disabled) return;
    const fav = favMovieOf(movie, detail);
    switch (phase) {
      case "add":
        store.addFavorite(fav);
        break;
      case "cancel":
        store.cancelFavorite(shortCode, code);
        break;
      case "archive":
        store.archive(fav);
        break;
      case "delete":
        store.deleteArchived(shortCode, code);
        break;
    }
    setPhase(nextPhase(phase));
    HapticFeedback.lightImpact();
  };

  const toggleTranslate = async () => {
    if (translating || !detail?.title) return;
    if (translation !== null) {
      setTranslation(null); // 再点还原
      return;
    }
    setTranslating(true);
    try {
      setTranslation(await translateToChinese(detail.title));
    } catch (e) {
      showError(`翻译失败：${describeError(e)}`);
    } finally {
      setTranslating(false);
    }
  };

  // 详情页的大封面（800×538）：详情还没回来时，从列表缩略图的地址推一个，进页就开始载、不等详情 HTML；
  // 推不出来 = 空串；兜底详情用固定的那张
  const derivedCover = isBigCover(movie.cover) ? movie.cover : coverFromThumb(movie.cover);
  const bigCover = movie.fallback ? FALLBACK_COVER : detail?.cover || derivedCover;
  // 当前能用的最好的封面（长按菜单的查看大图 / 分享用）
  const coverUrl = bigCover || movie.cover;

  const openCover = async () => {
    // 推出来的大图地址可能不存在：载不出来就退回列表带来的缩略图
    const img = (await loadImage(coverUrl)) ?? (coverUrl !== movie.cover ? await loadImage(movie.cover) : null);
    if (img) await QuickLook.previewImage(img, true);
    else showError("封面加载失败");
  };

  const playMissavFull = async () => {
    if (previews.missavFull) {
      play({ url: previews.missavFull, label: "MissAV 完整视频", full: true });
      return;
    }
    showToast("正在获取 MissAV 完整视频…");
    const url = await resolveMissavStream(code);
    if (url) {
      setPreviews((p) => ({ ...p, missavFull: url }));
      play({ url, label: "MissAV 完整视频", full: true });
    } else {
      showError("没有找到 MissAV 完整视频");
    }
  };

  const fanzaBusy = useRef(false);
  const playFanza = async () => {
    if (fanzaBusy.current) return;
    fanzaBusy.current = true;
    showToast("正在检查 Fanza 预告…");
    try {
      const url = fanzaPreviewUrl(code);
      if (await probeVideo(url)) play({ url, label: "Fanza 预告" });
      else showError("Fanza 暂无预告");
    } finally {
      fanzaBusy.current = false;
    }
  };

  /** 大「播放」：按「完整视频 > 预览」挑当前探测到的片源；还在探测就等一下；都没有就试 Fanza 预告。 */
  const playBest = () => {
    const best = pickBestSource(previews);
    if (best) {
      play(best);
      return;
    }
    if (isProbing(previews)) {
      showToast("还在探测片源，稍等一下…");
      return;
    }
    void playFanza();
  };

  const open = (url: string) => void Safari.openURL(url);
  const q = encodeURIComponent(code);
  const plainCode = code.toLowerCase().replace("-", "");
  const javdbUrl = `https://javdb.com/search?q=${q}&f=all`;

  const shareRecItem = (): RecItem => ({
    code,
    info: `${code} | ${todayString()}`,
    src: movie.cover || detail?.cover || "",
    link: detail?.link ?? movie.link,
  });

  /** 看这个频道归谁管：原作者的服务问数字密码；社区服务问维护者口令（后台「我的账号」里生成的，jca_ 开头）。 */
  const askPassword = async (channel: "author" | "user"): Promise<string | null> => {
    const answer = usesCommunity(channel)
      ? await Dialog.prompt({
          title: "输入维护者口令",
          message: "在社区推荐服务后台的「我的账号」里生成，以 jca_ 开头",
          placeholder: "jca_…",
          keyboardType: "default",
          confirmLabel: "确定",
          cancelLabel: "取消",
        })
      : await Dialog.prompt({ title: "输入密码", placeholder: "密码", keyboardType: "numberPad", confirmLabel: "确定", cancelLabel: "取消" });
    return answer === null ? null : answer.trim();
  };

  const reportOutcome = async (task: Promise<UploadOutcome>) => {
    showToast("发送中…");
    const outcome = await task;
    if (outcome.copy) await copyText(outcome.copy); // 未知返回码复制出来，方便发给作者排查
    if (outcome.ok) {
      HapticFeedback.notificationSuccess();
      showToast(outcome.message);
      return;
    }
    showError(outcome.message);
    if (outcome.serviceError) {
      // 服务端回的是 Google 的错误页：把页面上那几句话原样给你看，toast 放不下，也别让它满屏都是脚本
      await Dialog.alert({
        title: "推荐服务出错",
        message:
          `${outcome.serviceError}\n\n` +
          "这是推荐服务返回的网页，不是正常的结果码（作者推荐走原作者的 Google Apps Script，网友推荐走社区推荐服务）。可能是对方服务的部署或权限出了问题，" +
          "也可能是这台设备跟随跳转的方式和预期不一致。上面的文字已复制，可以发给作者或开发者排查；" +
          "设置里的「推荐服务」可以换成自己的上传服务地址。",
      });
    }
  };

  const recommendAsAuthor = async () => {
    if (recKindOf(code) === "author") {
      showError("该影片已在推荐列表！");
      return;
    }
    const pw = await askPassword("author");
    if (pw === null) return;
    await reportOutcome(sendRecommendation("author", "upload", shareRecItem(), pw));
  };

  const revokeRecommendation = async (channel: "author" | "user") => {
    // 社区服务里网友通道的撤销认设备：自己在期限内提交的不用口令。服务端说「没有权限」（NA）才改问维护者口令
    if (channel === "user" && usesCommunity("user")) {
      showToast("发送中…");
      const own = await sendRecommendation("user", "del", code);
      if (own.code !== "NA") {
        await reportOutcome(Promise.resolve(own));
        return;
      }
      const useKey = await Dialog.confirm({
        title: "只能撤销自己提交的推荐",
        message: "这条不是你在期限内提交的。如果你是维护者，可以用维护者口令撤销。",
        confirmLabel: "输入口令",
        cancelLabel: "算了",
      });
      if (!useKey) return;
    }
    const pw = await askPassword(channel);
    if (pw === null) return;
    await reportOutcome(sendRecommendation(channel, "del", code, pw));
  };

  /** 举报一条推荐（只有社区服务有，所以只举报得了归它管的列表）：选个原因，多人举报的条目会被自动隐藏等维护者复核。 */
  const reportRecommendation = async () => {
    const kind = recKindOf(code);
    if (!kind || !usesCommunity(kind)) return;
    const index = await Dialog.actionSheet({
      title: "举报这条推荐",
      message: "维护者会复核；被多人举报的条目会先被隐藏",
      actions: REPORT_REASONS.map((r) => ({ label: r.label })),
    });
    const reason = index === null ? undefined : REPORT_REASONS[index]?.reason;
    if (!reason) return;
    await reportOutcome(sendReport(kind, code, reason));
  };

  const recommendAsUser = async () => {
    if (recKindOf(code)) {
      showError("该片已在推荐列表");
      return;
    }
    const ok = await Dialog.confirm({
      title: "请将好看的影片进行推荐",
      message: "稍后将出现在「推荐」内的「网友推荐」",
      confirmLabel: "OK",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    await reportOutcome(sendRecommendation("user", "upload", shareRecItem()));
  };

  const recKind = recKindOf(code);

  // ———— 页面内容 ————

  const destContent = (() => {
    if (!dest) return <Spacer />;
    switch (dest.type) {
      case "magnets":
        return <MagnetPage code={code} detailUrl={detail?.link ?? movie.link} params={detail?.magnetParams ?? null} />;
      case "samples":
        return (
          <SamplesPage
            code={code}
            folder={detail && detail.stars.length === 1 ? detail.stars[0].name : safeFileName(code)}
            images={detail?.samples ?? []}
          />
        );
      case "category":
        return <CategoryMoviesPage title={dest.title} link={dest.link} kind={dest.kind} />;
      case "star":
        return <ActressPage star={dest.star} />;
    }
  })();

  const pushCategory = (kind: CategoryKind) => (link: NamedLink) =>
    setDest({ type: "category", title: link.name, link: link.link, kind });

  const openSamples = () => {
    if (!detail || detail.samples.length === 0) {
      showError("☹️ 暂无图像");
      return;
    }
    setDest({ type: "samples" });
  };

  const titleText = translation ?? detail?.title ?? (movie.fallback ? code : "");
  // 标题下面的一行：番号 · 上映日期(时长)。详情还没回来时用列表上带的「番号 | 日期」
  const metaText = detail ? `${code} · ${releaseLine(detail.date, detail.minutes)}` : movie.info.replace(" | ", " · ") || code;

  // 背景用列表上带来的缩略图，不跟着详情页的大封面换：换的时候会黑一下闪一下，糊成一片以后两张看不出区别
  const backdropCover = movie.cover || coverUrl;

  const colWidth = columnWidth();
  const playWidth = colWidth - COLLECT_WIDTH - CAPSULE_GAP;
  const stage = stageSize();
  // 海报底下垫着列表带来的缩略图：有缩略图、而且它不就是大图本身
  const thumbBelow = !!movie.cover && movie.cover !== bigCover;

  // ———— 舞台：点播放前是封面海报（点哪里都能播，长按有查看大图 / 分享），点了之后是播放器 ————

  const poster = (
    <ZStack
      frame={{ width: stage.width, height: stage.height }}
      background={{ style: "rgba(0,0,0,0.3)", shape: { type: "rect", cornerRadius: STAGE_RADIUS } }}
      clipShape={{ type: "rect", cornerRadius: STAGE_RADIUS }}
      onTapGesture={playBest}
      contextMenu={{
        menuItems: (
          <>
            <Button title="查看大图" systemImage="arrow.up.left.and.arrow.down.right" action={() => void openCover()} />
            <Button title="分享封面链接" systemImage="square.and.arrow.up" action={() => void shareItems([coverUrl])} />
          </>
        ),
      }}
    >
      {/* 两层：底下是列表带来的缩略图（147×200 的竖图，铺满放大会糊，只是大图到之前的占位；
          推出来的大图地址不存在时它就是最终画面），上面是大图（有缩略图垫底时 quiet：没载好 / 载失败都不画，露出底下的） */}
      {thumbBelow ? (
        <RemoteImage
          url={movie.cover}
          maxSide={COVER_THUMB_SIDE}
          mode="fill"
          width={stage.width}
          height={stage.height}
          background="rgba(255,255,255,0.06)"
        />
      ) : null}
      {bigCover ? (
        <RemoteImage
          url={bigCover}
          mode="fill"
          width={stage.width}
          height={stage.height}
          background={thumbBelow ? "rgba(0,0,0,0)" : "rgba(255,255,255,0.06)"}
          quiet={thumbBelow}
          keepPrevious
        />
      ) : null}
      <Rectangle fill={{ colors: ["rgba(0,0,0,0)", "rgba(0,0,0,0.5)"], startPoint: "center", endPoint: "bottom" }} />
      <Image systemName="play.circle.fill" font={60} foregroundStyle="rgba(255,255,255,0.92)" shadow={{ radius: 8, color: "rgba(0,0,0,0.4)" }} />
    </ZStack>
  );

  return (
    <ZStack
      navigationTitle={code}
      navigationBarTitleDisplayMode="inline"
      // 这一页是深色沉浸的：导航栏透明、按深色画；Tab 栏让出来；全屏（横着播放）时导航栏也收起来，底色换成纯黑。
      // 状态栏不用管：iPhone 横屏时系统默认就收起（statusBarHidden 要挂在整页的根上、还得是全屏弹出的页面才生效，这里是推入的页面，挂了也没用）
      toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}
      toolbarColorScheme={{ colorScheme: "dark", bars: ["navigationBar"] }}
      toolbarVisibility={{ visibility: "hidden", bars: fullscreen ? ["navigationBar", "tabBar"] : ["tabBar"] }}
      background={fullscreen ? "black" : undefined}
      navigationDestination={{
        isPresented: dest !== null,
        onChanged: (presented: boolean) => {
          if (!presented) setDest(null);
        },
        content: destContent,
      }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
    >
      {fullscreen ? null : <CoverBackdrop cover={backdropCover} />}

      {/* 整个脚本在根上已经锁了深色（App.tsx）；这里再把深色环境值套在页面内容上、导航栏锁深色，是双保险：
          环境值只套内容，不套在挂了 navigationDestination 的根上，免得和子页面的环境纠缠 */}
      <VStack spacing={0} environments={{ colorScheme: "dark" }} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        {/* 内容是一条最宽 COLUMN_MAX 的居中列（iPad 上不整屏铺开）。舞台固定在滚动区外面，读下面的信息时画面还在；
            点播放 / 关播放器时舞台高度会变（播放器下面多一排快进快退），整列一起平滑过渡 */}
        <VStack
          spacing={0}
          frame={{ maxWidth: fullscreen ? "infinity" : COLUMN_MAX, maxHeight: "infinity" }}
          animation={{ animation: Animation.smooth({ duration: 0.25 }), value: source ? 1 : 0 }}
        >
          <VStack
            padding={fullscreen ? 0 : { horizontal: SIDE, top: 4 }}
            frame={fullscreen ? { maxWidth: "infinity", maxHeight: "infinity" } : undefined}
          >
            {source ? (
              <PlayerCard
                key={source.url}
                source={source}
                sub={sub}
                avRef={playerRef}
                fullscreen={fullscreen}
                onExitFullscreen={exitFullscreen}
                onOpenSubtitles={() => setPanelOpen(true)}
                onClose={closePlayer}
              />
            ) : (
              poster
            )}
          </VStack>

          {/* 全屏时整页让给播放器：下面的内容不画（转回竖屏再出来；它的滚动位置会丢，可以接受） */}
          {fullscreen ? null : (
            <ScrollView>
              <VStack
                alignment="leading"
                spacing={22}
                padding={{ horizontal: SIDE, top: 14, bottom: 40 }}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                {/* 标题与评分 */}
                <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  {titleText ? (
                    <Button buttonStyle="plain" action={() => void toggleTranslate()}>
                      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect">
                        <Text font="title3" fontWeight="bold" foregroundStyle={INK.strong} multilineTextAlignment="leading">
                          {translating ? "翻译中..." : titleText}
                        </Text>
                        {detail?.title ? (
                          <Text font="caption2" foregroundStyle={INK.faint}>
                            {translation !== null ? "已翻译 · 点击还原" : "点击标题翻译成中文"}
                          </Text>
                        ) : null}
                      </VStack>
                    </Button>
                  ) : null}
                  <Text font="subheadline" foregroundStyle={INK.soft}>
                    {metaText}
                  </Text>
                  {/* 评分：点按打开 JavDB 搜索（原版），长按菜单里可以重新获取；获取失败会写出原因，不和「没有评分」混成同一个 N/A */}
                  <HStack>
                    <Menu
                      primaryAction={() => open(javdbUrl)}
                      label={
                        <PillLabel
                          icon="star.fill"
                          text={ratingLabel(rating)}
                          tint={rating?.kind === "failed" ? DANGER : undefined}
                        />
                      }
                    >
                      <Button title="重新获取评分" systemImage="arrow.clockwise" action={loadRating} />
                      <Button title="在 JavDB 打开" systemImage="safari" action={() => open(javdbUrl)} />
                    </Menu>
                    <Spacer />
                  </HStack>
                  {loading ? (
                    <HStack>
                      <Spacer />
                      <ProgressView progressViewStyle="circular" tint="white" />
                      <Spacer />
                    </HStack>
                  ) : null}
                  {error ? (
                    <Text font="footnote" foregroundStyle={DANGER}>
                      {error}
                    </Text>
                  ) : null}
                </VStack>

                {/* 操作：醒目的播放 + 收藏 */}
                <HStack spacing={CAPSULE_GAP} frame={{ width: colWidth }}>
                  <PlayCapsule subline={playSubline(previews, source?.label ?? null)} width={playWidth} onPress={playBest} />
                  <CollectCapsule
                    icon={phaseView.icon}
                    title={phaseView.title}
                    color={phaseView.color}
                    disabled={phaseView.disabled}
                    width={COLLECT_WIDTH}
                    onPress={runPrimary}
                  />
                </HStack>

                {/* 小胶囊两行：第一行是「找东西」（获取 / 预览 / 磁链 / 样品图），第二行是分享和推荐 */}
                <VStack alignment="leading" spacing={8}>
                  <HStack spacing={8}>
                    <Menu label={<PillLabel icon="globe" text="获取" />}>
                      <Button title="JavDB" action={() => open(javdbUrl)} />
                      <Button title="JavLibrary" action={() => open(`http://www.javlibrary.com/cn/vl_searchbyid.php?keyword=${q}`)} />
                      <Button title="Fanza" action={() => open(`https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=${plainCode}/?dmmref=aMonoDvd_List`)} />
                      <Button title="Netflav" action={() => open(`https://netflav.com/search?type=title&keyword=${q}`)} />
                      <Button title="JAV.GURU" action={() => open(`https://jav.guru/zh/?s=${q}`)} />
                      <Button title="Jable.TV" action={() => open(`https://jable.tv/search/${q}/`)} />
                      <Button title="MissAV" action={() => open(`${MISSAV_ORIGIN}/${q}`)} />
                      <Button title="JavDay" action={() => open(`https://javday.tv/videos/${encodeURIComponent(code.replace("-", ""))}`)} />
                      <Button title="18H" action={() => open(`https://18h.mm-cg.com/zh/fc_search/all/${q}/1.html`)} />
                    </Menu>
                    <Menu label={<PillLabel icon="play.rectangle.on.rectangle" text="预览" active={!!(previews.missavFull || previews.jableHls)} />}>
                      <Button title="Fanza 预告" action={() => void playFanza()} />
                      {previews.missav ? <Button title="MissAV 预览" action={() => play({ url: previews.missav ?? "", label: "MissAV 预览" })} /> : null}
                      {previews.jable?.preview ? (
                        <Button title="Jable 预览" action={() => play({ url: previews.jable?.preview ?? "", label: "Jable 预览" })} />
                      ) : null}
                      {previews.jable ? (
                        <Button
                          title="Jable 完整视频"
                          action={() => {
                            if (previews.jableHls) play({ url: previews.jableHls, label: "Jable 完整视频", full: true });
                            else showError("未找到完整影片！");
                          }}
                        />
                      ) : null}
                      <Button title="MissAV 完整视频" action={() => void playMissavFull()} />
                    </Menu>
                    {movie.fallback ? null : (
                      <Button buttonStyle="plain" disabled={!detail} action={() => setDest({ type: "magnets" })}>
                        <PillLabel icon="magnet" text="磁链" />
                      </Button>
                    )}
                    {movie.fallback ? null : (
                      <Button buttonStyle="plain" action={openSamples}>
                        <PillLabel icon="photo.on.rectangle" text="样品图" />
                      </Button>
                    )}
                    <Spacer />
                  </HStack>
                  <HStack spacing={8}>
                    <Menu label={<PillLabel icon="square.and.arrow.up" text="分享" />}>
                      <Button
                        title="分享链接"
                        systemImage="link"
                        action={() => {
                          void buildShareLink(code).then((link) => shareItems([link]));
                        }}
                      />
                      <Button
                        title="复制番号"
                        systemImage="doc.on.doc"
                        action={() => {
                          void copyText(code).then(() => showToast(`番号 ${code} 已复制`));
                        }}
                      />
                      <Button title="分享原链" systemImage="safari" action={() => void shareItems([detail?.link ?? movie.link])} />
                      <Button title="作者推荐" systemImage="star" action={() => void recommendAsAuthor()} />
                      {recKind === "author" ? (
                        <Button title="撤销作者推荐" systemImage="star.slash" action={() => void revokeRecommendation("author")} />
                      ) : null}
                    </Menu>
                    <Menu
                      primaryAction={() => void recommendAsUser()}
                      label={<PillLabel icon="hand.thumbsup" text={recKind ? "已推荐" : "推荐影片"} />}
                    >
                      {recKind === "user" ? (
                        <Button title="撤销我的推荐" systemImage="arrow.uturn.backward" action={() => void revokeRecommendation("user")} />
                      ) : (
                        <Button title="推荐这部影片" systemImage="hand.thumbsup" action={() => void recommendAsUser()} />
                      )}
                      {recKind && usesCommunity(recKind) ? (
                        <Button title="举报这条推荐" systemImage="exclamationmark.bubble" action={() => void reportRecommendation()} />
                      ) : null}
                    </Menu>
                    {/* 字幕和横屏只给完整视频：预览片段几秒钟，用不上 */}
                    {source?.full ? <SubtitleMenu sub={sub} onOpenPanel={() => setPanelOpen(true)} /> : null}
                    {source?.full ? (
                      <Button buttonStyle="plain" action={enterFullscreen}>
                        <PillLabel icon="arrow.up.left.and.arrow.down.right" text="全屏" />
                      </Button>
                    ) : null}
                    <Spacer />
                  </HStack>
                </VStack>

                {/* 片名信息卡片 */}
                {detail ? (
                  <VStack
                    alignment="leading"
                    spacing={12}
                    padding={14}
                    frame={{ maxWidth: "infinity", alignment: "leading" }}
                    background={{ style: CARD, shape: { type: "rect", cornerRadius: 14 } }}
                  >
                    <InfoRow label="發行商">
                      <LinkText link={detail.filmEstab} onTap={pushCategory("filmEstab")} />
                    </InfoRow>
                    <InfoRow label="製作商">
                      <LinkText link={detail.filmMaker} onTap={pushCategory("filmMaker")} />
                    </InfoRow>
                    <InfoRow label="系列">
                      <LinkText link={detail.series} onTap={pushCategory("series")} />
                    </InfoRow>
                    <InfoRow label="導演">
                      <LinkText link={detail.director} onTap={pushCategory("director")} />
                    </InfoRow>
                    <HStack alignment="top" spacing={8}>
                      <Text font="subheadline" fontWeight="bold" foregroundStyle={INK.soft} frame={{ width: 64, alignment: "leading" }}>
                        類別
                      </Text>
                      {detail.genres.length === 0 ? (
                        <Text font="subheadline" foregroundStyle={INK.faint}>
                          未知
                        </Text>
                      ) : (
                        <FlowLayout spacing={6}>
                          {detail.genres.map((genre) => (
                            <Button key={genre.link} buttonStyle="plain" action={() => setDest({ type: "category", title: genre.name, link: genre.link, kind: "genre" })}>
                              <Text
                                font="caption"
                                foregroundStyle={INK.strong}
                                padding={{ horizontal: 9, vertical: 4 }}
                                background={{ style: GLASS, shape: "capsule" }}
                              >
                                {genre.name}
                              </Text>
                            </Button>
                          ))}
                        </FlowLayout>
                      )}
                    </HStack>
                  </VStack>
                ) : null}

                {/* 参演：横向的头像卡片 */}
                {detail && detail.stars.length > 0 ? (
                  <VStack alignment="leading" spacing={10}>
                    <Text font="headline" foregroundStyle={INK.strong}>
                      參演
                    </Text>
                    <ScrollView axes="horizontal" scrollIndicator="hidden">
                      <HStack spacing={14} alignment="top">
                        {detail.stars.map((star) => (
                          <Button key={star.link} buttonStyle="plain" action={() => setDest({ type: "star", star })}>
                            <VStack spacing={6} frame={{ width: STAR_SIZE }}>
                              <RemoteImage
                                url={star.avatar}
                                maxSide={220}
                                mode="fill"
                                width={STAR_SIZE}
                                height={STAR_SIZE}
                                radius={STAR_SIZE / 2}
                                background="rgba(255,255,255,0.08)"
                              />
                              <Text font={11} foregroundStyle={INK.body} lineLimit={1} minScaleFactor={0.7}>
                                {star.name}
                              </Text>
                            </VStack>
                          </Button>
                        ))}
                      </HStack>
                    </ScrollView>
                  </VStack>
                ) : null}
              </VStack>
            </ScrollView>
          )}
        </VStack>
      </VStack>

      {/* 字幕设置面板：竖屏时浮在画面下方（画面还在上面，调的时候看得见字幕），全屏时贴在右侧、让出右缘那一列按钮 */}
      {panelOpen && source?.full ? (
        <VStack
          frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: fullscreen ? "trailing" : "bottom" }}
          padding={fullscreen ? { vertical: 10, trailing: PANEL_RIGHT_GAP } : { bottom: 12 }}
        >
          <SubtitlePanel
            sub={sub}
            width={fullscreen ? PANEL_WIDTH_FULLSCREEN : columnWidth()}
            onClose={() => setPanelOpen(false)}
          />
        </VStack>
      ) : null}
    </ZStack>
  );
}
