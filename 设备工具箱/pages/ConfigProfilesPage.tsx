// 配置描述文件：系统设置 →「VPN 与设备管理」里那些。
//
// 和「签名到期」看的不是一回事——那边是打包签名用的，这边是 VPN、证书、Web Clip。
// 设置里只能一个个点开看，这里一次列全。
//
// **只读。** 删描述文件没做。

import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  NavigationLink,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
  useState,
  type Color,
} from "scripting";
import { describeError } from "../core/debug";
import { deviceHub } from "../kit/hub";
import {
  KIND_LABEL,
  classifyProfile,
  profilesText,
  readConfigProfiles,
  removeConfigProfile,
  type ConfigProfile,
  type ProfileKind,
} from "../kit/configProfiles";
import { copyWithFeedback, exportText, TaskStateSection, useDeviceTask, ValueRow } from "./common";

const KIND_ICON: Record<ProfileKind, string> = {
  proxyCa: "checkmark.seal",
  webClip: "square.grid.2x2",
  udid: "number",
  other: "doc.text",
};

const KIND_COLOR: Record<ProfileKind, Color> = {
  proxyCa: "systemOrange",
  webClip: "systemIndigo",
  udid: "systemTeal",
  other: "secondaryLabel",
};

function DetailPage({ profile, onRemoved }: { profile: ConfigProfile; onRemoved: () => void }) {
  const dismiss = Navigation.useDismiss();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const kind = classifyProfile(profile);

  /**
   * 删。弹窗里把**删的是哪一份、删完会怎样**写清楚。
   *
   * 代理工具的根证书单独提一句：删了那个工具就解不了 HTTPS，
   * 而这件事从「删一份描述文件」这几个字上看不出来。
   */
  async function remove() {
    if (busy) return;
    const ok = await Dialog.confirm({
      title: `删掉「${profile.name}」？`,
      message:
        `${profile.identifier}\n\n` +
        (kind === "proxyCa"
          ? "这是个根证书。删了以后对应的代理工具就解不了 HTTPS，要回那个工具里重新生成并安装一份。"
          : "删了就没了，要回来得重新装一遍。") +
        "\n\n系统可能会要求输设备密码。",
      confirmLabel: "删除",
    });
    if (!ok) return;
    setBusy(true);
    setNote("");
    try {
      await removeConfigProfile(await deviceHub.get(), profile);
      onRemoved();
      dismiss();
    } catch (error) {
      setNote(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <List navigationTitle={profile.name} navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section header={<Text>基本</Text>} footer={<Text foregroundStyle="tertiaryLabel">点一行或长按都能复制。</Text>}>
        <ValueRow label="名称" value={profile.name} />
        <ValueRow label="组织" value={profile.organization || "—"} />
        <ValueRow label="状态" value={profile.active ? "生效中" : "未生效"} />
        <ValueRow label="能否删除" value={profile.locked ? "装上就删不掉" : "可以在设置里删"} />
        <ValueRow label="标识" value={profile.identifier} />
        <ValueRow label="UUID" value={profile.uuid || "—"} />
      </Section>

      {profile.description ? (
        <Section
          header={<Text>安装时的说明</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              这是装它的时候屏幕上显示的那段话，原样留着。推广类的描述文件全靠这段措辞，值得读一遍。
            </Text>
          }
        >
          <Text font="caption">{profile.description}</Text>
        </Section>
      ) : null}

      <Section
        footer={
          <Text foregroundStyle={note ? "systemRed" : "tertiaryLabel"}>
            {note ||
              (profile.locked
                ? "这一份标了不允许删除（一般是 MDM 下发的），设备不会接受。"
                : "删除没有撤销。删完会重新列一遍核对，以设备返回的结果为准。")}
          </Text>
        }
      >
        <Button
          title="复制这一份"
          systemImage="doc.on.doc"
          action={() => copyWithFeedback(profilesText([profile]))}
        />
        {busy ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel">删除中…</Text>
          </HStack>
        ) : (
          <Button
            title="删除这份描述文件"
            systemImage="trash"
            role="destructive"
            disabled={profile.locked}
            action={() => void remove()}
          />
        )}
      </Section>
    </List>
  );
}

export function ConfigProfilesPage() {
  const task = useDeviceTask((session) => readConfigProfiles(session));
  const profiles = task.data ?? [];

  const groups = (["proxyCa", "webClip", "udid", "other"] as ProfileKind[])
    .map((kind) => ({ kind, items: profiles.filter((profile) => classifyProfile(profile) === kind) }))
    .filter((group) => group.items.length > 0);

  return (
    <List
      navigationTitle="配置描述文件"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      refreshable={task.reload}
    >
      <TaskStateSection task={task} />

      {task.data ? (
        <Section
          footer={
            <Text foregroundStyle="tertiaryLabel">
              就是「设置 → 通用 → VPN 与设备管理」里那些：VPN 配置、根证书、Web Clip。
              和「签名到期」看的 provisioning profile 不是一回事。只看，不删。
            </Text>
          }
        >
          <HStack>
            <Text>一共</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`${profiles.length} 份`}</Text>
          </HStack>
          {profiles.length > 0 ? (
            [
              <Button
                key="export"
                title="导出成 txt"
                systemImage="square.and.arrow.up"
                action={() => void exportText("配置描述文件", profilesText(profiles))}
              />,
              <Button
                key="copy"
                title="复制整份清单"
                systemImage="doc.on.doc"
                action={() => copyWithFeedback(profilesText(profiles))}
              />,
            ]
          ) : (
            <Text foregroundStyle="tertiaryLabel">一份都没装。</Text>
          )}
        </Section>
      ) : null}

      {groups.map((group) => (
        <Section key={group.kind} header={<Text>{`${KIND_LABEL[group.kind]}（${group.items.length}）`}</Text>}>
          {group.items.map((profile) => (
            <NavigationLink
              key={profile.identifier}
              destination={<DetailPage profile={profile} onRemoved={task.reload} />}
            >
              <HStack spacing={10}>
                <Image
                  systemName={KIND_ICON[group.kind]}
                  foregroundStyle={KIND_COLOR[group.kind]}
                  frame={{ width: 26 }}
                />
                <VStack alignment="leading" spacing={2}>
                  <Text foregroundStyle="label" lineLimit={1}>
                    {profile.name}
                  </Text>
                  <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={1}>
                    {profile.organization || profile.identifier}
                  </Text>
                </VStack>
                <Spacer />
                {profile.locked ? <Image systemName="lock" foregroundStyle="systemOrange" /> : null}
                {!profile.active ? <Text font="caption" foregroundStyle="tertiaryLabel">未生效</Text> : null}
              </HStack>
            </NavigationLink>
          ))}
        </Section>
      ))}
    </List>
  );
}
