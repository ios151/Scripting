// 底层：硬件规格、硬件树、设备开放了哪些服务，外加开发者磁盘镜像的状态。
//
// 这一页原先的主角是 MobileGestalt 查询。iOS 27 起系统把那条路停了
//（回包恒为 `MobileGestaltDeprecated`），所以整块去掉了——留着只会让人对着
// 空列表试键名。能用的东西都搬到了这几项里，替代品是 lockdown 的 GetValue。

import { HStack, Image, List, NavigationLink, Section, Spacer, Text, VStack, type Color } from "scripting";
import { readImageStatus, type ImageStatus } from "../kit/imageMounter";
import { HardwarePage } from "./HardwarePage";
import { ServicesPage } from "./ServicesPage";
import { SpecPage } from "./SpecPage";
import { TaskStateSection, useDeviceTask, ValueRow } from "./common";

function Row({
  title,
  subtitle,
  systemImage,
  color,
}: {
  title: string;
  subtitle: string;
  systemImage: string;
  color: Color;
}) {
  return (
    <HStack spacing={12}>
      <Image systemName={systemImage} foregroundStyle={color} font="title3" frame={{ width: 30 }} />
      <VStack alignment="leading" spacing={2}>
        <Text>{title}</Text>
        <Text font="caption" foregroundStyle="secondaryLabel">
          {subtitle}
        </Text>
      </VStack>
      <Spacer />
    </HStack>
  );
}

function ImageSection({ status }: { status: ImageStatus }) {
  return (
    <Section
      header={<Text>开发者磁盘镜像</Text>}
      footer={
        <Text foregroundStyle="tertiaryLabel">
          没挂载的话「实时性能」那一页用不了——它走 Instruments 通道，服务表里得先有 dtservicehub。
          一般在开发者模式打开后，连一次 Xcode 或重启设备时由系统挂载，这个脚本挂不了。
        </Text>
      }
    >
      <ValueRow
        label="镜像"
        value={status.mounted === null ? "未挂载" : `已挂载（签名 ${status.signatureBytes ?? 0} 字节）`}
      />
      <ValueRow
        label="开发者模式"
        value={status.developerMode === null ? "读不到" : status.developerMode ? "已打开" : "没打开"}
      />
    </Section>
  );
}

export function LowLevelPage() {
  const task = useDeviceTask((session) => readImageStatus(session));

  return (
    <List navigationTitle="底层" navigationBarTitleDisplayMode="inline" listStyle="insetGroup" refreshable={task.reload}>
      <Section
        footer={
          <Text foregroundStyle="tertiaryLabel">
            硬件规格是解码过的摘要，硬件树是原始的那棵。两边数据同源，前者好读，后者全。
          </Text>
        }
      >
        <NavigationLink destination={<SpecPage />}>
          <Row title="硬件规格" subtitle="芯片、屏幕、触控、存储，解码后的" systemImage="cpu" color="systemPink" />
        </NavigationLink>
        <NavigationLink destination={<HardwarePage />}>
          <Row title="硬件树" subtitle="IORegistry 原始节点，可自己填类名" systemImage="list.bullet.indent" color="systemIndigo" />
        </NavigationLink>
        <NavigationLink destination={<ServicesPage />}>
          <Row
            title="设备提供的服务"
            subtitle="握手时设备自报的那份表"
            systemImage="list.bullet.rectangle.portrait"
            color="systemTeal"
          />
        </NavigationLink>
      </Section>

      <TaskStateSection task={task} />
      {task.data ? <ImageSection status={task.data} /> : null}
    </List>
  );
}
