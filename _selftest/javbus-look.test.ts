// 离线自测：kit/subtitleLook.ts 字幕外观的全局状态（Storage 换成内存替身）。
//   npx -y -p tsx tsx _selftest/javbus-look.test.ts
//
// 验证：改了马上通知订阅的组件、一次性的改动（选色 / 开关 / 拖完位置）马上存、滑块一路拖停下 0.4 秒才存一次（而且存的是最后的值）、
// 改动会过一遍 normalizeSubtitleStyle（收进范围）、取消订阅以后不再通知、flush 不重复写。
// 组件怎么重绘（pages/useSubtitleLook.ts）在真机上才看得到，这里测不了。

import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from "../JavBus/core/subtitleStyle";
import { changeLook, flushLook, getLook, subscribeLook } from "../JavBus/kit/subtitleLook";

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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const store = new Map<string, unknown>();
let writes = 0;
(globalThis as any).Storage = {
  get: (key: string) => (store.has(key) ? store.get(key) : null),
  set: (key: string, value: unknown) => {
    writes++;
    store.set(key, JSON.parse(JSON.stringify(value)));
  },
};

const stored = (): SubtitleStyle | undefined => (store.get("javbus.settings") as { subtitleStyle?: SubtitleStyle } | undefined)?.subtitleStyle;

async function main(): Promise<void> {
  console.log("读 / 改");
  {
    check("没存过：是默认外观", same(getLook(), DEFAULT_SUBTITLE_STYLE));

    const seen: SubtitleStyle[] = [];
    const off = subscribeLook((look) => seen.push(look));

    changeLook({ color: "#FFE14A" });
    check("选色：订阅的马上收到、内存里是新颜色", seen.length === 1 && seen[0].color === "#FFE14A" && getLook().color === "#FFE14A");
    check("选色：马上存了一次", writes === 1 && stored()?.color === "#FFE14A");

    changeLook({ scale: 9 });
    check("改动过一遍规整：字号倍数 9 收到 2", getLook().scale === 2);
    changeLook({ scale: 1 });

    off();
    changeLook({ layers: false });
    check("取消订阅以后不再通知", seen.length === 3);
    changeLook({ layers: true });
  }

  console.log("滑块一路拖");
  {
    const before = writes;
    const seen: number[] = [];
    const off = subscribeLook((look) => seen.push(look.opacity));

    changeLook({ opacity: 0.9 }, "later");
    changeLook({ opacity: 0.8 }, "later");
    changeLook({ opacity: 0.7 }, "later");
    check("每一格都通知，让字幕马上跟着变", same(seen, [0.9, 0.8, 0.7]));
    check("但还没存（停下 0.4 秒才存）", writes === before && stored()?.opacity !== 0.7);

    await sleep(550);
    check("停下以后只存了一次，存的是最后的值", writes === before + 1 && stored()?.opacity === 0.7);

    changeLook({ backdropOpacity: 0.3 }, "later");
    flushLook();
    check("flush 马上存，不用等", writes === before + 2 && stored()?.backdropOpacity === 0.3);
    flushLook();
    await sleep(550);
    check("没有要存的时候 flush 和到点的定时器都不重复写", writes === before + 2);
    off();
  }

  console.log("一次性的改动打断还没到点的滑块存盘");
  {
    const before = writes;
    changeLook({ scale: 1.4 }, "later");
    changeLook({ x: 0.1, y: -0.2 });
    check("拖完位置马上存，连带还没存的字号一起存了", writes === before + 1 && stored()?.scale === 1.4 && stored()?.x === 0.1 && stored()?.y === -0.2);
    await sleep(550);
    check("之前那个到点的定时器被取消了，没有多写", writes === before + 1);
  }

  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

void main();
