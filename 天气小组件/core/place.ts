// 地名：从系统的反查 / 正查结果里挑出放在标题里的城市名。纯函数，不碰系统。

import { isValidCoord } from "./geo";
import type { FixedPlace } from "./settings";

/** 挑城市名要用到的几个字段（系统的 `LocationPlacemark` 是它的超集） */
export type PlacemarkLike = {
  locality?: string;
  subAdministrativeArea?: string;
  administrativeArea?: string;
  country?: string;
  location?: { latitude: number; longitude: number };
};

const MAX_NAME = 24;

/**
 * 挑一个放在标题里的城市名：优先市，其次地区 / 自治州，再其次省。
 * 不用带国家省份前缀的长名字：「中国某某省某某土家族苗族自治州」这样的全称放在标题里太长（RoamControl 真机上踩过）。
 */
export function cityName(placemark: PlacemarkLike | undefined | null): string | null {
  if (placemark === undefined || placemark === null) return null;
  for (const candidate of [placemark.locality, placemark.subAdministrativeArea, placemark.administrativeArea, placemark.country]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

/**
 * 用户在 App 里输入城市名、系统给回一串结果：取第一个有坐标的，名字用结果里的城市名，
 * 没有就用用户自己输入的字。一个能用的都没有就是 null（「没找到这个地方」）。
 */
export function pickPlace(placemarks: readonly PlacemarkLike[] | null | undefined, typed: string): FixedPlace | null {
  const fallback = typed.trim();
  for (const placemark of placemarks ?? []) {
    const location = placemark.location;
    if (location === undefined || !isValidCoord(location)) continue;
    const name = (cityName(placemark) ?? fallback).slice(0, MAX_NAME);
    if (name === "") continue;
    return { name, latitude: location.latitude, longitude: location.longitude };
  }
  return null;
}
