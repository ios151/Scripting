// 配对：用 PIN 自己配一次，或者导入别处导出的配对文件。
//
// 记录存在钥匙串，而 Scripting 的 Keychain **按脚本隔离**
// （文档 keychain/zh.md「不同脚本之间的数据完全隔离」），本脚本读不到别人存的记录。
// 所以这里既能自己配（core/pair_setup：本脚本广播、设备来连、PIN 走 SRP），
// 也能导入一份现成的，免得同一台设备配好几遍。

import { Button, HStack, List, Section, Spacer, Text, VStack, useState } from "scripting";
import { utf8 } from "../core/bytes";
import { describeError } from "../core/debug";
import { createHostIdentity, createPIN, pairThisDevice } from "../core/pair_setup";
import { deletePairing, loadPairing, parsePairingFile, savePairing, type PairingRecord } from "../core/pairing";
import { copyWithFeedback } from "./common";
import { deviceHub } from "../kit/hub";
import { releaseKeepAlive, retainKeepAlive } from "../utils/keepalive";

export function PairingPage({ onChanged }: { onChanged: () => void }) {
  const [record, setRecord] = useState<PairingRecord | null>(() => loadPairing());
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  function report(message: string, error = false) {
    setStatus(message);
    setIsError(error);
  }

  async function runPairing() {
    setBusy(true);
    report("");
    let lease = false;
    try {
      /*
        保活照 utils/keepalive.ts 那三条规矩：在前台就申请、看返回值、只走 retain/release。
        输 PIN 要切到「设置」，本页在后台等，保活没起来就可能被回收。
      */
      try {
        const started = await retainKeepAlive("pairing");
        lease = true;
        if (!started) report("后台保活没起来，切到「设置」时本页可能被回收。多半是音频被别的 App 占着，停掉再试。", true);
      } catch (error) {
        report(`这个入口拿不到后台保活（${describeError(error)}），从脚本列表打开本脚本再配对更稳。`, true);
      }

      const host = await createHostIdentity();
      const code = createPIN();
      setPin(code);
      const paired = await pairThisDevice(host, code, (message) => report(message));

      // 先用新记录真的连一次，过了才落盘——免得一份连不上的记录覆盖掉能用的那份。
      report("验证新配对记录…");
      await deviceHub.openWith(paired, (message) => report(message));
      savePairing(paired);
      setRecord(paired);
      onChanged();
      report("✓ 配对完成，已连上设备");
    } catch (error) {
      report(`配对失败：${describeError(error)}`, true);
    } finally {
      if (lease) await releaseKeepAlive("pairing").catch(() => undefined);
      setPin("");
      setBusy(false);
    }
  }

  function importBytes(bytes: Uint8Array) {
    try {
      const imported = parsePairingFile(bytes);
      savePairing(imported);
      setRecord(imported);
      void deviceHub.disconnect();
      onChanged();
      report(`✓ 已导入：${imported.deviceName || imported.identifier}`);
    } catch (error) {
      report(`解析失败：${describeError(error)}`, true);
    }
  }

  async function importFromFile() {
    try {
      const files = await DocumentPicker.pickFiles({ types: ["public.data", "public.item"] });
      if (!files || files.length === 0) return;
      // 二进制 plist 也要能读，按字节读而不是按字符串
      importBytes(FileManager.readAsBytesSync(files[0]));
    } catch (error) {
      report(`读取文件失败：${describeError(error)}`, true);
    }
  }

  async function importFromClipboard() {
    const text = await Pasteboard.getString();
    if (!text) {
      report("剪贴板为空", true);
      return;
    }
    importBytes(utf8(text));
  }

  async function remove() {
    const ok = await Dialog.confirm({
      title: "删除配对记录？",
      message: "删除后要重新配对才能连接设备。别的脚本里存的记录不受影响。",
    });
    if (!ok) return;
    deletePairing();
    await deviceHub.disconnect();
    setRecord(null);
    onChanged();
    report("已删除配对记录");
  }

  return (
    <List navigationTitle="配对" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section header={<Text>当前记录</Text>}>
        {record ? (
          <VStack alignment="leading" spacing={4}>
            <Text>{record.deviceName || "已配对的设备"}</Text>
            <Text font="caption" foregroundStyle="secondaryLabel" fontDesign="monospaced">
              {record.identifier}
            </Text>
          </VStack>
        ) : (
          <Text foregroundStyle="secondaryLabel">还没有配对</Text>
        )}
      </Section>

      {pin ? (
        <Section
          header={<Text>输入这个 PIN</Text>}
          footer={
            <Text foregroundStyle="secondaryLabel">
              打开「设置 → 隐私与安全性 → 开发者 → 配对」，选中本机，输入上面的 6 位数字，然后回到这里。
            </Text>
          }
        >
          <HStack>
            <Text font={40} fontWeight="semibold" fontDesign="monospaced">
              {pin}
            </Text>
            <Spacer />
            <Button title="复制" systemImage="doc.on.doc" action={() => copyWithFeedback(pin)} />
          </HStack>
        </Section>
      ) : null}

      <Section
        header={<Text>配对这台设备</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            需要先打开开发者模式（设置 → 隐私与安全性 → 开发者模式）。点开始后，本页会显示一个 PIN。
          </Text>
        }
      >
        <Button title={busy ? "配对中…" : "开始配对"} systemImage="link" action={() => void (busy ? undefined : runPairing())} />
      </Section>

      <Section
        header={<Text>导入配对文件</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            这台设备在别的工具里配过的话，把那份配对记录导出来，在这儿导入就不用重新输 PIN。支持 XML / 二进制 plist 和 JSON。
          </Text>
        }
      >
        <Button title="从文件导入" systemImage="doc" action={() => void importFromFile()} />
        <Button title="从剪贴板粘贴" systemImage="doc.on.clipboard" action={() => void importFromClipboard()} />
      </Section>

      {record ? (
        <Section>
          <Button title="删除配对记录" role="destructive" action={() => void remove()} />
        </Section>
      ) : null}

      {status ? (
        <Section>
          <Text foregroundStyle={isError ? "systemRed" : "secondaryLabel"}>{status}</Text>
        </Section>
      ) : null}
    </List>
  );
}
