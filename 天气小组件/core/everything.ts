// 天气和预警一起取：预警是同一次请求带回来的，所以就是「取天气，再从结果里推出预警的状态」。
//
// 单独成一个函数是因为 App 页和小组件两处都要这一步，而且「预览预警样式」（示例预警）也在这里接进来。

import { alertStateOf, type AlertState } from "./alertState";
import { loadWeather, type Deps, type Input, type Loaded } from "./load";

export type Everything = { weather: Loaded; alerts: AlertState };

export type EverythingDeps = Deps & {
  /** 「预览预警样式」开到什么时候（UTC 毫秒）；没开是 0 */
  demoUntil(): number;
};

export async function loadEverything(deps: EverythingDeps, input: Input): Promise<Everything> {
  const weather = await loadWeather(deps, input);
  return { weather, alerts: alertStateOf(weather, deps.now(), deps.demoUntil()) };
}
