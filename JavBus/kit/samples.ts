// 样品图像：批量下载与存相册。
//
// 原版把图片存进脚本文件管理里的 `样品图像/<文件夹>/<番号>-NN.jpg`，文件夹名是演员名（只有一位演员时）
// 或番号。这里目录结构不变，落在脚本的 Documents 下。

import { pad2, safeFileName } from "../core/format";
import type { SampleImage } from "../core/types";
import { fetchImageData } from "./images";

const ROOT = "样品图像";
const WORKERS = 3;

export function samplesDir(folder: string): string {
  return `${FileManager.documentsDirectory}/${ROOT}/${safeFileName(folder)}`;
}

export interface DownloadReport {
  dir: string;
  /** 成功写入的文件绝对路径。 */
  files: string[];
  failed: number;
}

/**
 * 并发 3 路下载。文件名按图片序号编（`SSIS-001-01.jpg`），不像原版按完成先后编——
 * 并发下完成顺序是乱的，同一部片两次下载会得到不同的编号。
 * 大图（DMM 图床）下不下来时退回站内缩略图，总比整张缺着强。
 */
export async function downloadSamples(opts: {
  code: string;
  folder: string;
  images: SampleImage[];
  onProgress: (done: number, total: number) => void;
}): Promise<DownloadReport> {
  const dir = samplesDir(opts.folder);
  if (!(await FileManager.exists(dir))) await FileManager.createDirectory(dir, true);

  const total = opts.images.length;
  const files: (string | null)[] = opts.images.map(() => null);
  let next = 0;
  let done = 0;

  const worker = async () => {
    for (let i = next++; i < total; i = next++) {
      const image = opts.images[i];
      const data = (await fetchImageData(image.full)) ?? (await fetchImageData(image.thumb));
      if (data) {
        const path = `${dir}/${safeFileName(opts.code)}-${pad2(i + 1)}.jpg`;
        try {
          await FileManager.writeAsData(path, data);
          files[i] = path;
        } catch {
          /* 写盘失败按失败计 */
        }
      }
      opts.onProgress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, total) }, worker));

  const saved = files.filter((f): f is string => f !== null);
  return { dir, files: saved, failed: total - saved.length };
}

/** 把下载好的文件存进相册（复制，不挪走原文件）。返回成功张数。 */
export async function saveFilesToAlbum(files: string[]): Promise<number> {
  let ok = 0;
  for (const path of files) {
    try {
      if (await Photos.savePhoto(path, { shouldMoveFile: false })) ok++;
    } catch {
      return ok; // 多半是相册权限被拒，后面的也不会成功
    }
  }
  return ok;
}

/** 存单张到相册，用原始字节（不经 UIImage 重编码）。 */
export async function saveImageUrlToAlbum(url: string, fileName: string): Promise<boolean> {
  const data = await fetchImageData(url);
  if (!data) return false;
  try {
    return await Photos.savePhoto(data, { fileName });
  } catch {
    return false;
  }
}
