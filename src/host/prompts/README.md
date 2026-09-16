# prompts/ — 提示词平面导航

本目录集中存放**所有发给模型的文本**（与模型交互的提示词），按注入时机分五个子目录。新提示词按下面的判定顺序走一遍即有唯一归属；`runtime/`、`tools/`、`commands/` 只调用不定义提示词文本（依赖方向单向指向本目录）。

## 分类与判定

| 子目录 | 一句话定义 | 判定问句 |
|---|---|---|
| `system/` | systemPrompt section 文本：常驻段（captain / roleBuilder）+ 动态 band 文本组装（sessionPersona / sessionTeam / rootPrompt） | 这段文本会装进 systemPrompt 吗？ |
| `spawn/` | 子代理 / 成员出生时刻注入的提示词：子代理人格、阶段任务提示词、成员欢迎包 | 这段文本在 spawn / startContinuable 建会话那一刻随请求注入吗？ |
| `handoff/` | 任务流模板：指派、交接、汇报、婉拒、挂起、取消的邮件 / 通知文本 | 这段文本随任务流转投递吗？ |
| `personas/` | 人设框架与角色手册：框架字段渲染 / 合并、角色模板（ROLE_TEMPLATES）、领队 / 角色构建师预设、逐字角色手册（ROLE_DOCS） | 这段内容是人设数据或角色手册吗？ |
| `steering/` | 运行时中途发给模型的定向文本：steer、受理确认、快照 prompt | 以上都不是、运行时中途定向发给模型吗？ |

## 边界（不属于本目录的「像提示词的东西」）

- **工具 description 与工具结果 instruction 文本**（如 busy detail）：工具契约的一部分，随工具定义留在 `../tools/`。合同渲染**不在**此列——`renderContract` 是 handoff 模板、住在 `handoff/mails.ts`；`model/contract.ts` 只是旧四数组 → MD 的迁移合成助手（state/db、state/import 消费）。
- **邮件/唤醒投递封皮**（如 teamOps 的 `[来自 …]` 前缀包装、notifier 的传输层）与**磁盘文档渲染**（runtime/docs.ts 的 留言板.md / `<任务号>.纪要.md` 落盘）：传输/落盘层，不属提示词面。
- **人设的磁盘存取与快照查询**：状态属 runtime；本目录只收文本组装（纯函数），查表 / 读盘由 runtime 薄壳完成后传参进来。
- **命令 handler 内一次性 UX 文本**（busy 提示、降级 notice）：随 handler 留在 `../commands/`；可复用 / 契约性模型文本（如激活消息 buildActivationMessage）才进命令面文件。

## 现有文件速查

| 文件 | 内容 | 主要消费方 |
|---|---|---|
| system/captain.ts | 领队常驻段 CAPTAIN_SECTION_SHORT | host/index.ts（systemPrompt order 105） |
| system/roleBuilder.ts | 角色构建师常驻段 ROLE_BUILDER_SECTION、激活前缀 ACTIVATION_PREFIX | host/index.ts（order 106）、commands/eteam.ts |
| system/sessionPersona.ts | 角色接管 band 文本组装、neutralizeInterpolation | runtime/sessionPersona.ts 薄壳 |
| system/sessionTeam.ts | 团队绑定 band 文本组装 | runtime/sessionTeam.ts 薄壳 |
| system/rootPrompt.ts | 主对话注入 band 文本组装（角色库保留角色 system 的手册 MD 逐字嵌入，8000 字截断自述） | runtime/rootPrompt.ts 薄壳 |
| spawn/captainChild.ts | 领队子代理人格（含回合决策表，经 persona 系统段 + eteams_captain_guide 的 render 模型通道同文返回）+ 一句话回合提示词 captainTurnBrief（任务/现状/父会话等所需内容全部经规程与工具面获取；工作目录 / 任务目录按任务冻结，随提示词写明）+ 手册拼装 | tools/captainDispatch.ts、tools/captainTools.ts、runtime/captainAgent.ts |
| spawn/builderPhases.ts | 构建回合提示词（全相位同一句「身份 + 调 eteams_build_guide 领规程」+ 工作目录块（工作目录 / 构建状态目录）——任务/快照/父会话等所需内容全部经规程与工具面获取，docs/19.16 持续构建子代理） | runtime/builderPhases.ts |
| spawn/workDirs.ts | 子代理共用的工作目录块 workDirsBlock（工作目录 = 工程根 + 任务目录，宿主算好绝对路径下发，用户 2026-09-16 统一口径） | prompts/spawn（member / captainChild）、runtime |
| spawn/member.ts | 成员欢迎包（通用简报 memberBriefing：工作目录块（workDirsBlock）/队伍留言板/本任务纪要/文档目录 + 领队 + 三节点汇报 + 规则 + 工具表） | runtime/members.ts |
| handoff/mails.ts | 指派 / 汇报 / 婉拒 / 挂起 / 取消模板 | runtime/assignment.ts、runtime/members.ts、runtime/docs.ts、tools/memberTools.ts |
| personas/framework.ts | 人设框架（字段渲染 / 合并 / 摘要 / 回退执行提示） | state/、runtime/、prompts 内部 |
| personas/presets.ts | ROLE_TEMPLATES、PRESET_MEMBER_ROLES、defaultPersonaFor | runtime/roster.ts、runtime/teamOps.ts、state/import.ts |
| personas/captain.ts | 领队人设默认值 + 覆盖文件合成 | runtime/webui.ts、runtime/roster.ts、state/import.ts、tools/captainDispatch.ts、host/index.ts |
| personas/builder.ts | 角色构建师预设 + 持续构建子代理人格（构建纪律全文 = 回合决策表 + 可用接口清单，经 persona 系统段注入 + eteams_build_guide 的 render 模型通道同文返回；回合提示词只指路不复述） | runtime/builderPhases.ts、personas/presets.ts |
| personas/roleDocs.ts | ROLE_DOCS 逐字角色手册（scripts/gen-role-docs.cjs 生成） | personas/presets.ts、personas/builder.ts、personas/captain.ts |
| steering/askFallback.ts | 问答降级指引（degradeHint：不要重试弹窗，改以文本把问题连同推荐项问用户；文本提问同守提问口径——自包含/说人话/选项写清后果，口径全文在 tools/askUserTools.ts 的 eteams_ask_user description） | tools/askUserTools.ts |
| steering/dispatch.ts | dispatch 受理确认 + 面板完善指令（正文 captainCommissionMessage 随回合 sidecar 进 guide 快照；无领队主会话路径保留带自取现状指令的完整 prompt） | tools/captainDispatch.ts、runtime/webui.ts |