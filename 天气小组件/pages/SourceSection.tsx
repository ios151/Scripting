// App 页里的「天气来源」一节：天气数据从哪里取、现在的状态、填自己的服务地址和 token 的地方。
//
// 默认用内置的接口（001 提供的彩云接口），天气、详细数据和预警都从这里一次取到，装好就有；
// 想换成自己的，选「自己的彩云接口」填地址和 token；想用备用的 Open-Meteo，选它——那边只有基础的天气。
// 说明文字一句一行。

import { Button, HStack, Picker, SecureField, Spacer, Text, TextField } from "scripting";
import { OFFICIAL_HOST } from "../core/caiyun";
import type { DataSource, SourceMode } from "../core/dataSource";
import type { Loaded } from "../core/load";
import { sourceStatusText } from "../core/present";
import { Fold, type FoldState } from "./Fold";

const CUSTOM_HELP =
  "服务地址要以 https:// 开头\n" +
  "用彩云官方的服务：地址填 " +
  OFFICIAL_HOST +
  "\ntoken 填你在彩云平台申请的\n" +
  "token 是地址里的一段，不能带斜杠\n" +
  "地址和 token 只存在这台手机上\n" +
  "填好点「保存并测试」才会生效\n\n";

const FOOTER =
  "内置：天气、详细数据和预警都从 001 提供的彩云接口取，什么都不用填\n" +
  "自己的：用你自己的彩云接口，填服务地址和 token\n" +
  "Open-Meteo：备用，只有基础的天气，没有详细数据和预警\n\n" +
  "取天气会发出取整到小数点后两位（约 1 公里）的经纬度\n" +
  "加上联网都会带的 IP 地址\n" +
  "不含账号、设备名称";

/** 标题后面写现在用的是哪一种，收起时也看得见 */
const SOURCE_NOTE: Readonly<Record<SourceMode, string>> = { builtin: "内置", custom: "自己的", openmeteo: "Open-Meteo" };

export function SourceSection({
  source,
  choice,
  loaded,
  now,
  hostText,
  tokenText,
  busy,
  onChoice,
  setHostText,
  setTokenText,
  saveCustom,
  clearCustom,
  fold,
}: {
  /** 存着的设置：现在生效的是哪一种，「自己的」填过什么 */
  source: DataSource;
  /** 选择器停在哪一项。选了「自己的」但还没保存时，和 `source.mode` 不一样 */
  choice: SourceMode;
  /** null 表示还没取过 */
  loaded: Loaded | null;
  now: number;
  hostText: string;
  tokenText: string;
  busy: boolean;
  onChoice: (mode: SourceMode) => void;
  setHostText: (value: string) => void;
  setTokenText: (value: string) => void;
  saveCustom: () => void;
  clearCustom: () => void;
  fold: FoldState;
}) {
  const hasToken = source.token !== "";
  const canSave = hostText.trim() !== "" && (tokenText.trim() !== "" || hasToken) && !busy;
  const custom = choice === "custom";
  return (
    <Fold title="天气来源" note={SOURCE_NOTE[source.mode]} fold={fold} footer={(custom ? CUSTOM_HELP : "") + FOOTER}>
      <Picker title="数据从哪里来" value={choice} onChanged={(value: string) => onChoice(value as SourceMode)}>
        <Text tag="builtin">内置（001 提供）</Text>
        <Text tag="custom">自己的彩云接口</Text>
        <Text tag="openmeteo">Open-Meteo（备用）</Text>
      </Picker>
      <HStack>
        <Text>状态</Text>
        <Spacer />
        <Text foregroundStyle="secondaryLabel" multilineTextAlignment="trailing">
          {sourceStatusText(loaded, now)}
        </Text>
      </HStack>
      {custom ? (
        <TextField
          title="服务地址"
          prompt={OFFICIAL_HOST}
          value={hostText}
          onChanged={setHostText}
          keyboardType="URL"
          textInputAutocapitalization="never"
          autocorrectionDisabled
        />
      ) : null}
      {custom ? (
        <SecureField
          title="token"
          prompt={hasToken ? "已填，想换就重新粘贴" : "粘贴你的 token"}
          value={tokenText}
          onChanged={setTokenText}
        />
      ) : null}
      {custom ? (
        <Button action={saveCustom}>
          <Text foregroundStyle={canSave ? "systemBlue" : "secondaryLabel"}>保存并测试</Text>
        </Button>
      ) : null}
      {custom && (hasToken || source.host !== "") ? (
        <Button role="destructive" action={clearCustom}>
          <Text foregroundStyle="systemRed">清除自己的设置</Text>
        </Button>
      ) : null}
    </Fold>
  );
}
