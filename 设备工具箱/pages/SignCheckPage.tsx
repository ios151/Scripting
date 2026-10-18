// 签名检查：按证书分组看自签的包，点进去逐条诊断「为什么装不上 / 打不开」。
//
// 只看非 App Store / 非 TestFlight 的 App——那两类由 Apple 重签，不吃设备上的描述文件。
// 判断规则全在 kit/signCheck.ts，这里只负责取数据和显示。

import {
  Button,
  DisclosureGroup,
  HStack,
  Image,
  List,
  NavigationLink,
  Section,
  Spacer,
  Text,
  VStack,
  useState,
  type Color,
} from "scripting";
import { readAppDetail, readApps, type AppEntry } from "../kit/apps";
import { readImageStatus } from "../kit/imageMounter";
import { expiryState, readProfiles, type ProfileEntry } from "../kit/profiles";
import { marketingName, readDeviceUdid, readDeviceValues } from "../kit/services";
import type { PlistDict } from "../kit/plist";
import {
  diagnose,
  groupBySigner,
  reportText,
  subjectOf,
  summarize,
  type CheckItem,
  type CheckLevel,
  type DeviceEnv,
} from "../kit/signCheck";
import { copyWithFeedback, TaskStateSection, useDeviceTask } from "./common";
import { TestClockBanner, TestClockSection } from "./testClock";

const LEVEL_COLOR: Record<CheckLevel, Color> = {
  ok: "systemGreen",
  warn: "systemOrange",
  fail: "systemRed",
  unknown: "secondaryLabel",
};

const LEVEL_ICON: Record<CheckLevel, string> = {
  ok: "checkmark.circle.fill",
  warn: "exclamationmark.triangle.fill",
  fail: "xmark.octagon.fill",
  unknown: "questionmark.circle",
};

interface Snapshot {
  apps: AppEntry[];
  profiles: ProfileEntry[];
  env: DeviceEnv;
  deviceLine: string;
}

/** 证书名很长（「Apple Development: 某某 (ABC123XYZ)」），列表里只留前半截。 */
function shortSigner(signer: string): string {
  const cut = signer.indexOf("(");
  return (cut > 0 ? signer.slice(0, cut) : signer).trim() || signer;
}

function expiryLabel(expires: string | null): { text: string; color: Color } {
  if (!expires) return { text: "无描述文件", color: "secondaryLabel" };
  const state = expiryState(expires);
  return { text: state.text, color: LEVEL_COLOR[state.level === "expired" ? "fail" : state.level === "soon" ? "warn" : "ok"] };
}

function SignDetailPage({ app, snapshot }: { app: AppEntry; snapshot: Snapshot }) {
  const [copied, setCopied] = useState("");
  const task = useDeviceTask(async (session) => {
    const detail = await readAppDetail(session, app.bundleId);
    const subject = subjectOf(app.name, app.bundleId, detail);
    return { subject, items: diagnose(subject, snapshot.profiles, snapshot.env) };
  });
  const result = task.data;
  const conclusion = result ? summarize(result.items) : null;

  return (
    <List navigationTitle={app.name} navigationBarTitleDisplayMode="inline" listStyle="insetGroup" refreshable={task.reload}>
      <TaskStateSection task={task} />

      {result && conclusion ? (
        <Section footer={<Text foregroundStyle="tertiaryLabel">{copied || snapshot.deviceLine}</Text>}>
          <HStack spacing={10}>
            <Image systemName={LEVEL_ICON[conclusion.level]} foregroundStyle={LEVEL_COLOR[conclusion.level]} font="title3" />
            <Text fontWeight="semibold">{conclusion.text}</Text>
          </HStack>
          <Button
            title="复制诊断报告"
            systemImage="doc.on.doc"
            action={() => {
              copyWithFeedback(reportText(result.subject, result.items, snapshot.deviceLine));
              setCopied("✓ 报告已复制（不含 UDID 和序列号）");
            }}
          />
        </Section>
      ) : null}

      {result ? (
        <Section header={<Text>逐项</Text>}>
          {result.items.map((item: CheckItem, index) => (
            <HStack key={`${item.title}-${index}`} alignment="top" spacing={10}>
              <Image systemName={LEVEL_ICON[item.level]} foregroundStyle={LEVEL_COLOR[item.level]} />
              <VStack alignment="leading" spacing={2}>
                <Text font="subheadline" fontWeight="medium">{item.title}</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">{item.detail}</Text>
              </VStack>
              <Spacer minLength={0} />
            </HStack>
          ))}
        </Section>
      ) : null}
    </List>
  );
}

