# 38 提示词与命令集中管理整改方案

> 用户指令：「现在项目和大模型交互时提示词太混乱了，到处都是，我希望有一个文件夹分类型管理起来，还有就是插件的命令也很混乱，也需要管理。你清查一下项目中用到的命令和提示词都合理进行存放和优化」。
> 本文是整改的设计合同：清查矩阵、目标结构、逐符号迁移映射、接线同步、分阶段执行与验收记录全部在此定稿；执行按 38.6 的阶段推进。
> **铁律：零行为变更。** 只做移动 / 改名 / 建目录 / 纯文本提纯（函数搬走但产出逐字不变）；唯一例外是删除确认全仓零引用的死代码 `captainProtocolFull`。每阶段跑四绿门（38.6）。
> 范围：`src/host/**` + `tests/`、`scripts/` 引用同步 + `src/client/lib/addPeople.ts` 注释互指。非目标：不动 `src/client/**` 结构（docs/32 已收口）、不建 shared 平面（docs/32 §32.11 已决策不引入 paths 别名，client/host 的命令模板副本各留并互指）、不搬工具 description（工具契约随工具定义留在 `tools/`）。
> 绿基线（2026-09-04 实测）：`pnpm typecheck` / `pnpm lint` / `pnpm test`（281 passed）/ `pnpm build` 全绿；lint 有 5 条历史 error（「数据库引入」提交遗留）已按零行为原则先修复后开工。

## 38.1 清查矩阵

### A. 提示词散布点（模型注入文本散落在 prompts/ 之外）

| # | 现位置 | 内容 | 性质 |
|---|---|---|---|
| 1 | `runtime/builderPhases.ts` `buildPhasePrompt` | 角色构建阶段 start/continue/restart/resume 全部阶段提示词（约 65 行文本） | 子代理阶段任务提示词 |
| 2 | `runtime/sessionPersona.ts` `sessionPersonaSection` | 【eteams 角色接管·生效中】band 全文 | 动态 systemPrompt 段 |
| 3 | `runtime/sessionTeam.ts` `sessionTeamSection` | 【eteams 团队绑定·生效中/失效】band 全文 | 动态 systemPrompt 段 |
| 4 | `tools/captainTools.ts` `interviewSteerText` | 访谈发布后唤醒主对话的 steer 全文 | 运行时 steer 文本 |
| 5 | `tools/captainDispatch.ts` `dispatchAck` + 【团队现状】快照组装 | dispatch 受理确认 + 领队子代理首轮 prompt 组装 | 运行时 steer/prompt 文本 |
| 6 | `runtime/assignment.ts` `notifyMemberSuspended/CancelledInTx` | 【挂起】【取消】成员通知文本 | 任务流通知模板 |
| 7 | 回退执行提示 `你是「…」，以 X 的身份为团队交付。` 共 5 处：`prompts/persona.ts:135`、`runtime/roster.ts:107`、`state/db.ts:499`、`state/import.ts:241`（四处同形）、`runtime/members.ts:103`（变体「以团队成员身份」，无空格无「的」，原样保留不并入） | 同一提示词多处重复 |
| 8 | `index.ts` /eteam handler 内 | busy steer、激活降级 notice 文本 | 命令面一次性文本（随 handler 留在 commands/，见 38.3 判定规则） |

### B. prompts/ 现状：6 文件混型

`captain.ts`（常驻段 + 子代理人格 + 死代码）、`member.ts`、`persona.ts`（框架逻辑 + 角色模板 + 领队人设 + YAML 解析同居）、`roleBuilder.ts`（系统段 + 预设 + 子代理人格 + 命令常量 + 激活消息五种身份同居）、`handoff.ts`、`roleDocs.ts`。类型不可从路径判断。

### C. 命令散布点

