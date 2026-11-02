// 把卡片内容铺满整个小组件，并留出内缩。小组件根视图和 App 里的预览共用，所以两边的版面是一回事。
//
// 为什么要自己撑成满尺寸、而不是只写「撑满系统给的空间」：
//   · 系统会不会另外留一圈内容边距、`widgetBackground` 是画在内容区里还是铺满整个小组件，文档都没写死；
//   · 根视图自己撑成 `Widget.displaySize` 那么大，不管哪种情况背景都能铺到边，内容离边缘多远也只看我们自己的 `inset`。
// 里层再套一个写死尺寸的 ZStack，是因为 Scripting 里各个修饰符的应用顺序没文档：
// 背景挂在外层，不管它是在 frame 之前还是之后被应用，外层的自然尺寸都已经是满尺寸。
// 内缩层用 maxWidth / maxHeight = infinity，不用写死尺寸：padding 和 frame 谁先谁后都是同一个结果。
//
// 是个普通函数，不是组件：不依赖 children 怎么传，调用处直接把内容当参数交进来。

import { VStack, ZStack, type VirtualNode } from "scripting";

export function fullFrame(width: number, height: number, inset: number, content: VirtualNode): VirtualNode {
  return (
    <ZStack frame={{ width, height }}>
      <VStack padding={inset} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}>
        {content}
      </VStack>
    </ZStack>
  );
}
