# 33 结构整改审核报告（docs/32）

- 审核对象：[32 项目结构整改方案](32-restructure-plan.md)（2026-09-04 产出）。
- 审核方法：只读代码与文档，未改动任何源码/配置/既有文档（本文是唯一产出）。对 32.5.1 映射表做的是**全量核对而非抽样**：实测 `eteamsView.tsx` 全部顶层声明（110 个，含 1 个 `let`）的每一处引用行，按映射表目标文件划区（声明行分界、剔除注释行）计算每个符号「拆分后跨文件消费方集合」，另对约 35 个关键判定行逐行人读复核；对 32.6 的文件迁移/测试/脚本/构建接线逐文件 grep 实测（`tsconfig.*.json`、`tsdown.config.ts`、`tailwind.config.ts`、`eslint.config.mjs`、`vitest.config.ts`、`package.json`、`cordis.patch.yml`、`scripts/*` 共 14 个脚本全部过目）；对 32.5.3 七个批次逐批做批末依赖图校验与批间时序推演；store/dva、`refreshActivitySoon`、垫片、`lib/client.js` 体积（实测 5223 KB 相符）逐项回查。
- 严重度：**阻塞** = 不修订会做出错误实现或与基线矛盾；**建议** = 开工前修订成本低、收益明确；**备忘** = 已核实、需留意的瑕疵或执行提示。

---

## 一、总体结论

**需修订后执行**（阻塞 3 · 建议 7 · 备忘 9）。

主体判定质量高：映射表 109 个已列符号的落位判定逐符号核对**零断链错误**（仅 4 个符号违反方案自身的「唯一消费方落该文件」规则，见 32-S1）；按映射表构建的页内文件依赖图实测**无环**（28 条边全部单向）；「构建接线只有 buildTailwind.mjs 1 行 + components.json」的结论逐文件核实**成立**；测试 12 文件、脚本 3 处同步清单与实测**完全一致**；批次算术与实测行段吻合。三个阻塞项全部是「执行底稿与实况的偏差」（漏 1 个符号、漏 1 个消费方、1 处措辞矛盾），修订成本都是文档级几行，不动方案骨架。

## 二、审核清单逐项结论

| # | 清单项 | 结论 |
|---|---|---|
| 1 | 拆分映射表逐符号核验 | **有问题**：漏 1 个顶层符号（32-B1）；4 个「唯一消费方」符号落 shared 违反自身规则（32-S1）；其余 105 个符号判定全部正确，依赖图无环（3.2） |
| 2 | 批次划分可执行性 | **有问题**：批 2 的 eteamsView 旧引用同步已覆盖（STATUS_GROUPS 唯一真实消费方在 tasksTab，批 2 时仍在 eteamsView 内，改 import 即可）；批间无依赖倒置；但批 5/批 6 的批内子步顺序与「先被依赖后消费方」原则矛盾（32-S2），且批 2 的同步范围漏列 shared.tsx（32-M8） |
| 3 | 构建接线核验 | **通过**：逐文件核实「天然透明」结论成立，buildTailwind.mjs 恰 1 行（L129）、components.json 实际需改 3 个字段值 + `$comment`（32-S5 只处数口径问题） |
| 4 | 测试导入同步清单 | **通过**：tests/ 共 23 文件 = 12 客户端 + 11 仅 host，与 32.6.2 完全一致；无任何测试 import eteamsView 符号（映射表无需覆盖测试面） |
| 5 | dva store 与运行时时序 | **通过（措辞矛盾一处）**：model 注册经 `store/models/index.ts` 聚合（store/models/index.ts:29-32）+ `app.ts` create→model()→start()（store/app.ts:37-42），store 文件不搬迁即时序不变；但 R2「批内不改 store 内部任何 import」与实况矛盾（32-B3）。`refreshActivitySoon` 留 lib/monitor 判定成立：拆分后消费方是 index（1059）/teamTab（1547-1739）/teamMembers（2764-2786）三个文件，各自 `../../lib/monitor` import，无新耦合 |
| 6 | 目录判定决策树自洽性 | **有问题**：9 步序无两条规则同时命中的文件（33 文件逐个走树唯一落点）；唯一漏洞是树缺「入口 index.tsx」规则（32-S6）。card.tsx → pages/eteamsCard.tsx 改名理由成立：唯一消费方 index.tsx:32（`installCard`），裸 card 与 components/ui/card.tsx 撞名且无独立文档线（不属 features） |
| 7 | 需求覆盖度 | **基本覆盖**：组件/页面/shims 归属全解决；css 归属覆盖但「eteams.css 保持单文件」未显式落笔（32-S7，见 四） |
| 8 | 风险与回滚 | **通过（备忘两处）**：每批独立 commit + revert 回滚可执行；bundle 台账预期 ≈0 可信（模块图等价重组，entry/虚拟模块/external/content 全不变，基线 5223 KB 实测相符）；提交信息格式与用户习惯不一致（32-M7）；收口断言一处必假失败（32-S4） |

