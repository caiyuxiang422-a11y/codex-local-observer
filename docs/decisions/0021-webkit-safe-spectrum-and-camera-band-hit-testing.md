# ADR 0021：WebKit 安全的光谱边缘与摄像头带命中

## 状态

已采用。本决策取代 ADR 0020 的摘要视图 `foreignObject + mask` 实现，并取代
ADR 0018/0019 中“硬件紧凑视图不挂载 SDF”的实验性限制。

## 问题

1. WKWebView 可以把 SVG `foreignObject` 中带 `transform` 动画的 HTML 子元素提升为独立合成层。
   当该层越过 SVG mask 时，彩虹背景会铺满整个摘要视图，并遮住顶部内容。
2. 紧凑视图原来同时使用 CSS mask、负 inset 和父级 clip，Retina 与分数尺寸下会重复
   抗锯齿，造成光谱环宽度不均和圆弧偏方。
3. 静止紧凑/摘要窗口使用“整个原生 frame + 34pt”作为展开命中区，左右信息肩和
   摘要正文都会误触。

## 决策

### 摘要轮廓

- 硬件摄像头摘要不再嵌入 `foreignObject`、HTML 彩色轮或 SVG mask。
- 玻璃 fill、低透明度基础光谱线和流动高光线复用完全相同的 `contour.path`。
- 流动只改变纯 SVG path 的 `stroke-dashoffset`，不再创建可以越过轮廓的 HTML 合成层。
- 内容层固定高于光谱线；强制颜色模式隐藏装饰渐变并恢复实线边界。

### 紧凑水滴玻璃

- 原生 AppKit `NSVisualEffectView` 继续负责对窗口后的真实桌面取样与模糊。
- 一个低功耗 WebGL2 画布在挂载或几何/外观改变时绘制一帧：解析 SDF 轮廓、高度场、
  三维法线、双界面响应、中心/内边缘/外边缘高光、色散与阴影。
- 浮动与摄像头安全区紧凑态只挂载同一个 `CompactGlassChrome`。它把同一磨砂底层放在
  SDF 下方，把同一 masked-conic 2pt 光谱环放在 SDF 上方；顺序固定为
  AppKit → frost → SDF → spectrum → 内容。
- 原生遮罩、SDF 与前端轮廓都使用 `height / 2` 圆角。摄像头安全区只把同一材质暴露为
  左右两片，不在指标子组件里维护另一套玻璃 DOM；短表面的 SDF 光学分区按圆角比例缩放。

WebGL 不能直接读取桌面像素，因此 SDF 层表达的是厚度、法线、Fresnel 与色散响应，
不是桌面壁纸的真实位移折射。真实背景透视来自 AppKit；如要完整位移折射，必须增加屏幕
捕获或原生 Metal 管线，会带来录屏权限、隐私和维护成本，本版不采用。

### 指针命中

- 紧凑与摘要常驻态只测试当前 frame 顶部中央的
  `notchWidth × (notchHeight || safeAreaTop)` 区域，入口外扩为 0pt。
- 无硬件摄像头的显示器使用顶部中央回退胶囊作为 DOM 交互入口。
- 完整视图才使用整个 frame，退出区外扩 8pt；连续两个 50ms 样本都在外部才收起。
- IPC 返回后再比较发起采样时的 presentation，丢弃改帧期间的旧样本，但不停止下一次轮询。
- 原生支持路径禁用 section 级 `pointerenter/pointerleave`，不让整张摘要再次成为隐形命中区。

## 性能、可达性与回退

- SDF 层没有持续 `requestAnimationFrame`；常驻动画只是小面积 masked-conic 渐变轮，但电量开销仍不是零。
- “减少动态效果”停止 dash 流动；“减少透明度”或“增强对比度”关闭 SDF，恢复高可读底色。
- WebGL2、shader 或几何失败时使用现有 CSS/AppKit 材质回退，不影响项目数据。
- 浏览器可验证 DOM、SVG 轮廓与回退，但 `NSVisualEffectView.BehindWindow` 的桌面透视和 Retina
  拼接必须在有摄像头安全区的 Mac 上验收。

## 验收

1. 摘要视图中 `foreignObject` 和 HTML 彩色轮数量均为 0；光谱 path 与玻璃 fill 的 `d` 完全相同。
2. 摘要正文中心不出现彩虹填充，顶部左右内容都可见，中央摄像头区域不绘制应用像素。
3. 417×32pt 宿主的两个 104×26pt 侧面使用 13pt 圆角；共享 masked-conic 边缘在直线、四个圆弧处都为 2pt。
4. 560×224pt 摘要中只有顶部中央 185×32pt 摄像头带能打开完整视图；左右肩和正文不命中。
5. 连续切换紧凑/摘要/完整视图不会再出现整面彩虹、顶部丢失或轮询永久停止。
