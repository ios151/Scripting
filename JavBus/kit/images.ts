// 带请求头的图片加载。
//
// `<Image imageUrl>` 不能带请求头，而 JavBus 的封面要 Referer（部分线路还要 cookie），
// 原版也是给每张图都配了 UA / Referer / Cookie。所以这里自己 fetch → UIImage，
// 再用一个内存 LRU 缓存：列表滚来滚去不重复下载，同一张图并发请求合并成一次，
// 同时在途的下载数封顶，免得一页 30 张封面把线路挤满。

import { MOBILE_UA, SITE_ORIGIN } from "../core/constants";
import { cookieHeader, isJavbusUrl } from "./cookies";

const MAX_ENTRIES = 240;
const MAX_CONCURRENT = 6;

const cache = new Map<string, UIImage>();
const inflight = new Map<string, Promise<UIImage | null>>();
const waiting: (() => void)[] = [];
let active = 0;

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  waiting.shift()?.();
}

/** 图片请求头：和原版一样，所有图都带 UA + javbus 的 Referer；cookie 只给 javbus 自家域名。 */
export function imageHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": MOBILE_UA,
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    Referer: `${SITE_ORIGIN}/`,
  };
  if (isJavbusUrl(url)) {
    const cookie = cookieHeader(url);
    if (cookie) headers.Cookie = cookie;
  }
  return headers;
}

/** 原始图片字节（保存到相册 / 批量下载要原图，不能经过 UIImage 重编码）。网络抖动重试一次，4xx 不重试。 */
export async function fetchImageData(url: string): Promise<Data | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: imageHeaders(url), timeout: 25 });
      if (res.ok) return await res.data();
      if (res.status >= 400 && res.status < 500) return null;
    } catch {
      /* 网络抖动，再试一次 */
    }
  }
  return null;
}

function remember(key: string, image: UIImage): void {
  cache.set(key, image);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function keyOf(url: string, maxSide?: number): string {
  return maxSide ? `${url}#${maxSide}` : url;
}

/** 内存里已经有就同步返回，组件首帧就能出图，不闪占位。 */
export function peekImage(url: string, maxSide?: number): UIImage | null {
  const key = keyOf(url, maxSide);
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key); // 刷新 LRU 顺位
  cache.set(key, hit);
  return hit;
}

/**
 * 加载图片。`maxSide` 给列表缩略图用：解码后缩到最长边不超过它，省内存；
 * 详情大图不传。
 */
export function loadImage(url: string, maxSide?: number): Promise<UIImage | null> {
  if (!url) return Promise.resolve(null);
  const key = keyOf(url, maxSide);
  const hit = peekImage(url, maxSide);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    await acquire();
    try {
      const data = await fetchImageData(url);
      if (!data) return null;
      let image = UIImage.fromData(data);
      if (!image) return null;
      const longest = Math.max(image.width, image.height);
      if (maxSide && longest > maxSide) {
        const k = maxSide / longest;
        image =
          image.preparingThumbnail({ width: Math.round(image.width * k), height: Math.round(image.height * k) }) ??
          image;
      }
      remember(key, image);
      return image;
    } catch {
      return null;
    } finally {
      release();
    }
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

export function clearImageCache(): void {
  cache.clear();
}

export function imageCacheSize(): number {
  return cache.size;
}
