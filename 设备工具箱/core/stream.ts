// 字节流抽象。
//
// 配对握手走 node:net 的 TCP，隧道内的 RSD/DTX 走 VPN.localDevVPN 的连接，
// 两者读写语义一致，统一成一个接口，上层协议不必关心底下是哪条。

export interface ByteStream {
  /** 返回至多 max 字节；null 表示对端已关闭。 */
  read(max: number): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** 隧道连接每次读写上限 16384 字节，写入需按此切块。 */
export const MAX_CHUNK = 16384;

export class StreamClosedError extends Error {
  constructor(message = "连接已被对端关闭") {
    super(message);
  }
}

/** 带缓冲的读取器：协议层需要按长度精确取字节。 */
export class BufferedReader {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private readonly stream: ByteStream) {}

  /** 已缓冲但尚未消费的字节数。 */
  get buffered(): number {
    return this.buffer.length;
  }

  private take(count: number): Uint8Array {
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  /** 从底层多读一段进缓冲，返回是否还有数据。 */
  private async fill(): Promise<boolean> {
    const chunk = await this.stream.read(MAX_CHUNK);
    if (!chunk || chunk.length === 0) return false;
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    return true;
  }

  async readExact(count: number): Promise<Uint8Array> {
    while (this.buffer.length < count) {
      if (!(await this.fill())) throw new StreamClosedError();
    }
    return this.take(count);
  }

  /** 至少读到一个字节就返回，拿不到则返回 null。 */
  async readSome(): Promise<Uint8Array | null> {
    if (this.buffer.length > 0) return this.take(this.buffer.length);
    if (!(await this.fill())) return null;
    return this.take(this.buffer.length);
  }
}

/** 按 MAX_CHUNK 切块写入。 */
export async function writeAll(stream: ByteStream, data: Uint8Array): Promise<void> {
  for (let offset = 0; offset < data.length; offset += MAX_CHUNK) {
    await stream.write(data.subarray(offset, Math.min(offset + MAX_CHUNK, data.length)));
  }
}

/** 给 Promise 套一个超时，超时后按给定文案抛错。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
