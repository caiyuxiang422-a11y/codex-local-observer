# ADR 0005：可自定义的桌面快览便签

## 状态

已采用，其中原生窗口形态与定位已被 [ADR 0009](./0009-top-edge-notch-shelf.md) 取代；九类自定义信息、本地数据范围和隐私决策仍有效。

## 问题与目标

主仪表盘信息完整，但用户希望最小化主窗口后仍能在桌面上看到少量关键状态，并能自行选择九类信息。目标是做一个真正独立的本地窗口，而不是在主页面里缩小一张卡片。

## 已核实事实

- Tauri 支持一个应用内创建多个本地 Webview 窗口，并能控制置顶、显示、隐藏和主窗口最小化。
- `codex exec --json` 能为本工具启动的任务提供结构化生命周期与 Usage 事件；它不能证明其他 Codex 客户端正在运行哪些任务。
- 当前只读 `exec` 链路没有审批事件。审批需要后续 App Server 双向接入。
- 公开的组织 Usage API 是 OpenAI API 组织用量接口，不等于个人 ChatGPT/Codex 套餐额度。
- 当前没有用于安全自动读取个人 Plus/Pro 套餐的稳定公开本地接口；读取 Cookie、`auth.json` 或抓取官方 UI 违反项目约束。

## 选择

1. 增加动态创建的 `widget` Tauri 窗口。窗口无系统边框、默认 360×520、可缩放、默认置顶；用户可关闭置顶。主窗口提供“打开便签”和“打开并最小化”。
2. 前端只渲染统一 `WidgetSnapshot`，不解析 Codex 原始 JSONL。九个指标都包含状态、来源、更新时间、置信度和证据。
3. 用户用九个固定 ID 的复选框决定显示内容。偏好持久化到应用数据目录，不写入项目目录。
4. Token 仅汇总本工具保存的每任务最后一个 Usage 快照。总数只在 input/output 均完整时给出；缓存字段单独展示，不重复相加。
5. 运行/失败任务限定为本工具任务；最高完成度和停滞项目限定为用户里程碑。停滞暂定义为里程碑元数据超过 24 小时未更新，并明确这是低置信度规则。
6. 审批保持未知。订阅套餐默认未知；允许手工标签，但标为低置信度、未核验。

## 存储与隐私

MVP 新增 `widget-preferences-v1.json` 与 `widget-task-history-v1.json`。任务历史最多 250 条，只含任务 ID、项目路径、状态、时间、退出码、警告数、结构化 Usage 和归一化事件标签；不含 Prompt、推理、源码、完整命令输出或凭据。JSON 文件有大小上限、原子替换和 Unix `0600` 权限。

这偏离了项目默认 SQLite 架构。原因是当前只有两个低频、边界清晰的小文档，先验证便签价值可减少 schema/migration 成本。代价是缺少跨进程事务、查询、历史 migration 和完善的保留策略；当需要完整事件历史、导出/删除、跨窗口写入或账户级 Usage 时必须迁移到 SQLite。

## 风险与未知项

- 未接入 App Server 前，审批和其他 Codex 客户端任务不可见。
- 手工订阅标签可能过时，不能用于额度或计费判断。
- 轮询会产生少量 CPU/磁盘读取；刷新限制为 2–60 秒，默认 5 秒。
- 当前没有系统托盘和后台守护；应用退出后便签也退出。
- macOS 已作为本阶段目标；Windows/Linux 的置顶、跨工作区与任务栏行为需分别现场验证。

## 回退方案

删除 `widget` 窗口配置、`widget.rs`、`widget_data.rs` 和前端 `WidgetApp` 路由即可回到单窗口仪表盘；现有 Codex、Git、进度和高级能力接口不依赖便签。

## 官方参考

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex plans and usage](https://help.openai.com/en/articles/11369540)
- [Organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage)
