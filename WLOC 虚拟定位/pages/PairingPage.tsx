// 配对记录管理页。
//
// 两条路：
//   1. 「配对这台设备」——脚本自己起一个 TCP 监听、用 Bonjour 广播成可配对主机，
//      系统设置里就会出现它，输入这里显示的 PIN 完成 SRP 握手。
//   2. 「导入配对记录」——从别处导入已有记录（wloc 导出的 .mobiledevicepairing、
//      本脚本导出的 plist / JSON 都认）。换设备或从旧版迁移时用。
//
// 新记录要先独立跑通一次 pair-verify 才会覆盖钥匙串里的旧记录：配对途中任何一步
// 出错都可能留下一份连不上的记录，直接覆盖会把原本能用的那份弄丢。

import {
  NavigationStack,
  VStack,
  HStack,
  Spacer,
  Text,
  Button,
  TextField,
  List,
  Section,
  DisclosureGroup,
  useState,
  useObservable,
  Navigation,
  LiveActivity,
} from "scripting";
import { MessageSheet } from "./MessageSheet";
import { toHex, utf8 } from "../core/bytes";
import { debugLog, describeError } from "../core/debug";
import {
  deletePairing,
  exportPairingAsBinary,
  exportPairingAsJson,
  exportPairingAsXml,
  loadPairing,
  PAIRING_EXPORT_FORMATS,
  parsePairingFile,
  savePairing,
  type PairingExportFormat,
  type PairingRecord,
} from "../core/pairing";
import { createHostIdentity, createPIN, pairThisDevice } from "../core/pair_setup";
import { SimulationLiveActivity, type SimulationState } from "../live_activity";
import { verifyPairingRecord } from "../core/session";
import { endpointFromSettings, loadSettings } from "../utils/storage";
import { releaseKeepAlive, retainKeepAlive } from "../utils/keepalive";

