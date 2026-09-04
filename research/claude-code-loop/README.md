# Claude Code Agent Loop 深度研究（提示词管理 / 流程管理 / 架构）

研究对象：`C:\Users\epat\Downloads\Claude-Code-main`（Claude Code 源码快照），以
`src/query.ts`（主循环，约 1730 行）为中心，深入其背后全部支撑模块。研究日期：2026-09-04。

## 为什么做这件事

eTeam 是 DSH 插件：原始模型循环（流式采样、消息数组管理、prompt cache、compact）由宿主
持有，eTeam 拥有的是循环之上的编排层（领队/成员持续子代理、派发邮件与唤醒、任务状态机）。
要把编排层做得接近 Claude Code 的水准，需要弄清宿主循环在三个主题上各自的纪律——

1. **提示词管理**：系统提示如何组装、如何保缓存、上下文如何注入、压缩提示词怎么写；
2. **流程管理**：循环骨架、每轮输入的裁剪流水线、工具编排、压缩梯、恢复梯、消息队列；
3. **架构**：工具接口契约、注册表、deps/config 模式、子代理缓存共享、API 请求层。

然后回答一个问题：**eTeam 的编排协议层应该吸收哪些原则、改哪些文件、按什么顺序做**。

## 文档地图

| 文件 | 内容 | 读者 |
| --- | --- | --- |
| [01-prompt-management.md](01-prompt-management.md) | 系统提示分节与缓存边界、上下文注入、压缩提示词、提示词与压缩的配对、缓存纪律清单 | 想改 eTeam 人格/派发/交接文案的人 |
| [02-flow-management.md](02-flow-management.md) | 循环骨架与具名转移、消息裁剪流水线、工具编排与配对卫生、压缩梯、恢复梯、消息队列 | 想改 eTeam 唤醒/重试/状态机/守卫的人 |
| [03-architecture.md](03-architecture.md) | Tool 接口契约、工具注册表、deps/config 模式、fork 缓存共享、API 请求层 | 想改 eTeam 工具面/子代理装配的人 |
| [04-task-checklist.md](04-task-checklist.md) | **最终交付**：eTeam 编排层整体优化的任务与实施清单，分期（先必要后优化）+ 等级（P0–P3），含现状依据、改动点、验收标准 | 执行优化的人 |

四篇文档各自自含，不依赖彼此的行号或结论；04 的每一条都带自己的「现状 / 依据 / 动作 / 验收」，
可以单独拿去开工。

## 已读源码清单（证据基础）

通读（全文）：

- `src/query.ts` — 主循环与恢复梯（研究核心）
- `src/Tool.ts` — 工具接口契约与 buildTool 缺省值
- `src/tools.ts` — 工具注册表与装配
- `src/utils/systemPrompt.ts` — 系统提示优先级链
- `src/context.ts` — 用户/系统上下文的记忆化
- `src/utils/api.ts` — prependUserContext / appendSystemContext / splitSysPromptPrefix / 工具 schema 缓存
- `src/utils/messageQueueManager.ts` — 优先级消息队列
- `src/services/tools/StreamingToolExecutor.ts` — 流式工具执行器
- `src/services/tools/toolOrchestration.ts` — partitionToolCalls
- `src/services/compact/autoCompact.ts` — 主动压缩阈值与熔断
- `src/services/compact/prompt.ts` — 压缩提示词（9 节模板）
- `src/services/compact/microCompact.ts` — 微压缩（只回收工具结果）
- `src/services/api/claude.ts`（关键段）— 缓存断点、系统提示块、max_tokens
- `src/query/stopHooks.ts` — 停止钩子全套
- `src/query/deps.ts`、`src/query/config.ts`、`src/query/tokenBudget.ts`、`src/query/transitions.ts`
- `src/constants/prompts.ts` — 系统提示正文（分节原文）
- `src/constants/systemPromptSections.ts` — 分节注册表
- `src/tools.ts` 的全部注册逻辑
- `src/utils/forkedAgent.ts`（关键段）— fork 的 cacheSafeParams

抽查（结论采信处已注明行号或引文）：

- `src/utils/toolResultStorage.ts`、`src/services/compact/cachedMicrocompact.ts`（B 类机制）
- `src/tools/AgentTool/`（子代理装配）、`src/utils/attachments.ts`（附件包装，抽查 isMeta/system-reminder）

## 与 docs/37 的关系

docs/37（`docs/37-agent-loop-lessons.md`）是本研究的第一阶段成果（只分析 query.ts 单文件）；
本文件夹是第二阶段（全源码、三主题、落到清单）。04 清单已并入 37 中仍然成立的条目并
逐条核实了 eTeam 现状（2026-09-04 工作区状态），37 不再单独维护执行口径——执行以 04 为准。