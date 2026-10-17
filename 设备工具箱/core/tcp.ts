// node:net 的 TCP 客户端包装成 ByteStream。
//
// 只用于连接设备的 RemotePairing 端口（隧道外、经回环反射地址）。
// 隧道内的连接由 VPN.localDevVPN 提供，不走这里。

import { createConnection, type Socket } from "node:net";
import type { ByteStream } from "./stream";

export function wrapSocket(socket: Socket): ByteStream {
  const queue: Uint8Array[] = [];
  const waiters: {resolve: (chunk: Uint8Array | null) => void; reject: (error: Error) => void}[] = [];
  let queuedBytes = 0;
  let closed = false;
  let failure: Error | null = null;

  function push(chunk: Uint8Array) {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(chunk);
    else {
      if (queuedBytes + chunk.length > 4 * 1024 * 1024) {
        finish(new Error("配对连接缓冲已超限")); socket.destroy(); return;
      }
      queue.push(chunk); queuedBytes += chunk.length;
    }
  }

  // 出错时要让挂起的 read() 抛出，而不是返回 null——返回 null 会被调用方
  // 当成正常 EOF，真正的错误就被吞掉了。
  function finish(error?: Error) {
    if (error && !failure) failure = error;
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (failure) waiter.reject(failure); else waiter.resolve(null);
    }
  }

  socket.on("data", (data: Buffer) => {
    // 必须拷贝而不是开视图：Node 的 Buffer 取自共享内存池，底层随时可能被
    // 回收复用，数据在队列里排队期间就可能被改掉。
    push(new Uint8Array(data));
  });
  socket.on("error", (error: Error) => finish(error));
  socket.on("close", () => finish());
  socket.on("end", () => finish());

  return {
    read(): Promise<Uint8Array | null> {
      const chunk = queue.shift();
      if (chunk) { queuedBytes -= chunk.length; return Promise.resolve(chunk); }
      if (closed) return failure ? Promise.reject(failure) : Promise.resolve(null);
      return new Promise((resolve, reject) => waiters.push({resolve, reject}));
    },
    write(data: Uint8Array): Promise<void> {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(failure ?? new Error("连接已关闭"));
          return;
        }
        socket.write(data, (error?: Error | null) => (error ? reject(error) : resolve()));
      });
    },
    close(): Promise<void> {
      socket.destroy();
      finish();
      return Promise.resolve();
    },
  };
}

export function connectTCP(host: string, port: number, timeoutMs = 5000): Promise<ByteStream> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, noDelay: true });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);

    socket.on("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(wrapSocket(socket));
    });

    socket.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

/** 只测连通性，连上立刻断开。用于扫描设备的配对端口。 */
export interface ProbeResult {
  open: boolean;
  /** 失败时的错误码；超时记作 `ETIMEDOUT`。成功为 null。 */
  code: string | null;
}

/**
 * 探一个端口，**并带回失败原因**。
 *
 * 失败的几种原因意义完全不同，不能都算作「不通」：
 *
 * - `ECONNREFUSED` —— 流量到了本机、对面回了 RST，只是那个端口上没有服务。
 *   代理模式下这说明回环**是生效的**，该去查配对服务。
 * - `ETIMEDOUT`（我们自己的计时器）—— 石沉大海。代理模式下这反而说明
 *   **回环没生效**，包根本没被反射回来，该去查代理工具。
 * - `ENETUNREACH` / `EHOSTUNREACH` —— 连路由都没有，多半是飞行模式或断网。
 *
 * 诊断页以前一律显示「无响应」，把这三种混成一句，排查时等于没说。
 */
export function probeTCPDetail(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    function settle(result: ProbeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }

    const timer = setTimeout(() => settle({ open: false, code: "ETIMEDOUT" }), timeoutMs);
    socket.on("connect", () => settle({ open: true, code: null }));
    socket.on("error", (error: unknown) => {
      settle({ open: false, code: (error as { code?: string } | null)?.code ?? "UNKNOWN" });
    });
  });
}

/** 只关心开没开。端口扫描成百上千次地调它，不需要原因。 */
export function probeTCP(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return probeTCPDetail(host, port, timeoutMs).then((result) => result.open);
}
