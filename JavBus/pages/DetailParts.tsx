// 详情页专用的部件：舞台（封面海报 / 播放器）的尺寸、白色大「播放」胶囊、收藏胶囊。
// 令牌（INK / GLASS / CARD）、背景、小胶囊等全 App 共用的在 theme.tsx。

import { Button, HStack, Image, Text, VStack, type Color } from "scripting";

import { GLASS, columnWidth } from "./theme";

/** 播放 / 收藏两个大胶囊的高度。 */
export const CAPSULE_H = 52;

const STAGE_RATIO = 100 / 67;
const STAGE_MAX_HEIGHT = 360;
export const STAGE_RADIUS = 14;

/**
 * 舞台（封面海报 / 播放器画面）的尺寸，和胶囊一样算死，海报和播放器共用，点播放时画面不跳。
 * 不用 aspectRatio + maxHeight：fill 的封面图会把自己的固有比例带进布局（scaleToFill 上报的是「盖住提案」的尺寸），
 * 缩略图是竖图时舞台会被撑到 360 高；固定 frame 才会把外溢的部分截掉。
 */
export function stageSize(): { width: number; height: number } {
  const width = Math.min(columnWidth(), Math.round(STAGE_MAX_HEIGHT * STAGE_RATIO));
  return { width, height: Math.round(width / STAGE_RATIO) };
}

/** 醒目的白色「播放」胶囊：第二行写点下去会放什么。 */
export function PlayCapsule({ subline, width, onPress }: { subline: string; width: number; onPress: () => void }) {
  return (
    <Button buttonStyle="plain" action={onPress}>
      <HStack spacing={10} frame={{ width, height: CAPSULE_H }} background={{ style: "white", shape: "capsule" }}>
        <Image systemName="play.fill" font="title3" foregroundStyle="black" />
        <VStack alignment="leading" spacing={1}>
          <Text font="headline" foregroundStyle="black">
            播放
          </Text>
          <Text font="caption" foregroundStyle="rgba(0,0,0,0.55)" lineLimit={1} minScaleFactor={0.8}>
            {subline}
          </Text>
        </VStack>
      </HStack>
    </Button>
  );
}

/** 收藏胶囊（收藏 / 取消收藏 / 归档 / 删除…）：图标 + 当前阶段的名字，半透明白底。 */
export function CollectCapsule({
  icon,
  title,
  color,
  disabled,
  width,
  onPress,
}: {
  icon: string;
  title: string;
  color: Color;
  disabled: boolean;
  width: number;
  onPress: () => void;
}) {
  return (
    <Button buttonStyle="plain" disabled={disabled} action={onPress}>
      <HStack spacing={6} frame={{ width, height: CAPSULE_H }} background={{ style: GLASS, shape: "capsule" }}>
        <Image systemName={icon} font="body" foregroundStyle={color} />
        <Text font="subheadline" fontWeight="semibold" foregroundStyle={color}>
          {title}
        </Text>
      </HStack>
    </Button>
  );
}
