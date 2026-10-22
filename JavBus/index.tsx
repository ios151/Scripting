// JavBus —— 你口袋中的 AV 辞典。移植自 Nicked639 的 JSBox 脚本 JavBus 9.2。
//
// 目录分工：
//   core/   纯逻辑：番号处理、页面解析、收藏库、推荐载荷。不碰 Scripting 全局，Node 里能直接自测
//   kit/    依赖 Scripting 运行时的服务：请求与 cookie、图片、预览源、磁链、下载、持久化
//   pages/  界面
//
// 入口：index.tsx（本文件）是脚本被点开 / `scripting://run/JavBus?code=番号` 启动；
// intent.tsx 是分享表单 / 快捷指令。两边共用 pages/App.tsx。

import { Script } from "scripting";

import { runApp } from "./pages/App";

const code = Script.queryParameters.code;

void runApp({ code: typeof code === "string" && code ? code : undefined });
