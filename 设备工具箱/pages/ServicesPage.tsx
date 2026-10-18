// 设备提供了哪些服务。
//
// 这份表是建会话时设备自己报上来的（RSD 握手的回包），不是猜的、也不用再去问一次。
// 本脚本一直只用其中几个，剩下的从没看过——想知道「还能做什么」，先看这张表最实在。
//
// 只是列出来。点不开、连不上，也不会去连。

import { Button, HStack, Image, List, Section, Spacer, Text, VStack, type Color } from "scripting";
import { KIND_TITLE, describeServices, listText, type ServiceKind, type ServiceRow } from "../kit/serviceList";
import { copyWithFeedback, exportText, TaskStateSection, useDeviceTask } from "./common";

const KIND_SYMBOL: Record<ServiceKind, string> = {
  used: "checkmark.circle.fill",
  known: "circle",
  unknown: "questionmark.circle",
};

const KIND_COLOR: Record<ServiceKind, Color> = {
  used: "systemGreen",
  known: "secondaryLabel",
  unknown: "tertiaryLabel",
};

function Row({ row }: { row: ServiceRow }) {
  return (
    <Button action={() => copyWithFeedback(row.name)}>
      <HStack spacing={10} alignment="top">
        <Image systemName={KIND_SYMBOL[row.kind]} foregroundStyle={KIND_COLOR[row.kind]} frame={{ width: 24 }} />
        <VStack alignment="leading" spacing={2}>
          {/* 名字用等宽：一屏几十条，对齐了才扫得动 */}
          <Text font="caption" fontDesign="monospaced" foregroundStyle="label">
            {row.name}
          </Text>
          {row.detail ? (
            <Text font="caption" foregroundStyle="secondaryLabel">
              {row.detail}
            </Text>
          ) : null}
        </VStack>
        <Spacer />
        <Text font="caption2" fontDesign="monospaced" foregroundStyle="tertiaryLabel">
          {String(row.port)}
        </Text>
      </HStack>
    </Button>
  );
}

export function ServicesPage() {
  const task = useDeviceTask(async (session) => describeServices(session.services));
  const rows = task.data ?? [];

  return (
    <List navigationTitle="设备提供的服务" navigationBarTitleDisplayMode="inline" listStyle="insetGroup" refreshable={task.reload}>
      <TaskStateSection task={task} />

      {rows.length > 0 ? (
        <Section
          footer={
            <Text foregroundStyle="tertiaryLabel">
              建会话时设备自己报上来的，不是猜的。点一行复制服务名。右边是端口。
              这一页只列出来，不会去连任何一个。
            </Text>
          }
        >
          <HStack>
            <Text>一共</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`${rows.length} 个`}</Text>
          </HStack>
          <HStack>
            <Text foregroundStyle="systemGreen">{`已用 ${rows.filter((row) => row.kind === "used").length}`}</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`认识 ${rows.filter((row) => row.kind === "known").length}`}</Text>
            <Text foregroundStyle="tertiaryLabel">{`　没见过 ${rows.filter((row) => row.kind === "unknown").length}`}</Text>
          </HStack>
          <Button
            title="导出成 txt"
            systemImage="square.and.arrow.up"
            action={() => void exportText("设备服务表", listText(rows))}
          />
          <Button title="复制整份清单" systemImage="doc.on.doc" action={() => copyWithFeedback(listText(rows))} />
        </Section>
      ) : null}

      {(["used", "known", "unknown"] as ServiceKind[]).map((kind) => {
        const group = rows.filter((row) => row.kind === kind);
        if (group.length === 0) return null;
        return (
          <Section key={kind} header={<Text>{`${KIND_TITLE[kind]}（${group.length}）`}</Text>}>
            {group.map((row) => (
              <Row key={row.name} row={row} />
            ))}
          </Section>
        );
      })}
    </List>
  );
}
