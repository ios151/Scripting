// 联网取天气（连同预警）失败的原因：分几类，界面上各说一句人话。纯的，不碰系统。
//
// 彩云接口的失败：文档里只有 400「token is invalid」和 500 两个例子，其余按状态码常识归类。
// Open-Meteo 的失败不分类，统统当「联网失败」（见 core/openmeteo.ts）。

export type FailureReason = "token" | "quota" | "network" | "server" | "format" | "missing";

export type Failure = { reason: FailureReason; message: string };

/** 存进缓存的失败记录：什么时候、什么原因 */
export type FailureRecord = { at: number; reason: FailureReason; message: string };

export const FAILURE_REASONS: readonly FailureReason[] = ["token", "quota", "network", "server", "format", "missing"];

const MESSAGES: Readonly<Record<FailureReason, string>> = {
  token: "token 无效，或者没开通",
  quota: "请求太频繁，或者额度用完了",
  network: "联网失败",
  server: "接口出错了",
  format: "返回的内容读不懂",
  missing: "接口没有返回预警数据",
};

export function failureMessage(reason: FailureReason): string {
  return MESSAGES[reason];
}

export class FetchError extends Error {
  readonly reason: FailureReason;

  constructor(reason: FailureReason, detail?: string) {
    super(detail === undefined || detail === "" ? MESSAGES[reason] : `${MESSAGES[reason]}（${detail}）`);
    this.name = "FetchError";
    this.reason = reason;
  }
}

/** HTTP 状态 + 接口返回的错误说明 → 失败原因 */
export function classifyFailure(status: number, errorText: string): FailureReason {
  if (status === 429) return "quota";
  if (status === 401 || status === 403 || /token/i.test(errorText)) return "token";
  return "server";
}

export function describeFailure(error: unknown): Failure {
  if (error instanceof FetchError) return { reason: error.reason, message: error.message };
  return { reason: "network", message: MESSAGES.network };
}
