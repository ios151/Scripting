// 详情页上的字幕状态：搜索 → 载入 → 换一条 / 同步偏移 / 显示隐藏。界面在 SubtitleParts.tsx / SubtitlePanel.tsx。
// 字幕的外观（颜色 / 字号 / 透明度 / 位置）不在这里：它所有影片共用，放在 kit/subtitleLook.ts 的全局状态里（见那里的说明）。
// 调用方是 MovieDetailPage：状态跟着详情页走，播放器换片源（预览 ↔ 完整视频、MissAV ↔ Jable）重新挂载时字幕不会丢——
// 同一部片的字幕对哪个完整视频都适用，对不上用偏移调；预览片段用不上字幕，叠层只给 source.full。

import { useEffect, useRef, useState } from "scripting";

import { durationGapLabel, offsetLabel, shiftOffset, type SubtitleChoice, type SubtitleCue } from "../core/subtitle";
import { choiceLabel } from "../core/subtitlecat";
import { describeError } from "../kit/http";
import { takeTip } from "../kit/settings";
import { loadSubtitle, searchSubtitles, type LoadedSubtitle } from "../kit/subtitle";
import { showError, showToast } from "../kit/toast";

export interface Subtitles {
  /** 正在搜索或载入。 */
  busy: boolean;
  /** 载入好的字幕；还没有 = null。 */
  cues: SubtitleCue[] | null;
  visible: boolean;
  /** 同步偏移（秒），正数 = 字幕提前出现。 */
  offset: number;
  /** 当前这条的一句话说明（来源 · 文件名 · 语言 · 条数 · 时长对比 · 偏移 · 第几条）；没载入是空串。来源只有字幕猫的才写（迅雷的不写）。 */
  summary: string;
  /** 载入的这份字幕的下载地址，交给外部播放器当外挂字幕用；没载入是空串。 */
  url: string;
  choiceCount: number;
  search: () => void;
  next: () => void;
  toggle: () => void;
  shift: (delta: number) => void;
  resetOffset: () => void;
}

/** 播放器已知的视频时长（秒）；还没就绪、或者是直播（不是有限数）时返回 0，搜索时就不按时长排。 */
function videoSeconds(av: AVPlayer | null): number {
  const d = av?.duration ?? 0;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * @param code 番号，拿去搜字幕
 * @param getPlayer 取当前的 AVPlayer（还没就绪是 null），排序要用视频时长
 */
export function useSubtitles(code: string, getPlayer: () => AVPlayer | null): Subtitles {
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<SubtitleChoice[]>([]);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<LoadedSubtitle | null>(null);
  const [visible, setVisible] = useState(true);
  const [offset, setOffset] = useState(0);
  // 同一时刻只做一件事（busy 的 ref 版本给回调里判断用，state 版本给界面用）；
  // 序号：卸载时作废在途的结果，免得页面没了还去 setState
  const working = useRef(false);
  const work = useRef(0);

  useEffect(
    () => () => {
      work.current++;
    },
    [],
  );

  /** 从第 from 条起往后试（到头绕回第一条）：第一条载得进来的就用，一圈下来都不行才报错。 */
  const loadFrom = async (list: SubtitleChoice[], from: number, seq: number): Promise<void> => {
    let reason = "";
    for (let step = 0; step < list.length; step++) {
      const i = (from + step) % list.length;
      try {
        const result = await loadSubtitle(list[i]);
        if (seq !== work.current) return;
        setLoaded(result);
        setIndex(i);
        setVisible(true);
        // 第一次载入字幕时提一句：字幕能拖、样式在设置面板里（只提这一回）
        if (takeTip("subtitleDrag")) showToast("字幕可以用手指拖着挪位置；颜色、字号在「字幕设置」里改");
        return;
      } catch (error) {
        if (seq !== work.current) return;
        reason = describeError(error);
      }
    }
    showError(list.length > 1 ? "这几条字幕都打不开，可以稍后再试" : reason);
  };

  /** 占住「正在做」，做完放开；卸载了就什么都不碰。 */
  const run = async (task: (seq: number) => Promise<void>): Promise<void> => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    const seq = ++work.current;
    try {
      await task(seq);
    } catch (error) {
      if (seq === work.current) showError(describeError(error));
    } finally {
      if (seq === work.current) {
        working.current = false;
        setBusy(false);
      }
    }
  };

  const search = () =>
    void run(async (seq) => {
      const found = await searchSubtitles(code, videoSeconds(getPlayer()));
      if (seq !== work.current) return;
      if (found.length === 0) {
        showToast(`迅雷字幕库和字幕猫里都没有「${code}」的字幕`);
        return;
      }
      setChoices(found);
      await loadFrom(found, 0, seq);
    });

  const next = () => {
    if (choices.length > 1) void run((seq) => loadFrom(choices, index + 1, seq));
  };

  const current = loaded ? choices[index] : undefined;
  const summary =
    loaded && current
      ? [
          choiceLabel(current),
          current.name,
          loaded.language || "语言未知",
          `${loaded.cues.length} 条`,
          durationGapLabel(current.duration, videoSeconds(getPlayer())),
          offset !== 0 ? offsetLabel(offset) : "",
        ]
          .filter(Boolean)
          .join(" · ") + (choices.length > 1 ? `（${index + 1}/${choices.length}）` : "")
      : "";

  return {
    busy,
    cues: loaded?.cues ?? null,
    visible,
    offset,
    summary,
    url: loaded?.url ?? "",
    choiceCount: choices.length,
    search,
    next,
    toggle: () => setVisible((v) => !v),
    shift: (delta) => setOffset((o) => shiftOffset(o, delta)),
    resetOffset: () => setOffset(0),
  };
}
