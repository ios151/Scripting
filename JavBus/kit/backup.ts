// 收藏备份的导入 / 导出。
//
// 原版把数据存在脚本文件管理里的 JavBusBackup.json，空收藏时弹窗教用户把旧的 JavBusBackup.json
// 手动挪进脚本的文件管理接续数据。这里把「挪文件」做成一个按钮：从「文件」里选这个 JSON 导入，
// 原版导出的备份直接能用（格式同形，见 core/types.ts）。

import { libraryCounts } from "../core/library";
import { exportLibrary, importLibrary, library } from "./store";
import type { ImportMode } from "./store";

const FILE_NAME = "JavBusBackup.json";

const LABELS: [keyof ReturnType<typeof libraryCounts>, string][] = [
  ["favorite", "影片"],
  ["archive", "归档"],
  ["actress", "演员"],
  ["director", "导演"],
  ["series", "系列"],
  ["filmMaker", "制作商"],
  ["filmEstab", "发行商"],
];

/** 导入前后各表条数的差，拼成「影片 +3、演员 +1」。 */
function summarize(before: ReturnType<typeof libraryCounts>, after: ReturnType<typeof libraryCounts>): string {
  const parts = LABELS.map(([key, label]) => ({ label, diff: after[key] - before[key] }))
    .filter((p) => p.diff !== 0)
    .map((p) => `${p.label} ${p.diff > 0 ? "+" : ""}${p.diff}`);
  return parts.length > 0 ? parts.join("、") : "没有新增内容";
}

/** 选文件导入。取消返回 null；格式不对会抛错（调用方显示）。 */
export async function importBackupFromFile(): Promise<string | null> {
  const paths = await DocumentPicker.pickFiles({ types: ["public.json", "public.text"], allowsMultipleSelection: false });
  if (!paths || paths.length === 0) return null;
  const text = await FileManager.readAsString(paths[0]);

  const hasData = Object.values(libraryCounts(library())).some((n) => n > 0);
  let mode: ImportMode = "merge";
  if (hasData) {
    const choice = await Dialog.actionSheet({
      title: "导入备份",
      message: "本机已有收藏数据，怎么处理？",
      actions: [{ label: "合并到现有收藏" }, { label: "覆盖现有收藏", destructive: true }],
    });
    if (choice === null) return null;
    mode = choice === 1 ? "replace" : "merge";
  }

  const { before, after } = importLibrary(text, mode);
  return `导入完成：${summarize(libraryCounts(before), libraryCounts(after))}`;
}

/** 导出成 JavBusBackup.json，交给系统「存储到文件」。取消返回 false。 */
export async function exportBackupFile(): Promise<boolean> {
  const data = Data.fromString(exportLibrary());
  if (!data) throw new Error("生成备份失败");
  const saved = await DocumentPicker.exportFiles({ files: [{ data, name: FILE_NAME }] });
  return saved.length > 0;
}
