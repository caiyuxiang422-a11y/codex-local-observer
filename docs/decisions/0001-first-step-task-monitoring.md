# ADR 0001：第一步只做任务监控

状态：已采用（2026-08-25）

## 决策

第一版采用 Tauri 2（React/Vite 前端 + Rust 本地进程协调器），只实现由本工具启动的单个 `codex exec --json` 任务的实时监控。

## 为什么不是浏览器直接启动

浏览器不能安全、跨平台地启动本机 Codex 子进程，也不应拥有任意文件系统权限。Tauri 后端可以使用无 shell 的 `Command`、固定工作目录、只读沙箱和进程树终止；前端只消费统一 IPC 事件。

## 为什么暂时不用 App Server

App Server 适合后续做会话恢复、多任务和更丰富的协议，但它是另一层生命周期与版本兼容面。截图要求的是 `codex exec --json` JSONL 链路；先把这条链路做成可测试适配器，减少第一步的变量。

## 成功判定

`turn.completed` 只是上游回合终结候选，不代表子进程已经干净退出。协调器等 stdout/stderr EOF 和进程退出后再判定：

- `turn.completed` + exit code 0 → `completed`
- `turn.failed`、顶层 `error`、非零/信号退出 → `failed`
- 用户停止 → `cancelled`
- exit code 0 但没有终结事件 → `failed`，并说明“协议不完整”，不伪造成功

## 未决问题

- 不同 Codex CLI 版本的新增事件字段需要 fixture 和版本矩阵。
- Usage 的聚合范围必须由产品定义，不能从多个 `turn.completed` 盲目相加。
- 项目完成度应来自可验证信号（目标、Git diff、测试），不能用 token 数量代替。

