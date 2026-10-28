// 快捷指令签名 —— 在手机本机给快捷指令签名：不要服务器、不要 Mac、不靠第三方
// Copyright (C) 2026 ios151
//
// 做法：自己做一张根证书，装到手机并信任，再用它签出快捷指令认的 AEA1 文件。
// 整套密码学（SHA-256 / HMAC / HKDF、P-256 ECDSA、X.509、plist、AEA1）都在 core/ 里用纯 TS 写成，
// 设备和 Node 跑同一份代码，自测见 _selftest/shortcut-signer.test.ts；
// core/ 的文件头记着每一处为什么是现在这个写法，改它之前先读。
//
// 这里只是启动的入口，两种启动方式：
//   - 平常打开：弹出首页（pages/App.tsx）；别的 App 分享文件过来走 intent.tsx
//   - 别的脚本 / AI 技能用 Script.run 调用，queryParameters 里带字符串 action：不弹界面，
//     走 kit/api.ts，结果交给 Script.exit（详见 kit/api.ts 的文件头）

import { Script } from "scripting";
import { handleApiRequest, isApiRequest } from "./kit/api";
import { runApp } from "./pages/App";

const params = Script.queryParameters;
if (isApiRequest(params)) {
  // handleApiRequest 不会抛
  void handleApiRequest(params).then((result) => Script.exit(result));
} else {
  void runApp();
}
