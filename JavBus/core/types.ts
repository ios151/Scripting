// 全脚本共用的数据模型。
//
// 库里存的那几个形状（FavMovie / FavActress / FavNamed）有意和原版 JSBox 脚本的
// JavBusBackup.json 保持一致，这样原版导出的备份可以直接导入，导出的也能导回去。

/** 站点分区：对应原版顶部的「有码 / 无码 / 欧美」。 */
export type SiteKind = "censored" | "uncensored" | "western";

/** 列表里的一部影片（首页、搜索、分类、演员作品共用）。 */
export interface MovieItem {
  /** 识别码，如 SSIS-001（列表里 <date> 的第一个）。 */
  code: string;
  /** 详情页绝对地址。 */
  link: string;
  /** 封面缩略图绝对地址。 */
  cover: string;
  title: string;
  /** 发行日期，原样保留（推荐列表里是 2026-6-11 这种不补零的写法）。 */
  date: string;
  hd: boolean;
  sub: boolean;
}

/** 演员列表里的一位演员。 */
export interface StarItem {
  name: string;
  link: string;
  avatar: string;
}

/** 带链接的名字：发行商 / 制作商 / 系列 / 导演 / 类别。 */
export interface NamedLink {
  name: string;
  link: string;
}

export interface SampleImage {
  /** 大图（原版下载与预览用的就是这个，通常在 DMM 的图床上）。 */
  full: string;
  /** 站内缩略图，列表里用它，省流量。 */
  thumb: string;
}

/** 详情页里那段内联脚本的三个变量，磁链 AJAX 靠它们拼地址。 */
export interface MagnetParams {
  gid: string;
  uc: string;
  img: string;
  lang: string;
}

export interface MovieDetail {
  link: string;
  title: string;
  /** 識別碼；页面里没有时退回链接最后一段。 */
  code: string;
  cover: string;
  /** 發行日期，缺失为空串。 */
  date: string;
  /** 長度（分钟），缺失为 null。 */
  minutes: number | null;
  director: NamedLink | null;
  filmMaker: NamedLink | null;
  filmEstab: NamedLink | null;
  series: NamedLink | null;
  genres: NamedLink[];
  stars: StarItem[];
  samples: SampleImage[];
  magnetParams: MagnetParams | null;
}

export interface ActressInfo {
  birthday: string;
  age: string;
  height: string;
  cup: string;
  bust: string;
  waist: string;
  hip: string;
}

export interface GenreSection {
  title: string;
  items: NamedLink[];
}

export interface Magnet {
  /** 完整磁力链接。 */
  link: string;
  name: string;
  size: string;
  date: string;
  hd: boolean;
  sub: boolean;
}

/** 列表页解析结果：除了条目，还要区分「翻到头了」和「搜不到」两种空。 */
export interface ListPage {
  items: MovieItem[];
  /** 页面是 404（翻过了最后一页）。 */
  ended: boolean;
  /** 页面是「沒有您要的結果」。 */
  noResult: boolean;
}

// ———— 收藏库（与原版 JavBusBackup.json 同形） ————

export interface FavMovie {
  code: string;
  /** 封面缩略图。 */
  src: string;
  /** 「番号 | 日期」，列表上显示的那行字。 */
  info: string;
  /** 去重主键：详情页链接的最后一段。 */
  shortCode: string;
  /** 新增字段：详情页绝对地址。原版没有，导入的旧数据缺它，用 shortCode 补。 */
  link?: string;
}

export interface FavActress {
  src: string;
  /** 演员名。 */
  info: string;
  shortCode: string;
  /** 有码为空串，无码为 "uncensored/"。 */
  un: string;
}

export interface FavNamed {
  name: string;
  /** 无码来源的类目带 "/uncensored" 后缀（原版约定，用来重建链接）。 */
  shortCode: string;
}

export interface LibraryData {
  favorite: FavMovie[];
  archive: FavMovie[];
  actress: FavActress[];
  director: FavNamed[];
  filmMaker: FavNamed[];
  filmEstab: FavNamed[];
  series: FavNamed[];
  /**
   * 「我的精选」：归档里被自己标成精选的影片的 shortCode，最近标的在最前。新增字段，原版没有（原版备份导入时补空）。
   * 恒是归档的子集——删除归档、导入合并时都会剔掉不在归档里的（core/library.ts）。
   */
  picks: string[];
}

/** 能被收藏的类目种类，对应库里的四个数组。 */
export type NamedKind = "director" | "series" | "filmMaker" | "filmEstab";

/** 推荐列表里的一项（gitlab 上的 JSON）。 */
export interface RecItem {
  code: string;
  info: string;
  src: string;
  link: string;
}

// ———— 页面之间传递的「打开哪部影片」 ————

/** 从哪个入口进详情页：决定主按钮是「收藏」「归档」还是「删除」（原版按所在 menu 区分）。 */
export type DetailContext = "browse" | "favorites" | "archive" | "recommend";

/** 打开详情页所需的最少信息。 */
export interface MovieRef {
  link: string;
  code: string;
  /** 列表上的封面缩略图，收藏时存它。 */
  cover: string;
  /** 「番号 | 日期」。 */
  info: string;
  context: DetailContext;
  /** link 是用 shortCode 猜的（旧收藏没存链接），404 时换另一个域名再试一次。 */
  guessed?: boolean;
  /** JavBus 没有这部，靠 Missav / Jable 片源兜底出来的详情。 */
  fallback?: boolean;
}
