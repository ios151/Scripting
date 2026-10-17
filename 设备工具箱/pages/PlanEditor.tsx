// 文件夹方案的手动调整：改名、删文件夹、把 App 挪到别的文件夹或留在原位。
// 以半屏 sheet 呈现，点「完成」把改好的方案交回去。

import { Button, DisclosureGroup, HStack, List, Menu, NavigationStack, Section, Spacer, Text, useState } from "scripting";
import { FOLDER_NAME_LIMIT, type FolderPlan, type LooseApp, type SanitizedPlan } from "../kit/homeOrganize";
import { ItemIcon, type IconMap } from "./homeShared";

export function PlanEditor({
  initial,
  apps,
  icons,
  onDone,
}: {
  initial: SanitizedPlan;
  apps: LooseApp[];
  icons: IconMap;
  onDone: (plan: SanitizedPlan) => void;
}) {
  const [plan, setPlan] = useState<SanitizedPlan>(initial);
  const [notice, setNotice] = useState("");
  const nameOf = (id: string) => apps.find((app) => app.bundleId === id)?.name ?? id;
  const appItem = (id: string) => ({ kind: "app" as const, name: nameOf(id), bundleId: id });

  function updateFolders(change: (folders: FolderPlan[]) => FolderPlan[]) {
    const folders = change(plan.folders.map((folder) => ({ ...folder, bundleIds: [...folder.bundleIds] })));
    const kept = folders.filter((folder) => folder.bundleIds.length > 0);
    const used = new Set(kept.flatMap((folder) => folder.bundleIds));
    setPlan({ ...plan, folders: kept, unassigned: apps.map((app) => app.bundleId).filter((id) => !used.has(id)) });
  }

  function moveApp(id: string, toFolder: number | null) {
    updateFolders((folders) => {
      for (const folder of folders) folder.bundleIds = folder.bundleIds.filter((item) => item !== id);
      if (toFolder !== null && folders[toFolder]) folders[toFolder].bundleIds.push(id);
      return folders;
    });
  }

  async function rename(index: number) {
    const value = await Dialog.prompt({
      title: "文件夹名",
      defaultValue: plan.folders[index].name,
      placeholder: `不超过 ${FOLDER_NAME_LIMIT} 个字`,
      selectAll: true,
    });
    if (value === null) return;
    const name = value.trim().slice(0, FOLDER_NAME_LIMIT);
    if (!name) return;
    if (plan.folders.some((folder, i) => i !== index && folder.name === name)) {
      setNotice("已经有同名的文件夹了");
      return;
    }
    updateFolders((folders) => {
      folders[index].name = name;
      return folders;
    });
    setNotice("");
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="调整方案"
        navigationBarTitleDisplayMode="inline"
        listStyle="insetGroup"
        toolbar={{ confirmationAction: <Button title="完成" action={() => onDone(plan)} /> }}
      >
        {notice ? (
          <Section>
            <Text foregroundStyle="systemRed">{notice}</Text>
          </Section>
        ) : null}

        {plan.folders.map((folder, index) => (
          <Section
            key={`folder-${index}`}
            header={
              <HStack>
                <Text>{`${folder.name}（${folder.bundleIds.length}）`}</Text>
                <Spacer />
                <Menu title="" systemImage="ellipsis.circle">
                  <Button title="改名" systemImage="pencil" action={() => void rename(index)} />
                  <Button
                    title="删掉这个文件夹"
                    systemImage="trash"
                    role="destructive"
                    action={() => updateFolders((folders) => folders.filter((_, i) => i !== index))}
                  />
                </Menu>
              </HStack>
            }
          >
            {folder.bundleIds.map((id) => (
              <HStack key={id} spacing={10}>
                <ItemIcon item={appItem(id)} icons={icons} size={28} />
                <Text lineLimit={1}>{nameOf(id)}</Text>
                <Spacer />
                <Menu title="" systemImage="arrow.right.circle">
                  {plan.folders.map((other, otherIndex) =>
                    otherIndex === index ? null : (
                      <Button key={otherIndex} title={`移到「${other.name}」`} action={() => moveApp(id, otherIndex)} />
                    ),
                  )}
                  <Button title="不放进文件夹" action={() => moveApp(id, null)} />
                </Menu>
              </HStack>
            ))}
          </Section>
        ))}

        {plan.unassigned.length > 0 ? (
          <Section footer={<Text foregroundStyle="tertiaryLabel">这些 App 留在原位不动，也可以手动放进某个文件夹。</Text>}>
            <DisclosureGroup title={`不放进文件夹（${plan.unassigned.length}）`}>
              {plan.unassigned.map((id) => (
                <HStack key={id} spacing={10}>
                  <ItemIcon item={appItem(id)} icons={icons} size={28} />
                  <Text lineLimit={1}>{nameOf(id)}</Text>
                  <Spacer />
                  <Menu title="" systemImage="plus.circle">
                    {plan.folders.map((folder, index) => (
                      <Button key={index} title={`放进「${folder.name}」`} action={() => moveApp(id, index)} />
                    ))}
                  </Menu>
                </HStack>
              ))}
            </DisclosureGroup>
          </Section>
        ) : null}
      </List>
    </NavigationStack>
  );
}
