// 自定义应用列表的长按菜单：放哪几项、什么顺序。
//
// 上面一节是菜单里已有的，顺序就是长按时从上到下的顺序；下面一节是还能加的。
// 两节用同一个行样式画，只有右边的标记不一样（序号 / 加号），免得同一页看着像两个页面。
// 每行只有一个可点的东西（上面是 Menu，下面是 Button）——列表里一行塞两个按钮，
// 真机上点哪儿都说不准。

import { Button, HStack, Image, List, Menu, Section, Spacer, Text, VStack, useState, type VirtualNode } from "scripting";
import {
  DEFAULT_ROW_ACTIONS,
  ROW_ACTIONS,
  findRowAction,
  moveRowAction,
  saveRowActions,
  toggleRowAction,
  type RowAction,
  type RowActionId,
} from "../kit/rowActions";

/**
 * 一行。图标列定宽。
 *
 * 不定宽的话每行文字起点都不一样：SF Symbol 的原始宽度差很多，
 * 真机截图里「复制证书名」那一行就比别的往右缩了一截。
 */
function ActionRow({ action, trailing }: { action: RowAction; trailing: VirtualNode }) {
  return (
    <HStack spacing={12}>
      <Image
        systemName={action.systemImage}
        foregroundStyle={action.destructive ? "systemRed" : "systemBlue"}
        frame={{ width: 26 }}
      />
      <VStack alignment="leading" spacing={2}>
        <Text foregroundStyle="label" lineLimit={1}>
          {action.label}
        </Text>
        <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={1}>
          {action.hint}
        </Text>
      </VStack>
      <Spacer />
      {trailing}
    </HStack>
  );
}

export function RowActionsPage({ value, onChanged }: { value: RowActionId[]; onChanged: (ids: RowActionId[]) => void }) {
  const [ids, setIds] = useState<RowActionId[]>(value);

  function apply(next: RowActionId[]) {
    setIds(next);
    saveRowActions(next);
    onChanged(next);
  }

  const chosen = ids.map((id) => findRowAction(id)).filter((action): action is RowAction => action !== undefined);
  const rest = ROW_ACTIONS.filter((action) => !ids.includes(action.id));
  const isDefault = ids.length === DEFAULT_ROW_ACTIONS.length && ids.every((id, index) => id === DEFAULT_ROW_ACTIONS[index]);

  return (
    <List navigationTitle="长按菜单" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section
        header={<Text>{`菜单里的（${chosen.length}）`}</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            右边的序号就是长按时从上到下的次序，第 1 项离手指最近。点一行可以调次序或移除。
          </Text>
        }
      >
        {chosen.length === 0 ? (
          <Text foregroundStyle="tertiaryLabel">一项都没有，长按会弹个空菜单。从下面加几项。</Text>
        ) : (
          chosen.map((action, index) => (
            <Menu
              key={action.id}
              label={
                <ActionRow
                  action={action}
                  trailing={
                    <HStack spacing={6}>
                      <Text font="footnote" fontDesign="monospaced" foregroundStyle="secondaryLabel">
                        {String(index + 1)}
                      </Text>
                      <Image systemName="ellipsis.circle" foregroundStyle="tertiaryLabel" />
                    </HStack>
                  }
                />
              }
            >
              <Button
                title="上移"
                systemImage="arrow.up"
                disabled={index === 0}
                action={() => apply(moveRowAction(ids, action.id, -1))}
              />
              <Button
                title="下移"
                systemImage="arrow.down"
                disabled={index === chosen.length - 1}
                action={() => apply(moveRowAction(ids, action.id, 1))}
              />
              <Button
                title="从菜单移除"
                systemImage="minus.circle"
                role="destructive"
                action={() => apply(toggleRowAction(ids, action.id, false))}
              />
            </Menu>
          ))
        )}
      </Section>

      {rest.length > 0 ? (
        <Section header={<Text>还能加</Text>} footer={<Text foregroundStyle="tertiaryLabel">点一下加到菜单末尾。</Text>}>
          {rest.map((action) => (
            <Button key={action.id} action={() => apply(toggleRowAction(ids, action.id, true))}>
              <ActionRow action={action} trailing={<Image systemName="plus.circle" foregroundStyle="tertiaryLabel" />} />
            </Button>
          ))}
        </Section>
      ) : null}

      <Section
        footer={
          <Text foregroundStyle="tertiaryLabel">
            左滑卸载不受这里影响，一直都在。「在 App Store 打开」和「分享链接」要先按 bundle ID 查一次链接，查不到会提示。
          </Text>
        }
      >
        <Button
          title="恢复默认"
          systemImage="arrow.uturn.backward"
          disabled={isDefault}
          action={() => apply([...DEFAULT_ROW_ACTIONS])}
        />
      </Section>
    </List>
  );
}
