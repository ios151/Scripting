// App 页里可以展开 / 收起的几组：哪几组是展开着的，存下来、下次打开还是那样。纯函数，不碰系统。
//
// 存储里读出来一律先 parse：只认认得的组、只认 true；坏了就当全收着。

/** 可收起的组，id 就是存下来的键 */
export const FOLD_IDS = ["display", "place", "source", "alerts", "summary", "week", "detail", "air", "life", "status", "widget", "credits"] as const;

export type FoldId = (typeof FOLD_IDS)[number];

/** 展开着的组（值都是 true）；没写的就是收着 */
export type Folds = Partial<Record<FoldId, true>>;

export function parseFolds(raw: unknown): Folds {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const folds: Folds = {};
  for (const id of FOLD_IDS) {
    if (record[id] === true) folds[id] = true;
  }
  return folds;
}

/** 展开或收起一组，返回新的（不改传进来的） */
export function setFold(folds: Folds, id: FoldId, open: boolean): Folds {
  const next: Folds = { ...folds };
  if (open) next[id] = true;
  else delete next[id];
  return next;
}
