# 34 结构整改验收报告（docs/32）

- 验收对象：[32 项目结构整改方案](32-restructure-plan.md) 全量执行结果（工作区未提交改动，HEAD = `cb52bc4`「结构归位」；`cb52bc4` 之后为批 6+7 尾段与阶段 4 文档回写，随后由用户统一提交）。
- 验收方法：**全部为本报告自己的运行输出与读码实测**，不转述执行/审核 agent 的结论。四门 + verifyM0 + 独立 smokeEnvelope 全部亲跑；结构收口逐项 grep/清点；110 符号映射按「目标文件 × 顶层声明 grep」逐行复核（非抽样）；对 HEAD 快照（`cb52bc4`）用临时 git worktree（`node_modules` junction，用毕即拆）实测 typecheck 以核实「中途快照红」的性质。
- 结论：**验收通过**。四门全绿（typecheck 0 错 / lint 0 错 / test 272/272 / build exit 0 + SMOKE OK）、verifyM0 all checks passed（含 inject 3 服务新断言）、`lib/client.js` 5223 KB → **5230 KB（+7 KB，+0.13%，±1% 阈值内）**；根目录只剩 `index.tsx`，`eteamsView.tsx`（5060 行 110 符号）拆分 14 文件无缺项无重复、零行为变更成立。记录 7 条观察/偏差（见 §六），全部不阻塞、不涉及业务代码行为面。

---

## 一、验收环境与门禁——四绿 + verifyM0 全过

验收在整改工作区终态（未提交改动 = 批 6+7 尾段 + 阶段 4 文档/注释）上执行，HEAD = `cb52bc4`，日期 2026-09-04。

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | **0 错误**（host + client 两个 tsconfig 均通过，exit 0） |
| lint | `pnpm lint` | **0 错误**（`$ eslint .` 无输出退出 0） |
| test | `pnpm test` | **272/272 全绿**（23 个测试文件，4.90s） |
| build | `pnpm build` | **exit 0**（clean → tsc×2 → buildTailwind → tsdown → wrapClient → smokeEnvelope 全链；末行 `SMOKE OK: id=dsh-eteams, exports=[apply, inject]`） |
| verifyM0 | `node scripts/verifyM0.mjs` | **all checks passed**（exit 0） |
| smokeEnvelope（独立复跑） | `node scripts/smokeEnvelope.mjs` | **SMOKE OK**（build 内嵌之外单独再跑一次确认） |

verifyM0 关键断言逐条目视输出确认，其中新修断言原文为：

```
✓ exports.inject declares every accessed service (slots + conversationEvents + modelDirectories)
```

对应源码 `src/client/index.tsx:50` `export const inject = ['slots', 'conversationEvents', 'modelDirectories']`（3 服务与断言一致）。该断言由主 agent 在批 0 基线后修复（原断言只认 2 服务、会假失败），修复属**测试底稿修正**而非产品行为变更，本报告独立复测通过。

## 二、体积台账——+7 KB（+0.13%），在 ±1% 纪律内

`lib/client.js`（单文件 CJS envelope，`node -e` statSync 实测）：

| 口径 | 批 0 基线（docs/32 32.5.3） | 终态 | 增量 |
| --- | --- | --- | --- |
| `lib/client.js`（min） | 5,348,587 B（5223 KB） | **5,355,635 B（5230 KB）** | **+7,048 B（+6.9 KB，+0.13%）** |

解读：纯模块图重组（entry、虚拟模块、external、content 扫描面全不变），增量全部来自 14 个新文件的模块头注释与 import 块（源码面 5060 行 → 14 文件共约 5370 行，净 +约 310 行），tree-shaking 边界变化贡献极小。无异常膨胀（R7 阈值 ±1% 内），与 docs/21 附录 C 新增的整改行（5223 → 5230 KB）一致。

## 三、结构收口逐项核查——全部通过

### 3.1 目录形态

