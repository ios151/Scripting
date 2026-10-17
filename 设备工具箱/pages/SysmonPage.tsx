// 实时性能：全机 CPU、内存，以及吃 CPU 最多的进程。走 DVT。
//
// 要先挂上开发者磁盘镜像，否则设备的服务表里没有 dtservicehub。
// 进页面先查一次镜像状态，没挂就直接说清楚，不让人对着空白页猜。

import {
  Button,
  Chart,
  HStack,
  LineChart,
  List,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
  type Color,
} from "scripting";
import { describeError } from "../core/debug";
import { deviceHub } from "../kit/hub";
import { isTunnelDropped } from "../kit/session";
import { readImageStatus } from "../kit/imageMounter";
import { formatBytes } from "../kit/services";
import { memoryBreakdown, monitorSystem, type MemoryBreakdown, type SystemSample } from "../kit/sysmon";
import { withKeepAlive } from "../utils/keepalive";
import { TaskStateSection, useDeviceTask } from "./common";

/** 曲线最多留这么多点。1 秒一个点，十分钟。 */
const HISTORY_LIMIT = 600;
const INTERVAL_MS = 1000;
/** 进程表只显示前几名，全列出来几百个进程没法看。 */
const TOP_PROCESSES = 12;

function cpuColor(percent: number | null): Color {
  if (percent === null) return "secondaryLabel";
  if (percent >= 80) return "systemRed";
  if (percent >= 50) return "systemOrange";
  return "systemGreen";
}

/** 内存比 CPU 容忍度低：iOS 常年八九成占用是正常的，所以阈值往上挪。 */
function memoryColor(memory: MemoryBreakdown): Color {
  const percent = (memory.used / memory.total) * 100;
  if (percent >= 95) return "systemRed";
  if (percent >= 85) return "systemOrange";
  return "systemGreen";
}

