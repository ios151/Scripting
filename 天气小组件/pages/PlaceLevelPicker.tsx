// App 页「位置」里的「地名写到」：标题里写城市还是区县。
// 说明文字在「位置」那一节的 footer 里（index.tsx），这里只有选项。

import { Picker, Text } from "scripting";
import type { PlaceLevel } from "../core/settings";

export function PlaceLevelPicker({ level, onChange }: { level: PlaceLevel; onChange: (next: PlaceLevel) => void }) {
  return (
    <Picker title="地名写到" value={level} onChanged={(value: string) => onChange(value as PlaceLevel)}>
      <Text tag="city">城市</Text>
      <Text tag="district">区县</Text>
    </Picker>
  );
}
