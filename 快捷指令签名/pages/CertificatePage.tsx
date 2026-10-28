// 证书页：装证书（两条路）、在设置里信任、试签、（实验）借快捷指令跳设置、改名、看指纹、重新生成。

import { Button, HStack, List, ProgressView, Section, Spacer, Text, Toggle, VStack, useState } from "scripting";
import { checkRootName, identityExpiry, rootFingerprint, type SigningIdentity } from "../core/identity";
import { JUMP_SHORTCUT_NAME, jumpShortcut } from "../core/jump";
import { CERTIFICATE_DIR_NAME, certificateFileName } from "../core/names";
import { SAMPLE_SHORTCUT_NAME, SAMPLE_SHORTCUT_XML } from "../core/sample";
import { commonNameOf } from "../core/x509";
import { promptText } from "../kit/dialog";
import { openInFilesApp, runShortcutByName, shareFile, writeCertificateFile, writeShortcut } from "../kit/files";
import { signChecked } from "../kit/flow";
import { installRootCertificate } from "../kit/profileServer";
import {
  certificateReady,
  ensureIdentity,
  replaceIdentity,
  saveRootName,
  savedRootName,
  setCertificateReady,
} from "../kit/store";

interface Props {
  identity: SigningIdentity | null;
  ready: boolean;
  /** 身份有变（第一次生成 / 重新生成 / 改名）时通知首页；首页应重新读一遍「装好了」的状态 */
  onChange: (identity: SigningIdentity) => void;
  /** 用户点了「我已装好并信任」 */
  onReadyChange: (ready: boolean) => void;
}

const DEFAULT_ROOT_NAME = "Shortcut Signer Root";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const pad = (value: number): string => String(value).padStart(2, "0");

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <HStack>
      <Text>{label}</Text>
      <Spacer />
      <Text foregroundStyle="secondaryLabel">{value}</Text>
    </HStack>
  );
}

