// App 页里可展开 / 收起的一组：一行标题（带展开箭头），点开才看到里面的东西。
//
// 展开状态由 App 页管（按组存下来，见 core/folds.ts），这里只管画：
//   · 收着的时候里面的东西不交给系统去建（光靠 isExpanded 的话，系统照样会建出来、只是不显示）；
//   · 标题后面可以跟一句摘要，收起时也看得见（比如「位置  跟着当前定位」）。摘要紧跟在标题后面，
//     **别用 Spacer、别用 frame={{ maxWidth: "infinity" }} 把它撑满**：设备工具箱里真机试过，
//     那样写会让 DisclosureGroup 的 isExpanded 失效（展开的组也被画成收着的箭头）；
//   · 说明文字（原来在节的 footer 里）展开后放在最后，小一号灰字；一句一行写在 footer 里，用 \n 分行。

import { DisclosureGroup, HStack, Text, type VirtualNode } from "scripting";

/** 一组的展开状态，和「用户点了展开 / 收起」的回调 */
export type FoldState = { open: boolean; onToggle: (open: boolean) => void };

/** 照抄 DisclosureGroup 的 children 类型：写窄了，三元里一支返回数组就过不了 */
export type FoldChildren = (VirtualNode | boolean | undefined | null | (VirtualNode | undefined | null | boolean)[])[] | VirtualNode | null | boolean | undefined;

function FoldLabel({ title, note }: { title: string; note?: string }) {
  if (note === undefined || note === "") return <Text>{title}</Text>;
  return (
    <HStack spacing={8}>
      <Text>{title}</Text>
      <Text font={13} foregroundStyle="secondaryLabel" lineLimit={1}>
        {note}
      </Text>
    </HStack>
  );
}

export function Fold({ title, note, fold, footer, children }: { title: string; note?: string; fold: FoldState; footer?: string; children?: FoldChildren }) {
  return (
    <DisclosureGroup label={<FoldLabel title={title} note={note} />} isExpanded={fold.open} onChanged={fold.onToggle}>
      {fold.open ? (
        <>
          {children}
          {footer === undefined ? null : (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {footer}
            </Text>
          )}
        </>
      ) : null}
    </DisclosureGroup>
  );
}
