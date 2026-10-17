// 设备信息：型号、系统、存储、各类标识，一屏看完。

import { Button, List, NavigationLink, Section, Text, useState } from "scripting";
import { readDeviceInfo } from "../kit/services";
import { RawListPage } from "./RawListPage";
import { TaskStateSection, ValueRow, useDeviceTask } from "./common";

export function InfoPage() {
  const task = useDeviceTask((session) => readDeviceInfo(session));
  /** 序列号、UDID、IMEI 默认打码：这一页最常被截图发出去。 */
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState("");
  const info = task.data;

  return (
    <List
      navigationTitle="设备信息"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      toolbar={{
        topBarTrailing: (
          <Button
            title={reveal ? "隐藏标识" : "显示标识"}
            systemImage={reveal ? "eye.slash" : "eye"}
            action={() => setReveal(!reveal)}
          />
        ),
      }}
      refreshable={task.reload}
    >
      <TaskStateSection task={task} />

      {info && info.warnings.length > 0 ? (
        <Section>
          {info.warnings.map((warning) => (
            <Text key={warning} font="footnote" foregroundStyle="systemOrange">
              {warning}
            </Text>
          ))}
        </Section>
      ) : null}

      {info?.sections.map((section) => (
        <Section
          key={section.title}
          header={<Text>{section.title}</Text>}
          footer={
            section.title === "标识" ? (
              <Text foregroundStyle="tertiaryLabel">
                {copied ? `✓ 已复制「${copied}」` : "默认打码，右上角可以显示。点一行复制它的值。"}
              </Text>
            ) : undefined
          }
        >
          {section.items.map((item) => (
            <ValueRow
              key={item.label}
              label={item.label}
              value={item.value}
              masked={item.sensitive === true && !reveal}
              onCopied={setCopied}
            />
          ))}
        </Section>
      ))}

      {info ? (
        <Section>
          <NavigationLink destination={<RawListPage title="全部属性" rows={info.raw} />}>
            <Text>{`全部属性（${info.raw.length} 项）`}</Text>
          </NavigationLink>
        </Section>
      ) : null}
    </List>
  );
}