| # | 现位置 | 内容 |
|---|---|---|
| 1 | `index.ts` apply() 内 | `/eteam` CommandDefinition + 约 115 行 handler 内联；`ctx.inject(['commands'])` 注册壳内联 |
| 2 | `prompts/roleBuilder.ts` | `ADD_PEOPLE_COMMAND`、`ACTIVATION_PREFIX`、`ADD_PEOPLE_BARE_BODY`、`buildActivationMessage`（命令契约混在提示词文件里） |
| 3 | `index.ts` 命令 hint | `--add-people 我需要创建一个成员…` 与 `ADD_PEOPLE_BARE_BODY` 重复书写 |
| 4 | `client/lib/addPeople.ts` | 客户端预填模板副本（平面隔离无法共享，互指注释对齐） |

### D. 死代码 / 重复

- `prompts/captain.ts` `captainProtocolFull` — 全仓零引用（docs/26 领队子代理重构后遗留），删除。
- A#7 回退执行提示共 5 处：四处同形（persona/roster/db/import）统一为一个 helper（输出逐字不变）；`runtime/members.ts:103` 变体「以团队成员身份为团队交付」形态不同，**原样保留**（不强行统一，否则违反零行为铁律）。
- `prompts/roleBuilder.ts` 与 `client/lib/addPeople.ts` 命令模板重复：各留副本、互加指向注释。

## 38.2 目标结构

```
src/host/
  commands/                        # 插件命令平面（斜杠命令）
    index.ts                       # registerCommands(ctx, config, log)——唯一注册入口
    eteam.ts                       # /eteam 定义 + handler + buildActivationMessage + 命令面文本
  prompts/                         # 提示词平面：所有发给模型的文本，按类型分五个子目录
    README.md                      # 分类导航（每类一句话定义 + 判定规则）
    system/                        # systemPrompt section 文本（常驻段 + 动态 band 文本组装）
      captain.ts                   # CAPTAIN_SECTION_SHORT
      roleBuilder.ts               # ROLE_BUILDER_SECTION、ACTIVATION_PREFIX
      sessionPersona.ts            # 角色接管 band 文本组装（纯函数）+ neutralizeInterpolation
      sessionTeam.ts               # 团队绑定 band 文本组装（纯函数）
    spawn/                         # 子代理/成员出生时刻注入的提示词
      captainChild.ts              # CAPTAIN_CHILD_PERSONA、captainChildPersona
      builderPhases.ts             # builderPhasePrompt(kind, snapshot)——阶段文本纯函数
      member.ts                    # memberWelcome、MEMBER_RULES、MEMBER_TOOL_SHEET
    handoff/                       # 任务流模板（指派/交接/汇报/婉拒/挂起/取消）
      mails.ts                     # renderContract、assignmentMail、reportCompleted/Failed、decline、suspendedNotice、cancelledNotice
    personas/                      # 人设框架与角色手册
      framework.ts                 # PERSONA_FRAMEWORK_VERSION、PERSONA_BASELINE_RULES、渲染/合并、personaDigest、fallbackExecutionPrompt
      presets.ts                   # RoleTemplate、ROLE_TEMPLATES、PRESET_MEMBER_ROLES、ROLE_BUILDER_NAME、defaultPersonaFor
      captain.ts                   # defaultCaptainPersona、composeCaptainPersona、parsePersonaYaml
      builder.ts                   # ROLE_BUILDER_PRESET、ROLE_BUILDER_CHILD_PERSONA、ROLE_BUILDER_SPEC_TAIL
      roleDocs.ts                  # ROLE_DOCS（脚本生成物）
    steering/                      # 运行时 steer / 受理确认 / 快照 prompt 文本
      interview.ts                 # interviewSteerText
      dispatch.ts                  # dispatchAck、captainDispatchPrompt
```

### 分类判定规则（prompts/README.md 的内容，自含）

