// 首页与启动流程：index.tsx（正常启动）和 intent.tsx（别的 App 分享过来）共用。
//
// 链路：选 / 粘贴 / 下载 / 分享来的 plist → 校验并转二进制 → AA01 归档 → AEA1 容器（证书链 + ECDSA）
//      → 自检 → 临时目录里的 .shortcut → 分享面板 / 打开方式 → 快捷指令导入

import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  NavigationLink,
  NavigationStack,
  ProgressView,
  Script,
  Section,
  Spacer,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting";
import type { SigningIdentity } from "../core/identity";
import { formatSize, stripExtension } from "../core/names";
import { openInMenu, resetWorkDir, saveToFiles, shareFile, writeShortcut } from "../kit/files";
import { promptText } from "../kit/dialog";
import { signChecked } from "../kit/flow";
import { isFailure, pickFromClipboard, pickFromFiles, pickFromUrl, type Source } from "../kit/input";
import { certificateReady, ensureIdentity, readIdentity } from "../kit/store";
import { CertificatePage } from "./CertificatePage";

interface Item {
  id: number;
  name: string;
  ok: boolean;
  /** 成功：「N 个动作 · 大小」；失败：原因 */
  detail: string;
  /** 签好的文件路径，失败时为空 */
  path: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function loadIdentityState(): { identity: SigningIdentity | null; error: string } {
  try {
    return { identity: readIdentity(), error: "" };
  } catch (error) {
    return { identity: null, error: describeError(error) };
  }
}

export interface AppProps {
  /** 别的 App 通过分享面板递来的文件（intent.tsx 读好了交进来）；有就一进来自动签 */
  shared?: Source[];
}

export function App({ shared = [] }: AppProps) {
  const dismiss = Navigation.useDismiss();
  const [identity, setIdentity] = useState<SigningIdentity | null>(() => loadIdentityState().identity);
  const [identityError] = useState(() => loadIdentityState().error);
  const [ready, setReady] = useState(() => certificateReady());
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeIsError, setNoticeIsError] = useState(false);
  const nextId = useRef(1);
  const workReady = useRef<Promise<void> | undefined>(undefined);

  // 启动时清掉上一轮留在临时目录里的文件。签名前要等它做完，免得把刚写的文件也清了
  useEffect(() => {
    workReady.current = resetWorkDir().catch(() => undefined);
  }, []);

  // 分享面板来的文件：一进来就签，不用再点一次。放在上一个 effect 之后，signAll 里会等清目录做完
  useEffect(() => {
    if (shared.length > 0) void signAll(shared);
  }, []);

  function report(text: string, isError: boolean) {
    setNotice(text);
    setNoticeIsError(isError);
  }

  /** 证书页里生成 / 重新生成 / 改名之后：新证书还没装，「装好了」已被清掉，照实刷新。 */
  function onIdentityChange(next: SigningIdentity) {
    setIdentity(next);
    setReady(certificateReady());
  }

  /** 把一批来料签掉，结果一份一份摆进列表。单份失败（读不了、签不了、写不进盘）都不影响别的。 */
  async function signAll(sources: Source[]) {
    if (sources.length === 0) return;
    setBusy("签名中…");
    report("", false);
    try {
      await sleep(50); // 让「签名中」先画出来
      await workReady.current;
      let current = identity;
      if (current === null) {
        setBusy("第一次使用：生成签名身份…");
        await sleep(50);
        current = ensureIdentity();
        setIdentity(current);
        setReady(certificateReady());
      }
      const added: Item[] = [];
      for (const [index, source] of sources.entries()) {
        if (sources.length > 1) {
          setBusy(`签名中（${index + 1}/${sources.length}）…`);
          await sleep(30);
        }
        if (isFailure(source)) {
          added.push({ id: nextId.current++, name: source.name, ok: false, detail: source.error, path: "" });
          continue;
        }
        const outcome = signChecked(source.bytes, current);
        if (!outcome.ok) {
          added.push({ id: nextId.current++, name: source.name, ok: false, detail: outcome.message, path: "" });
          continue;
        }
        const name = outcome.name ?? stripExtension(source.name);
        try {
          const path = await writeShortcut(name, outcome.data);
          const resigned = outcome.source === "signed" ? " · 换了签名" : "";
          added.push({
            id: nextId.current++,
            name,
            ok: true,
            detail: `${outcome.actionCount} 个动作 · ${formatSize(outcome.data.length)}${outcome.compressed ? " · LZFSE" : " · 未压缩"}${resigned}`,
            path,
          });
        } catch (error) {
          added.push({ id: nextId.current++, name, ok: false, detail: `签好了但写不进临时目录：${describeError(error)}`, path: "" });
        }
      }
      setItems((previous) => [...added, ...previous]);
      const good = added.filter((item) => item.ok).length;
      report(
        good === added.length
          ? "签好了。点下面的「导入」，在分享面板里选「快捷指令」。"
          : `${good} 份签好了，${added.length - good} 份没签成，原因在下面。`,
        good === 0,
      );
    } catch (error) {
      report(`失败：${describeError(error)}`, true);
    } finally {
      setBusy("");
    }
  }

  async function load(read: () => Promise<Source[]>) {
    report("", false); // 开始新的一次操作：上一次的报错不该留在屏幕上（取消选择时尤其明显）
    try {
      await signAll(await read());
    } catch (error) {
      report(`失败：${describeError(error)}`, true);
    }
  }

  async function fromClipboard(): Promise<Source[]> {
    return [await pickFromClipboard()];
  }

