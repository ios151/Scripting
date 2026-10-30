// 主屏布局：Dock 和每一页上有什么，可以备份成 plist、导出成图、复制成清单。
//
// 只读不写——设备的 setIconState 能把布局写回去，但格式不对时整个主屏会乱，
// 这一版不做恢复。

import {
  Button,
  DisclosureGroup,
  HStack,
  Image,
  ImageRenderer,
  List,
  Menu,
  NavigationLink,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
  useRef,
  useState,
  type VirtualNode,
} from "scripting";
import { debugLog, describeError } from "../core/debug";
import { loadIconsWithCache } from "../kit/cache";
import { deviceHub } from "../kit/hub";
import { fileStamp } from "../kit/dates";
import { encodeXmlPlist } from "../kit/plist";
import {
  collectBundleIds,
  readHomeLayout,
  readIcons,
  readWallpapers,
  type HomeItem,
  type HomeLayout,
} from "../kit/services";
import { withKeepAlive } from "../utils/keepalive";
import { copyWithFeedback, TaskStateSection, useDeviceTask } from "./common";
import { DockEditPage } from "./DockEditPage";
import { OrganizePage } from "./OrganizePage";
import { BACKUP_SCOPE, ItemIcon, KIND_LABEL, toImage, toThumbnail, type IconMap } from "./homeShared";

