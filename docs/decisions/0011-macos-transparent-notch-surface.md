# ADR 0011：本地版启用透明 WebView 的刘海锚点模式

## 状态

已采用（2026-08-30）。

## 背景

ADR 0010 已经把窗口位置改为由 AppKit 的 `NSScreen` 安全区和顶部辅助区域决定，但原来的 Tauri 配置仍然是 `macOSPrivateApi=false`。在当前 Tauri/Wry 版本中，macOS 的 `transparent: true` 在这个配置下不会把 WKWebView 的默认背景关闭；因此 CSS 的 `background: transparent` 不能单独证明窗口真的能透出桌面。

这会产生两个相反的问题：

- 在有硬件刘海的 MacBook 上，WebView 的矩形背景会让应用看起来又画了一条“假刘海”；
- 在没有硬件刘海的外接显示器上，圆角回退胶囊的透明角落可能露出 WebView 的默认底色。

## 已核实事实

1. 第三方应用不能修改、绘制或控制 Mac 的摄像头硬件切口。应用只能读取 AppKit 提供的布局几何，并把自己的窗口贴合到该几何。
2. Tauri 的 macOS 透明窗口路径需要 `macOSPrivateApi` 构建开关；Wry 为 WKWebView 关闭默认背景使用的是未公开的 `drawsBackground` KVC 设置。这个开关不是硬件刘海控制，也不能赋予应用 BoringNotch 的 SkyLight/CGS 能力。
3. 当前 Tauri 宿主仍然是 `TaoWindow : NSWindow`，不是可覆写 `canBecomeKeyWindow` 的独立 `NSPanel`。本 ADR 不改变这个事实。
4. AppKit 的 `NSView.alphaValue`、`NSWindow.setOpaque(false)`、清色背景和 `ignoresMouseEvents` 是公开 API；它们可以作为运行时的防御措施和交互切换，但不能把 WKWebView 的透明能力误报为公开 API 的完整等价物。

## 决策

本项目的默认目标是“本地 macOS 桌面版”，不是 App Store 发行版，因此 `src-tauri/tauri.conf.json` 选择 `macOSPrivateApi=true`，让透明 WebView 这条路径在实际构建中生效。为避免把透明配置当成无条件保证，原生桥接在收起的硬件刘海模式仍保持中央空间透明，同时保留两侧基础信息芯片可见；展开或无刘海回退模式恢复完整表面，诊断面板回读窗口和 WebView 状态。

交互状态按下面的规则执行：

- 有硬件刘海 + 收起：窗口贴合 AppKit 推导的缺口，中央缺口空间不绘制像素，左右基础信息芯片保持可见，窗口点击穿透；这不是把项目文字塞进实体黑色区域。由原生 AppKit 指针采样判断靠近后展开。
- 有硬件刘海 + 展开：恢复 WebView alpha，窗口接收鼠标和键盘，内容从顶边向下展开。
- 无硬件刘海：显示明确标注的顶部胶囊回退，保持窗口可点击；不会把回退尺寸称为真实刘海。
- 显示器或窗口信息暂时不可用：保留可用的回退交互，不把未知值写成 0 或硬件数据。

## 为什么现在选择私有透明开关

这是一个针对本地发行的产品取舍：用户明确需要与系统刘海视觉融合，而现有 Tauri/WKWebView 栈在不启用该开关时无法可靠去掉默认 WebView 背景。启用后为 CSS 玻璃表面提供透明 WebView 合成基础，可减少“白色/矩形底板”伪影；实际是否采样到窗口外桌面仍取决于 macOS/WebKit 合成上下文，不等同于原生 `NSVisualEffectView` 材质。

这不是“更原生”或“更安全”的证明。它只是解决当前 WebView 合成层的一个具体限制；硬件几何、窗口焦点和权限仍分别由 AppKit/Tauri 的公开接口负责。

## 风险与回退

- Tauri 文档明确警告：macOS 私有 API 会阻止 App Store 接受；签名、公证、企业分发和未来 macOS 版本兼容性需要单独验证。
- Wry 的私有 KVC 键可能在未来系统或依赖升级中变化。启动后若诊断发现窗口仍有不透明底色，应降级为明确的窄胶囊，而不是继续宣称“等同硬件刘海”。
- 开源使用者若需要公开 API/商店兼容版本，可以把 `macOSPrivateApi` 改回 `false`；中央透明区域可能退化为保守表面，非刘海回退仍保持可见，不应把它宣传为硬件刘海融合。
- 若产品未来要求严格的 BoringNotch 行为（真正 non-activating `NSPanel`、锁屏/特殊 Space、录屏排除），应新建独立原生 panel 宿主设计，不要把本 ADR 当成那些能力已经完成。

## 验收

- `.app` 构建日志不再提示透明配置被忽略。
- 内置 Retina 屏幕上，诊断显示 `source=appkit`、真实安全区/辅助区域和 `webviewAlphaValue`；收起硬件模式显示中央透明、两侧信息可见与点击穿透，展开显示 `100% alpha` 并可操作按钮。
- AppKit 指针命令返回的 pointer/frame 都是逻辑点，靠近刘海能触发展开；不再使用 Tauri `cursorPosition()` 的 Retina 换算。
- `cargo fmt --check`、`cargo clippy -D warnings`、Rust/前端测试、Vite 构建和 macOS `.app` 构建通过。

## 参考

- [Apple NSScreen](https://developer.apple.com/documentation/appkit/nsscreen)
- [Apple NSScreen safeAreaInsets](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets)
- [Apple NSWindow](https://developer.apple.com/documentation/appkit/nswindow)
- [Tauri macOSPrivateApi](https://v2.tauri.app/reference/config/#macosprivateapi)
- [Tauri Window Customization](https://v2.tauri.app/learn/window-customization/)
- [Wry WKWebView implementation](https://github.com/tauri-apps/wry/blob/wry-0.55.1/src/wkwebview/mod.rs)
