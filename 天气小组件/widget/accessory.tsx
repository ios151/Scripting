// 锁屏 / 待机的三种小组件。系统只给单色（图标和字都会被统一染色），所以这里不靠颜色说话，
// 只放图标和字，也不指定前景色。圆形放图标 + 气温，矩形放地名、气温和天气、最高最低，单行放一句话。
//
// 对应 RoamControl 的天气角标（一朵云加当前气温）：锁屏上的圆形就是那个角标。
// 点一下打开本脚本（widgetURL）；不写的话，点锁屏小组件只会打开 Scripting 的首页。
// 有预警时：单行换成预警短名、矩形的第三行换成预警（前面是按预警类型挑的图案）、圆形里的天气图标换成三角（通用的警告符号，
// 圆形里没有地方写字，用类型图案的话会和「现在在下雨」那种天气图标混在一起）。
// 锁屏是单色，预警的级别颜色画不出来，靠文字（「大风蓝色预警」）说。

import { AccessoryWidgetBackground, HStack, Image, Label, Spacer, Text, VStack, ZStack } from "scripting";
import type { Content } from "../core/present";

export function AccessoryView({
  family,
  content,
  tapURL,
}: {
  family: "circular" | "rectangular" | "inline";
  content: Content;
  tapURL: string | undefined;
}) {
  if (content.kind === "empty") {
    if (family === "inline") {
      return (
        <Text lineLimit={1} widgetURL={tapURL}>
          {content.title}
        </Text>
      );
    }
    if (family === "circular") {
      return (
        <ZStack widgetURL={tapURL}>
          <AccessoryWidgetBackground />
          <Image systemName={content.symbol} font="title3" />
        </ZStack>
      );
    }
    return (
      <VStack alignment="leading" spacing={1} widgetURL={tapURL}>
        <Text font="headline" lineLimit={1} minScaleFactor={0.7}>
          {content.title}
        </Text>
        <Text font="caption2" lineLimit={1} minScaleFactor={0.7}>
          {content.lines[0] ?? ""}
        </Text>
      </VStack>
    );
  }

  const alert = content.alert;
  const warning = "exclamationmark.triangle.fill";

  if (family === "inline") {
    return (
      <Label
        title={alert !== null ? alert.text : content.inline}
        systemImage={alert !== null ? alert.symbol : content.condition.symbol}
        widgetURL={tapURL}
      />
    );
  }

  if (family === "rectangular") {
    return (
      <HStack spacing={8} widgetURL={tapURL}>
        <Image systemName={content.condition.symbol} font="title2" />
        <VStack alignment="leading" spacing={1}>
          <Text font="caption" fontWeight="semibold" lineLimit={1} minScaleFactor={0.7}>
            {content.place}
          </Text>
          <Text font="title3" fontWeight="medium" monospacedDigit lineLimit={1} minScaleFactor={0.6}>
            {content.temperature + " " + content.condition.text}
          </Text>
          {alert !== null ? (
            <HStack spacing={3}>
              <Image systemName={alert.symbol} font="caption2" />
              <Text font="caption2" fontWeight="semibold" lineLimit={1} minScaleFactor={0.7}>
                {alert.text}
              </Text>
            </HStack>
          ) : (
            <Text font="caption2" lineLimit={1} minScaleFactor={0.7}>
              {content.range}
            </Text>
          )}
        </VStack>
        <Spacer />
      </HStack>
    );
  }

  return (
    <ZStack widgetURL={tapURL}>
      <AccessoryWidgetBackground />
      <VStack spacing={1}>
        <Image systemName={alert !== null ? warning : content.condition.symbol} font="headline" />
        <Text font="caption" fontWeight="semibold" monospacedDigit lineLimit={1} minScaleFactor={0.6}>
          {content.temperature}
        </Text>
      </VStack>
    </ZStack>
  );
}
