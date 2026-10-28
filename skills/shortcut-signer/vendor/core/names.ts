// 文件名相关的小函数。放在 core/ 里是为了能在 Node 自测里跑：
// 快捷指令的名字来自 plist 里的 WFWorkflowName，是不可信的输入，要拿它当文件名必须先清洗。
//
// 本文件在脚本（core/）和技能（vendor/core/）里各有一份逐字节相同的副本（共 7 个文件，清单和同步命令见 MAINTAINING.md 第 14 节）：
// 源头是脚本这边，改任何一份都要同步另一份，自测会比对。

/**
 * 文件名里不能有的字符换成下划线，去掉首尾空白和点，限长；全被去光就用兜底名。
 * 斜杠、反斜杠都被换掉、开头的点也去掉，所以 `../../x` 这类名字出不了工作目录。
 */
export function safeFileName(name: string, fallback = "快捷指令"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 80);
  return cleaned === "" ? fallback : cleaned;
}

/** 路径最后一段（文件名）；末尾多余的斜杠不算。选文件拿到的都是 POSIX 绝对路径。 */
export function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/** 拼路径：用斜杠连起来，重复的斜杠合成一个（`temporaryDirectory` 末尾带不带斜杠都行）。只用于 POSIX 路径。 */
export function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

/** 分享面板递来的文件路径：正常就是绝对路径；万一是 file:// 链接，就还原成路径（%XX 解码，解不开原样用）。 */
export function sharedFilePath(raw: string): string {
  if (!/^file:\/\//i.test(raw)) return raw;
  const path = raw.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 存证书文件的文件夹，在「文件」App 里就是 Scripting 下面这个目录。 */
export const CERTIFICATE_DIR_NAME = "快捷指令签名证书";

/** 证书文件名：用证书自己的名字，扩展名 .cer（DER），「文件」App 点开它系统就会当证书来装。 */
export function certificateFileName(commonName: string): string {
  return `${safeFileName(commonName, "Shortcut Signer Root")}.cer`;
}

/**
 * 「文件」App 的深链：shareddocuments:// 加绝对路径。App 沙盒路径以 /var 开头时，
 * 真实位置是 /private/var（/var 是符号链接），写成后者更稳。路径里的中文和空格要编码。
 */
export function filesAppUrl(absolutePath: string): string {
  const real = absolutePath.startsWith("/var/") ? `/private${absolutePath}` : absolutePath;
  return `shareddocuments://${encodeURI(real)}`;
}

/** 文件名取链接路径最后一段（去掉查询串和锚点），解码失败就原样用，空了用「链接」。 */
export function nameFromUrl(url: string): string {
  const last = url.split(/[?#]/)[0].split("/").filter((part) => part !== "").pop() ?? "";
  try {
    return decodeURIComponent(last) || "链接";
  } catch {
    return last || "链接";
  }
}

/** 一眼看得出不是「文件直链」的链接，给个明确的说法；看不出来返回 null。 */
export function linkProblem(url: string): string | null {
  if (/^https:\/\/(www\.)?icloud\.com\/shortcuts\//i.test(url)) {
    return "这是 iCloud 分享链接，本来就是 Apple 签好的，在 Safari 里直接打开就能导入，不用经过这里。这里要的是 .shortcut 或 plist 文件的直链。";
  }
  return null;
}

/** 去掉常见的快捷指令 / plist 扩展名，作显示用的名字。 */
export function stripExtension(name: string): string {
  return name.replace(/\.(shortcut|plist|wflow|xml)$/i, "");
}

export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