## 三、逐项问题

### 3.1 问题表

| # | 严重度 | 问题 | 证据 | 修法 |
|---|---|---|---|---|
| 32-B1 | 阻塞 | **32.5.1 映射表漏顶层符号 `usageStylesInjected`**。实测 eteamsView.tsx 顶层声明 **110 个**（含唯一的模块级 `let`），表覆盖 109；32.1/32.5.1 的「109 个全覆盖」随之失准。该符号是 usage calendar 样式注入的幂等标志，`ensureUsageCalendarStyles` 直接消费；usageCalendar 行的符号区间（1210–1453）虽整段连续、整段搬运会自然带上它，但方案合同是「下表即执行底稿」逐符号搬迁，漏项即断链 | src/client/eteamsView.tsx:1224（`let usageStylesInjected = false;`）、1233-1235（消费） | 32.5.1 usageCalendar 行补 `usageStylesInjected`（跟 ensureUsageCalendarStyles 同文件整段搬）；「109 个」两处改「110 个」 |
| 32-B2 | 阻塞 | **32.6.1 api.ts 行漏消费方 `buildCard.tsx`**。buildCard 阶段 1 迁 pages/ 后其 `./api` 必须同步为 `../lib/api`；按 32.6.1 清单同步会漏掉它，阶段 1 结束 typecheck 必红（门能拦下，但这是执行底稿缺口，且会浪费一轮「四绿不过即停」的排查） | src/client/buildCard.tsx:24（`import { fetchBuildState, type BuildSession } from './api'`）；32.2 矩阵正确列了 buildCard，32.6.1 丢失 | 32.6.1 api 行消费方补 buildCard |
| 32-B3 | 阻塞 | **R2 缓解措施与 32.6.1 直接矛盾**。R2 写「store/ 目录本轮不动；**批内不改 store 内部任何 import**」，但 store 四个文件都 import 被迁模块、必须同步改相对路径——32.6.1 的 diagnostics/api/monitor 三行也如实把这些列为需同步消费方。两处必有一处误导执行者 | src/client/store/app.ts:12-13（`../diagnostics`、type `../monitor`）、store/models/build.ts:32 与 roster.ts:26（`../../api`）、store/models/activity.ts:10（type `../../monitor`）；docs/32:370（R2） | R2 措辞改为「store/ 的文件不搬迁、model 注册结构与聚合顺序零改动（D19e）；store 内对被迁模块（diagnostics/monitor/api）的相对 import 随迁移同步改路径（32.6.1 已列）」 |
| 32-S1 | 建议 | **shared.tsx 四个符号违反方案自身的「唯一真实消费方落该文件」规则**：`ROLE_BUILDER_NAME`（唯一消费方 addMembersDialog）、`PROTECTED_MEMBERS`（membersTab ×3）、`memberRank`（membersTab）、`ROLE_LIST_CSS`（唯一真实消费方 index；membersTab:4447 是注释级提及）。不落位断裂、无编译影响，但「按读码核实的判定表」自述与实况不符 | src/client/eteamsView.tsx:3004、3548/4264/4451、3417、915 vs 4447（注释） | 二选一：① 四符号改落其唯一消费方文件；② 在 32.5.2 补一条明示例外（推荐：「领队/保护成员领域常量族整族同居 shared——PROTECTED_MEMBERS 字面引用 LEADER_NAME/ROLE_BUILDER_NAME，拆家反而破坏族内聚」；ROLE_LIST_CSS 亦可循同款写法说明「样式注入点在 index、选择器服务多 tab」）。与 tone 族例外同款写法，一处补齐 |
| 32-S2 | 建议 | **批 5/批 6 批内子步顺序与自述原则矛盾**。批 5 顺序 modelRoutePicker→teamMembers→addMembersDialog→buildDraft→teamTab，但 teamMembers→buildDraft 有真实依赖（HandbookSource@2713、handbookSeed@2748）；批 6 顺序 membersTab→memberDialog→reportsTab，但 membersTab→memberDialog（@4383）。批末状态无环、四绿成立；但若执行者批内分子步推进（先迁 teamMembers 时 buildDraft 仍在 eteamsView），会造出 teamMembers→eteamsView 临时反向 import，与仍在 eteamsView 的 TeamTab→LeaderCard（@2039）正向 import 成环——正是 R1 要防的形态 | docs/32:234-235；src/client/eteamsView.tsx:2713/2748/4383 | 批 5 改为 modelRoutePicker→buildDraft→teamMembers→addMembersDialog→teamTab；批 6 改为 memberDialog→membersTab→reportsTab；或批次说明写明「批内子步不单独跑门，以批末状态为准」 |
| 32-S3 | 建议 | **阶段 1 的约 20 个文件级迁移没有批次/commit 粒度**。32.5.3 的「四绿门 + 独立 commit + revert 回滚」合同只覆盖 eteamsView 符号批次（0–7）；阶段 1 混入 lib/hooks/types/styles/features 四域/pages 五文件迁移 + tests/scripts 同步，四绿门只挂在批 1/批 2 末与阶段末。「回滚 = revert 阶段提交序列」对一锅炖的阶段 1 粒度过粗（回滚会连 shared.tsx/STATUS_GROUPS 一起退） | docs/32:349 | 阶段 1 显式拆 3 个 commit：① 纯文件移动 + 消费方/测试/脚本 import 同步；② 批 1 shared.tsx；③ 批 2 features/tasks 归位 + STATUS_GROUPS 上浮；每 commit 后跑四绿 |
| 32-S4 | 建议 | **32.8.1 收口断言一处必假失败、grep 清单不完整**。① `ls src/client/ \| wc -l 期望 1`：执行后根目录是 index.tsx + lib/hooks/components/store/features/pages/styles/types 共 9 项（`ls` 连目录一起数），断言对正确执行报失败；② 收口 grep 只列 eteamsView/api/monitor/cn/bridge/diagnostics 六个旧名，漏 addPeople/modelCatalog/phaseLabels/versionLabel/tailwind/useHostDark/avatar\*/backdropEngine/eteamsBackdrop/mdEditor/taskAssign\* 及改名后的 `from './card'` | docs/32:358-360 | ① 改 `ls -p src/client \| grep -v / \| wc -l`（期望 1）；② grep 补全旧名清单（typecheck+build 会兜住断链，grep 是辅助线，但清单应与 32.6.1 的迁移面对齐） |
| 32-S5 | 建议 | **components.json 改动处数三处口径不一**：32.6.4 结论行「5 处字段」、该行内「改 4 处」、32.8 阶段 3「components.json 5 处」。实测需改 **3 个字段值**（tailwind.css→src/client/styles/eteams.css、aliases.utils→src/client/lib/cn、aliases.lib→src/client/lib）；aliases.hooks 现值本就是 src/client/hooks（建 hooks/ 后即成真，值不改）；components/ui 两 alias 不动；`$comment` 改写另计 | docs/32:322、329、351；components.json（实测现值） | 三处统一为「改 3 个字段值 + `$comment` 改写」 |
| 32-S6 | 建议 | **32.3.1 判定决策树缺「入口」规则**。树的 9 步没有一条命中 index.tsx（apply/槽位注册），按字面会落到第 8 步 lib/；32.3.2 规则表有 index 专属行但树无对应问项。判定树的卖点是「新文件走一遍即有唯一答案」，自身应闭环 | docs/32:71-81 vs 87 | 决策树加第 0 步「是不是根入口 index.tsx？→ 保持根目录（tsdown 入口，全仓唯一）」 |
| 32-S7 | 建议 | **eteams.css「保持单文件、不 per-feature 拆分」未显式落笔**。用户原话点名 css 归属；方案把 eteams.css 归 styles/（32.2/32.4），但对「单文件 vs per-feature」没有一句论证。实测该文件（221 行）内容是 @layer base 全表面共享 token 桥（亮暗双块）+ mini-preflight 作用域基线 + @tailwind 三指令——它是唯一 Tailwind 输入，天然单文件，没有 per-feature 拆分面（feature 私有运行时样式本就随各自文件注入：mdEditor ensureMdxStyles、usageCalendar ensureUsageCalendarStyles） | src/client/eteams.css:1-221；docs/32:95（styles 规则未表态拆分） | 32.3.2 styles 行或 32.4 要点补一句「eteams.css 保持单文件：承载全表面共享的 token 桥/作用域基线，非任何单页面样式；页面/feature 私有运行时样式随其宿主文件注入（既有形态）」 |
| 32-M1 | 备忘 | `pillClass` 当前**零真实调用位**（仅注释 229/257 与定义 413）——基线即死代码。「零行为变更」铁律下随族迁 shared.tsx 原样保留，勿顺手删除；删除是后续独立清理项 | src/client/eteamsView.tsx:229,257,413 | 执行时不删不改；可在 32.10 记一笔后续清理候选 |
| 32-M2 | 备忘 | R1 引证的交叉类型对不上：`SlotDraft/TaskEditTarget` 实测**无跨文件引用**（4520/4527 定义、4555/4558 均在 TasksTab 域内），taskDrawer 域不引用。真正需要跨文件 `import type` 的是 membersTab→`DraftEdit`（@3430）与 teamMembers→`HandbookSource`（@2713）。tsconfig.base.json:15 `verbatimModuleSyntax: true` + eslint `consistent-type-imports` 会强制这些用 type-only import（否则 TS1484/编译报错，四绿门立即暴露） | src/client/eteamsView.tsx:4520-4558、3430、2713；tsconfig.base.json:15；eslint.config.mjs（consistent-type-imports） | R1 的例子换成 DraftEdit/HandbookSource；拆分时跨文件类型一律 `import type` 或内联 `type` 修饰 |
| 32-M3 | 备忘 | 消费方计数噪音三处（多列/计数偏差，不产生断链）：① 32.6.1 bridge 行多列 teamsButton——teamsButton 实际不 import bridge（teamsButton.tsx:63-82 无此项）；② diagnostics「8 个消费方」实为 10（index、card、buildCard、teamsButton、teamsPanel、heroTeamsButton、eteamsBackdrop、mdEditor、eteamsView、store/app）；③ 32.2 cn 行「components/ui 全部 15 个」实为 13 个 tsx（portal.ts 与 lucide-icon.d.ts 不 import cn） | src/client/teamsButton.tsx:63-82；src/client/components/ui/*（grep `'../cn'`） | 执行按 grep 实测逐文件改 import，不依赖文档里的计数；顺手把三处计数改准 |
| 32-M4 | 备忘 | 32.5.2 tone 族说明「pillClass/dotClass/Pill/PILL_*（memberDialog/teamTab/tasksTab 多消费）」中 memberDialog 不在 pill 族消费面（它只用 MUTED_CLASS）；Pill 真实消费方是 tasksTab/teamMembers/membersTab，dotClass 是 teamTab/tasksTab。「整族进 shared」的结论不受影响 | src/client/eteamsView.tsx:465/477（Pill）、2006/4657/4798（dotClass） | 顺手改准消费方列举 |
| 32-M5 | 备忘 | tsdown.config.ts 注释「见 src/client/eteamsView.tsx 的 Token 消耗卡片」在批 3 后过时；32.10 文档回写清单未收录 tsdown.config.ts | tsdown.config.ts（usageTooltipsCssInline docstring） | 32.10 补一行：阶段 3 顺带更新该注释为 usageCalendar.tsx 新路径 |
| 32-M6 | 备忘 | 32.5.1 依赖方向图把 addMembersDialog→buildDraft 列为边（「addMembersDialog / membersTab / teamMembers → buildDraft」），实测 addMembersDialog 无 buildDraft 引用——多余无害边 | src/client/eteamsView.tsx:2907-3190（AddMembersDialog/StepButtons 域内无 buildDraft 符号） | 顺手从图里去掉，保持「图=执行底稿」的可信度 |
| 32-M7 | 备忘 | 提交信息格式 `refactor(structure): 批次主题` 与用户既有习惯（纯中文短句，如「架构调整」「优化团队流程」）不一致。回滚语义不受影响，但提交历史风格突变 | git log（c1e0a95 等近五条） | 执行前与用户确认口径：沿用用户短句风格（如「结构整改：批 N 共享层下沉」）或保留 conventional 前缀 |
| 32-M8 | 备忘 | 批 2 的同步范围只写「eteamsView 改 import」，还应包括：批 1 产出的 shared.tsx 对 taskDisplayStatus 的 import 改写（`../../taskDisplayStatus`→`../../features/tasks/taskDisplayStatus`）、被迁文件自身的出向 import 改写（taskAssign.tsx 的 `./api`→`../../lib/api`、`./avatar`→`../features/avatar/avatar`、`./monitor`→`../../lib/monitor`、`./cn`→`../../lib/cn`；taskAssignCore.ts 的 `./api`→`../../lib/api`）。typecheck 会兜住，但批次说明应完整 | src/client/taskAssign.tsx:21-32、taskAssignCore.ts:8；docs/32:231 | 批 2 说明补「shared.tsx 与被迁文件自身 import 同步改写」 |
| 32-M9 | 备忘 | 批 7 后 index.tsx/teamsPanel.tsx 对 teams-view 的 import specifier 方案未定（`./pages/teams-view` 目录索引 vs 显式 `/index`）；moduleResolution=Bundler 与 rolldown 都支持目录索引，但显式文件名更稳 | docs/32:236 | 执行时以 typecheck/build 为准；建议统一写显式 `./pages/teams-view/index`（或方案里定死一种） |

### 3.2 32.5 映射表核验明细（全量核对结果）

方法：以 eteamsView.tsx 全部 110 个顶层声明为全集（含唯一的 `let usageStylesInjected`），对每个符号取全部非注释引用行，按「声明行分界」映射到所属目标文件区域，计算**拆分后**跨文件消费方集合（同批次同文件互引不计，注释级引用不计——与 32.5 的口径一致）；关键判定行再逐行人读复核。

- **「≥2 消费方 → shared.tsx」核验（21 个类名/组件符号全数成立）**：MUTED_CLASS（9 个目标文件）、FormErrorNote（8）、BORDER_L1_CLASS（6）、PANEL_CARD_CLASS（6）、SECTION_TITLE_CLASS（5）、EMPTY_CLASS（4）、LINE_CLASS（3）、Pill（3）、FORM_LABEL_CLASS/LIST_COUNT_CLASS（3）、PHASE_TONES（boardTab:1118 + teamTab:2006）、GLYPH_TONE_CLASS/dotClass/PageHeader/CARD_GRID_CLASS/CHIP_CLASS/SELECT_NONE/TEXT2_CLASS/LIST_TITLE_CLASS/FORM_ROW_CLASS/LEADER_NAME（各 2）。判定错误 0。
- **「唯一消费方」核验（代表清单，实测全部 0 跨文件引用）**：RAIL_*/rail*/RAIL_WIDE_MIN_WIDTH/SHELL_CLASS/CONTENT_CLASS（index，消费方全部在 ETeamsView/Body 域内）、EVENT_ROW_CLASS（boardTab）、TEAM_CARD_CLASS/TEAM_GOAL_PLACEHOLDER/PHASE_PILL_CLASS/MEMBER_LIST_CLASS（teamTab）、MEMBER_CARD_CLASS/ROLE_CHIP_CLASS（teamMembers）、PICKER_CELL_CLASS/PICKER_OPTION_CLASS（modelRoutePicker）、STEP_BTN_CLASS/CartItem（addMembersDialog）、DETAIL_ROW_CLASS/DETAIL_LABEL_CLASS/CMD_CHIP_CLASS（buildDraft）、ROLE_CARD_CLASS/ADD_MODE_CARD_CLASS/ADD_MODE_ICON_CLASS/PAGE_PILL_CLASS/BUILD_STEP_CLASS/STEP_ROW_CLASS/STEP_NUM_CLASS（membersTab）、TASK_ROW_CLASS/TASK_ROW/SlotDraft/TaskEditTarget/DisplayStatusPill/GroupSummaryChip（tasksTab）、ATTEMPT_CLASS/DRAWER_DIALOG_CLASS（taskDrawer）、DRAWER_CLASS/DIALOG_ITEM_CLASS（memberDialog）、USAGE_CALENDAR_THEME/LABELS 及 usage* 函数族（usageCalendar 域内自洽）。判定错误 0。
- **判错仅 4 处且同型（32-S1）**：ROLE_BUILDER_NAME/PROTECTED_MEMBERS/memberRank/ROLE_LIST_CSS 是「唯一真实消费方却落 shared」的规则性偏差——不断链、不致环，属可编译的次优落位。
- **漏符号 1 个（32-B1）**：`usageStylesInjected`；映射总数「109」实为 110。
- **关键争议符号复核**：`STATUS_GROUPS`「唯一真实消费方是 tasksTab」**成立**——boardTab 的两处（1112、242）均为 JSX/JSDoc 注释级引用（方案口径明确不计），唯一真实调用位是 4787；其定义体（194-212）只引用 `Tone` 类型（已随 taskDisplayStatus 迁移），Q3 的退回条件不会触发。`TONE_CLASS`「唯一真实消费方 boardTab」成立（1118）。`PHASE_TONES`「boardTab/teamTab 双消费」成立（1118/2006）。
- **循环依赖**：按映射表构建页内文件级依赖图（实测 27 条边；脚本初算 28 条，其中 boardTab→features/tasks 一条系 JSX 注释误计，剔除后仍成立）全部单向、**无环**；最强链 index→teamTab→teamMembers→modelRoutePicker/buildDraft→shared→features/tasks；shared 只被消费不消费页内其他文件（其自身依赖 cn/features/tasks/components/ui）。批 2 把 STATUS_GROUPS 上浮后，eteamsView（此时 tasksTab 域还在其中）以 `./features/tasks/taskDisplayStatus` 导入，无环。
- **批次算术**：批 3（usage+board ≈418 行）、批 4（taskDrawer+tasksTab ≈690）、批 5（≈1900）、批 6（≈1240）、批 7 收口余量（≈510：imports 段 172 + rail 族 50 + 壳常量 + ETeamsView/Body ≈290）与 32.5.3 表的余量估算一致。

