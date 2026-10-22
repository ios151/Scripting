// 网络图片：走 kit/images.ts 带请求头加载，内存缓存命中时首帧直接出图。
//
// `<Image imageUrl>` 不能带 Referer，JavBus 的封面要它，所以不用系统的网络图片。

import { Image, ProgressView, ZStack, useEffect, useState, type Color, type ImageInterpolation } from "scripting";

import { loadImage, peekImage } from "../kit/images";

export interface RemoteImageProps {
  url: string;
  /** 列表缩略图传一个最长边上限（像素），解码后缩小省内存；详情大图不传。 */
  maxSide?: number;
  /** fill：铺满裁切（封面格）；fit：完整显示（大图、头像）。 */
  mode?: "fill" | "fit";
  width?: number;
  height?: number;
  radius?: number;
  background?: Color;
  /** 归档的影片把封面虚化。 */
  blurred?: boolean;
  /** 加载中和失败时都什么也不画（背景图用：不能在背景正中间转一个被放大的菊花）。 */
  quiet?: boolean;
  /** 地址换了以后，新图到之前继续显示旧图，不清成空白 / 菊花（封面从缩略图换成大图时用）。列表里不要开：复用的格子会闪出别人的图。 */
  keepPrevious?: boolean;
  /** 放大时的插值。把几十像素的小图放大成模糊背景时用 "high"。 */
  interpolation?: ImageInterpolation;
}

export function RemoteImage({
  url,
  maxSide,
  mode = "fill",
  width,
  height,
  radius = 0,
  background = "rgba(255,255,255,0.08)",
  blurred = false,
  quiet = false,
  keepPrevious = false,
  interpolation,
}: RemoteImageProps) {
  const [image, setImage] = useState<UIImage | null>(() => (url ? peekImage(url, maxSide) : null));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const hit = url ? peekImage(url, maxSide) : null;
    if (hit) {
      setImage(hit);
      return;
    }
    if (!keepPrevious || !url) setImage(null);
    if (!url) {
      setFailed(true);
      return;
    }
    void loadImage(url, maxSide).then((loaded) => {
      if (!alive) return;
      if (loaded) setImage(loaded);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [url, maxSide]);

  return (
    <ZStack
      frame={{ width, height, maxWidth: width === undefined ? "infinity" : undefined }}
      background={background}
      clipShape={{ type: "rect", cornerRadius: radius }}
    >
      {image ? (
        mode === "fill" ? (
          <Image
            image={image}
            resizable
            scaleToFill
            interpolation={interpolation}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            blur={blurred ? 4 : 0}
          />
        ) : (
          <Image
            image={image}
            resizable
            scaleToFit
            interpolation={interpolation}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            blur={blurred ? 4 : 0}
          />
        )
      ) : quiet ? null : failed ? (
        <Image systemName="photo" font={22} foregroundStyle="rgba(255,255,255,0.45)" />
      ) : (
        <ProgressView progressViewStyle="circular" />
      )}
    </ZStack>
  );
}
