// 离线自测：kit/orientation.ts 的进入横屏 / 退出横屏 / 还原，和「等界面转过去」（Device 换成内存替身）。
//   npx -y -p tsx tsx _selftest/javbus-player.test.ts
//
// 只验证我们自己的逻辑：进入时只留横屏、退出时先只许竖屏再等界面转回来、之后还原成用户自己的配置、
// 退出的等待期里又进入 / 还原会取消那次还原、连着退出两次只认最后一次、设备不支持（setter 抛错）时不抛；
// 等界面转过去是读 Device.screen 的宽高（转到了就返回，到点没转到返回 false，读不出来当竖的）。
// 方向到底转没转（2026-10-22 真机实测：强制 ["landscape"] 能转，屏幕 440 × 956 → 956 × 440；光放开 ["all"] 没转成，原因没查清）
// 要看真机，这里测不了。

import {
  enterLandscape,
  exitLandscape,
  isLandscapeNow,
  restoreOrientation,
  waitForLandscape,
} from "../JavBus/kit/orientation";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

const PORTRAIT = { width: 440, height: 956, scale: 3 };
const LANDSCAPE = { width: 956, height: 440, scale: 3 };

const device: {
  supportedInterfaceOrientations: string[];
  userConfiguredInterfaceOrientations: string[];
  screen: { width: number; height: number; scale: number };
} = {
  supportedInterfaceOrientations: ["portrait"],
  userConfiguredInterfaceOrientations: ["portrait"],
  screen: PORTRAIT,
};
(globalThis as any).Device = device;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  console.log("进入 / 退出横屏");
  {
    enterLandscape();
    check("进入：只留横屏", same(device.supportedInterfaceOrientations, ["landscape"]));

    exitLandscape(30);
    check("退出：马上只许竖屏（把界面转回来）", same(device.supportedInterfaceOrientations, ["portrait"]));

    device.userConfiguredInterfaceOrientations = ["portrait", "landscapeLeft"];
    device.supportedInterfaceOrientations = ["landscape"]; // 假设这时界面还横着
    await sleep(80);
    check("等界面转完以后还原成用户自己配的方向", same(device.supportedInterfaceOrientations, ["portrait", "landscapeLeft"]));
    device.userConfiguredInterfaceOrientations = ["portrait"];
    device.supportedInterfaceOrientations = ["portrait"];
  }

  console.log("等待期里的变化");
  {
    exitLandscape(40);
    enterLandscape();
    await sleep(90);
    check("退出的等待期里又进入：取消那次还原，仍然是横屏", same(device.supportedInterfaceOrientations, ["landscape"]));

    exitLandscape(40);
    restoreOrientation();
    check("立刻还原：马上是用户配置", same(device.supportedInterfaceOrientations, ["portrait"]));
    device.supportedInterfaceOrientations = ["landscape"]; // 假设之后又进了横屏
    await sleep(90);
    check("立刻还原会取消还没到点的那次还原（不会把后来的横屏冲掉）", same(device.supportedInterfaceOrientations, ["landscape"]));

    device.supportedInterfaceOrientations = ["portrait"];
    exitLandscape(40);
    exitLandscape(40);
    device.supportedInterfaceOrientations = ["landscape"];
    await sleep(90);
    check("连着退出两次：最后落在用户配置上", same(device.supportedInterfaceOrientations, ["portrait"]));
    device.supportedInterfaceOrientations = ["portrait"];
  }

  console.log("等界面转过去");
  {
    device.screen = PORTRAIT;
    check("竖着：isLandscapeNow 是 false", isLandscapeNow() === false);
    device.screen = LANDSCAPE;
    check("横着：isLandscapeNow 是 true", isLandscapeNow() === true);
    check("已经是想要的方向：马上返回 true", (await waitForLandscape(true, 200, 10)) === true);

    device.screen = PORTRAIT;
    setTimeout(() => {
      device.screen = LANDSCAPE;
    }, 60);
    const started = Date.now();
    check("等的过程中转过去了：返回 true", (await waitForLandscape(true, 1000, 10)) === true);
    check("转到就返回，不等满超时", Date.now() - started < 600);

    device.screen = PORTRAIT;
    check("到点还没转过去：返回 false", (await waitForLandscape(true, 80, 10)) === false);

    device.screen = LANDSCAPE;
    setTimeout(() => {
      device.screen = PORTRAIT;
    }, 40);
    check("等转回竖屏：返回 true", (await waitForLandscape(false, 1000, 10)) === true);

    // 读到的是「当场的值」：转完以后再读就是新的，不是第一次读到的旧值（真机上页面渲染时读到的就是旧值，所以得在定时器里读）
    device.screen = PORTRAIT;
    const before = isLandscapeNow();
    device.screen = LANDSCAPE;
    check("每次都当场读 Device.screen：转前转后读到的不同", before === false && isLandscapeNow() === true);

    const keep = device.screen;
    Object.defineProperty(device, "screen", {
      configurable: true,
      get: () => {
        throw new Error("读不出");
      },
    });
    check("读不出屏幕大小：当竖的，不抛", isLandscapeNow() === false);
    check("读不出屏幕大小：等横屏到点返回 false，不抛", (await waitForLandscape(true, 40, 10)) === false);
    Object.defineProperty(device, "screen", { configurable: true, writable: true, value: keep });
  }

  console.log("设备不支持");
  {
    Object.defineProperty(device, "supportedInterfaceOrientations", {
      configurable: true,
      get: () => ["portrait"],
      set: () => {
        throw new Error("iPad 不支持");
      },
    });
    let threw = false;
    try {
      enterLandscape();
      exitLandscape(10);
      restoreOrientation();
      await sleep(40);
    } catch {
      threw = true;
    }
    check("setter 抛错时进入、退出、还原都不抛", !threw);
  }

  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

void main();
