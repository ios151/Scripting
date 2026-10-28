// 签出来的文件落在临时目录，再交给系统：分享面板 / 「打开方式」 / 存到「文件」。
//
// 界面状态里只放文件路径，不放整份字节（大块二进制进 state 会拖慢 Scripting 的界面，
// 设备工具箱踩过）。
//
// 不 import "scripting"：拼路径、取文件名用 core/names.ts 里的 joinPath / baseName，
// 原生全局（FileManager 等）只在函数体里用，这样 Node 里塞假的全局对象就能测。

import { runShortcutUrl } from "../core/jump";
import { CERTIFICATE_DIR_NAME, baseName, certificateFileName, filesAppUrl, joinPath, safeFileName } from "../core/names";

const WORK_DIR_NAME = "ShortcutSigner";

function workDir(): string {
  return joinPath(FileManager.temporaryDirectory, WORK_DIR_NAME);
}

/** 清掉上一轮留下的文件，并确保目录在。 */
export async function resetWorkDir(): Promise<void> {
  const dir = workDir();
  if (await FileManager.exists(dir)) {
    for (const entry of await FileManager.readDirectory(dir)) await FileManager.remove(joinPath(dir, entry));
  } else {
    await FileManager.createDirectory(dir, true);
  }
}

/** 写出 `<名字>.shortcut`；重名就加序号（不覆盖已有文件）。directory 不给就用临时工作目录。返回绝对路径。 */
export async function writeShortcut(name: string, bytes: Uint8Array, directory?: string): Promise<string> {
  const dir = directory ?? workDir();
  if (!(await FileManager.exists(dir))) await FileManager.createDirectory(dir, true);
  const base = safeFileName(name);
  let path = joinPath(dir, `${base}.shortcut`);
  for (let index = 2; await FileManager.exists(path); index++) path = joinPath(dir, `${base} ${index}.shortcut`);
  await FileManager.writeAsBytes(path, bytes);
  return path;
}

/**
 * 把根证书（DER，.cer）存进 Scripting 的文档目录下的「快捷指令签名证书」文件夹——
 * 那个目录在「文件」App 里看得到，点一下 .cer，系统就把它当描述文件接手去「设置」里装。
 * Safari 那条路走不通时的备选。文件夹是我们自己的，每次先清空，免得旧证书和新证书混在一起。
 * 返回 { 文件夹, 文件 } 的绝对路径。
 */
export async function writeCertificateFile(
  commonName: string,
  der: Uint8Array,
): Promise<{ dir: string; path: string }> {
  const dir = joinPath(FileManager.documentsDirectory, CERTIFICATE_DIR_NAME);
  if (await FileManager.exists(dir)) {
    for (const entry of await FileManager.readDirectory(dir)) await FileManager.remove(joinPath(dir, entry));
  } else {
    await FileManager.createDirectory(dir, true);
  }
  const path = joinPath(dir, certificateFileName(commonName));
  await FileManager.writeAsBytes(path, der);
  return { dir, path };
}

/** 跳到「文件」App 的某个目录；跳没跳成返回 false，调用方要把路径用文字写出来。 */
export async function openInFilesApp(absolutePath: string): Promise<boolean> {
  try {
    return await Safari.openURL(filesAppUrl(absolutePath));
  } catch {
    return false;
  }
}

/** 让「快捷指令」App 运行指定名字的快捷指令；系统没接手返回 false。 */
export async function runShortcutByName(name: string): Promise<boolean> {
  try {
    return await Safari.openURL(runShortcutUrl(name));
  } catch {
    return false;
  }
}

/** 系统分享面板：里面有「快捷指令」，选它就进导入界面。 */
export function shareFile(path: string): Promise<boolean> {
  return ShareSheet.present([path]);
}

/** 「打开方式…」菜单：只列能打开这个文件的 App。 */
export function openInMenu(path: string): Promise<string | null> {
  return DocumentInteraction.openInMenu(path);
}

/** 存到「文件」App。 */
export async function saveToFiles(path: string): Promise<boolean> {
  const data = Data.fromFile(path);
  if (data == null) throw new Error("读不到刚才签好的文件");
  const saved = await DocumentPicker.exportFiles({ files: [{ data, name: baseName(path) }] });
  // 点「取消」时回的未必是空数组（Dialog.prompt 的取消就是 undefined，dts 写的是 null），不赌
  return Array.isArray(saved) && saved.length > 0;
}
