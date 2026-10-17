// 签名到期：手机上装的描述文件，按到期时间排，标出快到期 / 已过期，以及哪些 App 在用它。
// 可以删单个，也可以一键清掉已过期的。

import {
  Button,
  HStack,
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
import { debugLog, describeError } from "../core/debug";
import { readApps, type AppEntry } from "../kit/apps";
import { deviceHub } from "../kit/hub";
import { ymdhm } from "../kit/dates";
import {
  PROFILE_KIND_LABEL,
  SOON_DAYS,
  appsForProfile,
  expiryState,
  readProfiles,
  removeProfile,
  type ExpiryState,
  type ProfileEntry,
} from "../kit/profiles";
import { flattenSorted } from "../kit/services";
import { RawListPage } from "./RawListPage";
import { TaskStateSection, ValueRow, useDeviceTask } from "./common";
import { TestClockBanner } from "./testClock";

const LEVEL_COLOR: Record<ExpiryState["level"], Color> = {
  expired: "systemRed",
  soon: "systemOrange",
  ok: "secondaryLabel",
  unknown: "tertiaryLabel",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return ymdhm(date);
}

function usageText(apps: AppEntry[]): string {
  return apps.map((app) => app.name).join("、");
}

function removeWarning(apps: AppEntry[]): string {
  return apps.length > 0
    ? `用它签名的 App 会打不开，直到重新签名：${usageText(apps)}。`
    : "没找到在用它的 App，删掉一般没有影响。";
}

function ProfileRow({ profile, apps }: { profile: ProfileEntry; apps: AppEntry[] }) {
  const state = expiryState(profile.expires);
  return (
    <VStack alignment="leading" spacing={3}>
      <HStack spacing={8}>
        <Text lineLimit={1}>{profile.name}</Text>
        <Spacer />
        <Text font="subheadline" foregroundStyle={LEVEL_COLOR[state.level]}>
          {state.text}
        </Text>
      </HStack>
      <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>
        {`${PROFILE_KIND_LABEL[profile.kind]} · ${profile.teamName || profile.teamId || "未知团队"}`}
      </Text>
      {apps.length > 0 ? (
        <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={1}>
          {`用于：${usageText(apps)}`}
        </Text>
      ) : null}
    </VStack>
  );
}

function ProfileDetailPage({
  profile,
  apps,
  onRemoved,
}: {
  profile: ProfileEntry;
  apps: AppEntry[];
  onRemoved: (uuid: string) => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const state = expiryState(profile.expires);

  async function remove() {
    if (working) return;
    const ok = await Dialog.confirm({ title: `删除「${profile.name}」？`, message: removeWarning(apps), confirmLabel: "删除" });
    if (!ok) return;
    setWorking(true);
    setMessage("");
    try {
      await removeProfile(await deviceHub.get(), profile.uuid);
      onRemoved(profile.uuid);
      dismiss();
    } catch (error) {
      setMessage(`删除失败：${describeError(error)}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <List navigationTitle={profile.name} navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section header={<Text>到期</Text>}>
        <HStack>
          <Text>状态</Text>
          <Spacer />
          <Text foregroundStyle={LEVEL_COLOR[state.level]}>{state.text}</Text>
        </HStack>
        <ValueRow label="到期时间" value={formatDate(profile.expires)} />
        <ValueRow label="创建时间" value={formatDate(profile.created)} />
      </Section>

      <Section header={<Text>详情</Text>} footer={<Text foregroundStyle="tertiaryLabel">点一行复制它的值。</Text>}>
        <ValueRow label="类型" value={PROFILE_KIND_LABEL[profile.kind]} />
        <ValueRow label="团队" value={profile.teamName || "—"} />
        <ValueRow label="Team ID" value={profile.teamId || "—"} />
        <ValueRow label="App ID 名称" value={profile.appIdName || "—"} />
        <ValueRow label="App ID" value={profile.appIdentifier || "—"} />
        <ValueRow label="设备数" value={profile.deviceCount === null ? "不限（企业）" : String(profile.deviceCount)} />
        <ValueRow label="UUID" value={profile.uuid || "—"} />
      </Section>

      <Section
        header={<Text>证书</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            证书自己的有效期和描述文件的不是一回事：免费账号的证书 7 天、企业证书一年。
            证书先到期时，描述文件看着还好好的，包却已经打不开了。
          </Text>
        }
      >
        {profile.certificates.length === 0 ? (
          <Text foregroundStyle="tertiaryLabel">没有读出证书</Text>
        ) : (
          profile.certificates.map((cert, index) => {
            const state = expiryState(cert.notAfter);
            return (
              <VStack key={`${cert.subject}-${index}`} alignment="leading" spacing={3}>
                <HStack spacing={8}>
                  <Text font="subheadline" lineLimit={1}>{cert.subject || "（无主体名）"}</Text>
                  <Spacer />
                  <Text font="caption" foregroundStyle={LEVEL_COLOR[state.level]}>{state.text}</Text>
                </HStack>
                {cert.organization ? (
                  <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{cert.organization}</Text>
                ) : null}
                <Text font="caption2" foregroundStyle="tertiaryLabel" lineLimit={1}>
                  {`${formatDate(cert.notBefore)} → ${formatDate(cert.notAfter)}`}
                </Text>
                {cert.issuer ? (
                  <Text font="caption2" foregroundStyle="tertiaryLabel" lineLimit={1}>{`颁发者：${cert.issuer}`}</Text>
                ) : null}
              </VStack>
            );
          })
        )}
      </Section>

      <Section
        header={<Text>授权的能力</Text>}
        footer={<Text foregroundStyle="tertiaryLabel">描述文件允许这个 App 用的权限。App 用了这里没有的权限，多半装得上但一打开就闪退。</Text>}
      >
        {profile.entitlementKeys.length === 0 ? (
          <Text foregroundStyle="tertiaryLabel">没有 entitlements</Text>
        ) : (
          <NavigationLink destination={<RawListPage title="授权的能力" rows={flattenSorted(profile.entitlements)} />}>
            <HStack>
              <Text>全部权限</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{`${profile.entitlementKeys.length} 项`}</Text>
            </HStack>
          </NavigationLink>
        )}
      </Section>

      <Section header={<Text>在用它的 App</Text>}>
        {apps.length > 0 ? (
          apps.map((app) => <ValueRow key={app.bundleId} label={app.name} value={app.bundleId} />)
        ) : (
          <Text foregroundStyle="tertiaryLabel">没找到</Text>
        )}
      </Section>

      <Section
        footer={
          <Text foregroundStyle={message ? "systemRed" : "tertiaryLabel"}>{message || removeWarning(apps)}</Text>
        }
      >
        {working ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel">删除中…</Text>
          </HStack>
        ) : (
          <Button title="删除描述文件" systemImage="trash" role="destructive" action={() => void remove()} />
        )}
      </Section>
    </List>
  );
}

export function ProfilesPage() {
  const task = useDeviceTask(async (session) => {
    const profiles = await readProfiles(session);
    // 应用列表只用来对「谁在用这个描述文件」，取不到不影响主功能
    const apps = await readApps(session).catch((error) => {
      debugLog("misagent", "应用列表没取到，跳过对应 App", describeError(error));
      return [] as AppEntry[];
    });
    return { profiles, apps };
  });
  const [removed, setRemoved] = useState<string[]>([]);
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState("");
  const [clockTick, setClockTick] = useState(0);

  const apps = task.data?.apps ?? [];
  const profiles = (task.data?.profiles ?? []).filter((profile) => !removed.includes(profile.uuid));
  const levelOf = (profile: ProfileEntry) => expiryState(profile.expires).level;
  const expired = profiles.filter((profile) => levelOf(profile) === "expired");
  const soonCount = profiles.filter((profile) => levelOf(profile) === "soon").length;

  async function removeExpired() {
    if (working || expired.length === 0) return;
    const affected = expired.flatMap((profile) => appsForProfile(profile, apps));
    const ok = await Dialog.confirm({
      title: `删除 ${expired.length} 个已过期的描述文件？`,
      message:
        affected.length > 0
          ? `它们已经失效，对应的 App 本来就打不开了：${usageText(affected)}。删掉只是清理。`
          : "它们已经失效，删掉只是清理。",
      confirmLabel: "删除",
    });
    if (!ok) return;
    const done: string[] = [];
    try {
      const session = await deviceHub.get();
      for (const profile of expired) {
        setWorking(`删除中 ${done.length + 1}/${expired.length}`);
        await removeProfile(session, profile.uuid);
        done.push(profile.uuid);
      }
      setMessage(`✓ 已删除 ${done.length} 个`);
    } catch (error) {
      setMessage(`删到第 ${done.length + 1} 个时失败：${describeError(error)}`);
    } finally {
      setRemoved((list) => [...list, ...done]);
      setWorking("");
    }
  }

  return (
    <List navigationTitle="签名到期" navigationBarTitleDisplayMode="inline" listStyle="insetGroup" refreshable={task.reload}>
      <TaskStateSection task={task} />
      {/* 时钟拨过时这一页的天数也是算出来的，必须让人看见（开关在「签名检查」页） */}
      <TestClockBanner key={`banner-${clockTick}`} onChanged={() => setClockTick((value) => value + 1)} />

      {task.data ? (
        <Section
          footer={
            <Text foregroundStyle="tertiaryLabel">
              {message ||
                `按到期时间排，${SOON_DAYS} 天内到期标橙、已过期标红。App Store 和 TestFlight 的 App 不靠这些描述文件，不受影响。`}
            </Text>
          }
        >
          <HStack>
            <Text>描述文件</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`${profiles.length} 个`}</Text>
          </HStack>
          {soonCount > 0 ? (
            <HStack>
              <Text>{`${SOON_DAYS} 天内到期`}</Text>
              <Spacer />
              <Text foregroundStyle="systemOrange">{`${soonCount} 个`}</Text>
            </HStack>
          ) : null}
          {expired.length > 0 ? (
            working ? (
              <HStack spacing={10}>
                <ProgressView />
                <Text foregroundStyle="secondaryLabel">{working}</Text>
              </HStack>
            ) : (
              <Button
                title={`删除已过期的（${expired.length} 个）`}
                systemImage="trash"
                role="destructive"
                action={() => void removeExpired()}
              />
            )
          ) : null}
        </Section>
      ) : null}

      {task.data ? (
        <Section>
          {profiles.length === 0 ? (
            <Text foregroundStyle="tertiaryLabel">没有装任何描述文件。只用 App Store / TestFlight 的话这里就是空的。</Text>
          ) : (
            profiles.map((profile) => {
              const using = appsForProfile(profile, apps);
              return (
                <NavigationLink
                  key={profile.uuid || profile.name}
                  destination={
                    <ProfileDetailPage
                      profile={profile}
                      apps={using}
                      onRemoved={(uuid) => {
                        setRemoved((list) => [...list, uuid]);
                        setMessage(`✓ 已删除「${profile.name}」`);
                      }}
                    />
                  }
                >
                  <ProfileRow profile={profile} apps={using} />
                </NavigationLink>
              );
            })
          )}
        </Section>
      ) : null}
    </List>
  );
}
