// 应用管理：自己装的 App，按占用空间或名称排，可搜索、按来源筛选、复制清单；详情页可卸载。

import {
  Button,
  HStack,
  Image,
  List,
  Menu,
  Navigation,
  NavigationLink,
  ProgressView,
  RoundedRectangle,
  Section,
  Spacer,
  Text,
  VStack,
  useRef,
  useState,
  type Color,
} from "scripting";
import type { PlistDict } from "../kit/plist";
import { debugLog, describeError } from "../core/debug";
import {
  ENTITLEMENT_HIGHLIGHTS,
  INFO_HIGHLIGHTS,
  SOURCE_LABEL,
  appListText,
  entitlementsOf,
  installTimes,
  readAppDetail,
  sinceText,
  urlSchemes,
  formatAge,
  isScriptingItself,
  loadSizeCache,
  readAppSizes,
  saveSizeCache,
  readApps,
  sortApps,
  totalSize,
  uninstallApp,
  versionText,
  withSizes,
  type AppEntry,
  type AppSizes,
  type AppSort,
  type AppSource,
} from "../kit/apps";
import { findStoreLinks, shareText, type StoreLink } from "../kit/appStore";
import { loadCachedIcons, saveCachedIcons } from "../kit/cache";
import { deviceHub } from "../kit/hub";
import {
  findRowAction,
  loadRowActions,
  rowActionText,
  type RowActionId,
} from "../kit/rowActions";
import { flattenSorted, formatBytes, formatValue, readHomeLayout, readIcons } from "../kit/services";
import { withKeepAlive } from "../utils/keepalive";
import { RawListPage } from "./RawListPage";
import { RowActionsPage } from "./RowActionsPage";
import { copyWithFeedback, TaskStateSection, useDeviceTask, ValueRow } from "./common";

const SOURCE_COLOR: Record<AppSource, Color> = {
  appStore: "secondaryLabel",
  testFlight: "systemBlue",
  development: "systemOrange",
  distribution: "systemPurple",
  other: "systemPink",
};

const SOURCES: AppSource[] = ["appStore", "testFlight", "development", "distribution", "other"];

function sizeText(app: AppEntry): string {
  return app.appSize === null && app.dataSize === null ? "—" : formatBytes(totalSize(app));
}

/** App 图标。还没载入时画个灰方块占位，免得列表的行高一直在跳。 */
function AppIcon({ icon, size = 30 }: { icon: UIImage | undefined; size?: number }) {
  const shape = { type: "rect", cornerRadius: size * 0.22 } as const;
  return icon ? (
    <Image image={icon} resizable frame={{ width: size, height: size }} clipShape={shape} />
  ) : (
    <RoundedRectangle cornerRadius={size * 0.22} fill="tertiarySystemFill" frame={{ width: size, height: size }} />
  );
}

function AppRow({ app, icon, since }: { app: AppEntry; icon: UIImage | undefined; since?: string }) {
  return (
    <HStack spacing={10}>
      <AppIcon icon={icon} />
      <VStack alignment="leading" spacing={2}>
        {/* 显式给 label 色：多选时整行是 Button，不写的话名字会被染成按钮的蓝色 */}
        <Text foregroundStyle="label" lineLimit={1}>{app.name}</Text>
        <HStack spacing={4}>
          <Text font="caption" foregroundStyle={SOURCE_COLOR[app.source]}>
            {SOURCE_LABEL[app.source]}
          </Text>
          <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={1}>
            {since ? `· ${since}` : `· ${versionText(app)}`}
          </Text>
        </HStack>
      </VStack>
      <Spacer />
      <Text font="subheadline" foregroundStyle="secondaryLabel">
        {sizeText(app)}
      </Text>
    </HStack>
  );
}

