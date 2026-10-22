// 磁链列表。
//
// 原版：页眉「JavBus 站点资源」，每行 名称 / 大小 / 时间 / 高清 / 字幕；点一下复制，左滑分享，
// 下拉刷新；没有磁链显示「☹️ JavBus 暂无磁链」。点击复制之后原版还会把磁链推到 Quicker，
// 第一次要现场输邮箱和口令——这里改成在设置里配好，没配就只复制，不逼人在点磁链的当口填表。

import {
  Button,
  ContentUnavailableView,
  HStack,
  List,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting";

import type { Magnet, MagnetParams } from "../core/types";
import { describeError } from "../kit/http";
import { loadMagnets } from "../kit/magnets";
import { copyText, pushToQuicker, shareItems } from "../kit/share";
import { showToast } from "../kit/toast";
import { Badge } from "./components";
import { PageBackdrop } from "./theme";

type State = { phase: "loading" } | { phase: "ready"; items: Magnet[] } | { phase: "error"; message: string };

export function MagnetPage({
  code,
  detailUrl,
  params,
}: {
  code: string;
  detailUrl: string;
  params: MagnetParams | null;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = async (force: boolean) => {
    if (force) setState({ phase: "loading" });
    try {
      setState({ phase: "ready", items: await loadMagnets(detailUrl, params, force) });
    } catch (error) {
      setState({ phase: "error", message: describeError(error) });
    }
  };

  useEffect(() => {
    void load(false);
  }, [detailUrl]);

  const copyOne = async (magnet: Magnet) => {
    await copyText(magnet.link);
    HapticFeedback.lightImpact();
    showToast("💡 磁链已复制");
    const pushed = await pushToQuicker(magnet.link);
    if (pushed) showToast(pushed.ok ? "已推送到 Quicker" : `Quicker：${pushed.message}`);
  };

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <PageBackdrop />
      <List
        navigationTitle={code}
        navigationBarTitleDisplayMode="inline"
        scrollContentBackground="hidden"
        refreshable={async () => {
          await load(true);
        }}
      >
        <Section header={<Text>JavBus 站点资源</Text>} footer={<Text>点击复制磁链 · 左滑分享 · 下拉刷新</Text>}>
          {state.phase === "loading" ? (
            <HStack padding={20}>
              <Spacer />
              <ProgressView />
              <Spacer />
            </HStack>
          ) : state.phase === "error" ? (
            <VStack spacing={8} padding={12}>
              <Text foregroundStyle="systemRed" multilineTextAlignment="center">
                {state.message}
              </Text>
              <Button title="重试" systemImage="arrow.clockwise" action={() => void load(true)} />
            </VStack>
          ) : state.items.length === 0 ? (
            <ContentUnavailableView title="☹️ JavBus 暂无磁链" systemImage="magnet" description="下拉可以重新获取" />
          ) : (
            state.items.map((magnet) => (
              <Button
                key={magnet.link}
                buttonStyle="plain"
                action={() => void copyOne(magnet)}
                // 不用 role="destructive"：它会把整行推歪；这里本来也不是破坏性操作
                trailingSwipeActions={{
                  allowsFullSwipe: false,
                  actions: [
                    <Button
                      key="share"
                      title="分享"
                      systemImage="square.and.arrow.up"
                      tint="systemBlue"
                      action={() => void shareItems([magnet.link])}
                    />,
                  ],
                }}
              >
                <VStack
                  alignment="leading"
                  spacing={6}
                  padding={{ vertical: 4 }}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                  contentShape="rect"
                >
                  <Text font="subheadline" lineLimit={2} multilineTextAlignment="leading">
                    {magnet.name}
                  </Text>
                  <HStack spacing={8}>
                    <Text font="caption" foregroundStyle="secondaryLabel">
                      {magnet.size}
                    </Text>
                    {magnet.hd ? <Badge text="高清" color="#7294b1" /> : null}
                    {magnet.sub ? <Badge text="字幕" color="#f2b867" /> : null}
                    <Spacer />
                    <Text font="caption" foregroundStyle="secondaryLabel">
                      {magnet.date}
                    </Text>
                  </HStack>
                </VStack>
              </Button>
            ))
          )}
        </Section>
      </List>
    </ZStack>
  );
}
