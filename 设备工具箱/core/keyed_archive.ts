// NSKeyedArchiver 归档/解档（够用版）。
//
// DTX 的方法名与方法参数在线路上都是 NSKeyedArchiver 归档后的 plist，
// 直接发 UTF-8 字符串设备不认。回包同理，解档后才能读出 NSError 文案。

import { decodeBplist, encodeBplist, isBplist, PReal, PUid, type PlistValue } from "./bplist";

const NULL_PLACEHOLDER = "$null";

/** 把一个基础值（字符串/数字/布尔）归档成 NSKeyedArchiver plist。 */
export function archive(value: PlistValue): Uint8Array {
  return encodeBplist({
    $version: 100000,
    $objects: [NULL_PLACEHOLDER, value],
    $archiver: "NSKeyedArchiver",
    $top: { root: new PUid(1) },
  });
}

/** 归档一个双精度数——经纬度参数走这条路。 */
export function archiveDouble(value: number): Uint8Array {
  return archive(new PReal(value));
}

/** 归档一个字符串——方法名与频道名走这条路。 */
export function archiveString(value: string): Uint8Array {
  return archive(value);
}

/**
 * 解档。只解引用 UID 并还原 NSArray/NSDictionary/NSString 这几种容器，
 * 其余类实例原样返回解引用后的字典（带 $class 名），足够读出错误描述。
 */
export function unarchive(bytes: Uint8Array): unknown {
  if (!isBplist(bytes)) return null;
  const { root, objects } = decodeBplist(bytes);

  if (typeof root !== "object" || root === null || Array.isArray(root)) return root;
  const top = (root as Record<string, PlistValue>)["$top"];
  if (top === undefined) return root;

  const objectList = Array.isArray((root as Record<string, PlistValue>)["$objects"])
    ? ((root as Record<string, PlistValue>)["$objects"] as PlistValue[])
    : objects;

  const rootRef = typeof top === "object" && top !== null && !Array.isArray(top)
    ? (top as Record<string, PlistValue>)["root"]
    : top;

  return resolve(rootRef, objectList, 0);
}

function resolve(value: PlistValue | undefined, objects: PlistValue[], depth: number): unknown {
  if (value === undefined) return null;
  if (depth > 32) return null;

  if (value instanceof PUid) {
    const target = objects[value.value];
    if (target === NULL_PLACEHOLDER) return null;
    return resolve(target, objects, depth + 1);
  }

  if (value instanceof PReal) return value.value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((item) => resolve(item, objects, depth + 1));

  if (typeof value === "object" && value !== null) {
    const dict = value as Record<string, PlistValue>;

    if (dict["NS.string"] !== undefined) return resolve(dict["NS.string"], objects, depth + 1);

    if (dict["NS.objects"] !== undefined) {
      const items = resolve(dict["NS.objects"], objects, depth + 1) as unknown[];
      if (dict["NS.keys"] === undefined) return items;
      const keys = resolve(dict["NS.keys"], objects, depth + 1) as unknown[];
      const out: Record<string, unknown> = {};
      keys.forEach((key, index) => {
        out[String(key)] = items[index];
      });
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(dict)) {
      if (key === "$class") {
        const cls = resolve(item, objects, depth + 1);
        if (cls && typeof cls === "object") out.$class = (cls as Record<string, unknown>).$classname ?? null;
        continue;
      }
      out[key] = resolve(item, objects, depth + 1);
    }
    return out;
  }

  return value;
}

/** NSError 里放描述的键，以及套着描述的容器键。 */
const ERROR_MESSAGE_KEYS = ["NSLocalizedDescription", "NSLocalizedFailureReason", "NSDebugDescription"];
const ERROR_CONTAINER_KEYS = ["NSUserInfo", "userInfo", "NS.objects"];

/**
 * 从解档后的回包里捞错误描述，没有则返回 null。
 *
 * 只认 NSError 的那几个键与承载它们的容器——不能见到字符串就当错误，
 * 否则正常回包里的任何字符串都会被误报成失败。
 */
export function describeArchivedError(value: unknown, depth = 0): string | null {
  if (value == null || depth > 8) return null;

  // 设备偶尔直接回一条字符串，那就是错误本身。
  if (typeof value === "string") return value.trim() || null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = describeArchivedError(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  const dict = value as Record<string, unknown>;
  for (const key of ERROR_MESSAGE_KEYS) {
    const message = dict[key];
    if (typeof message === "string" && message.trim()) return message.trim();
  }

  for (const key of ERROR_CONTAINER_KEYS) {
    if (dict[key] === undefined) continue;
    const found = describeArchivedError(dict[key], depth + 1);
    if (found) return found;
  }

  // 是 NSError 但没带本地化文案时，退而给出域与错误码。
  if (dict.$class === "NSError") {
    const domain = typeof dict.NSDomain === "string" ? dict.NSDomain : "未知域";
    const code = typeof dict.NSCode === "number" ? dict.NSCode : "?";
    return `${domain} (${code})`;
  }

  return null;
}