function AppDetailPage({ app, icon, onUninstalled }: { app: AppEntry; icon: UIImage | undefined; onUninstalled: (bundleId: string) => void }) {
  const dismiss = Navigation.useDismiss();
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState("");
  const isSelf = isScriptingItself(app);
  /** undefined：还没查；null：查过，没有。点按钮才查，不进页就往外发请求。 */
  const [link, setLink] = useState<StoreLink | null | undefined>(undefined);
  const [looking, setLooking] = useState(false);
  const [linkError, setLinkError] = useState("");

  /** 整份 Info.plist（含 entitlements）。点了才查：一个 App 的回包就有几十 KB。 */
  const [detail, setDetail] = useState<PlistDict | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");

  async function loadDetail() {
    if (loadingDetail) return;
    setLoadingDetail(true);
    setDetailError("");
    try {
      setDetail(await readAppDetail(await deviceHub.get(), app.bundleId));
    } catch (error) {
      setDetailError(`读取失败：${describeError(error)}`);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function lookUpLink() {
    if (looking) return;
    setLooking(true);
    setLinkError("");
    try {
      const found = await findStoreLinks([app.bundleId], { locale: Device.systemLocale });
      setLink(found.get(app.bundleId) ?? null);
    } catch (error) {
      setLinkError(`查询失败：${describeError(error)}`);
    } finally {
      setLooking(false);
    }
  }

  async function uninstall() {
    if (working || isSelf) return;
    const ok = await Dialog.confirm({
      title: `卸载「${app.name}」？`,
      message: "App 和它在本机的全部数据会一起删除，不能恢复。存在 iCloud 里的数据不受影响，以后可以重新下载。",
      confirmLabel: "卸载",
    });
    if (!ok) return;
    setWorking("卸载中…");
    setMessage("");
    try {
      await uninstallApp(await deviceHub.get(), app.bundleId, (percent) => setWorking(`卸载中 ${percent}%`));
      onUninstalled(app.bundleId);
      dismiss();
    } catch (error) {
      setMessage(`卸载失败：${describeError(error)}`);
    } finally {
      setWorking("");
    }
  }

  return (
    <List navigationTitle={app.name} navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section header={<Text>基本</Text>} footer={<Text foregroundStyle="tertiaryLabel">点一行或长按都能复制。</Text>}>
        <HStack spacing={12}>
          <AppIcon icon={icon} size={52} />
          <VStack alignment="leading" spacing={2}>
            <Text fontWeight="medium" lineLimit={1}>{app.name}</Text>
            <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{app.bundleId}</Text>
          </VStack>
          <Spacer />
        </HStack>
        <ValueRow label="名称" value={app.name} />
        <ValueRow label="版本" value={versionText(app)} />
        <ValueRow label="Bundle ID" value={app.bundleId} />
        <ValueRow label="来源" value={SOURCE_LABEL[app.source]} />
      </Section>

      <Section header={<Text>占用空间</Text>}>
        <ValueRow label="安装包" value={app.appSize === null ? "—" : formatBytes(app.appSize)} />
        <ValueRow label="文稿与数据" value={app.dataSize === null ? "—" : formatBytes(app.dataSize)} />
        <ValueRow label="合计" value={sizeText(app)} />
      </Section>

      <Section
        header={<Text>签名</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            来源是按签名推断的：App Store 由 Apple 重签；TestFlight 带测试标记；开发签可调试；企业 / Ad Hoc 用分发证书。
            对不上的归为「其他签名」。
          </Text>
        }
      >
        <ValueRow label="证书" value={app.signer || "—"} />
        <ValueRow label="Team ID" value={app.teamId || "—"} />
        <ValueRow label="App ID" value={app.appIdentifier || "—"} />
      </Section>

      <Section
        header={<Text>配置</Text>}
        footer={
          <Text foregroundStyle={detailError ? "systemRed" : "tertiaryLabel"}>
            {detailError || "读整份 Info.plist 和 entitlements：查 URL scheme、后台模式、推送环境、App Groups。点一行或长按都能复制。"}
          </Text>
        }
      >
        {detail ? (
          [
            ...INFO_HIGHLIGHTS.filter(([key]) => detail[key] !== undefined).map(([key, label]) => (
              <ValueRow key={key} label={label} value={formatValue(detail[key])} />
            )),
            <ValueRow key="schemes" label="注册的 URL scheme" value={urlSchemes(detail).join("、") || "无"} />,
            ...ENTITLEMENT_HIGHLIGHTS.filter(([key]) => entitlementsOf(detail)[key] !== undefined).map(([key, label]) => (
              <ValueRow key={key} label={label} value={formatValue(entitlementsOf(detail)[key])} />
            )),
            <NavigationLink key="info" destination={<RawListPage title="Info.plist" rows={flattenSorted(detail)} />}>
              <Text>{`完整 Info.plist（${Object.keys(detail).length} 项）`}</Text>
            </NavigationLink>,
            <NavigationLink
              key="ent"
              destination={<RawListPage title="Entitlements" rows={flattenSorted(entitlementsOf(detail))} />}
            >
              <Text>{`完整 entitlements（${Object.keys(entitlementsOf(detail)).length} 项）`}</Text>
            </NavigationLink>,
          ]
        ) : loadingDetail ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel">读取中…</Text>
          </HStack>
        ) : (
          <Button title="读取 Info.plist 和 entitlements" systemImage="doc.text.magnifyingglass" action={() => void loadDetail()} />
        )}
      </Section>

      <Section
        header={<Text>App Store</Text>}
        footer={
          <Text foregroundStyle={linkError ? "systemRed" : "tertiaryLabel"}>
            {linkError ||
              (link === null
                ? "没在 App Store 上查到。TestFlight 的邀请链接设备上没有；自签时改过 bundle ID 的也查不到。"
                : link && app.source !== "appStore"
                  ? "这是 App Store 上正式版的页面，不是你现在装的这个版本。"
                  : "按 bundle ID 查苹果的公开接口，只发 bundle ID 和地区。")}
          </Text>
        }
      >
        {link ? (
          [
            <ValueRow key="url" label="链接" value={link.url} />,
            <ValueRow key="genre" label="分类" value={link.genre || "—"} />,
            <Button key="share" title="分享链接" systemImage="square.and.arrow.up" action={() => void ShareSheet.present([link.url])} />,
            <Button key="open" title="在 App Store 打开" systemImage="arrow.up.forward.app" action={() => void Safari.openURL(link.url)} />,
          ]
        ) : looking ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel">查询中…</Text>
          </HStack>
        ) : link === undefined ? (
          <Button title="查找 App Store 链接" systemImage="magnifyingglass" action={() => void lookUpLink()} />
        ) : null}
      </Section>

      <Section
        footer={
          <Text foregroundStyle={message ? "systemRed" : "tertiaryLabel"}>
            {message || (isSelf ? "这是 Scripting 自己，卸载会把正在运行的脚本一起删掉，这里不提供。" : "卸载前会弹窗确认。")}
          </Text>
        }
      >
        {working ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel">{working}</Text>
          </HStack>
        ) : (
          <Button title="卸载 App" systemImage="trash" role="destructive" disabled={isSelf} action={() => void uninstall()} />
        )}
      </Section>
    </List>
  );
}

