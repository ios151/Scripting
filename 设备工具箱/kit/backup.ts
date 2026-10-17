// 主屏布局的本地备份：每次写回设备之前自动存一份，「恢复」从这里取。
//
// 存在本脚本的文档目录里（FileManager.documentsDirectory/主屏备份/），只留最近 20 份。
// 文件就是设备原样返回的 iconState，编码成 XML plist——和「导出备份」是同一种格式，
// 用户手动导出的那份也能拿来恢复。

import type { PlistValue } from "../core/bplist";
import { fileStamp } from "./dates";
import { decodePlist, encodeXmlPlist } from "./plist";

const KEEP = 20;

function backupDirectory(): string {
  return `${FileManager.documentsDirectory}/主屏备份`;
}

export interface BackupEntry {
  name: string;
  path: string;
}

function toPath(dir: string, entry: string): string {
  return entry.startsWith("/") ? entry : `${dir}/${entry}`;
}

export async function listBackups(): Promise<BackupEntry[]> {
  const dir = backupDirectory();
  if (!(await FileManager.exists(dir))) return [];
  const names = await FileManager.readDirectory(dir);
  return names
    .map((entry) => ({ name: entry.split("/").pop() ?? entry, path: toPath(dir, entry) }))
    .filter((entry) => entry.name.endsWith(".plist"))
    // 文件名就是时间戳，倒序即最新在前
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** 存一份，返回文件名。超过上限的旧备份删掉。 */
export async function saveBackup(raw: PlistValue, reason: string): Promise<string> {
  const dir = backupDirectory();
  await FileManager.createDirectory(dir, true);
  const name = `${fileStamp()}-${reason}.plist`;
  await FileManager.writeAsBytes(`${dir}/${name}`, encodeXmlPlist(raw));
  const all = await listBackups();
  for (const old of all.slice(KEEP)) await FileManager.remove(old.path).catch(() => undefined);
  return name;
}

export async function loadBackup(path: string): Promise<PlistValue> {
  const raw = decodePlist(await FileManager.readAsBytes(path));
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(Array.isArray)) {
    throw new Error("这个文件不是主屏布局备份");
  }
  return raw;
}