  async function fromUrl(): Promise<Source[]> {
    const text = await promptText({
      title: "快捷指令文件的链接",
      message: "链接要以 https 开头",
      placeholder: "粘贴 .shortcut 后缀的链接",
    });
    if (text === null || text.trim() === "") return [];
    setBusy("下载中…");
    try {
      return [await pickFromUrl(text)];
    } finally {
      setBusy("");
    }
  }

  async function guard(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      report(`失败：${describeError(error)}`, true);
    }
  }

  const needsCertificate = identity === null || !ready;
  const certificateLabel = identity === null ? "还没生成" : ready ? "已装好" : "还没确认装好";

  return (
    <NavigationStack>
      <List
        navigationTitle="快捷指令签名"
        listStyle="insetGroup"
        toolbar={{ cancellationAction: <Button title="退出" action={() => dismiss()} /> }}
      >
        {/*
          这一条只是提示、不放链接：上一版把进证书页的 NavigationLink 放在条件渲染里，
          用户在证书页里生成身份后这一段就卸载，SwiftUI 里源链接被移出视图树，已经推进去的页面可能被一起收掉。
          进证书页的链接只留下面「证书」那一个，常驻，只换标签。
        */}
        {needsCertificate ? (
          <Section
            footer={
              <Text foregroundStyle={identityError ? "systemRed" : "secondaryLabel"}>
                {identityError ||
                  (identity === null
                    ? "还没有签名身份。签出来的文件要手机信任这张证书才导得进去，先到下面「证书」里装好。"
                    : "还没确认证书装好并信任。装好后在「证书」页第二步打个勾，这条提示就不再出现。")}
              </Text>
            }
          >
            <HStack spacing={10}>
              <Image systemName="exclamationmark.shield.fill" foregroundStyle="systemOrange" />
              <Text>先装证书</Text>
            </HStack>
          </Section>
        ) : null}

        <Section
          header={<Text>要签名的快捷指令</Text>}
          footer={
            <Text foregroundStyle={noticeIsError ? "systemRed" : "secondaryLabel"}>
              {notice || "文件、剪贴板里的 plist 文本、https 链接都行；已经签过名的也能换成这里的签名。可以一次选多个。"}
            </Text>
          }
        >
          {busy ? (
            <HStack spacing={10}>
              <ProgressView />
              <Text foregroundStyle="secondaryLabel">{busy}</Text>
            </HStack>
          ) : (
            <>
              <Button title="选择文件…" systemImage="doc.badge.plus" action={() => void load(pickFromFiles)} />
              <Button title="粘贴剪贴板里的 plist" systemImage="doc.on.clipboard" action={() => void load(fromClipboard)} />
              <Button title="输入链接…" systemImage="link" action={() => void load(fromUrl)} />
            </>
          )}
        </Section>

        {items.length > 0 ? (
          <Section header={<Text>签好的</Text>}>
            {items.map((item) => (
              <VStack key={item.id} alignment="leading" spacing={6}>
                <HStack spacing={8}>
                  <Image
                    systemName={item.ok ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"}
                    foregroundStyle={item.ok ? "systemGreen" : "systemOrange"}
                  />
                  <Text>{item.name}</Text>
                </HStack>
                <Text font="caption" foregroundStyle={item.ok ? "secondaryLabel" : "systemRed"}>
                  {item.detail}
                </Text>
                {item.ok ? (
                  <HStack spacing={18}>
                    <Button
                      title="导入"
                      systemImage="square.and.arrow.down"
                      buttonStyle="borderless"
                      action={() => void guard(() => shareFile(item.path))}
                    />
                    <Button
                      title="打开方式"
                      systemImage="arrow.up.forward.app"
                      buttonStyle="borderless"
                      action={() => void guard(() => openInMenu(item.path))}
                    />
                    <Button
                      title="存到文件"
                      systemImage="folder"
                      buttonStyle="borderless"
                      action={() => void guard(() => saveToFiles(item.path))}
                    />
                    <Spacer />
                  </HStack>
                ) : null}
              </VStack>
            ))}
          </Section>
        ) : null}

        <Section
          header={<Text>证书</Text>}
          footer={
            <Text>
              导入时提示「无法验证」或「未信任」：多半是证书还没装或没信任，到这里重做一遍。
              「导入」不出现快捷指令：试试「打开方式」。
            </Text>
          }
        >
          <NavigationLink
            destination={
              <CertificatePage
                identity={identity}
                ready={ready}
                onChange={onIdentityChange}
                onReadyChange={setReady}
              />
            }
          >
            <HStack>
              <Text>安装与信任证书</Text>
              <Spacer />
              <Text foregroundStyle={needsCertificate ? "systemOrange" : "secondaryLabel"}>{certificateLabel}</Text>
            </HStack>
          </NavigationLink>
        </Section>
      </List>
    </NavigationStack>
  );
}

/** 启动：弹出首页（全屏），关掉之后收尾退出。shared 是分享面板递来的文件，正常启动不传。 */
export async function runApp(shared: Source[] = []): Promise<void> {
  await Navigation.present({ element: <App shared={shared} />, modalPresentationStyle: "fullScreen" });
  // 点「退出」时可能正卡在装证书的等待里，那边的 finally 来不及跑；保活请求要主动释放（幂等）
  await BackgroundKeeper.stopKeepAlive().catch(() => undefined);
  if (shared.length > 0) {
    // 分享面板递来的文件是安全作用域资源，用完交还（取餐码的分享入口也这么收尾）；交还失败不该拦住退出
    try {
      DocumentPicker.stopAcessingSecurityScopedResources();
    } catch {
      // 忽略
    }
  }
  Script.exit();
}