export function AppsPage() {
  const [sizes, setSizes] = useState<Map<string, AppSizes>>(new Map());
  const [sizeStatus, setSizeStatus] = useState("");
  const [iconStatus, setIconStatus] = useState("");
  const sizesBusy = useRef(false);
  /** App 图标。有的 App 名字是英文，和主屏上看到的不一样，光看名字认不出来。 */
  const [icons, setIcons] = useState<Map<string, UIImage>>(new Map());
  const iconsBusy = useRef(false);
  /** bundleId → 安装 / 更新时间。来自主屏布局的 iconModDate。 */
  const [installedAt, setInstalledAt] = useState<Map<string, number>>(new Map());

  function toImages(pngs: Map<string, Uint8Array>): Map<string, UIImage> {
    const map = new Map<string, UIImage>();
    for (const [id, png] of pngs) {
      const data = Data.fromUint8Array(png);
      const image = data ? UIImage.fromData(data) : null;
      if (image) map.set(id, image);
    }
    return map;
  }

  /**
   * 图标：先摆缓存里的，再只去设备上取缺的那几个，**取一批铺一批**。
   *
   * 一百多个图标是一个个取的，每次重取要等十几秒，而图标基本不变，所以有缓存。
   * 没缓存的那几百个以前是全取完才一次性铺上去，前面十几秒满屏灰方块；
   * 现在每攒够一批就显示出来，从列表顶上往下慢慢长出来。
   */
  async function loadIcons(bundleIds: string[], refresh = false) {
    if (iconsBusy.current) return;
    iconsBusy.current = true;
    try {
      const cached = refresh ? new Map<string, Uint8Array>() : await loadCachedIcons(bundleIds);
      if (cached.size > 0) setIcons(toImages(cached));
      const missing = bundleIds.filter((id) => !cached.has(id));
      if (missing.length === 0) return;
      setIconStatus(`载入图标 0/${missing.length}`);
      // 几百个图标逐个取要十几秒，这期间切走不保活就断在半路
      const fetched = await withKeepAlive("apps-icons", async () =>
        readIcons(
          await deviceHub.get(),
          missing,
          (done, total) => setIconStatus(`载入图标 ${done}/${total}`),
          (batch) => setIcons((current) => new Map([...current, ...toImages(batch)])),
        ),
      );
      await saveCachedIcons(fetched);
    } catch (error) {
      // 取不到就显示占位方块，不影响别的
      debugLog("apps", "图标没取到", describeError(error));
    } finally {
      setIconStatus("");
      iconsBusy.current = false;
    }
  }

  /** 右上角「重新载入」：丢掉缓存，图标和占用空间都重新从设备取一遍。 */
  async function refreshCaches() {
    const ids = (task.data ?? []).map((app) => app.bundleId);
    if (ids.length === 0) return;
    setMessage("");
    setIcons(new Map());
    setSizes(new Map());
    Storage.remove("appSizes");
    void loadIcons(ids, true);
    void loadSizes(ids, true);
  }

  /**
   * 占用空间：先摆上次缓存的数，后台重新算，回来一组替换一组，算完存缓存。
   * 算不出来列表照样能用。
   */
  async function loadSizes(bundleIds: string[], refresh = false) {
    if (sizesBusy.current) return;
    sizesBusy.current = true;
    const cache = refresh ? null : loadSizeCache();
    if (cache) setSizes(cache.sizes);
    const label = cache ? `显示的是${formatAge(Date.now() - cache.savedAt)}的统计，正在刷新` : "正在计算占用空间";
    setSizeStatus(`${label}…`);
    const fresh = new Map<string, AppSizes>();
    try {
      // 一百多个 App 的占用空间是设备逐个算的，半分钟起步，同样要保活
      await withKeepAlive("apps-sizes", async () =>
        readAppSizes(await deviceHub.get(), bundleIds, (batch, done, total) => {
          for (const [bundleId, size] of batch) fresh.set(bundleId, size);
          setSizes((current) => new Map([...current, ...batch]));
          setSizeStatus(`${label} ${done}/${total}…`);
        }),
      );
      saveSizeCache(fresh);
      setSizeStatus("");
    } catch (error) {
      setSizeStatus(`占用空间没算完：${describeError(error)}${cache ? "。没刷新到的显示上次的统计" : ""}`);
    } finally {
      sizesBusy.current = false;
    }
  }

  const task = useDeviceTask(async (session, log) => {
    const apps = await readApps(session, log);
    // 列表先出来，图标和大小都在后台补
    const ids = apps.map((app) => app.bundleId);
    // 安装时间在主屏布局里，顺带读一次；读不到不影响别的
    readHomeLayout(session)
      .then((layout) => setInstalledAt(installTimes(layout.raw)))
      .catch((error) => debugLog("apps", "安装时间没取到", describeError(error)));
    setTimeout(() => void loadIcons(ids), 0);
    setTimeout(() => void loadSizes(ids), 0);
    return apps;
  });
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<AppSort>("size");
  const [filter, setFilter] = useState<AppSource | "all">("all");
  /** 刚卸载的直接从列表里拿掉，不用整页重读。 */
  const [removed, setRemoved] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  /** 多选：分享 App Store 链接，分享完再问要不要卸载（「领取 → 收藏 → 删除」一条龙）。 */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [working, setWorking] = useState("");
  /** 长按菜单放哪几项、什么顺序，用户自己定，存在 Storage 里。 */
  const [rowActions, setRowActions] = useState<RowActionId[]>(() => loadRowActions());

  function togglePick(bundleId: string) {
    setPicked((list) => (list.includes(bundleId) ? list.filter((id) => id !== bundleId) : [...list, bundleId]));
  }

  function exitSelecting() {
    setSelecting(false);
    setPicked([]);
  }

  /**
   * 查链接 → 系统分享面板 → 真分享出去了才问要不要卸载 → 逐个卸载。
   * 没查到链接的不分享、也不卸载；Scripting 自己永远不卸。
   */
  /** 逐个卸载，返回结果说明。调用方负责确认和退出多选。 */
  async function uninstallMany(targets: AppEntry[]): Promise<string> {
    const session = await deviceHub.get();
    const done: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const app = targets[i];
      setWorking(`卸载中 ${i + 1}/${targets.length}：${app.name}`);
      try {
        await uninstallApp(session, app.bundleId);
        done.push(app.bundleId);
      } catch (error) {
        failed.push(`${app.name}（${describeError(error)}）`);
      }
    }
    setRemoved((list) => [...list, ...done]);
    return failed.length === 0 ? `✓ 已卸载 ${done.length} 个` : `已卸载 ${done.length} 个；没卸掉：${failed.join("；")}`;
  }

  /** 左滑或长按卸载单个。确认框照旧，不因为入口快就省掉。 */
  async function uninstallOne(app: AppEntry) {
    if (working) return;
    if (isScriptingItself(app)) {
      setMessage("这是 Scripting 自己，卸载会把正在运行的脚本一起删掉。");
      return;
    }
    const ok = await Dialog.confirm({
      title: `卸载「${app.name}」？`,
      message: `占用约 ${formatBytes(totalSize(app))}。App 和它在本机的数据会一起删除，不能恢复；存在 iCloud 里的数据不受影响。`,
      confirmLabel: "卸载",
    });
    if (!ok) return;
    setMessage("");
    try {
      setMessage(await uninstallMany([app]));
    } catch (error) {
      setMessage(`卸载失败：${describeError(error)}`);
    } finally {
      setWorking("");
    }
  }

  /**
   * 执行长按菜单里的一项。复制类直接进剪贴板；App Store 那两项要先查链接。
   * 查链接会走网络、可能查不到，所以结果都落在页脚的提示里，不弹窗打断。
   */
  async function runRowAction(id: RowActionId, app: AppEntry) {
    const copied = rowActionText(id, app);
    if (copied !== null) {
      if (!copied) {
        setMessage(`「${app.name}」没有这一项。`);
        return;
      }
      copyWithFeedback(copied);
      setMessage(`✓ 已复制：${copied}`);
      return;
    }
    if (id === "uninstall") {
      await uninstallOne(app);
      return;
    }
    if (working) return;
    setMessage("");
    setWorking(`查 App Store 链接：${app.name}…`);
    try {
      const found = await findStoreLinks([app.bundleId], { locale: Device.systemLocale });
      const link = found.get(app.bundleId);
      if (!link) {
        setMessage(`「${app.name}」没在 App Store 上查到（TestFlight、自签的常见）。`);
        return;
      }
      if (id === "store-open") await Safari.openURL(link.url);
      else await ShareSheet.present([link.url]);
    } catch (error) {
      setMessage(`查询失败：${describeError(error)}`);
    } finally {
      setWorking("");
    }
  }

  /** 直接批量卸载，不经过分享。 */
  async function uninstallPicked() {
    if (working) return;
    const chosen = all.filter((app) => picked.includes(app.bundleId));
    const removable = chosen.filter((app) => !isScriptingItself(app));
    if (removable.length === 0) {
      setMessage(chosen.length > 0 ? "选中的只有 Scripting 自己，不能卸载。" : "");
      return;
    }
    const skipped = chosen.length - removable.length;
    const names = removable.slice(0, 8).map((app) => app.name).join("、") + (removable.length > 8 ? "…" : "");
    const total = removable.reduce((sum, app) => sum + totalSize(app), 0);
    const ok = await Dialog.confirm({
      title: `卸载这 ${removable.length} 个 App？`,
      message:
        `${names}\n\n合计约 ${formatBytes(total)}。App 和它们在本机的数据会一起删除，不能恢复；` +
        `存在 iCloud 里的数据不受影响。${skipped > 0 ? "\n（Scripting 自己不会被卸载。）" : ""}`,
      confirmLabel: "卸载",
    });
    if (!ok) return;
    setMessage("");
    try {
      setMessage(await uninstallMany(removable));
      exitSelecting();
    } catch (error) {
      setMessage(`卸载中断：${describeError(error)}`);
    } finally {
      setWorking("");
    }
  }

  async function shareAndClean(format: "links" | "text") {
    if (working) return;
    const chosen = all.filter((app) => picked.includes(app.bundleId));
    if (chosen.length === 0) return;
    setMessage("");
    setWorking(`查 App Store 链接（${chosen.length} 个）…`);
    try {
      const links = await findStoreLinks(
        chosen.map((app) => app.bundleId),
        { locale: Device.systemLocale },
      );
      const linked = chosen.filter((app) => links.has(app.bundleId));
      const missing = chosen.length - linked.length;
      setWorking("");
      if (linked.length === 0) {
        setMessage("选中的 App 都没在 App Store 上查到链接（TestFlight、自签的常见）。");
        return;
      }
      const items =
        format === "links"
          ? linked.map((app) => links.get(app.bundleId)!.url)
          : [shareText(linked.map((app) => ({ name: app.name, link: links.get(app.bundleId)! })))];
      if (!(await ShareSheet.present(items))) {
        setMessage("已取消分享，没有卸载任何 App。");
        return;
      }
      const removable = linked.filter((app) => !isScriptingItself(app));
      const skipped = missing > 0 ? `没查到链接的 ${missing} 个没分享，也不会卸载。` : "";
      if (removable.length === 0) {
        setMessage(`✓ 已分享 ${linked.length} 个链接。${skipped}`);
        exitSelecting();
        return;
      }
      const names = removable.slice(0, 6).map((app) => app.name).join("、") + (removable.length > 6 ? "…" : "");
      const ok = await Dialog.confirm({
        title: `分享好了。要卸载这 ${removable.length} 个吗？`,
        message: `${names}\n\nApp 和它在本机的数据会一起删除，不能恢复；以后可以用刚分享的链接重新下载。${skipped ? `\n${skipped}` : ""}`,
        confirmLabel: "卸载",
      });
      if (!ok) {
        setMessage(`✓ 已分享 ${linked.length} 个链接，没有卸载。`);
        exitSelecting();
        return;
      }
      setMessage(`${await uninstallMany(removable)}（已分享 ${linked.length} 个链接）。${skipped}`);
      exitSelecting();
    } catch (error) {
      setMessage(`没做完：${describeError(error)}`);
    } finally {
      setWorking("");
    }
  }

  const all = (task.data ?? [])
    .filter((app) => !removed.includes(app.bundleId))
    .map((app) => withSizes(app, sizes.get(app.bundleId)));
  const keyword = query.trim().toLowerCase();
  const shown = sortApps(
    all.filter(
      (app) =>
        (filter === "all" || app.source === filter) &&
        (!keyword || app.name.toLowerCase().includes(keyword) || app.bundleId.toLowerCase().includes(keyword)),
    ),
    sortBy,
    installedAt,
  );
  const countOf = (source: AppSource) => all.filter((app) => app.source === source).length;
  const shownSize = shown.reduce((sum, app) => sum + totalSize(app), 0);

  return (
    <List
      navigationTitle="应用管理"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      refreshable={task.reload}
      searchable={{ value: query, onChanged: setQuery, prompt: "搜索名称或 Bundle ID" }}
      toolbar={{
        topBarTrailing: !task.data ? undefined : selecting ? (
          <Button title="完成" action={exitSelecting} />
        ) : (
          <Menu title="选项" systemImage="line.3.horizontal.decrease.circle">
            <Button
              title="多选（分享链接 / 卸载）"
              systemImage="checkmark.circle"
              action={() => {
                setSelecting(true);
                setMessage("");
              }}
            />
            <Button
              title="按占用空间"
              systemImage={sortBy === "size" ? "checkmark" : "internaldrive"}
              action={() => setSortBy("size")}
            />
            <Button
              title="按名称"
              systemImage={sortBy === "name" ? "checkmark" : "textformat"}
              action={() => setSortBy("name")}
            />
            <Button
              title="按安装 / 更新时间"
              systemImage={sortBy === "installed" ? "checkmark" : "clock"}
              action={() => setSortBy("installed")}
            />
            <Menu title="按来源筛选" systemImage="line.3.horizontal.decrease">
              <Button
                title={`全部（${all.length}）`}
                systemImage={filter === "all" ? "checkmark" : "square.stack"}
                action={() => setFilter("all")}
              />
              {SOURCES.filter((source) => countOf(source) > 0).map((source) => (
                <Button
                  key={source}
                  title={`${SOURCE_LABEL[source]}（${countOf(source)}）`}
                  systemImage={filter === source ? "checkmark" : "circle"}
                  action={() => setFilter(source)}
                />
              ))}
            </Menu>
            <Button
              title="自定义长按菜单"
              systemImage="hand.tap"
              action={() =>
                void Navigation.present(<RowActionsPage value={rowActions} onChanged={setRowActions} />)
              }
            />
            <Button
              title="重新载入图标和大小"
              systemImage="arrow.clockwise"
              action={() => void refreshCaches()}
            />
            <Button
              title="复制当前清单"
              systemImage="doc.on.doc"
              action={() => {
                copyWithFeedback(appListText(shown));
                setMessage(`✓ 已复制 ${shown.length} 个 App 的清单`);
              }}
            />
          </Menu>
        ),
        /*
          多选时的主操作放底部工具栏：早先放在列表最上面那一节里，往下滑去勾 App 就看不见了，
          真机上被问「勾完就没下一步了？」。
        */
        bottomBar:
          task.data && selecting ? (
            working ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">{working}</Text>
            ) : (
              <HStack spacing={16}>
                <Menu title={`分享（${picked.length}）`} systemImage="square.and.arrow.up" disabled={picked.length === 0}>
                  {/* 带分类的那项放前面：发去备忘录、群里时基本都要它 */}
                  <Button title="清单：按分类 + 名称 + 链接" systemImage="list.bullet.rectangle" action={() => void shareAndClean("text")} />
                  <Button title="只发链接，不带名称和分类" systemImage="link" action={() => void shareAndClean("links")} />
                </Menu>
                <Spacer />
                {/* 直接卸载，不必先分享——先分享再卸是「换机」那条路，日常清理用不着 */}
                <Button
                  title={`卸载（${picked.length}）`}
                  systemImage="trash"
                  role="destructive"
                  disabled={picked.length === 0}
                  action={() => void uninstallPicked()}
                />
              </HStack>
            )
          ) : undefined,
      }}
    >
      <TaskStateSection task={task} />

      {task.data && selecting ? (
        <Section
          header={<Text>{`已选 ${picked.length} 个`}</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              勾好之后点屏幕底部的「分享链接」。按 bundle ID 查 App Store 链接（只发 bundle ID 和地区），用系统分享面板发给收藏类 App；
              真分享出去了才会问要不要卸载。TestFlight、自签的 App 能查到的是 App Store 正式版的页面，查不到的不分享也不卸载。
            </Text>
          }
        >
          {working ? (
            <HStack spacing={10}>
              <ProgressView />
              <Text foregroundStyle="secondaryLabel">{working}</Text>
            </HStack>
          ) : null}
          <Button
            title={shown.every((app) => picked.includes(app.bundleId)) ? "全不选" : `全选当前列表（${shown.length}）`}
            action={() =>
              setPicked(shown.every((app) => picked.includes(app.bundleId)) ? [] : shown.map((app) => app.bundleId))
            }
          />
        </Section>
      ) : null}

      {task.data ? (
        <Section
          footer={
            <Text foregroundStyle="tertiaryLabel">
              {/*
                图标和占用空间是两条并行的后台任务，各有各的进度。早先只挑一条显示，
                真机上三百多个 App 时图标慢慢刷，页脚却只写着占用空间——看着像卡住了。
              */}
              {message ||
                [iconStatus, sizeStatus].filter(Boolean).join("，") ||
                "占用空间 = 安装包 + 文稿与数据，口径接近「设置 → 通用 → iPhone 储存空间」。右上角可以换排序、按来源筛选、自定义长按菜单。"}
            </Text>
          }
        >
          <HStack>
            <Text>{filter === "all" ? "全部 App" : SOURCE_LABEL[filter]}</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`${shown.length} 个 · ${formatBytes(shownSize)}`}</Text>
          </HStack>
        </Section>
      ) : null}

      {task.data ? (
        <Section>
          {shown.length === 0 ? (
            <Text foregroundStyle="tertiaryLabel">{keyword ? "没有匹配的 App" : "这一类没有 App"}</Text>
          ) : selecting ? (
            shown.map((app) => (
              <Button key={app.bundleId} action={() => togglePick(app.bundleId)}>
                <HStack spacing={10}>
                  <Image
                    systemName={picked.includes(app.bundleId) ? "checkmark.circle.fill" : "circle"}
                    foregroundStyle={picked.includes(app.bundleId) ? "systemBlue" : "tertiaryLabel"}
                  />
                  <AppRow app={app} icon={icons.get(app.bundleId)} since={sortBy === "installed" ? sinceText(installedAt.get(app.bundleId)) : undefined} />
                </HStack>
              </Button>
            ))
          ) : (
            shown.map((app) => (
              <NavigationLink
                key={app.bundleId}
                destination={
                  <AppDetailPage
                    app={app}
                    icon={icons.get(app.bundleId)}
                    onUninstalled={(bundleId) => {
                      setRemoved((list) => [...list, bundleId]);
                      setMessage(`✓ 已卸载「${app.name}」`);
                    }}
                  />
                }
                /* 左滑直接卸载，长按给一组常用动作——翻到想删的那个时不用再点进详情页 */
                trailingSwipeActions={{
                  allowsFullSwipe: false,
                  actions: [
                    <Button
                      key="uninstall"
                      title="卸载"
                      systemImage="trash"
                      role="destructive"
                      action={() => void uninstallOne(app)}
                    />,
                  ],
                }}
                contextMenu={{
                  menuItems: (
                    <>
                      {rowActions.map((id) => {
                        const action = findRowAction(id);
                        if (!action) return null;
                        return (
                          <Button
                            key={id}
                            title={action.label}
                            systemImage={action.systemImage}
                            role={action.destructive ? "destructive" : undefined}
                            action={() => void runRowAction(id, app)}
                          />
                        );
                      })}
                    </>
                  ),
                }}
              >
                <AppRow app={app} icon={icons.get(app.bundleId)} since={sortBy === "installed" ? sinceText(installedAt.get(app.bundleId)) : undefined} />
              </NavigationLink>
            ))
          )}
        </Section>
      ) : null}
    </List>
  );
}
