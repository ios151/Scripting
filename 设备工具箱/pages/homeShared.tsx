// 主屏布局几个页面共用的：条目图标、类型名、PNG 转图片。

import { HStack, Image, RoundedRectangle, VStack, ZStack } from "scripting";
import type { HomeItem, HomeItemKind } from "../kit/services";

const KIND_SYMBOL: Record<HomeItemKind, string> = {
  app: "app",
  folder: "folder",
  widget: "square.grid.2x2",
  webclip: "safari",
  other: "questionmark.square.dashed",
};

export const KIND_LABEL: Record<HomeItemKind, string> = {
  app: "",
  folder: "文件夹",
  widget: "小组件",
  webclip: "网页",
  other: "",
};

export type IconMap = Map<string, UIImage>;

/**
 * 写回主屏布局前的提醒。用户反馈写回后单独摆放的小组件设置被抹掉了；v0.10.2 写回前补了实例 ID
 * （见 kit/homeEdit.ts 的 withWidgetIdentifiers），真机确认 Scripting 小组件的参数保住了。
 * 有的第三方小组件连 userSelectedElementIdentifier 都没有（真机日志里的 UsageWidget），补不了，
 * 那种还没验证过，所以留一句。
 */
export const WIDGET_WARNING =
  "小组件：单独摆放的小组件写入后会保留设置。个别第三方小组件如果被重置，重新编辑一下即可。";

/**
 * 备份覆盖到哪儿。真机验证（2026-10-18）：设备返回的布局只有 Dock 和主屏各页，
 * 没有负一屏——它的小组件由系统单独管，不在 getIconState 里，这条通道读不到。
 * 所以备份、恢复都不涉及它，得说清楚，别让人以为备份是完整的。
 */
export const BACKUP_SCOPE = "备份覆盖 Dock 和主屏各页。负一屏（今天视图）的小组件不在系统给的布局数据里，备份和恢复都不涉及它。";

export function toImage(png: Uint8Array): UIImage | null {
  const data = Data.fromUint8Array(png);
  return data ? UIImage.fromData(data) : null;
}

/**
 * 大图按比例缩到不超过 width × height（像素）再交给界面。壁纸预览原图一千多乘两千多，
 * 直接塞给 Image 的话，每次重绘都要按原尺寸解码、缩放，整页会卡。
 */
export function toThumbnail(png: Data, width: number, height: number): UIImage | null {
  const image = UIImage.fromData(png);
  if (!image || image.width <= 0 || image.height <= 0) return image;
  const ratio = Math.min(width / image.width, height / image.height);
  if (ratio >= 1) return image;
  const size = { width: Math.round(image.width * ratio), height: Math.round(image.height * ratio) };
  return image.preparingThumbnail(size) ?? image;
}

/**
 * 文件夹图标：照系统的样子，用第一页前 9 个 App 的图标拼成九宫格。
 * 取不到图标的格子画一个灰块占位，不让格子塌掉。
 */
function FolderIcon({ item, icons, size }: { item: HomeItem; icons: IconMap; size: number }) {
  const children = (item.pages?.[0] ?? []).slice(0, 9);
  const padding = size * 0.13;
  const gap = size * 0.05;
  const cell = (size - padding * 2 - gap * 2) / 3;
  const rows = [children.slice(0, 3), children.slice(3, 6), children.slice(6, 9)];
  return (
    <ZStack frame={{ width: size, height: size }}>
      <RoundedRectangle cornerRadius={size * 0.225} fill="tertiarySystemFill" />
      <VStack spacing={gap} frame={{ width: size - padding * 2, height: size - padding * 2, alignment: "topLeading" }}>
        {rows.map((row, rowIndex) => (
          <HStack key={rowIndex} spacing={gap}>
            {row.map((child, index) => {
              const image = child.bundleId ? icons.get(child.bundleId) : undefined;
              return image ? (
                <Image key={index} image={image} resizable frame={{ width: cell, height: cell }} clipShape={{ type: "rect", cornerRadius: cell * 0.225 }} />
              ) : (
                <RoundedRectangle key={index} cornerRadius={cell * 0.225} fill="quaternaryLabel" frame={{ width: cell, height: cell }} />
              );
            })}
          </HStack>
        ))}
      </VStack>
    </ZStack>
  );
}

export function ItemIcon({ item, icons, size }: { item: HomeItem; icons: IconMap; size: number }) {
  if (item.kind === "folder" && (item.pages?.[0]?.length ?? 0) > 0) return <FolderIcon item={item} icons={icons} size={size} />;
  const image = item.bundleId ? icons.get(item.bundleId) : undefined;
  if (image) {
    return <Image image={image} resizable frame={{ width: size, height: size }} clipShape={{ type: "rect", cornerRadius: size * 0.225 }} />;
  }
  return (
    <Image
      systemName={KIND_SYMBOL[item.kind]}
      foregroundStyle="secondaryLabel"
      font={size * 0.55}
      frame={{ width: size, height: size }}
    />
  );
}

