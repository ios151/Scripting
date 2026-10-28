import { Button, HStack, Image, Spacer, Text, VStack, useState } from "scripting"

export type SignedShortcutViewProps = {
  /** 签好的 .shortcut 的绝对路径（sign 结果里的 items[].path） */
  path: string
  /** 快捷指令的名字（items[].name） */
  name?: string
  /** 动作数（items[].actionCount） */
  actionCount?: number
  /** 文件大小，字节（items[].size） */
  size?: number
  /** 证书是不是已经确认装好并信任（sign 结果里的 certificate.usable）。false 时卡片上提醒导入会失败 */
  certificateReady?: boolean
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "")
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/**
 * 聊天里的「导入」卡片：显示签好的快捷指令，点「导入」弹出系统分享面板，选「快捷指令」就进导入界面。
 * 在聊天里用 `scripting-file` 块渲染它（见技能的 SKILL.md）。
 */
export default function SignedShortcutView({ path, name, actionCount, size, certificateReady }: SignedShortcutViewProps) {
  const [busy, setBusy] = useState(false)
  const isChinese = Device.systemLocale.toLowerCase().startsWith("zh")
  const title = name || baseName(path)

  const detail = [
    typeof actionCount === "number" ? (isChinese ? `${actionCount} 个动作` : `${actionCount} actions`) : "",
    typeof size === "number" ? formatSize(size) : "",
  ]
    .filter((part) => part !== "")
    .join(" · ")

  const importShortcut = async () => {
    if (busy) return
    setBusy(true)
    try {
      await ShareSheet.present([path])
    } finally {
      setBusy(false)
    }
  }

  const saveToFiles = async () => {
    if (busy) return
    setBusy(true)
    try {
      const data = Data.fromFile(path)
      if (data == null) return
      await DocumentPicker.exportFiles({ files: [{ data, name: baseName(path) }] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack alignment="leading" spacing={9} padding={{ vertical: 4 }}>
      <HStack spacing={10} alignment="center">
        <Image systemName="checkmark.seal.fill" foregroundStyle="systemBlue" />
        <VStack alignment="leading" spacing={2}>
          <Text font="subheadline" fontWeight="semibold" lineLimit={2} foregroundStyle="label">
            {title}
          </Text>
          {detail !== "" ? (
            <Text font="caption" foregroundStyle="secondaryLabel">
              {detail}
            </Text>
          ) : null}
        </VStack>
        <Spacer />
      </HStack>

      {certificateReady === false ? (
        <Text font="caption" foregroundStyle="systemOrange">
          {isChinese
            ? "证书还没确认装好并信任：现在导入会提示无法验证。先在「快捷指令签名」脚本里装好并信任证书。"
            : "The certificate is not confirmed as installed and trusted yet, so importing will fail. Install and trust it in the signer script first."}
        </Text>
      ) : null}

      <HStack spacing={10}>
        <Button
          title={isChinese ? "导入" : "Import"}
          systemImage="square.and.arrow.down"
          buttonStyle="bordered"
          controlSize="small"
          disabled={busy}
          action={() => void importShortcut()}
        />
        <Button
          title={isChinese ? "存到文件" : "Save to Files"}
          systemImage="folder"
          buttonStyle="bordered"
          controlSize="small"
          disabled={busy}
          action={() => void saveToFiles()}
        />
        <Spacer />
      </HStack>
    </VStack>
  )
}
