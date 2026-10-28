// Dialog 的小包装。
//
// `Dialog.prompt` 点「取消」时，dts 写返回 null，真机上回的是 undefined（2026-10-28 用户截图：
// 「undefined is not an object (evaluating 'text.trim')」；SideInstaller 里也专门处理过）。
// 这里把「没有输入」统一成 null，调用方只需要判一种：
//   取消 → null；点了确认但什么都没填 → ""。
// 两者要分得开：证书名称留空是「用默认名」，取消是「什么都别改」。

type PromptOptions = Parameters<typeof Dialog.prompt>[0];

export async function promptText(options: PromptOptions): Promise<string | null> {
  const value: unknown = await Dialog.prompt(options);
  return typeof value === "string" ? value : null;
}