- 装进 systemPrompt 的段 / band 文本 → `system/`
- 子代理/成员被创建（spawn / startContinuable）那一刻随请求注入的提示词 → `spawn/`
- 任务指派、交接、汇报、婉拒、挂起、取消等任务流邮件 / 通知文本 → `handoff/`
- 成员人设字段、角色模板、逐字角色手册 → `personas/`
- 其余运行时中途发给模型的定向文本（steer、受理确认、快照 prompt）→ `steering/`
- 工具 description 与**工具结果 instruction 文本**（busy detail、contract 渲染等）是工具契约的一部分，随工具定义留在 `tools/`，不搬。
- **邮件/唤醒投递封皮**（如 teamOps 的 `[来自 …]` 前缀包装、notifier 的传输层）与**磁盘文档渲染**（runtime/docs.ts 的 notes.md 落盘）不属提示词面。
- 命令 handler 内一次性 UX 文本随 handler 留在 `commands/`；可复用 / 契约性模型文本（如激活消息 buildActivationMessage）进命令面文件，其常量与提示词段共享单一来源。
- 依赖方向：`runtime/` `tools/` `commands/` → `prompts/` 单向；`prompts/` 不 import runtime 状态（band 文本组装是纯函数，查表/读盘由 runtime 薄壳完成后传参）。

## 38.3 迁移映射（逐符号）

| 符号 | 现位置 | 新位置 |
|---|---|---|
| `CAPTAIN_SECTION_SHORT` | prompts/captain.ts | prompts/system/captain.ts |
| `captainProtocolFull` | prompts/captain.ts | **删除**（零引用） |
| `CAPTAIN_CHILD_PERSONA`、`captainChildPersona` | prompts/captain.ts | prompts/spawn/captainChild.ts |
| `MEMBER_RULES`、`MEMBER_TOOL_SHEET`、`memberWelcome` | prompts/member.ts | prompts/spawn/member.ts |
| `PERSONA_FRAMEWORK_VERSION`、`PERSONA_BASELINE_RULES`、`renderPersonaBlock`、`mergePersona`、`personaDigest` | prompts/persona.ts | prompts/personas/framework.ts |
| `RoleTemplate`、`ROLE_TEMPLATES`、`PRESET_MEMBER_ROLES`、`ROLE_BUILDER_NAME`、`defaultPersonaFor`、`GENERIC_TEMPLATE` | prompts/persona.ts | prompts/personas/presets.ts |
| `defaultCaptainPersona`、`parsePersonaYaml`、`composeCaptainPersona` | prompts/persona.ts | prompts/personas/captain.ts |
| `ROLE_BUILDER_PRESET`、`ROLE_BUILDER_CHILD_PERSONA`、`ROLE_BUILDER_SPEC_TAIL` | prompts/roleBuilder.ts | prompts/personas/builder.ts |
| `ROLE_BUILDER_SECTION`、`ACTIVATION_PREFIX` | prompts/roleBuilder.ts | prompts/system/roleBuilder.ts |
| `ROLE_DOCS` | prompts/roleDocs.ts | prompts/personas/roleDocs.ts |
| `renderContract`、`assignmentMail`、`reportCompletedMail`、`reportFailedMail`、`declineMail` | prompts/handoff.ts | prompts/handoff/mails.ts |
| `buildPhasePrompt` | runtime/builderPhases.ts | prompts/spawn/builderPhases.ts，签名改 `builderPhasePrompt(kind, snapshot)` 纯函数：快照为**自足结构化类型**（prompts 内定义，不 import runtime 类型），runtime 读盘（`readBuildSession` 的 null 映射成字段 undefined，保留「（缺失）」快照行与 start 分支空串两种缺省语义）；`BuildPhaseKind` 类型随迁；`spawnBuildPhase` 对外签名不变（内部读盘后传快照），三个调用方零改动 |
| `sessionPersonaSection` 文本部分 | runtime/sessionPersona.ts | 纯函数组装迁 prompts/system/sessionPersona.ts；runtime 留 store + 薄壳（查 Map → 委托），对外签名不变 |
| `sessionTeamSection` 文本部分 | runtime/sessionTeam.ts | 同上；runtime 留 bindings store + 薄壳 |
| `neutralizeInterpolation` | runtime/sessionPersona.ts | prompts/system/sessionPersona.ts（提示词装配保护属提示词面）；runtime/sessionPersona.ts re-export——全仓唯一导入方 sessionTeam.ts 本次自身改写，re-export 属**预防性保 API** |
| `sessionTeamSection` 分支入参 | runtime/sessionTeam.ts | band 纯函数收**判别联合**：`{kind:'dead', name}` / `{kind:'live', name, taskCount}`；`captainChildTeamOf` 注册表守卫留 runtime 薄壳（tests/sessionTeam 依赖） |
| `interviewSteerText` | tools/captainTools.ts | prompts/steering/interview.ts |
| `dispatchAck`、【团队现状】prompt 组装 | tools/captainDispatch.ts | prompts/steering/dispatch.ts（新增 `captainDispatchPrompt(teamViewJson, message)`） |
| 挂起/取消通知文本 | runtime/assignment.ts | prompts/handoff/mails.ts 新增 `suspendedNotice(task, note?)`、`cancelledNotice(task, reason?)` |
| 回退执行提示（×5，4 同形 + members 变体） | persona.ts:135 / roster.ts:107 / db.ts:499 / import.ts:241 / members.ts:103 | personas/framework.ts 新增 `fallbackExecutionPrompt(name, role)`；roster / db / import / defaultPersonaFor（`role \|\| 'member'`）四处改调 helper（输出逐字不变）；members.ts:103 变体**原样保留** |
| `SessionPersona` 接口 | runtime/sessionPersona.ts | 一并迁 prompts/system/sessionPersona.ts（band 纯函数与提示词面共用）；runtime/sessionPersona.ts re-export type 保 API |
| `/eteam` 定义 + handler + busy/notice 文本 | index.ts | commands/eteam.ts；hint 改由 `ADD_PEOPLE_BARE_BODY` 常量拼接 |
| `ctx.inject(['commands'])` 注册壳 | index.ts | commands/index.ts `registerCommands(ctx, config, log)`，apply() 一行调用 |
| `ADD_PEOPLE_COMMAND`、`ADD_PEOPLE_BARE_BODY`、`buildActivationMessage` | prompts/roleBuilder.ts | commands/eteam.ts |
| `ADD_PEOPLE_TEMPLATE` | client/lib/addPeople.ts | 不动（平面隔离），加互指注释 |

