// 离线自测（Node 里跑，不碰 Scripting 的原生 API）。
//   npx -y -p tsx tsx _selftest/shortcut-signer.test.ts
//
// 「快捷指令签名」的核心全是自己写的纯 TS：SHA-256 / HMAC / HKDF、P-256 + ECDSA、DER / X.509、
// plist、AEA1。每一块都拿 node:crypto 或 Apple 官方签名的真实样本对拍，不靠「看着对」。

import {
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  X509Certificate,
} from "node:crypto";

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import {
  buildAar,
  extractAar,
  packAea,
  parseAar,
  parseAea,
  SEGMENT_SIZE,
  verifyAea,
  type Compressor,
  type Decompressor,
} from "../快捷指令签名/core/aea";
import { bigIntToBytes, bytesToBigInt, concat, equalBytes, fromHex, toBytes, toHex, utf8 } from "../快捷指令签名/core/bytes";
import { integer, oid, time } from "../快捷指令签名/core/der";
import {
  checkRootName,
  createIdentity,
  parseIdentity,
  rootFingerprint,
  serializeIdentity,
} from "../快捷指令签名/core/identity";
import {
  encodeBplist,
  encodeXmlPlist,
  isDict,
  parseBplist,
  parsePlist,
  parseXmlPlist,
  PReal,
  type PlistValue,
} from "../快捷指令签名/core/plist";
import { actionIdentifiers, checkWorkflow, KNOWN_ACTIONS } from "../快捷指令签名/core/check";
import {
  authDataFor,
  extractWorkflow,
  headPreview,
  isSignedBy,
  prepareShortcut,
  readWorkflow,
  ShortcutError,
  signShortcut,
  sniffShortcut,
} from "../快捷指令签名/core/sign";
import {
  baseName,
  CERTIFICATE_DIR_NAME,
  certificateFileName,
  filesAppUrl,
  formatSize,
  linkProblem,
  nameFromUrl,
  safeFileName,
  sharedFilePath,
  stripExtension,
} from "../快捷指令签名/core/names";
import { JUMP_SHORTCUT_NAME, JUMP_TARGETS, jumpShortcut, runShortcutUrl } from "../快捷指令签名/core/jump";
import { SAMPLE_SHORTCUT_NAME, SAMPLE_SHORTCUT_XML } from "../快捷指令签名/core/sample";
import { rootProfile } from "../快捷指令签名/core/profile";
import { hkdfSha256, hmacSha256, sha256 } from "../快捷指令签名/core/sha256";
import { commonNameOf, publicKeyFromCertificate } from "../快捷指令签名/core/x509";
import {
  API_ACTIONS,
  API_VERSION,
  handleApiRequest,
  isApiRequest,
  type ApiCheckResult,
  type ApiFailure,
  type ApiSignResult,
  type ApiStatusResult,
} from "../快捷指令签名/kit/api";
import { promptText } from "../快捷指令签名/kit/dialog";
import { signChecked } from "../快捷指令签名/kit/flow";
import { isFailure, pickFromClipboard, pickFromFiles, pickFromUrl, sourcesFromPaths } from "../快捷指令签名/kit/input";
import { looksLikeLzfse, nativeCompress, nativeDecompress } from "../快捷指令签名/kit/lzfse";
// 技能里的东西：路由和本地检查（router.ts 不 import "scripting"，Node 里能直接测）
import { runLocalCheck } from "../skills/shortcut-signer/scripts/localCheck";
import { REQUIRED_API_VERSION, route, SIGNER_SCRIPT, type SignerRunner } from "../skills/shortcut-signer/scripts/router";
import {
  certificateReady,
  ensureIdentity,
  readIdentity,
  replaceIdentity,
  resetCacheForTests,
  saveRootName,
  savedRootName,
  setCertificateReady,
} from "../快捷指令签名/kit/store";
import {
  decodeDerSignature,
  decodePoint,
  ecdsaSign,
  ecdsaVerify,
  encodeDerSignature,
  encodePoint,
  generateKeyPair,
  N,
  publicFromPrivate,
} from "../快捷指令签名/core/p256";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

const rnd = (n: number): Uint8Array => new Uint8Array(nodeRandomBytes(n));

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** P-256 公钥的 SPKI 外壳，node 才认。 */
const SPKI_PREFIX = fromHex("3059301306072a8648ce3d020106082a8648ce3d030107034200");

function nodePublicKey(point: Uint8Array) {
  return createPublicKey({ key: Buffer.from(concat(SPKI_PREFIX, point)), format: "der", type: "spki" });
}

function nodePrivateKey(d: bigint, point: Uint8Array) {
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
      d: b64url(bigIntToBytes(d, 32)),
    },
    format: "jwk",
  });
}

function testBasics(): void {
  console.log("字节工具");
  check("toHex / fromHex 往返", toHex(fromHex("00ff10ab")) === "00ff10ab");
  check("bigIntToBytes 定长大端", toHex(bigIntToBytes(0x0102n, 4)) === "00000102");
  check("bytesToBigInt", bytesToBigInt(fromHex("010203")) === 0x010203n);
  let threw = false;
  try {
    bigIntToBytes(0x1ffn, 1);
  } catch {
    threw = true;
  }
  check("放不下的数值抛错而不是截断", threw);
}

function testSha(): void {
  console.log("SHA-256 / HMAC / HKDF（对拍 node:crypto）");
  check(
    "sha256('abc') 已知答案",
    toHex(sha256(utf8("abc"))) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );

  let shaOk = true;
  for (let length = 0; length <= 200; length++) {
    const data = rnd(length);
    if (toHex(sha256(data)) !== createHash("sha256").update(data).digest("hex")) shaOk = false;
  }
  check("长度 0..200 逐个对拍（覆盖 55/56/63/64/65 等分组边界）", shaOk);

  const big = rnd(1_000_003);
  check("1 MB 随机数据", toHex(sha256(big)) === createHash("sha256").update(big).digest("hex"));

  let hmacOk = true;
  for (const keyLength of [0, 1, 32, 64, 65, 200]) {
    for (const dataLength of [0, 1, 63, 64, 65, 1000]) {
      const key = rnd(keyLength);
      const data = rnd(dataLength);
      const expected = createHmac("sha256", key).update(data).digest("hex");
      if (toHex(hmacSha256(key, data)) !== expected) hmacOk = false;
    }
  }
  check("HMAC：密钥 0/1/32/64/65/200 字节 × 数据 0..1000 字节", hmacOk);

  let hkdfOk = true;
  for (const saltChoice of ["none", "empty", "32"] as const) {
    for (const length of [1, 32, 33, 64, 100]) {
      const ikm = rnd(32);
      const info = rnd(11);
      const salt = saltChoice === "32" ? rnd(32) : new Uint8Array(0);
      const ours = hkdfSha256(ikm, saltChoice === "none" ? null : salt, info, length);
      const theirs = new Uint8Array(hkdfSync("sha256", ikm, salt, info, length));
      if (toHex(ours) !== toHex(theirs)) hkdfOk = false;
    }
  }
  check("HKDF：salt 无 / 空 / 32 字节 × 输出 1..100 字节", hkdfOk);
}

function testP256(): void {
  console.log("P-256 / ECDSA");

  // RFC 6979 附录 A.2.5（P-256 + SHA-256，消息 "sample"）：注入固定的 k，r / s 必须一模一样
  const d = 0xc9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721n;
  const pub = publicFromPrivate(d);
  check(
    "RFC 6979 公钥 X",
    pub.x === 0x60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6n,
  );
  check(
    "RFC 6979 公钥 Y",
    pub.y === 0x7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299n,
  );
  const hash = sha256(utf8("sample"));
  const fixed = ecdsaSign(d, hash, {
    k: 0xa6e3c57dd01abe90086538398355dd4c3b17aa873382b0f24d6129493d8aad60n,
  });
  check("RFC 6979 签名 r", fixed.r === 0xefd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716n);
  check("RFC 6979 签名 s", fixed.s === 0xf7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8n);
  check("已知答案能验过", ecdsaVerify(pub, hash, fixed.r, fixed.s));

  // 边界私钥：d = 1 得到基点，d = N-1 得到基点的 y 取反
  const g = publicFromPrivate(1n);
  check("d=1 → 基点 X", g.x === 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n);
  const negG = publicFromPrivate(N - 1n);
  check("d=N-1 → X 与基点相同", negG.x === g.x);

  let pubOk = true;
  for (let i = 0; i < 20; i++) {
    const key = generateKeyPair(rnd);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(bigIntToBytes(key.d, 32)));
    if (toHex(encodePoint(key)) !== ecdh.getPublicKey("hex")) pubOk = false;
  }
  check("20 个随机私钥推出的公钥与 node 的 ECDH 一致", pubOk);

  let selfOk = true;
  let nodeAcceptsOurs = true;
  let weAcceptNodes = true;
  for (let i = 0; i < 12; i++) {
    const key = generateKeyPair(rnd);
    const point = encodePoint(key);
    const message = rnd(1 + (i * 37) % 300);
    const digest = sha256(message);

    const sig = ecdsaSign(key.d, digest, { random: rnd });
    if (!ecdsaVerify(key, digest, sig.r, sig.s)) selfOk = false;

    const der = encodeDerSignature(sig.r, sig.s);
    const ok = nodeVerify("sha256", Buffer.from(message), { key: nodePublicKey(point), dsaEncoding: "der" }, Buffer.from(der));
    if (!ok) nodeAcceptsOurs = false;

    const theirs = nodeSign("sha256", Buffer.from(message), { key: nodePrivateKey(key.d, point), dsaEncoding: "der" });
    const parsed = decodeDerSignature(new Uint8Array(theirs));
    if (parsed === null || !ecdsaVerify(key, digest, parsed.r, parsed.s)) weAcceptNodes = false;
  }
  check("自己签自己验", selfOk);
  check("node 能验过我们签的（DER）", nodeAcceptsOurs);
  check("我们能验过 node 签的", weAcceptNodes);

  // 该拒绝的要拒绝
  const key = generateKeyPair(rnd);
  const digest = sha256(utf8("hello"));
  const sig = ecdsaSign(key.d, digest, { random: rnd });
  const other = generateKeyPair(rnd);
  check("改一个字节的摘要验不过", !ecdsaVerify(key, sha256(utf8("hellp")), sig.r, sig.s));
  check("换一把公钥验不过", !ecdsaVerify(other, digest, sig.r, sig.s));
  check("r = 0 / s = 0 / s = N 都拒绝", !ecdsaVerify(key, digest, 0n, sig.s) && !ecdsaVerify(key, digest, sig.r, 0n) && !ecdsaVerify(key, digest, sig.r, N));

  // 点的编码
  const encoded = encodePoint(key);
  check("65 字节且以 04 开头", encoded.length === 65 && encoded[0] === 4);
  const round = decodePoint(encoded);
  check("编码往返", round.x === key.x && round.y === key.y);
  const bad = encoded.slice();
  bad[64] ^= 1;
  let rejected = false;
  try {
    decodePoint(bad);
  } catch {
    rejected = true;
  }
  check("不在曲线上的点被拒绝", rejected);

  // DER 签名编码：最高位为 1 要补 00，前导零要去掉
  const der1 = encodeDerSignature(0x80n, 0x7fn);
  check("DER：r=0x80 补 00，s=0x7f 不补", toHex(der1) === "30070202008002017f");
  const parsed1 = decodeDerSignature(der1);
  check("DER 往返", parsed1 !== null && parsed1.r === 0x80n && parsed1.s === 0x7fn);
  check("DER 解析拒绝长度不符", decodeDerSignature(der1.subarray(0, der1.length - 1)) === null);
}

function testDer(): void {
  console.log("DER 编码");
  check("OID ecdsa-with-SHA256", toHex(oid("1.2.840.10045.4.3.2")) === "06082a8648ce3d040302");
  check("OID prime256v1", toHex(oid("1.2.840.10045.3.1.7")) === "06082a8648ce3d030107");
  check("OID commonName", toHex(oid("2.5.4.3")) === "0603550403");
  check("OID 快捷指令签名标记（1.2.840.113635.100.18.1）", toHex(oid("1.2.840.113635.100.18.1")) === "06092a864886f763641201");
  check("INTEGER 0 / 127 / 128 / 256", [0, 127, 128, 256].map((n) => toHex(integer(n))).join() === "020100,02017f,02020080,02020100");
  check("UTCTime（2049 以前）", toHex(time(new Date(Date.UTC(2026, 9, 28, 10, 0, 0)))) === "170d3236313032383130303030305a");
  check("GeneralizedTime（2050 起）", toHex(time(new Date(Date.UTC(2050, 0, 2, 3, 4, 5)))) === "180f32303530303130323033303430355a");
}

function testIdentity(): void {
  console.log("证书与签名身份（node 的 X509Certificate 当裁判）");
  const identity = createIdentity({ random: rnd });
  const root = new X509Certificate(Buffer.from(identity.rootCertificate));
  const leaf = new X509Certificate(Buffer.from(identity.leafCertificate));

  check("根证书自签验得过", root.verify(root.publicKey));
  check("叶证书是根签的", leaf.verify(root.publicKey) && leaf.checkIssued(root));
  check("叶证书不是自签的", leaf.subject !== leaf.issuer && !leaf.verify(leaf.publicKey));
  check("根是 CA、叶不是", root.ca && !leaf.ca);
  check("叶的 issuer 就是根的 subject", leaf.issuer === root.subject);
  check("根 CN 形如「Shortcut Signer Root xxxx」", /CN=Shortcut Signer Root [0-9a-f]{4}/.test(root.subject));
  check("叶 CN 是 32 位十六进制（和 Apple 一样）", /CN=[0-9a-f]{32}(\n|$)/.test(leaf.subject));
  check("叶证书带 serverAuth + clientAuth", (leaf.keyUsage ?? []).join() === "1.3.6.1.5.5.7.3.1,1.3.6.1.5.5.7.3.2");

  const jwk = leaf.publicKey.export({ format: "jwk" });
  check(
    "叶证书里的公钥就是我们生成的那把",
    jwk.x === Buffer.from(bigIntToBytes(identity.leafPublicKey.x, 32)).toString("base64url") &&
      jwk.y === Buffer.from(bigIntToBytes(identity.leafPublicKey.y, 32)).toString("base64url"),
  );

  const marker = oid("1.2.840.113635.100.18.1");
  const has = (der: Uint8Array): boolean => Buffer.from(der).includes(Buffer.from(marker));
  check("两张证书都带 1.2.840.113635.100.18.1 扩展", has(identity.rootCertificate) && has(identity.leafCertificate));

  const years = (new Date(leaf.validTo).getTime() - Date.now()) / (365.25 * 86_400_000);
  check("有效期约 10 年", years > 9.9 && years < 10.1);
  check("指纹格式和 node 的 fingerprint256 一致", rootFingerprint(identity) === root.fingerprint256);

  // 每次生成的都不一样
  const another = createIdentity({ random: rnd });
  check("两次生成的身份不同", toHex(another.rootCertificate) !== toHex(identity.rootCertificate));

  // 存取往返
  const restored = parseIdentity(serializeIdentity(identity));
  check(
    "序列化往返不丢信息",
    restored.leafPrivateKey === identity.leafPrivateKey &&
      toHex(restored.leafCertificate) === toHex(identity.leafCertificate) &&
      toHex(restored.rootCertificate) === toHex(identity.rootCertificate) &&
      restored.createdAt === identity.createdAt,
  );
  const tampered = JSON.parse(serializeIdentity(identity)) as { leafKey: string };
  tampered.leafKey = toHex(bigIntToBytes(another.leafPrivateKey, 32));
  let rejected = false;
  try {
    parseIdentity(JSON.stringify(tampered));
  } catch {
    rejected = true;
  }
  check("叶私钥和叶证书对不上时拒绝读取", rejected);
  let rejectedGarbage = false;
  try {
    parseIdentity("{\"version\":2}");
  } catch {
    rejectedGarbage = true;
  }
  check("格式不认识的数据被拒绝", rejectedGarbage);
}

// ---------------------------------------------------------------------------
// plist
// ---------------------------------------------------------------------------

/** 用户那个「签名测试」快捷指令的原文（未签名 XML plist）。 */
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>WFWorkflowName</key>
	<string>签名测试</string>
	<key>WFWorkflowMinimumClientVersion</key>
	<integer>900</integer>
	<key>WFWorkflowIcon</key>
	<dict>
		<key>WFWorkflowIconStartColor</key>
		<integer>4274264319</integer>
		<key>WFWorkflowIconGlyphNumber</key>
		<integer>61440</integer>
	</dict>
	<key>WFWorkflowImportQuestions</key>
	<array/>
	<key>WFWorkflowHasOutputFallback</key>
	<false/>
	<key>WFWorkflowActions</key>
	<array>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.alert</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>WFAlertActionTitle</key>
				<string>签名测试 ✅</string>
				<key>WFAlertActionMessage</key>
				<string>导入并运行成功：这个快捷指令的签名被系统接受了。</string>
				<key>WFAlertActionCancelButtonShown</key>
				<false/>
			</dict>
		</dict>
	</array>