### 3.3 已核实通过的要点

- **构建接线「天然透明」逐文件成立**：tsconfig.client.json（rootDir=src/client、include 全量、无 paths——rootDir 内相对移动对它不可见，`lib/types/client/` 镜像树自动跟随，index.tsx 留根保证 `lib/types/client/index.d.ts` 被 verifyM0 断言）；tsdown.config.ts（入口 src/client/index.tsx 不动；三个虚拟模块 id 均为包名/产物字符串 `@mdxeditor/editor/style.css`、`react-activity-calendar/tooltips.css`、`./tailwind.gen.css`，readFileSync 目标全在 node_modules/lib，transform hook 指 node_modules 内路径——与源码文件位置零相关）；tailwind.config.ts content=`src/client/**/*.{ts,tsx}` 确为目录级通配（eteams.css 本就不在扫描面，styles/ 迁移无感）；eslint.config.mjs（kebab override 只锚 `src/client/components/**`，新文件全 camelCase，零改动成立）；vitest.config.ts include `tests/**/*.test.ts`（测试文件不动）；package.json exports 只指 `lib/*`、`dsh.client.inject` 是包名数组；cordis.patch.yml 无源码路径；.prettierignore/.gitignore（lib/、docs/ 已 ignore）。
- **scripts 同步清单与实测一致**：buildTailwind.mjs L129 恰一处 `-i src/client/eteams.css`；genAvatarWidgets.mjs:19 `OUT_FILE = join(ROOT,'src','client','avatarWidgets.ts')` 恰一处；avatarPreviewEntry.ts:5-6 两行 import；wrapClient/smokeEnvelope/clean/bisect-client 只触 `lib/*`；list-primitives/list-routes/scanSlots/gen-role-docs/asar-extract/avatarPreview.mjs 均不触 src/client。
- **tests 同步清单精确覆盖**：23 个测试文件中 12 个触 client 模块（activityModel/avatarPipeline/backdropEngine/bridge/cnUtil/dvaApp/heroTeamsButton/m0/roleBuilder/rosterEffects/taskAssign/taskDisplayStatus），与 32.6.2 一一对应；11 个仅 host 面；无测试 import eteamsView.tsx 或 components/ui。
- **dva 时序**：models 经 store/models/index.ts 聚合 import 注册（29-32），app.ts create→循环 model()→start()（store/app.ts:37-42）——store 文件不搬迁则注册时序与求值顺序零变化；store/models/index.ts 顶部 regenerator 全局兜底副作用（R3 所述）与现状一致，批内不改其 import 结构的前提成立（对 lib 路径的改写除外，见 32-B3）。
- **垫片位置无关**：eteamsCss.d.ts=`declare module '*.gen.css'` 通配、dvaCore.d.ts=脚本式环境声明（无顶层 import）、mdEditorCss.d.ts/usageCalendarCss.d.ts=包名声明——四件全部与放置位置无关，R10 成立。
- **verifyM0 对内部路径零敏感**：全部断言针对 envelope 形状/路由字符串/manifest 字段/`lib/types/client/index.d.ts` 存在性——批 7 删除 eteamsView.tsx 不影响其中任何一条；smokeEnvelope 对 `.eteams-ui{--`、`--background:`、`.eteams-ui .flex` 的断言（R8/R9 兜底）实测存在（scripts/smokeEnvelope.mjs:148-151）。
- **基线相符**：lib/client.js 实测 5223 KB；eteamsView.tsx 5060 行；根目录 33 文件 + components/store 两目录，与 32.1/32.2 一致。