/** 折叠时显示在标题右边的概要：「12 个 App · 2 个文件夹 · 1 个小组件」。 */
function pageSummary(items: HomeItem[]): string {
  if (items.length === 0) return "空白页";
  const apps = items.filter((item) => item.kind === "app").length;
  const folders = items.filter((item) => item.kind === "folder").length;
  const widgets = items.filter((item) => item.kind === "widget").length;
  return [
    apps ? `${apps} 个 App` : "",
    folders ? `${folders} 个文件夹` : "",
    widgets ? `${widgets} 个小组件` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 可折叠的一组（Dock 或某一页）。
 * DisclosureGroup 的 label 放标题 + 右侧概要，展开状态由外面的 state 受控。
 */
function PageGroup({
  title,
  items,
  icons,
  expanded,
  onToggle,
}: {
  title: string;
  items: HomeItem[];
  icons: IconMap;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  return (
    <Section>
      <DisclosureGroup
        label={
          <HStack frame={{ maxWidth: "infinity" }} spacing={8}>
            <Text font="headline" foregroundStyle="label">{title}</Text>
            <Spacer />
            <Text font="caption" foregroundStyle="secondaryLabel">{pageSummary(items)}</Text>
          </HStack>
        }
        isExpanded={expanded}
        onChanged={onToggle}
      >
        {items.length === 0 ? <Text foregroundStyle="tertiaryLabel">空白页</Text> : null}
        {items.map((item, index) => (
          <ItemRow key={`${title}-${index}`} item={item} icons={icons} />
        ))}
      </DisclosureGroup>
    </Section>
  );
}

function countApps(items: HomeItem[]): number {
  return items.reduce((sum, item) => sum + (item.kind === "folder" ? (item.pages ?? []).reduce((n, page) => n + countApps(page), 0) : item.kind === "app" ? 1 : 0), 0);
}

/** 纯文本清单：一页一段，文件夹缩进。 */
function layoutText(layout: HomeLayout): string {
  const lines: string[] = [];
  const write = (items: HomeItem[], indent: string) => {
    for (const item of items) {
      const tag = KIND_LABEL[item.kind] ? `［${KIND_LABEL[item.kind]}］` : "";
      lines.push(`${indent}${tag}${item.name}`);
      item.pages?.forEach((page, index) => {
        if ((item.pages?.length ?? 0) > 1) lines.push(`${indent}  · 第 ${index + 1} 页`);
        write(page, `${indent}    `);
      });
    }
  };
  lines.push("【Dock】");
  write(layout.dock, "  ");
  layout.pages.forEach((page, index) => {
    lines.push("", `【第 ${index + 1} 页】`);
    write(page, "  ");
  });
  return lines.join("\n");
}

function ItemRow({ item, icons }: { item: HomeItem; icons: IconMap }) {
  if (item.kind === "folder") {
    return (
      <DisclosureGroup
        label={
          <HStack spacing={10}>
            <ItemIcon item={item} icons={icons} size={30} />
            <Text>{item.name}</Text>
            <Spacer />
            <Text font="caption" foregroundStyle="tertiaryLabel">{`${countApps([item])} 个 App`}</Text>
          </HStack>
        }
      >
        {(item.pages ?? []).flat().map((child, index) => (
          <ItemRow key={`${child.bundleId ?? child.name}-${index}`} item={child} icons={icons} />
        ))}
      </DisclosureGroup>
    );
  }
  return (
    <HStack spacing={10}>
      <ItemIcon item={item} icons={icons} size={30} />
      <Text lineLimit={1}>{item.name}</Text>
      <Spacer />
      {KIND_LABEL[item.kind] ? (
        <Text font="caption" foregroundStyle="tertiaryLabel">
          {KIND_LABEL[item.kind]}
        </Text>
      ) : null}
    </HStack>
  );
}

/** 导出成图用的一页：四列网格。不用 LazyVGrid——离屏渲染时懒加载的格子可能还没生成。 */
function PageImage({ title, items, icons }: { title: string; items: HomeItem[]; icons: IconMap }): VirtualNode {
  const rows: HomeItem[][] = [];
  for (let i = 0; i < items.length; i += 4) rows.push(items.slice(i, i + 4));
  return (
    <VStack alignment="leading" spacing={10}>
      <Text font="headline" foregroundStyle="label">{title}</Text>
      {rows.map((row, rowIndex) => (
        <HStack key={rowIndex} spacing={12} alignment="top">
          {row.map((item, index) => (
            <VStack key={index} spacing={4} frame={{ width: 72 }}>
              <ItemIcon item={item} icons={icons} size={56} />
              <Text font="caption2" foregroundStyle="secondaryLabel" lineLimit={1}>
                {item.name}
              </Text>
            </VStack>
          ))}
        </HStack>
      ))}
    </VStack>
  );
}

/**
 * 原图转成原生 Data 留着导出，预览图在载入时缩好一次，重绘只用它。
 * 状态和 props 里不放几 MB 的 Uint8Array——它会跟着每次重绘在 JS 里流转。
 */
interface Wallpaper {
  data: Data;
  image: UIImage | null;
}

/** 预览格 140×240pt，按 3 倍屏缩。 */
function toWallpaper(bytes: Uint8Array | null): Wallpaper | null {
  const data = bytes ? Data.fromUint8Array(bytes) : null;
  if (!data) return null;
  const started = Date.now();
  const image = toThumbnail(data, 420, 720);
  debugLog("springboard", `壁纸 ${data.size} 字节，解码缩图 ${Date.now() - started} ms`);
  return { data, image };
}

function WallpaperCell({
  label,
  wallpaper,
  onExport,
}: {
  label: string;
  wallpaper: Wallpaper | null;
  onExport: (label: string, data: Data) => void;
}) {
  const image = wallpaper?.image ?? null;
  const data = wallpaper?.data ?? null;
  return (
    <VStack spacing={6}>
      {image ? (
        <Image
          image={image}
          resizable
          aspectRatio={{ contentMode: "fit" }}
          frame={{ width: 140, height: 240 }}
          clipShape={{ type: "rect", cornerRadius: 12 }}
        />
      ) : (
        <Text foregroundStyle="tertiaryLabel" frame={{ width: 140, height: 60 }}>
          {`${label}壁纸取不到`}
        </Text>
      )}
      {/* 两个格子在同一行，不设 borderless 的话点一下整行，两个导出都会触发。 */}
      {data ? (
        <Button title={`导出${label}壁纸`} buttonStyle="borderless" action={() => onExport(label, data)} />
      ) : null}
    </VStack>
  );
}

export function HomeScreenPage() {
  const [icons, setIcons] = useState<IconMap>(new Map());
  const [iconProgress, setIconProgress] = useState("");
  /** 图标正在载入时挡掉第二次（重读布局会再触发一遍，同一批缺的图标不用取两回）。 */
  const iconsBusy = useRef(false);
  const [wallpapers, setWallpapers] = useState<{ home: Wallpaper | null; lock: Wallpaper | null } | null>(null);
  const [wallpaperLoading, setWallpaperLoading] = useState(false);
  /** 同一帧里连点两下时状态还没刷新，靠 ref 挡掉第二次（真机日志里出现过一次连载两遍）。 */
  const wallpaperBusy = useRef(false);
  const [message, setMessage] = useState("");
  /** 展开着的分组。默认只开 Dock 和第 1 页：九页全摊开要滑很久才到底。 */
  const [openGroups, setOpenGroups] = useState<string[]>(["dock", "page-0"]);
  const isOpen = (id: string) => openGroups.includes(id);
  const setOpen = (id: string, open: boolean) =>
    setOpenGroups((list) => (open ? (list.includes(id) ? list : [...list, id]) : list.filter((item) => item !== id)));

  /**
   * 图标：先摆缓存里的，再只去设备上取缺的，取一批铺一批。
   *
   * 和应用管理共用同一个图标缓存（`kit/cache.ts`），所以应用管理载过的这里直接有，
   * 这里载过的（含系统 App）下次也不用再取。以前每次进来都把一两百个图标逐个重取一遍，
   * 要等十几秒，期间整页灰方块。
   */
  async function loadIcons(layout: HomeLayout) {
    const ids = collectBundleIds(layout);
    if (ids.length === 0 || iconsBusy.current) return;
    iconsBusy.current = true;
    const addImages = (pngs: Map<string, Uint8Array>) =>
      setIcons((current) => {
        const next: IconMap = new Map(current);
        for (const [id, png] of pngs) {
          const image = toImage(png);
          if (image) next.set(id, image);
        }
        return next;
      });
    try {
      await loadIconsWithCache(
        ids,
        // 缓存是空的时候要逐个取十几秒，这期间切走不保活就断在半路
        (missing, onProgress, onBatch) =>
          withKeepAlive("home-icons", async () => readIcons(await deviceHub.get(), missing, onProgress, onBatch)),
        {
          onCached: addImages,
          onProgress: (done, total) => setIconProgress(`载入图标 ${done}/${total}`),
          onFetched: addImages,
        },
      );
    } catch (error) {
      setMessage(`图标没取全：${describeError(error)}`);
    } finally {
      setIconProgress("");
      iconsBusy.current = false;
    }
  }

  const task = useDeviceTask(async (session) => {
    const layout = await readHomeLayout(session);
    // 布局先出来，图标在后台慢慢补——一百多个 App 要一个个取。
    setTimeout(() => void loadIcons(layout), 0);
    return layout;
  });
  const layout = task.data;

  async function exportFile(name: string, content: Data | Uint8Array) {
    const data = content instanceof Uint8Array ? Data.fromUint8Array(content) : content;
    if (!data) throw new Error("无法构造导出数据");
    const saved = await DocumentPicker.exportFiles({ files: [{ data, name }] });
    setMessage(saved.length > 0 ? `✓ 已导出 ${name}` : "已取消导出");
  }

  async function run(label: string, action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      setMessage(`${label}失败：${describeError(error)}`);
    }
  }

  async function exportImage() {
    if (!layout) return;
    const element = (
      <VStack alignment="leading" spacing={24} padding={20} frame={{ width: 360 }} background="systemBackground">
        <PageImage title="Dock" items={layout.dock} icons={icons} />
        {layout.pages.map((page, index) => (
          <PageImage key={index} title={`第 ${index + 1} 页`} items={page} icons={icons} />
        ))}
      </VStack>
    );
    const png = await ImageRenderer.toPNGData(element, { opaque: true, scale: 3 });
    const bytes = png.toUint8Array();
    if (!bytes) throw new Error("渲染结果为空");
    await exportFile(`主屏布局-${fileStamp()}.png`, bytes);
  }

  const totalApps = layout ? countApps(layout.dock) + layout.pages.reduce((sum, page) => sum + countApps(page), 0) : 0;
  async function loadWallpapers() {
    if (wallpaperBusy.current) return;
    wallpaperBusy.current = true;
    setWallpaperLoading(true);
    await run("载入壁纸", async () => {
      const { home, lock } = await readWallpapers(await deviceHub.get());
      setWallpapers({ home: toWallpaper(home), lock: toWallpaper(lock) });
    });
    wallpaperBusy.current = false;
    setWallpaperLoading(false);
  }

  const exportWallpaper = (label: string, data: Data) =>
    void run("导出壁纸", () => exportFile(`${label}壁纸-${fileStamp()}.png`, data));

  return (
    <List
      navigationTitle="主屏布局"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      refreshable={task.reload}
      toolbar={{
        topBarTrailing: layout ? (
          <Menu title="导出" systemImage="square.and.arrow.up">
            <Button
              title="备份布局（plist）"
              systemImage="doc.badge.arrow.up"
              action={() => void run("备份", () => exportFile(`主屏布局-${fileStamp()}.plist`, encodeXmlPlist(layout.raw)))}
            />
            <Button title="导出成图" systemImage="photo" action={() => void run("导出图片", exportImage)} />
            <Button
              title="复制清单"
              systemImage="list.bullet"
              action={() => {
                copyWithFeedback(layoutText(layout));
                setMessage("✓ 清单已复制");
              }}
            />
          </Menu>
        ) : undefined,
      }}
    >
      <TaskStateSection task={task} />

      {layout ? (
        <Section
          footer={
            <Text foregroundStyle="tertiaryLabel">
              {message || iconProgress || `右上角可以备份成 plist、导出成图或复制成文字清单。备份只保存在你选的位置。${BACKUP_SCOPE}`}
            </Text>
          }
        >
          <HStack>
            <Text>概览</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`${layout.pages.length} 页 · ${totalApps} 个 App`}</Text>
          </HStack>
          <NavigationLink destination={<OrganizePage icons={icons} />}>
            <Text>AI 整理（分文件夹、按名称或颜色排序）</Text>
          </NavigationLink>
          <NavigationLink destination={<DockEditPage icons={icons} />}>
            <Text>编辑 Dock / 从备份恢复</Text>
          </NavigationLink>
          {(() => {
            const all = ["dock", ...layout.pages.map((_, index) => `page-${index}`)];
            const allOpen = all.every((id) => openGroups.includes(id));
            return (
              <Button
                title={allOpen ? "全部收起" : "全部展开"}
                systemImage={allOpen ? "rectangle.compress.vertical" : "rectangle.expand.vertical"}
                action={() => setOpenGroups(allOpen ? [] : all)}
              />
            );
          })()}
        </Section>
      ) : null}

      {layout ? (
        <PageGroup
          title="Dock"
          items={layout.dock}
          icons={icons}
          expanded={isOpen("dock")}
          onToggle={(open) => setOpen("dock", open)}
        />
      ) : null}

      {layout?.pages.map((page, pageIndex) => (
        <PageGroup
          key={`page-${pageIndex}`}
          title={`第 ${pageIndex + 1} 页`}
          items={page}
          icons={icons}
          expanded={isOpen(`page-${pageIndex}`)}
          onToggle={(open) => setOpen(`page-${pageIndex}`, open)}
        />
      ))}

      {layout ? (
        <Section header={<Text>壁纸</Text>}>
          {wallpapers === null ? (
            wallpaperLoading ? (
              <HStack spacing={10}>
                <ProgressView />
                <Text foregroundStyle="secondaryLabel">载入壁纸…</Text>
              </HStack>
            ) : (
              <Button title="载入壁纸预览" action={() => void loadWallpapers()} />
            )
          ) : (
            <HStack spacing={12} alignment="top">
              <WallpaperCell label="主屏" wallpaper={wallpapers.home} onExport={exportWallpaper} />
              <WallpaperCell label="锁屏" wallpaper={wallpapers.lock} onExport={exportWallpaper} />
            </HStack>
          )}
        </Section>
      ) : null}
    </List>
  );
}
