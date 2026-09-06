# ADR 0010：使用 AppKit 读取真实硬件刘海几何

## 状态

已采用（2026-08-30）。

## 问题与目标

项目早期把一个固定尺寸的黑色 Tauri 窗口称为“刘海”。这在不同分辨率、Retina 缩放和外接显示器上都会产生错位，也容易让用户误以为应用可以控制 macOS 的摄像头硬件区域。

目标是让快览窗口读取当前显示器的系统几何，并把自己的内容贴合到真实安全区；同时保留无刘海显示器、旧 macOS 和浏览器预览的明确回退。目标不包括修改硬件刘海、读取官方桌面应用私有 UI，或复制 BoringNotch 的代码。

## 已核实事实

- macOS AppKit 的 `NSScreen` 公开属性可以提供 `frame`、`visibleFrame`、`safeAreaInsets`、`auxiliaryTopLeftArea` 和 `auxiliaryTopRightArea`。后面三项在 macOS 12 及以上可用；旧系统需要能力检查。
- 辅助顶部区域之间的中心间隙可以推导出摄像头安全区的逻辑点宽度；`safeAreaInsets.top` 给出顶部安全区高度。它们是显示布局数据，不是可写的硬件控制接口。
- AppKit 的窗口坐标使用逻辑点，Tauri 的 monitor API 常以物理像素返回。两套坐标不能在同一条路径中直接相加。
- BoringNotch 的公开源码使用独立的 `NSPanel`、`mainMenu + 3` 层级和非激活窗口覆写；其仓库为 GPL-3.0，并且部分更高权限行为依赖非公开框架。这个项目不能直接复制其代码或把普通 Tauri 窗口宣传成等价实现。
- Tauri 的 macOS `transparent` 配置在未启用 `macOSPrivateApi` 时不能证明 WKWebView 背景已经透明；打开该选项会带来私有 API、签名和 App Store 分发代价。

## 方案

1. `src-tauri/src/macos_window.rs` 是唯一的 AppKit 边界。它通过 `WebviewWindow::with_webview` 在 AppKit 主线程借用宿主 `NSWindow`，不跨调用保存裸指针；macOS 显示路径使用 `orderFrontRegardless`，避免把普通 Tauri `show()` 的强制键窗口行为当成刘海交互的一部分。
2. 读取窗口所属 `NSScreen`；隐藏窗口尚未绑定屏幕时，先用窗口 frame 中心命中 `NSScreen::screens`，最后才回退到 `mainScreen`。
3. 计算并返回两组尺寸：
   - `notchWidth/notchHeight`：由辅助顶部区域与顶部安全区推导的 AppKit 布局间隙，供渲染和诊断；它不是可写的硬件尺寸；
   - `closedWidth/closedHeight`：应用窗口的宿主命中区。刘海设备的高度跟随顶部安全区（不额外绘制菜单栏下方的 chin）；宽度在真实缺口两侧各预留基础信息芯片和间距，再加少量命中余量。中央摄像头空间保持透明，两侧显示项目/状态与 Token/余量；全局指针轮询为收起宿主点击穿透时提供 hover 回退。
4. 设置公开的窗口属性：无边框、不可移动、无阴影、跨 Space/全屏辅助。摄像头安全区模式固定使用 `mainMenu + 3`；本机 AppKit 探针已验证 `NSNormalWindowLevel` 会把这种普通 `NSWindow` 下移一个菜单栏高度。用户的“保持在最前方 / 标准窗口层级”偏好仅适用于浮动窗口。frame 按摄像头中心贴到当前屏幕顶部，且先应用有效窗口层级再 `setFrame`，避免 AppKit 先把正确坐标约束到菜单栏下方。
5. 前端把真实安全区、宿主命中区和来源分开显示；原生桥接失败时使用 220×38 回退，并明确标记 `supported=false` 或错误。

## 为什么不直接创建 `NSPanel`

现有 Tauri WebView 的宿主由 Tauri 创建为 `NSWindow`。把它强转为 `NSPanel` 或运行时替换 Objective-C class 会引入未定义行为和生命周期风险。严格的 `canBecomeKeyWindow`/`canBecomeMainWindow` 覆写需要独立的原生 `NSPanel` host，再把 WebView 作为子视图管理；这是一项后续 macOS 专用架构，不应在当前桥接中伪装完成。

## 风险、成本与回退

- 外接显示器通常没有硬件刘海；界面必须显示“顶部胶囊回退”，不能继续使用硬件尺寸。
- 辅助区域必须同时位于屏幕顶边、彼此高度一致且完整落在屏幕内，才认定为硬件缺口；窄显示器上的回退宽度会被限制在屏幕范围内。这样宁可显示回退，也不把异常几何误报成真实刘海。
- 显示器切换、系统缩放和菜单栏设置可能改变几何。前端目前定期刷新并在每次显示/展开时重新同步；若未来需要即时响应，可增加 `NSApplication.didChangeScreenParametersNotification` 桥接。
- 普通 `NSWindow` 即使通过 `orderFrontRegardless` 显示，也不保证具有真正 `NSPanel` 的非激活语义；当前路径只是避免直接调用 Tauri `show()` 的强制键窗口分支。若该行为成为硬需求，回退/升级路径是独立原生 panel host。
- 原生桥接的普通几何刷新不得改写浮动窗口的层级偏好；但摄像头安全区模式每次都要保持
  `mainMenu + 3`，否则几何契约本身不成立。诊断继续回读实际 `windowLevel`。
- 透明 WebView 的本地发行策略已由 [ADR 0011](0011-macos-transparent-notch-surface.md) 记录：当前 macOS 本地构建启用 `macOSPrivateApi`，并保留改回 `false` 的公开 API 回退。该开关只影响 WebView 合成，不代表可以控制硬件刘海。
- AppKit 桥接只负责窗口和屏幕几何，不能修复 Codex Usage、项目 Token 或进度数据缺失；这些数据仍由各自适配器提供并带来源/置信度。

## 验收

- 在本机内置 Retina 屏幕上，独立 AppKit 检查可返回安全区和辅助区域；应用诊断应显示 `source=appkit`，而不是浏览器回退。
- 在无刘海/浏览器回退中，`hasHardwareNotch=false`、`notchWidth=0`，且 UI 不把回退尺寸称为真实硬件数据。
- `cargo fmt`、`cargo clippy -D warnings`、Rust 单元测试、前端测试、TypeScript/Vite 构建和 macOS `.app` 构建必须通过。透明 WebView、严格非激活 panel 和锁屏/录屏行为不在本 ADR 的已验证范围内。

## 参考

- [Apple NSScreen 文档](https://developer.apple.com/documentation/appkit/nsscreen)
- [Apple NSWindow 文档](https://developer.apple.com/documentation/appkit/nswindow)
- [Tauri Window Customization](https://v2.tauri.app/learn/window-customization/)
- [BoringNotch 官方窗口源码](https://github.com/TheBoredTeam/boring.notch/blob/main/boringNotch/components/Notch/BoringNotchWindow.swift)
- [BoringNotch LICENSE](https://github.com/TheBoredTeam/boring.notch/blob/main/LICENSE)