## 四、用户需求覆盖度核对

| 用户需求 | 覆盖结论 |
|---|---|
| ①「重新规划项目结构」 | 覆盖 ✓：根目录只留 index.tsx + 判定树 9 步 + 每目录唯一规则 + 32.2 现状矩阵 33 文件全判定；唯一漏洞是决策树缺入口项（32-S6） |
| ②「组件和页面的归属」 | 覆盖 ✓：pages/（宿主挂载面）vs features/（有文档线的领域块）vs lib/（横切基建）vs components/ui（vendored）四分，13 个非入口文件逐一走树唯一落点；eteamsView 拆分映射把「页面私有子组件就近、跨 tab 进 shared」落成可执行底稿 |
| ③「css 这些东西」 | 覆盖但欠一句显式决策（32-S7）：eteams.css→styles/（唯一 Tailwind 输入/token 桥，天然单文件）；运行时注入器 tailwind.ts→lib/；feature 私有运行时样式随各自文件；建议把「保持单文件」与理由写明 |
| ④ css shims（*.d.ts） | 覆盖 ✓：types/，四件全部为包名/通配声明、与位置无关（已核实） |
| ⑤「现出一个整改方案，再执行」 | 覆盖 ✓：32.8 四阶段 + 每批四绿门/独立 commit/revert + 12 条风险 + 文档回写清单 + 8 条开放问题；执行分支（Q8）沿用既有惯例 |

