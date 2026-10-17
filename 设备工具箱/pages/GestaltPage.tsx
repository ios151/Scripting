// 底层查询：MobileGestalt 按键名读设备属性，外加开发者磁盘镜像状态。
//
// 沙盒 App 读不到这些，只有走开发者通道才有。界面上只读，不写任何东西。

import {
  Button,
  HStack,
  List,
  NavigationLink,
  ProgressView,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useState,
} from "scripting";
import { describeError } from "../core/debug";
import { deviceHub } from "../kit/hub";
import { readImageStatus, type ImageStatus } from "../kit/imageMounter";
import {
  GESTALT_PRESETS,
  SENSITIVE_GESTALT_KEYS,
  isGestaltKey,
  readMobileGestalt,
  type GestaltGroup,
} from "../kit/services";
import { RawListPage } from "./RawListPage";
import { TaskStateSection, ValueRow, useDeviceTask } from "./common";

/** 自己加的键存在这儿，下次进来还在。 */
const CUSTOM_KEYS_KEY = "gestaltCustomKeys";
const CUSTOM_LIMIT = 40;

function loadCustomKeys(): string[] {
  const saved = Storage.get<string[]>(CUSTOM_KEYS_KEY);
  return Array.isArray(saved) ? saved.filter((key) => typeof key === "string" && isGestaltKey(key)) : [];
}

function ImageSection({ status }: { status: ImageStatus }) {
  return (
    <Section
      header={<Text>开发者磁盘镜像</Text>}
      footer={
        <Text foregroundStyle="tertiaryLabel">
          镜像挂上之后，设备才会开放调试类的服务。iOS 17 起用的是个性化镜像（Personalized），
          一般在 Xcode 连接设备或打开开发者模式后由系统挂载。这一页只查，不做挂载。
        </Text>
      }
    >
      <HStack>
        <Text>镜像</Text>
        <Spacer />
        <Text foregroundStyle={status.mounted ? "systemGreen" : "secondaryLabel"}>
          {status.mounted ? `已挂载（${status.mounted}）` : "未挂载"}
        </Text>
      </HStack>
      {status.signatureBytes !== null ? (
        <ValueRow label="签名长度" value={`${status.signatureBytes} 字节`} />
      ) : null}
      <HStack>
        <Text>开发者模式</Text>
        <Spacer />
        <Text foregroundStyle={status.developerMode === true ? "systemGreen" : status.developerMode === false ? "systemOrange" : "secondaryLabel"}>
          {status.developerMode === true ? "已开启" : status.developerMode === false ? "未开启" : "查不到（老系统没有这个开关）"}
        </Text>
      </HStack>
    </Section>
  );
}