export function PairingPage() {
  const dismiss = Navigation.useDismiss();
  const [pairing, setPairing] = useState<PairingRecord | null>(() => loadPairing());
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pin, setPin] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [pairingInProgress, setPairingInProgress] = useState(false);
  /** 「配对这台设备」的操作说明浮层。 */
  const [showIntro, setShowIntro] = useState(false);
  /** 显示 PIN 的卡片。和定位模拟共用同一个注册，靠 kind 区分。 */
  const pinActivity = useObservable(() => SimulationLiveActivity());

  /**
   * 配对卡片的状态。
   *
   * 和定位模拟共用一个 SimulationState——一个脚本只能注册一个 Live Activity，
   * 注册两个的话灵动岛上会直接显示「错误」。定位相关的字段这里用不上，给中性值。
   */
  function pairingCardState(code: string): SimulationState {
    return {
      kind: "pairing",
    // 配对卡片的标题是固定的「配对 PIN」，不走自定义那套
    title: "",
      pin: code,
      place: "",
      latitude: 0,
      longitude: 0,
      mode: "",
      modeIcon: "",
      speedKmh: 0,
      travelled: 0,
      total: 0,
      leg: 1,
      paused: false,
      startedAt: Date.now(),
      tint: "systemBlue",
      compactIcon: "personalhotspot",
      compactIconIsEmoji: false,
      compactText: code,
      compactTimer: false,
      restoreTint: "systemRed",
    };
  }

  /**
   * 在本机直接配对。
   *
   * 关键在顺序：**先把路指清楚，再出 PIN**。
   * 一上来甩一个六位码，用户不知道该往哪儿输，等摸到设置里广播都快超时了。
   * 所以先弹一个说明把路径念一遍，点「我知道了」才开始广播并显示 PIN。
   *
   * 广播期间要切到「设置」去输码，脚本会被切到后台——整段流程靠后台保活撑着。
   */
  /*
    说明原先走系统 Dialog.confirm，十几行文案被压成小字还不给滚动，
    「设置 → 隐私与安全性 → 开发者 → 配对」这条最该看清的路径挤成一团。
    现在换成和其他提示同一个半屏浮层（MessageSheet），正文可滚、可往上拉开。
  */
  function startDevicePairing() {
    setShowIntro(true);
  }

  /** 用户在说明里点了「我知道了，开始」才真的跑。 */
  async function runDevicePairing() {
    setShowIntro(false);
    setPairingInProgress(true);
    setIsError(false);
    let lease = false;
    try {
      const host = await createHostIdentity();
      const code = createPIN();
      setPin(code);
      setStatus("正在启动配对广播…");

      // 把 PIN 挂到灵动岛上：输码要切到「设置」，那时本页已经看不见了。
      // 起不来不影响配对，只是得自己记住六位数。
      try {
        /*
          **不要 endAllActivities**。

          这一句原本是照抄 index.tsx 的 startLiveActivity，那边清场是为了收掉
          上一轮脚本留下的残卡。但配对可以在模拟进行中发起（比如系统更新后
          重新配对），而这一句会把正在提醒用户「位置模拟中」的那张卡片一起收掉，
          模拟还在跑、卡片却没了——比没有卡片更糟。

          换新实例仍然要：一个实例的 start() 只许调一次，再配一次就起不来了。
        */
        pinActivity.setValue(SimulationLiveActivity());
        await pinActivity.value.start(pairingCardState(code));
      } catch (error) {
        debugLog("liveactivity", "PIN 卡片启动失败", describeError(error));
      }

      try {
        // 走 retain/release 而不是直接调 BackgroundKeeper：保活的引用计数是按
        // 脚本算的，直接 stopKeepAlive 会把同一脚本里**模拟会话**的那份也撤掉
        // ——而配对常常就发生在模拟进行中（系统更新后重新配对）。
        await retainKeepAlive("pairing");
        lease = true;
      } catch {
        // 没有后台保活也能试，只是切走后更容易被系统回收。
      }

      const record = await pairThisDevice(host, code, setStatus);

      // 独立验证一次：这一步过了才算这份记录真的能用。
      setStatus("验证新配对记录…");
      const current = loadSettings();
      await verifyPairingRecord(
        record,
        endpointFromSettings(current),
        setStatus,
      );

      savePairing(record);
      setPairing(record);
      setStatus("✓ 配对完成");
    } catch (error) {
      setStatus(`配对失败：${error instanceof Error ? error.message : String(error)}`);
      setIsError(true);
    } finally {
      if (lease) await releaseKeepAlive("pairing").catch(() => undefined);
      // 配对结束就收掉卡片——PIN 已经没用了，留着是信息泄露也是干扰。
      await pinActivity.value
        .end(pairingCardState(""), { dismissTimeInterval: 0 })
        .catch(() => undefined);
      setPin("");
      setPairingInProgress(false);
    }
  }

  function importBytes(bytes: Uint8Array) {
    try {
      const record = parsePairingFile(bytes);
      savePairing(record);
      setPairing(record);
      setStatus(`✓ 已导入：${record.deviceName || record.identifier}`);
      setIsError(false);
      setShowPaste(false);
      setPasteText("");
    } catch (error) {
      setStatus(`解析失败：${error instanceof Error ? error.message : String(error)}`);
      setIsError(true);
    }
  }

  async function importFromFile() {
    try {
      const files = await DocumentPicker.pickFiles({
        types: ["public.data", "public.item"],
      });
      if (!files || files.length === 0) return;
      // 二进制 plist 也要能读，所以按字节读而不是按字符串。
      importBytes(FileManager.readAsBytesSync(files[0]));
    } catch (error) {
      setStatus(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
      setIsError(true);
    }
  }

  async function importFromClipboard() {
    const text = await Pasteboard.getString();
    if (!text) {
      setStatus("剪贴板为空");
      setIsError(true);
      return;
    }
    importBytes(utf8(text));
  }

  /**
   * 导出配对记录。
   *
   * 和 wloc 一样给两条路：存成文件，或复制成文本配合「从剪贴板粘贴」迁移。
   * 只有纯文本格式能复制——二进制 plist 放不进剪贴板。
   */
  async function handleExport(format: PairingExportFormat, toClipboard: boolean) {
    if (!pairing) return;
    const spec = PAIRING_EXPORT_FORMATS.find((item) => item.id === format);
    if (!spec) return;

    setIsError(false);
    try {
      if (toClipboard) {
        const text = format === "json" ? exportPairingAsJson(pairing) : exportPairingAsXml(pairing);
        Pasteboard.setString(text);
        setStatus(`✓ 已复制${spec.label}文本，可在另一台设备用「从剪贴板粘贴」导入`);
        return;
      }

      const name = `${pairing.identifier || "wloc"}.${spec.extension}`;
      // 直接给 Data，不落临时文件——少一处要清理的痕迹。
      const data =
        format === "binary"
          ? Data.fromUint8Array(exportPairingAsBinary(pairing))
          : Data.fromString(
              format === "json" ? exportPairingAsJson(pairing) : exportPairingAsXml(pairing),
            );
      if (!data) throw new Error("无法构造导出数据");

      const saved = await DocumentPicker.exportFiles({ files: [{ data, name }] });
      setStatus(saved.length > 0 ? `✓ 已导出 ${name}` : "已取消导出");
    } catch (error) {
      setStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
      setIsError(true);
    }
  }

  function remove() {
    deletePairing();
    setPairing(null);
    setStatus("已删除配对记录");
    setIsError(false);
  }

  const statusColor = isError ? "systemRed" : status.startsWith("✓") ? "systemGreen" : "systemOrange";

  return (
    <NavigationStack>
      <List
        navigationTitle="配对管理"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="关闭" action={() => dismiss()} />,
        }}
        sheet={{
          content: (
            <MessageSheet
              tone="info"
              message={
                "配对这台设备\n" +
                "接下来会生成一个六位 PIN，并把本机广播成一台可配对的电脑。\n\n" +
                "拿到 PIN 后，去：\n" +
                "设置 → 隐私与安全性 → 开发者 → 配对\n\n" +
                "在列表里选「Scripting WLOC」，输入 PIN。\n" +
                "系统会先要你输一次 iPhone 解锁密码，这是它自己的验证，正常。\n\n" +
                "广播三分钟后自动结束。PIN 会同时显示在本页和灵动岛上，切到设置也看得到。"
              }
              confirm={{ label: "我知道了，开始", onConfirm: () => void runDevicePairing() }}
              onDismiss={() => setShowIntro(false)}
            />
          ),
          isPresented: showIntro,
          onChanged: setShowIntro,
        }}
      >
        <Section header={<Text font="caption" foregroundStyle="secondaryLabel">配对状态</Text>}>
          {pairing ? (
            <VStack alignment="leading" spacing={6}>
              <HStack>
                <Text foregroundStyle="systemGreen" font="caption">● 已配对</Text>
                <Spacer />
                <Button title="删除" action={remove} foregroundStyle="red" />
              </HStack>
              {!!pairing.deviceName && (
                <Text font="subheadline" fontWeight="semibold">{pairing.deviceName}</Text>
              )}
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                标识：{pairing.identifier}
              </Text>
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                公钥：{pairing.publicKey.length > 0 ? `${toHex(pairing.publicKey).slice(0, 16)}…` : "（未包含，不影响使用）"}
              </Text>
            </VStack>
          ) : (
            <VStack alignment="leading" spacing={4}>
              <Text foregroundStyle="systemOrange">● 未配对</Text>
              <Text font="caption" foregroundStyle="secondaryLabel">
                请先在 wloc 里完成配对，再用它的「导出配对文件」把记录导进来。
              </Text>
            </VStack>
          )}
        </Section>

        <Section
          header={<Text font="caption" foregroundStyle="secondaryLabel">配对这台设备</Text>}
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              不经 wloc，直接在这台设备上配对。点下去后会生成一个六位 PIN 并把本机
              广播成可配对主机，然后前往
              {"「设置 → 隐私与安全 → 开发者 → 配对」"}
              ，在列表里选 Scripting WLOC 并输入 PIN。
              {"\n\n"}
              离开应用期间靠后台保活维持广播，广播三分钟后自动结束。
              新记录只有独立验证通过后才会覆盖已有记录。
            </Text>
          }
        >
          {pin ? (
            <VStack alignment="leading" spacing={10} padding={{ vertical: 6 }}>
              <VStack alignment="leading" spacing={2}>
                <Text font="caption" foregroundStyle="secondaryLabel">配对 PIN</Text>
                <Text
                  font="largeTitle"
                  fontWeight="bold"
                  fontDesign="monospaced"
                  foregroundStyle="systemBlue"
                >
                  {pin}
                </Text>
              </VStack>

              {/* 把路径摆在 PIN 正下方，照着点就行，不用再回头看说明 */}
              <VStack alignment="leading" spacing={4}>
                <Text font="caption" fontWeight="semibold">接下来：</Text>
                <Text font="caption2" foregroundStyle="secondaryLabel">
                  ① 打开「设置」→ 隐私与安全性 → 开发者 → 配对
                </Text>
                <Text font="caption2" foregroundStyle="secondaryLabel">
                  ② 列表里选「Scripting WLOC」
                </Text>
                <Text font="caption2" foregroundStyle="secondaryLabel">
                  ③ 输入上面的 PIN，再按系统要求输一次 iPhone 解锁密码
                </Text>
                <Text font="caption2" foregroundStyle="secondaryLabel">
                  ④ 回到本页等「✓ 配对完成」
                </Text>
              </VStack>

              <Button
                title="复制 PIN"
                systemImage="doc.on.doc"
                buttonStyle="borderless"
                controlSize="small"
                action={() => {
                  Pasteboard.setString(pin);
                  setStatus("已复制 PIN");
                }}
              />

              <Text font="caption2" foregroundStyle="tertiaryLabel">
                PIN 同时显示在灵动岛上，切到设置里也看得到。广播三分钟后结束，
                超时就回来重新开始。
              </Text>
            </VStack>
          ) : null}
          <Button
            title={pairingInProgress ? "等待在设置中输入 PIN…" : "配对这台设备"}
            systemImage="personalhotspot"
            action={startDevicePairing}
            disabled={pairingInProgress}
          />
        </Section>

        {/*
          导出。
          记录等同于这台设备的调试授权，只该在自己的设备之间传——提示里说明一次，
          不做额外拦截（用户自己的记录，拦了反而碍事）。
        */}
        {pairing ? (
          <Section
            header={<Text font="caption" foregroundStyle="secondaryLabel">导出配对记录</Text>}
            footer={
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                这份记录等同于本机的调试授权，只在你自己的设备之间传递，不要发给别人。
                XML plist 和二进制 plist 两种格式 wloc 也能读。
              </Text>
            }
          >
            <DisclosureGroup
              title="导出…"
              isExpanded={exportOpen}
              onChanged={(value: boolean) => setExportOpen(value)}
            >
              {PAIRING_EXPORT_FORMATS.map((spec) => (
                <VStack key={`exp-${spec.id}`} alignment="leading" spacing={4} padding={{ vertical: 4 }}>
                  <Text font="subheadline" fontWeight="semibold">{spec.label}</Text>
                  <Text font="caption2" foregroundStyle="secondaryLabel">{spec.detail}</Text>
                  <HStack spacing={12}>
                    <Button
                      title="存为文件"
                      systemImage="square.and.arrow.down"
                      buttonStyle="borderless"
                      controlSize="small"
                      action={() => void handleExport(spec.id, false)}
                    />
                    {spec.text ? (
                      <Button
                        title="复制文本"
                        systemImage="doc.on.doc"
                        buttonStyle="borderless"
                        controlSize="small"
                        action={() => void handleExport(spec.id, true)}
                      />
                    ) : null}
                    <Spacer />
                  </HStack>
                </VStack>
              ))}
            </DisclosureGroup>
          </Section>
        ) : null}

        <Section header={<Text font="caption" foregroundStyle="secondaryLabel">导入配对记录</Text>}>
          <Button title="从文件导入…" action={importFromFile} />
          <Button title="从剪贴板粘贴" action={importFromClipboard} />
          <Button
            title={showPaste ? "收起" : "手动粘贴文本"}
            action={() => {
              setShowPaste((value) => !value);
              setStatus("");
              setIsError(false);
            }}
          />
        </Section>

        {showPaste && (
          <Section header={<Text font="caption" foregroundStyle="secondaryLabel">粘贴内容（plist XML 或 JSON）</Text>}>
            <TextField title="" value={pasteText} onChanged={setPasteText} prompt="粘贴内容…" axis="vertical" />
            <Button title="确认导入" action={() => importBytes(utf8(pasteText))} />
          </Section>
        )}

        {!!status && (
          <Section>
            <Text font="caption" foregroundStyle={statusColor}>{status}</Text>
          </Section>
        )}

        <Section
          header={<Text font="caption" foregroundStyle="secondaryLabel">怎么拿到配对记录</Text>}
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              文件里含私钥，等同于这台设备的调试授权，请勿外传。更新系统后设备侧的配对授权会失效，回到这一页重新配一次即可。
            </Text>
          }
        >
          <VStack alignment="leading" spacing={8}>
            <Text font="caption">1. 在 wloc 里完成「配对这台 iPhone」</Text>
            <Text font="caption">2. 配对页点「导出配对文件」，存成 wloc-pairing.mobiledevicepairing</Text>
            <Text font="caption">3. 回到这里「从文件导入」选中它</Text>
            <Text font="caption2" foregroundStyle="secondaryLabel">
              支持二进制 plist、XML plist，以及旧版脚本的 JSON 格式。
            </Text>
          </VStack>
        </Section>
      </List>
    </NavigationStack>
  );
}
