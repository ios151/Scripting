// 离线「画一遍」自测用的假环境（只在 weather-widget-render.test.ts 里用，要比天气小组件的源码先 import）：
//   · 假的 `scripting`：每个视图（HStack、Text、Image……）只是一个带名字的字符串，不碰任何原生 API；
//   · `createElement` / `Fragment`：工作区的 tsconfig 用的是 jsx: react + createElement，运行时由 Scripting 提供，这里自己给一份，
//     把 JSX 变成 { type, props, children } 的普通对象。
// 这样 widget/*.tsx、pages/*.tsx 能在 Node 里真的跑一遍（条件分支、传参、文字内容、尺寸算得对不对），只是看不到画面。

import Module from "node:module";

/** 这个脚本里用到的视图。名字就是它的 type */
const VIEWS = [
  "AccessoryWidgetBackground", "HStack", "Image", "Label", "Spacer", "Text", "VStack", "ZStack",
  "Section", "Button", "Picker", "SecureField", "TextField", "Capsule", "Circle", "Rectangle", "RoundedRectangle",
] as const;

const fake: Record<string, string> = {};
for (const name of VIEWS) fake[name] = name;

const host = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const original = host._load;
host._load = function (this: unknown, request: string, ...rest: unknown[]): unknown {
  return request === "scripting" ? fake : original.call(this, request, ...rest);
};

const globals = globalThis as unknown as Record<string, unknown>;
globals.createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children });
globals.Fragment = "Fragment";
