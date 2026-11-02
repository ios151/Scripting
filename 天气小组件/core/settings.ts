// 设置，和小组件上「参数」那一栏怎么读。
//
// 存下来的东西在 App、小组件两个运行环境之间共用，读出来一律先过 parse，不信任何一个字段。

import { isValidCoord, type Coord } from "./geo";

/** 固定城市：用户在 App 页里查好的一个地点 */
export type FixedPlace = Coord & { name: string };

export type Settings = {
  /** current：跟着当前定位走；fixed：固定看一个城市 */
  mode: "current" | "fixed";
  fixed: FixedPlace | null;
};

export function defaultSettings(): Settings {
  return { mode: "current", fixed: null };
}

const MAX_NAME = 24;

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, MAX_NAME);
  return text === "" ? null : text;
}

export function parseSettings(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) return defaultSettings();
  const record = raw as Record<string, unknown>;
  const fixedRaw = record.fixed;
  let fixed: FixedPlace | null = null;
  if (isValidCoord(fixedRaw)) {
    const name = cleanName((fixedRaw as unknown as Record<string, unknown>).name);
    if (name !== null) fixed = { name, latitude: fixedRaw.latitude, longitude: fixedRaw.longitude };
  }
  // 说是固定城市、却没有可用的城市：按跟着定位走，别画一张空卡
  return { mode: record.mode === "fixed" && fixed !== null ? "fixed" : "current", fixed };
}

/** 小组件参数里写的地点 */
export type ParameterPlace = Coord & { name: string | null };

const PARAMETER = /^\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*(?:[,，]\s*([\s\S]*))?$/;

/**
 * 「纬度,经度」或「纬度,经度,名称」，逗号中英文都行，例如 `39.90,116.40,北京`。
 * 不是这个格式（包括空的）、坐标越界都返回 null，当作没填参数。
 */
export function parseParameter(text: string | null | undefined): ParameterPlace | null {
  if (typeof text !== "string") return null;
  const match = PARAMETER.exec(text);
  if (match === null) return null;
  const place = { latitude: Number(match[1]), longitude: Number(match[2]) };
  if (!isValidCoord(place)) return null;
  return { ...place, name: cleanName(match[3]) };
}
