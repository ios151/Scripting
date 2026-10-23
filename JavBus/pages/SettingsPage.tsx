// 设置页：收藏数据（导入 / 导出 / 清空）、偏好、Quicker 推送、分享链接、推荐服务、
// 站点验证与 cookie、缓存、关于。
//
// 原版没有设置页——Quicker 邮箱口令是点磁链时现场弹输入框、各种提示靠 $cache 键。
// 这里把这些隐含的状态都摆出来。输入类设置统一用 Dialog.prompt 逐项修改，
// 不在文本框里逐字提交（逐字提交会让「清空地址」瞬间被默认值顶回去，没法重新输入）。

import {
  Button,
  HStack,
  List,
  Navigation,
  NavigationStack,
  Section,
  Spacer,
  Text,
  Toggle,
  ZStack,
  useEffect,
  useState,
} from "scripting";

import { ORIGIN_VERSION, SITE_ORIGIN, VERSION } from "../core/constants";
import { libraryCounts } from "../core/library";
import { PLAYER_TEMPLATE_EXAMPLE } from "../core/player";
import { channelUsesCommunity, normalizeCommunityUrl } from "../core/recommend";
import { COMMUNITY_FOOTER, COMMUNITY_PROMPT, LEGACY_SERVICE_FOOTER, PLAYER_TEMPLATE_FOOTER, PLAYER_TEMPLATE_PROMPT } from "../core/texts";
import { exportBackupFile, importBackupFromFile } from "../kit/backup";
import { clearCookies, cookieCounts } from "../kit/cookies";
import { describeError } from "../kit/http";
import { clearImageCache, imageCacheSize } from "../kit/images";
import { testCommunity } from "../kit/recommend";
import { manualAgeVerify } from "../kit/session";
import {
  DEFAULT_SETTINGS,
  getFlags,
  getSettings,
  resetFlags,
  updateSettings,
  type Settings,
} from "../kit/settings";
import { store, useLibrary } from "../kit/store";
import { showError, showToast } from "../kit/toast";
import { AuthorFooter } from "./AuthorFooter";
import { showDeclaration, showReleaseNotes } from "./TextSheet";
import { PageBackdrop } from "./theme";
import { useToastHost } from "./useToastHost";

/** 一行「标题 + 当前值」，点一下用输入框改。 */
function ValueRow({
  title,
  value,
  placeholder,
  secret,
  keyboard = "URL",
  message,
  onEdit,
}: {
  title: string;
  value: string;
  placeholder: string;
  secret?: boolean;
  keyboard?: "URL" | "emailAddress" | "default";
  /** 输入框上方的说明。系统弹窗的正文不能长，长说明放在这一节的 footer 里。 */
  message?: string;
  onEdit: (next: string) => void;
}) {
  const shown = !value ? "未设置" : secret ? "••••••" : value;
  return (
    <Button
      buttonStyle="plain"
      action={async () => {
        const next = await Dialog.prompt({
          title,
          message,
          placeholder,
          defaultValue: value,
          selectAll: true,
          confirmLabel: "保存",
          cancelLabel: "取消",
          keyboardType: keyboard,
        });
        if (next !== null) onEdit(next);
      }}
    >
      {/* contentShape：Spacer 那一段默认不响应点击，不加的话只有两端的文字能点 */}
      <HStack contentShape="rect">
        <Text>{title}</Text>
        <Spacer />
        <Text foregroundStyle="secondaryLabel" lineLimit={1} frame={{ maxWidth: 190, alignment: "trailing" }}>
          {shown}
        </Text>
      </HStack>
    </Button>
  );
}

function CountRow({ label, value }: { label: string; value: string }) {
  return (
    <HStack>
      <Text foregroundStyle="secondaryLabel">{label}</Text>
      <Spacer />
      <Text>{value}</Text>
    </HStack>
  );
}

const COUNT_LABELS: [keyof ReturnType<typeof libraryCounts>, string][] = [
  ["favorite", "收藏影片"],
  ["archive", "归档影片"],
  ["picks", "我的精选"],
  ["actress", "收藏演员"],
  ["director", "收藏导演"],
  ["series", "收藏系列"],
  ["filmMaker", "收藏制作商"],
  ["filmEstab", "收藏发行商"],
];