## 38.4 接线同步

- import 改写：`index.ts`、`runtime/`（assignment / builderPhases / docs / members / roster / teamOps / webui）、`tools/`（captainDispatch / captainTools / memberTools）、`state/`（db / import 引 `PERSONA_FRAMEWORK_VERSION`）按 38.3 改路径；prompts 内部互引同步（host 内 `.js` 后缀惯例不变）。
- runtime 薄壳保签名：`sessionPersonaSection` / `sessionTeamSection` 对外签名与行为不变，tests/sessionPersona、sessionTeam、usage、workspaces 零改动。
- 测试同步：`tests/roleBuilder.test.ts`（CAPTAIN_SECTION_SHORT→system/captain；buildActivationMessage→commands/eteam；ROLE_BUILDER_PRESET→personas/builder；ROLE_BUILDER_SECTION→system/roleBuilder；PRESET_MEMBER_ROLES/ROLE_TEMPLATES→personas/presets）、`tests/captainDispatch.test.ts`（captainChildPersona→spawn/captainChild；composeCaptainPersona→personas/captain）、`tests/webui.test.ts`（renderPersonaBlock→personas/framework）。
- 脚本同步：`scripts/gen-role-docs.cjs` 输出路径与 @module 注释改 `prompts/personas/roleDocs.ts`。
- 构建：tsdown 入口不变，`lib/types` 由 build 重生成。

## 38.4.1 执行阶段（四绿门 = `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build`）

1. **建骨架**：建 `commands/` 与 `prompts/{system,spawn,handoff,personas,steering}/`、prompts/README.md。
2. **prompts 归位**：personas → spawn → handoff → system → steering 五批小步迁移，每批改 import 后跑 typecheck + test，阶段末跑四绿门；同步 scripts 与 tests。
3. **纯文本提纯**：buildPhasePrompt 纯函数化、session band 薄壳化、fallbackExecutionPrompt 统一、挂起/取消文本迁出。
4. **命令收编**：index.ts 命令段整体迁 commands/，hint 常量化。
5. **收尾**：删死代码、互指注释、全仓 grep 收口；陈旧指向同步——state/db.ts:430 注释（renderPersonaBlock 新址）、prompts/captain.ts 文件头（删 `captainProtocolFull` 后失实）、scripts/gen-role-docs.cjs:66 硬编码绝对路径改相对推导。

