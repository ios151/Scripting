// 内置的测试快捷指令：一个「显示提示」动作，运行时弹框说「导入并运行成功」。
//
// 用来一键验证整条链路（证书装对没、信任了没、签名系统认不认），不用先找个快捷指令文件。
// 内容和 2026-10-28 在用户 iOS 27.2 上签过、导入并运行成功的那份完全一致
// （shortcut-sign-test/签名测试.shortcut，逐字节照抄），所以它本身的 plist 结构是已知能用的——
// 出问题只可能出在证书或签名上。

export const SAMPLE_SHORTCUT_NAME = "签名测试";

export const SAMPLE_SHORTCUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>WFWorkflowName</key>
	<string>签名测试</string>
	<key>WFWorkflowMinimumClientVersion</key>
	<integer>900</integer>
	<key>WFWorkflowMinimumClientVersionString</key>
	<string>900</string>
	<key>WFWorkflowIcon</key>
	<dict>
		<key>WFWorkflowIconStartColor</key>
		<integer>4274264319</integer>
		<key>WFWorkflowIconGlyphNumber</key>
		<integer>61440</integer>
	</dict>
	<key>WFWorkflowClientVersion</key>
	<string>2607.0.1</string>
	<key>WFWorkflowImportQuestions</key>
	<array/>
	<key>WFWorkflowTypes</key>
	<array>
		<string>Watch</string>
	</array>
	<key>WFWorkflowInputContentItemClasses</key>
	<array>
		<string>WFAppStoreAppContentItem</string>
		<string>WFArticleContentItem</string>
		<string>WFContactContentItem</string>
		<string>WFDateContentItem</string>
		<string>WFEmailAddressContentItem</string>
		<string>WFGenericFileContentItem</string>
		<string>WFImageContentItem</string>
		<string>WFiTunesProductContentItem</string>
		<string>WFLocationContentItem</string>
		<string>WFDCMapsLinkContentItem</string>
		<string>WFAVAssetContentItem</string>
		<string>WFPDFContentItem</string>
		<string>WFPhoneNumberContentItem</string>
		<string>WFRichTextContentItem</string>
		<string>WFSafariWebPageContentItem</string>
		<string>WFStringContentItem</string>
		<string>WFURLContentItem</string>
	</array>
	<key>WFWorkflowOutputContentItemClasses</key>
	<array/>
	<key>WFQuickActionSurfaces</key>
	<array/>
	<key>WFWorkflowHasOutputFallback</key>
	<false/>
	<key>WFWorkflowHasShortcutInputVariables</key>
	<false/>
	<key>WFWorkflowActions</key>
	<array>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.alert</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>WFAlertActionTitle</key>
				<string>签名测试 ✅</string>
				<key>WFAlertActionMessage</key>
				<string>导入并运行成功：这个快捷指令的签名被系统接受了。</string>
				<key>WFAlertActionCancelButtonShown</key>
				<false/>
			</dict>
		</dict>
	</array>
</dict>
</plist>
`;
