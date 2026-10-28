// 分享面板 / 快捷指令入口：在别的 App 里把 .shortcut 文件分享给 Scripting，选「快捷指令签名」，
// 就从这里开始跑——不是 index.tsx。
//
// 要出现在分享面板的脚本列表里，两样缺一不可（WLOC 的 intent.tsx 里有同样的说明，那边真机验证过）：
//   1. script.json 里 intentInputTypes 声明 "FileURLs"。只收文件：文字、链接、图片都不收，
//      免得用户在系统里随便分享点什么，都弹出这个脚本
//   2. 本文件存在，文件名必须是 intent.tsx，与 index.tsx 同级
//
// 文件路径在 Intent.fileURLsParameter 里。script.json 的 runInApp 为 true，所以是在 Scripting 主程序里
// 弹出完整界面，不受分享扩展内存上限的限制（文档：分享大文件时，扩展进程可能被系统因内存杀掉）。
//
// 路径要趁早读成字节再交给首页：分享结束后系统可能回收它们。读好的文件进首页就自动签，不用再点一次。
// 没收到文件（比如从快捷指令里不带输入地运行）就是一次普通启动。

import { Intent } from "scripting";
import { sourcesFromPaths } from "./kit/input";
import { runApp } from "./pages/App";

void runApp(sourcesFromPaths(Intent.fileURLsParameter ?? []));
