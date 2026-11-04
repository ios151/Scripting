// 地名：从系统的反查 / 正查结果里挑出放在标题里的名字（城市、区县两级）。纯函数，不碰系统。

import { isValidCoord } from "./geo";
import type { FixedPlace, PlaceLevel } from "./settings";

/** 挑地名要用到的几个字段（系统的 `LocationPlacemark` 是它的超集） */
export type PlacemarkLike = {
  locality?: string;
  /** 区县：北京的「海淀区」、县级市下面的街道等，系统给的是哪一级就是哪一级 */
  subLocality?: string;
  subAdministrativeArea?: string;
  administrativeArea?: string;
  country?: string;
  location?: { latitude: number; longitude: number };
};

/** 一次反查能挑出来的两级名字；挑不到的那一级是 null */
export type PlaceParts = { city: string | null; district: string | null };

const MAX_NAME = 24;

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * 挑一个放在标题里的城市名：优先市，其次地区 / 自治州，再其次省。
 * 不用带国家省份前缀的长名字：「中国某某省某某土家族苗族自治州」这样的全称放在标题里太长（RoamControl 真机上踩过）。
 */
export function cityName(placemark: PlacemarkLike | undefined | null): string | null {
  if (placemark === undefined || placemark === null) return null;
  for (const candidate of [placemark.locality, placemark.subAdministrativeArea, placemark.administrativeArea, placemark.country]) {
    const name = clean(candidate);
    if (name !== null) return name;
  }
  return null;
}

/** 区县名：系统给的 `subLocality`，没有就是 null。不往下猜街道、道路（系统给的道路名不是行政上的街道，也不准） */
export function districtName(placemark: PlacemarkLike | undefined | null): string | null {
  return placemark === undefined || placemark === null ? null : clean(placemark.subLocality);
}

export function placeParts(placemark: PlacemarkLike | undefined | null): PlaceParts {
  return { city: cityName(placemark), district: districtName(placemark) };
}

/**
 * 标题里写的名字：写到区县时，有区县就写区县，系统没给就退回城市；写到城市时写城市，城市也没有才退到区县。
 * `district` 是 undefined 说明还没查过区县，当作没有。
 */
export function placeLabel(level: PlaceLevel, city: string | null, district: string | null | undefined): string | null {
  const finer = district ?? null;
  return level === "district" ? (finer ?? city) : (city ?? finer);
}

/**
 * 用户在 App 里输入地点、系统给回一串结果：取第一个有坐标的，名字用结果里的城市名（再带上区县名），
 * 没有城市名就用用户自己输入的字。一个能用的都没有就是 null（「没找到这个地方」）。
 */
export function pickPlace(placemarks: readonly PlacemarkLike[] | null | undefined, typed: string): FixedPlace | null {
  const fallback = typed.trim();
  for (const placemark of placemarks ?? []) {
    const location = placemark.location;
    if (location === undefined || !isValidCoord(location)) continue;
    const name = (cityName(placemark) ?? fallback).slice(0, MAX_NAME);
    if (name === "") continue;
    const found = districtName(placemark);
    const district = found === null ? null : found.slice(0, MAX_NAME);
    // 区县和城市同名（或者根本没有）就不用多记一项
    if (district === null || district === name) return { name, latitude: location.latitude, longitude: location.longitude };
    return { name, district, latitude: location.latitude, longitude: location.longitude };
  }
  return null;
}
