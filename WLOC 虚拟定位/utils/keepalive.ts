// 后台保活的持有者记账。
//
// `BackgroundKeeper` 的引用计数是**按脚本**算的，不是按调用算的——dts 原文：
// 「Repeated successful calls from one script are idempotent. stopKeepAlive()
// releases that script's request.」同一个脚本里不管谁调 `stopKeepAlive()`，
// 整份请求都没了。
//
// 本脚本有两处要保活：会话（整个模拟期间）和配对（输 PIN 的那几十秒）。
// 各调各的就会出现「模拟进行中去重新配对，配完一松手，模拟的保活被一起撤掉」，
// 而系统更新后边模拟边重新配对恰恰是常见操作。所以在这里自己记一份持有者，
// 最后一个松手才真的停。

import { debugLog, describeError } from "../core/debug";

export type KeepAliveOwner = "session" | "pairing";

const owners = new Set<KeepAliveOwner>();

/**
 * 申请保活并登记持有者。
 *
 * 每次都真的调一遍 `keepAlive()`，不因为已登记就跳过：保活靠的是共享音频引擎，
 * 来一通电话就会被打断（`getState().status` 变 `interrupted`），这时重调才能把
 * 它接回来。重复调用本身是幂等的。
 *
 * **不要按 `Script.env` 预判能不能用。** 文档和 dts 都写着「仅 `index` 可用」，
 * 据此拦掉首页 Tab 是 2.7.1 的错——Tab 跑在主 App 里，保活照常生效，拦掉的结果
 * 是蜂窝下切走几分钟必掉线。能不能用问 `keepAlive()` 自己：系统拒绝会 resolve
 * 成 false，环境不允许会 reject。
 *
 * @returns 保活是否真的起来了
 * @throws 环境不允许时 `keepAlive()` 自己会抛，交给调用方处理
 */
export async function retainKeepAlive(owner: KeepAliveOwner): Promise<boolean> {
  /*
    登记放在 await **之后**。

    放前面的话，`keepAlive()` 抛出时这个 owner 就永远留在集合里了——调用方
    接住异常、认为自己没拿到租约、也就不会去 release，于是其他持有者松手时
    `owners.size > 0` 永远成立，音频引擎再也停不下来，白耗电到脚本退出。

    抛出时也不删已有的登记：会话中途重申请失败（比如来电打断）不该把它
    原本持有的那份一笔勾销。
  */
  const started = await BackgroundKeeper.keepAlive();
  owners.add(owner);
  debugLog("keepalive", `keepAlive() 返回 ${started}（持有者：${[...owners].join("+")}）`);
  return started;
}

/** 松手。只有最后一个持有者松手时才真的停。 */
export async function releaseKeepAlive(owner: KeepAliveOwner): Promise<void> {
  if (!owners.delete(owner)) return;
  if (owners.size > 0) {
    debugLog("keepalive", `${owner} 松手，${[...owners].join("+")} 还要，保活继续`);
    return;
  }
  debugLog("keepalive", `${owner} 松手，没人要了，停掉保活`);
  await BackgroundKeeper.stopKeepAlive().catch((error) => {
    debugLog("keepalive", "停保活出错", describeError(error));
  });
}
