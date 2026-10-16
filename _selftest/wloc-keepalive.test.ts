// 后台保活的持有者记账。
//
//   npx -y -p tsx tsx _selftest/wloc-keepalive.test.ts
//
// 这一块错了的后果很重：保活没了，App 切后台几分钟就被挂起，隧道断、定位弹回
// 真实位置——而界面上什么都不会报。2.7.1 就是在这里按 `Script.env` 预判，把首页
// Tab 整个入口拦废了。
//
// 要守的那条不变量：`BackgroundKeeper` 的引用计数**按脚本**算，谁调
// `stopKeepAlive()` 整份请求都没了。所以配对那边松手时，不能把模拟会话的保活
// 一起撤掉——边模拟边重新配对是常见操作。

import { releaseKeepAlive, retainKeepAlive } from "../WLOC 虚拟定位/utils/keepalive";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ""}`);
  }
}

/** 记下 keepAlive / stopKeepAlive 各被调了几次。 */
const calls = { keepAlive: 0, stop: 0 };
let keepAliveResult = true;

(globalThis as unknown as { BackgroundKeeper: unknown }).BackgroundKeeper = {
  async keepAlive() {
    calls.keepAlive += 1;
    return keepAliveResult;
  },
  async stopKeepAlive() {
    calls.stop += 1;
  },
};

async function main() {
  console.log("[持有者记账]");
  {
    await retainKeepAlive("session");
    check("会话 retain 真的调了 keepAlive", calls.keepAlive === 1, `${calls.keepAlive} 次`);

    await retainKeepAlive("pairing");
    // 每次都真调：保活被电话打断后要靠重调接回来，而重复调用本身是幂等的。
    check("配对 retain 也调一次 keepAlive", calls.keepAlive === 2, `${calls.keepAlive} 次`);

    await releaseKeepAlive("pairing");
    check("配对松手不撤掉会话的保活", calls.stop === 0, `stopKeepAlive 调了 ${calls.stop} 次`);

    await releaseKeepAlive("session");
    check("最后一个松手才真的停", calls.stop === 1, `stopKeepAlive 调了 ${calls.stop} 次`);
  }

  console.log("\n[重复与越界]");
  {
    calls.stop = 0;
    await releaseKeepAlive("session");
    check("没持有过的 owner 松手是空操作", calls.stop === 0, `stopKeepAlive 调了 ${calls.stop} 次`);

    await retainKeepAlive("session");
    await retainKeepAlive("session");
    await releaseKeepAlive("session");
    check("同一 owner 重复 retain 只需松手一次", calls.stop === 1, `stopKeepAlive 调了 ${calls.stop} 次`);
  }

  console.log("\n[系统拒绝]");
  {
    keepAliveResult = false;
    const started = await retainKeepAlive("session");
    check("被拒时如实返回 false", started === false);
    // 登记照样要留下：否则后面 release 不对称，保活会一直挂着没人收。
    calls.stop = 0;
    await releaseKeepAlive("session");
    check("被拒后仍然登记，松手时照常收尾", calls.stop === 1, `stopKeepAlive 调了 ${calls.stop} 次`);
    keepAliveResult = true;
  }

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

void main();