## 五、执行前必须修订清单（阻塞项）

1. **32.5.1 映射表补 `usageStylesInjected`**（32-B1）：usageCalendar 行加入该符号，「109 个」两处改「110 个」。不修的后果：按表逐符号执行的执行者把注入标志留在旧文件，`ensureUsageCalendarStyles` 断链（typecheck 即红，但执行底稿自相矛盾）。
2. **32.6.1 api.ts 行消费方补 `buildCard`**（32-B2）：buildCard.tsx:24 直连 `./api`。不修的后果：阶段 1 同步漏一文件，typecheck 红，浪费一轮停批排查。
3. **R2 措辞与 32.6.1 对齐**（32-B3）：改为「store/ 文件不搬迁、model 注册结构零改动；其对 lib/diagnostics、lib/monitor、lib/api 的相对 import 随迁移同步改路径」。不修的后果：按 R2 字面执行 → 阶段 1 必红，且「四绿不过即停」合同在此空转。

三项都是文档级修订，合计约 5 行改动；不动方案骨架、不动批次结构、不动落位判定主体。

## 六、可以带进执行的注意项

1. 批 5 顺序改为 modelRoutePicker→**buildDraft**→teamMembers→addMembersDialog→teamTab，批 6 改为 **memberDialog**→membersTab→reportsTab（32-S2）；若保持原顺序，则明确「批内子步不跑门」。
2. 阶段 1 的文件迁移拆 3 个独立 commit（纯移动+同步 / 批 1 shared.tsx / 批 2 features/tasks+STATUS_GROUPS），每 commit 后四绿（32-S3）。
3. shared.tsx 四个「唯一消费方」符号（ROLE_BUILDER_NAME/PROTECTED_MEMBERS/memberRank/ROLE_LIST_CSS）：要么按规则改落唯一消费方文件，要么在 32.5.2 补明示例外（推荐后者，领域常量族同居）（32-S1）。
4. 跨文件类型边用 `import type`：真实的两处是 membersTab→DraftEdit、teamMembers→HandbookSource（R1 原引证的 SlotDraft/TaskEditTarget 实为域内自用）；verbatimModuleSyntax + eslint consistent-type-imports 双重强制，不用等门报错（32-M2）。
5. 收口断言改 `ls -p src/client | grep -v / | wc -l`（期望 1），grep 清单补全 32.6.1 的全部旧名（32-S4）。
6. 消费方同步一律按 grep 实测执行，不依赖 32.6.1 行内的计数与个别多列/漏列（teamsButton 非 bridge 消费方、diagnostics 实为 10 个消费方、api 漏 buildCard 已入阻塞清单）（32-M3/B2）。
7. 顺手修正三处文档精度：components.json 处数统一「3 字段 + $comment」、tone 族消费方列举去 memberDialog、依赖图去 addMembersDialog→buildDraft 多余边（32-S5/M4/M6）。
8. 32.10 补一行：tsdown.config.ts 的 usageTooltipsCssInline 注释路径随批 3 更新（32-M5）。
9. 提交信息风格执行前与用户确认（32-M7）；pillClass 是基线死代码，随迁不删（32-M1）；批 7 的 teams-view import specifier 建议定死显式路径（32-M9）。