</dict>
</plist>
`;

/** 把 plist 值化成可比较的规范字符串：Map 保序，整数不分 number / bigint。 */
function canon(value: PlistValue): string {
  if (typeof value === "boolean") return `bool:${value}`;
  if (typeof value === "number" || typeof value === "bigint") return `int:${value}`;
  if (value instanceof PReal) return `real:${value.value}`;
  if (typeof value === "string") return `str:${JSON.stringify(value)}`;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (value instanceof Uint8Array) return `data:${toHex(value)}`;
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  const pairs = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return `{${pairs.map(([key, item]) => `${JSON.stringify(key)}=>${canon(item)}`).join(",")}}`;
}

function throwsError(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}

function testPlist(): void {
  console.log("plist（XML 读 / 二进制读写 / XML 写）");
  const parsed = parseXmlPlist(SAMPLE_XML);
  check("XML 解析出字典", isDict(parsed));
  const dict = parsed as Map<string, PlistValue>;
  check(
    "键保持文档顺序",
    [...dict.keys()].join() ===
      "WFWorkflowName,WFWorkflowMinimumClientVersion,WFWorkflowIcon,WFWorkflowImportQuestions,WFWorkflowHasOutputFallback,WFWorkflowActions",
  );
  check("中文名", dict.get("WFWorkflowName") === "签名测试");
  check("整数 / 布尔 / 空数组", dict.get("WFWorkflowMinimumClientVersion") === 900 && dict.get("WFWorkflowHasOutputFallback") === false && Array.isArray(dict.get("WFWorkflowImportQuestions")));
  const action = (dict.get("WFWorkflowActions") as PlistValue[])[0] as Map<string, PlistValue>;
  const params = action.get("WFWorkflowActionParameters") as Map<string, PlistValue>;
  check("emoji 原样保留", params.get("WFAlertActionTitle") === "签名测试 ✅");

  const entity = parseXmlPlist(
    '<plist version="1.0"><!-- 注释 --><dict><key>k&amp;1</key><string>a &lt;b&gt; &amp; &#65;&#x1F600; &quot;q&quot; &apos;s&apos;</string>' +
      "<key>c</key><string><![CDATA[<raw & text>]]></string><key>e</key><string/><key>t</key><true/><key>d</key><data> AQID\n BA== </data></dict></plist>",
  ) as Map<string, PlistValue>;
  check("实体与字符引用解码", entity.get("k&1") === "a <b> & A😀 \"q\" 's'");
  check("CDATA 原样", entity.get("c") === "<raw & text>");
  check("<string/> 是空串、<true/> 是 true", entity.get("e") === "" && entity.get("t") === true);
  check("<data> 容忍空白与换行", toHex(entity.get("d") as Uint8Array) === "01020304");

  check("缺值的字典被拒绝", throwsError(() => parseXmlPlist("<plist><dict><key>a</key></dict></plist>")));
  check("没闭合被拒绝", throwsError(() => parseXmlPlist("<plist><dict><key>a</key><string>x</string></plist>")));
  check("不认识的标签被拒绝", throwsError(() => parseXmlPlist("<plist><foo/></plist>")));
  check("坏整数被拒绝", throwsError(() => parseXmlPlist("<plist><integer>abc</integer></plist>")));
  check("不是 plist 被拒绝", throwsError(() => parseXmlPlist("<html></html>")));

  const date = new Date(Date.UTC(2026, 9, 28, 1, 2, 3));
  const tricky = new Map<string, PlistValue>([
    ["int-small", 5],
    ["int-256", 256],
    ["int-70000", 70000],
    ["int-2^32", 4_294_967_296],
    ["neg", -7],
    ["neg-big", -(2 ** 40)],
    ["u64-max", 18446744073709551615n],
    ["i64-min", -9223372036854775808n],
    ["real", new PReal(1.5)],
    ["real-int", new PReal(2)],
    ["true", true],
    ["false", false],
    ["ascii-14", "x".repeat(14)],
    ["ascii-15", "y".repeat(15)],
    ["ascii-300", "z".repeat(300)],
    ["cn", "中文 ✅ 😀"],
    ["empty", ""],
    ["date", date],
    ["data-0", new Uint8Array(0)],
    ["data-14", rnd(14)],
    ["data-15", rnd(15)],
    ["data-300", rnd(300)],
    ["array-20", Array.from({ length: 20 }, (_, i) => i * 1000)],
    ["nested", new Map<string, PlistValue>([["a", [1, new Map<string, PlistValue>([["b", "c"]])]]])],
    ["0", "整数样的键也保序"],
  ]);
  const binary = encodeBplist(tricky);
  check("二进制头是 bplist00", String.fromCharCode(...binary.subarray(0, 8)) === "bplist00");
  check("二进制往返（各类型 / 长度边界）", canon(parseBplist(binary)) === canon(tricky));
  check("XML 写出再读回一致", canon(parseXmlPlist(new TextDecoder().decode(encodeXmlPlist(tricky)))) === canon(tricky));
  check("普通对象也能写", canon(parseBplist(encodeBplist({ a: 1, b: ["x"] }))) === canon(new Map<string, PlistValue>([["a", 1], ["b", ["x"]]])));
  check("parsePlist 两种格式都认", canon(parsePlist(binary)) === canon(tricky) && canon(parsePlist(utf8(SAMPLE_XML))) === canon(parsed));

  // 重复的键名只存一份：同样内容重复 200 次，体积远小于不去重的情况
  const repeated = Array.from({ length: 200 }, () => new Map<string, PlistValue>([["WFWorkflowActionIdentifier", "is.workflow.actions.alert"]]));
  check("重复字符串去重（200 个相同字典 < 2.5KB）", encodeBplist(repeated).length < 2500);

  check("非整数的 number 被拒绝", throwsError(() => encodeBplist(1.5)));
  check("超出 64 位的整数被拒绝", throwsError(() => encodeBplist(1n << 64n)));
}

// ---------------------------------------------------------------------------
// AEA1
// ---------------------------------------------------------------------------

/** 测试用的游程编码：重复数据压得下去，随机数据会变大——正好测「压不小就原样存」。 */
const rleCompress: Compressor = (raw) => {
  const out: number[] = [];
  for (let i = 0; i < raw.length; ) {
    let run = 1;
    while (i + run < raw.length && raw[i + run] === raw[i] && run < 255) run++;
    out.push(run, raw[i]);
    i += run;
  }
  return Uint8Array.from(out);
};

const rleDecompress: Decompressor = (stored, rawSize) => {
  const out = new Uint8Array(rawSize);
  let at = 0;
  for (let i = 0; i < stored.length; i += 2) {
    out.fill(stored[i + 1], at, at + stored[i]);
    at += stored[i];
  }
  if (at !== rawSize) throw new Error("RLE 还原长度不对");
  return out;
};

const noDecompress: Decompressor = () => {
  throw new Error("不该有压缩过的段");
};

function derSignatureOf(identityKey: bigint, message: Uint8Array): Uint8Array {
  const { r, s } = ecdsaSign(identityKey, sha256(message), { random: rnd });
  return encodeDerSignature(r, s);
}

function testAea(): void {
  console.log("AEA1 / AA01（自己写、自己验、再让 Apple 的样本当裁判）");
  const identity = createIdentity({ random: rnd });
  const pub = encodePoint(identity.leafPublicKey);
  const authData = authDataFor(identity);
  const sign = (message: Uint8Array): Uint8Array => derSignatureOf(identity.leafPrivateKey, message);
  const mtime = 1_788_000_000_123_456_789n;

  // AA01 归档
  const payload = rnd(1621);
  const aar = buildAar("Shortcut.wflow", payload, mtime);
  const entries = parseAar(aar);
  check("归档有两个条目：目录 + Shortcut.wflow", entries.length === 2 && entries[0].type === "D" && entries[1].type === "F");
  check("路径 / 权限 / 数据", entries[0].path === "" && entries[0].mode === 0o755 && entries[1].path === "Shortcut.wflow" && entries[1].mode === 0o644 && equalBytes(entries[1].data, payload));
  const fieldOrder = (index: number): string => Object.keys(entries[index].fields).join();
  check("字段顺序和 Apple 一样（TYP PAT MOD MTM [DAT]）", fieldOrder(0) === "TYP,PAT,MOD,MTM" && fieldOrder(1) === "TYP,PAT,MOD,MTM,DAT");
  const mtm = entries[1].fields.MTM as Uint8Array;
  check("修改时间是 i64 秒 + u32 纳秒", Number(bytesToBigIntLE(mtm.subarray(0, 8))) === 1_788_000_000 && Number(bytesToBigIntLE(mtm.subarray(8, 12))) === 123_456_789);
  const bigPayload = rnd(70_000);
  check("数据超过 64KB 改用 DATB", Object.keys(parseAar(buildAar("big", bigPayload, mtime))[1].fields).includes("DAT") && equalBytes(parseAar(buildAar("big", bigPayload, mtime))[1].data, bigPayload));

  // 打包 + 全面校验
  const file = packAea(aar, { authData, signingPublicKey: pub, sign });
  check("以 AEA1 开头", String.fromCharCode(...file.subarray(0, 4)) === "AEA1");
  const verdict = verifyAea(file, pub, noDecompress);
  check(`校验全部通过${verdict.ok ? "" : "：" + verdict.problems.join("；")}`, verdict.ok);
  check("取回的归档与原来一致", equalBytes(extractAar(parseAea(file), noDecompress), aar));
  check("签名位 128 字节、DER 右补零", (() => {
    const field = parseAea(file).signatureField;
    const length = field[1] + 2;
    return field[0] === 0x30 && field.subarray(length).every((b) => b === 0);
  })());

  // 压缩分支：重复数据走压缩，随机数据压不小、原样存
  const repetitive = buildAar("Shortcut.wflow", new Uint8Array(5000).fill(7), mtime);
  const compressed = packAea(repetitive, { authData, signingPublicKey: pub, sign, compress: rleCompress });
  const compressedInfo = parseAea(compressed).segments[0];
  check("重复数据确实被压缩了", compressedInfo.storedSize < compressedInfo.rawSize);
  check("压缩过的段也能验过、还原", verifyAea(compressed, pub, rleDecompress).ok && equalBytes(extractAar(parseAea(compressed), rleDecompress), repetitive));
  const incompressible = packAea(aar, { authData, signingPublicKey: pub, sign, compress: rleCompress });
  const rawInfo = parseAea(incompressible).segments[0];
  check("随机数据压不小就原样存（压缩后长度 == 原始长度）", rawInfo.storedSize === rawInfo.rawSize && verifyAea(incompressible, pub, noDecompress).ok);

  // 多段：2.5 MiB 的载荷要切成 3 段
  const huge = buildAar("Shortcut.wflow", rnd(Math.floor(2.5 * SEGMENT_SIZE)), mtime);
  const multi = packAea(huge, { authData, signingPublicKey: pub, sign });
  check("2.5 MiB 切成 3 段", parseAea(multi).segments.length === 3);
  check("多段文件校验通过且能还原", verifyAea(multi, pub, noDecompress).ok && equalBytes(extractAar(parseAea(multi), noDecompress), huge));

  // 篡改任何一块都得被发现
  const p = 12 + authData.length;
  const spots: [string, number][] = [
    ["授权数据", 12 + 5],
    ["签名", p + 5],
    ["KDK", p + 0x80 + 1],
    ["盐", p + 0xa0 + 1],
    ["根头 HMAC", p + 0xc0 + 1],
    ["根头", p + 0xe0 + 2],
    ["簇头 HMAC", p + 0x110 + 1],
    ["段条目", p + 0x130 + 1],
    ["首段 HMAC", p + 0x130 + 256 * 40 + 32 + 1],
    ["未用的 HMAC 槽", p + 0x130 + 256 * 40 + 32 + 20 * 32],
    ["段数据", file.length - 1],
  ];
  let tamperOk = true;
  const missed: string[] = [];
  for (const [label, at] of spots) {
    const broken = file.slice();
    broken[at] ^= 0x01;
    if (verifyAea(broken, pub, noDecompress).ok) {
      tamperOk = false;
      missed.push(label);
    }
  }
  check(`改动任意一块都会被发现（${spots.length} 处）${missed.length ? "，漏了：" + missed.join("、") : ""}`, tamperOk);
  check("多一个字节也会被发现", !verifyAea(concat(file, Uint8Array.of(0)), pub, noDecompress).ok);
  check("换一把公钥验不过", !verifyAea(file, encodePoint(generateKeyPair(rnd)), noDecompress).ok);
  check("截断的文件被拒绝", throwsError(() => parseAea(file.subarray(0, 200))));
  check("不是 AEA1 的文件被拒绝", throwsError(() => parseAea(utf8("hello world ".repeat(60)))));

  // Apple 官方签名样本（gNN.shortcut + gNN.aar，由 shortcut-signer-golden/make_golden.py 整理）。
  // 默认用 _selftest/shortcut-signer-golden，也可以用 SIGNER_GOLDEN 指到别处；都没有就跳过
  const goldenDir = process.env.SIGNER_GOLDEN ?? join(process.cwd(), "_selftest", "shortcut-signer-golden");
  if (!existsSync(goldenDir) || readdirSync(goldenDir).every((name) => !name.endsWith(".shortcut"))) {
    console.log("  - 没有 Apple 样本（_selftest/shortcut-signer-golden 或 SIGNER_GOLDEN），跳过对拍");
    return;
  }
  const names = readdirSync(goldenDir).filter((name) => name.endsWith(".shortcut")).sort();
  let verified = 0;
  let reproduced = 0;
  let aarReproduced = 0;
  const failures: string[] = [];
  for (const name of names) {
    const data = new Uint8Array(readFileSync(join(goldenDir, name)));
    const rawAar = new Uint8Array(readFileSync(join(goldenDir, name.replace(/\.shortcut$/, ".aar"))));
    const parsed = parseAea(data);
    const chain = (parseBplist(parsed.authData) as Map<string, PlistValue>).get("SigningCertificateChain") as Uint8Array[];
    const leafKey = publicKeyFromCertificate(chain[0]);
    if (leafKey === null) {
      failures.push(`${name}：取不出叶公钥`);
      continue;
    }
    const fromAar: Decompressor = () => rawAar;
    if (verifyAea(data, leafKey, fromAar).ok) verified++;
    else failures.push(`${name}：验不过 ${verifyAea(data, leafKey, fromAar).problems.join("；")}`);

    // 用样本自己的随机数 / 压缩结果 / 签名重新打包，必须逐字节相同
    const segment = parsed.segments[0];
    // 原生压缩结果的形状检查（kit/lzfse.ts）不能把 Apple 自己的段判成不合格
    if (!looksLikeLzfse(segment.stored)) failures.push(`${name}：looksLikeLzfse 不认 Apple 的 LZFSE 段`);
    const queue = [parsed.kdk, parsed.salt, parsed.hmacs];
    const signatureDer = parsed.signatureField.subarray(0, parsed.signatureField[1] + 2);
    const rebuilt = packAea(rawAar, {
      authData: parsed.authData,
      signingPublicKey: leafKey,
      sign: () => signatureDer,
      compress: () => segment.stored,
      random: () => queue.shift() as Uint8Array,
    });
    if (equalBytes(rebuilt, data)) reproduced++;
    else failures.push(`${name}：重新打包和样本不一致`);

    // 归档也要能逐字节复现：用样本里的修改时间
    const entry = parseAar(rawAar)[1];
    const stamp = entry.fields.MTM as Uint8Array;
    const ns = bytesToBigIntLE(stamp.subarray(0, 8)) * 1_000_000_000n + bytesToBigIntLE(stamp.subarray(8, 12));
    if (equalBytes(buildAar(entry.path, entry.data, ns), rawAar)) aarReproduced++;
    else failures.push(`${name}：归档重新生成和样本不一致`);
  }
  if (failures.length) console.log(failures.map((line) => `    ${line}`).join("\n"));
  check(`Apple 官方样本 ${names.length} 个：全部通过校验（HMAC / ECDSA / SHA-256 / 总长）`, names.length > 0 && verified === names.length);
  check(`Apple 官方样本：容器逐字节复现 ${reproduced}/${names.length}`, names.length > 0 && reproduced === names.length);
  check(`Apple 官方样本：AA01 归档逐字节复现 ${aarReproduced}/${names.length}`, names.length > 0 && aarReproduced === names.length);
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  return bytesToBigInt(Uint8Array.from(bytes).reverse());
}

// ---------------------------------------------------------------------------
// 整条签名流程
// ---------------------------------------------------------------------------

function testSign(): void {
  console.log("签名全流程（认文件 → 校验 → 打包 → 自检）");
  const identity = createIdentity({ random: rnd });
  const other = createIdentity({ random: rnd });
  const pub = encodePoint(identity.leafPublicKey);

  check("sniff：XML / 二进制 / 已签名 / 空 / 未知", [
    sniffShortcut(utf8(SAMPLE_XML)),
    sniffShortcut(utf8("\n  \t" + SAMPLE_XML)),
    sniffShortcut(encodeBplist(new Map([["a", 1]]))),
    sniffShortcut(utf8("AEA1....")),
    sniffShortcut(new Uint8Array(0)),
    sniffShortcut(utf8('{"json":true}')),
  ].join() === "xml,xml,bplist,signed,empty,unknown");
  check("sniff 认带 BOM 的 XML", sniffShortcut(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8(SAMPLE_XML))) === "xml");

  const prepared = prepareShortcut(utf8(SAMPLE_XML));
  check("取到名字和动作数", prepared.name === "签名测试" && prepared.actionCount === 1 && prepared.source === "xml");
  check("载荷是二进制 plist、内容与原文一致", String.fromCharCode(...prepared.payload.subarray(0, 8)) === "bplist00" && canon(parseBplist(prepared.payload)) === canon(parseXmlPlist(SAMPLE_XML)));

  const messageOf = (run: () => unknown): string => {
    try {
      run();
      return "";
    } catch (error) {
      return error instanceof ShortcutError ? error.message : `(非 ShortcutError) ${(error as Error).message}`;
    }
  };
  check("空文件", messageOf(() => prepareShortcut(new Uint8Array(0))).includes("空"));
  check("不是 plist", messageOf(() => prepareShortcut(utf8('{"a":1}'))).includes("认不出"));
  check("plist 里没有 WFWorkflowActions", messageOf(() => prepareShortcut(encodeXmlPlist({ a: 1 }))).includes("WFWorkflowActions"));
  check("XML 坏了", messageOf(() => prepareShortcut(utf8("<plist><dict>"))).includes("解析失败"));
  check("顶层不是字典", messageOf(() => prepareShortcut(encodeXmlPlist([1, 2]))).includes("顶层不是字典"));

  // 报错要具体到用户能自己核对：大小、开头的字节、多半是什么
  const zipMessage = messageOf(() => prepareShortcut(concat(Uint8Array.of(0x50, 0x4b, 0x03, 0x04), rnd(40))));
  check("认不出的文件：报出大小、开头字节和猜测（zip）", zipMessage.includes("共 44 字节") && zipMessage.includes("50 4B 03 04") && zipMessage.includes("zip"));
  check("认不出的文件：剪贴板里是链接文字时指路「输入链接」", messageOf(() => prepareShortcut(utf8("  https://example.com/a.shortcut"))).includes("输入链接"));
  check(
    "认不出的文件：JSON / PDF 点名",
    messageOf(() => prepareShortcut(utf8('{"a":1}'))).includes("JSON") && messageOf(() => prepareShortcut(utf8("%PDF-1.7 ..."))).includes("PDF"),
  );
  const noGuess = messageOf(() => prepareShortcut(Uint8Array.of(0, 1, 2, 3, 4)));
  check("认不出的文件：猜不出就不乱猜，只报事实", noGuess.includes("共 5 字节") && noGuess.includes("00 01 02 03 04") && !noGuess.includes("像是") && !noGuess.includes("这是"));
  check(
    "网页（HTML）单独点名：大小写、前导空白、BOM 都认",
    ["<!DOCTYPE html><html><body>登录</body></html>", "\n  <html lang=en>", "<!doctype HTML>"].every((text) => messageOf(() => prepareShortcut(utf8(text))).includes("网页（HTML）")) &&
      messageOf(() => prepareShortcut(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8("<html>")))).includes("网页（HTML）"),
  );
  check("真正的 plist（DOCTYPE plist）不会被当成网页", !messageOf(() => prepareShortcut(utf8(SAMPLE_XML))).includes("网页"));
  check("headPreview：十六进制 + 可见字符（不可见的换成 ·）", headPreview(utf8("PK\u0003\u0004")) === "50 4B 03 04（PK··）" && headPreview(utf8("abcdefghijklmnop")).startsWith("61 62 63"));

  const signed = signShortcut(utf8(SAMPLE_XML), identity, { random: rnd });
  check("签出来是 AEA1", String.fromCharCode(...signed.data.subarray(0, 4)) === "AEA1");
  const verdict = verifyAea(signed.data, pub, noDecompress);
  check(`自检通过${verdict.ok ? "" : "：" + verdict.problems.join("；")}`, verdict.ok);
  check("授权数据里是 [叶, 根] 两张证书", (() => {
    const chain = (parseBplist(parseAea(signed.data).authData) as Map<string, PlistValue>).get("SigningCertificateChain") as Uint8Array[];
    return chain.length === 2 && equalBytes(chain[0], identity.leafCertificate) && equalBytes(chain[1], identity.rootCertificate);
  })());
  check("证书链能被 node 验到根", (() => {
    const chain = (parseBplist(parseAea(signed.data).authData) as Map<string, PlistValue>).get("SigningCertificateChain") as Uint8Array[];
    const leaf = new X509Certificate(Buffer.from(chain[0]));
    const root = new X509Certificate(Buffer.from(chain[1]));
    return leaf.verify(root.publicKey) && root.verify(root.publicKey);
  })());
  check("签名公钥就是叶证书里的公钥", equalBytes(publicKeyFromCertificate(identity.leafCertificate) as Uint8Array, pub));
  check("取回的 Shortcut.wflow 与原载荷一致", equalBytes(extractWorkflow(signed.data, noDecompress), prepared.payload));
  check("isSignedBy：自己签的是，别人的不是", isSignedBy(signed.data, identity) && !isSignedBy(signed.data, other));
  check("名字 / 动作数 / 来源", signed.name === "签名测试" && signed.actionCount === 1 && signed.source === "xml");

  // 二进制 plist 原样放进去
  const binaryInput = encodeBplist(parseXmlPlist(SAMPLE_XML));
  const fromBinary = signShortcut(binaryInput, identity, { random: rnd });
  check("二进制来料原样放进去，不重新编码", equalBytes(extractWorkflow(fromBinary.data, noDecompress), binaryInput) && fromBinary.source === "bplist");

  // 已签名的来料：拆出来换成我们的签名
  const resigned = signShortcut(signed.data, other, { random: rnd, decompress: noDecompress });
  check("已签名的来料能换签名，内容不变", resigned.source === "signed" && isSignedBy(resigned.data, other) && equalBytes(extractWorkflow(resigned.data, noDecompress), prepared.payload) && verifyAea(resigned.data, encodePoint(other.leafPublicKey), noDecompress).ok);
  const compressedSigned = signShortcut(utf8(SAMPLE_XML), identity, { random: rnd, compress: rleCompress });
  check(
    "没有解压能力时，压缩过的签名文件给出明确的中文错误",
    messageOf(() => prepareShortcut(compressedSigned.data)).includes("LZFSE") || parseAea(compressedSigned.data).segments[0].storedSize === parseAea(compressedSigned.data).segments[0].rawSize,
  );
  const reRead = prepareShortcut(compressedSigned.data, { decompress: rleDecompress });
  check("给了解压函数就能读回压缩过的签名文件", reRead.actionCount === 1);

  // 把产物落盘，给 Python 侧独立验证器用（设了 SIGNER_OUT 才写）
  const out = process.env.SIGNER_OUT;
  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "signed.shortcut"), signed.data);
    writeFileSync(join(out, "signed-compressed-rle.shortcut"), compressedSigned.data);
    writeFileSync(join(out, "identity-root.cer"), identity.rootCertificate);
    writeFileSync(join(out, "identity-leaf.cer"), identity.leafCertificate);
    writeFileSync(join(out, "tricky.bplist"), encodeBplist(parseXmlPlist(SAMPLE_XML)));
    writeFileSync(join(out, "profile.mobileconfig"), rootProfile(identity));
    console.log(`  - 已写出产物到 ${out}`);
  }
}

// ---------------------------------------------------------------------------
// 文件名 / 描述文件 / 流程里的自检回退 / 设备转译器兼容
// ---------------------------------------------------------------------------

function testNames(): void {
  console.log("文件名清洗（快捷指令名来自 plist，不可信）");
  const traversal = safeFileName("../../etc/passwd");
  check("路径穿越出不了工作目录（无斜杠、不以点开头）", !traversal.includes("/") && !traversal.includes("\\") && !traversal.startsWith("."));
  check("Windows 风格的非法字符", safeFileName("a\\b:c*d?e") === "a_b_c_d_e");
  check("控制字符", safeFileName("a\u0000b\nc") === "a_b_c");
  check("首尾空白和点", safeFileName("  .name. ") === "name");
  check("全是点 / 空 → 兜底名", safeFileName("...") === "快捷指令" && safeFileName("") === "快捷指令" && safeFileName("", "x") === "x");
  check("限长 80", safeFileName("x".repeat(200)).length === 80);
  check("中文和 emoji 保留", safeFileName("签名测试 ✅") === "签名测试 ✅");
  check("去扩展名", stripExtension("a.shortcut") === "a" && stripExtension("a.PLIST") === "a" && stripExtension("a.b") === "a.b");
  check("体积显示", formatSize(2048) === "2.0 KB" && formatSize(3 * 1024 * 1024) === "3.0 MB");
  check(
    "取文件名：POSIX 路径最后一段，末尾斜杠不算",
    baseName("/var/mobile/Documents/签名测试.shortcut") === "签名测试.shortcut" && baseName("/a/b/") === "b" && baseName("x.shortcut") === "x.shortcut" && baseName("/") === "/",
  );
  check(
    "分享面板的路径：绝对路径原样；file:// 链接还原成路径（%XX 解码，大小写不敏感，解不开原样用）",
    sharedFilePath("/var/mobile/x.shortcut") === "/var/mobile/x.shortcut" &&
      sharedFilePath("file:///var/mobile/%E7%AD%BE%E5%90%8D.shortcut") === "/var/mobile/签名.shortcut" &&
      sharedFilePath("FILE:///a%20b") === "/a b" &&
      sharedFilePath("file:///a%E7%AD") === "/a%E7%AD",
  );

  check("链接取文件名：路径最后一段、去查询串", nameFromUrl("https://x.com/a/My.shortcut?dl=1#top") === "My.shortcut");
  check("链接取文件名：百分号解码", nameFromUrl("https://x.com/%E7%AD%BE%E5%90%8D.shortcut") === "签名.shortcut");
  check("链接取文件名：坏编码原样用、没有路径时取到域名",nameFromUrl("https://x.com/%E7%AD.shortcut") === "%E7%AD.shortcut" && nameFromUrl("https://x.com/") === "x.com" && nameFromUrl("https://") === "https:");
  check("iCloud 分享链接给出明确说法，普通链接不拦", (linkProblem("https://www.icloud.com/shortcuts/abc123") ?? "").includes("iCloud") && linkProblem("https://icloud.com/shortcuts/abc") !== null && linkProblem("https://example.com/a.shortcut") === null);
}

/** Scripting 原生 Data / CompressionAlgorithm 的最小替身，验 kit/lzfse.ts 的包装逻辑。 */
function testNativeLzfse(): void {
  console.log("原生 LZFSE 的包装（假 Data）");
  const g = globalThis as Record<string, unknown>;
  const saved = { Data: g.Data, CompressionAlgorithm: g.CompressionAlgorithm };
  type Mode = "ok" | "junk" | "throw";
  /** toUint8Array() 回什么：dts 写 Uint8Array，真机上别的接口回过 ArrayBuffer、也回过 undefined */
  type BytesAs = "array" | "buffer" | "undefined";
  const state: {
    mode: Mode;
    bytesAs: BytesAs;
    received: { offset: number; length: number; bufferLength: number }[];
    algorithms: unknown[];
  } = {
    mode: "ok",
    bytesAs: "array",
    received: [],
    algorithms: [],
  };
  class FakeData {
    constructor(readonly bytes: Uint8Array) {}
    static fromUint8Array(bytes: Uint8Array): FakeData {
      state.received.push({ offset: bytes.byteOffset, length: bytes.byteLength, bufferLength: bytes.buffer.byteLength });
      return new FakeData(bytes);
    }
    compressed(algorithm: unknown): FakeData {
      state.algorithms.push(algorithm);
      if (state.mode === "throw") throw new Error("boom");
      if (state.mode === "junk") return new FakeData(utf8("definitely not lzfse"));
      return new FakeData(concat(utf8("bvx2"), this.bytes.subarray(0, Math.max(1, this.bytes.length >> 1)), utf8("bvx$")));
    }
    decompressed(algorithm: unknown): FakeData {
      state.algorithms.push(algorithm);
      return new FakeData(new Uint8Array(40).fill(9));
    }
    toUint8Array(): unknown {
      if (state.bytesAs === "buffer") return this.bytes.slice().buffer;
      if (state.bytesAs === "undefined") return undefined;
      return this.bytes;
    }
  }
  try {
    g.Data = FakeData;
    g.CompressionAlgorithm = { lzfse: 7 };

    // 一段「别的缓冲上的小视图」：必须被拷成独占整块缓冲的数组再交给原生
    const big = rnd(1000);
    const view = big.subarray(100, 300);
    const packed = nativeCompress(view);
    const first = state.received[0];
    check("传给原生的数组独占整块缓冲（视图被拷贝）", first.offset === 0 && first.length === first.bufferLength && first.length === 200);
    check("标准形状的压缩结果被采用", looksLikeLzfse(packed) && packed !== view);
    check("枚举存在时用枚举的值", state.algorithms[0] === 7);

    state.mode = "junk";
    check("形状不对的压缩结果不用，退回原数据", nativeCompress(view) === view);
    state.mode = "throw";
    check("原生抛错时退回原数据", nativeCompress(view) === view);

    state.mode = "ok";
    state.algorithms.length = 0;
    delete g.CompressionAlgorithm;
    nativeCompress(view);
    check("CompressionAlgorithm 不存在时用它的值 0，不抛 ReferenceError", state.algorithms[0] === 0);

    check("解压长度对得上就返回", nativeDecompress(rnd(10), 40).length === 40);
    check("解压长度对不上就抛错", throwsError(() => nativeDecompress(rnd(10), 41)));
    const stored = rnd(500).subarray(7, 77);
    state.received.length = 0;
    nativeDecompress(stored, 40);
    check("解压时同样只传独占整块缓冲的数组", state.received[0].offset === 0 && state.received[0].length === state.received[0].bufferLength);

    // 原生交回字节的形状和 dts 不一致时（真机踩过的那一类）
    state.bytesAs = "buffer";
    const packedFromBuffer = nativeCompress(view);
    check("toUint8Array 回 ArrayBuffer 时压缩照样可用（统一成 Uint8Array）", packedFromBuffer instanceof Uint8Array && packedFromBuffer !== view && looksLikeLzfse(packedFromBuffer));
    const unpackedFromBuffer = nativeDecompress(rnd(10), 40);
    check("toUint8Array 回 ArrayBuffer 时解压照样可用", unpackedFromBuffer instanceof Uint8Array && unpackedFromBuffer.length === 40);
    state.bytesAs = "undefined";
    check("原生没给出字节（undefined）：压缩退回原数据，解压抛明白的错", nativeCompress(view) === view && throwsError(() => nativeDecompress(rnd(10), 40)));
    state.bytesAs = "array";
  } finally {
    g.Data = saved.Data;
    g.CompressionAlgorithm = saved.CompressionAlgorithm;
  }
}

function testProfile(): void {
  console.log("根证书描述文件（.mobileconfig）");
  const identity = createIdentity({ random: rnd });
  const other = createIdentity({ random: rnd });
  const xml = rootProfile(identity);
  const text = new TextDecoder().decode(xml);
  const parsed = parseXmlPlist(text) as Map<string, PlistValue>;
  const content = (parsed.get("PayloadContent") as PlistValue[])[0] as Map<string, PlistValue>;
  const uuid = /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;

  check("以 XML plist 头开始", text.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && text.includes("<plist version=\"1.0\">"));
  check("顶层是 Configuration", parsed.get("PayloadType") === "Configuration" && parsed.get("PayloadVersion") === 1);
  check("内层是 com.apple.security.root", content.get("PayloadType") === "com.apple.security.root" && content.get("PayloadVersion") === 1);
  check("证书内容就是根证书 DER", equalBytes(content.get("PayloadContent") as Uint8Array, identity.rootCertificate));
  check("两层 UUID 合法（版本 5）且互不相同", uuid.test(parsed.get("PayloadUUID") as string) && uuid.test(content.get("PayloadUUID") as string) && parsed.get("PayloadUUID") !== content.get("PayloadUUID"));
  check("同一身份反复生成的描述文件逐字节相同（重装不会装出重复项）", toHex(rootProfile(identity)) === toHex(xml));
  check("不同身份的标识不同", (parsed.get("PayloadIdentifier") as string) !== ((parseXmlPlist(new TextDecoder().decode(rootProfile(other))) as Map<string, PlistValue>).get("PayloadIdentifier") as string));
  check("证书显示名就是根证书的 CN", content.get("PayloadDisplayName") === commonNameOf(identity.rootCertificate) && /^Shortcut Signer Root [0-9a-f]{4}$/.test(commonNameOf(identity.rootCertificate) ?? ""));
  check("可以移除（不锁死用户）", parsed.get("PayloadRemovalDisallowed") === false);
}

function testRename(): void {
  console.log("证书名称（可改，改名 = 用新名字重新生成）");
  check("合法名称", ["快捷指令签名", "My Signer", "😀 emoji 名", "a".repeat(40)].every((name) => checkRootName(name) === null));
  check("空 / 首尾空格 / 过长 / 控制字符都不合法", [
    checkRootName(""),
    checkRootName(" 前面有空格"),
    checkRootName("后面有空格 "),
    checkRootName("a".repeat(41)),
    checkRootName("带\u0000控制字符"),
    checkRootName("带\n换行"),
  ].every((problem) => problem !== null));
  check("名称按字符数计，emoji 算一个（40 个 emoji 合法）", checkRootName("😀".repeat(40)) === null && checkRootName("😀".repeat(41)) !== null);

  const named = createIdentity({ random: rnd, rootName: "我的快捷指令签名" });
  check("自定义名称原样做成根证书的 CN（不加随机后缀）", commonNameOf(named.rootCertificate) === "我的快捷指令签名");
  const root = new X509Certificate(Buffer.from(named.rootCertificate));
  const leaf = new X509Certificate(Buffer.from(named.leafCertificate));
  check("改名后根证书仍然自签有效、叶证书仍然是它签的", root.verify(root.publicKey) && leaf.verify(root.publicKey) && root.ca);
  check("叶证书的 issuer 是新名字", leaf.issuer === root.subject);
  check("两个同名身份的根证书指纹不同", rootFingerprint(named) !== rootFingerprint(createIdentity({ random: rnd, rootName: "我的快捷指令签名" })));
  check("名称前后有空白会被修剪", commonNameOf(createIdentity({ random: rnd, rootName: "  带空白  " }).rootCertificate) === "带空白");
  check("全是空白等于没给，用默认名", /^Shortcut Signer Root [0-9a-f]{4}$/.test(commonNameOf(createIdentity({ random: rnd, rootName: "   " }).rootCertificate) ?? ""));
  check("非法名称拒绝生成", throwsError(() => createIdentity({ random: rnd, rootName: "x".repeat(41) })));

  const profile = parseXmlPlist(new TextDecoder().decode(rootProfile(named))) as Map<string, PlistValue>;
  const inner = (profile.get("PayloadContent") as PlistValue[])[0] as Map<string, PlistValue>;
  check("描述文件和里面的证书都用这个名字显示", profile.get("PayloadDisplayName") === "我的快捷指令签名" && inner.get("PayloadDisplayName") === "我的快捷指令签名");
}

function testFilesRoute(): void {
  console.log("存到「文件」的备选路线（文件名与深链）");
  check("证书文件名 = 证书名 + .cer", certificateFileName("Shortcut Signer Root b661") === "Shortcut Signer Root b661.cer");
  check("证书名里有路径符号时被清洗", certificateFileName("../a/b") === "_.._a_b.cer" || !certificateFileName("../a/b").includes("/"));
  check("证书名清洗后为空用兜底名", certificateFileName("...") === "Shortcut Signer Root.cer");
  check("文件夹名", CERTIFICATE_DIR_NAME === "快捷指令签名证书");
  const url = filesAppUrl(`/var/mobile/Containers/Data/Application/AB-12/Documents/${CERTIFICATE_DIR_NAME}`);
  check(
    "深链：/var 补成 /private/var，中文被编码",
    url === `shareddocuments:///private/var/mobile/Containers/Data/Application/AB-12/Documents/${encodeURIComponent(CERTIFICATE_DIR_NAME)}`,
  );
  check("深链：已经是 /private/var 的不重复补", filesAppUrl("/private/var/x y").startsWith("shareddocuments:///private/var/x%20y"));
  check("深链：解码后能还原路径", decodeURI(filesAppUrl("/private/var/a b/快捷")).replace("shareddocuments://", "") === "/private/var/a b/快捷");
}

