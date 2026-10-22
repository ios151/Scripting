// 内置文案：声明、18+ 提示、更新说明。声明与 18+ 提示照原版逐字保留。

import { ORIGIN_VERSION, VERSION } from "./constants";

export const DECLARATION = `声明

1. 脚本含成人内容，未满十八岁禁止运行；
2. 脚本所有内容来自 https://www.javbus.com 与脚本作者无任何关系；
3. 脚本制作纯属技术交流，无任何商业利益或传播淫秽目的。`;

/**
 * 设置页「外部播放器」一节底下的一行说明，和别的小节一样短。
 * 占位符怎么填、例子，在点开那一行弹出的输入框里（PLAYER_TEMPLATE_PROMPT + 输入框里的占位文字）；README 里有完整说明。
 */
export const PLAYER_TEMPLATE_FOOTER =
  "播放器 ↗ 菜单里的「自定义播放器」用这里的模板拼链接，点开这一行有说明和例子。Infuse、SenPlayer、VLC、nPlayer 已经内置，不用填。";

/**
 * 输入自定义模板时的说明：设置里点那一行、或在播放器菜单里第一次选「自定义播放器」，弹的都是同一个输入框。
 * 放在字符串里：JSX 里直接写 {url} 会被当成表达式。系统弹窗的正文不能长，所以只写要点；
 * 例子只有一个，就是输入框里的占位文字（PLAYER_TEMPLATE_EXAMPLE）。
 */
export const PLAYER_TEMPLATE_PROMPT = "模板里必须有 {url}（编码后的视频地址）或 {raw}（原样地址），打开时换成这条视频的地址。";

/**
 * 设置页「推荐服务」一节底下的说明。填了社区服务地址 / 没填，各一句。
 * 「社区服务」就是 javbus-community：大家一起维护的推荐服务（有后台、能审核、能举报），部署方法在它的 README 里。
 */
export const COMMUNITY_FOOTER =
  "网友推荐用的是社区推荐服务：列表、提交、撤销、举报都走它。作者精选仍用原作者维护的列表和上传服务（就是下面两个地址，一般不用动）。" +
  "点开地址那一行可以改，清空会回到默认的社区服务地址；点「恢复默认」会回到出厂设置。";
export const LEGACY_SERVICE_FOOTER =
  "没有填社区服务地址，用的是原作者维护的列表和上传服务（其中网友推荐的上传服务已经失效，提交会失败）。社区推荐服务部署好以后，把它的地址填在上面就行。";
export const COMMUNITY_PROMPT = "javbus-community 的地址，例如 https://javbus-community.你的子域名.workers.dev；留空保存 = 用默认地址";

/** 原版 checkAdult 上半屏的英文警告（FBI WARNING）。 */
export const FBI_WARNING =
  "Federal law provides severe civil and criminal penalties for the unauthorized reproduction, distribution, or exhibition of copyrighted motion pictures (Title 17, United States Code,Sections 501 and 508). The Federal Bureau of Investigation investigates allegations of criminal copyright infringement (Title 17, United States Code, Section 506).";

/** 原版 checkAdult 下半屏的中文警告。 */
export const ADULT_WARNING =
  "本脚本运行内容可能包含成人视频、图片，可能会引起你的不适，未满十八岁，禁止运行。\n\n脚本所有内容来自 https://www.javbus.com 与脚本作者无任何关系。\n脚本制作纯属技术交流，无任何商业利益或传播淫秽目的。";

/**
 * 「更新说明」的内置版本。原版读的远程 README 现在已经 404，所以远程读不到时显示这个。
 */
export const RELEASE_NOTES = `# JavBus ${VERSION}

移植自 Nicked639 的 JSBox 脚本 **JavBus ${ORIGIN_VERSION}**（你口袋中的 AV 辞典）。

## 功能

- 最新 / 搜索：有码、无码、欧美三个分区；全部 / 收录；番号自动补连字符，搜不到自动换站重搜
- 女优：有码 / 无码列表，演员资料，作品列表，收藏演员
- 分类：类别、导演、系列、制作商、发行商，后四类可收藏
- 详情：封面、标题翻译、片名信息、类别、参演、磁链、样品图像（可批量下载）
- 预览：MissAV 预览、Jable 预览 / 完整视频、Fanza 预告、MissAV 完整视频；内嵌播放器带快进快退，
  也可以交给 Infuse / SenPlayer / VLC / nPlayer 或自定义的外部播放器
- 字幕：播放完整视频时，详情页的「字幕」小胶囊可以搜迅雷字幕库和字幕猫，字幕画在画面上，能换一条、调同步；
  可以用手指拖着挪位置，「字幕设置」里改颜色（可以填 # 色值）/ 字号（滑块）/ 文字和底色的透明度，长句会拆成上下两层（小窗和「全屏」里都有，画中画里没有；
  要用播放器自带的全屏或画中画，用「SenPlayer 打开（带字幕）」）
- 全屏：播放完整视频时，小胶囊里的「全屏」会把界面转成横屏、整页让给播放器，右缘一列按钮：退出全屏 / 字幕设置 / 分享（实验功能）
- 推荐：作者推荐 / 网友推荐，可以推荐影片；设置里填了社区推荐服务的地址后，列表、提交、撤销都走它，
  还能举报失效或不当的推荐（维护者在它的后台审核、自动检查封面和链接是否还在）
- 收藏 / 归档：影片、演员、导演、系列、制作商、发行商；可导入原版的 JavBusBackup.json
- 剪贴板与分享表单检测番号

## 和原版的差别

- Today 小组件做不了（iOS 14 起被 WidgetKit 取代，小组件读不了剪贴板、也放不下完整界面）：
  改用 \`scripting://run/JavBus?code=番号\`、分享表单、启动时读剪贴板
- 脚本自更新（\`$addin\`）是 JSBox 专有的：Scripting 里用它自己的导入 / 远程资源更新
- 「Avgle 联动」原版是调起另一个 JSBox 脚本，站点已经停止服务，9.2 起原版也把它从菜单里去掉了，这里同样没有
- 外部播放器：原版只有 nPlayer，这里加上了 Infuse / SenPlayer / VLC / 自定义链接模板 / 复制视频链接
- 字幕：原版没有；这里接了迅雷字幕库和字幕猫。MissAV 完整视频的隐藏页默认改用电脑版 UA（据反馈能出 1080p），设置里可以关
- 点磁链复制后推送到 Quicker 改为在设置里配置
- 推荐服务：原作者的网友推荐上传服务已经失效（GitLab 令牌过期、上传一律失败）。这里多了一个可选的「社区推荐服务」
  （javbus-community，Cloudflare Worker + 管理后台，大家一起维护），在设置里填地址就用它；不填仍是原作者的列表
`;
