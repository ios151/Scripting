// 全部原始字段。能搜，点一行复制值。

import { List, Section, Text, useState } from "scripting";
import { RawRow } from "./common";

export function RawListPage({ title, rows }: { title: string; rows: [string, string][] }) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const shown = keyword
    ? rows.filter(([label, value]) => label.toLowerCase().includes(keyword) || value.toLowerCase().includes(keyword))
    : rows;

  return (
    <List
      navigationTitle={title}
      navigationBarTitleDisplayMode="inline"
      searchable={{ value: query, onChanged: setQuery, prompt: "搜索字段" }}
    >
      <Section footer={<Text foregroundStyle="tertiaryLabel">{`共 ${shown.length} 项，点一行复制它的值。`}</Text>}>
        {shown.map(([label, value]) => (
          <RawRow key={label} label={label} value={value} />
        ))}
      </Section>
    </List>
  );
}