| 检查 | 命令/方法 | 结果 |
| --- | --- | --- |
| 根目录只剩入口 | `ls -p src/client \| grep -v /` | **仅 `index.tsx`**（目录 8 个：components/features/hooks/lib/pages/store/styles/types，与 docs/32 32.4 目标树同形） |
| pages/ 清点 | `ls src/client/pages/` | 恰 5 文件（teamsButton/teamsPanel/heroTeamsButton/eteamsCard/buildCard）+ teamsView/ 目录 |
| teamsView/ 清点 | `ls src/client/pages/teamsView/ \| wc -l` | **恰 14 文件**（index/shared/boardTab/usageCalendar/teamTab/teamMembers/modelRoutePicker/addMembersDialog/buildDraft/membersTab/tasksTab/taskDrawer/memberDialog/reportsTab） |
| features/ 四域 | `ls src/client/features/` | avatar/（4 文件）、backdrop/（2）、mdEditor/（1）、tasks/（3）齐 |
| lib/ 10 件 / hooks/ 1 件 / types/ 4 件 / styles/ 1 件 | 逐目录 ls | 与 32.4 目标树逐项一致 |
| 旧目录名残留 | `grep -rn "teams-view\|md-editor" src/ tests/ scripts/` | **0 命中**（kebab 旧名在代码/测试/脚本面零残留） |

### 3.2 旧路径残留 grep——零命中

