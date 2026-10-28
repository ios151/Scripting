// 签名身份存在钥匙串里；证书名称、「证书我装好了」这类不敏感的状态存在 Storage 里。
//
// Scripting 的 Keychain 按脚本隔离：别的脚本读不到，脚本被删时系统连同这份数据一起回收。
// 默认可访问性是「首次解锁后、仅本设备」，不会同步到 iCloud，也不会迁到新手机——
// 换手机要重新生成、重新装证书。身份的格式和为什么根私钥不存见 core/identity.ts。

import { checkRootName, createIdentity, parseIdentity, serializeIdentity, type SigningIdentity } from "../core/identity";

const KEYCHAIN_KEY = "shortcut_signer_identity_v1";
const ROOT_NAME_KEY = "rootName";
const READY_KEY = "certificateReady";

let cached: SigningIdentity | null | undefined;

/** 用户设的根证书名称；没设返回空串（生成时用默认名）。 */
export function savedRootName(): string {
  const value = Storage.get<string>(ROOT_NAME_KEY);
  return typeof value === "string" ? value : "";
}

/** 只记下名称、不生成：还没有身份时先起好名字，第一次生成就用它。空串 = 用默认名。 */
export function saveRootName(name: string): void {
  const trimmed = name.trim();
  if (trimmed !== "") {
    const problem = checkRootName(trimmed);
    if (problem !== null) throw new Error(problem);
  }
  Storage.set(ROOT_NAME_KEY, trimmed);
}

/**
 * 用户有没有确认「证书已经装好并信任了」。
 * 脚本检测不到系统里的信任状态（没有对应的 API），只能让用户自己点一下，首页才不再催着去装。
 */
export function certificateReady(): boolean {
  return Storage.get<boolean>(READY_KEY) === true;
}

export function setCertificateReady(ready: boolean): void {
  Storage.set(READY_KEY, ready);
}

/** 读身份；没有返回 null。存的数据坏了会抛错（不缓存失败），界面据此提示重新生成。 */
export function readIdentity(): SigningIdentity | null {
  if (cached !== undefined) return cached;
  const raw = Keychain.get(KEYCHAIN_KEY);
  if (raw === null || raw === undefined || raw === "") {
    cached = null;
    return null;
  }
  try {
    cached = parseIdentity(raw);
  } catch (error) {
    // 不悄悄重新生成：那会让手机上已经信任的证书一下子作废。把恢复办法写在报错里
    throw new Error(
      `签名身份读不出来（${error instanceof Error ? error.message : String(error)}）。到「证书」页最下面点「重新生成签名身份」恢复。`,
    );
  }
  return cached;
}

/**
 * 生成一套新身份并存起来，旧的就此作废（手机上要重新装、重新信任新的根证书，所以「装好了」的确认也清掉）。
 * 不传名字就用上次存的；传了就记住，下次重新生成沿用。
 */
export function replaceIdentity(rootName?: string): SigningIdentity {
  const name = (rootName ?? savedRootName()).trim();
  const identity = createIdentity({ rootName: name });
  if (!Keychain.set(KEYCHAIN_KEY, serializeIdentity(identity))) {
    throw new Error("写不进钥匙串，没法保存签名身份");
  }
  cached = identity;
  Storage.set(ROOT_NAME_KEY, name);
  Storage.set(READY_KEY, false);
  return identity;
}

/** 有就用，没有就生成。 */
export function ensureIdentity(): SigningIdentity {
  return readIdentity() ?? replaceIdentity();
}

/** 清掉进程内缓存，下次 readIdentity 重新读钥匙串。只给离线自测用，验「读回来」和「存坏了」两条路。 */
export function resetCacheForTests(): void {
  cached = undefined;
}
