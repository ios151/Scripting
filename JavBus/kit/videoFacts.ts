// 读视频轨的分辨率、帧率、码率，给播放器控制条下面那一行小字用（core/playerControls.ts 的 describeVideo 负责写成文字）。
//
// 用的是 AVAsset.loadTracks：另开一个 AVAsset 去读，不碰正在播的 AVPlayer，读完马上 dispose。
// 对 HLS（MissAV / Jable 的完整视频）会多请求一次清单；读不到、读超时都返回 null，这一行就不画——它只是装饰，不能影响播放。
// 编码（HEVC）、动态范围（HDR）、解码方式、实时网速这些 Scripting 的 API 读不到（AVAssetTrack 没有格式描述），所以不写。

import type { VideoFacts } from "../core/playerControls";

/** 读信息最多等多久。HLS 要先下清单，慢网络上可能很久；等不起就算了。 */
const LOAD_TIMEOUT_MS = 8000;

function timeout<T>(ms: number): Promise<T | null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

export async function loadVideoFacts(url: string, headers?: Record<string, string>): Promise<VideoFacts | null> {
  let asset: AVAsset | null = null;
  try {
    // 不要精确时长：这里只读轨道信息，精确时长要扫描文件，白花时间
    asset = new AVAsset(url, { headers, preferPreciseDuration: false });
    const opened = asset;
    const read = (async (): Promise<VideoFacts | null> => {
      const tracks = await opened.loadTracks("video");
      const track = tracks[0];
      if (!track) return null;
      const [size, fps, bitrate] = await Promise.all([
        track.loadNaturalSize(),
        track.loadNominalFrameRate(),
        track.loadEstimatedDataRate(),
      ]);
      return { width: size.width, height: size.height, fps, bitrate };
      // 超时先返回、asset 随后被释放时，这条还在路上的读取会失败：在这里吞掉，免得变成没人接的异常
    })().catch(() => null);
    return await Promise.race([read, timeout<VideoFacts>(LOAD_TIMEOUT_MS)]);
  } catch {
    return null;
  } finally {
    try {
      asset?.dispose();
    } catch {
      /* 已经释放过 */
    }
  }
}
