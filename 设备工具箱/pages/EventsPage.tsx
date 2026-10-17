// 系统事件探针：勾几类事件，开着就实时往下滚。
//
// 平时这些事件只在系统各组件之间传。装个 App、锁一下屏、改个设置，
// 对应的事件会当场跳出来——摸清哪个动作触发哪些事件，就靠这一页。

import {
  Button,
  DisclosureGroup,
  HStack,
  Image,
  List,
  ProgressView,
  Section,
  Spacer,
  Text,
  Toggle,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting";
import { describeError } from "../core/debug";
import { deviceHub } from "../kit/hub";
import { hms } from "../kit/dates";
import { isTunnelDropped } from "../kit/session";
import { EVENT_GROUPS, EVENT_KINDS, watchEvents, type DeviceEvent } from "../kit/notifications";
import { withKeepAlive } from "../utils/keepalive";
import { copyWithFeedback } from "./common";

/** 最多留多少条。系统安静时半天不来一条，热闹时一下来一串。 */
const LIMIT = 300;
const SELECTED_KEY = "watchedEvents";

function loadSelected(): string[] {
  const saved = Storage.get<string[]>(SELECTED_KEY);
  const known = new Set(EVENT_KINDS.map((kind) => kind.name));
  const picked = Array.isArray(saved) ? saved.filter((name) => typeof name === "string" && known.has(name)) : [];
  // 没存过就默认全开：第一次用的人多半想先看看都有些什么
  return picked.length > 0 ? picked : EVENT_KINDS.map((kind) => kind.name);
}

export function EventsPage() {
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [selected, setSelected] = useState<string[]>(() => loadSelected());
  const [running, setRunning] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  /** 接收循环跨很多次渲染，读 state 只会拿到开始那一刻的值。 */
  const runningRef = useRef(false);

  // 离开页面就停，别让它在后台占着连接
  useEffect(() => {
    return () => {
      runningRef.current = false;
    };
  }, []);

  function toggleKind(name: string, on: boolean) {
    const next = on ? [...selected, name] : selected.filter((item) => item !== name);
    setSelected(next);
    Storage.set(SELECTED_KEY, next);
  }

  async function start() {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError("");
    try {
      // 听事件本来就要去动设备（装 App、锁屏、改设置），不保活一切走就断
      await withKeepAlive("events", async () => {
        await watchEvents(await deviceHub.get(), {
          names: selected,
          shouldStop: () => !runningRef.current,
          onReady: () => setListening(true),
          onEvent: (event) =>
            setEvents((list) => {
              const next = [event, ...list];
              return next.length > LIMIT ? next.slice(0, LIMIT) : next;
            }),
        });
      });
    } catch (failure) {
      // 锁屏、熄屏、切网络都会把隧道收掉，这不是出错——而测事件时恰恰经常要锁屏
      setError(isTunnelDropped(failure) ? "连接断开了（锁屏、熄屏、切网络都会断）。点右上角重新开始。" : describeError(failure));
    } finally {
      runningRef.current = false;
      setRunning(false);
      setListening(false);
    }
  }

  function toggle() {
    if (runningRef.current) runningRef.current = false;
    else void start();
  }

  return (
    <List
      navigationTitle="系统事件"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      toolbar={{
        topBarTrailing: (
          <Button
            title={running ? "停止" : "开始"}
            systemImage={running ? "pause.circle.fill" : "play.circle"}
            disabled={!running && selected.length === 0}
            action={toggle}
          />
        ),
      }}
    >
      <Section
        footer={
          <Text foregroundStyle={error ? "systemRed" : "tertiaryLabel"}>
            {error ||
              (running
                ? listening
                  ? "听着呢。去装个 App、锁一下屏、改个设置试试，事件会当场跳出来。"
                  : "正在订阅…"
                : "只订阅和接收，不往系统里发任何东西。离开这一页就停。")}
          </Text>
        }
      >
        <HStack>
          <Text>状态</Text>
          <Spacer />
          {running ? (
            <HStack spacing={8}>
              <ProgressView />
              <Text foregroundStyle={listening ? "systemGreen" : "secondaryLabel"}>
                {listening ? `监听 ${selected.length} 类` : "订阅中"}
              </Text>
            </HStack>
          ) : (
            <Text foregroundStyle="secondaryLabel">未开始</Text>
          )}
        </HStack>
        <HStack>
          <Text>已收到</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">{`${events.length} 条`}</Text>
        </HStack>
        {events.length > 0 ? (
          <Button
            title="清空"
            systemImage="trash"
            role="destructive"
            action={() => setEvents([])}
          />
        ) : null}
      </Section>

      <Section>
        {/*
          每个开关必须是列表里独立的一行。早先把一组包进 VStack，真机上开关全挤在
          右侧叠成一列，和左边的名字对不上——列表的行高是按「一个子节点一行」算的。
        */}
        <DisclosureGroup title={`要听哪几类（${selected.length}/${EVENT_KINDS.length}）`}>
          {EVENT_GROUPS.flatMap((group) => [
            <Text key={`group-${group}`} font="caption" foregroundStyle="secondaryLabel">
              {group}
            </Text>,
            ...EVENT_KINDS.filter((kind) => kind.group === group).map((kind) => (
              <Toggle
                key={kind.name}
                title={kind.label}
                value={selected.includes(kind.name)}
                onChanged={(on: boolean) => toggleKind(kind.name, on)}
                disabled={running}
              />
            )),
          ])}
        </DisclosureGroup>
      </Section>

      <Section
        header={<Text>事件</Text>}
        footer={
          events.length >= LIMIT ? (
            <Text foregroundStyle="tertiaryLabel">{`只留最近 ${LIMIT} 条，更早的已经丢掉。`}</Text>
          ) : undefined
        }
      >
        {events.length === 0 ? (
          <Text foregroundStyle="tertiaryLabel">
            {running ? "还没有事件。系统平时挺安静的，动一下设备试试。" : "点右上角「开始」。"}
          </Text>
        ) : (
          events.map((event, index) => (
            <Button
              key={`${event.at}-${index}`}
              action={() => copyWithFeedback(event.name)}
              contextMenu={{ menuItems: <Button title="复制事件名" systemImage="doc.on.doc" action={() => copyWithFeedback(event.name)} /> }}
            >
              <HStack spacing={10}>
                <Image systemName="bolt.horizontal.circle" foregroundStyle="systemIndigo" />
                <VStack alignment="leading" spacing={2}>
                  <Text foregroundStyle="label" lineLimit={1}>{event.label}</Text>
                  <Text font="caption2" foregroundStyle="tertiaryLabel" lineLimit={1}>{event.name}</Text>
                </VStack>
                <Spacer />
                <Text font="caption" fontDesign="monospaced" foregroundStyle="secondaryLabel">{hms(event.at)}</Text>
              </HStack>
            </Button>
          ))
        )}
      </Section>
    </List>
  );
}
