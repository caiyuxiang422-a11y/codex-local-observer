# 0006：单项目驾驶舱与账户额度口径

## 状态

已接受（2026-08-26）

## 背景

早期页面同时展示任务、Git、测试、构建、里程碑、高级能力和九类便签指标。信息虽然完整，但首次打开时用户很难回答两个最基本的问题：当前选中的项目进行到哪里了，以及还能使用多少账户额度。

## 决策

主界面默认采用单项目驾驶舱：

- 一个可输入/选择的项目目录是唯一主上下文；切换目录时清空旧项目快照。
- 首屏只展示项目完成度、当前项目 Token、账户累计与窗口剩余，以及最近日 Token、运行中/最近失败/最近变化。
- 任务执行、Git、测试、构建和里程碑编辑保留在“高级工具与诊断”折叠区，不删除已有能力。
- 项目 Token 先尝试由官方 App Server 按当前目录精确匹配线程并汇总
  `threadUsage`；如果官方没有返回历史线程 usage，则回退到本工具启动且收到
  Codex JSONL Usage 的本地任务记录。两种来源不相加，缺字段保持未知。

账户信息通过 Codex CLI 的本地 App Server stdio JSON-RPC 适配器读取：

- 请求 `account/read`、`account/rateLimits/read`、`account/usage/read`。
- 不读取 `~/.codex/auth.json`、Cookie、桌面 UI 或其他客户端的私有存储。
- 账户卡片优先显示 `remainingPercent` 和 `resetsAt`；若接口返回 `credits.balance`，单独显示为 credits。
- 不把本地 Token 从假定的总额度中相减，也不把 credits 误称为 Token。
- 没有稳定的绝对总 Token 字段时显示未知，并提供官方 Usage Dashboard 作为核对入口。

项目用量的读取顺序和边界：

1. `thread/list` 使用规范化后的项目 `cwd`，最多读取 200 个线程，并记录是否有下一页。
2. 对匹配线程调用 `account/usage/read {threadId}`，只汇总官方返回的
   `threadUsage.groups`；`null`、空数组、超时和错误不会被当作 0。
3. 查询成功但历史 usage 不可回溯时，显示“已找到 N 个会话，但官方未返回历史
   Token”；传输或协议失败则显示“官方项目用量读取失败”。
4. 当前观察台启动的新任务仍会保存结构化 usage，因此可以从任务开始建立可验证
   的项目本地基线；它不能补回其他 Codex 客户端的历史计量。

## 原因

官方 App Server 文档定义了账户、rate-limit 窗口、重置时间和 Token 活动接口，但 rate-limit 响应不等于一个固定的 Token 总配额。把百分比强行换算成 Token 会造成虚假精确，尤其在不同模型、任务复杂度和套餐窗口并存时。

## 后果与后续

- 用户在一个屏幕内得到最常用的项目判断，低频诊断仍可展开。
- App Server 请求可能因未登录、网络或 CLI 版本差异返回 partial/unknown；UI 必须保留来源、时间和证据。
- 当前账号的实测结果是：项目目录可匹配到线程，但每个线程的 `threadUsage` 都为
  `null`。这是官方接口没有提供历史项目 Token 的证据，不是项目消耗为 0。
- 若未来官方提供稳定的绝对额度字段，应新增版本化解析和 fixture，再考虑显示“剩余 Token 数”。
- 若需要把账户快照也放进悬浮便签，应增加独立的低频 account metric，不能让便签每几秒启动一个 App Server 进程。

## 参考

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540)
- [Using Credits for Flexible Usage](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-free-go-plus-pro-sora)