/** Scripting 的 Keychain / Storage 的最小替身，让 kit/store.ts 能在 Node 里被测。 */
function installFakeStores(): { keychain: Map<string, string>; storage: Map<string, unknown>; failWrites: { value: boolean } } {
  const keychain = new Map<string, string>();
  const storage = new Map<string, unknown>();
  const failWrites = { value: false };
  const g = globalThis as Record<string, unknown>;
  g.Keychain = {
    get: (key: string) => keychain.get(key) ?? null,
    set: (key: string, value: string) => {
      if (failWrites.value) return false;
      keychain.set(key, value);
      return true;
    },
    remove: (key: string) => keychain.delete(key),
  };
  g.Storage = {
    get: (key: string) => storage.get(key),
    set: (key: string, value: unknown) => void storage.set(key, value),
  };
  return { keychain, storage, failWrites };
}

function testStore(): void {
  console.log("签名身份的存取（假钥匙串 / 假 Storage）");
  const { keychain, storage, failWrites } = installFakeStores();
  resetCacheForTests();

  check("什么都没存时读到 null", readIdentity() === null && savedRootName() === "");
  const first = ensureIdentity();
  check("ensureIdentity 生成并存进钥匙串", keychain.size === 1 && readIdentity() === first);
  check("默认名称", /^Shortcut Signer Root [0-9a-f]{4}$/.test(commonNameOf(first.rootCertificate) ?? ""));

  resetCacheForTests();
  const reread = readIdentity();
  check("清了缓存再读，是从钥匙串里读回来的同一个身份", reread !== null && reread.leafPrivateKey === first.leafPrivateKey && toHex(reread.rootCertificate) === toHex(first.rootCertificate));

  check("saveRootName 只记名字、不动已有身份", (() => {
    saveRootName("  我的签名  ");
    return savedRootName() === "我的签名" && readIdentity() === reread;
  })());
  const renamed = replaceIdentity();
  check("replaceIdentity 不传名字就沿用存下的名字", commonNameOf(renamed.rootCertificate) === "我的签名" && toHex(renamed.rootCertificate) !== toHex(first.rootCertificate));
  check("新身份写进了钥匙串", (() => {
    resetCacheForTests();
    const back = readIdentity();
    return back !== null && back.leafPrivateKey === renamed.leafPrivateKey;
  })());

  const explicit = replaceIdentity("另一个名字");
  check("传名字就用它，并且记住", commonNameOf(explicit.rootCertificate) === "另一个名字" && storage.get("rootName") === "另一个名字");
  const reset = replaceIdentity("");
  check("传空串 = 改回默认名，并且记住", /^Shortcut Signer Root [0-9a-f]{4}$/.test(commonNameOf(reset.rootCertificate) ?? "") && storage.get("rootName") === "");

  check("saveRootName 拒绝非法名称", throwsError(() => saveRootName("x".repeat(41))) && savedRootName() === "");

  // 「证书我装好了」的确认：用户手动点的（脚本检测不到系统里的信任状态），重新生成时清掉
  check("没确认过时是 false", certificateReady() === false);
  setCertificateReady(true);
  check("确认之后读到 true，并且存进了 Storage", certificateReady() === true && storage.get("certificateReady") === true);
  replaceIdentity();
  check("重新生成身份会清掉确认（新证书还没装）", certificateReady() === false);

  // 存坏了：读会抛错（不缓存失败），重新生成之后恢复
  keychain.set("shortcut_signer_identity_v1", "{坏的");
  resetCacheForTests();
  check("钥匙串里的数据坏了：读取抛错，且每次都抛（不缓存失败）", throwsError(() => readIdentity()) && throwsError(() => readIdentity()) && throwsError(() => ensureIdentity()));
  const corruptMessage = (() => {
    try {
      readIdentity();
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  check("读不出来的报错里写着恢复办法（重新生成签名身份）", corruptMessage.includes("重新生成签名身份"));
  const healed = replaceIdentity();
  check("重新生成能覆盖坏数据", readIdentity() === healed);

  // 钥匙串写不进去：明确报错，也不能留下「缓存里有、钥匙串里没有」的假身份
  resetCacheForTests();
  keychain.clear();
  failWrites.value = true;
  check("写不进钥匙串时报错", throwsError(() => replaceIdentity()));
  check("失败后没有留下假身份", readIdentity() === null);
  failWrites.value = false;
}

function testSample(): void {
  console.log("内置测试快捷指令");
  const prepared = prepareShortcut(utf8(SAMPLE_SHORTCUT_XML));
  check("能解析：名字 / 动作数", prepared.name === SAMPLE_SHORTCUT_NAME && prepared.actionCount === 1);
  const dict = parseXmlPlist(SAMPLE_SHORTCUT_XML) as Map<string, PlistValue>;
  const action = (dict.get("WFWorkflowActions") as PlistValue[])[0] as Map<string, PlistValue>;
  check("唯一的动作是「显示提示」", action.get("WFWorkflowActionIdentifier") === "is.workflow.actions.alert");
  const outcome = signChecked(utf8(SAMPLE_SHORTCUT_XML), createIdentity({ random: rnd }), { decompress: noDecompress });
  check("能签、自检通过", outcome.ok);

  // 和用户已经验证过的那个文件逐字节一致（文件在 scripting 的上一级；没有就跳过）
  const tested = join(process.cwd(), "..", "shortcut-sign-test", "签名测试.shortcut");
  if (existsSync(tested)) {
    check("和 shortcut-sign-test/签名测试.shortcut 逐字节一致", readFileSync(tested, "utf8") === SAMPLE_SHORTCUT_XML);
  } else {
    console.log("  - 找不到 shortcut-sign-test/签名测试.shortcut，跳过逐字节比对");
  }
}

function testJump(): void {
  console.log("「证书设置跳转」快捷指令（证书页第四步，实验）");
  const bytes = jumpShortcut();
  const workflow = parsePlist(bytes) as Map<string, PlistValue>;
  const verdict = checkWorkflow(workflow);
  check(
    "结构检查：没有错误，警告只有「没写 UUID」（没人引用动作的结果，不需要）",
    verdict.ok && verdict.errors.length === 0 && issueCodes(verdict.warnings).every((code) => code === "missing_uuid"),
  );
  check("动作数 = 菜单头 + 每个目标的（菜单项 + 打开 URL）+ 菜单尾", verdict.actionCount === 2 + 2 * JUMP_TARGETS.length);

  // 外壳：名字和动作以外的键，必须和真机验证过的「签名测试」一模一样
  const shell = parsePlist(utf8(SAMPLE_SHORTCUT_XML)) as Map<string, PlistValue>;
  const withoutNameAndActions = (dict: Map<string, PlistValue>): string =>
    new TextDecoder().decode(encodeXmlPlist(new Map([...dict].filter(([key]) => key !== "WFWorkflowName" && key !== "WFWorkflowActions"))));
  check("名字和动作以外的键，和真机验证过的「签名测试」逐项一致", withoutNameAndActions(workflow) === withoutNameAndActions(shell));

  // 名字三处要一致：plist 里的名字、落盘的文件名（safeFileName 不能改动它）、run-shortcut 链接里的名字
  const link = new URL(runShortcutUrl(JUMP_SHORTCUT_NAME));
  check(
    "名字三处一致：WFWorkflowName、文件名清洗后不变、run-shortcut 链接里解码回来",
    workflow.get("WFWorkflowName") === JUMP_SHORTCUT_NAME &&
      safeFileName(JUMP_SHORTCUT_NAME) === JUMP_SHORTCUT_NAME &&
      link.protocol === "shortcuts:" &&
      link.host === "run-shortcut" &&
      link.searchParams.get("name") === JUMP_SHORTCUT_NAME,
  );
  const tricky = runShortcutUrl("a b&c=d");
  check("run-shortcut 链接对空格 / & / = 编码，不会截断名字", !/[ ]/.test(tricky) && new URL(tricky).searchParams.get("name") === "a b&c=d");

  // 动作：菜单三种模式的顺序，菜单项文字，每项后面紧跟自己的打开 URL
  const actions = workflow.get("WFWorkflowActions") as Map<string, PlistValue>[];
  const identifierOf = (item: Map<string, PlistValue>): PlistValue | undefined => item.get("WFWorkflowActionIdentifier");
  const paramsOf = (item: Map<string, PlistValue>): Map<string, PlistValue> => item.get("WFWorkflowActionParameters") as Map<string, PlistValue>;
  const modes = actions.filter((item) => identifierOf(item) === "is.workflow.actions.choosefrommenu").map((item) => paramsOf(item).get("WFControlFlowMode"));
  check("菜单动作的模式依次是 0、每项一个 1、最后 2", modes.join() === ["0", ...JUMP_TARGETS.map(() => "1"), "2"].join());
  check("菜单头里的选项文字 = 各目标的标题，顺序一致", JSON.stringify(paramsOf(actions[0]).get("WFMenuItems")) === JSON.stringify(JUMP_TARGETS.map((target) => target.title)));
  check(
    "每个菜单项后面紧跟自己的打开 URL，链接逐字等于目标",
    JUMP_TARGETS.every((target, index) => {
      const item = actions[1 + 2 * index];
      const open = actions[2 + 2 * index];
      return paramsOf(item).get("WFMenuItemTitle") === target.title && identifierOf(open) === "is.workflow.actions.openurl" && paramsOf(open).get("WFInput") === target.url;
    }),
  );
  check(
    "两条链接就是这两条（改动要有意：WFInput 直接放字符串，和真实样本一致）",
    JUMP_TARGETS.map((target) => target.url).join("|") ===
      "prefs:root=General&path=ManagedConfigurationList|prefs:root=General&path=About/CERT_TRUST_SETTINGS",
  );

  // 签名往返
  const signed = signChecked(bytes, createIdentity({ random: rnd }), { decompress: noDecompress });
  check("能签、自检通过，名字和动作数对得上", signed.ok && signed.name === JUMP_SHORTCUT_NAME && signed.actionCount === verdict.actionCount);
  if (signed.ok) {
    const back = readWorkflow(signed.data, { decompress: noDecompress }).workflow;
    check("签出来的文件读回来，内容和未签名的一致", new TextDecoder().decode(encodeXmlPlist(back)) === new TextDecoder().decode(encodeXmlPlist(workflow)));
  }
}

function testFlow(): void {
  console.log("签名流程里的自检与回退");
  const identity = createIdentity({ random: rnd });
  const input = utf8(SAMPLE_XML);

  const plain = signChecked(input, identity, { decompress: noDecompress });
  check("没有压缩器时直接签", plain.ok && !plain.compressed && plain.actionCount === 1 && plain.name === "签名测试");

  // 压缩器压得动（游程编码吃连续相同的字节，所以塞一长串同一个字符）：最终文件里确实有压缩段
  const repetitive = new Map<string, PlistValue>([
    ["WFWorkflowName", "重复"],
    ["WFWorkflowActions", []],
    ["padding", "a".repeat(6000)],
  ]);
  const shrinkable = signChecked(encodeBplist(repetitive), identity, { compress: rleCompress, decompress: rleDecompress });
  check("压得动就用压缩（自检用同一套解压）", shrinkable.ok && shrinkable.compressed);

  // 压缩器吐出解不回去的东西 → 自检发现 → 退回不压缩，结果仍然有效
  const garbage: Compressor = (raw) => new Uint8Array(Math.max(raw.length - 10, 1)).fill(1);
  const afterFallback = signChecked(input, identity, { compress: garbage, decompress: rleDecompress });
  check("压缩结果解不回去时退回不压缩", afterFallback.ok && !afterFallback.compressed && verifyAea(afterFallback.ok ? afterFallback.data : new Uint8Array(0), encodePoint(identity.leafPublicKey), noDecompress).ok);

  // 解压出来的内容和原文对不上（长度对、内容错）→ SHA-256 不符 → 同样退回
  const wrongBytes: Decompressor = (_stored, rawSize) => new Uint8Array(rawSize);
  const afterWrong = signChecked(input, identity, { compress: garbage, decompress: wrongBytes });
  check("解压内容不对时退回不压缩", afterWrong.ok && !afterWrong.compressed);

  // 身份本身有问题（公钥对不上私钥）→ 两次都过不了自检 → 明确报错、不交文件
  const other = createIdentity({ random: rnd });
  const broken = { ...identity, leafPublicKey: other.leafPublicKey };
  const rejected = signChecked(input, broken, { compress: rleCompress, decompress: rleDecompress });
  check("身份有问题时自检拦下，不交文件", !rejected.ok && rejected.message.includes("没通过自检"));

  const junk = signChecked(utf8("nope"), identity, { decompress: noDecompress });
  check("来料不对时给出明确原因", !junk.ok && junk.message.includes("认不出"));
  const empty = signChecked(new Uint8Array(0), identity, { decompress: noDecompress });
  check("空文件", !empty.ok && empty.message.includes("空"));

  check(
    "looksLikeLzfse：认标准流、拒别的",
    looksLikeLzfse(concat(utf8("bvx2"), rnd(20), utf8("bvx$"))) &&
      looksLikeLzfse(concat(utf8("bvxn"), rnd(8), utf8("bvx$"))) &&
      !looksLikeLzfse(utf8("hello world!!!!")) &&
      !looksLikeLzfse(concat(utf8("bvx2"), rnd(20))) &&
      !looksLikeLzfse(new Uint8Array(3)),
  );
}

/** 断言一个异步动作会抛错，且错误信息里带 text。 */
async function rejectsWith(run: () => Promise<unknown>, text: string): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(text);
  }
}

/**
 * 原生接口交回来的值和 dts 写的不一样（真机踩过两次）：
 *   - FileManager.readAsBytesSync 回 ArrayBuffer（dts 写 Uint8Array）→ 任何文件都被判成「认不出这个文件」
 *   - Dialog.prompt 点取消回 undefined（dts 写 null）→ `.trim()` 栽在 undefined 上
 * 这里用假的全局对象把它们复现出来，验 kit/ 里的胶水代码扛得住。
 */
async function testDeviceBoundaries(): Promise<void> {
  console.log("设备接口和 dts 不一致时的防护（真机踩过的）");
  const g = globalThis as Record<string, unknown>;
  const saved = {
    DocumentPicker: g.DocumentPicker,
    FileManager: g.FileManager,
    Pasteboard: g.Pasteboard,
    Dialog: g.Dialog,
    fetch: g.fetch,
  };
  try {
    // ---- toBytes：运行时给的「字节」统一成 Uint8Array ----
    const plain = Uint8Array.of(1, 2, 3);
    check("toBytes：Uint8Array 原样返回", toBytes(plain) === plain);
    const fromBuffer = toBytes(Uint8Array.of(7, 8, 9).buffer);
    check("toBytes：ArrayBuffer → Uint8Array（有 length、内容对）", fromBuffer instanceof Uint8Array && fromBuffer.length === 3 && toHex(fromBuffer) === "070809");
    check("toBytes：其它类型化数组按字节看", toHex(toBytes(new Uint16Array([0x0201, 0x0403]))) === "01020304");
    const six = Uint8Array.of(0, 1, 2, 3, 4, 5);
    check("toBytes：DataView 只取它那一段", toHex(toBytes(new DataView(six.buffer, 2, 3))) === "020304");
    class FakeNativeData {
      constructor(private readonly inner: unknown) {}
      toUint8Array(): unknown {
        return this.inner;
      }
    }
    check(
      "toBytes：原生 Data（toUint8Array 回 Uint8Array 或 ArrayBuffer）都认",
      toHex(toBytes(new FakeNativeData(Uint8Array.of(5, 6)))) === "0506" && toHex(toBytes(new FakeNativeData(Uint8Array.of(5, 6).buffer))) === "0506",
    );
    check(
      "toBytes：认不出的类型一律抛 TypeError，并点名类型",
      [new FakeNativeData(null), undefined, null, "abc", 42, {}].every((value) => {
        try {
          toBytes(value);
          return false;
        } catch (error) {
          return error instanceof TypeError && error.message.includes("[object ");
        }
      }),
    );
    const foreignBuffer = runInNewContext("new Uint8Array([10, 11, 12]).buffer") as ArrayBuffer;
    const foreignBytes = runInNewContext("new Uint8Array([10, 11, 12])") as Uint8Array;
    check(
      "toBytes：别的运行环境造出来的 ArrayBuffer / Uint8Array 也认（instanceof 对它们不成立）",
      !(foreignBuffer instanceof ArrayBuffer) && !(foreignBytes instanceof Uint8Array) && toHex(toBytes(foreignBuffer)) === "0a0b0c" && toHex(toBytes(foreignBytes)) === "0a0b0c",
    );

    // ---- prepareShortcut 的类型拦截：ArrayBuffer 混进来要点名，不能再说「认不出这个文件」 ----
    const guardMessage = (value: unknown): string => {
      try {
        prepareShortcut(value as Uint8Array);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const wrongType = guardMessage(new ArrayBuffer(8));
    check("prepareShortcut 拦下非字节数组并点名类型（不再误报「认不出这个文件」）", wrongType.includes("内部错误") && wrongType.includes("ArrayBuffer") && !wrongType.includes("认不出"));
    const foreignNope = runInNewContext("new Uint8Array([110, 111, 112, 101])") as Uint8Array;
    check("别的运行环境造出来的 Uint8Array 不会被这道拦截误伤", guardMessage(foreignNope).includes("认不出") && !guardMessage(foreignNope).includes("内部错误"));

    // ---- 选文件：readAsBytesSync 回 ArrayBuffer（真机行为） ----
    const identity = createIdentity({ random: rnd });
    const sample = utf8(SAMPLE_SHORTCUT_XML);
    let picked: string[] | undefined = [
      "/var/mobile/Documents/签名测试.shortcut",
      "/var/mobile/Documents/big.bin",
      "/var/mobile/Documents/broken.shortcut",
    ];
    g.DocumentPicker = { pickFiles: async () => picked };
    g.FileManager = {
      statSync: (path: string) => ({ size: path.endsWith("big.bin") ? 25 * 1024 * 1024 : sample.length }),
      readAsBytesSync: (path: string) => {
        if (path.endsWith("broken.shortcut")) throw new Error("Operation not permitted");
        return sample.slice().buffer;
      },
    };
    const sources = await pickFromFiles();
    const [first, second, third] = sources;
    check(
      "选文件：readAsBytesSync 回 ArrayBuffer 时，读出来的也是真正的 Uint8Array",
      sources.length === 3 && !isFailure(first) && first.name === "签名测试.shortcut" && first.bytes instanceof Uint8Array && first.bytes.length === sample.length,
    );
    const signedPicked = isFailure(first) ? null : signChecked(first.bytes, identity, { decompress: noDecompress });
    check("选文件读回来的内容能直接签（真机上这里曾被判成「认不出这个文件」）", signedPicked !== null && signedPicked.ok && signedPicked.name === "签名测试");
    check(
      "选文件：太大的、读不了的各成一条失败记录，不拖累别的",
      isFailure(second) && second.error.includes("太大") && isFailure(third) && third.error.includes("读不了") && third.error.includes("Operation not permitted"),
    );
    picked = undefined;
    check("选文件：取消（回 undefined）→ 空列表", (await pickFromFiles()).length === 0);
    picked = [];
    check("选文件：取消（回空数组）→ 空列表", (await pickFromFiles()).length === 0);

    // ---- 分享面板递来的文件（intent.tsx 走 sourcesFromPaths）：路径先还原再读，读出来的同样是 Uint8Array ----
    const touched: string[] = [];
    g.FileManager = {
      statSync: (path: string) => {
        touched.push(path);
        return { size: sample.length };
      },
      readAsBytesSync: () => sample.slice().buffer,
    };
    const shared = sourcesFromPaths(["file:///var/mobile/Shared/%E7%AD%BE.shortcut", "/var/mobile/Shared/第二个.shortcut"]);
    const [sharedFirst, sharedSecond] = shared;
    check(
      "分享来的文件：file:// 先还原成路径再读，名字取对，字节是真正的 Uint8Array",
      shared.length === 2 &&
        touched[0] === "/var/mobile/Shared/签.shortcut" &&
        !isFailure(sharedFirst) &&
        sharedFirst.name === "签.shortcut" &&
        sharedFirst.bytes instanceof Uint8Array &&
        !isFailure(sharedSecond) &&
        sharedSecond.name === "第二个.shortcut",
    );
    const sharedSigned = isFailure(sharedFirst) ? null : signChecked(sharedFirst.bytes, identity, { decompress: noDecompress });
    check("分享来的文件能直接签", sharedSigned !== null && sharedSigned.ok && sharedSigned.name === "签名测试");
    check("分享来的文件：没有文件 → 空列表", sourcesFromPaths([]).length === 0);

    // ---- 剪贴板 ----
    let clip: unknown = SAMPLE_SHORTCUT_XML;
    g.Pasteboard = { getString: async () => clip };
    const fromClip = await pickFromClipboard();
    check("剪贴板：文字按 UTF-8 转成 Uint8Array", fromClip.name === "剪贴板" && fromClip.bytes instanceof Uint8Array && toHex(fromClip.bytes) === toHex(sample));
    clip = undefined;
    check("剪贴板：没内容（undefined）时报明白的错", await rejectsWith(() => pickFromClipboard(), "剪贴板里没有文字"));
    clip = "  \n ";
    check("剪贴板：只有空白也算没内容", await rejectsWith(() => pickFromClipboard(), "剪贴板里没有文字"));

    // ---- 链接 ----
    const requested: string[] = [];
    let reply: { ok: boolean; status: number; arrayBuffer: () => Promise<unknown> } = {
      ok: true,
      status: 200,
      arrayBuffer: async () => sample.slice().buffer,
    };
    g.fetch = async (url: string) => {
      requested.push(url);
      return reply;
    };
    const fromUrl = await pickFromUrl("  https://example.com/a/%E7%AD%BE.shortcut?dl=1  ");
    check(
      "链接：前后空白去掉、文件名取自路径、内容是 Uint8Array",
      requested[0] === "https://example.com/a/%E7%AD%BE.shortcut?dl=1" && fromUrl.name === "签.shortcut" && fromUrl.bytes instanceof Uint8Array && fromUrl.bytes.length === sample.length,
    );
    check("链接：不是 https 给明白的错，也不会发出请求", (await rejectsWith(() => pickFromUrl("http://example.com/a.shortcut"), "https")) && requested.length === 1);
    check("链接：iCloud 分享链接给明白的说法", await rejectsWith(() => pickFromUrl("https://www.icloud.com/shortcuts/abc123"), "iCloud"));
    reply = { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    check("链接：HTTP 出错时报状态码", await rejectsWith(() => pickFromUrl("https://example.com/a.shortcut"), "404"));

    // ---- Dialog.prompt：取消回 undefined（真机行为） ----
    const asked: unknown[] = [];
    let answer: unknown;
    g.Dialog = {
      prompt: async (options: unknown) => {
        asked.push(options);
        return answer;
      },
    };
    answer = undefined;
    check("promptText：取消（回 undefined）→ null", (await promptText({ title: "t" })) === null);
    answer = null;
    check("promptText：取消（回 null）→ null", (await promptText({ title: "t" })) === null);
    answer = "";
    check("promptText：点了确认但留空 → 空串（和取消分得开）", (await promptText({ title: "t" })) === "");
    answer = "  https://x  ";
    const options = { title: "标题", placeholder: "占位" };
    check("promptText：有输入原样返回，选项原样传给 Dialog.prompt", (await promptText(options)) === "  https://x  " && asked[asked.length - 1] === options);

    // ---- 界面文案：链接框的提示用汉字，不是示例网址 ----
    const scriptRoot = join(process.cwd(), "快捷指令签名");
    const appPath = join(scriptRoot, "pages", "App.tsx");
    if (existsSync(appPath)) {
      const app = readFileSync(appPath, "utf8");
      check("链接输入框的提示是中文，不是示例网址", app.includes('placeholder: "粘贴 .shortcut 后缀的链接"') && !app.includes("example.com"));
    }

    // ---- 分享入口：script.json 声明 + intent.tsx 缺一不可（只声明不建文件，脚本不会出现在分享面板里） ----
    if (existsSync(scriptRoot)) {
      const manifest = JSON.parse(readFileSync(join(scriptRoot, "script.json"), "utf8")) as {
        entry?: string;
        intentInputTypes?: string[];
        runInApp?: boolean;
      };
      check(
        "分享入口：script.json 声明收文件（FileURLs）、在主程序里跑（大文件不受分享扩展内存限制）",
        manifest.intentInputTypes?.includes("FileURLs") === true && manifest.runInApp === true && manifest.entry === "index.tsx",
      );
      const intentPath = join(scriptRoot, "intent.tsx");
      check(
        "分享入口：intent.tsx 与 index.tsx 同级，读 fileURLsParameter 交给首页",
        existsSync(intentPath) &&
          existsSync(join(scriptRoot, manifest.entry ?? "index.tsx")) &&
          /Intent\.fileURLsParameter/.test(readFileSync(intentPath, "utf8")) &&
          /sourcesFromPaths/.test(readFileSync(intentPath, "utf8")),
      );
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// 结构检查（core/check.ts）：规则移植自用户之前的 shortcut-skill，那份的三个 fixture 原样搬来当用例
// ---------------------------------------------------------------------------

/** 变量引用在文本里占的位（U+FFFC）。用 fromCharCode 写，免得源码里放一个看不见的字符。 */
const OBJ = String.fromCharCode(0xfffc);

const FIXTURE_VALID = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>WFWorkflowActions</key>
<array>
<dict>
<key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gettext</string>
<key>WFWorkflowActionParameters</key>
<dict><key>UUID</key><string>A1111111-1111-4111-8111-111111111111</string><key>WFTextActionText</key><string>Hello</string></dict>
</dict>
<dict>
<key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.showresult</string>
<key>WFWorkflowActionParameters</key>
<dict>
<key>Text</key>
<dict>
<key>Value</key>
<dict>
<key>attachmentsByRange</key>
<dict><key>{0, 1}</key><dict><key>OutputName</key><string>Text</string><key>OutputUUID</key><string>A1111111-1111-4111-8111-111111111111</string><key>Type</key><string>ActionOutput</string></dict></dict>
<key>string</key><string>${OBJ}</string>
</dict>
<key>WFSerializationType</key><string>WFTextTokenString</string>
</dict>
</dict>
</dict>
</array>
<key>WFWorkflowName</key><string>最小有效 Shortcut</string>
<key>WFWorkflowClientVersion</key><string>2700.0.4</string>
</dict>
</plist>
`;

const FIXTURE_INVALID = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>WFWorkflowActions</key><array>
<dict>
<key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gettext</string>
<key>WFWorkflowActionParameters</key><dict><key>UUID</key><string>11111111-1111-1111-1111-111111111111</string></dict>
</dict>
<dict>
<key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.showresult</string>
<key>WFWorkflowActionParameters</key><dict>
<key>Text</key><dict><key>Value</key><dict><key>attachmentsByRange</key><dict><key>{0, 2}</key><dict><key>OutputUUID</key><string>99999999-9999-9999-9999-999999999999</string><key>Type</key><string>ActionOutput</string></dict></dict><key>string</key><string>${OBJ}</string></dict></dict>
</dict>
</dict>
</array>
<key>WFWorkflowName</key><string>无效 Shortcut</string>
</dict></plist>
`;

const FIXTURE_CONTROL_ORDER = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>WFWorkflowActions</key><array>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string><key>WFWorkflowActionParameters</key><dict><key>GroupingIdentifier</key><string>B1111111-1111-4111-8111-111111111111</string><key>WFControlFlowMode</key><integer>0</integer></dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string><key>WFWorkflowActionParameters</key><dict><key>GroupingIdentifier</key><string>B1111111-1111-4111-8111-111111111111</string><key>WFControlFlowMode</key><integer>2</integer></dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string><key>WFWorkflowActionParameters</key><dict><key>GroupingIdentifier</key><string>B1111111-1111-4111-8111-111111111111</string><key>WFControlFlowMode</key><integer>1</integer></dict></dict>
</array><key>WFWorkflowName</key><string>控制流顺序错误</string></dict></plist>
`;

const issueCodes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

/** 用对象拼一份快捷指令：先编成 XML 再解析回来，和真实输入走同一条路（字典读出来是 Map）。 */
function workflowOf(actions: unknown[], extra: Record<string, unknown> = {}): PlistValue {
  return parsePlist(encodeXmlPlist({ WFWorkflowName: "测试", WFWorkflowActions: actions, ...extra } as Record<string, PlistValue>));
}

const ACTION_UUID = "A2222222-2222-4222-8222-222222222222";
const action = (identifier: string, parameters: Record<string, unknown> = {}) => ({
  WFWorkflowActionIdentifier: identifier,
  WFWorkflowActionParameters: parameters,
});

/**
 * 本机 24 个 Apple 签名的真实快捷指令（自测目录里的 gNN.shortcut + gNN.aar，不随脚本分发）读成 plist 值。
 * 没有样本回 null——用到它的测试就跳过。可以用 SIGNER_GOLDEN 指到别处。
 */
function goldenSamples(): { name: string; workflow: PlistValue }[] | null {
  const dir = process.env.SIGNER_GOLDEN ?? join(process.cwd(), "_selftest", "shortcut-signer-golden");
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".shortcut")).sort() : [];
  if (names.length === 0) return null;
  return names.map((name) => {
    const signed = new Uint8Array(readFileSync(join(dir, name)));
    const archive = new Uint8Array(readFileSync(join(dir, name.replace(/\.shortcut$/, ".aar"))));
    return { name, workflow: readWorkflow(signed, { decompress: () => archive }).workflow };
  });
}

function testCheck(): void {
  console.log("结构检查（移植自用户之前的 shortcut-skill 的检查器）");
  const parsed = (xml: string): PlistValue => parsePlist(utf8(xml));

  // ---- 三个原 fixture ----
  const valid = checkWorkflow(parsed(FIXTURE_VALID));
  check(
    "fixture 有效：ok、2 个动作、0 个错误，只有「第二个动作没有 UUID」的警告",
    valid.ok && valid.actionCount === 2 && valid.errors.length === 0 && valid.actionUUIDs.join() === "A1111111-1111-4111-8111-111111111111" && issueCodes(valid.warnings).join() === "missing_uuid",
  );
  const invalid = checkWorkflow(parsed(FIXTURE_INVALID));
  check(
    "fixture 无效：检出 invalid_uuid、range_out_of_bounds、unknown_output_uuid（和原报告一致），不多不少",
    !invalid.ok && issueCodes(invalid.errors).join() === "invalid_uuid,range_out_of_bounds,unknown_output_uuid",
  );
  check("fixture 无效：错误带位置，范围错误指到那个键", invalid.errors[1].path === "$.WFWorkflowActions[1].attachmentsByRange.{0, 2}" && invalid.errors[0].path.endsWith(".UUID"));
  const order = checkWorkflow(parsed(FIXTURE_CONTROL_ORDER));
  check("fixture 控制流顺序错（0,2,1）：只报 control_group_order，开始 / 结束数量是对的所以不报失衡", !order.ok && issueCodes(order.errors).join() === "control_group_order" && order.errors[0].message.includes("0,2,1"));

  // ---- 外层和动作的基本结构 ----
  check("顶层不是字典：root_not_dict", issueCodes(checkWorkflow(parsePlist(encodeXmlPlist([1, 2]))).errors).join() === "root_not_dict");
  const bare = checkWorkflow(parsePlist(encodeXmlPlist({})));
  check("什么都没有：缺 WFWorkflowActions 是错误，缺名字只是警告", issueCodes(bare.errors).join() === "missing_actions" && issueCodes(bare.warnings).join() === "missing_name");
  const blankName = checkWorkflow(workflowOf([], { WFWorkflowName: "   " }));
  check("名字是空白也算没有，但只是警告", blankName.ok && issueCodes(blankName.warnings).join() === "missing_name");
  const noName = checkWorkflow(parsePlist(encodeXmlPlist({ WFWorkflowActions: [action("is.workflow.actions.gettext", { UUID: ACTION_UUID })] } as Record<string, PlistValue>)));
  check("没有 WFWorkflowName 的真实形状（真实导出的快捷指令都这样）：通过，只有名字的警告", noName.ok && issueCodes(noName.warnings).join() === "missing_name" && noName.errors.length === 0);
  const strictNoName = checkWorkflow(parsePlist(encodeXmlPlist({ WFWorkflowActions: [] } as Record<string, PlistValue>)), { strict: true });
  check("严格模式下没有名字才算错误：strict_missing_name", !strictNoName.ok && issueCodes(strictNoName.errors).join() === "strict_missing_name");
  check(
    "动作不是字典 / 缺标识 / 缺参数：各报各的",
    issueCodes(checkWorkflow(workflowOf(["不是字典", { WFWorkflowActionParameters: {} }, { WFWorkflowActionIdentifier: "x.y" }])).errors).join() ===
      "action_not_dict,missing_action_identifier,missing_action_parameters",
  );

  // ---- UUID ----
  const dup = checkWorkflow(workflowOf([action("is.workflow.actions.gettext", { UUID: ACTION_UUID }), action("is.workflow.actions.gettext", { UUID: ACTION_UUID })]));
  check("动作 UUID 重复：duplicate_uuid", issueCodes(dup.errors).join() === "duplicate_uuid" && dup.actionUUIDs.length === 2);
  check("没有 UUID 的动作给警告，注释动作例外", issueCodes(checkWorkflow(workflowOf([action("is.workflow.actions.gettext"), action("is.workflow.actions.comment")])).warnings).join() === "missing_uuid");
  check("UUID 形状：第三段 / 第四段的首位不对就报 invalid_uuid，Shortcuts 自己的版本 4 能过", issueCodes(checkWorkflow(workflowOf([action("a.b", { UUID: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" })])).errors).join() === "invalid_uuid" && checkWorkflow(workflowOf([action("a.b", { UUID: ACTION_UUID })])).ok);

  // ---- 控制流 ----
  const group = "C3333333-3333-4333-8333-333333333333";
  const flow = (...modes: number[]) => modes.map((mode) => action("is.workflow.actions.conditional", { GroupingIdentifier: group, WFControlFlowMode: mode }));
  check("控制流 0,1,2 正常；0,1,1,2 也正常", checkWorkflow(workflowOf(flow(0, 1, 2))).ok && checkWorkflow(workflowOf(flow(0, 1, 1, 2))).errors.length === 0);
  check("控制流两个开始：control_group_unbalanced 和顺序错一起报", issueCodes(checkWorkflow(workflowOf(flow(0, 0, 2))).errors).join() === "control_group_unbalanced,control_group_order");
  check(
    "控制流缺分组 / 模式不是 0 1 2",
    issueCodes(checkWorkflow(workflowOf([action("is.workflow.actions.conditional", { WFControlFlowMode: 0 })])).errors).includes("control_missing_group") &&
      issueCodes(checkWorkflow(workflowOf([action("is.workflow.actions.conditional", { GroupingIdentifier: group, WFControlFlowMode: 3 })])).errors).includes("control_invalid_mode"),
  );

  // ---- App Intent ----
  const scripting = (extra: Record<string, unknown> = {}, id = "com.scripting.ios.RunScriptIntent") =>
    action(id, {
      UUID: ACTION_UUID,
      AppIntentDescriptor: { BundleIdentifier: "com.scripting.ios", AppIntentIdentifier: "RunScriptIntent", Name: "Scripting", TeamIdentifier: "58P5F4LJ36", ...extra },
    });
  check("Scripting 的 App Intent 动作：描述自洽就通过", checkWorkflow(workflowOf([scripting()])).ok);
  check("标识和描述对不上：intent_descriptor_mismatch", issueCodes(checkWorkflow(workflowOf([scripting({}, "wrong")])).errors).join() === "intent_descriptor_mismatch");
  check("Scripting 的动作缺团队标识：scripting_descriptor_invalid", issueCodes(checkWorkflow(workflowOf([scripting({ TeamIdentifier: "0000000000" })])).errors).join() === "scripting_descriptor_invalid");

  // ---- 变量引用 ----
  const text = (token: unknown, string = OBJ, key = "{0, 1}") => ({ Text: { Value: { string, attachmentsByRange: { [key]: token } }, WFSerializationType: "WFTextTokenString" } });
  const source = action("is.workflow.actions.gettext", { UUID: ACTION_UUID, WFTextActionText: "x" });
  const withRef = (parameters: Record<string, unknown>) => workflowOf([source, action("is.workflow.actions.showresult", { UUID: "E5555555-5555-4555-8555-555555555555", ...parameters })]);
  const output = { Type: "ActionOutput", OutputUUID: ACTION_UUID, OutputName: "Text" };
  check("变量引用：指向存在的动作 UUID、范围盖住占位符，通过", checkWorkflow(withRef(text(output))).ok);
  check("变量引用：OutputUUID 对不上：unknown_output_uuid", issueCodes(checkWorkflow(withRef(text({ ...output, OutputUUID: "F6666666-6666-4666-8666-666666666666" }))).errors).join() === "unknown_output_uuid");
  check("变量引用：ActionOutput 没有 OutputUUID：invalid_output_token", issueCodes(checkWorkflow(withRef(text({ Type: "ActionOutput", OutputName: "Text" }))).errors).join() === "invalid_output_token");
  check("变量引用：没有 Type：missing_token_type", issueCodes(checkWorkflow(withRef(text({ OutputUUID: ACTION_UUID }))).errors).join() === "missing_token_type");
  check(
    "变量引用：别的类型（Variable / ExtensionInput / Ask / AskEachTime…）不报错也不警告——和原版的有意不同，原版会把它们都当错误",
    ["Variable", "ExtensionInput", "Ask", "AskEachTime", "CurrentDate", "Clipboard"].every((type) => {
      const result = checkWorkflow(withRef(text({ Type: type, VariableName: "x" })));
      return result.ok && result.warnings.every((warning) => warning.code === "missing_uuid");
    }),
  );
  check("变量引用：不认识的类型只给警告 unknown_token_type", (() => {
    const result = checkWorkflow(withRef(text({ Type: "SomethingNew" })));
    return result.ok && issueCodes(result.warnings).includes("unknown_token_type");
  })());
  check("ActionOutput 没有 OutputName：只给警告", (() => {
    const result = checkWorkflow(withRef(text({ Type: "ActionOutput", OutputUUID: ACTION_UUID })));
    return result.ok && issueCodes(result.warnings).includes("missing_output_name");
  })());
  check("范围写法不对（{a,b}）：invalid_range", issueCodes(checkWorkflow(withRef(text(output, OBJ, "{a,b}"))).errors).includes("invalid_range"));
  check("范围没盖住占位符：range_missing_placeholder", issueCodes(checkWorkflow(withRef(text(output, "abc"))).errors).join() === "range_missing_placeholder");
  check("范围盖住占位符就行，不要求在开头：「前缀￼」用 {2, 1}", checkWorkflow(withRef(text(output, `前缀${OBJ}`, "{2, 1}"))).ok);
  check("范围超出文本长度：range_out_of_bounds", issueCodes(checkWorkflow(withRef(text(output, OBJ, "{0, 5}"))).errors).join() === "range_out_of_bounds");
  check(
    "单独的变量附件（WFTextTokenAttachment）：Value 缺 OutputUUID 报错，引用对得上才通过",
    issueCodes(checkWorkflow(withRef({ Text: { Value: { Type: "ActionOutput" }, WFSerializationType: "WFTextTokenAttachment" } })).errors).includes("invalid_output_token") &&
      checkWorkflow(withRef({ Text: { Value: output, WFSerializationType: "WFTextTokenAttachment" } })).ok,
  );
  check(
    "单独的变量附件：Value 不是字典 → invalid_output_token；Value 没有 Type → missing_token_type；不认识的类型只给警告",
    issueCodes(checkWorkflow(withRef({ Text: { Value: "oops", WFSerializationType: "WFTextTokenAttachment" } })).errors).join() === "invalid_output_token" &&
      issueCodes(checkWorkflow(withRef({ Text: { Value: { OutputUUID: ACTION_UUID }, WFSerializationType: "WFTextTokenAttachment" } })).errors).join() === "missing_token_type" &&
      (() => {
        const result = checkWorkflow(withRef({ Text: { Value: { Type: "SomethingNew" }, WFSerializationType: "WFTextTokenAttachment" } }));
        return result.ok && issueCodes(result.warnings).includes("unknown_token_type");
      })(),
  );

  // ---- 动作标识在不在知识库里 ----
  const typo = checkWorkflow(workflowOf([action("is.workflow.actions.notificaton", { UUID: ACTION_UUID })]));
  check(
    "系统动作的标识不在知识库里：只给警告 unknown_action（拼错了、凭记忆编的），位置指到标识",
    typo.ok && issueCodes(typo.warnings).join() === "unknown_action" && typo.warnings[0].path === "$.WFWorkflowActions[0].WFWorkflowActionIdentifier" && typo.warnings[0].message.includes("notificaton"),
  );
  check(
    "知识库里登记过的、第三方 App 的（不是 is.workflow.actions. 开头的）都不警告",
    checkWorkflow(workflowOf([action("is.workflow.actions.notification", { UUID: ACTION_UUID }), action("com.example.SomeIntent", { UUID: "B3333333-3333-4333-8333-333333333333" })])).warnings.length === 0,
  );
  check(
    "严格模式下 unknown_action 才算错误：strict_unknown_action",
    issueCodes(checkWorkflow(workflowOf([action("is.workflow.actions.notificaton", { UUID: ACTION_UUID })]), { strict: true }).errors).join() === "strict_unknown_action",
  );

  // ---- 严格模式 ----
  const strictResult = checkWorkflow(workflowOf([action("is.workflow.actions.gettext")]), { strict: true });
  check("严格模式：警告变成错误，错误码加 strict_ 前缀", !strictResult.ok && issueCodes(strictResult.errors).join() === "strict_missing_uuid" && strictResult.warnings.length === 1);

  // ---- 我们自己的两份：内置测试快捷指令和技能模板都得过检查 ----
  check("内置的测试快捷指令能过检查（只有「没有 UUID」的警告）", (() => {
    const result = checkWorkflow(parsePlist(utf8(SAMPLE_SHORTCUT_XML)));
    return result.ok && result.warnings.every((warning) => warning.code === "missing_uuid");
  })());

  // ---- 真实样本：Apple 签名的真实快捷指令不该被判有错 ----
  // 移植过来的检查器原本把「没有 WFWorkflowName」当错误，24 个真实样本全军覆没（它们的 Shortcut.wflow 里都没有这个键）。
  // 有样本时把它们全跑一遍，要求没有错误；警告不管（没有 UUID 的动作很多，是正常的）。没有样本就跳过
  const samples = goldenSamples();
  if (samples === null) {
    console.log("  - 没有 Apple 样本（_selftest/shortcut-signer-golden 或 SIGNER_GOLDEN），跳过「真实样本不误报」");
  } else {
    const wrong = samples.flatMap(({ name, workflow }) => {
      const result = checkWorkflow(workflow);
      return result.ok ? [] : [`${name}：${issueCodes(result.errors).join(",")}`];
    });
    check(`真实样本不误报：${samples.length} 个 Apple 签名的真实快捷指令全部通过检查（没有错误）${wrong.length ? "，没通过：" + wrong.join("；") : ""}`, wrong.length === 0);
    // 知识库里的动作就是从这些样本里挖出来的，所以它们里面不该有哪个动作被 unknown_action 警告
    const unknownInSamples = samples.flatMap(({ name, workflow }) =>
      checkWorkflow(workflow).warnings.filter((issue) => issue.code === "unknown_action").map((issue) => `${name}：${issue.message.slice(0, 60)}`),
    );
    check(`真实样本里没有一个动作被 unknown_action 警告${unknownInSamples.length ? "：" + unknownInSamples.slice(0, 3).join("；") : ""}`, unknownInSamples.length === 0);
  }

  // ---- actionIdentifiers ----
  check("actionIdentifiers：按顺序，读不出的是 unknown", actionIdentifiers([new Map([["WFWorkflowActionIdentifier", "a.b"]]), "x", new Map()]).join() === "a.b,unknown,unknown");

  // ---- readWorkflow（check 和 sign 共用的「认格式并解析」） ----
  const bplist = encodeBplist(parsed(FIXTURE_VALID));
  const viaXml = readWorkflow(utf8(FIXTURE_VALID));
  const viaBplist = readWorkflow(bplist);
  check("readWorkflow：XML 来料没有现成的二进制（payload 为 null），二进制来料原样当 payload", viaXml.source === "xml" && viaXml.payload === null && viaBplist.source === "bplist" && viaBplist.payload === bplist);
  const identityForRead = createIdentity({ random: rnd });
  const signedForRead = signShortcut(utf8(SAMPLE_SHORTCUT_XML), identityForRead, { random: rnd });
  const viaSigned = readWorkflow(signedForRead.data);
  check("readWorkflow：已签名的来料拆出里面的二进制 plist", viaSigned.source === "signed" && viaSigned.payload !== null && isDict(viaSigned.workflow));
  check("readWorkflow 不要求是快捷指令（那是检查器的事），prepareShortcut 才要求", readWorkflow(utf8("<plist><dict/></plist>")).source === "xml" && throwsError(() => prepareShortcut(utf8("<plist><dict/></plist>"))));
  check("readWorkflow：认不出的、空的、网页，照样给明白的错", throwsError(() => readWorkflow(utf8("hello"))) && throwsError(() => readWorkflow(new Uint8Array(0))) && throwsError(() => readWorkflow(utf8("<html></html>"))));
}

/**
 * 无界面 API（kit/api.ts）：AI 技能经 Script.run 调用的那个入口。
 * 用内存里的假文件系统 + 假钥匙串验，不碰界面。
 */
async function testApi(): Promise<void> {
  console.log("无界面 API（给 AI 技能用）");
  const g = globalThis as Record<string, unknown>;
  const saved = { FileManager: g.FileManager, Keychain: g.Keychain, Storage: g.Storage };
  try {
    const { keychain, failWrites } = installFakeStores();
    resetCacheForTests();

    // 内存里的文件系统：路径 → 字节
    const files = new Map<string, Uint8Array>();
    const dirs = new Set<string>();
    g.FileManager = {
      temporaryDirectory: "/var/tmp/", // 末尾带斜杠，验 joinPath
      exists: async (path: string) => files.has(path) || dirs.has(path),
      createDirectory: async (path: string) => void dirs.add(path),
      writeAsBytes: async (path: string, bytes: Uint8Array) => void files.set(path, bytes.slice()),
      statSync: (path: string) => {
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error("No such file or directory");
        return { size: bytes.length };
      },
      readAsBytesSync: (path: string) => {
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error("No such file or directory");
        return bytes.slice().buffer; // 真机行为：ArrayBuffer
      },
    };
    files.set("/ws/签名测试.plist", utf8(SAMPLE_SHORTCUT_XML));

    check("API_ACTIONS 就是 status / check / sign", API_ACTIONS.join() === "status,check,sign");
    check(
      "isApiRequest：只认带非空字符串 action 的对象",
      isApiRequest({ action: "sign" }) &&
        !isApiRequest({}) &&
        !isApiRequest({ action: "" }) &&
        !isApiRequest({ action: 1 }) &&
        !isApiRequest(undefined) &&
        !isApiRequest(null) &&
        !isApiRequest("sign"),
    );

    // ---- status ----
    const first = (await handleApiRequest({ action: "status" })) as ApiStatusResult;
    check(
      "status：还没有身份时如实说，并告诉下一步",
      first.ok && first.action === "status" && first.apiVersion === API_VERSION && !first.certificate.generated && !first.certificate.usable && (first.nextStep ?? "").includes("还没有签名身份"),
    );
    check("status 只读，不会生成身份", keychain.size === 0);

    // ---- 参数校验：在还没有身份的时候跑，才能证明校验没通过的请求不会生成身份、不会写文件 ----
    const failures = (await Promise.all([
      handleApiRequest({ action: "sign" }),
      handleApiRequest({ action: "sign", paths: [123, "", null] }),
      handleApiRequest({ action: "sign", paths: Array.from({ length: 21 }, (_, index) => `/ws/${index}.plist`) }),
      handleApiRequest({ action: "sign", paths: ["relative/a.plist"] }),
      handleApiRequest({ action: "sign", paths: ["/ws/签名测试.plist"], outputDir: "relative/dir" }),
      handleApiRequest({ action: "sign", paths: ["/ws/签名测试.plist"], outputDir: 123 }),
      handleApiRequest({ action: "frobnicate" }),
      handleApiRequest({ action: { not: "a string" } }),
    ])) as ApiFailure[];
    check(
      "校验：缺路径 / 路径全无效 / 太多 / 相对路径 / 坏的 outputDir / 不认识的 action，都是 validation 错误",
      failures.every((result) => !result.ok && result.error.type === "validation" && result.apiVersion === API_VERSION),
    );
    check(
      "校验：报错信息说得清",
      failures[0].error.message.includes("paths") &&
        failures[2].error.message.includes("20") &&
        failures[3].error.message.includes("绝对路径") &&
        failures[6].error.message.includes("status、check、sign"),
    );
    check("校验没通过的请求不会生成身份、不会写文件", keychain.size === 0 && files.size === 1 && dirs.size === 0);

    // ---- check：只读的结构检查，不需要身份，不写文件 ----
    files.set("/ws/最小有效.plist", utf8(FIXTURE_VALID));
    files.set("/ws/无效.plist", utf8(FIXTURE_INVALID));
    files.set("/ws/不是快捷指令.zip", concat(Uint8Array.of(0x50, 0x4b, 0x03, 0x04), rnd(40)));
    const checked = (await handleApiRequest({
      action: "check",
      paths: ["/ws/最小有效.plist", "/ws/无效.plist", "/ws/签名测试.plist", "/ws/不是快捷指令.zip", "/ws/不存在.plist"],
    })) as ApiCheckResult;
    const [c0, c1, c2, c3, c4] = checked.items;
    check(
      "check：一批里好坏混着，各管各的；整体 ok 只表示请求处理了",
      checked.ok && checked.action === "check" && checked.checkedCount === 5 && checked.passedCount === 2 && checked.failedCount === 3,
    );
    check(
      "check：通过的带动作数、动作标识、来料类型和警告数",
      c0.ok &&
        c0.actionCount === 2 &&
        c0.actionIds?.join() === "is.workflow.actions.gettext,is.workflow.actions.showresult" &&
        c0.inputKind === "xml" &&
        c0.errorCount === 0 &&
        c0.warningCount === 1,
    );
    check(
      "check：没通过的列出带错误码和位置的问题",
      !c1.ok && c1.errors.map((issue) => issue.code).join() === "invalid_uuid,range_out_of_bounds,unknown_output_uuid" && c1.errorCount === 3 && c1.errors[0].path.endsWith(".UUID"),
    );
    check("check：内置的测试快捷指令通过", c2.ok);
    check(
      "check：认不出的文件、读不了的路径，记成 unreadable 错误并写明原因，不拖累别的",
      !c3.ok && c3.errors[0].code === "unreadable" && c3.errors[0].message.includes("zip") && !c4.ok && c4.errors[0].code === "unreadable" && c4.errors[0].message.includes("读不了"),
    );
    check("check 不需要身份：没有生成身份、没有写任何文件", keychain.size === 0 && files.size === 4 && dirs.size === 0);
    const passedOnly = (await handleApiRequest({ action: "check", path: "/ws/最小有效.plist" })) as ApiCheckResult;
    check(
      "check：全部通过时 nextStep 说可以 sign 并提醒仍要试跑；有没通过的说要改",
      (passedOnly.nextStep ?? "").includes("可以 sign") && (passedOnly.nextStep ?? "").includes("试跑") && (checked.nextStep ?? "").includes("3 份没通过"),
    );
    const strictChecked = (await handleApiRequest({ action: "check", path: "/ws/最小有效.plist", strict: true })) as ApiCheckResult;
    check("check：strict 把警告当错误", !strictChecked.items[0].ok && strictChecked.items[0].errors[0].code === "strict_missing_uuid");
    // 前 60 个动作 UUID 写坏（60 条错误），后 60 个没有 UUID（60 条警告）：错误和警告各超过 50 条
    files.set(
      "/ws/很多问题.plist",
      encodeXmlPlist({
        WFWorkflowName: "很多问题",
        WFWorkflowActions: Array.from({ length: 120 }, (_, index) => ({
          WFWorkflowActionIdentifier: "is.workflow.actions.gettext",
          WFWorkflowActionParameters: index < 60 ? { UUID: `bad-${index}` } : {},
        })),
      }),
    );
    const many = (await handleApiRequest({ action: "check", path: "/ws/很多问题.plist" })) as ApiCheckResult;
    check(
      "check：错误和警告太多时各列前 50 条、总数另报；动作标识最多 100 个",
      !many.items[0].ok &&
        many.items[0].errorCount === 60 &&
        many.items[0].errors.length === 50 &&
        many.items[0].warningCount === 60 &&
        many.items[0].warnings.length === 50 &&
        many.items[0].actionCount === 120 &&
        many.items[0].actionIds?.length === 100,
    );
    check("check：参数校验和 sign 一样（没给路径是 validation 错误）", (await handleApiRequest({ action: "check" })).ok === false);

    // ---- sign ----
    const signed = (await handleApiRequest({ action: "sign", paths: ["/ws/签名测试.plist"] })) as ApiSignResult;
    const item = signed.items[0];
    check(
      "sign：签好一份，写进临时工作目录（末尾带斜杠的临时目录也拼得对）",
      signed.ok && signed.signedCount === 1 && signed.failedCount === 0 && item.ok && item.path === "/var/tmp/ShortcutSigner/签名测试.shortcut" && files.has(item.path),
    );
    const identity = readIdentity();
    check("sign：没有身份就自动生成，写进了钥匙串", identity !== null && keychain.size === 1);
    const writtenBytes = item.ok ? files.get(item.path) : undefined;
    check(
      "sign：写出的文件自检通过（和 Apple 校验的同一套）",
      identity !== null && writtenBytes !== undefined && verifyAea(writtenBytes, encodePoint(identity.leafPublicKey), noDecompress).ok,
    );
    check(
      "sign：结果里带名字、动作数、动作标识、来料类型",
      item.ok && item.name === "签名测试" && item.actionCount === 1 && item.actionIds.join() === "is.workflow.actions.alert" && !item.actionIdsTruncated && item.inputKind === "xml" && !item.resigned,
    );
    check(
      "sign：证书还没确认装好时，结果里明说，不能让 AI 说成能导入",
      signed.certificate.generated && !signed.certificate.usable && !signed.certificate.confirmedInstalled && (signed.nextStep ?? "").includes("还没确认装好"),
    );
    check(
      "证书信息：名称 / 指纹 / 有效期",
      /^Shortcut Signer Root [0-9a-f]{4}$/.test(signed.certificate.name ?? "") &&
        /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(signed.certificate.fingerprint ?? "") &&
        /^\d{4}-\d{2}-\d{2}$/.test(signed.certificate.expires ?? ""),
    );

    // ---- 用户确认装好信任之后 ----
    setCertificateReady(true);
    const ready = (await handleApiRequest({ action: "status" })) as ApiStatusResult;
    check("status：用户确认装好信任后 usable 为真，没有待办", ready.certificate.usable && ready.certificate.confirmedInstalled && ready.nextStep === null);
    const again = (await handleApiRequest({ action: "sign", path: "/ws/签名测试.plist", outputDir: "/ws/out" })) as ApiSignResult;
    check(
      "sign：path 传单个字符串也行；outputDir 写到指定目录；证书可用时提示去导入",
      again.signedCount === 1 && again.items[0].ok && again.items[0].path === "/ws/out/签名测试.shortcut" && (again.nextStep ?? "").includes("导入"),
    );
    const third = (await handleApiRequest({ action: "sign", paths: ["/ws/签名测试.plist"], outputDir: "/ws/out/" })) as ApiSignResult;
    check("sign：重名不覆盖，加序号（outputDir 末尾带斜杠也行）", third.items[0].ok && third.items[0].path === "/ws/out/签名测试 2.shortcut" && files.has("/ws/out/签名测试.shortcut"));

    // ---- 一批里好坏混着 ----
    files.set("/ws/不是快捷指令.zip", concat(Uint8Array.of(0x50, 0x4b, 0x03, 0x04), rnd(40)));
    const mixed = (await handleApiRequest({
      action: "sign",
      paths: ["/ws/签名测试.plist", "/ws/不存在.plist", "/ws/不是快捷指令.zip"],
    })) as ApiSignResult;
    const [m0, m1, m2] = mixed.items;
    check(
      "sign：一批里好坏混着，各管各的，失败的写明原因",
      mixed.ok && mixed.signedCount === 1 && mixed.failedCount === 2 && m0.ok && !m1.ok && m1.error.includes("读不了") && !m2.ok && m2.error.includes("认不出") && m2.error.includes("zip"),
    );

    // ---- 已签名的来料换签名 ----
    const resigned = (await handleApiRequest({ action: "sign", paths: [item.ok ? item.path : ""] })) as ApiSignResult;
    const r0 = resigned.items[0];
    check("sign：已签名的来料换成本脚本的签名，并标明", r0.ok && r0.resigned && r0.inputKind === "signed" && r0.name === "签名测试");
    const checkedSigned = (await handleApiRequest({ action: "check", path: r0.ok ? r0.path : "" })) as ApiCheckResult;
    check("check：已签名的文件也能查（拆出里面的 plist）", checkedSigned.items[0].ok && checkedSigned.items[0].inputKind === "signed" && checkedSigned.items[0].actionCount === 1);

    // ---- 动作标识：截断和读不出来的 ----
    files.set(
      "/ws/多动作.plist",
      encodeXmlPlist({
        WFWorkflowName: "多动作",
        WFWorkflowActions: Array.from({ length: 150 }, (_, index) => (index === 0 ? {} : { WFWorkflowActionIdentifier: `is.workflow.actions.demo${index}` })),
      }),
    );
    const big = (await handleApiRequest({ action: "sign", paths: ["/ws/多动作.plist"] })) as ApiSignResult;
    const b0 = big.items[0];
    check(
      "sign：动作标识最多带 100 个并标明截断；读不出标识的记为 unknown",
      b0.ok && b0.actionCount === 150 && b0.actionIds.length === 100 && b0.actionIdsTruncated && b0.actionIds[0] === "unknown" && b0.actionIds[1] === "is.workflow.actions.demo1",
    );

    // ---- 写盘失败：这一份失败，整个调用不抛 ----
    const fm = g.FileManager as Record<string, unknown>;
    const realWrite = fm.writeAsBytes;
    fm.writeAsBytes = async () => {
      throw new Error("磁盘满了");
    };
    const diskFull = (await handleApiRequest({ action: "sign", paths: ["/ws/签名测试.plist"] })) as ApiSignResult;
    check("写盘失败：这一份记为失败并写明原因，整个调用不抛", diskFull.ok && diskFull.failedCount === 1 && !diskFull.items[0].ok && diskFull.items[0].error.includes("磁盘满了"));
    fm.writeAsBytes = realWrite;

    // ---- 身份出问题：明说怎么恢复，不悄悄重新生成 ----
    keychain.set("shortcut_signer_identity_v1", "{not json");
    resetCacheForTests();
    const brokenStatus = (await handleApiRequest({ action: "status" })) as ApiFailure;
    const brokenSign = (await handleApiRequest({ action: "sign", paths: ["/ws/签名测试.plist"] })) as ApiFailure;
    check(
      "身份损坏：status 和 sign 都报 identity 错误并写明怎么恢复，钥匙串原样不动（不悄悄重新生成）",
      !brokenStatus.ok &&
        brokenStatus.error.type === "identity" &&
        brokenStatus.error.message.includes("重新生成") &&
        !brokenSign.ok &&
        brokenSign.error.type === "identity" &&
        keychain.get("shortcut_signer_identity_v1") === "{not json",
    );
    keychain.clear();
    resetCacheForTests();
    failWrites.value = true;
    const noWrite = (await handleApiRequest({ action: "sign", paths: ["/ws/签名测试.plist"] })) as ApiFailure;
    check("钥匙串写不进去：sign 报 identity 错误，没留下假身份", !noWrite.ok && noWrite.error.type === "identity" && keychain.size === 0);
    failWrites.value = false;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
    resetCacheForTests();
  }
}

/**
 * Scripting 里 AI 的技能（skills/shortcut-signer）和脚本是两份东西，靠几处约定对上：
 * 参数 schema 的取值 = API_ACTIONS、被调用的脚本名 = script.json 的 name、API 版本、文档里引用的文件都在、模板能签。
 * 这里把这些约定核一遍，改了任何一边忘了另一边，这里会报红。
 */
function testSkill(): void {
  console.log("AI 技能（skills/shortcut-signer）和脚本的一致性");
  const skillRoot = join(process.cwd(), "skills", "shortcut-signer");
  const scriptRoot = join(process.cwd(), "快捷指令签名");
  if (!existsSync(skillRoot) || !existsSync(scriptRoot)) {
    console.log("  - 找不到技能或脚本目录（要在 scripting/ 下运行），跳过");
    return;
  }
  const read = (...parts: string[]): string => readFileSync(join(skillRoot, ...parts), "utf8");

  // ---- SKILL.md 前置信息 ----
  const skillMd = read("SKILL.md");
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1] ?? "";
  const field = (key: string): string => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1].trim() ?? "";
  check(
    "SKILL.md 前置信息：name = 文件夹名，有 description / runtime / entry，入口文件在",
    field("name") === "shortcut-signer" &&
      field("description").length > 20 &&
      field("runtime") === "scripting" &&
      field("entry") === "scripts/sign.ts" &&
      existsSync(join(skillRoot, field("entry"))),
  );
  check("description 是合法的 YAML 单行写法（没有「: 」「 #」，否则会被当成别的）", !/: | #/.test(field("description")));
  check(
    "metadata 里有 intent_patterns / required_tools / input_schema_file，工具是 run_shell_command 和 file_tool",
    /intent_patterns:\s*".+"/.test(front) && /required_tools:\s*"run_shell_command, file_tool"/.test(front) && /input_schema_file:\s*"schema\.json"/.test(front),
  );

  // ---- schema.json / skill.json ----
  const schema = JSON.parse(read("schema.json")) as { properties: { operation: { enum: string[] } } };
  check("schema.json 的 operation 取值 = 脚本的 API_ACTIONS", schema.properties.operation.enum.join() === API_ACTIONS.join());
  const meta = JSON.parse(read("skill.json")) as { icon?: string; color?: string };
  check("skill.json 有图标和颜色", typeof meta.icon === "string" && typeof meta.color === "string");

  // ---- 技能入口和脚本的约定（路由在 router.ts，sign.ts 只接线） ----
  const entry = read("scripts", "sign.ts");
  const manifest = JSON.parse(readFileSync(join(scriptRoot, "script.json"), "utf8")) as { name: string };
  check("router.ts 调用的脚本名 = script.json 的 name", SIGNER_SCRIPT === manifest.name);
  // 每个 action 是在哪个接口版本加的。加了新 action 却忘了登记，这里会报红
  const addedIn: Record<string, number> = { status: 1, check: 2, sign: 1 };
  check("每个 action 都登记了是哪个接口版本加的", API_ACTIONS.every((action) => action in addedIn));
  // check 在技能里本地跑，经脚本做的只有 status / sign（路由行为在 testSkillCheck 里测）
  const viaScript = API_ACTIONS.filter((action) => action !== "check");
  check(
    "router.ts 要求的 API 版本：够用（不低于经脚本做的 action 里最新的那个）、也不超过脚本现在的 API_VERSION",
    Number.isInteger(REQUIRED_API_VERSION) &&
      REQUIRED_API_VERSION >= Math.max(...viaScript.map((action) => addedIn[action])) &&
      REQUIRED_API_VERSION <= API_VERSION,
  );
  check(
    "sign.ts 只接线：从 router 取路由、用 Script.run 调脚本、用 Script.exit 交回",
    /from "\.\/router"/.test(entry) && /\broute\(/.test(entry) && /\bScript\.run\b/.test(entry) && /\bScript\.exit\(/.test(entry),
  );

  // ---- SKILL.md 里的引用都存在 ----
  const referenced = [...skillMd.matchAll(/<skill_dir>\/([A-Za-z0-9_./-]+)/g)].map((match) => match[1].replace(/\.+$/, ""));
  const missing = [...new Set(referenced)].filter((path) => !existsSync(join(skillRoot, path)));
  check(`SKILL.md 里 <skill_dir>/… 引用的文件都存在（共 ${new Set(referenced).size} 处）${missing.length ? "：缺 " + missing.join("、") : ""}`, referenced.length > 0 && missing.length === 0);
  check(
    "SKILL.md 讲了每个 operation 的调用写法",
    API_ACTIONS.every((action) => skillMd.includes(`"operation":"${action}"`)),
  );
  check(
    "SKILL.md 里的安全规则还在（签名不是审核、先说明并取得明确同意）",
    skillMd.includes("签名不是审核") && skillMd.includes("明确同意"),
  );

  // ---- templates/ 和 references/ 里的每个文件，SKILL.md 都得引用到（不留孤儿） ----
  const unreferenced = ["templates", "references"].flatMap((dir) =>
    readdirSync(join(skillRoot, dir)).filter((file) => !skillMd.includes(`<skill_dir>/${dir}/${file}`)).map((file) => `${dir}/${file}`),
  );
  check(`templates/ 和 references/ 里的每个文件 SKILL.md 都引用了${unreferenced.length ? "：漏了 " + unreferenced.join("、") : ""}`, unreferenced.length === 0);

  // ---- 模板 plist：能被认出来、能过结构检查、能签 ----
  const templateIdentity = createIdentity({ random: rnd });
  const templates = readdirSync(join(skillRoot, "templates")).filter((file) => file.endsWith(".plist"));
  check(
    "有八份模板：空白骨架、文本 → 显示结果、询问并通知、菜单、剪贴板判断、请求接口、替换文本、分享面板收文字",
    templates.join() === "ask-and-notify.plist,blank.plist,http-json.plist,if-clipboard.plist,menu.plist,replace-text.plist,share-text.plist,text-to-result.plist",
  );
  const templateNames: string[] = [];
  for (const file of templates) {
    const bytes = utf8(read("templates", file));
    const result = checkWorkflow(parsePlist(bytes));
    const prepared = prepareShortcut(bytes);
    templateNames.push(prepared.name ?? "");
    check(
      `模板 ${file}：是快捷指令、过结构检查（没有错误）、能签、自检通过`,
      prepared.actionCount >= 1 && result.ok && signChecked(bytes, templateIdentity, { decompress: noDecompress }).ok,
    );
  }
  check("模板的名字各不相同（导入时不会互相顶替）", new Set(templateNames).size === templates.length && !templateNames.includes(""));
  const blank = prepareShortcut(utf8(read("templates", "blank.plist")));
  check(
    "blank.plist：名字「新快捷指令」，一个「显示提示」动作",
    blank.name === "新快捷指令" && blank.actionIds.join() === "is.workflow.actions.alert" && blank.source === "xml",
  );
  check(
    "blank.plist 和脚本里内置的测试快捷指令只有名字 / 标题 / 内容不同（其余结构一字不差，那份在真机上验证过）",
    read("templates", "blank.plist").replace(/新快捷指令|标题|内容/g, "·") === SAMPLE_SHORTCUT_XML.replace(/签名测试 ✅|签名测试|导入并运行成功：这个快捷指令的签名被系统接受了。/g, "·"),
  );
  const textToResult = prepareShortcut(utf8(read("templates", "text-to-result.plist")));
  check(
    "text-to-result.plist：gettext → showresult 两个动作",
    textToResult.actionIds.join() === "is.workflow.actions.gettext,is.workflow.actions.showresult",
  );

  // ---- 技能文件夹里同样不能有不该有的东西 ----
  const banned = new RegExp(`${"dan"}1165|${"short"}${"sign"}(?!er)|t\\.me/`, "i");
  const everyFile = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? everyFile(path) : [path];
    });
  const leaks = everyFile(skillRoot).filter((file) => banned.test(readFileSync(file, "utf8")));
  check(`技能文件夹里没有朋友项目的名字、没有作者频道链接${leaks.length ? "：" + leaks.join("、") : ""}`, leaks.length === 0);
}

/**
 * 技能里的本地检查（skills/shortcut-signer/scripts/localCheck.ts + vendor/）：
 * 检查器在脚本和技能里各有一份逐字节相同的副本，技能的 check 不经过脚本。这里核对三件事：
 * 副本没漂移、本地检查和脚本的 check 给出一样的结果、路由把 check 留在本地而 status / sign 交给脚本。
 */
async function testSkillCheck(): Promise<void> {
  console.log("技能里的本地检查（vendor 副本 + 路由）");
  const skillRoot = join(process.cwd(), "skills", "shortcut-signer");
  const scriptRoot = join(process.cwd(), "快捷指令签名");
  if (!existsSync(skillRoot) || !existsSync(scriptRoot)) {
    console.log("  - 找不到技能或脚本目录（要在 scripting/ 下运行），跳过");
    return;
  }

  // ---- vendor/ 里的副本和脚本里的逐字节相同 ----
  const shared = ["core/bytes.ts", "core/plist.ts", "core/check.ts", "core/read.ts", "core/report.ts", "core/names.ts", "kit/sources.ts"];
  const vendorRoot = join(skillRoot, "vendor");
  const drifted = shared.filter((file) => {
    const copy = join(vendorRoot, file);
    return !existsSync(copy) || !readFileSync(join(scriptRoot, file)).equals(readFileSync(copy));
  });
  check(
    `vendor/ 里的 ${shared.length} 个文件和脚本里的逐字节相同${drifted.length ? "，不一致：" + drifted.join("、") + "（以脚本为准重新复制，命令见 MAINTAINING.md 第 14 节）" : ""}`,
    drifted.length === 0,
  );
  const vendored = sourceFiles(vendorRoot)
    .map((file) => relative(vendorRoot, file).replace(/\\/g, "/"))
    .sort();
  check("vendor/ 里只有这几个文件，没有别的", vendored.join() === [...shared].sort().join());

  // ---- 技能里的 TS 文件只引用技能文件夹里的东西（注释行不算） ----
  const outside: string[] = [];
  const scriptingImporters: string[] = [];
  for (const file of sourceFiles(skillRoot)) {
    const shortName = relative(skillRoot, file).replace(/\\/g, "/");
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
    for (const match of code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
      const target = match[1];
      if (target === "scripting") {
        scriptingImporters.push(shortName);
      } else if (!target.startsWith(".")) {
        outside.push(`${shortName} → ${target}`);
      } else {
        const base = resolve(dirname(file), target);
        const inside = !relative(skillRoot, base).startsWith("..");
        if (!inside || ![".ts", ".tsx", "/index.ts", "/index.tsx"].some((suffix) => existsSync(base + suffix))) {
          outside.push(`${shortName} → ${target}`);
        }
      }
    }
  }
  check(`技能里的 TS 文件只引用 scripting 和技能文件夹里找得到的文件${outside.length ? "：" + outside.join("、") : ""}`, outside.length === 0);
  check(
    'import "scripting" 的只有入口 sign.ts 和聊天卡片（router / localCheck / vendor 都不，Node 里才能测）',
    [...new Set(scriptingImporters)].sort().join() === "scripts/sign.ts,views/SignedShortcutView.tsx",
  );

  const g = globalThis as Record<string, unknown>;
  const savedFileManager = g.FileManager;
  try {
    // 内存里的文件系统：路径 → 字节；太大的那个只有大小、没有内容
    const files = new Map<string, Uint8Array>();
    const hugeSize = 25 * 1024 * 1024;
    g.FileManager = {
      statSync: (path: string) => {
        if (path === "/ws/太大.bin") return { size: hugeSize };
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error("No such file or directory");
        return { size: bytes.length };
      },
      readAsBytesSync: (path: string) => {
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error("No such file or directory");
        return bytes.slice().buffer; // 真机行为：ArrayBuffer
      },
    };
    files.set("/ws/最小有效.plist", utf8(FIXTURE_VALID));
    files.set("/ws/无效.plist", utf8(FIXTURE_INVALID));
    files.set("/ws/控制流.plist", utf8(FIXTURE_CONTROL_ORDER));
    files.set("/ws/二进制.plist", encodeBplist(parsePlist(utf8(FIXTURE_VALID))));
    files.set(
      "/ws/很多问题.plist",
      encodeXmlPlist({
        WFWorkflowName: "很多问题",
        WFWorkflowActions: Array.from({ length: 120 }, (_, index) => ({
          WFWorkflowActionIdentifier: "is.workflow.actions.gettext",
          WFWorkflowActionParameters: index < 60 ? { UUID: `bad-${index}` } : {},
        })),
      }),
    );
    files.set("/ws/不是快捷指令.zip", concat(Uint8Array.of(0x50, 0x4b, 0x03, 0x04), rnd(40)));
    files.set("/ws/空.plist", new Uint8Array(0));
    files.set("/ws/网页.html", utf8("<!DOCTYPE html><html><body>登录</body></html>"));
    const paths = [
      "/ws/最小有效.plist",
      "/ws/无效.plist",
      "/ws/控制流.plist",
      "/ws/二进制.plist",
      "/ws/很多问题.plist",
      "/ws/不是快捷指令.zip",
      "/ws/空.plist",
      "/ws/网页.html",
      "/ws/太大.bin",
      "/ws/不存在.plist",
    ];

    // ---- 本地检查 vs 脚本的 check：整份结果（除了 apiVersion）一字不差 ----
    const sameAsScript = async (params: Record<string, unknown>): Promise<boolean> => {
      const viaApi = (await handleApiRequest({ action: "check", ...params })) as unknown as Record<string, unknown>;
      const { apiVersion, ...rest } = viaApi;
      return typeof apiVersion === "number" && JSON.stringify(runLocalCheck(params)) === JSON.stringify(rest);
    };
    check(
      "本地检查和脚本的 check：同一批文件（好 / 坏 / 二进制 / 压缩包 / 空 / 网页 / 太大 / 不存在），整份结果一字不差（只少 apiVersion）",
      await sameAsScript({ paths }),
    );
    check("严格模式、path 单个字符串、file:// 路径，两边也一样", (await sameAsScript({ paths, strict: true })) &&
      (await sameAsScript({ path: "/ws/最小有效.plist" })) &&
      (await sameAsScript({ paths: ["file:///ws/%E6%9C%80%E5%B0%8F%E6%9C%89%E6%95%88.plist"] })));
    const badParams: Record<string, unknown>[] = [
      {},
      { paths: [] },
      { paths: [1, ""] },
      { paths: ["relative.plist"] },
      { paths: Array.from({ length: 21 }, (_, index) => `/ws/${index}.plist`) },
    ];
    const sameValidation = await Promise.all(
      badParams.map(async (params) => {
        const viaApi = (await handleApiRequest({ action: "check", ...params })) as unknown as { error: { message: string } };
        const local = runLocalCheck(params) as { ok: boolean; apiVersion?: number; error: { type: string; message: string } };
        return !local.ok && local.error.type === "validation" && local.error.message === viaApi.error.message && local.apiVersion === undefined;
      }),
    );
    check("参数校验和脚本的 check 说一样的话，而且不带 apiVersion", sameValidation.every(Boolean));
    check("本地检查不碰 Script（没有 Script 全局也能跑）", g.Script === undefined && (runLocalCheck({ paths }) as { ok: boolean }).ok);

    // 已签名的 .shortcut：本地检查不收（拆它要原生解压，是脚本的活），记成 unreadable 并说明直接 sign
    files.set("/ws/已签名.shortcut", signShortcut(utf8(SAMPLE_SHORTCUT_XML), createIdentity({ random: rnd }), { random: rnd }).data);
    const [signedItem] = (runLocalCheck({ paths: ["/ws/已签名.shortcut"] }) as unknown as ApiCheckResult).items;
    check(
      "本地检查不收已签名的文件：记成 unreadable、说明直接 sign，不当成坏文件抛出来",
      !signedItem.ok && signedItem.errors[0].code === "unreadable" && signedItem.errors[0].message.includes("sign"),
    );

    // ---- 路由：check 留在本地，status / sign 才交给脚本 ----
    const calls: Record<string, unknown>[] = [];
    const answer = { ok: true, action: "from-script", apiVersion: API_VERSION };
    const runner: SignerRunner = {
      run: async (request) => {
        calls.push(request);
        return answer;
      },
    };
    const local = await route({ operation: "check", paths: ["/ws/最小有效.plist"] }, runner);
    check("路由：check 留在本地，脚本一次都没被叫", calls.length === 0 && local.ok === true && local.action === "check" && local.passedCount === 1);
    const scriptDown: SignerRunner = {
      run: async () => {
        throw new Error("脚本没装");
      },
    };
    check("路由：脚本没装、版本旧也不影响 check", (await route({ operation: "check", paths }, scriptDown)).ok === true);

    const status = await route({ operation: "status", extra: 1 }, runner);
    check("路由：status 只转交 { action }，别的参数丢掉，结果原样交回", JSON.stringify(calls[0]) === '{"action":"status"}' && status === answer);
    await route({ operation: "sign", path: "/ws/a.plist", outputDir: "/ws/out", strict: true, evil: "x" }, runner);
    check(
      "路由：sign 只转交 paths（path 当 paths 用）和 outputDir，strict 和别的参数丢掉",
      JSON.stringify(calls[1]) === '{"action":"sign","paths":"/ws/a.plist","outputDir":"/ws/out"}',
    );
    await route({ operation: "sign", paths: ["/a", "/b"] }, runner);
    check("路由：sign 没给 outputDir 就不带这个键", JSON.stringify(calls[2]) === '{"action":"sign","paths":["/a","/b"]}');
    await route({}, runner);
    check("路由：不给 operation 就是 status", JSON.stringify(calls[3]) === '{"action":"status"}');

    const callsBefore = calls.length;
    const unknown = await route({ operation: "frobnicate" }, runner);
    const notString = await route({ operation: 42 }, runner);
    check(
      "路由：不认识的 operation 是 validation 错误，写明可用的三个，脚本不会被叫",
      calls.length === callsBefore &&
        unknown.ok === false &&
        unknown.error.type === "validation" &&
        unknown.error.message.includes("status、check、sign") &&
        notString.error.message.includes("42"),
    );
    const launch = await route({ operation: "status" }, scriptDown);
    check("路由：脚本叫不起来是 launch 错误，点名脚本", launch.ok === false && launch.error.type === "launch" && launch.error.message.includes(SIGNER_SCRIPT));
    const empty = await Promise.all([null, undefined, "文本"].map((value) => route({ operation: "status" }, { run: async () => value })));
    check("路由：脚本没返回对象是 no_result 错误", empty.every((result) => result.ok === false && result.error.type === "no_result"));
    const old = await route({ operation: "status" }, { run: async () => ({ ok: true, apiVersion: REQUIRED_API_VERSION - 1 }) });
    check(
      "路由：脚本的 API 版本太旧是 outdated 错误，写明两个版本号",
      old.ok === false && old.error.type === "outdated" && old.error.message.includes(String(REQUIRED_API_VERSION - 1)) && old.error.message.includes(String(REQUIRED_API_VERSION)),
    );
    const fresh = { ok: true, apiVersion: REQUIRED_API_VERSION, marker: 1 };
    const failed = { ok: false, error: { type: "identity", message: "x" } };
    check(
      "路由：版本够用的结果、没有版本号的失败，都原样交回",
      (await route({ operation: "status" }, { run: async () => fresh })) === fresh && (await route({ operation: "status" }, { run: async () => failed })) === failed,
    );
  } finally {
    if (savedFileManager === undefined) delete g.FileManager;
    else g.FileManager = savedFileManager;
  }
}

interface CatalogEntry {
  /** 证据标签：真机 / 样本 / 公开 */
  tier: string;
  /** 登记在哪个文件里 */
  file: string;
  /** 参数表第一列里写的键名 */
  keys: Set<string>;
  /** 这个条目的正文（到下一个标题为止），查出处用 */
  text: string;
}

/**
 * 读技能的动作目录（references/actions-*.md）：每个动作一个标题 `### \`标识\` — 名称`（或小表里的一行），
 * 里面写着「证据：**样本**（…）」和参数表。读出来给下面的测试核对。
 */
function readCatalog(referencesDir: string, files: string[]): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>();
  for (const file of files) {
    let current: CatalogEntry | null = null;
    for (const line of readFileSync(join(referencesDir, file), "utf8").split("\n")) {
      const heading = /^#{2,3} `([A-Za-z0-9_.]+)`/.exec(line);
      if (heading) {
        current = { tier: "", file, keys: new Set(), text: "" };
        entries.set(heading[1], current);
        continue;
      }
      if (/^#{1,3} /.test(line)) {
        current = null;
        continue;
      }
      const row = /^\| `([A-Za-z0-9_.]+)` — [^|]*\| \*\*(真机|样本|公开)\*\*/.exec(line);
      if (row) {
        entries.set(row[1], { tier: row[2], file, keys: new Set(), text: line });
        continue;
      }
      if (current === null) continue;
      current.text += `${line}\n`;
      const tier = /^- 证据：\*\*(真机|样本|公开)\*\*/.exec(line);
      if (tier) current.tier = tier[1];
      // 参数表的行：第一列只有反引号里的键名（用 / 隔开几个）；条件码表那种第一列是数字的不算
      const param = /^\| ((?:`[A-Za-z][A-Za-z0-9_]*`(?: \/ )?)+) \|/.exec(line);
      if (param) for (const key of param[1].matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) current.keys.add(key[1]);
    }
  }
  return entries;
}

/** 文档里 ```xml 围栏块的内容。 */
function xmlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```xml\n([\s\S]*?)```/g)].map((match) => match[1]);
}

/** 把文档里的一段 XML 片段包成一份完整的快捷指令，好交给解析器和检查器；认不出形状的返回 null。 */
function wrapSnippet(xml: string): string | null {
  const head = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>WFWorkflowName</key><string>片段</string><key>WFWorkflowActions</key><array>';
  const tail = "</array></dict></plist>";
  const body = xml.trim();
  if (body.startsWith("<dict>")) return head + body + tail; // 一个或几个完整的动作
  if (body.startsWith("<key>")) {
    // 某个动作的几个参数
    return `${head}<dict><key>WFWorkflowActionIdentifier</key><string>x.y</string><key>WFWorkflowActionParameters</key><dict>${body}</dict></dict>${tail}`;
  }
  return null;
}

/**
 * 技能的知识库（references/ 里的动作目录、值的写法，和 templates/）：
 * 标「样本」的动作要真的在真实样本里出现过、写的参数键要真的见过；目录索引和各文件对得上；
 * 模板只用「真机 / 样本」级的动作；文档里的 XML 片段都解析得了。
 */
function testSkillKnowledge(): void {
  console.log("技能的知识库（动作目录、值的写法、模板）");
  const skillRoot = join(process.cwd(), "skills", "shortcut-signer");
  const referencesDir = join(skillRoot, "references");
  if (!existsSync(referencesDir)) {
    console.log("  - 找不到技能目录（要在 scripting/ 下运行），跳过");
    return;
  }
  const categoryFiles = readdirSync(referencesDir).filter((file) => /^actions-.+\.md$/.test(file)).sort();
  check(`动作目录分成 ${categoryFiles.length} 个文件：actions-data / flow / io / text`, categoryFiles.join() === "actions-data.md,actions-flow.md,actions-io.md,actions-text.md");
  const catalog = readCatalog(referencesDir, categoryFiles);
  check(`目录里登记了 ${catalog.size} 个动作`, catalog.size >= 30);
  // 检查器认的系统动作（KNOWN_ACTIONS）和知识库目录是同一份名单：目录加了动作，检查器那边也要加，反过来也一样
  const onlyInChecker = [...KNOWN_ACTIONS].filter((id) => !catalog.has(id));
  const onlyInCatalog = [...catalog.keys()].filter((id) => !KNOWN_ACTIONS.has(id));
  check(
    `检查器认的系统动作（KNOWN_ACTIONS）和知识库目录是同一份名单${onlyInChecker.length ? "；只在检查器里：" + onlyInChecker.join("、") : ""}${onlyInCatalog.length ? "；只在目录里：" + onlyInCatalog.join("、") : ""}`,
    onlyInChecker.length === 0 && onlyInCatalog.length === 0,
  );
  const untagged = [...catalog].filter(([, entry]) => entry.tier === "").map(([id]) => id);
  check(`每个动作都写了证据标签（真机 / 样本 / 公开）${untagged.length ? "：缺 " + untagged.join("、") : ""}`, untagged.length === 0);
  check(
    "标「真机」的只有 alert（用户真机验证过的唯一一个；哪天验证了别的，在这里加上并更新文档）",
    [...catalog].filter(([, entry]) => entry.tier === "真机").map(([id]) => id).join() === "is.workflow.actions.alert",
  );
  // 「公开」级的东西都要写出处：整个动作标「公开」的，或者「样本」级动作里靠公开资料补的参数（第一列写成「`键名`（公开）」）
  const noSource = [...catalog]
    .filter(([, entry]) => (entry.tier === "公开" || entry.text.includes("（公开）")) && !/出处：.*https?:\/\//.test(entry.text))
    .map(([id]) => id);
  check(`标「公开」的动作、和写了「（公开）」参数的动作，都写了出处网址${noSource.length ? "：缺 " + noSource.join("、") : ""}`, noSource.length === 0);

  // ---- 索引（actions.md）和各文件对得上 ----
  const indexMd = readFileSync(join(referencesDir, "actions.md"), "utf8");
  const indexRows = new Map<string, { tier: string; file: string }>();
  for (const line of indexMd.split("\n")) {
    const row = /^\| `([A-Za-z0-9_.]+)` \| [^|]+\| (真机|样本|公开) \| ([A-Za-z0-9_.-]+\.md) \|/.exec(line);
    if (row) indexRows.set(row[1], { tier: row[2], file: row[3] });
  }
  const notIndexed = [...catalog.keys()].filter((id) => !indexRows.has(id));
  const stray = [...indexRows.keys()].filter((id) => !catalog.has(id));
  const mismatched = [...indexRows].filter(([id, row]) => catalog.has(id) && (catalog.get(id)!.tier !== row.tier || catalog.get(id)!.file !== row.file)).map(([id]) => id);
  check(
    `actions.md 的索引和各文件一一对上（标识、证据、所在文件）${notIndexed.length ? "；索引里漏了 " + notIndexed.join("、") : ""}${stray.length ? "；索引里多了 " + stray.join("、") : ""}${mismatched.length ? "；对不上 " + mismatched.join("、") : ""}`,
    notIndexed.length === 0 && stray.length === 0 && mismatched.length === 0,
  );

  // ---- 对着真实样本核：标「样本」的动作和参数键 ----
  const samples = goldenSamples();
  if (samples === null) {
    console.log("  - 没有 Apple 样本（_selftest/shortcut-signer-golden 或 SIGNER_GOLDEN），跳过「目录对着真实样本核」");
  } else {
    const seenKeys = new Map<string, Set<string>>();
    for (const { workflow } of samples) {
      const actions = isDict(workflow) ? workflow.get("WFWorkflowActions") : undefined;
      for (const action of Array.isArray(actions) ? actions : []) {
        if (!isDict(action)) continue;
        const id = String(action.get("WFWorkflowActionIdentifier"));
        const params = action.get("WFWorkflowActionParameters");
        const keys = seenKeys.get(id) ?? new Set<string>();
        if (isDict(params)) for (const key of params.keys()) keys.add(key);
        seenKeys.set(id, keys);
      }
    }
    const sampled = [...catalog].filter(([, entry]) => entry.tier === "样本");
    const unseen = sampled.filter(([id]) => !seenKeys.has(id)).map(([id]) => id);
    check(`标「样本」的 ${sampled.length} 个动作，标识都在真实样本里出现过${unseen.length ? "：没见过 " + unseen.join("、") : ""}`, unseen.length === 0);
    const badKeys = sampled.flatMap(([id, entry]) => (seenKeys.has(id) ? [...entry.keys].filter((key) => !seenKeys.get(id)!.has(key)).map((key) => `${id} 的 ${key}`) : []));
    check(`标「样本」的动作，参数表里写的键名都在真实样本里见过${badKeys.length ? "：没见过 " + badKeys.join("、") : ""}`, badKeys.length === 0);
    const sampleIds = new Set(seenKeys.keys());
    const missingFromCatalog = [...sampleIds].filter((id) => id.startsWith("is.workflow.actions.") && !catalog.has(id));
    check(`真实样本里出现的系统动作，目录里都登记了${missingFromCatalog.length ? "：漏了 " + missingFromCatalog.join("、") : ""}`, missingFromCatalog.length === 0);
  }

  // ---- 模板：用到的动作都登记过；用了「公开」级动作的模板，recipes.md 里要标出来 ----
  const templatesDir = join(skillRoot, "templates");
  const recipeRows = readFileSync(join(referencesDir, "recipes.md"), "utf8").split("\n");
  const unregistered: string[] = [];
  const unmarked: string[] = [];
  for (const file of readdirSync(templatesDir).filter((name) => name.endsWith(".plist"))) {
    const ids = prepareShortcut(utf8(readFileSync(join(templatesDir, file), "utf8"))).actionIds;
    let weak = false;
    for (const id of ids) {
      const tier = catalog.get(id)?.tier;
      if (tier === undefined || tier === "") unregistered.push(`${file} 的 ${id}`);
      else if (tier === "公开") weak = true;
    }
    const row = recipeRows.find((line) => line.startsWith("|") && line.includes(`\`${file}\``)) ?? "";
    if (weak && !row.includes("公开")) unmarked.push(file);
  }
  check(`模板用到的动作都在目录里登记过${unregistered.length ? "：没登记 " + unregistered.join("、") : ""}`, unregistered.length === 0);
  check(`用了「公开」级动作的模板，recipes.md 的那一行里标了「公开」${unmarked.length ? "：没标 " + unmarked.join("、") : ""}`, unmarked.length === 0);

  // ---- 文档里的 XML 片段：解析得了，检查器除了「引用的动作不在这一段里」之外不报错 ----
  const bad: string[] = [];
  let blocks = 0;
  for (const file of readdirSync(referencesDir).filter((name) => name.endsWith(".md"))) {
    xmlBlocks(readFileSync(join(referencesDir, file), "utf8")).forEach((block, index) => {
      const wrapped = wrapSnippet(block);
      if (wrapped === null) return;
      blocks++;
      try {
        const result = checkWorkflow(parsePlist(utf8(wrapped)));
        const real = result.errors.filter((issue) => issue.code !== "unknown_output_uuid");
        if (real.length > 0) bad.push(`${file} 第 ${index + 1} 段：${real.map((issue) => issue.code).join(",")}`);
      } catch (error) {
        bad.push(`${file} 第 ${index + 1} 段：解析失败（${(error as Error).message}）`);
      }
    });
  }
  check(`文档里的 ${blocks} 段 XML 片段都解析得了、检查器没有报错${bad.length ? "：" + bad.join("；") : ""}`, blocks > 0 && bad.length === 0);
}

/** 可复现的伪随机数（mulberry32），模糊测试出了问题能原样重放。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(source: Uint8Array, random: () => number): Uint8Array {
  const out = source.slice();
  const edits = 1 + Math.floor(random() * 4);
  for (let i = 0; i < edits; i++) {
    const at = Math.floor(random() * out.length);
    const kind = random();
    if (kind < 0.5) out[at] = Math.floor(random() * 256);
    else if (kind < 0.75) out[at] ^= 1 << Math.floor(random() * 8);
    else out.fill(random() < 0.5 ? 0xff : 0x00, at, Math.min(out.length, at + 1 + Math.floor(random() * 8)));
  }
  // 偶尔截断
  return random() < 0.2 ? out.subarray(0, Math.floor(random() * out.length)) : out;
}

function testFuzz(): void {
  console.log("坏输入不能卡死、不能抛出怪东西（可复现的随机变异）");
  const random = seeded(20261028);
  const started = Date.now();
  const identity = createIdentity({ random: rnd });
  const xml = utf8(SAMPLE_XML);
  const binary = encodeBplist(parseXmlPlist(SAMPLE_XML));
  const signed = signShortcut(xml, identity, { random: rnd }).data;
  const publicKey = encodePoint(identity.leafPublicKey);

  let stray = 0; // 抛出的不是 Error
  const run = (action: () => unknown): void => {
    try {
      action();
    } catch (error) {
      if (!(error instanceof Error)) stray++;
    }
  };
  for (let i = 0; i < 1500; i++) {
    run(() => parsePlist(mutate(xml, random)));
    run(() => parsePlist(mutate(binary, random)));
    run(() => prepareShortcut(mutate(xml, random)));
  }
  for (let i = 0; i < 300; i++) {
    const broken = mutate(signed, random);
    run(() => parseAea(broken));
    run(() => verifyAea(broken, publicKey, noDecompress));
    run(() => prepareShortcut(broken, { decompress: noDecompress }));
  }
  check("变异了 4500 份 plist + 900 份签名文件：全程只抛 Error", stray === 0);
  check(`没有卡死（共 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`, Date.now() - started < 60_000);

  // 声明一个天文数字的元素个数，也不能申请出天文数字的内存 / 跑很久
  const hostile = binary.slice();
  const trailer = hostile.length - 32;
  hostile.set(Uint8Array.of(0xff, 0xff, 0xff, 0xff), trailer + 8 + 4); // numObjects 高位拉满
  check("声明天文数字个对象的二进制 plist 会被拒绝", throwsError(() => parseBplist(hostile)));
}

/** 递归列出目录下的 .ts / .tsx。 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

function testDeviceTranspile(): void {
  console.log("设备转译器兼容（设备把 .ts 也当 TSX 解析，tsc 过了不等于设备能起）");
  const root = join(process.cwd(), "快捷指令签名");
  if (!existsSync(root)) {
    console.log("  - 找不到脚本目录（要在 scripting/ 下运行），跳过");
    return;
  }
  // 脚本和技能里的 TS 都要过这几关：技能里的入口、路由、本地检查也是在设备上跑的
  const skillRoot = join(process.cwd(), "skills", "shortcut-signer");
  const files = [...sourceFiles(root), ...(existsSync(skillRoot) ? sourceFiles(skillRoot) : [])];
  check(`找到 ${files.length} 个源文件（脚本 + 技能）`, files.length > 0);

  // 用脚本批量改源文件时，反斜杠转义被吃掉会把 \u0000 \r 之类变成真的控制字符（踩过）
  const stray = files.filter((file) => readFileSync(file).some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13));
  check(`源文件里没有意外的控制字符${stray.length ? "：" + stray.join("、") : ""}`, stray.length === 0);

  // 裸的泛型箭头函数 `<T>(x) =>` 会被当成 JSX 标签；要写 `<T,>` 或 function
  const offenders = files.filter((file) => /(?:=|\(|,|\basync)\s*<\s*[A-Za-z_]\w*\s*>\s*\(/.test(readFileSync(file, "utf8")));
  check(`没有裸泛型箭头函数${offenders.length ? "：" + offenders.join("、") : ""}`, offenders.length === 0);

  // 两类真机踩过的坑，源码里不许再出现：
  //   绕过 kit/dialog.ts 直接用 Dialog.prompt（点取消回 undefined，`.trim()` 会栽）；
  //   不经 toBytes 就用 readAsBytes / readAsBytesSync 的结果（回的是 ArrayBuffer）
  const promptOffenders = files.filter(
    (file) => !file.replace(/\\/g, "/").endsWith("kit/dialog.ts") && /\bDialog\.prompt\s*\(/.test(readFileSync(file, "utf8")),
  );
  check(`Dialog.prompt 只在 kit/dialog.ts 里用${promptOffenders.length ? "：" + promptOffenders.join("、") : ""}`, promptOffenders.length === 0);
  const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);
  const rawByteReaders = files.filter((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .some((line) => !isCommentLine(line) && /\breadAsBytes(Sync)?\s*\(/.test(line) && !/\btoBytes\s*\(/.test(line)),
  );
  check(`readAsBytes 的结果都过 toBytes${rawByteReaders.length ? "：" + rawByteReaders.join("、") : ""}`, rawByteReaders.length === 0);

  // 朋友的项目不能出现在随脚本发布的任何文件里（用户要求），页脚的作者频道也撤了。
  // 名字拆开写，免得这份测试自己成了出处
  const banned = new RegExp(`${"dan"}1165|${"short"}${"sign"}(?!er)|t\\.me/`, "i");
  const shipped = [...files, ...["README.md", "NOTICE.md", "MAINTAINING.md", "script.json"].map((name) => join(root, name))].filter((file) => existsSync(file));
  const leaks = shipped.filter((file) => banned.test(readFileSync(file, "utf8")));
  check(`发布的文件里没有朋友项目的名字、没有作者频道链接${leaks.length ? "：" + leaks.join("、") : ""}`, leaks.length === 0);

  const tsPath = process.env.SIGNER_TS;
  if (tsPath === undefined) {
    console.log("  - 没设 SIGNER_TS（typescript.js 的路径），跳过「按 TSX 转译」");
    return;
  }
  const ts = createRequire(join(process.cwd(), "noop.js"))(tsPath);
  const bad: string[] = [];
  for (const file of files) {
    const result = ts.transpileModule(readFileSync(file, "utf8"), {
      // 文件名一律按 .tsx，复现设备的解析方式
      fileName: file.replace(/\.tsx?$/, ".tsx"),
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        jsxFactory: "createElement",
        jsxFragmentFactory: "Fragment",
      },
    });
    if ((result.diagnostics ?? []).length > 0) bad.push(file);
  }
  check(`所有文件按 TSX 转译都没有语法错误${bad.length ? "：" + bad.join("、") : ""}`, bad.length === 0);
}

async function main(): Promise<void> {
  testBasics();
  testSha();
  testP256();
  testDer();
  testIdentity();
  testPlist();
  testAea();
  testSign();
  testCheck();
  testNames();
  testProfile();
  testRename();
  testFilesRoute();
  testNativeLzfse();
  testStore();
  testSample();
  testJump();
  testFlow();
  await testDeviceBoundaries();
  await testApi();
  testSkill();
  await testSkillCheck();
  testSkillKnowledge();
  testFuzz();
  testDeviceTranspile();

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

void main();