export function SysmonPage() {
  const [samples, setSamples] = useState<SystemSample[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  /** 采样循环跨很多次渲染，读 state 只会拿到开始那一刻的值。 */
  const runningRef = useRef(false);

  // 离开页面就停，别让它在后台一直占着连接、一直推数据
  useEffect(() => {
    return () => {
      runningRef.current = false;
    };
  }, []);

  const image = useDeviceTask((session) => readImageStatus(session));

  async function start() {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError("");
    try {
      // 采样一跑就是几分钟，中途切走不保活就断
      await withKeepAlive("sysmon", async () => {
        await monitorSystem(await deviceHub.get(), {
          intervalMs: INTERVAL_MS,
          shouldStop: () => !runningRef.current,
          onSample: (sample) =>
            setSamples((list) => {
              const next = [...list, sample];
              return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
            }),
        });
      });
    } catch (failure) {
      // 同事件页：锁屏、切网络会收掉隧道，不是程序出错
      setError(isTunnelDropped(failure) ? "连接断开了（锁屏、熄屏、切网络都会断）。点右上角重新开始。" : describeError(failure));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  function toggle() {
    if (runningRef.current) runningRef.current = false;
    else void start();
  }

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const memory = latest ? memoryBreakdown(latest) : null;
  const cpuMarks = samples
    .filter((sample) => sample.cpuPercent !== null)
    .map((sample) => ({ label: new Date(sample.at), value: sample.cpuPercent! }));
  const available = image.data?.mounted !== null && image.data !== null;

  return (
    <List
      navigationTitle="实时性能"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      toolbar={{
        topBarTrailing: available ? (
          <Button
            title={running ? "停止" : "开始"}
            systemImage={running ? "pause.circle.fill" : "play.circle"}
            action={toggle}
          />
        ) : undefined,
      }}
    >
      <TaskStateSection task={image} />

      {image.data && !available ? (
        <Section
          footer={
            <Text foregroundStyle="tertiaryLabel">
              实时性能走的是 Instruments 那条通道，要先挂上开发者磁盘镜像。
              一般在「设置 → 隐私与安全性 → 开发者模式」打开后，连一次 Xcode 或重启设备时由系统挂载。
            </Text>
          }
        >
          <Text foregroundStyle="systemOrange">开发者磁盘镜像没挂载，这一页用不了。</Text>
        </Section>
      ) : null}

      {available ? (
        <Section
          footer={
            <Text foregroundStyle={error ? "systemRed" : "tertiaryLabel"}>
              {error ||
                (running
                  ? `采样中，每 ${INTERVAL_MS / 1000} 秒一次，最多留 ${HISTORY_LIMIT / 60} 分钟` +
                    // 设备只给页数、不给页大小，是按总量反推的，写出来免得数字对不上时查不到原因
                    (memory ? `。内存按 ${memory.pageSize / 1024}K 页换算` : "")
                  : "点右上角开始。数据由设备推送，不落盘，离开这一页就停。")}
            </Text>
          }
        >
          <HStack>
            <Text>CPU</Text>
            <Spacer />
            <Text font="title3" fontWeight="semibold" foregroundStyle={cpuColor(latest?.cpuPercent ?? null)}>
              {latest?.cpuPercent === null || latest === null ? "—" : `${latest.cpuPercent}%`}
            </Text>
          </HStack>
          {memory ? (
            <HStack>
              <Text>内存</Text>
              <Spacer />
              <Text font="title3" fontWeight="semibold" foregroundStyle={memoryColor(memory)}>
                {`${Math.round((memory.used / memory.total) * 100)}%`}
              </Text>
            </HStack>
          ) : null}
          {memory ? (
            <HStack>
              <Text foregroundStyle="secondaryLabel">已用 / 总量</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{`${formatBytes(memory.used)} / ${formatBytes(memory.total)}`}</Text>
            </HStack>
          ) : null}
          {memory && memory.purgeable !== null ? (
            <HStack>
              <Text foregroundStyle="secondaryLabel">可清除</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{formatBytes(memory.purgeable)}</Text>
            </HStack>
          ) : null}
          {latest && latest.processes.length > 0 ? (
            <HStack>
              <Text>进程数</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{`${latest.processes.length} 个`}</Text>
            </HStack>
          ) : null}
          {running && samples.length === 0 ? (
            <HStack spacing={10}>
              <ProgressView />
              <Text foregroundStyle="secondaryLabel">等第一次采样…</Text>
            </HStack>
          ) : null}
        </Section>
      ) : null}

      {cpuMarks.length >= 2 ? (
        <Section header={<Text>CPU 曲线</Text>}>
          <Chart frame={{ height: 180 }} chartXAxis={{ gridLine: false, valueLabel: true }} chartYScale={{ from: 0, to: 100 }}>
            <LineChart marks={cpuMarks.map((mark) => ({ ...mark, foregroundStyle: "systemGreen" }))} />
          </Chart>
        </Section>
      ) : null}

      {latest && latest.processes.length > 0 ? (
        <Section
          header={<Text>{`吃 CPU 最多的 ${Math.min(TOP_PROCESSES, latest.processes.length)} 个`}</Text>}
          footer={<Text foregroundStyle="tertiaryLabel">只看，不做结束进程之类的操作。</Text>}
        >
          {latest.processes.slice(0, TOP_PROCESSES).map((process) => (
            <HStack key={process.pid}>
              <VStack alignment="leading" spacing={2}>
                <Text lineLimit={1}>{process.name}</Text>
                <Text font="caption" foregroundStyle="tertiaryLabel">{`pid ${process.pid}`}</Text>
              </VStack>
              <Spacer />
              <VStack alignment="trailing" spacing={2}>
                <Text font="subheadline" foregroundStyle={cpuColor(process.cpuPercent)}>
                  {process.cpuPercent === null ? "—" : `${process.cpuPercent}%`}
                </Text>
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {process.memoryBytes === null ? "—" : formatBytes(process.memoryBytes)}
                </Text>
              </VStack>
            </HStack>
          ))}
        </Section>
      ) : null}
    </List>
  );
}
