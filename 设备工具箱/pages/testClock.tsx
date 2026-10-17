// 模拟时间的开关和提示条。只在签名相关的两页上出现。
//
// 拨过之后所有「还剩几天 / 已过期」都按拨后的时间算，所以必须一眼看得出来：
// 两页顶部都挂橙色提示条，旁边就是恢复按钮。时钟本身见 kit/testClock.ts。

import { Button, HStack, Image, Menu, Section, Spacer, Text } from "scripting";
import { clockLabel, clockOffsetDays, isClockShifted, resetClock, shiftClock } from "../kit/testClock";

/** 常用的几档：覆盖「快到期」和「已过期」两种显示。 */
const PRESETS = [1, 3, 7, 30, 90, 365];

/** 拨过时顶在页面最上面的提示条。没拨就不画。 */
export function TestClockBanner({ onChanged }: { onChanged: () => void }) {
  if (!isClockShifted()) return null;
  return (
    <Section>
      <HStack spacing={8}>
        <Image systemName="clock.badge.exclamationmark" foregroundStyle="systemOrange" />
        <Text font="footnote" foregroundStyle="systemOrange">{clockLabel()}</Text>
        <Spacer />
        <Button
          title="恢复"
          buttonStyle="borderless"
          action={() => {
            resetClock();
            onChanged();
          }}
        />
      </HStack>
    </Section>
  );
}

/** 控制那一节。放在签名检查页底部。 */
export function TestClockSection({ onChanged }: { onChanged: () => void }) {
  const offset = clockOffsetDays();
  return (
    <Section
      header={<Text>模拟时间（测试用）</Text>}
      footer={
        <Text foregroundStyle="tertiaryLabel">
          证书和描述文件的到期时间改不了，但可以把「现在」往后拨，看看快到期和已过期是什么样。
          只影响这个 App 里的判断，不碰设备，也不写进设置——重启脚本就恢复真实时间。
        </Text>
      }
    >
      <HStack>
        <Text>当前</Text>
        <Spacer />
        <Text foregroundStyle={isClockShifted() ? "systemOrange" : "secondaryLabel"}>
          {isClockShifted() ? clockLabel() : "真实时间"}
        </Text>
      </HStack>
      <Menu title="往后拨" systemImage="clock.arrow.circlepath">
        {PRESETS.map((days) => (
          <Button
            key={days}
            title={`${days} 天后${offset === days ? "（当前）" : ""}`}
            action={() => {
              shiftClock(days);
              onChanged();
            }}
          />
        ))}
      </Menu>
      {isClockShifted() ? (
        <Button
          title="恢复真实时间"
          systemImage="arrow.uturn.backward"
          action={() => {
            resetClock();
            onChanged();
          }}
        />
      ) : null}
    </Section>
  );
}