export function SettingsPage() {
  const dismiss = Navigation.useDismiss();
  const lib = useLibrary();
  const [settings, setSettings] = useState<Settings>(getSettings());
  const [cookies, setCookies] = useState(cookieCounts());
  const [images, setImages] = useState(imageCacheSize());
  const [flags, setFlags] = useState(getFlags());
  const toast = useToastHost(); // 设置页是整页弹出的，会盖住 TabView 上的提示，自己要有一个宿主

  useEffect(() => {
    setCookies(cookieCounts());
    setImages(imageCacheSize());
    setFlags(getFlags());
  }, []);

  const update = (patch: Partial<Settings>) => setSettings(updateSettings(patch));
  const counts = libraryCounts(lib);

  const run = async (task: () => Promise<string | null | boolean>, okMessage?: string) => {
    try {
      const result = await task();
      if (typeof result === "string") showToast(result);
      else if (result === true && okMessage) showToast(okMessage);
    } catch (error) {
      showError(describeError(error));
    }
  };

  const confirmClearLibrary = async () => {
    const ok = await Dialog.confirm({
      title: "清空全部收藏",
      message: `影片 ${counts.favorite}、归档 ${counts.archive}、演员 ${counts.actress} 等全部收藏数据都会删除，无法恢复。建议先导出备份。`,
      confirmLabel: "清空",
      cancelLabel: "取消",
    });
    if (ok) {
      store.clear();
      showToast("已清空");
    }
  };

  const setCommunityUrl = (value: string) => {
    const text = value.trim();
    // 填了但不是 http(s) 地址：别悄悄存成空（sanitize 会把它清掉），当场说清楚
    if (text && !normalizeCommunityUrl(text)) {
      showError("地址要以 http:// 或 https:// 开头");
      return;
    }
    update({ communityUrl: text });
  };

  const testConnection = async () => {
    showToast("连接中…");
    const result = await testCommunity(settings.communityUrl);
    if (result.ok) showToast(result.message);
    else showError(result.message);
  };

  const restoreRecommendDefaults = () =>
    update({
      communityUrl: DEFAULT_SETTINGS.communityUrl,
      recUrlAuthor: DEFAULT_SETTINGS.recUrlAuthor,
      recUrlUser: DEFAULT_SETTINGS.recUrlUser,
      uploadUrlAuthor: DEFAULT_SETTINGS.uploadUrlAuthor,
      uploadUrlUser: DEFAULT_SETTINGS.uploadUrlUser,
    });

  const verifyByWeb = async () => {
    try {
      await manualAgeVerify(`${SITE_ORIGIN}/`);
      setCookies(cookieCounts());
      showToast("已读取站点 cookie");
    } catch (error) {
      showError(describeError(error));
    }
  };

  return (
    // 这是单独 present 出来的 modal：不去赌它继承不继承 App 根视图的深色，自己也锁一次
    <NavigationStack preferredColorScheme="dark">
      <ZStack>
        <PageBackdrop />
        <List
          navigationTitle="设置"
          navigationBarTitleDisplayMode="inline"
          scrollContentBackground="hidden"
          toolbar={{ topBarLeading: [<Button key="done" title="完成" action={() => dismiss()} />] }}
          toast={toast}
        >
          <Section header={<Text>收藏数据</Text>} footer={<Text>备份文件与 JSBox 原版的 JavBusBackup.json 同一格式，两边可以互导。</Text>}>
            {COUNT_LABELS.map(([key, label]) => (
              <CountRow key={key} label={label} value={String(counts[key])} />
            ))}
            <Button title="导入备份" systemImage="square.and.arrow.down" action={() => void run(importBackupFromFile)} />
            <Button title="导出备份" systemImage="square.and.arrow.up" action={() => void run(exportBackupFile, "已导出")} />
            <Button title="清空全部收藏" systemImage="trash" foregroundStyle="systemRed" action={() => void confirmClearLibrary()} />
          </Section>

          <Section header={<Text>偏好</Text>}>
            <Toggle
              title="启动时检测剪贴板里的番号"
              value={settings.checkClipboard}
              onChanged={(on: boolean) => update({ checkClipboard: on })}
            />
            <Toggle
              title="进入详情自动播放预览"
              value={settings.autoPreview}
              onChanged={(on: boolean) => update({ autoPreview: on })}
            />
            <Toggle
              title="进入详情预取 MissAV 完整视频"
              value={settings.prefetchMissav}
              onChanged={(on: boolean) => update({ prefetchMissav: on })}
            />
            <Toggle
              title="MissAV 用电脑版页面（可出 1080p）"
              value={settings.missavDesktop}
              onChanged={(on: boolean) => update({ missavDesktop: on })}
            />
          </Section>

          <Section header={<Text>外部播放器</Text>} footer={<Text>{PLAYER_TEMPLATE_FOOTER}</Text>}>
            <ValueRow
              title="自定义链接模板"
              value={settings.playerTemplate}
              placeholder={PLAYER_TEMPLATE_EXAMPLE}
              message={PLAYER_TEMPLATE_PROMPT}
              onEdit={(v) => update({ playerTemplate: v })}
            />
          </Section>

          <Section header={<Text>Quicker 推送</Text>} footer={<Text>配置后，点击磁链复制的同时会把它推送到电脑上的 Quicker。</Text>}>
            <ValueRow title="Quicker 邮箱" value={settings.quickerMail} placeholder="name@example.com" keyboard="emailAddress" onEdit={(v) => update({ quickerMail: v })} />
            <ValueRow title="Quicker 口令" value={settings.quickerCode} placeholder="口令" secret keyboard="default" onEdit={(v) => update({ quickerCode: v })} />
            {settings.quickerMail || settings.quickerCode ? (
              <Button
                title="清除 Quicker 配置"
                foregroundStyle="systemRed"
                action={() => update({ quickerMail: "", quickerCode: "" })}
              />
            ) : null}
          </Section>

          <Section
            header={<Text>分享链接</Text>}
            footer={
              <Text>
                默认分享 scripting://run/JavBus?code=番号（点开会直接打开本脚本）。如果你有自己的中转页，
                可以填模板，{"{code}"} 会换成番号；http(s) 开头的会再用 is.gd 缩短。
              </Text>
            }
          >
            <ValueRow title="链接模板" value={settings.shareTemplate} placeholder="https://example.com/?code={code}" onEdit={(v) => update({ shareTemplate: v })} />
          </Section>

          <Section
            header={<Text>推荐服务</Text>}
            footer={<Text>{settings.communityUrl ? COMMUNITY_FOOTER : LEGACY_SERVICE_FOOTER}</Text>}
          >
            <ValueRow
              title="社区服务地址"
              value={settings.communityUrl}
              placeholder="https://xxx.workers.dev"
              message={COMMUNITY_PROMPT}
              onEdit={setCommunityUrl}
            />
            {settings.communityUrl ? <Button title="测试连接" systemImage="network" action={() => void testConnection()} /> : null}
            {/* 归社区服务管的列表用社区的接口，它们的高级地址不起作用，就不摆出来；其余（作者精选）照旧可改 */}
            {channelUsesCommunity("author", settings.communityUrl) ? null : (
              <>
                <ValueRow title="作者推荐列表" value={settings.recUrlAuthor} placeholder="JSON 地址" onEdit={(v) => update({ recUrlAuthor: v })} />
                <ValueRow title="作者上传服务" value={settings.uploadUrlAuthor} placeholder="服务地址" onEdit={(v) => update({ uploadUrlAuthor: v })} />
              </>
            )}
            {channelUsesCommunity("user", settings.communityUrl) ? null : (
              <>
                <ValueRow title="网友推荐列表" value={settings.recUrlUser} placeholder="JSON 地址" onEdit={(v) => update({ recUrlUser: v })} />
                <ValueRow title="网友上传服务" value={settings.uploadUrlUser} placeholder="服务地址" onEdit={(v) => update({ uploadUrlUser: v })} />
              </>
            )}
            <Button title="恢复默认" foregroundStyle="secondaryLabel" action={restoreRecommendDefaults} />
          </Section>

          <Section
            header={<Text>站点验证</Text>}
            footer={
              <Text>
                JavBus 有时会要求确认年满 18 岁。脚本第一次遇到会先问你；没生效时可以在这里打开网页自己确认一次。
              </Text>
            }
          >
            <CountRow label="代为提交年龄确认" value={flags.siteAge ? "已同意" : "未设置"} />
            <CountRow label="已保存的 cookie" value={`有码 ${cookies.com} · 欧美 ${cookies.org}`} />
            <Button title="打开网页手动验证" systemImage="safari" action={() => void verifyByWeb()} />
            <Button
              title="清除站点 cookie"
              systemImage="trash"
              foregroundStyle="systemRed"
              action={() => {
                clearCookies();
                setCookies(cookieCounts());
                showToast("已清除");
              }}
            />
          </Section>

          <Section header={<Text>缓存与提示</Text>}>
            <CountRow label="内存里的图片" value={`${images} 张`} />
            <Button
              title="清理图片缓存"
              systemImage="photo.on.rectangle"
              action={() => {
                clearImageCache();
                setImages(imageCacheSize());
                showToast("已清理");
              }}
            />
            <Button
              title="重置 18+ 确认与首次提示"
              systemImage="arrow.counterclockwise"
              action={() => {
                resetFlags();
                setFlags(getFlags());
                showToast("下次打开会重新提示");
              }}
            />
          </Section>

          <Section header={<Text>关于</Text>}>
            <CountRow label="版本" value={`${VERSION}（对标 JSBox 原版 ${ORIGIN_VERSION}）`} />
            <Button title="作者声明" systemImage="doc.text" action={showDeclaration} />
            <Button title="更新说明" systemImage="sparkles" action={showReleaseNotes} />
            <Button title="原作者 @nicked" systemImage="paperplane" action={() => void Safari.openURL("https://t.me/nicked")} />
          </Section>

          <AuthorFooter />
        </List>
      </ZStack>
    </NavigationStack>
  );
}