export function GestaltPage() {
  const [values, setValues] = useState<Map<string, string>>(new Map());
  const [customKeys, setCustomKeys] = useState<string[]>(() => loadCustomKeys());
  const [input, setInput] = useState("");
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const groups: GestaltGroup[] = [
    ...GESTALT_PRESETS,
    ...(customKeys.length > 0 ? [{ title: "自己加的键", keys: customKeys }] : []),
  ];
  const allKeys = groups.flatMap((group) => group.keys);

  const task = useDeviceTask(async (session) => {
    setValues(await readMobileGestalt(session, allKeys));
    return true;
  });

  async function query(keys: string[]) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const found = await readMobileGestalt(await deviceHub.get(), keys);
      // 并进去，不覆盖之前查到的
      setValues((current) => new Map([...current, ...found]));
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  function addKey() {
    const key = input.trim();
    if (!isGestaltKey(key)) {
      setError("键名只能是字母开头的字母、数字、下划线或连字符。");
      return;
    }
    if (customKeys.includes(key) || allKeys.includes(key)) {
      setError(`「${key}」已经在列表里了。`);
      setInput("");
      return;
    }
    const next = [...customKeys, key].slice(-CUSTOM_LIMIT);
    setCustomKeys(next);
    Storage.set(CUSTOM_KEYS_KEY, next);
    setInput("");
    void query([key]);
  }

  function removeKey(key: string) {
    const next = customKeys.filter((item) => item !== key);
    setCustomKeys(next);
    Storage.set(CUSTOM_KEYS_KEY, next);
  }

  const rows: [string, string][] = allKeys
    .filter((key) => values.has(key))
    .map((key) => [key, values.get(key)!]);

  return (
    <List
      navigationTitle="底层查询"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      refreshable={task.reload}
      toolbar={{
        topBarTrailing: (
          <Button
            title={reveal ? "隐藏标识" : "显示标识"}
            systemImage={reveal ? "eye.slash" : "eye"}
            action={() => setReveal(!reveal)}
          />
        ),
      }}
    >
      <TaskStateSection task={task} />

      {task.data ? (
        <Section
          header={<Text>MobileGestalt</Text>}
          footer={
            <Text foregroundStyle={error ? "systemRed" : "tertiaryLabel"}>
              {error ||
                copied ||
                `这是系统内部的设备属性库，沙盒 App 读不到。已拿到 ${rows.length} 个键；设备不认识的键不会出现。点一行复制它的值。`}
            </Text>
          }
        >
          <HStack>
            <Text>已查到</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`${rows.length} / ${allKeys.length}`}</Text>
          </HStack>
          {rows.length > 0 ? (
            <NavigationLink destination={<RawListPage title="MobileGestalt" rows={rows} />}>
              <Text>全部结果（可搜索）</Text>
            </NavigationLink>
          ) : null}
        </Section>
      ) : null}

      {task.data
        ? groups.map((group) => (
            <Section key={group.title} header={<Text>{group.title}</Text>}>
              {group.keys.map((key) => {
                const value = values.get(key);
                const custom = customKeys.includes(key);
                return value === undefined ? (
                  <HStack key={key}>
                    <Text foregroundStyle="secondaryLabel" lineLimit={1}>{key}</Text>
                    <Spacer />
                    <Text font="caption" foregroundStyle="tertiaryLabel">设备没给</Text>
                    {custom ? (
                      <Button title="" systemImage="minus.circle" buttonStyle="borderless" role="destructive" action={() => removeKey(key)} />
                    ) : null}
                  </HStack>
                ) : custom ? (
                  <HStack key={key}>
                    <VStack alignment="leading" spacing={2}>
                      <Text font="caption" foregroundStyle="secondaryLabel">{key}</Text>
                      <Text font="footnote" fontDesign="monospaced" lineLimit={3}>{value}</Text>
                    </VStack>
                    <Spacer />
                    <Button title="" systemImage="minus.circle" buttonStyle="borderless" role="destructive" action={() => removeKey(key)} />
                  </HStack>
                ) : (
                  <ValueRow
                    key={key}
                    label={key}
                    value={value}
                    masked={SENSITIVE_GESTALT_KEYS.has(key) && !reveal}
                    onCopied={(label) => setCopied(`✓ 已复制「${label}」`)}
                  />
                );
              })}
            </Section>
          ))
        : null}

      {task.data ? (
        <Section
          header={<Text>查别的键</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              输入键名直接查，比如 ProductType。加进来的键会记住，下次进这一页一起查。
            </Text>
          }
        >
          <TextField
            title=""
            value={input}
            prompt="键名，如 DeviceSupportsSiri"
            textInputAutocapitalization="never"
            onChanged={setInput}
            onSubmit={addKey}
          />
          {busy ? (
            <HStack spacing={10}>
              <ProgressView />
              <Text foregroundStyle="secondaryLabel">查询中…</Text>
            </HStack>
          ) : (
            <Button title="查询并加入列表" systemImage="plus.magnifyingglass" disabled={!input.trim()} action={addKey} />
          )}
        </Section>
      ) : null}

      {task.data ? <ImageStatusSection /> : null}
    </List>
  );
}

/** 镜像状态单独取一次，失败不影响上面的查询。 */
function ImageStatusSection() {
  const task = useDeviceTask((session) => readImageStatus(session));
  if (task.error) {
    return (
      <Section header={<Text>开发者磁盘镜像</Text>}>
        <Text foregroundStyle="secondaryLabel">{`查不到：${task.error}`}</Text>
      </Section>
    );
  }
  if (!task.data) {
    return (
      <Section header={<Text>开发者磁盘镜像</Text>}>
        <HStack spacing={10}>
          <ProgressView />
          <Text foregroundStyle="secondaryLabel">查询中…</Text>
        </HStack>
      </Section>
    );
  }
  return <ImageSection status={task.data} />;
}
