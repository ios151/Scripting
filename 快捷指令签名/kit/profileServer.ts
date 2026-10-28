// 把根证书的描述文件交给 Safari，由系统接手安装。
//
// 做法沿用设备工具箱验证过的那套：本机起一个一次性 HttpServer，用 `HttpResponse.raw` 带上
// application/x-apple-aspen-config 发出去，再 `Safari.openURL` 打开 http://127.0.0.1:端口/…，
// Safari 下载完，系统弹「已下载描述文件」。
//
// 几处不显眼的约束（审查员逐条对过文档 / 真机行为）：
//   - 监听地址显式写成 127.0.0.1：文档只说 listenAddressIPv4「forceIPv4 为 true 时才用」，没说默认值，
//     不赌它默认只听回环。
//   - `start()` 声明写「成功返回 null」，真机上成功返回 undefined（2026-10-28 用户截图：
//     「本地服务启动失败：undefined」，按 !== null 判断把成功当失败）。只认真有内容的错误字符串。
//   - 后台保活：跳去 Safari 之后 Scripting 在后台，不保活的话服务可能还没被取就被挂起。
//     音频被别的 App 占着时 keepAlive 会返回 false（文档：Audio failure resolves to false），
//     而且可能迟迟不返回，所以给它 4 秒期限，结果交给界面提示。
//   - 描述文件被取走之后不能只留 3 秒：用户读「允许下载配置描述文件」那个弹窗要时间。
//     改成等到「离开过 App 又回到前台」，最长 90 秒；至少留 3 秒让下载收尾。服务只听回环、只有一条
//     固定路径、内容就是公开的根证书，多开一会儿没有代价。

import { AppEvents } from "scripting";
import type { SigningIdentity } from "../core/identity";
import { rootProfile } from "../core/profile";

const PROFILE_PATH = "/shortcut-signer.mobileconfig";
const WAIT_FOR_DOWNLOAD_MS = 60_000;
const MIN_LINGER_MS = 3_000;
const MAX_LINGER_MS = 90_000;
const KEEP_ALIVE_TIMEOUT_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface InstallResult {
  /** Safari 有没有把描述文件取走（取走了才有后面「设置里点安装」那一步；不代表用户点了「允许」） */
  delivered: boolean;
  /** 后台保活有没有开成。false 时 Safari 可能一直转圈，界面要提示用户暂停音乐再试 */
  keptAlive: boolean;
}

async function requestKeepAlive(): Promise<boolean> {
  try {
    return await Promise.race([BackgroundKeeper.keepAlive(), sleep(KEEP_ALIVE_TIMEOUT_MS).then(() => false)]);
  } catch {
    return false;
  }
}

export async function installRootCertificate(identity: SigningIdentity): Promise<InstallResult> {
  const body = Data.fromUint8Array(rootProfile(identity));
  if (body == null) throw new Error("描述文件生成失败");

  const server = new HttpServer();
  let delivered = false;
  server.registerAsyncHandler(PROFILE_PATH, async () => {
    delivered = true;
    return HttpResponse.raw(200, "OK", {
      headers: {
        "Content-Type": "application/x-apple-aspen-config",
        "Content-Disposition": 'attachment; filename="shortcut-signer.mobileconfig"',
        "Cache-Control": "no-store",
      },
      body,
    });
  });

  server.listenAddressIPv4 = "127.0.0.1";
  const failure: unknown = server.start({ port: 0, forceIPv4: true });
  if (typeof failure === "string" && failure !== "") throw new Error(`本地服务启动失败：${failure}`);

  // 记「离开过 App、又回来了」：Safari 打开时 App 先 inactive 再 background，用户从设置回来是 active
  let wasAway = false;
  let returned = false;
  const onPhase = (phase: string) => {
    if (phase !== "active") wasAway = true;
    else if (wasAway) returned = true;
  };
  AppEvents.scenePhase.addListener(onPhase);

  try {
    const port = server.port;
    if (port === null || port === undefined) throw new Error("本地服务没有拿到端口");
    const keptAlive = await requestKeepAlive();
    const opened = await Safari.openURL(`http://127.0.0.1:${port}${PROFILE_PATH}`);
    // 只认明确的 false 才算失败：这个返回值真机上没核过，同类的 start() 就把「成功」回成了 undefined
    if (opened === false) throw new Error("打不开 Safari");

    const waitUntil = Date.now() + WAIT_FOR_DOWNLOAD_MS;
    while (!delivered && Date.now() < waitUntil) await sleep(250);
    if (!delivered) return { delivered: false, keptAlive };

    const deliveredAt = Date.now();
    while (Date.now() - deliveredAt < MAX_LINGER_MS && !(returned && Date.now() - deliveredAt >= MIN_LINGER_MS)) {
      await sleep(250);
    }
    return { delivered: true, keptAlive };
  } finally {
    AppEvents.scenePhase.removeListener(onPhase);
    server.stop();
    // 申请有没有成功、是不是超时之后才成功，都释放一次：没有申请时这是空操作，有就别留着耗电
    await BackgroundKeeper.stopKeepAlive().catch(() => undefined);
  }
}
