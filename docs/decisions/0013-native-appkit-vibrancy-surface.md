# ADR 0013：用 AppKit 原生材质托底 WebView 液态玻璃

## 状态

已采用（2026-08-31）。

## 背景

`backdrop-filter` 只能表达 WebView 内的半透明近似；在透明 Tauri 窗口中，
WebKit 是否把桌面内容交给 CSS 采样还取决于 macOS 合成器，因此无法把它当作
“真正的系统玻璃”来保证。用户同时要求展开面板和无刘海回退胶囊有实际的桌面
模糊/光泽，而真实硬件刘海中心不能被应用绘制覆盖。

## 决策

1. 在 macOS 运行时直接使用 Tauri 已经间接依赖的 `window-vibrancy` 0.6.0，
   将它声明为本项目的直接依赖（MIT/Apache-2.0）。该库创建带 tag 的
   `NSVisualEffectView` 子类，并把它插入 WKWebView 下方；React/WebView 仍负责
   文本、按钮、圆角裁剪和无障碍树，AppKit 只负责背景采样。
2. 展开态使用 `Popover + BehindWindow + Active` 的语义材质，半径为 30pt；
   无刘海收起态使用同一材质并按 CSS 的 6pt 顶部 inset、胶囊半径更新原生视图。
   每次几何同步通过固定 tag 查找并更新已有视图，避免轮询重复添加兄弟节点。
3. 硬件刘海收起态复用与浮动紧凑态相同 tag、相同参数的一个原生效果视图，
   但根据 AppKit 辅助区域几何为它生成左右双胶囊 alpha mask。遮罩只暴露左右
   信息芯片，中央系统摄像头间隙保持空白；不再维护两份独立合成的原生材质。
   如果几何暂时不可用，会隐藏该视图并退回 CSS 芯片；展开后恢复整面原生材质。
4. 原生桥接只在 `interactive` 状态被明确同步时更新材质；窗口没有 WebView、
   AppKit 主线程不可用或尺寸无效时静默保留 CSS/透明回退，不把材质失败升级为
   数据读取失败。

## 为什么不用 NSGlassEffectView

`NSGlassEffectView` 是更新系统 SDK 的 API，在当前支持的 macOS 15 环境中不能
作为最低运行时依赖。`NSVisualEffectView` 是 macOS 10.10 起的稳定 AppKit
材质入口，能覆盖当前系统并在未来系统继续由系统决定具体光泽；如果以后把最低
系统版本提升到包含 `NSGlassEffectView` 的版本，可增加运行时探测后再选择它，
不能在未探测时直接链接新类。

## 取舍与边界

- 原生材质是否能看到桌面取样仍受透明窗口、WebKit 合成和用户的“减少透明度”
  设置影响；CSS 最终层继续提供不透明/高对比度回退。它比纯 CSS 更接近系统
  液态玻璃，但不承诺每台 Mac 的像素完全一致。
- 硬件收起态先把 `auxiliaryTopLeftArea`/`auxiliaryTopRightArea` 的全局坐标换算到
  WebView 局部坐标，再用原生 `NSImage` mask 裁出左右两枚胶囊。遮罩几何失效时
  整个原生层保持隐藏并保留 CSS 回退，不能退回未经裁切的全宽材质。
- `window-vibrancy` 是小型平台适配库，不引入新的运行时服务或网络权限；
  但它仍增加了一个直接依赖，升级前应复查 objc2 版本与 macOS 构建矩阵。

## 验收

- `cargo check --lib`、`cargo test --lib`、`cargo clippy --all-targets -- -D warnings`
  通过。
- 硬件刘海收起时只有一个带左右双胶囊 mask 的原生 tag 视图；中央摄像头缺口的
  mask alpha 为零。浮动紧凑、展开和无刘海回退复用同一个 tag，且都位于 WKWebView
  下方；重复刷新不会创建第二个同 tag 视图。
- 实机验收仍需在最新 bundle 上确认透明 WebView 能看到桌面背景；若只看到纯色，
  这是 macOS/WebKit 合成限制，应保留 CSS 视觉层并记录为环境差异，而不是伪造
  “已实现真实透视”。