长中文重的文件用小步 Edit 逐段搬移，不做整文件 Write。

## 38.5 验收记录

执行日期 2026-09-04。按 38.4.1 分批小步迁移，每批跑 typecheck + test，阶段末跑全量四绿门。

**四绿门结果（最终全量）**：

- `pnpm typecheck` ✓（host + client 两个 tsconfig 均无错）
- `pnpm lint` ✓ 0 error（仅存 2 条 react-hooks warning，整改前即有、与本整改无关）
- `pnpm test` ✓ 281/281（vitest 23 个文件；基线即为 281，零测试改动断言、只改 import 路径）
- `pnpm build` ✓（SMOKE OK: id=dsh-eteams, exports=[apply, inject]）

**体积对拍**：client bundle 5,347,542 字节（基线 5,347,929，−387）；host bundle 444,097 字节（基线 436,265，**+7,832**）。host 增量来自新模块的文件头/接线注释——tsdown 产物保留注释，属结构性增量；用关键提示词标记逐字计数核验无内容重复（`agency-agents-zh 单文件规格` ×3、`【eteams 角色接管·生效中】` ×1、`【eteams 团队绑定·生效中】` ×1，与源码出现点一一对应）。

**收口 grep**：`src|tests|scripts|.fmt-check.ts` 下旧路径 `prompts/{persona,captain,roleBuilder,handoff,member,roleDocs}` 零命中；`buildPhasePrompt` / `captainProtocolFull` 旧定义零命中，`dispatchAck` / `interviewSteerText` 仅在 prompts/steering/ 新址定义。

**基线备注**：整改开始时仓库基线即有 5 条 lint error（「数据库引入」提交遗留），已按零行为原则先修复后开工（members.ts 去 unused import、teamOps.ts 去 unused type、webui.ts 删 unused `stationProgress` 行、db.ts 构造器断言改写、tests/support/tmpWorkspace.ts 拆 value/type import）。

**执行偏差**（均不改变对外行为，逐条记录）：

1. `captainProtocolFull` 删除时机与文件同批：prompts/captain.ts 拆分时该死代码未迁入任何新文件，随旧文件删除（零引用已复核）。
2. `sessionPersonaBand`（prompts/system/sessionPersona.ts）内部自行调用 `neutralizeInterpolation`，而非要求 runtime 薄壳先 neutralize 字段再传参——语义逐字等价、防护不可被调用方遗忘；`sessionTeamBand` 同（判别联合两分支名各自 neutralize）。
3. `runtime/builderPhases.ts` 快照投影为显式字段映射（request/stepsDone/draft/interview 四字段），而非整体透传 `BuildSession`——38.3 的「自足快照」落地形式；读盘时机保持在原 `buildPhasePrompt` 内读盘点（spawn 前一刻），行为不变。
4. `BuildPhaseKind` 类型在 prompts/spawn/builderPhases.ts 定义，runtime/builderPhases.ts `export type` 转出口保持既有导入面。
5. handler 迁移时 `/eteam` 的 `hint` 由 `ADD_PEOPLE_BARE_BODY` 常量拼接（消除重复字面量，拼接结果与原字面量逐字一致）；handler/命令 UX 文本（busy/IO 竞态/降级 notice）随 handler 留 commands/eteam.ts，原样未动。
6. `.fmt-check.ts`（仓库根的格式巡检脚本）内一处 `renderPersonaBlock` 动态 import 同步改指 personas/framework——清查矩阵 A 表未列，属收口 grep 发现的漏网点，已并入。
7. scripts/gen-role-docs.cjs 输出路径由硬编码绝对路径改为按脚本位置相对推导（`__dirname/../src/host/prompts/personas/roleDocs.ts`），@module 注释同步。