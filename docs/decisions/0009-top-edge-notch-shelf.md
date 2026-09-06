# ADR 0009：顶边刘海式项目快览

## 状态

已采用（2026-08-30）。

## 问题

旧快览是一个放在菜单栏下方的可拖动浅色圆角窗口。收起时它仍是四周有空隙的胶囊，展开时则变成另一个白色玻璃面板。两种状态缺少共同的空间原点，且高频数据、任务列表、证据和设置同层竞争，不符合“一眼看到当前项目”的目标。

## 已核实事实

- BoringNotch 的公开源码使用顶部中央锚定、不可移动的透明 `NSPanel`；原生宿主窗口约 640×210，可见 notch 在关闭/展开之间改变尺寸。默认 hover intent 约 0.3 秒，离开后约 0.1 秒收起，点击立即展开。来源：[BoringNotch 官方仓库](https://github.com/TheBoredTeam/boring.notch)、[尺寸源码](https://raw.githubusercontent.com/TheBoredTeam/boring.notch/main/boringNotch/sizing/matters.swift)、[窗口源码](https://raw.githubusercontent.com/TheBoredTeam/boring.notch/main/boringNotch/components/Notch/BoringNotchWindow.swift)。
- BoringNotch 是 GPL-3.0 项目，且为最高窗口层级、Space、锁屏/截图隐私等行为使用了 CGS、SkyLight 等非公开能力。当前 MIT 项目不能直接复制它的代码或资产，也不应声称与其系统层能力等价。来源：[官方 LICENSE](https://raw.githubusercontent.com/TheBoredTeam/boring.notch/main/LICENSE)、[SkyLight 窗口实现](https://raw.githubusercontent.com/TheBoredTeam/boring.notch/main/boringNotch/components/Notch/BoringNotchSkyLightWindow.swift)。
- Tauri 的 `Monitor.work_area()` 排除 macOS 菜单栏，因此旧的 work-area + 12 px 定位必然位于菜单栏下方。`Monitor.position()/size()` 提供跨平台的完整显示器近似；macOS 原生路径进一步使用 AppKit 的 `NSScreen.frame`、`safeAreaInsets` 和辅助顶部区域读取真实屏幕几何。
- “当前项目进度”不能用“全部项目中完成度最高者”代替。两者是不同 scope，必须在数据契约中分开。

## 决策

1. 快览默认固定在当前显示器完整 frame 的顶边中央，不允许用户拖离顶边或手动缩放。macOS 关闭态的真实刘海宽高由 AppKit 动态读取，宿主高度跟随顶部安全区，不额外绘制菜单栏下方的 chin；展开态为 620×460，转换只保持顶边 y 和水平中心。无刘海或非 macOS 环境回退为 220×38。
2. 可见表面是一个贴合顶边的液态玻璃 shell：浅色外观使用白色半透明材质，关闭时顶边无空隙、只有底部圆角；展开时同一表面向下生长。深色外观遵循系统配色。外层只使用一层材质与模糊，内部卡片是不叠加 blur 的 tonal surface；减少透明度/动画时回退到实色或无动画。
3. hover intent 为 260 ms；无刘海回退或已展开态的点击/键盘聚焦可立即展开，硬件刘海收起态点击穿透，移出延迟 140 ms 收起。原生 frame 先长大再运行可见 shell 动画；收起时表面以约 300 ms 向顶部中心缩回，原生 frame 在动画结束后变窄，避免动画被 WebView 边界裁切；再次靠近时可中断并反向展开。
4. 信息层级是：关闭态显示项目、运行状态、项目 Token 和 Usage 窗口比例；硬件刘海两侧保留项目/状态与 Token/余量基础芯片，中央缺口透明；展开第一层显示项目 Token、Usage 余量比例、距当前里程碑目标；任务、跨项目比较、日用量和变化放入可滚动第二层；自定义设置使用独立二级视图。
5. `WidgetSnapshot.currentProjectProgress` 使用 `scope=current_project`，只精确匹配当前规范化项目路径。没有选择、没有里程碑或完成度无效时显示未知，不回退到 `highestCompletion`。
6. 实现仅提炼公开可见的交互模型；代码、图形和 Codex 信息布局为本项目独立实现，不引入 BoringNotch GPL-3.0 源码或资产。

## 风险与边界

- 当前仍是 Tauri `WebviewWindow` 对应的普通 `NSWindow`，AppKit 桥接只施加公开的面板式样式和窗口行为，不把它强转成 BoringNotch 的 non-activating `NSPanel`。Tauri macOS 显示窗口时可能仍激活应用；严格复刻需要独立的 macOS 原生 panel host，同时会影响键盘设置表单。
- 公开 Tauri `alwaysOnTop` 不等于 `.mainMenu + 3` 或 CGS 最高 Space。当前不保证在锁屏、所有全屏 Space 或菜单栏最高层级可见，也不做录屏排除；用户关闭“始终置顶”后，后续几何刷新不会重新覆盖该选择。
- AppKit 桥接现在读取 macOS `safeAreaInsets` 和 `auxiliaryTopLeft/RightArea`，并把真实刘海尺寸与宿主命中区分别返回。刘海设备的关闭宿主高度贴合顶部安全区；桥接不可用时才使用 220×38 回退，这类回退会在设置诊断中明确标记，不会冒充硬件数据。
- 透明 WebView 的构建策略由后续 [ADR 0011](0011-macos-transparent-notch-surface.md) 决定：本地 macOS 版启用 Tauri `macOSPrivateApi=true` 以避免默认 WKWebView 底色造成矩形伪影；硬件刘海收起时只让中央缺口透明、保留两侧芯片，同时保留公开 AppKit 回退路径和明确的签名、商店分发风险。
- 多显示器当前只放置一个快览，每次显示时使用当前/主显示器；没有为每个 `NSScreen` 创建独立窗口。

## 验收与回退

- 前端验收覆盖动态关闭尺寸变量、620×460 展开态、设置滚动/粘性保存按钮、Escape 收起、减少动画/透明度回退和原生诊断。后端测试覆盖负坐标显示器、顶边居中、AppKit 回退契约和当前项目进度不串项目。
- 若顶边窗口在目标 macOS 上与菜单栏冲突，可回退为完整 monitor frame 顶边 + 可配置安全下移；若动画导致 WebView 边界闪烁，可回退为无动画的两档尺寸，不改变数据契约。
