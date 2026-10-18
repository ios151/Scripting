// 设备在 RSD 握手时报上来的服务表：它到底开放了哪些能力。
//
// 这份目录只做一件事：把服务名翻译成人话，并标出本脚本用没用上。
// **不认识的原样列出来**——名字和端口都是设备给的事实，编一个说法反而误导。
//
// 名字后缀 `.shim.remote` 是 iOS 17 起 RSD 通道的叫法，和老的 lockdown 服务同名同义；
// 这里按去掉后缀之后的名字匹配，两种写法都认。

/** 本脚本真正连过的服务，以及用在哪。 */
export const USED: Record<string, string> = {
  "com.apple.mobile.lockdown.remote.trusted": "设备信息：型号、系统、存储、序列号",
  "com.apple.mobile.diagnostics_relay": "电池健康、硬件树（IORegistry）、重启 / 关机",
  "com.apple.springboardservices": "主屏布局、App 图标、壁纸",
  "com.apple.mobile.installation_proxy": "App 列表、占用空间、卸载",
  "com.apple.misagent": "描述文件：签名到期",
  "com.apple.mobile.mobile_image_mounter": "开发者磁盘镜像状态",
  "com.apple.mobile.notification_proxy": "系统事件探针",
  "com.apple.instruments.dtservicehub": "实时性能：CPU、内存、进程",
};

/**
 * 认识但没用上的。写清楚「是干什么的」，不写「能不能做」——
 * 能不能做要看设备给不给、以及该不该做，那是另一回事。
 */
export const KNOWN: Record<string, string> = {
  "com.apple.mobile.heartbeat": "心跳。Xcode 连着时靠它维持会话",
  "com.apple.mobile.MCInstall": "配置描述文件：VPN、Wi-Fi、证书那一类（和签名用的描述文件是两回事）",
  "com.apple.mobile.assertion_agent": "防休眠断言，调试时让设备别睡",
  "com.apple.mobile.house_arrest": "单个 App 的沙盒容器",
  "com.apple.afc": "「文件」App 里那块共享媒体目录",
  "com.apple.crashreportcopymobile": "崩溃日志",
  "com.apple.crashreportmover": "把崩溃日志挪到可取的位置",
  "com.apple.os_trace_relay": "系统日志（os_log）",
  "com.apple.syslog_relay": "老式 syslog 文本日志",
  "com.apple.pcapd": "网络抓包",
  "com.apple.mobilebackup2": "完整备份与恢复",
  "com.apple.mobilesync": "通讯录日历那套同步",
  "com.apple.mobile.screenshotr": "给设备屏幕截图",
  "com.apple.companion_proxy": "配对的 Apple Watch",
  "com.apple.mobileactivationd": "激活状态",
  "com.apple.webinspector": "Safari 网页调试",
  "com.apple.atc": "iTunes 媒体同步",
  "com.apple.streaming_zip_conduit": "边传边装 ipa",
  "com.apple.mobile.insecure_notification_proxy": "不需要信任关系的通知代理",
  "com.apple.dt.testmanagerd.remote": "跑 XCTest",
  "com.apple.dt.remoteFetchSymbols": "取设备上的符号文件",
  "com.apple.dt.simulatelocation": "模拟定位（WLOC 走的就是这条）",
  "com.apple.internal.dt.remote.debugproxy": "debugserver，调试器附加进程",
  "com.apple.gputools.remote.agent": "GPU 抓帧",
  "com.apple.bluetooth.BTPacketLogger": "蓝牙抓包",
  "com.apple.accessibility.axAuditDaemon.remoteserver": "辅助功能审计",
  "com.apple.iosdiagnostics.relay": "诊断数据上报",
  "com.apple.coredevice.appservice": "CoreDevice：装 App、起进程（iOS 17 起的新接口）",
  "com.apple.coredevice.deviceinfo": "CoreDevice：设备信息",
  "com.apple.coredevice.diagnosticsservice": "CoreDevice：诊断",
  "com.apple.coredevice.featureflagsservice": "CoreDevice：功能开关",
  "com.apple.coredevice.fileservice.control": "CoreDevice：文件传输控制",
  "com.apple.coredevice.openstdiosocket": "CoreDevice：进程的标准输入输出",
  "com.apple.remote.installcoordination_proxy": "安装协调",
  "com.apple.RemoteDebug.remoteautomationd": "远程自动化",
  "com.apple.dt.fetchsymbols": "取符号（老接口）",
};

export type ServiceKind = "used" | "known" | "unknown";

export interface ServiceRow {
  /** 设备报上来的原样名字。 */
  name: string;
  port: number;
  kind: ServiceKind;
  /** 用在哪 / 是干什么的。不认识时是空串。 */
  detail: string;
}

/** 去掉 RSD 的 `.shim.remote` 后缀，拿到和老 lockdown 服务一致的名字。 */
export function baseName(name: string): string {
  return name.endsWith(".shim.remote") ? name.slice(0, -".shim.remote".length) : name;
}

export function classify(name: string): { kind: ServiceKind; detail: string } {
  const base = baseName(name);
  // 完整名优先：lockdown.remote.trusted 这种本身就不带 shim 后缀
  const used = USED[name] ?? USED[base];
  if (used) return { kind: "used", detail: used };
  const known = KNOWN[name] ?? KNOWN[base];
  if (known) return { kind: "known", detail: known };
  return { kind: "unknown", detail: "" };
}

/** 整理成能直接渲染的行，按名字排。 */
export function describeServices(services: Map<string, number>): ServiceRow[] {
  return [...services.entries()]
    .map(([name, port]) => ({ name, port, ...classify(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const KIND_TITLE: Record<ServiceKind, string> = {
  used: "已经用上的",
  known: "认识，但本脚本没用",
  unknown: "没见过的",
};

/** 复制出去的那份文本。带端口，方便对着查。 */
export function listText(rows: ServiceRow[]): string {
  const lines = [`设备提供的服务，共 ${rows.length} 个`, ""];
  for (const kind of ["used", "known", "unknown"] as ServiceKind[]) {
    const group = rows.filter((row) => row.kind === kind);
    if (group.length === 0) continue;
    lines.push(`【${KIND_TITLE[kind]}】${group.length} 个`);
    for (const row of group) {
      lines.push(`  ${row.name}  :${row.port}${row.detail ? `  —— ${row.detail}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
