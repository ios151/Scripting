// 详情页主按钮的阶段：收藏 ⇄ 取消收藏、归档 → 已归档、删除 → 已删除。纯逻辑，页面只负责把阶段画出来、把动作落到库上。

import type { MovieStatus } from "./library";
import type { DetailContext } from "./types";

/**
 * 主按钮是一个逐步切换的状态机，和原版一样：进页面时按入口和库里的状态定初始阶段，之后每点一下按固定规则往下走，
 * 不再按库状态重算——重算的话，从推荐页点「收藏」后按钮会变成「归档」，看不出已经收藏了。
 */
export type Phase = "add" | "cancel" | "archive" | "delete" | "archived" | "deleted";

/**
 * 初始阶段。原版只有「收藏」入口（收藏 Tab）会给「归档」，归档 Tab 给「删除」，其余入口都是收藏 ⇄ 取消收藏。
 * 推荐页原版在已收藏时给「归档」，这里并入「其余入口」：同一部片从哪进来，按钮都先告诉你它收没收藏。
 */
export function initialPhase(context: DetailContext, status: MovieStatus): Phase {
  if (context === "archive") return status === "archived" ? "delete" : "deleted";
  if (status === "archived") return "archived";
  if (status === "favorite") return context === "favorites" ? "archive" : "cancel";
  return "add";
}

/** 点一下之后的阶段。已归档、已删除是终点（按钮置灰）。 */
export function nextPhase(phase: Phase): Phase {
  switch (phase) {
    case "add":
      return "cancel";
    case "cancel":
      return "add";
    case "archive":
      return "archived";
    case "delete":
      return "deleted";
    default:
      return phase;
  }
}
