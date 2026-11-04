// App 页里的「显示样式」：中号、大号上画哪些数据。
//
// 改了马上存下、马上让主屏幕的小组件重画，上面的卡片预览（中号）也跟着变。
// 默认的样子是原来的；备用来源（Open-Meteo）没有这些数据，选了也按默认的样子画。
// 说明文字一句一行。

import { Button, Picker, Text } from "scripting";
import { defaultDisplay, sameDisplay, type BottomMode, type Display, type HeadlineMode, type StripMode, type TopMode } from "../core/display";
import { Fold, type FoldState } from "./Fold";

const FOOTER =
  "中号：中间那一排、右上那一行都能换\n" +
  "中号和大号：底部那一行能换\n" +
  "选「一句话」时，自动：有雨先说雨，明天气温变化大就说变化，否则用彩云的一句话\n" +
  "默认：逐小时、天气和降水概率、体感湿度风空气\n" +
  "备用来源（Open-Meteo）没有这些数据，会按默认的样子画";

export function DisplaySection({ display, onChange, fold }: { display: Display; onChange: (next: Display) => void; fold: FoldState }) {
  return (
    <Fold title="显示样式" note={sameDisplay(display, defaultDisplay()) ? "默认" : "已自定义"} fold={fold} footer={FOOTER}>
      <Picker title="中号：中间那一排" value={display.strip} onChanged={(value: string) => onChange({ ...display, strip: value as StripMode })}>
        <Text tag="hourly">逐小时</Text>
        <Text tag="daily">未来几天</Text>
      </Picker>
      <Picker title="中号：右上那一行" value={display.top} onChanged={(value: string) => onChange({ ...display, top: value as TopMode })}>
        <Text tag="condition">天气和降水概率</Text>
        <Text tag="windHumidity">风和湿度</Text>
      </Picker>
      <Picker title="中号、大号：底部那一行" value={display.bottom} onChanged={(value: string) => onChange({ ...display, bottom: value as BottomMode })}>
        <Text tag="stats">体感、湿度、风、空气</Text>
        <Text tag="headline">一句话、日落、空气</Text>
        <Text tag="none">不显示</Text>
      </Picker>
      {display.bottom === "headline" ? (
        <Picker title="一句话写什么" value={display.headline} onChanged={(value: string) => onChange({ ...display, headline: value as HeadlineMode })}>
          <Text tag="auto">自动</Text>
          <Text tag="keypoint">彩云的一句话</Text>
          <Text tag="change">明天比今天冷还是暖</Text>
        </Picker>
      ) : null}
      {sameDisplay(display, defaultDisplay()) ? null : (
        <Button action={() => onChange(defaultDisplay())}>
          <Text foregroundStyle="systemBlue">恢复默认样式</Text>
        </Button>
      )}
    </Fold>
  );
}
