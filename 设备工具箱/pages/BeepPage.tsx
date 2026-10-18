// 通话录音提示音：把「开始录音 / 结束录音」的系统提示音换成静音，或者还原回原声。
//
// 这一页不自动连设备、也不自动读设备上的文件：那两个文件在媒体域之外，读写都要走
// Airlift 那条链（一次检查要跑好几轮隧道，几十秒），所以状态直接用上次操作记在
// Storage 里的结果，想知道设备上的真实情况得手动点「重新检查」。

import { Button, HStack, List, Section, Spacer, Text, VStack, useRef, useState } from "scripting";
import { describeError } from "../core/debug";
import {
  applySilentTones,
  TONE_BACKUP_FOLDER,
  TONE_FILES,
  hasToneBackup,
  inspectTones,
  loadToneMode,
  rescueTones,
  restoreOriginalTones,
  type ToneMode,
} from "../kit/airbeep";
import { deviceHub } from "../kit/hub";
import { isTunnelDropped } from "../kit/session";

function modeText(mode: ToneMode): string {
  if (mode === "silent") return "已静音";
  if (mode === "original") return "系统原声";
  return "未知";
}

/** 隧道断开时的提示：改过设备的那两个动作要多提醒一句，状态可能停在中间。 */
function tunnelLostText(action: string): string {
  const base = "连接断开了（锁屏、熄屏、切网络都会断）。再点一次按钮会自动重连。";
  return action === "silent" || action === "restore"
    ? `${base}设备上的状态可能停在中间，重连后先点「重新检查设备状态」。`
    : base;
}

/** 写完不做读回校验（理由见 kit/airbeep.ts 文件头），所以成功提示里带一句怎么确认。 */
const CONFIRM_HINT = "想确认设备上的状态，点「重新检查设备状态」。";

/** 「标签 + 值」一行。 */
function StateRow({ label, value }: { label: string; value: string }) {
  return (
    <HStack frame={{ maxWidth: "infinity" }}>
      <Text>{label}</Text>
      <Spacer />
      <Text foregroundStyle="secondaryLabel" lineLimit={1} truncationMode="middle">
        {value}
      </Text>
    </HStack>
  );
}

