# ADR 0014：液态玻璃参考实现与 macOS 适配边界

## 状态

已采用（2026-08-31）。

## 问题

用户希望收起态两侧芯片和展开态面板具有白色、透明、带光泽的 Apple 风格材质，
同时不能因为“模拟刘海”而覆盖 Mac 的真实摄像头缺口。

## 已核实的外部参考

- [`samasante/liquid-glass`](https://github.com/samasante/liquid-glass)：截至本次
  检查 GitHub 页面显示 502 stars、MIT 许可证。它采用 rounded-rect SDF 位移图、
  SVG `feDisplacementMap`、边缘高光和清晰的内容层；仓库说明也明确指出，
  `backdrop-filter: url()` 的实时折射在 Chrome/Edge 可用，Safari/Firefox 主要
  退化为 frost/tint/edge-light。
- [`deepika-builds/liquid-glass`](https://github.com/deepika-builds/liquid-glass)：截至
  本次检查显示 253 stars、MIT 许可证，并提供独立的 `SKILL.md`。它把材质拆成
  折射、色差、模糊、色调、边缘高光和阴影，同时要求保留内容可读性、避免在大于
  约 800px 的元素上滥用 GPU 滤镜。

星数是随时间变化的仓库元数据，只作为选择参考，不是质量或安全性的证明。

## 本项目的选择

1. 不直接复制或引入上述整套 Web 折射库。我们的桌面 UI 跑在 macOS WKWebView，
   而不是 Chromium；把只在 Chromium 完整工作的折射效果作为功能依赖，会造成
   用户看到的材质随系统版本变化，且会增加 GPU 和维护成本。
2. 采用同一套视觉分层思想：低不透明度白色 tint、较强背景模糊/饱和度、窄而明亮
   的顶部/边缘 sheen、轻微内阴影，以及清晰的前景文字。对应 CSS 在
   `src/WidgetApp.css` 的最后一层，所有重要数据仍由 React 原生 DOM 绘制。
3. 在 macOS 原生窗口下方增加 `NSVisualEffectView`（通过 `window-vibrancy`），
   让 AppKit 负责桌面取样；React 层负责内容、圆角裁剪、交互和无障碍。
4. 真实硬件刘海收起时移除全宽原生材质，只保留两侧芯片；展开后才使用完整面板。
   中央摄像头缺口的几何仍来自 AppKit 的安全区和辅助区域，不绘制或控制硬件本身。

## 为什么这样做

- **可见性**：降低 WebView 背景 alpha 才能让 AppKit 的桌面取样透出来；纯不透明
  渐变只能看起来像磨砂卡片，不能称为真实透视。
- **可靠性**：在 WebKit 不支持完整 `backdrop-filter: url()` 时，仍有原生材质和
  CSS frost/tint/edge-light 回退，不把折射效果承担到信息含义上。
- **可维护性**：不增加 WebGL、截图复制或远程服务；材质失败只降级视觉，不影响
  Token、任务和项目进度数据。
- **无障碍**：减少透明度、提高对比度和减少动画偏好仍切换到实色/静态回退。

## 未知项与验收边界

- 不同 macOS 版本、桌面壁纸和“减少透明度”设置会改变 AppKit 取样结果；不能
  承诺每台机器像素完全一致。
- 当前运行环境为 macOS 15；不能直接链接只在更新系统 SDK/运行时提供的
  `NSGlassEffectView`。如未来把最低系统版本提高到相应版本，需增加运行时探测
  和独立回退测试。
- 最新 bundle 仍需在真实带刘海 MacBook 上进行逐像素验收，重点检查：展开/收起
  圆角无黑边、中心缺口未被覆盖、短标题省略、减少透明度回退和鼠标靠近反向收起。

## 回退方案

如果原生材质在某个系统或 WebView 合成路径不可见，保留 CSS 的白色 frost/tint/
sheen 层，并在设置中提示“系统材质不可用”；不要改为读取桌面截图，也不要抓取
官方 Codex 应用的私有存储来弥补视觉问题。