| 检查面 | 结果 |
| --- | --- |
| `eteamsView` 作为现存 import 路径（`from '…eteamsView'` / `import('…')` / `require('…')`，全仓 src/ tests/ scripts/） | **0 命中** |
| `./eteams.css` import | **0 命中**（构建接线走 `src/client/styles/eteams.css`，见 3.4） |
| 旧根路径 import（`./api` `./monitor` `./cn` `./bridge` `./diagnostics` `./addPeople` `./modelCatalog` `./phaseLabels` `./versionLabel` `./tailwind` `./useHostDark` `./avatar*` `./backdropEngine` `./eteamsBackdrop` `./mdEditor` `./taskAssign*` `./taskDisplayStatus` `./card` `./teamsButton` `./teamsPanel` `./heroTeamsButton` `./buildCard`） | **0 命中**（§32.8.1 原文 grep 的 11 条命中逐一核过，全部是「同目录内相对导入」的新位置合法形态：features/avatar→avatarOption、features/backdrop→backdropEngine、features/tasks→taskAssignCore/taskDisplayStatus、lib/diagnostics→versionLabel、pages/teamsButton→teamsPanel、pages/teamsPanel→heroTeamsButton——该 grep 模式目录无关、无法区分新旧，属方案自述的「辅助线」性质，硬门由 typecheck/build 承担） |
| 子目录反向旧路径（`../api` 等 26 个旧名） | **0 命中** |
| tests/ 中 eteamsView 引用 | **0 命中**（12 个客户端测试文件全部指向新路径：lib/bridge、lib/cn、lib/api、lib/monitor、lib/addPeople、pages/heroTeamsButton、features/avatar/*、features/backdrop/backdropEngine、features/tasks/*，与 32.6.2 清单一一对应；其余 11 个仅 host 面未动） |
| scripts/ 中 eteamsView 引用与旧路径 | **0 命中**（genAvatarWidgets OUT_FILE → `features/avatar/avatarWidgets.ts`、avatarPreviewEntry 两条 import → `features/avatar/*`、buildTailwind `-i` → `src/client/styles/eteams.css`） |
| 源码中 `eteamsView` 字样 | 仅存在于**注释**（历史溯源措辞，如「原 eteamsView，已拆分至 pages/teamsView/」共 27 处）——按验收口径不算残留；无一处代码引用 |

### 3.3 接线核对（32.6.3/32.6.4）

| 接线 | 结果 |
| --- | --- |
| `components.json` | JSON 解析通过；3 字段值到位：`tailwind.css = src/client/styles/eteams.css`、`aliases.utils = src/client/lib/cn`、`aliases.lib = src/client/lib`；`aliases.hooks = src/client/hooks` 建立后首次成真；components/ui 两 alias 未动；`$comment` 已改写（真实链路 + aliases 真实路径 + hooks 成真说明） |
| `scripts/buildTailwind.mjs` | `-i src/client/styles/eteams.css` 恰一处（L130，spawnSync 参数数组内），产物存在性自检保留 |
| `tailwind.config.ts` / `tsconfig.*.json` / `tsdown.config.ts` / `eslint.config.mjs` / `vitest.config.ts` / `package.json` / `cordis.patch.yml` | **功能面零改动**（git diff 确认；tailwind.config.ts 有一处 docstring 内路径注释更新，属注释级，见 §五-⑧） |
| `tsdown.config.ts` 批 3 注释更新 | usageTooltipsCssInline docstring 已指向 `src/client/pages/teamsView/usageCalendar.tsx`（L111） |
| store 内对被迁模块的 import（R2） | store/app.ts → `../lib/diagnostics`（值）+ `../lib/monitor`（type）、store/models/activity.ts → `../../lib/monitor`（type）、build.ts / roster.ts → `../../lib/api`，全部同步；`store/models/index.ts` 聚合注册结构与顺序零改动（D19e） |

## 四、110 符号映射复核表（32.5.1，逐行 grep 实测）

方法：对 14 个目标文件逐一提取顶层声明（`export? function/const/let/class/type/interface`），与 32.5.1 映射表逐符号对拍；跨文件重复声明以全量符号名去重核验（结果 **109 个 teamsView 顶层符号零重复** + `STATUS_GROUPS` 上浮 1 个 = 110 个全覆盖、无缺项、无多迁）。原 `eteamsView.tsx`（基线 c1e0a95，5060 行）已删除。

| 目标文件 | 符号数 | 符号（全部实测在位） |
| --- | --- | --- |
| teamsView/index.tsx（461 行） | 14 | ETeamsView、ETeamsViewBody、SHELL_CLASS、CONTENT_CLASS、RAIL_CLASS、RAIL_WIDE_CLASS、RAIL_TITLE_CLASS、RAIL_LIST_CLASS、RAIL_LINK_BASE_CLASS、RAIL_LINK_IDLE_CLASS、RAIL_LINK_ACTIVE_CLASS、railBtnClass、railLinkClass、RAIL_WIDE_MIN_WIDTH |
| teamsView/shared.tsx（231 行） | 30 | 领域常量 4（LEADER_NAME、ROLE_BUILDER_NAME、PROTECTED_MEMBERS、memberRank）+ tone 族 9（TONE_CLASS、PHASE_TONES、PILL_BASE_CLASS、PILL_NEUTRAL_CLASS、PILL_TONE_CLASS、pillClass、dotClass、Pill、GLYPH_TONE_CLASS）+ 跨 tab 小组件 2（FormErrorNote、PageHeader）+ 类名/注入样式 15（BORDER_L1_CLASS、TEXT2_CLASS、MUTED_CLASS、LINE_CLASS、SECTION_TITLE_CLASS、EMPTY_CLASS、PANEL_CARD_CLASS、SELECT_NONE、FORM_ROW_CLASS、FORM_LABEL_CLASS、LIST_TITLE_CLASS、LIST_COUNT_CLASS、CHIP_CLASS、CARD_GRID_CLASS、ROLE_LIST_CSS） |
| teamsView/boardTab.tsx（219 行） | 2 | BoardTab、EVENT_ROW_CLASS |
| teamsView/usageCalendar.tsx（263 行） | 10 | UsageCalendarCard、USAGE_CALENDAR_THEME、USAGE_CALENDAR_LABELS、ensureUsageCalendarStyles、**usageStylesInjected**（`let`，32-B1 补列项，与 ensureUsageCalendarStyles 同迁）、usageNum、usageDateLabel、usagePercentile、usageLevelsOf、usageTooltipText；`react-activity-calendar` 三导入与 tooltips.css 虚拟模块 import 随迁 |
| teamsView/teamTab.tsx（710 行） | 5 | TeamTab、TEAM_CARD_CLASS、TEAM_GOAL_PLACEHOLDER、PHASE_PILL_CLASS、MEMBER_LIST_CLASS |
| teamsView/teamMembers.tsx（490 行） | 7 | LeaderCard、MemberCard、MemberDetailView、MODEL_OPTIONS、LEADER_MODEL_OPTIONS、MEMBER_CARD_CLASS、ROLE_CHIP_CLASS |
| teamsView/modelRoutePicker.tsx（392 行） | 3 | ModelRoutePicker、PICKER_CELL_CLASS、PICKER_OPTION_CLASS |
| teamsView/addMembersDialog.tsx（315 行） | 4 | AddMembersDialog、StepButtons、STEP_BTN_CLASS、CartItem |
| teamsView/buildDraft.tsx（170 行） | 12 | DraftPreview、CommandChip、fromBuildDraft、EMPTY_EDIT、DraftEdit、PREFILL_STEPS、BUILD_STEPS、handbookSeed、HandbookSource、DETAIL_ROW_CLASS、DETAIL_LABEL_CLASS、CMD_CHIP_CLASS |
| teamsView/membersTab.tsx（1242 行） | 8 | MembersTab、ROLE_CARD_CLASS、ADD_MODE_CARD_CLASS、ADD_MODE_ICON_CLASS、PAGE_PILL_CLASS、BUILD_STEP_CLASS、STEP_ROW_CLASS、STEP_NUM_CLASS |
| teamsView/tasksTab.tsx（588 行） | 6 | TasksTab、SlotDraft、TaskEditTarget、TASK_ROW_CLASS、DisplayStatusPill、GroupSummaryChip |
| teamsView/taskDrawer.tsx（154 行） | 4 | TaskDrawer、TaskStations、DRAWER_DIALOG_CLASS、ATTEMPT_CLASS |
| teamsView/memberDialog.tsx（66 行） | 3 | MemberDialog、DRAWER_CLASS、DIALOG_ITEM_CLASS |
| teamsView/reportsTab.tsx（69 行） | 1 | ReportsTab |
| features/tasks/taskDisplayStatus.ts | 1 | STATUS_GROUPS（上浮迁入，L185；唯一真实消费方 tasksTab，`boardTab`/`shared` 中两处命中均为注释级，与 32.5.2 口径一致） |

合计 **110/110**。14 文件合计约 5370 行（原 5060 行 + 模块头/ import 开销约 310 行，零行为变更口径下正常）。

依赖方向实测（页内跨文件 import 全清单，17 条边全部单向）：index → 5 个 tab；boardTab → usageCalendar；teamTab → teamMembers、addMembersDialog；teamMembers → modelRoutePicker、buildDraft；membersTab → buildDraft、memberDialog；reportsTab → memberDialog；tasksTab → taskDrawer；全部 tab → shared（boardTab/buildDraft/memberDialog/taskDrawer/usageCalendar 等 → shared 4 条）。**无环**；buildDraft 不反向 import teamMembers、memberDialog 不反向 import membersTab（反向命中均为注释，代码零引用）。

## 五、要求核对（docs/32 全文）与遗留/偏差清单

批 1–7 全部执行且终态符合修订版顺序要求：批 5 修订序（modelRoutePicker → **buildDraft** → teamMembers → addMembersDialog → teamTab）与批 6 修订序（**memberDialog** → membersTab → reportsTab）的批末依赖方向实测成立（见 §四尾图）；两处外部消费方 `index.tsx:36` 与 `teamsPanel.tsx:60` 均以显式文件名导入 `./pages/teamsView/index`（32-M9 定案形态）。批内子步的瞬时中间态不可从单快照复现，以「批末状态为准」合同核（见 §五-③ 的快照实证）。32.5.2 两处明示例外落实：tone 徽标族 9 符号整族在 shared.tsx、领域常量族 4 符号（+ROLE_LIST_CSS）在 shared.tsx；`pillClass` **原样保留**于 shared.tsx（其唯一调用位是 Pill 组件体，与基线同态，见 §五-⑥）；shared.tsx 30 符号 + 四段分区注释齐（L15「领域常量」/L32「tone 徽标族」/L109「跨 tab 小组件」/L143「页面级类名常量与注入样式」，231 行未触发 400 行二分阈值）。

**未发现需要修改业务代码的问题；本报告未修改任何 src/ 代码。** 记录的偏差/观察（均不阻塞）：

| # | 事项 | 说明 |
| --- | --- | --- |
| ① | **目录名 camelCase 两处改名偏离原方案示意**：`pages/teams-view/` → `pages/teamsView/`、`features/md-editor/` → `features/mdEditor/` | 原方案 32.3.3 的「目录名可用连字符」示例（`features/md-editor/`）与既有 `unicorn/filename-case` 纪律相悖（该规则连带约束目录名）；执行按 camelCase 收口，全仓 kebab 仅存 `components/ui/`（既有 override 例外）。属对方案示意的正确化而非执行走样，docs/32:101 命名细则已同步更正（见 §六） |
| ② | **verifyM0 断言修复**：inject 服务断言由 2 服务（slots + conversationEvents）改为 3 服务（+ modelDirectories） | 批 0 基线时该断言对 3 服务现状假失败；修复是 `scripts/verifyM0.mjs` 断言底稿与 `src/client/index.tsx` 既有事实对齐，非行为变更；本验收独立复测 all checks passed |
| ③ | **`cb52bc4` 中途快照不通过 typecheck**（实测） | 临时 worktree（junction `node_modules`，用毕即拆）实测：`tsc -p tsconfig.client.json` 3 处 TS2305——membersTab.tsx 从 `../../store/app` 取 useDispatch/useSelector（终态改自 react-redux 直取）、从 `./memberDialog` 取 MemberDialog（终态 memberDialog.tsx 已收全 MemberDialog）。系批 6 中间态快照被中途提交所致的历史快照问题；工作区终态四绿不受影响。回滚锚点如需可用「阶段前基线 commit（c1e0a95）」而非 `cb52bc4` |
| ④ | `src/client/index.tsx:5` 模块头注释仍写「`inject: ['slots']`」与实际 3 服务不符 | **基线即陈旧**（c1e0a95 的 inject 已是 3 服务），非整改引入；注释级、非接线，按纪律未动 src/，在此单列 |
| ⑤ | `pnpm format:check` 失败（336 文件）——**非本轮门禁、非整改回归** | 四门不含 prettier；`roles/` 资产、`roles-manifest/*.json`、`.tmp-*` 杂物等 321 个未触碰文件先行失败，`endOfLine: lf` 与 Windows CRLF 检出叠加；整改触及文件的内容级格式与全仓基线同态（未触碰的 src/host/runtime/usage.ts、tests/webui.test.ts 等同样不达标）。属仓库级卫生项，后续独立清理 |
| ⑥ | docs/32 32.10「pillClass 基线即零调用（死代码）」表述不准 | 实测其唯一调用位是 Pill 组件体（基线 eteamsView.tsx:423 JSX 内 `className={pillClass(tone)}`，终态 shared.tsx:93 同构）——「无组件外调用位、随族原样保留不删」的执行要求已落实且终态与基线同态；不准确的是「零调用」措辞本身，按 docs/32 历史记录不回改、在此更正口径 |
| ⑦ | docs/README.md 阅读顺序表缺 31 行（30 之后直接 32） | 本验收顺手补齐 31 行（前轮四功能验收报告）并新增 34 行（本报告）；属验收阶段文档收口动作 |
| ⑧ | 三处业务文件的注释级路径更新略超「构建接线零改动」字面：`tailwind.config.ts` docstring、`types/eteamsCss.d.ts` 注释、`lib/{tailwind,monitor,phaseLabels}.ts` / `lucide-icon.d.ts` 注释 | 全部为注释内旧路径→新路径的文字替换，`declare module` 声明体、content glob、构建参数零变化；属 32.10「现状描述段更新」范畴，四门与 build 全绿佐证零行为变更 |

## 六、阶段 4 文档回写核对——完成

| 文档 | 核对结果 |
| --- | --- |
| docs/04 §4.3 | 「模块划分（客户端）」已按实况树重写（lib/hooks/components/store/features/pages/styles/types 全量 + 目录职责口径段 + camelCase 说明），与实际目录逐项一致 |
| docs/21 | 新增 §21.6.1「结构整改指针」（根目录/D19d vendoring/cn/hooks/Tailwind 输入/content/注入器/巨石去向对照表，S0–S15 历史记录不回改）+ 附录 C 增整改体积行（5223 → 5230 KB，+7 KB/+0.13%） |
| components.json | `$comment` 改写完成（见 §3.3） |
| docs/13/14/19/25/28/29 | 「现状/模块」描述段路径更新到位（抽查 13/28/29：新路径 + 「原 eteamsView.tsx:行号」历史锚点保留的双轨写法，证据基线未回改） |
| docs/README.md | 32/33 行已增（本次补 31/34 两行，§五-⑦） |
| docs/32（本文） | 文末「实施结果回写」段由本验收补齐（见 §七）；101 行命名细则事实性错误已更正 |
| 后续清理候选 | `pillClass` 保留原样（不删）；`src/host/runtime/webui.ts` 拆分维持「不在本轮执行」结论，本轮 host 代码零改动（git diff 证实） |

## 七、验收结论

**通过。** 整改目标全部达成且零行为变更：`src/client/` 根目录只剩 `index.tsx`（入口层唯一），33 个平铺文件按 pages/features/lib/components/store/styles/types 七目录归位；5060 行 110 顶符的 `eteamsView.tsx` 巨石拆分为 `pages/teamsView/` 14 文件（110/110 符号对位、零重复、依赖无环、两处跨文件类型边均 `import type`）；`lib/client.js` 5230 KB（+0.13%）；四门 + verifyM0 + smokeEnvelope 全绿（全部为本报告亲跑输出）。遗留面仅文档/注释级（§五 8 条，全部不阻塞），无需要修的代码问题。