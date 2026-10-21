# Codex 本地观察台

[English](README.md)

一个非官方、本地优先的 macOS Codex 可观测性工具。它只展示能够确认来源的
数据，不会为了填满界面而编造数字。

> [!IMPORTANT]
> 本项目是独立开源项目，与 OpenAI 无隶属、合作或官方背书关系，也不是官方
> Codex 客户端。“Codex”等产品名称归各自权利人所有。

项目目前处于 **Alpha 阶段**。源码可以公开审查和本地开发；公开提供 macOS
安装包前，必须完成 Developer ID 签名与 Apple 公证。临时签名或未签名构建不应
作为面向普通用户的正式下载。

## 可以看到什么

- 当前选中项目的 Git 状态、用户定义的里程碑进度、由本工具观察到的运行/失败
  任务，以及最近变化。
- 只有本机 Codex 集成真实返回时才显示项目与账户 Usage；历史 Token 未返回时
  保持“不可用”，不会显示成 0。
- 官方 App Server 暴露时，显示限额窗口百分比、重置时间、credits 和套餐信息。
- 保留主、次额度窗口；摘要显示更紧的已返回窗口，详细视图分别展示两者。项目各数据源
  独立加载，主窗口可见时定时刷新项目数据。
- 与编程有关的 CPU、内存、存储、网络和电池只读状态。
- 紧凑、摘要和详细三种视图；既可以贴合 macOS 摄像头安全区，也可以使用可拖动
  的浮动窗口。
- 可自定义显示指标，并支持中英文界面偏好。

摄像头安全区视图只是依据 AppKit 公共屏幕几何定位的应用窗口，不能控制、替换
或修改物理摄像头区域。

## 数据口径

| 指标 | 实际含义 |
| --- | --- |
| 项目 Token | 匹配项目线程返回的 Usage，或本工具本地观察到的任务 Usage；两种范围不会相加。 |
| 账户活动量 | 账户接口返回的 Token 活动，不是额度上限。 |
| Usage 余量 | 官方窗口百分比或 credits 余额；不能换算成一个绝对剩余 Token 数。 |
| 项目完成度 | 用户定义里程碑的透明加权结果，不根据 Token、文件数或提交数猜测。 |
| 运行/失败任务 | 本观察台启动或记录的任务，不代表其他 Codex 客户端中的全部任务。 |
| 等待批准 | 在接入受支持的审批事件前保持未知。 |

重要快照会尽量携带来源、更新时间、可信度和证据。详细边界和工程权衡记录在
[架构决策](docs/decisions/) 中。

## 隐私与安全

- 只访问用户明确选择的项目目录，不扫描整块磁盘。
- 不读取 `~/.codex/auth.json`、浏览器 Cookie 或其他应用的私有存储。
- Prompt 通过 stdin 交给子进程，默认不保存。
- 本地任务历史不保存完整 Prompt、推理、源码正文或完整命令输出。
- Codex 任务默认使用只读、临时沙箱。
- 测试和构建脚本只在用户明确操作后运行。它们属于所选仓库提供的代码，仍可能
  写文件或访问网络。
- 偏好、里程碑、工作区登记和有上限的任务元数据保存在 Tauri 应用数据目录。
- 当前实现不包含应用遥测或云同步。

安全问题请先阅读 [SECURITY.md](SECURITY.md)，不要把漏洞细节直接发到公开 Issue。

## 环境要求

- macOS 11 或更高版本。目前实际开发验证以 Apple silicon 为主；Intel 和通用
  二进制仍需要单独验证。
- Node.js 20.19 或更高版本及 npm。
- Rust stable 与 Xcode Command Line Tools。
- Git；真实 Codex 数据还要求本机可用的 Codex CLI。

Tauri 平台依赖见
[v2.tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 本地运行

```bash
npm ci
npm run dev
```

浏览器预览不能读取本机项目或启动 Codex，会明确提示桌面后端未连接。

运行桌面开发版：

```bash
rustup default stable
source "$HOME/.cargo/env"
npm run tauri:dev
```

如果没有自动找到 Codex，可以明确指定可执行文件：

```bash
export CODEX_MONITOR_CODEX_BIN=/path/to/codex
npm run tauri:dev
```

开发时也可以用 `CODEX_MONITOR_PROJECT_DIR` 指定默认项目。正式构建不会探测编译
它时所在的私人目录。

## 验证修改

```bash
npm run check

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

仓库包含前端模型测试，以及事件解析、路径校验、有界存储、脱敏、进程结果、项目
进度、Usage 归一化和平台降级的 Rust 测试。摄像头安全区几何和玻璃材质仍需真实
设备验收。

## 打包与发布

生成仅供本机验证的 macOS 归档：

```bash
npm run package:macos
```

脚本会在 `release/` 中生成 app zip、SHA-256、构建元数据和许可说明。如果没有
Apple Developer ID 与公证凭据，产物会明确标为未公证，不能宣传成普通用户可以
直接安装的正式版本。

完整的维护者清单、Bundle ID 决策、可选 Apple secrets 和 GitHub 发布行为见
[RELEASE.md](RELEASE.md)。

## 目录结构

```text
src/                    React UI、视图模型和前端测试
src-tauri/src/          Rust 适配器、进程控制、存储和 AppKit 桥接
src-tauri/capabilities/ Tauri 窗口权限策略
docs/decisions/         架构决策记录
.github/workflows/      持续集成与受保护的 macOS 发布流程
```

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和
[行为准则](CODE_OF_CONDUCT.md)。任何新数据源都必须保持本地优先、最小权限和
明确标注来源的原则。

持续更新的范围与验证要求见[维护流程](docs/maintenance.md)和[变更记录](CHANGELOG.md)。

## 许可证

项目代码使用 [MIT License](LICENSE)。随应用分发的依赖归属和源码链接见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
