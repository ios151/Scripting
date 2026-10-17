// 后台保活的持有者记账。
//
// `BackgroundKeeper` 的引用计数是**按脚本**算的，不是按调用算的——dts 原文：
// 「Repeated successful calls from one script are idempotent. stopKeepAlive()
// releases that script's request.」同一个脚本里不管谁调 `stopKeepAlive()`，
// 整份请求都没了。
//
// 所以在这里自己记一份持有者，最后一个松手才真的停。
//
// 持有者按**可能同时在跑的活动**分，不按页面分：同名持有者只记一次，谁先松手
// 整份就没了。应用管理的图标和占用空间是两条并行的任务，所以各占一个名字。
// 名字按需要加，加完记得在下面的联合类型里写清楚它管哪段活动。

import { debugLog, describeError } from "../core/debug";

export type KeepAliveOwner =
  /** 配对（输 PIN 的那几十秒）。 */
  | "pairing"
  /** 电池实时刷新。 */
  | "session"
  /** 应用管理：逐个取图标，几百个要十几秒。 */
  | "apps-icons"
  /** 应用管理：算占用空间，一百多个要半分钟。 */
  | "apps-sizes"
  /** 实时性能采样。 */
  | "sysmon"
  /** 系统事件监听，一挂就是十分钟。 */
  | "events";

const owners = new Set<KeepAliveOwner>();

/**
 * 申请保活并登记持有者。
 *
 * 每次都真的调一遍 `keepAlive()`，不因为已登记就跳过：保活靠的是共享音频引擎，
 * 来一通电话就会被打断（`getState().status` 变 `interrupted`），这时重调才能把
 * 它接回来。重复调用本身是幂等的。
 *
 * **绝对不要写 `if (Script.env !== "index") return` 这种预判。**
 *
 * 文档和 dts 都写着「仅 `index` 可用」，**这句是错的**：首页 Tab（`home_screen`）
 * 跑在主 App 里，保活照常生效。照着那句话拦一道，首页入口的保活就整个没了，
 * 后果是蜂窝下切走几分钟必掉线——而掉线不报错，界面上一点线索都没有，
 * 只有用户来说「又断了」。
 *
 * 能不能用**问 `keepAlive()` 自己**：系统拒绝会 resolve 成 false，环境不允许会 reject。
 * 有返回值可问的 API，就不要拿环境名去猜。
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

/**
 * 把一段耗时的活动包起来：开始前申请保活，不管成没成、出没出错，结束后都松手。
 *
 * **申请要在前台做**（点按钮那一刻就在前台），不是等切后台了再补——dts 原话
 * 「while foregrounded, before starting background work」。
 * 申请失败不拦着活动继续：保活只是让它在后台也能跑完，拿不到顶多是切走会断。
 */
export async function withKeepAlive<T>(owner: KeepAliveOwner, work: () => Promise<T>): Promise<T> {
  const kept = await retainKeepAlive(owner).catch((error) => {
    debugLog("keepalive", `${owner} 申请保活失败`, describeError(error));
    return false;
  });
  try {
    return await work();
  } finally {
    if (kept) await releaseKeepAlive(owner);
  }
}
