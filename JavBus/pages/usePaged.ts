// 分页加载的通用 hook：首页、搜索、类目、演员作品都是「第 N 页 → 一批条目 → 滚到底再取下一页」。
//
// 几个要点：
// - `key` 变了（切分区 / 换关键词 / 切全部收录）就清空重来；在途的旧请求回来时靠 token 作废，
//   不然慢的旧响应会把新列表覆盖掉。
// - fetcher 走 ref：useEffect 里捕获的是首帧闭包，回调里读 state 会读到旧值，走 ref 才永远拿到最新的。
// - 条目按 `identify` 去重：翻页边界偶尔会重复一两部。
// - 错误只记 message，由页面决定怎么显示；「到底了」不是错误，是 done。

import { useCallback, useEffect, useRef, useState } from "scripting";

export interface PageResult<T> {
  items: T[];
  /** 没有下一页了（404 / 空页）。 */
  done: boolean;
}

export interface Paged<T> {
  items: T[];
  loading: boolean;
  error: string;
  done: boolean;
  loadMore: () => void;
  /** 失败之后手动重试：首页没取到就重头来，翻页失败就重取那一页。 */
  retry: () => void;
  reload: () => void;
}

interface State<T> {
  items: T[];
  loading: boolean;
  error: string;
  done: boolean;
}

export function usePaged<T>(
  key: string,
  fetchPage: (page: number) => Promise<PageResult<T>>,
  identify: (item: T) => string,
  enabled = true,
): Paged<T> {
  const [state, setState] = useState<State<T>>({ items: [], loading: enabled, error: "", done: false });
  const token = useRef(0);
  const pageRef = useRef(0);
  const busy = useRef(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const identifyRef = useRef(identify);
  identifyRef.current = identify;
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async (reset: boolean) => {
    if (busy.current && !reset) return;
    const mine = ++token.current;
    busy.current = true;
    if (reset) pageRef.current = 0;
    setState((s) => ({ items: reset ? [] : s.items, loading: true, error: "", done: reset ? false : s.done }));
    try {
      const result = await fetchRef.current(pageRef.current + 1);
      if (mine !== token.current) return;
      pageRef.current += 1;
      setState((s) => {
        const base = reset ? [] : s.items;
        const seen = new Set(base.map(identifyRef.current));
        const fresh = result.items.filter((item) => {
          const id = identifyRef.current(item);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        return { items: [...base, ...fresh], loading: false, error: "", done: result.done || fresh.length === 0 };
      });
    } catch (error) {
      if (mine !== token.current) return;
      setState((s) => ({ ...s, loading: false, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (mine === token.current) busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      token.current++; // 作废在途请求
      busy.current = false;
      return;
    }
    void load(true);
    return () => {
      token.current++;
      busy.current = false;
    };
  }, [key, enabled]);

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (s.loading || s.done || s.error) return;
    void load(false);
  }, []);

  const reload = useCallback(() => {
    void load(true);
  }, []);

  const retry = useCallback(() => {
    void load(pageRef.current === 0);
  }, []);

  return { items: state.items, loading: state.loading, error: state.error, done: state.done, loadMore, retry, reload };
}
