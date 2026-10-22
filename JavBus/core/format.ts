// 展示用的小格式化函数。

/**
 * 影片长度：原版把分钟拼成 `0H:MM`（128 → `02:08`），缺失显示 `???分钟`。
 * 原版 `"0" + hours` 在 10 小时以上会拼出 `010`，这里改成补零到两位。
 */
export function formatLength(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "???分钟";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** 详情页「上映時間」那一行：`2021-09-09(02:08)`。 */
export function releaseLine(date: string, minutes: number | null): string {
  return `${date || "????-??-??"}(${formatLength(minutes)})`;
}

/** 原版 nowTime()：`2026-10-22`，月日不补零（推荐上传的 info 里用，和已有数据保持一致）。 */
export function todayString(now = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 样品图序号：`01`、`02`…（下载文件名 `<番号>-01.jpg` 用）。 */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 文件夹名里不能有的字符换成下划线（演员名偶尔带 `/`）。 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

/** 稳定地给一个名字挑一组渐变色：原版每次渲染随机，列表一刷新颜色就跳。 */
export function hashIndex(text: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % modulo;
}
