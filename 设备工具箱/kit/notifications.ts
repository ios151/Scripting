// 系统事件探针：订阅系统内部的通知，设备有动静就推过来。
//
// 请求格式照 idevice（notification_proxy.rs）：
//   {Command: "ObserveNotification", Name: "…"}  订阅一个名字，可以订阅多个
//   设备之后持续回  {Command: "RelayNotification", Name: "…"}
//   {Command: "Shutdown"}  收工
//
// 这些事件平时只在系统各组件之间传，外面看不见。装个 App、锁一下屏、改个设置，
// 对应的事件会当场跳出来。
//
// **只订阅、只接收，不往外发。** PostNotification 能让系统做事（触发备份之类），
// 那是另一回事，这里不碰。

import { debugLog } from "../core/debug";
import { withTimeout } from "../core/stream";
import type { DeviceSession } from "./session";

export const NOTIFICATION_SERVICE = "com.apple.mobile.notification_proxy.shim.remote";

export interface EventKind {
  /** 系统里的通知名。 */
  name: string;
  /** 给人看的说法。 */
  label: string;
  group: string;
}

/**
 * 可以订阅的事件。名字取自 libimobiledevice 长期在用的那批常量。
 * 设备不认识的名字不会报错，只是永远不会推过来，所以多列几个没有副作用。
 */
export const EVENT_KINDS: EventKind[] = [
  { group: "应用", name: "com.apple.mobile.application_installed", label: "装了一个 App" },
  { group: "应用", name: "com.apple.mobile.application_uninstalled", label: "卸了一个 App" },
  { group: "屏幕", name: "com.apple.springboard.lockstate", label: "锁屏状态变了" },
  { group: "屏幕", name: "com.apple.springboard.hasBlankedScreen", label: "屏幕熄灭" },
  { group: "屏幕", name: "com.apple.springboard.lockcomplete", label: "锁屏完成" },
  { group: "屏幕", name: "com.apple.springboard.finishedstartup", label: "SpringBoard 启动完成" },
  { group: "系统", name: "com.apple.language.changed", label: "语言或地区变了" },
  { group: "系统", name: "com.apple.mobile.lockdown.device_name_changed", label: "设备名改了" },
  { group: "系统", name: "com.apple.mobile.lockdown.trusted_host_attached", label: "连上了受信任的电脑" },
  { group: "系统", name: "com.apple.mobile.lockdown.host_detached", label: "电脑断开" },
  { group: "系统", name: "com.apple.mobile.lockdown.host_attached", label: "电脑接上" },
  { group: "备份与同步", name: "com.apple.itdbprep.notification.didEnd", label: "媒体库整理结束" },
  { group: "备份与同步", name: "com.apple.mobile.data_sync.domain_changed", label: "同步数据变了" },
  { group: "备份与同步", name: "com.apple.itunes-client.syncCancelRequest", label: "同步被取消" },
  { group: "备份与同步", name: "com.apple.mobile.backup.domain_changed", label: "备份数据变了" },
];

export const EVENT_GROUPS = [...new Set(EVENT_KINDS.map((kind) => kind.group))];

export interface DeviceEvent {
  at: number;
  name: string;
  /** 认识的名字给中文说法，不认识的就显示原名。 */
  label: string;
}

/** 名字 → 说法。设备可能推来没订阅过的名字，所以要兜底。 */
const LABELS = new Map(EVENT_KINDS.map((kind) => [kind.name, kind.label]));

export function describeEvent(name: string, at = Date.now()): DeviceEvent {
  return { at, name, label: LABELS.get(name) ?? name };
}

/** 这么久没有任何事件就当连接废了。系统平时很安静，给足时间。 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface WatchOptions {
  /** 要订阅的事件名。 */
  names: string[];
  onEvent: (event: DeviceEvent) => void;
  /** 返回 true 就收工。 */
  shouldStop: () => boolean;
  /** 订阅完成时调一次，让界面知道已经在听了。 */
  onReady?: () => void;
}

/**
 * 订阅并持续接收，直到 shouldStop 为 true。整个过程占一条连接。
 *
 * 注意：停止只在收到下一条事件、或者等待超时后才会生效——读是阻塞的，
 * 没法从外面打断。所以界面上点「停止」之后，连接可能还挂着，直到下一个事件来。
 */
export async function watchEvents(session: DeviceSession, options: WatchOptions): Promise<void> {
  const names = [...new Set(options.names)].filter((name) => name.trim());
  if (names.length === 0) throw new Error("没有选中任何事件");
  await session.withService(NOTIFICATION_SERVICE, async (client) => {
    for (const name of names) await client.send({ Command: "ObserveNotification", Name: name });
    debugLog("events", `订阅了 ${names.length} 个事件`);
    options.onReady?.();
    try {
      while (!options.shouldStop()) {
        const message = await withTimeout(client.receiveDict(), IDLE_TIMEOUT_MS, "太久没有事件，已停止");
        if (message.Command !== "RelayNotification") continue;
        const name = typeof message.Name === "string" ? message.Name : "";
        if (!name) continue;
        debugLog("events", `收到 ${name}`);
        options.onEvent(describeEvent(name));
      }
    } finally {
      await client.send({ Command: "Shutdown" }).catch(() => undefined);
    }
  });
}
