# ADR 0004：第四步高级能力采用“能力探测 + 安全基础层”

## 状态

已接受（第四步基础层）。这不是六项高级能力全部上线的声明。

## 背景

第四步草图同时列出 App Server、会话恢复、审批、Usage API、多项目和插件系统。它们的数据来源、权限和稳定性不同，不能因为界面上出现一个名称就当作已经可用：

- 本机 `codex-cli 0.148.0-alpha.15` 的 `app-server` 帮助仍标记为 experimental，并同时提供 stdio、Unix socket 和 WebSocket 选项。
- 本机 CLI 还能用 `app-server generate-json-schema --out <DIR>` 生成协议 schema；由于版本是 alpha，schema 没有直接复制进应用，后续接入时应把具体 CLI 版本和脱敏 fixture 一起锁定。
- `codex exec --json` 是当前已经验证的单任务事件入口；现有任务适配器默认使用 `--ephemeral`，因此不会无意创建可恢复会话。
- 官方 Usage API 文档描述的是组织级 OpenAI API 用量/成本端点，不是 ChatGPT 或 Codex 订阅剩余额度。参见 [Usage API reference](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage)。
- 审批和插件执行会扩大文件、网络或任意代码执行权限，必须有显式的授权、审计和回滚设计。

## 决策

第四步先交付以下可验证基础层：

1. 后台只读探测 Codex CLI 的 App Server 帮助和版本，返回带 `source`、`collectedAt`、`confidence`、`evidence` 的能力快照。探测不会启动长期 server、连接远程地址或读取凭据。
2. 在 Tauri 应用数据目录保存用户明确添加的多项目工作区注册表。只接受用户传入的已存在目录，不扫描磁盘；写入使用版本化 JSON、临时文件和原子替换，并限制数量、路径和字段长度。
3. 前端展示六项能力的真实状态：已探测、实验性、未配置、未验证或默认关闭。未接入的能力不得显示为“成功”。
4. 多项目只提供添加当前目录、切换已登记目录和删除登记；切换会使旧项目快照失效，避免把一个项目的 Git/进度数据显示到另一个项目。

当前 IPC 边界是 `get_advanced_capabilities`、`list_workspaces`、`save_workspace` 和
`delete_workspace`。工作区快照使用 `schemaVersion/source/updatedAt/confidence`，目录路径在后台
canonicalize 后保存到 `workspace-registry-v1.json`；前端不能传入任意可执行程序、shell 片段或
存储路径。

## 暂不实现

- 不根据未经锁定的 App Server JSON-RPC 方法实现会话控制。
- 不自动持久化任务会话，也不读取 `~/.codex/auth.json`；会话恢复要在明确的存储、删除和隐私策略后再开放。
- 不自动批准命令、文件变更或额外权限；现有任务仍保持只读沙箱。
- 不在本阶段请求 Admin API key，也不把 API Usage 映射成个人订阅额度。
- 不执行插件代码；未来插件必须先有 manifest、信任来源、权限声明、隔离和卸载机制。

## 数据契约原则

每个能力和工作区快照都带版本、来源、更新时间和置信度；未知字段应向前兼容。能力状态是环境观察，不是产品完成度。工作区注册表只保存路径和用户提供的显示信息，不保存 Prompt、源码、Token 或命令输出。

## 代价与回退

应用数据 JSON 适合少量工作区的低频读写，但不适合历史、并发写入和复杂查询。出现这些需求时迁移到 SQLite，并保留版本化 migration；不能通过删除旧文件“升级”。如果能力探测与当前 CLI 版本不兼容，面板应回退为“未验证”，而不是猜测协议。删除工作区只删除注册表记录，不删除项目文件。
