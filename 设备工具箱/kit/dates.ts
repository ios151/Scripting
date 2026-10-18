// 日期时间格式化。
//
// 原先五个文件各写一遍 `const pad = (v) => String(v).padStart(2, "0")`，
// 格式还各不相同。统一放这儿，页面只管挑一个用。
//
// 一律按**本机时区**显示：这些时间（备份时间、描述文件到期、事件发生）都是给人
// 当场看的，换算成 UTC 反而要在脑子里再转一次。

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 2026-10-18T03:45:07Z。只有这一个是 UTC：plist 的 `<date>` 就是这个格式，
 * 毫秒不写（苹果自己也不写），描述文件的到期时间也按它存。
 */
export function isoSeconds(at: Date): string {
  return at.toISOString().replace(/\.\d+Z$/, "Z");
}

/** 2026-10-18 */
export function ymd(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 2026-10-18 03:45 */
export function ymdhm(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${ymd(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 03:45:07。只有时间，用在一眨眼就过去的事件流里。 */
export function hms(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 20261018-034507，给文件名用。
 *
 * 带上秒：同一分钟内导出两次就会撞名，而连着导出两份正是常见操作。
 */
export function fileStamp(at: number | Date = Date.now()): string {
  const date = at instanceof Date ? at : new Date(at);
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
