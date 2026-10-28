// 「签一份」的完整动作：签 → 自检 → 交出去。
//
// 设备上的代码没法在这台电脑上跑，所以每一份签出来的文件都先自己验一遍（和 Apple 的校验
// 同一套：HMAC 链、ECDSA、段校验和、总长），验不过的绝不交给用户导入。原生压缩出的内容
// 验不过时退回「不压缩」再来一次——这是格式允许的，只是文件大一点。

import { parseAea, verifyAea, type Compressor, type Decompressor } from "../core/aea";
import type { SigningIdentity } from "../core/identity";
import { encodePoint } from "../core/p256";
import { ShortcutError, signShortcut, type ShortcutKind } from "../core/sign";
import { nativeCompress, nativeDecompress } from "./lzfse";

export interface FlowDeps {
  compress?: Compressor;
  decompress: Decompressor;
}

const DEVICE_DEPS: FlowDeps = { compress: nativeCompress, decompress: nativeDecompress };

export type SignOutcome =
  | {
      ok: true;
      name: string | null;
      actionCount: number;
      /** 每个动作的标识，按顺序（见 PreparedShortcut.actionIds） */
      actionIds: string[];
      data: Uint8Array;
      source: ShortcutKind;
      /** 最终的文件里有没有真的压缩过的段（压不小或退回不压缩时为 false） */
      compressed: boolean;
    }
  | { ok: false; message: string };

export function signChecked(input: Uint8Array, identity: SigningIdentity, deps: FlowDeps = DEVICE_DEPS): SignOutcome {
  const publicKey = encodePoint(identity.leafPublicKey);
  // 先试压缩，再退回不压缩
  const attempts: (Compressor | undefined)[] = deps.compress ? [deps.compress, undefined] : [undefined];
  let problems: string[] = [];
  try {
    for (const compress of attempts) {
      const signed = signShortcut(input, identity, { compress, decompress: deps.decompress });
      const verdict = verifyAea(signed.data, publicKey, deps.decompress);
      if (verdict.ok) {
        return {
          ok: true,
          name: signed.name,
          actionCount: signed.actionCount,
          actionIds: signed.actionIds,
          data: signed.data,
          source: signed.source,
          compressed: parseAea(signed.data).segments.some((segment) => segment.storedSize < segment.rawSize),
        };
      }
      problems = verdict.problems;
    }
  } catch (error) {
    return { ok: false, message: error instanceof ShortcutError ? error.message : `签名失败：${(error as Error).message}` };
  }
  return { ok: false, message: `签出来的文件没通过自检，已丢弃：${problems.join("；")}` };
}