export function BeepPage() {
  const [mode, setMode] = useState<ToneMode>(() => loadToneMode());
  const [backedUp, setBackedUp] = useState(() => hasToneBackup());
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [detail, setDetail] = useState<string[]>([]);
  /** 最近几条进度。失败时留在页面上，好知道它做到哪一步、有没有把原声写回去。 */
  const recent = useRef<string[]>([]);

  function report(message: string): void {
    setBusy(message);
    recent.current = [...recent.current, message].slice(-6);
  }

  /** 四个动作共用：连设备 → 干活 → 刷新本页状态；异常统一落到 problem。 */
  async function run(action: "silent" | "restore" | "check" | "rescue") {
    setBusy("连接设备…");
    setNotice("");
    setProblem("");
    setDetail([]);
    recent.current = [];
    try {
      const session = await deviceHub.get(report);
      if (action === "silent") {
        await applySilentTones(session, report);
        setNotice(`已把录音提示音换成静音。${CONFIRM_HINT}`);
      } else if (action === "restore") {
        await restoreOriginalTones(session, report);
        setNotice(`已还原系统原声。${CONFIRM_HINT}`);
      } else if (action === "rescue") {
        const rescue = await rescueTones(session, report);
        setDetail([...recent.current, ...rescue.lines]);
        if (rescue.recovered > 0) setNotice(`救回 ${rescue.recovered} 个文件，已写回设备。`);
        else setNotice("扫描完成。");
      } else {
        const tones = await inspectTones(session, report);
        setMode(tones.mode);
        // recent.current 包含完整 log（含具体错误），tones.lines 是结论；全部显示
        setDetail([...recent.current, ...tones.lines]);
        setNotice("检查完成。");
      }
    } catch (failure) {
      setProblem(isTunnelDropped(failure) ? tunnelLostText(action) : describeError(failure));
      setDetail(recent.current);
    } finally {
      setMode(loadToneMode());
      setBackedUp(hasToneBackup());
      setBusy("");
    }
  }

  /** 静音前先问一句：这一步会动设备上的系统文件。 */
  async function confirmSilent() {
    const ok = await Dialog.confirm({
      title: "静音录音提示音",
      message: "会先读出设备上的原声备份到本机，再把两个提示音文件换成静音。录音开始和结束时的「正在录音」播报就没声音了，随时可以还原。",
    });
    if (ok === true) await run("silent");
  }

  async function confirmRestore() {
    const ok = await Dialog.confirm({
      title: "还原系统原声",
      message: "会把本机备份的两个原声文件写回设备，恢复录音开始和结束时的提示音。",
    });
    if (ok === true) await run("restore");
  }

  return (
    <List navigationTitle="通话录音提示音" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section
        header={<Text>状态</Text>}
        footer={<Text foregroundStyle="tertiaryLabel">「未知」只是本机没记下结果，不代表设备上的状态；点「重新检查设备状态」会真去读一遍。</Text>}
      >
        <StateRow label="当前提示音" value={modeText(mode)} />
        <StateRow label="原声备份" value={backedUp ? "已备份" : "未备份"} />
      </Section>

      <Section
        header={<Text>操作</Text>}
        footer={
          <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={12} foregroundStyle="secondaryLabel">
              想静音：抢救残留 → 静音录音提示音 → 重新检查设备状态
            </Text>
            <Text font={12} foregroundStyle="secondaryLabel">
              想还原：抢救残留 → 还原系统原声 → 重新检查设备状态
            </Text>
            <Text foregroundStyle="tertiaryLabel">
              为什么从「抢救残留」开始：上一次要是中途断了，设备上那份原声可能还停在媒体域里（这条链的读是
              搬运式的，读不到时文件已经被搬走了）。先捞回来写回去，设备才是干净状态，接下来做什么才算数。
            </Text>
            <Text foregroundStyle="tertiaryLabel">
              为什么要「重新检查」收尾：写入不做读回校验（那要多跑三轮、占掉四分之三的时间，还时灵时不灵），
              所以状态栏记的是「这次写了什么」，不是「设备上现在是什么」。检查一遍才是真去读回来的。
            </Text>
            <Text foregroundStyle="tertiaryLabel">
              前三个动作都要跑 Airlift（暂存 + AirTraffic 同步）；中途别锁屏、别切网络。
            </Text>
          </VStack>
        }
      >
        <Button action={() => void confirmSilent()}>
          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            <Text>静音录音提示音</Text>
            <Spacer />
            {mode === "silent" ? <Text font={13} foregroundStyle="secondaryLabel">已经是静音</Text> : null}
          </HStack>
        </Button>
        <Button action={() => void confirmRestore()}>
          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            <Text foregroundStyle={backedUp ? "label" : "tertiaryLabel"}>还原系统原声</Text>
            <Spacer />
            <Text font={13} foregroundStyle="secondaryLabel">{backedUp ? "" : "没有备份"}</Text>
          </HStack>
        </Button>
        <Button action={() => void run("check")}>
          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            <Text>重新检查设备状态</Text>
            <Spacer />
            <Text font={13} foregroundStyle="secondaryLabel">读一遍两个文件</Text>
          </HStack>
        </Button>
        <Button action={() => void run("rescue")}>
          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            <Text>抢救残留</Text>
            <Spacer />
            <Text font={13} foregroundStyle="secondaryLabel">读不到时先点这个</Text>
          </HStack>
        </Button>
      </Section>

      {busy || notice || problem || detail.length > 0 ? (
        <Section header={<Text>最近一次操作</Text>}>
          <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            {busy ? <Text foregroundStyle="secondaryLabel">{busy}</Text> : null}
            {notice ? <Text font={13} foregroundStyle="systemGreen">{notice}</Text> : null}
            {problem ? <Text font={13} foregroundStyle="systemRed">{problem}</Text> : null}
            {detail.map((line, i) => (
              <Text key={i} font={13} foregroundStyle="secondaryLabel">
                {line}
              </Text>
            ))}
          </VStack>
        </Section>
      ) : null}

      <Section header={<Text>说明</Text>}>
        <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={13} foregroundStyle="secondaryLabel">
            换的是系统「通话录音」的播报提示音，跟铃声、短信提示音无关，也不影响通话本身。
          </Text>
          <Text font={13} foregroundStyle="secondaryLabel">
            原声备份在本机「文件」App ▸ Scripting ▸ {TONE_BACKUP_FOLDER}，还原时用的是这份。
          </Text>
          {TONE_FILES.map((file) => (
            <VStack key={file.name} alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={13}>{file.name}</Text>
              <Text font={12} foregroundStyle="tertiaryLabel" lineLimit={2} truncationMode="middle">
                {file.path}
              </Text>
            </VStack>
          ))}
          <Text font={12} foregroundStyle="tertiaryLabel">
            这个功能的思路来自 @Waa404，这里在他的基础上重写了实现；协议细节参考了 idevice 和 pymobiledevice3。
          </Text>
        </VStack>
      </Section>
    </List>
  );
}
