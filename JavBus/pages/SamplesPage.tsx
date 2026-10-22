// 样品图像：两列缩略图，点开看大图（系统预览，能缩放），底部「批量下载」。
//
// 原版点图用 $quicklook 看大图、批量下载到脚本文件管理里的「样品图像/<演员或番号>/」，
// 按钮标题实时显示 n/总数、完成后变「完成」。照搬，另外下载完给两个出口：存相册、导出文件
// （脚本沙盒里的文件普通人找不到）。

import { Button, HStack, Image, LazyVGrid, ProgressView, ScrollView, Text, VStack, ZStack, useState } from "scripting";

import type { SampleImage } from "../core/types";
import { loadImage } from "../kit/images";
import { downloadSamples, saveFilesToAlbum } from "../kit/samples";
import { takeTip } from "../kit/settings";
import { showError, showToast } from "../kit/toast";
import { RemoteImage } from "./RemoteImage";
import { PageBackdrop, SIDE } from "./theme";

const COLUMNS = [
  { size: { type: "flexible" as const }, spacing: 8 },
  { size: { type: "flexible" as const } },
];

export function SamplesPage({ code, folder, images }: { code: string; folder: string; images: SampleImage[] }) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [finished, setFinished] = useState(false);
  const [opening, setOpening] = useState(false);

  const openBig = async (image: SampleImage) => {
    if (opening) return;
    setOpening(true);
    try {
      showToast("加载大图…");
      const big = (await loadImage(image.full)) ?? (await loadImage(image.thumb));
      if (!big) {
        showError("大图加载失败");
        return;
      }
      await QuickLook.previewImage(big, true);
    } finally {
      setOpening(false);
    }
  };

  const startDownload = async () => {
    if (progress && !finished) return;
    if (takeTip("downPics")) {
      await Dialog.alert({
        title: "批量下载",
        message: `图片会保存在脚本文档目录的「样品图像/${folder}」里；下载完成后也可以存进相册或导出。`,
      });
    }
    HapticFeedback.mediumImpact();
    setFinished(false);
    setProgress({ done: 0, total: images.length });
    try {
      const report = await downloadSamples({
        code,
        folder,
        images,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setFinished(true);
      HapticFeedback.notificationSuccess();
      const choice = await Dialog.actionSheet({
        title: "下载完成",
        message: `成功 ${report.files.length} 张${report.failed > 0 ? `，失败 ${report.failed} 张` : ""}`,
        actions: [{ label: "存入相册" }, { label: "导出 / 分享文件" }],
      });
      if (choice === 0) {
        const saved = await saveFilesToAlbum(report.files);
        if (saved === report.files.length) showToast(`已存入相册 ${saved} 张`);
        else showError(`相册只存入 ${saved}/${report.files.length} 张，请检查相册权限`);
      } else if (choice === 1) {
        await ShareSheet.present(report.files);
      }
    } catch (error) {
      setProgress(null);
      showError(error instanceof Error ? error.message : String(error));
    }
  };

  const title = finished ? "完成" : progress ? `${progress.done}/${progress.total}` : "批量下载";

  return (
    <ZStack
      navigationTitle="样品图像"
      navigationBarTitleDisplayMode="inline"
      // 有自己的底栏，Tab 栏让出来（同详情页）
      toolbarVisibility={{ visibility: "hidden", bars: ["tabBar"] }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
    >
      <PageBackdrop />
      <ScrollView
        safeAreaInset={{
          bottom: {
            content: (
              <VStack spacing={8} padding={{ vertical: 10 }} frame={{ maxWidth: "infinity" }} background="barMaterial">
                {progress && !finished ? (
                  <ProgressView value={progress.done} total={Math.max(1, progress.total)} tint="white" frame={{ width: 200 }} />
                ) : null}
                {/* 白色大胶囊，和详情页的「播放」同一个语气；宽度算死（Button 的 label 里弹性宽度不撑开） */}
                <Button buttonStyle="plain" action={() => void startDownload()}>
                  <HStack spacing={8} frame={{ width: 200, height: 48 }} background={{ style: "white", shape: "capsule" }}>
                    <Image systemName="arrow.down.circle" font="body" foregroundStyle="black" />
                    <Text font="headline" foregroundStyle="black">
                      {title}
                    </Text>
                  </HStack>
                </Button>
              </VStack>
            ),
          },
        }}
      >
        <LazyVGrid columns={COLUMNS} spacing={8} padding={{ horizontal: SIDE, top: 8 }}>
          {images.map((image) => (
            <Button key={image.full} buttonStyle="plain" action={() => void openBig(image)}>
              <RemoteImage url={image.thumb} maxSide={420} mode="fit" height={120} radius={10} />
            </Button>
          ))}
        </LazyVGrid>
      </ScrollView>
    </ZStack>
  );
}