export function SignCheckPage() {
  /** 拨时钟后重算一遍页面：到期判断读的是模块级的时钟，不走 state。 */
  const [clockTick, setClockTick] = useState(0);
  const refreshClock = () => setClockTick((value) => value + 1);
  const task = useDeviceTask(async (session, log): Promise<Snapshot> => {
    log("读取应用列表…");
    const all = await readApps(session);
    log("读取描述文件…");
    const profiles = await readProfiles(session).catch(() => [] as ProfileEntry[]);
    log("读取设备环境…");
    const udid = await readDeviceUdid(session).catch(() => null);
    const image = await readImageStatus(session).catch(() => ({ mounted: null, signatureBytes: null, developerMode: null }));
    /*
      机型和系统版本走 lockdown 的 GetValue。
      原先走 MobileGestalt，iOS 27 起那条路被系统停了，这一行一直是「未知机型」。
    */
    const values = await readDeviceValues(session).catch(() => ({}) as PlistDict);
    const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : null);
    /*
      机型显示成「市售名（标识）」。诊断报告是给人看的，光一个 iPhone18,2 认不出是哪台；
      标识也得留着——描述文件、设备列表那些地方用的是它。表里查不到的新机型，
      `marketingName` 原样返回标识，这时候只显示一次，不写成「iPhone19,1（iPhone19,1）」。
    */
    const productType = text("ProductType");
    const named = marketingName(productType);
    const model = !named ? "未知机型" : named === productType ? named : `${named}（${productType}）`;
    const deviceLine = `设备：${model} · iOS ${text("ProductVersion") ?? "?"}（${text("BuildVersion") ?? "?"}）`;
    return {
      // App Store 和 TestFlight 的包由 Apple 重签，不吃设备上的描述文件，不用查
      apps: all.filter((app) => app.source !== "appStore" && app.source !== "testFlight"),
      profiles,
      env: { udid, developerMode: image.developerMode, imageMounted: image.mounted !== null },
      deviceLine,
    };
  });
  const snapshot = task.data;
  const groups = snapshot ? groupBySigner(snapshot.apps, snapshot.profiles) : [];
  const appOf = (bundleId: string) => snapshot!.apps.find((app) => app.bundleId === bundleId)!;

  return (
    <List navigationTitle="签名检查" navigationBarTitleDisplayMode="inline" listStyle="insetGroup" refreshable={task.reload}>
      <TaskStateSection task={task} />
      <TestClockBanner key={`banner-${clockTick}`} onChanged={refreshClock} />

      {snapshot ? (
        <Section
          footer={
            <Text foregroundStyle="tertiaryLabel">
              只列非 App Store / TestFlight 的包，按签名证书分组。
              {snapshot.env.udid ? "" : "没读到本机 UDID，设备限制那一项会显示查不到。"}
            </Text>
          }
        >
          <HStack>
            <Text>自签的包</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`${snapshot.apps.length} 个 · ${snapshot.profiles.length} 份描述文件`}</Text>
          </HStack>
          <Text font="caption" foregroundStyle="secondaryLabel">{snapshot.deviceLine}</Text>
          <HStack>
            <Text>开发者模式</Text>
            <Spacer />
            <Text
              foregroundStyle={
                snapshot.env.developerMode === true ? "systemGreen" : snapshot.env.developerMode === false ? "systemOrange" : "secondaryLabel"
              }
            >
              {snapshot.env.developerMode === true ? "已开启" : snapshot.env.developerMode === false ? "未开启" : "查不到"}
            </Text>
          </HStack>
        </Section>
      ) : null}

      {snapshot && groups.length === 0 ? (
        <Section>
          <Text foregroundStyle="tertiaryLabel">没有自签的包。App Store 和 TestFlight 的 App 不在这里。</Text>
        </Section>
      ) : null}

      {snapshot
        ? groups.map((group) => {
            const expiry = expiryLabel(group.earliestExpiry);
            return (
              <Section key={group.signer}>
                <DisclosureGroup
                  title={shortSigner(group.signer)}
                  label={
                    <HStack>
                      <VStack alignment="leading" spacing={2}>
                        <Text lineLimit={1}>{shortSigner(group.signer)}</Text>
                        <Text font="caption" foregroundStyle="secondaryLabel">{`${group.bundleIds.length} 个 App`}</Text>
                      </VStack>
                      <Spacer />
                      <Text font="caption" foregroundStyle={expiry.color}>{expiry.text}</Text>
                    </HStack>
                  }
                >
                  {group.bundleIds.map((bundleId) => (
                    <NavigationLink key={bundleId} destination={<SignDetailPage app={appOf(bundleId)} snapshot={snapshot} />}>
                      <VStack alignment="leading" spacing={2}>
                        <Text lineLimit={1}>{appOf(bundleId).name}</Text>
                        <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{bundleId}</Text>
                      </VStack>
                    </NavigationLink>
                  ))}
                </DisclosureGroup>
              </Section>
            );
          })
        : null}

      {snapshot ? <TestClockSection key={`clock-${clockTick}`} onChanged={refreshClock} /> : null}
    </List>
  );
}
