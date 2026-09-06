# ADR 0015：采用 rdev/liquid-glass-react 的兼容性液态玻璃层

## 状态

已采用（2026-08-31）。

## 背景与事实

- 本项目按用户指定检查了 [`rdev/liquid-glass-react`](https://github.com/rdev/liquid-glass-react)。本次页面检查显示约 6.0k stars；星标是会变化的仓库元数据，不是质量或安全证明。
- 仓库采用 MIT 许可证，并提供 `LiquidGlass` React 组件。它用 SVG `feDisplacementMap` 分离 RGB 通道，叠加 `backdrop-filter`、边缘高光和轻微弹性。
- 仓库 README 明确说明 Safari/Firefox 只部分支持该效果，位移折射不可见。Tauri 的 macOS 前端运行在 WKWebView（WebKit），所以不能把 Chromium 下的完整位移当作稳定能力。
- npm 包 `liquid-glass-react@1.1.1` 的 tarball 声明 React/ReactDOM `>=19`，而当前 GitHub `master` 页面显示的声明是 `>=18`；两者存在漂移。本项目当前使用 React 19，固定 npm 版本 `1.1.1` 并保留 lockfile，不直接跟踪未发布的 `master`。
- `shader` 模式会按尺寸逐像素生成 Canvas 位移图，且仓库已有关于 shader 稳定性、滚动/GPU 开销和 SVG 层重叠的公开 issue。本项目不是需要持续动画的全屏 WebGL 场景。

## 决策

1. 引入并固定 `liquid-glass-react@1.1.1`，仅在展开的快览面板中挂载一个指针穿透的装饰层，使用 `mode="standard"` 和保守参数（低位移、低色差、适度 blur/saturation）。
2. `LiquidGlassBackdrop` 只提供材质光学层；文字、Token、Usage、任务和进度仍由原有 DOM 绘制，AppKit 的 `NSVisualEffectView` 继续负责桌面背景采样。
3. 通过 CSS 将组件生成的 SVG/边框片段裁剪在面板圆角内，并移除库默认的深色 inset shadow，避免黑色圆角边缘；传入的白色 sheen 也被提升为全尺寸光学子层；信息层固定在更高 z-index，保证可读性。
   组件的位移 SVG 只在挂载时测量尺寸，而原生窗口此时可能仍处于收起态；适配层因此强制让 SVG 跟随展开宿主尺寸，避免 218×30 的启动图残留在面板左上角。
4. 遇到“减少透明度”“高对比度”或“减少动画”偏好时，不挂载该装饰层，继续使用原生/实色回退。库层失效时不影响数据读取和窗口交互。
5. 不使用 `shader` 模式、不把库套在真实硬件刘海中央、不读取桌面截图，也不把第三方组件宣传为 Apple 官方实现。

## 原因与取舍

- 这样能实际复用指定项目的标准位移图、色差和边缘光学思路，同时尊重 WebKit 的能力边界；在支持有限的环境中，仍能看到白色磨砂与光泽，而不是出现不稳定的黑色 shader 横条。
- 装饰层限制为一个面板，避免每个 Token 卡片都创建 SVG filter，降低 GPU/电量和调试成本。内容保持原生 DOM，便于选择文本、辅助功能和数据降级。
- 这是“兼容性液态玻璃”而不是逐像素保证的 Apple 原生 Liquid Glass。不同 macOS 版本、壁纸、显示器缩放和 WebKit 合成路径可能产生不同的折射可见度。
- 第三方组件的默认层级和内联尺寸不能直接套进中心锚定的原生窗口：默认深色辅助层会造成白色背景闪黑，初始尺寸也可能与异步 AppKit resize 错位。当前 CSS 适配只覆盖可预测的标准模式，升级组件时必须重新做几何验收。

## 验收标准

- 展开面板的四个圆角没有黑边，中央真实摄像头缺口仍由 AppKit 保持透明。
- 文字和进度条在库层启用时仍清晰，库层关闭/不支持时数据布局不改变。
- `prefers-reduced-motion`、`prefers-reduced-transparency`、`prefers-contrast: more` 下无持续 shader/透明滤镜。
- `npm run check`、Rust 格式/测试/lint 和 macOS `.app` 打包均通过；真实带刘海 MacBook 仍需人工检查不同壁纸与系统辅助功能设置。

## 许可证与更新边界

使用 npm 包时保留其 MIT 许可证文本（见 `node_modules/liquid-glass-react/LICENSE`，发布归档时应将该归属一并带上）。升级前应重新核对 npm tarball 与 GitHub 源码、peer dependency、公开 issue 和 WebKit 实机表现；不能只依据 stars 或 README 标题自动升级。
