// 「女优」页：有码 / 无码两套演员列表，滚到底翻页，点头像进演员页。
//
// 原版的「有码 / 无码 / 欧美」切换在这一页也有：选「欧美」会跳回「最新」页显示欧美列表
// （欧美站没有演员列表），这里同样——发一个请求给首页，不在本页停留。

import { ContentUnavailableView, Navigation, NavigationStack, ScrollView, VStack, ZStack, useState } from "scripting";

import { parseStars } from "../core/parse";
import { actressListUrl } from "../core/site";
import type { StarItem } from "../core/types";
import { getPage } from "../kit/http";
import { requestLaunch } from "../kit/launch";
import { ActressPage } from "./ActressPage";
import { LoadFooter, SearchBar, StarGrid } from "./components";
import { rootToolbar } from "./rootToolbar";
import { PageBackdrop, SIDE, Segmented, TINT } from "./theme";
import { usePaged } from "./usePaged";

type Kind = "censored" | "uncensored";

const KIND_ITEMS: { key: Kind | "western"; label: string }[] = [
  { key: "censored", label: "有码" },
  { key: "uncensored", label: "无码" },
  { key: "western", label: "欧美" },
];

export function StarsPage() {
  const dismiss = Navigation.useDismiss();
  const [kind, setKind] = useState<Kind>("censored");
  const [input, setInput] = useState("");

  const paged = usePaged<StarItem>(
    kind,
    async (page) => {
      const res = await getPage(actressListUrl(kind, page));
      const stars = parseStars(res.html, res.url);
      return { items: stars, done: stars.length === 0 };
    },
    (star) => star.link,
  );

  const onKind = (value: Kind | "western") => {
    // 选「欧美」不在本页停留：分段的选中项由 kind 决定，kind 没变，选中项就还是当前分区
    if (value === "western") requestLaunch({ type: "kind", kind: "western" });
    else setKind(value);
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    requestLaunch({ type: "search", keyword: text });
    setInput("");
  };

  return (
    <NavigationStack>
      <ZStack>
        <PageBackdrop tint={TINT.stars} />
        <ScrollView
          navigationTitle="女优"
          navigationBarTitleDisplayMode="inline"
          toolbar={rootToolbar(() => dismiss())}
          refreshable={async () => {
            paged.reload();
          }}
        >
          <VStack spacing={14} padding={{ top: 8, bottom: 24 }}>
            <VStack spacing={10} padding={{ horizontal: SIDE }}>
              <SearchBar value={input} onChanged={setInput} onSubmit={submit} />
              <Segmented items={KIND_ITEMS} selected={kind} onSelect={onKind} />
            </VStack>
            {paged.items.length === 0 && !paged.loading && !paged.error ? (
              <ContentUnavailableView title="暂无演员" systemImage="person.2" />
            ) : (
              <StarGrid stars={paged.items} destinationFor={(star) => <ActressPage star={star} />} onNearEnd={paged.loadMore} />
            )}
            <LoadFooter loading={paged.loading} error={paged.error} done={paged.done} count={paged.items.length} onRetry={paged.retry} />
          </VStack>
        </ScrollView>
      </ZStack>
    </NavigationStack>
  );
}