export function CertificatePage({ identity: initial, ready: initialReady, onChange, onReadyChange }: Props) {
  // 页面自己也记一份：被推进来的页面不一定会跟着首页的 state 重新拿 props，
  // 生成 / 重新生成之后得靠自己立刻刷新
  const [identity, setIdentity] = useState<SigningIdentity | null>(initial);
  const [ready, setReady] = useState(initialReady);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  // 第四步的结果写在它自己那一节里，不然会落在页面最上面的第一步，按钮在下面的人看不到
  const [jumpMessage, setJumpMessage] = useState("");
  const [jumpFailed, setJumpFailed] = useState(false);

  function report(text: string, isError: boolean) {
    setMessage(text);
    setFailed(isError);
  }

  function reportJump(text: string, isError: boolean) {
    setJumpMessage(text);
    setJumpFailed(isError);
  }

  /** 身份换了：新证书还没装，「装好了」的确认已经被 store 清掉，这里照实刷新。 */
  function adopt(next: SigningIdentity) {
    setIdentity(next);
    setReady(certificateReady());
    onChange(next);
  }

  function changeReady(on: boolean) {
    setCertificateReady(on);
    setReady(on);
    onReadyChange(on);
  }

  /** 有身份就用，没有就按已存的名字生成。生成要算一阵子，先让「准备中」画出来。 */
  async function current(): Promise<SigningIdentity> {
    if (identity !== null) return identity;
    await sleep(50);
    const created = ensureIdentity();
    adopt(created);
    return created;
  }

  async function installViaSafari() {
    setBusy("准备证书…");
    report("", false);
    try {
      const target = await current();
      setBusy("正在打开 Safari…");
      const result = await installRootCertificate(target);
      if (result.delivered) {
        report(
          "描述文件已交给 Safari。系统问「是否允许下载配置描述文件」要点「允许」，然后去「设置」点最上面的「已下载描述文件」安装，再做第二步。" +
            "设置里没出现这一行，就是没点「允许」，回来再点一次。",
          false,
        );
      } else {
        report(
          `没等到 Safari 取走描述文件。${
            result.keptAlive ? "" : "后台保活没开成（在播放音乐？），Safari 可能一直转圈——暂停音乐再试。"
          }Safari 若弹出「此网站正尝试下载配置描述文件」，选「允许」。也可以改用下面「存到文件」那条路。`,
          true,
        );
      }
    } catch (error) {
      report(`失败：${describeError(error)}。可以改用下面「存到文件」那条路。`, true);
    } finally {
      setBusy("");
    }
  }

  async function installViaFiles() {
    setBusy("准备证书…");
    report("", false);
    try {
      const target = await current();
      const name = commonNameOf(target.rootCertificate) ?? DEFAULT_ROOT_NAME;
      const saved = await writeCertificateFile(name, target.rootCertificate);
      const jumped = await openInFilesApp(saved.dir);
      report(
        `证书已存好：「文件」App → 我的 iPhone → Scripting → ${CERTIFICATE_DIR_NAME} → 点「${certificateFileName(name)}」，` +
          `系统会提示「已下载描述文件」，再去「设置」里安装、信任。${jumped ? "" : "（没能自动跳到「文件」，请手动打开。）"}`,
        false,
      );
    } catch (error) {
      report(`失败：${describeError(error)}`, true);
    } finally {
      setBusy("");
    }
  }

  /** 签一份内置的快捷指令并交给分享面板；`say` 决定把结果写在页面的哪一处。 */
  async function signAndShare(
    name: string,
    input: Uint8Array,
    signedNote: string,
    say: (text: string, isError: boolean) => void,
  ) {
    setBusy("签名中…");
    say("", false);
    try {
      const target = await current();
      const outcome = signChecked(input, target);
      if (!outcome.ok) {
        say(outcome.message, true);
        return;
      }
      const path = await writeShortcut(name, outcome.data);
      say(signedNote, false);
      setBusy("");
      await shareFile(path);
    } catch (error) {
      say(`失败：${describeError(error)}`, true);
    } finally {
      setBusy("");
    }
  }

  /** 签一份内置的测试快捷指令并交给分享面板：一步验证证书装对了、系统认这个签名。 */
  function trial() {
    return signAndShare(
      SAMPLE_SHORTCUT_NAME,
      new TextEncoder().encode(SAMPLE_SHORTCUT_XML),
      `已签好「${SAMPLE_SHORTCUT_NAME}」。在分享面板里选「快捷指令」导入，运行它会弹出一个提示框。`,
      report,
    );
  }

  /** 实验：签一份「跳转设置」快捷指令交给分享面板。证书没信任时系统会拒绝导入，所以没打勾的话顺带提醒。 */
  function importJump() {
    return signAndShare(
      JUMP_SHORTCUT_NAME,
      jumpShortcut(),
      `已签好「${JUMP_SHORTCUT_NAME}」。在分享面板里选「快捷指令」导入，名字别改（下面的「运行」按这个名字找它）。${
        ready ? "" : "第二步还没打勾：证书没信任的话，导入会失败。"
      }`,
      reportJump,
    );
  }

  /** 实验：让「快捷指令」运行它。没导入过的话，「快捷指令」会提示找不到。 */
  async function runJump() {
    reportJump("", false);
    if (!(await runShortcutByName(JUMP_SHORTCUT_NAME))) {
      reportJump(`没能打开「快捷指令」App。可以手动打开它，运行「${JUMP_SHORTCUT_NAME}」。`, true);
    }
  }

  /** 名字是签进证书里的，改名 = 用新名字重新生成；还没有身份时只是先把名字记下，第一次生成就用它。 */
  async function rename() {
    const typed = await promptText({
      title: "证书名称",
      message: "显示在「设置 → 通用 → 关于本机 → 证书信任设置」里。留空用默认名。名字是签进证书里的，改名要重新生成，手机上要重装、重新信任。",
      defaultValue: savedRootName(),
      placeholder: DEFAULT_ROOT_NAME,
    });
    if (typed === null) return;
    const name = typed.trim();
    if (name !== "") {
      const problem = checkRootName(name);
      if (problem !== null) {
        report(problem, true);
        return;
      }
    }
    if (identity !== null) {
      const ok = await Dialog.confirm({
        title: "用新名字重新生成证书？",
        message: "会换一套新的根证书和签名密钥，手机上要重新安装、重新信任。旧证书还信任着的话，以前签的文件仍然能导入。",
        confirmLabel: "重新生成",
      });
      if (!ok) return;
    }
    setBusy("生成中…");
    report("", false);
    try {
      await sleep(50);
      if (identity === null) {
        saveRootName(name);
        report(name === "" ? "已改回默认名称，第一次生成证书时会用它。" : `已记下名称「${name}」，第一次生成证书时会用它。`, false);
      } else {
        adopt(replaceIdentity(name));
        report(`已用「${name === "" ? "默认名称" : name}」生成新的证书。回到上面重新装、重新信任。`, false);
      }
    } catch (error) {
      report(`失败：${describeError(error)}`, true);
    } finally {
      setBusy("");
    }
  }

  async function regenerate() {
    const ok = await Dialog.confirm({
      title: "重新生成签名身份？",
      message:
        "会换一套新的根证书和签名密钥。手机上要重新安装、重新信任新的证书；以前签出来的文件，只要手机还信任旧证书就仍然能导入，不信任了就导不进。",
      confirmLabel: "重新生成",
    });
    if (!ok) return;
    setBusy("生成中…");
    report("", false);
    try {
      await sleep(50);
      adopt(replaceIdentity());
      report("已生成新的身份。回到上面重新装证书、重新信任。", false);
    } catch (error) {
      report(`失败：${describeError(error)}`, true);
    } finally {
      setBusy("");
    }
  }

  const rootName = identity ? commonNameOf(identity.rootCertificate) ?? DEFAULT_ROOT_NAME : savedRootName() || DEFAULT_ROOT_NAME;

  return (
    <List navigationTitle="证书" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section
        header={<Text>第一步 · 装上证书</Text>}
        footer={
          <Text>
            两条路任选其一：Safari 那条会打开 Safari（默认浏览器得是 Safari），提示「此网站正尝试下载配置描述文件」时选「允许」；
            「文件」那条把证书存成 .cer，你在「文件」App 里点它，系统同样会当描述文件接手。第一次点会先生成签名身份，一瞬间的事。
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
            <Button
              title={identity ? "下载并安装证书（Safari）" : "生成身份并安装证书（Safari）"}
              systemImage="safari"
              action={() => void installViaSafari()}
            />
            <Button title="存到「文件」，在文件里点开装" systemImage="folder" action={() => void installViaFiles()} />
          </>
        )}
        {message ? <Text foregroundStyle={failed ? "systemRed" : "secondaryLabel"}>{message}</Text> : null}
      </Section>

      <Section
        header={<Text>第二步 · 在设置里装并信任</Text>}
        footer={
          <Text>
            两步缺一不可：装上去只是「有这张证书」，系统不会因此相信它；第 2 步的开关才是「信任」。脚本没法替你点这两处，
            也检测不到你点没点，所以做完后自己在下面打个勾，首页就不再提醒；重新生成证书会自动取消这个勾。
          </Text>
        }
      >
        <VStack alignment="leading" spacing={6}>
          <Text>1. 打开「设置」，最上面会出现「已下载描述文件」，点进去 → 安装（要输锁屏密码）</Text>
          <Text>2. 设置 → 通用 → 关于本机 → 最底下「证书信任设置」→ 打开「{rootName}」的开关</Text>
          <Text>3. 回到本脚本，选快捷指令签名，导入即可</Text>
        </VStack>
        <Toggle title="我已经装好并信任了这张证书" value={ready} onChanged={(on: boolean) => changeReady(on)} />
      </Section>

      <Section
        header={<Text>第三步 · 试一下</Text>}
        footer={
          <Text>
            内置的测试快捷指令只有一个「显示提示」。导入后能运行并弹出提示框，说明证书和签名都被系统接受了。
          </Text>
        }
      >
        <Button title="试签一个测试快捷指令" systemImage="checkmark.seal" disabled={busy !== ""} action={() => void trial()} />
      </Section>

      <Section
        header={<Text>第四步 · 一键跳到设置（可选，实验）</Text>}
        footer={
          <Text>
            借快捷指令去打开「设置」里的指定页（脚本自己打不开，系统只放行快捷指令这类系统应用）。导入一次，以后点「运行」，
            菜单里选「描述文件」或「证书信任设置」就直接跳过去。它自己要等证书信任了才导得进去，所以第一次装证书用不上，
            重装、换证书、删旧描述文件时才派得上用场。这两条链接在你的 iOS 上通不通没验证过：没反应或报错是系统不放行，
            落在设置首页是认了 App 但不认具体的页，都照第二步的文字走。
          </Text>
        }
      >
        <Button
          title={`导入「${JUMP_SHORTCUT_NAME}」快捷指令`}
          systemImage="square.and.arrow.down"
          disabled={busy !== ""}
          action={() => void importJump()}
        />
        <Button title="运行它，跳到设置" systemImage="gearshape" disabled={busy !== ""} action={() => void runJump()} />
        {jumpMessage ? <Text foregroundStyle={jumpFailed ? "systemRed" : "secondaryLabel"}>{jumpMessage}</Text> : null}
      </Section>

      <Section footer={<Text>名字显示在「证书信任设置」里。它是签进证书的，改名等于用新名字重新生成一套证书，手机上要重装、重新信任。</Text>}>
        {/* plain：文字保持正文颜色，不被染成按钮蓝；contentShape：带 Spacer 的整行才点得到右边那一段 */}
        <Button buttonStyle="plain" contentShape="rect" disabled={busy !== ""} action={() => void rename()}>
          <HStack>
            <Text>证书名称</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{rootName}</Text>
          </HStack>
        </Button>
      </Section>

      {identity ? (
        <Section
          header={<Text>当前证书</Text>}
          footer={<Text>装的时候对一下指纹。根证书的私钥生成完叶证书就丢掉了，不会存在手机上；留下的只有只能签快捷指令的叶私钥，存在钥匙串里。</Text>}
        >
          <Row label="名称" value={rootName} />
          <Row label="创建于" value={formatDate(new Date(identity.createdAt))} />
          <Row label="有效至" value={formatDate(identityExpiry(identity))} />
          <VStack alignment="leading" spacing={4}>
            <Text>SHA-256 指纹</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">{rootFingerprint(identity)}</Text>
          </VStack>
          <Button
            title="复制指纹"
            systemImage="doc.on.doc"
            action={() => {
              Pasteboard.setString(rootFingerprint(identity));
              HapticFeedback.notificationSuccess();
            }}
          />
        </Section>
      ) : null}

      <Section footer={<Text>换了手机、或者想把以前装过的证书都作废时用。身份文件损坏读不出来时，也点这里恢复。</Text>}>
        <Button title="重新生成签名身份…" systemImage="arrow.triangle.2.circlepath" role="destructive" disabled={busy !== ""} action={() => void regenerate()} />
      </Section>
    </List>
  );
}
