// 18+ 提示：原版 checkAdult。黑底红字的 FBI WARNING，「已满十八岁」才放行（记住，之后不再问），
// 「未满十八岁」直接退出脚本。文案逐字照原版。

import { Button, ScrollView, Script, Text, VStack, ZStack } from "scripting";

import { ADULT_WARNING, FBI_WARNING } from "../core/texts";
import { setFlag } from "../kit/settings";
import { GLASS, PageBackdrop, SIDE, columnWidth } from "./theme";

export function GatePage({ onPass }: { onPass: () => void }) {
  return (
    <ZStack preferredColorScheme="dark" environments={{ colorScheme: "dark" }}>
      <PageBackdrop tint="rgba(220,30,50,0.28)" />
      <ScrollView>
        <VStack spacing={18} padding={{ horizontal: SIDE, top: 56, bottom: 30 }}>
          <Text
            font={25}
            fontWeight="bold"
            foregroundStyle="white"
            padding={{ horizontal: 22, vertical: 6 }}
            background={{ style: "red", shape: { type: "rect", cornerRadius: 6 } }}
          >
            FBI WARNING
          </Text>
          <Text font="subheadline" fontWeight="bold" foregroundStyle="white" multilineTextAlignment="leading">
            {FBI_WARNING}
          </Text>
          <Text
            font={25}
            fontWeight="bold"
            foregroundStyle="white"
            padding={{ horizontal: 22, vertical: 6 }}
            background={{ style: "red", shape: { type: "rect", cornerRadius: 6 } }}
          >
            警告 ⚠️
          </Text>
          <Text font="subheadline" fontWeight="bold" foregroundStyle="white" multilineTextAlignment="center">
            {ADULT_WARNING}
          </Text>
          {/* 两个大胶囊：同意是白底黑字（和详情页的「播放」同一个语气），退出是半透明白底红字。宽度算死 */}
          <Button
            buttonStyle="plain"
            action={() => {
              setFlag("adult", true);
              onPass();
            }}
          >
            <Text
              font="headline"
              foregroundStyle="black"
              frame={{ width: columnWidth(), height: 52 }}
              background={{ style: "white", shape: "capsule" }}
            >
              已满十八岁
            </Text>
          </Button>
          <Button buttonStyle="plain" action={() => Script.exit()}>
            <Text
              font="headline"
              foregroundStyle="#ff6b6b"
              frame={{ width: columnWidth(), height: 52 }}
              background={{ style: GLASS, shape: "capsule" }}
            >
              未满十八岁
            </Text>
          </Button>
        </VStack>
      </ScrollView>
    </ZStack>
  );
}
