# 46 结构性改造清单（逐文件打勾）

> 打勾规则：该条目涉及的文件改造完成**且模块四道门禁全绿**后，把 `[ ]` 改 `[x]`；发现口径漂移/遗留问题记录在条目下或文末「验收记录」。门禁命令：
>
> ```bash
> pnpm typecheck && pnpm lint && pnpm test && pnpm build
> ```
>
> 基线（2026-09-06）：typecheck ✅ / lint 0 错误 2 既有警告 / test 317 用例 23 文件全绿 / build SMOKE OK。
> 规范与方案见 `44-page-structure-spec.md`；文件角色与去向见 `45-project-map.md`。

## M1 路由骨架

- [x] `package.json`：引入 react-router-dom@^6.30（devDependencies，打进 envelope）
- [x] 新增 `src/client/lib/status.ts`：初版 NAV_ITEMS（id/label/path）
- [x] 新增 `src/client/pages/teamsView/routes.tsx`：MemoryRouter + Routes（/board /team /roster /tasks /reports 五基础路径）+ ui model sync（initialEntries 由 activeNav/drawerTaskId/桥 pending 推导；location 变化回写 ui/setNav、ui/setDrawerTask）
- [x] `src/client/pages/teamsView/index.tsx`：五 tab 渲染改 Routes 出口；rail 点击迁 useNavigate（宽窄两套）；railBtnClass/railLinkClass active 三元改查表；桥信号 handler（GOTO_ADD/GOTO_ROSTER/SELECT_TEAM）改 navigate()；横幅分区改造
- [x] `src/client/store/models/ui.ts`：仅更新注释（持久层/观察面语义），结构不变

## M2 角色域（membersTab 1195 行拆分）

- [x] 新增 `teamsView/roster/roster-page.tsx`：角色列表页（搜索/分页/删除；/roster）
- [x] 新增 `teamsView/roster/roster-add-page.tsx`：新增工作台（choose/ai/manual 三态留页内；/roster/add）
- [x] 新增 `teamsView/roster/roster-detail-page.tsx`：角色详情编辑页（/roster/:name）
- [x] 新增 `teamsView/roster/build-workbench.tsx`：构建工作台（轮询/访谈/草稿确认；由 add 页消费，轮询仅角色域活跃时跑）
- [x] `routes.tsx` 增加 /roster /roster/add /roster/:name 三路由
- [x] membersTab 拆分后**删除**；原 17 个 shared 导入符号改由新文件各自导入
- [x] 随机头像钮/详情编辑态等查表化（lib/status.ts 增对应表）；三页四件全部按 44.3 横幅分区

## M3 任务域（tasksTab 805 行拆分）

- [x] 新增 `teamsView/tasks/tasks-page.tsx`：任务列表页（TaskListCard 栅格；TaskDndProvider 随页；/tasks）
- [x] 新增 `teamsView/tasks/task-detail-page.tsx`：任务详情页（/tasks/:taskId；TaskDndProvider 随页）
- [x] `routes.tsx` 增加 /tasks /tasks/:taskId 两路由
- [x] `features/tasks/taskDisplayStatus.ts`：增 isStartable/isTerminal 谓词；三处开始钮判据（taskListCard/taskSubtaskItem/详情页头）改谓词消费
- [x] 新增单测：deletableOf（taskListCard）镜像宿主 deleteTask 守卫口径锁定
- [x] tasksTab 拆分后**删除**；列表本地态（folderBusy/folderError/startError/deleteTarget）留列表页

## M4 团队域（teamTab + teamMembers 拆分）

- [x] 新增 `teamsView/team/team-page.tsx`：团队列表页（卡片栅格 + 建团/删团弹窗留页内；/team）
- [x] 新增 `teamsView/team/team-detail-page.tsx`：团队详情页（成员卡列表/模型路线/拉人/移出；原 detailId 态；/team/:teamId）
- [x] 新增 `teamsView/team/member-cards.tsx`：领队卡/成员卡（自 teamMembers 拆出）
- [x] 新增 `teamsView/team/member-detail-page.tsx`：成员详情页（手册编辑/同步回角色库/toast；/team/:teamId/member/:name）
- [x] `routes.tsx` 增加 /team/:teamId、/team/:teamId/member/:name 两路由
- [x] teamTab、teamMembers 拆分后**删除**
- [x] `memberDialog.tsx` / `addMembersDialog.tsx` / `modelRoutePicker.tsx`：横幅分区（移动留 M8）；子代理活动点查表化（lib/status.ts 增 ACTIVITY_DOT 表）

## M5 看板 + 汇报

- [x] `boardTab.tsx`：横幅分区；页内三元查表化
- [x] `reportsTab.tsx`：横幅分区；页内三元查表化
- [x] `usageCalendar.tsx`：横幅分区（档位表已表驱动，保持）

## M6 弹层与卡片（pages 根 5 表面）

- [x] `teamsButton.tsx`（37 处三元，全仓最重）：内部 tab/视图查表化；EMPTY_CLASS 同名异值改局部命名；横幅分区
- [x] `teamsPanel.tsx`：横幅分区；覆盖层视图查表化
- [x] `heroTeamsButton.ts`：查表化 + 分区
- [x] `eteamsCard.tsx`：头像栈密度参数化准备；横幅分区
- [x] `buildCard.tsx`：CARD_STATUS 迁 lib/status.ts（BUILD_SESSION 表）；渲染端 5 分支大三元链拆状态→文案表；横幅分区

## M7 复用收口（普查清单 11 项）

- [x] 1. `components/form-dialog.tsx`：FormDialog 壳 + FormFooterActions——弹窗尾行 ×5（teamTab 新增团队/taskDialogs 编辑/addMembersDialog/membersTab 详情头/tasksTab 就地编辑器）+ 删除确认弹窗 ×2（teamTab/taskDialogs，近乎逐字）
- [x] 2. `components/avatar-ring.tsx`：AvatarRing + RandomAvatarButton + rollAvatarPair——头像环 ×4（membersTab ×3 + teamMembers ×1）、随机头像钮 ×3（逐字同文）
- [x] 3. `components/back-bar.tsx`：返回条 ×6（membersTab ×2、teamMembers、teamTab、tasksTab 文字钮变体、teamsPanel ghost——变体经 props 保持原观感）
- [x] 4. `components/delete-button.tsx`：删除/移出钮 ×6（teamMembers ×2、teamTab、taskListCard、taskSubtaskItem、membersTab）；taskSubtaskItem 缺 destructive 属既有口径漂移——prop 保持现状观感，漂移记验收记录
- [x] 5. `lib/errors.ts`：errorMessageOf + runWithBusy——28 处错误规范化 + 15+ 处 busy/error 壳（tasksTab ×7、membersTab ×6、teamMembers ×2、build/roster model ×9 等）
- [x] 6. `components/step-glyph.tsx`：StepGlyph（✔●◌）——taskDrawer 站点行 + 构建步骤两份逐字重复的字形三元；GLYPH_TONE_CLASS 归位 taskDisplayStatus.ts
- [x] 7. `components/avatar-stack.tsx`：teamTab（+N）/ eteamsCard（slice 8）/ teamsButton（chip）三密度 → props
- [x] 8. `hooks/usePoll.ts`：membersTab 1500ms、壳 index 3000ms（buildCard setTimeout 重试链语义不同，**不并**）
- [x] 9. `lib/text.ts`：matchesQuery——membersTab 过滤 + 壳侧栏筛选同一判据
- [x] 10. isStartable/isTerminal 消费收尾（M3 建表，此处确认三处判据全收拢）
- [x] 11. 类常量收编（不改观感只去重）：PAGE_PILL_CLASS、buildCard STATUS_PILL/INTERVIEW_PILL、brand-tint 圆牌三档（ADD_MODE_ICON/STEP_NUM/taskAssign 站点 chip）、BORDER_TOKEN_CLASS/POPUP_BORDER_CLASS 同值异名、SUBTASK_CARD_CLASS ↔ taskHeaderCard 内联逐字重复、MEMBER_CARD_CLASS 由 PANEL_CARD 三要素拼装、taskListCard 内联 LIST_COUNT 档、ATTEMPT_CLASS/DRAWER_CLASS 左竖线族统一 token 口径

## M8 目录重排 + 终检（既有文件纯移动）

- [x] `teamsView/navigation/rail.tsx`：自 index 拆出宽/窄侧栏
- [x] `teamsView/shared.tsx` 拆分：`shared/styles.ts`（类名常量层）+ `shared/components.tsx`（Pill/FormErrorNote/PageHeader）；**17 引用方改导入**
- [x] `markdownDoc.tsx` → `shared/markdown-doc.tsx`
- [x] `boardTab.tsx` → `board/board-page.tsx`；`usageCalendar.tsx` → `board/usage-calendar.tsx`
- [x] `memberDialog.tsx` → `team/member-dialog.tsx`；`addMembersDialog.tsx` → `team/add-members-dialog.tsx`；`modelRoutePicker.tsx` → `team/model-route-picker.tsx`
- [x] `buildDraft.tsx` → `roster/build-draft.tsx`
- [x] `taskDialogs.tsx` → `tasks/task-dialogs.tsx`；`taskDrawer.tsx` → `tasks/task-drawer.tsx`；`taskHeaderCard.tsx` → `tasks/task-header-card.tsx`；`taskListCard.tsx` → `tasks/task-list-card.tsx`；`taskSubtaskItem.tsx` → `tasks/task-subtask-item.tsx`；`taskPills.tsx` → `tasks/task-pills.tsx`
- [x] `reportsTab.tsx` → `reports/reports-page.tsx`
- [x] 全文件横幅合规终查（对照 44.3：七区格式/顺序/命名）
- [x] `docs/45-project-map.md` 收口为终态（去掉「去向」列，路径全部更新）
- [x] 终检四道门禁全绿 + 317+ 用例全绿

## 验收记录

（逐模块追加：门禁结果原样关键行 + 口径漂移/遗留问题）

### M1 路由骨架（2026-09-06）

- 门禁关键行：
  - `pnpm typecheck`：host + client 两工程 0 错误（每文件完成后即跑，终跑全绿）。
  - `pnpm lint`：`✖ 2 problems (0 errors, 2 warnings)`——memberDialog.tsx 38 / taskDrawer.tsx 116，既有基线警告原样，未新增。
  - `pnpm test`：`Test Files  23 passed (23)` / `Tests  328 passed (328)` 全绿。
  - `pnpm build`：`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`；envelope 依赖清单含 `@remix-run/router` / `react-router` / `react-router-dom`（devDependencies 打包面生效）。
- 口径漂移与遗留（以代码事实为准）：
  1. **initialEntries 实际仅由 ui.activeNav 推导**（routes.tsx `ETeamsRouter`）。清单所列另两项：drawerTaskId → /tasks/:taskId 详情路由随 M3 落地后才有映射意义；桥 pending 信号由壳挂载 effect 消费后 `navigate('/roster')` 落地——与迁移前 setNav 同为挂载 effect 时序，行为零变更（未做挂载渲染期消费，避免首帧前跳转的时序变化），见 routes.tsx 文件头注记。
  2. **location → store 回写 M1 仅 `ui/setNav`**；`ui/setDrawerTask` 回写随 M3——M1 无任务详情路径可映射，且 tab 间切换本就不清 drawerTaskId（ui model 独立键互不清空语义），提前回写会破坏「返回任务页恢复详情」。
  3. **SELECT_TEAM 桥信号保持纯 store 选择语义不导航**（/team/:teamId 随 M4 落地后再改导航）。
  4. 双表面并存（整页覆盖层 + 槽位面板）导航各自独立——各挂一棵 MemoryRouter，为 44.2.1 批准的隔离语义；store 仅作重挂恢复持久层。
  5. 测试计数 328（本清单基线行记 317）：改造未增删用例，以当前代码事实为准。
  6. index.tsx 横幅分区按 44.3 落样式类/常量与映射表/工具函数/子组件/主组件五区（类型/事件处理两区无内容，整段省略）；主组件 ETeamsView 移至文件末（44.3.2 置末规则），ETeamsViewBody 为子组件区。
- 验收（独立验收 agent，2026-09-06）：**pass**。逐条核对 M1 五项完成、44.3 横幅格式（34 个 `=` 定宽/顺序/命名）合规、零行为变更抽查通过（RAIL_BTN/RAIL_LINK 两态类值逐字面量、NAV_ITEMS 五 label 同文、tasks/reports 的 team undefined 守卫保留、onOpenReports 先 setDialogMember 后导航同序、桥 handler 仅 setNav→navigate 等价替换、ui model 仅注释变更）。验收中发现并修复一处：`lib/status.ts` 模块区误用 `/* —— X —— */` 行注释（该形式 44.3.2 仅限主组件内事件处理分隔），改为标准 `/** ===== X ===== */` 定宽横幅并补类型区（类型→常量与映射表→工具函数，44.3.3 lib 模板）；纯注释变更后四道门禁重跑全绿（typecheck 0 错误 / lint 0 错误 2 既有警告 / 328 用例全绿 / SMOKE OK）。

### M2 角色域（2026-09-06）

- 门禁关键行：
  - `pnpm typecheck`：host + client 两工程 0 错误（每文件完成后即跑，终跑全绿）。
  - `pnpm lint`：`✖ 2 problems (0 errors, 2 warnings)`——memberDialog.tsx 39 / taskDrawer.tsx 116，既有基线警告原样（memberDialog 因文件头注释补依赖方向说明，警告行号 38→39，计数未变），未新增。
  - `pnpm test`：`Test Files  23 passed (23)` / `Tests  328 passed (328)` 全绿。
  - `pnpm build`：`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`。
- 落地摘要：membersTab.tsx（1195 行）拆为 `roster/roster-page` / `roster/roster-add-page` / `roster/roster-detail-page` / `roster/build-workbench` 四件并删除原件；routes.tsx 增 /roster、/roster/add、/roster/:name（react-router v6 静态段优先，/roster/add 不被 :name 吞）；原 17 个 shared 符号由四件各自按需导入；随机头像钮文案/类名与详情副标题查表进 `lib/status.ts`（RANDOM_AVATAR_BTN_META、ROSTER_DETAIL_SUBTITLE_META），navIdOfPath 增前缀匹配以点亮 /roster/* 的 rail 高亮；buildDraft 仍经 `../buildDraft` 引用（M8 才移动）。
- 口径漂移与遗留（以代码事实为准）：
  1. **「待确认」自动跳转去重升为模块级单例**（build-workbench `SEEN_REVIEW_STARTED_AT`）：拆页后三个路由页轮询/自动跳转收进 useBuildSession，若去重留在组件 ref，用户从新增页回列表会因页面重挂被再次强拉回确认页——与原代码注释声明的意图（「用户手动离开后不反复强拉，状态再迁移才再次跳转」）相悖。去重窗口由「tab 挂载期」放宽为「面板运行期」，状态再迁移（restart）仍会重置键值再次跳转。
  2. **详情页 `:name` 在名册中找不到时渲染 null**（防御位在全部 hook 之后）：拆分前该窗口回落到列表视图渲染——现仅出现在改名保存后的名册回拉瞬间（亚秒级），观感从「闪列表」变「闪空」，随即详情恢复。
  3. **新增页内临时态随导航卸载即清**（manual 表单/aiPrefill/draftAvatarRoll 等）：拆页的固有结果——离开 /roster/add 再进即全新页面；draftEdit 不受影响（经 useBuildSession 按 updatedAt 重建）。拆分前三态留在 membersTab 内不清，此为拆页显式接受的差异。
  4. **构建中在新增页再收 GOTO_ADD**：壳侧 handler 仍先 `navigate('/roster')` 再递增 openAddTick，列表页消费 tick 再跳回 /roster/add——产生一帧列表闪动且新增页内态复位（方式/表单）。壳契约 M1 已定稿未动，留给 M7/M8 若收口壳侧信号时一并处理。
  5. **eslint.config.mjs 增 teamsView 文件名大小写覆写**（`camelCase + kebabCase` 并许）：unicorn/filename-case 对路径每段生效，纯 kebab 模式会误报 `teamsView` 目录——44.3.3 页面文件 kebab 与既有 camelCase 根文件并存，故该子树两 case 并许（置项目级块之后，last-match-wins）。
  6. 测试计数 328 与 M1 验收记录一致（清单基线行记 317）：改造未增删用例，以代码事实为准。
  7. 六个既有文件（build model、buildDraft、memberDialog、reportsTab、shared、index.tsx）仅注释小步 Edit 更新去向指向（membersTab → roster/ 四件），无结构变更。
- 零行为变更抽查：四件新文件与原 membersTab 的 JSX 文案/字符串字面量逐串比对一致（仅注释措辞差异；五处副标题/随机头像钮文案迁移 lib/status.ts 表驱动，三处使用位观感不变）；删除确认、重名拦截、访谈/续跑/确认入库/放弃各落点、返回钮语义、分页每页 8 条均逐位保留。
- 验收（独立验收 agent，2026-09-06）：**pass**。逐条核对 M2 七项完成（四新文件/三路由/membersTab 删除且 17 个 shared 符号四件分摊无遗漏/两张 META 查表值与原字面量逐串一致）；44.3 横幅程序化校验 21 条均 34 个 `=` 定宽、区序与三种模板对位（routes.tsx 类型→子组件→主组件、status.ts 按 lib 模板、页内 handler 皆以 `/* —— 事件处理 —— */` 行注释分隔）；零行为变更抽查通过（三处跳转 openAddTick/待加入角色/确认与手动保存后回列表与原 setView 链等价、删除确认与确认入库 payload 逐位、详情 null 防御位置于全部 hook 之后、navIdOfPath 前缀匹配保持 /roster/* rail 高亮、上述漂移 1-4 与代码事实吻合）。四道门禁独立重跑全绿（typecheck 0 错误 / lint 0 错误 2 既有警告 memberDialog 39 + taskDrawer 116 / 328 用例全绿 / SMOKE OK）。本次验收零修复。

### M3 任务域（2026-09-06）

- 门禁关键行：
  - `pnpm typecheck`：host + client 两工程 0 错误（每文件完成后即跑，终跑全绿）。
  - `pnpm lint`：`✖ 2 problems (0 errors, 2 warnings)`——memberDialog.tsx 39 / taskDrawer.tsx 116，既有基线警告原样，未新增。
  - `pnpm test`：`Test Files  24 passed (24)` / `Tests  337 passed (337)` 全绿。
  - `pnpm build`：`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`。
- 落地摘要：tasksTab.tsx（805 行）拆为 `tasks/tasks-page`（229 行，列表栅格 + TaskDndProvider + TaskDialogs）与 `tasks/task-detail-page`（735 行，详情条/就地编辑器/弹层抽屉 + TaskDndProvider）两件并删除原件；routes.tsx 增 /tasks、/tasks/:taskId 两路由（静态段优先，/tasks 不被 :taskId 吞；team undefined 守卫原样保留），location→store 单向 sync 增 `ui/setDrawerTask`（/tasks/:taskId 写 id、/tasks 写 null、其余路径不触碰），initialEntries 增任务页签 + drawerTaskId 非空回落 `/tasks/:taskId` 的重挂恢复；`features/tasks/taskDisplayStatus.ts` 增 isStartable/isTerminal 谓词，三处开始钮判据（taskListCard 组卡 / taskSubtaskItem 行头两处 / 详情页 task+group 两分支）全收拢为谓词消费（chain 长度、kind、subs 结构检查留在调用点）；壳 index.tsx 移除 drawerTaskId 的 useSelector 与两 props（改由 routes.tsx sync 回写）；`tests/taskListCard.test.ts` 新增 7 例锁定 deletableOf 镜像宿主 deleteTask 守卫口径（注释互链），`tests/taskDisplayStatus.test.ts` 增谓词 describe 十态逐格 2 例。
- 口径漂移与遗留（以代码事实为准）：
  1. **列表页 TaskDialogs 编辑弹窗 props 传 inert 值**（editTarget=null、空串草稿、no-op 回调；删除弹窗 props 为真值）：编辑态本属详情页就地编辑器流，列表页上编辑弹窗不可达（modal 挡返回条，closeEdit 必先于回列表发生），为避免死编辑态复制进列表页而置空——TaskDialogs 组件本体未动未移（M8 才动）。
  2. **详情页 not-found（任务已删/畸形 :taskId）渲染一帧 null 后 navigate('/tasks')**：拆分前同窗口原文件回落列表视图渲染——与 M2 详情页 null 防御位同款拆页差异（防御位置于全部 hook 之后），亚帧级。
  3. **详情页内瞬态随路由切换卸载即清**（expandedSubIds/inlineEdit/编辑弹窗草稿）：拆页固有结果；列表页 submitStart/confirmDelete 因此删去了原 inlineEdit 清理行（详情页保留）——列表页本就无 inlineEdit 态。
  4. **rail 点「任务」落列表页**（原经 props 恢复上次的详情选中）：重挂恢复语义经 initialEntries（activeNav=tasks 且 drawerTaskId 非空 → /tasks/:taskId）保留；同面板运行期 rail 切回则落 /tasks 列表（原条件渲染会还原陈旧详情）。drawerTaskId 持久语义（tab 间切换不清）由 sync 的「其余路径不触碰」保持。
  5. **deletableOf 改具名导出**（taskListCard.tsx）：仅供 `tests/taskListCard.test.ts` 导入锁定镜像口径，判定式一字未动，无渲染方变化。
  6. 测试计数 337（清单基线行记 317、M1/M2 记 328）：+9 为本模块新增用例（deletableOf 7 + 谓词 describe 2），以代码事实为准。
  7. 逐字面量核对：两新页与原 tasksTab 的全部字符串字面量比对，新增字面量仅导入路径/'react-router-dom'/路由串（'/tasks'、'/tasks/:taskId'、`/tasks/${t.taskId}`）与 inert 空串；原 `'cancelled'` 字面量（组卡开始钮 `status !== 'cancelled'` 子句）随 isTerminal 收拢消失，谓词十态单测锁定等价——无任何文案/类名/aria 字面量漂移。
- 验收（独立验收 agent，2026-09-06）：**pass**。逐条核对 M3 六项完成：两新页接岗（tasks-page 229 行 / task-detail-page 735 行）且 tasksTab 已删、/tasks 与 /tasks/:taskId 两路由落地（静态段优先、team undefined 守卫保留）、isStartable/isTerminal 三处开始钮判据收拢为谓词消费（taskListCard 组卡 `!isTerminal` ≡ 原 `!== 'completed' && !== 'cancelled'`、taskSubtaskItem 行头两处与详情页 task/group 两分支 `isStartable` ≡ 原 `=== 'ready'`，十态逐格单测锁定等价）、deletableOf 具名导出判定式一字未动且 7 例单测与 host deleteTask 守卫（src/host/runtime/assignment.ts）逐条镜像、列表本地态（folderBusy/folderError/startError/deleteTarget）留列表页。44.3 横幅程序化校验：tasks-page 类型→主组件、task-detail-page 类型→工具函数→主组件，均 34 个 `=` 定宽、区序合规，页内 handler 以 `/* —— 事件处理 —— */` 行注释分隔。零行为变更抽查通过：两新页与原 tasksTab 全部字符串字面量比对——新增仅导入路径/路由串/inert 空串，消失仅旧导入路径与 `'cancelled'`（谓词等价由单测锁定），删除确认/开始提交/文件夹打开调用与 payload 逐位、空态与三计数文案同文、详情 not-found 防御位置于全部 hook 之后、TaskDndProvider 随页各自包裹同原分支包裹口径。验收中发现并小步修复一处遗留：5 文件 9 处注释仍以已删除的 tasksTab 为现在时持有方/放置位（ui.ts drawerTaskId 的「M1 仍由任务页内部回写、届时 location sync 接管」M3 前瞻注记、taskSubtaskItem ×3、taskDialogs ×1、taskAssign ×3、taskAssignCore ×1），Edit 更新为现持有方（tasks/ 两路由页、tasks/task-detail-page、taskSubtaskItem）；纯注释变更后四道门禁重跑全绿（typecheck 0 错误 / lint 0 错误 2 既有警告 memberDialog 39 + taskDrawer 116 / 337 用例 24 文件全绿 / SMOKE OK）。

### M4 团队域（2026-09-06）

- 门禁关键行：
  - `pnpm typecheck`：host + client 两工程 0 错误（每文件完成后即跑，终跑全绿）。
  - `pnpm lint`：`✖ 2 problems (0 errors, 2 warnings)`——memberDialog.tsx 56 / taskDrawer.tsx 116，既有基线 2 警告原样（memberDialog 因 kindLabel 收编出组件为模块级 KIND_LABELS，useEffect 下移致警告行号 39→56，计数未变），未新增。
  - `pnpm test`：`Test Files  24 passed (24)` / `Tests  337 passed (337)` 全绿。
  - `pnpm build`：`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`。
- 落地摘要：teamTab.tsx（678 行）拆为 `team/team-page`（列表：卡片栅格 + 建团/删团弹窗留页内 + 空态）与 `team/team-detail-page`（原 detailId 态：返回条/成员卡列表/模型路线乐观补丁链/添加成员弹窗 + 页头建团同款常驻）两件；teamMembers.tsx（497 行）拆为 `team/member-cards`（LeaderCard/MemberCard + MEMBER_CARD_CLASS/ROLE_CHIP_CLASS/MODEL_OPTIONS）与 `team/member-detail-page`（MemberDetailView 收编为路由页：手册编辑/同步回角色库/toast 逐位保持）两件，四件落定后 teamTab/teamMembers 删除；routes.tsx 增 /team/:teamId、/team/:teamId/member/:name 两路由（静态段优先，/team 不被 :teamId 吞；navIdOfPath 前缀匹配已覆盖 /team/*，rail 高亮与拆分前一致）；原 memberDetail 的 kind（领队/成员）语义并入路由——:name 命中成员行 = 成员详情、命中领队名 = 领队详情（手册只读）、皆不中 = 原「成员不在团队里」not-found 卡；lib/status.ts 增子代理活动表 ACTIVITY_DOT（running/inactive 点色 + title 双三元收拢，member-cards 原位消费，键由 `activity === 'running'` 三元只算名）；memberDialog/addMembersDialog/modelRoutePicker 三件横幅分区（KIND_LABELS 收编出组件；移动留 M8），buildDraft/taskAssign/index 注释去向更新。
- 口径漂移与遗留（以代码事实为准）：
  1. **详情页保留页头与建团入口**（清单括注只写列表页「建团/删团弹窗留页内」）：原 TeamTab 的 PageHeader「团队 + ＋ 新增团队」与创建弹窗在列表/详情两态常驻渲染——零观感要求下详情页同款保留（壳 index 429 注记本就声明团队页头由页内自渲染）；建团弹窗 JSX/state 因此在两页各挂各的实例（M3 TaskDialogs 每页实例同款拆页先例），M7-1 FormDialog 收口时塌缩。删团弹窗仅列表页持有（删除钮只在列表卡上，详情态弹窗原样挂载但恒关、无 DOM）。
  2. **kind 并入路由的推导口径**：成员行优先命中（成员可改名/重名加 -2 后缀，成员行查找唯一）；领队被移出（leaderRemoved）时 :name = 领队名的路由仍可达领队详情——原 UI 在 leaderRemoved 时不渲染领队卡、无此入口，现仅手改 URL 可达（防御位，正常流不可触）。
  3. **详情 not-found 一帧空后跳转**：团队详情 /team/:teamId 在池中查不到（已删/畸形段）navigate('/team')、成员详情 :teamId 查不到同——原 detailId/memberDetail 落空窗口原地回落列表渲染（M2/M3 详情页同款拆页差异，防御位置于全部 hook 之后）。
  4. **详情态瞬态随路由卸载即清**（detailError/addOpen/modelSavingName/createOpen/建团表单）：拆页固有结果；原 tab 内列表↔详情本就是同组件条件渲染、切出即卸载，无可见差异。
  5. **SELECT_TEAM 桥信号保持纯 store 选择语义不导航**（M1 验收注记 3 的「/team/:teamId 随 M4 落地后再改导航」未执行）：弹层/创建卡选团队改导航属行为变更（面板会强跳详情页），与本模块零行为变更纪律冲突，清单/任务范围亦未列出——留待壳侧信号收口时由用户拍板。
  6. **memberOpError 错误规范化在列表/详情两页各一份模块级 1 行函数**（原 TeamTab 组件内单份）——M7-5 lib/errors.ts errorMessageOf 收口。
  7. 测试计数 337 与 M3 验收记录一致（清单基线行记 317）：本模块未增删用例，以代码事实为准。
  8. initialEntries 团队页签恢复落 /team 列表（activeNav='team' → navPathOfId）：原 detailId/memberDetail 即组件瞬态、重挂本就落列表——路由恢复口径与拆分前一致，团队域无 ui model 持久键需要 sync。
- 零行为变更抽查：四新件 + routes/status 与原 teamTab/teamMembers 的字符串字面量程序化双向比对——旧字面量消失仅 16 条 import 路径（../../→../../../、./→../ 目录降级），新增仅 24 条 import 路径与路由串（'/team/${…}'、'/team/${…}/member/${encodeURIComponent(…)}'、'/team/${team.teamId}' 返回导航）；建团/删团 payload、模型乐观补丁 RoutePatch 结构、成员手册 save/syncToRole 与 toast 文案、移出/领队移除调用逐位保留；卡片栅格/成员列表/成员详情 JSX 类名逐字面量未动（ACTIVITY_DOT 两档类值与原三元两支逐串一致）。
- 验收修复（独立验收 agent，2026-09-06）：**成员详情页丢失页头与建团入口**——拆分前 TeamTab 的 PageHeader「团队 + ＋ 新增团队」与创建弹窗在列表/详情/成员详情三态常驻渲染（成员详情视图在 TeamTab 树内，not-found 卡窗口同），拆页时仅列表/详情两页保留。修复：member-detail-page 补 PageHeader + 创建弹窗（sessionId/onSelectTeam 经 routes.tsx 传入；创建成功落同 :name 的新队成员/领队详情——原 detailId 换队 + memberDetail 保留的同态映射；表单错误独立命名 createError 避让手册编辑 error）；壳 index 页头注记「两页」→「三页」、45 地图 member-detail 行同步；另补页内 `/* —— 事件处理 —— */` 行注释分隔（44.3.2，六姊妹页皆有）。增补后四道门禁重跑全绿。
- 验收（独立验收 agent，2026-09-06）：**pass**。逐条核对 M4 七项完成：四新件接岗（team-page 360 行 / team-detail-page 500 行 / member-cards 240 行 / member-detail-page 修复后 431 行）且 teamTab/teamMembers 已删、/team/:teamId 与 /team/:teamId/member/:name 两路由落地（静态段优先，/team 不被 :teamId 吞；navIdOfPath 前缀匹配 rail 高亮覆盖 /team/*）、三弹层件横幅分区（KIND_LABELS 六键值逐串一致收编出组件）+ ACTIVITY_DOT 表（running/inactive 点色 + title 与原双三元两支逐串一致，member-cards 原位消费，键只算名）。44.3 横幅程序化校验：9 文件全部 34 个 `=` 定宽，区序与三种模板对位（routes.tsx 类型→子组件→主组件、status.ts lib 模板、页内 handler 以行注释分隔）。零行为变更抽查通过：新旧字面量双向比对无任何文案/类名漂移（消失仅旧 import 路径、新增仅 import 路径/路由串/dispatch 类型/status 既有表），routeBody/changeModel/changeMemberEffort/changeCaptainModel/changeCaptainEffort/removeMember/removeLeader 与原 TeamTab 逐行一致，confirmDeleteTeam/建团 payload 逐位，MemberDetailView→MemberDetailPage 的 save/syncToRole/toast/手册播种逐位，kind 并入路由推导与漂移注记 2 吻合，防御位（team===null / target===null 一帧后跳转/渲染卡）置于全部 hook 之后。上述验收修复一处（成员详情页头），修复后四道门禁独立重跑全绿（typecheck 0 错误 / lint 0 错误 2 既有警告 memberDialog 56 + taskDrawer 116 / 337 用例 24 文件全绿 / SMOKE OK）。

### M5 看板 + 汇报（2026-09-06）

- 门禁关键行：
  - `pnpm typecheck`：host + client 两工程 0 错误（每文件完成后即跑，终跑全绿）。
  - `pnpm lint`：`✖ 2 problems (0 errors, 2 warnings)`——memberDialog.tsx 56 / taskDrawer.tsx 116，既有基线警告原样，未新增。
  - `pnpm test`：`Test Files  24 passed (24)` / `Tests  337 passed (337)` 全绿。
  - `pnpm build`：`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`。
- 落地摘要：三件横幅分区（boardTab 样式类→常量与映射表→主组件三区，reportsTab 常量与映射表→主组件两区，usageCalendar 常量与映射表→工具函数→主组件三区）。boardTab 页内三元查表化：空态脚注两态收编 `EMPTY_FOOTNOTE_META`（'error'/'noTeam' 两键——尚未建团队整句 / 状态加载失败前缀，错误支的原始错误串是运行时值，表存字面量件、消费位拼接），数据更新行空档占位收编 `FETCH_AT_EMPTY`（fetchedAt=0 分支；另一支为运行时 relativeTime 计算，条件式保留）；reportsTab 收编 `MEMBER_SELECT_PLACEHOLDER`（placeholder 与哨兵 SelectItem 两处同文字面量单点维护）；usageCalendar 档位表 USAGE_LEVEL_STEPS/USAGE_LEVEL_NAMES 已表驱动保持原样，仅自函数区归组进常量区（const/function 声明无初始化顺序依赖，调用时点在渲染期）。45 地图三行行数与 M5 注记同步。
- 口径漂移与遗留（以代码事实为准）：
  1. **「页内三元查表化」按代码事实收口为字面量件收编**：boardTab/reportsTab 各 2 处三元均非 44.2.2 状态域值查表面——boardTab 脚注两支形态不同（一支插值运行时错误串）、更新行另一支为运行时 relativeTime 调用；reportsTab 两处为 Select 哨兵值归一（回调内值映射，非渲染位，docs/23 S23-3 契约）与正文 member 空判（两支 JSX 结构不同，组件换位）。查表只收字面量件（EMPTY_FOOTNOTE_META/FETCH_AT_EMPTY/MEMBER_SELECT_PLACEHOLDER），条件式在必须处保留，未硬套函数表（仓内无先例）。
  2. **usageCalendar 渲染位嵌套三元链原样保留**（meta 行四支：上次刷新失败/全年合计/今年零消耗/空串；日历体三支：错误重试/日历/暂无数据）：不在本模块清单范围（档位表已表驱动），拆链属行为面重构、超出零行为变更纪律——留 M8 横幅终查时由用户拍板。
  3. reportsTab 无样式类区、boardTab 无类型区（props 行内类型，memberDialog M4 分区同款保留）——44.3.1 用不上的区整段省略。
  4. 测试计数 337 与 M3/M4 验收记录一致（清单基线行记 317）：本模块未增删用例，以代码事实为准。
- 零行为变更抽查：三文件字符串字面量比对——EMPTY_FOOTNOTE_META error 支拼接后与原模板串 `状态加载失败：${error}` 同值、noTeam 支同串；FETCH_AT_EMPTY/MEMBER_SELECT_PLACEHOLDER 同字面量替位（reportsTab '— 选择 —' 由两处 inline 收敛为表内单点）；JSX 结构仅空态脚注 `<p>` 内表达式换行展开（JSX 纯空白行折叠语义，渲染文本不变）；usageCalendar 仅声明归组、主体零改动。横幅程序化校验：三文件均 34 个 `=` 定宽、区序与 44.3.3 页面模板对位。

### M6 弹层与卡片（2026-09-06）

- 门禁关键行：
  - `pnpm typecheck`：host + client 两工程 0 错误（每文件完成后即跑，终跑全绿）。
  - `pnpm lint`：`✖ 2 problems (0 errors, 2 warnings)`——memberDialog.tsx 56 / taskDrawer.tsx 116，既有基线警告原样，未新增。
  - `pnpm test`：`Test Files  24 passed (24)` / `Tests  337 passed (337)` 全绿。
  - `pnpm build`：`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`。
- 落地摘要：pages 根五表面横幅分区 + 查表化——
  - **teamsButton.tsx**（776 行）：六区（类型→样式类→常量与映射表→工具函数→子组件→主组件）；EMPTY_CLASS 改局部命名 `POPUP_EMPTY_CLASS`（teamsView/shared 同名异值易混，M8 平铺收口前置避让，类值逐字不变）；页脚新增钮两 tab 逐字同文收编 `TAB_ACTION_META`、团队 tab 空态两态收编 `TEAM_EMPTY_META`（error 支存前缀、运行时错误串消费位拼接，M5 EMPTY_FOOTNOTE_META 同模式）、两 TabsTrigger 逐字同文类名收编 `POPUP_TAB_TRIGGER_CLASS`、清除钮两处复用位收编 `ClearButton` 子组件；主组件 TeamsButton 移文件末（44.3.2 置末），页内 handler 以 `/* —— 事件处理 —— */` 行注释分隔。
  - **teamsPanel.tsx**：四区（类型→样式类→工具函数→主组件）；覆盖层静态面类名收编 `OVERLAY_PAGE_CLASS`/`OVERLAY_HEADER_CLASS`（逐字面量）；pane 矩形动态 inline style、z-[500] 层级、portal 行为原样。
  - **heroTeamsButton.ts**（非 JSX）：lib 模板三区（样式类=HERO_BUTTON_CSS 注入样式表 → 常量与映射表=HERO_ROW_SELECTOR/BUTTON_FLAG/STYLE_ID → 工具函数）；导出面（HERO_ROW_SELECTOR/ensureHeroButton/installHeroTeamsButton）原样，tests/heroTeamsButton.test.ts 锁定件不受影响。
  - **eteamsCard.tsx**：五区（类型→常量与映射表=eteamsCardDefinition Node 定义→工具函数=parse 群+installCard→子组件=ETeamsCardBody→主组件）；ETeamsCard 移文件末；M7-7 头像栈密度参数化注记预留（本件仅注记，结构未动）。
  - **buildCard.tsx**（295 行）：状态 pill 表原 CARD_STATUS 迁 `lib/status.ts`（BUILD_SESSION_META 四态 label+toneClass）；渲染端 5 分支大三元链拆 buildView 视图键（嵌套三元只算键名，21.5.1 同纪律）→ `BUILD_VIEW_META`（text/spin/stepFallback）；轮询 1500/800 setTimeout 链、扑空 75 次重试、jumpedSessionAt 去重语义逐行原样（不并 usePoll，M7-8 注记同）。
  - **lib/status.ts**：类型区增 `BuildSessionStatus`（= BuildSession['status']，api.ts 无下游依赖无环），常量区增 `BUILD_SESSION_META`；文件头注记「已入表」补 M6。
- 口径漂移与遗留（以代码事实为准）：
  1. **表名 BUILD_SESSION_META**（清单括注「BUILD_SESSION 表」）：依 44.3.3 `_META` 后缀纪律与库内既有表族统一命名，键型即 BuildSession['status'] 四态——非漂移，命名规约落点。
  2. **teamsPanel/heroTeamsButton 无状态切换三元可查表**：覆盖层视图为纯静态 chrome + ETeamsView 出口、hero 注入器为纯过程逻辑——「查表化」按代码事实收口为字面量件收编（OVERLAY_* 类常量；M5 boardTab/reportsTab 同先例），未硬造函数表。
  3. **BUILD_VIEW_META 三字段设计**：building 行文案是「前缀 + 运行时 step」拼接——表存前缀字面量件与空档兜底 stepFallback（'准备中'），spin 键承载两支 JSX 结构差异（spinner 有无）；八视图键由归属/轮询态嵌套三元推导，判定顺序与原五分支逐支等价（orphan 的 confirmed 终态优先、loading→null→active（访谈未答单列不转圈）/awaiting→confirmed→else idle）。
  4. **teamsButton「37 处三元」残余**：查表化后剩余三元均为运行时值判据（选中态/回调/键名计算/插值），非 44.2.2 状态域字面量查表面——字面量件已收尽，条件式在必须处保留（M5 同口径）。
  5. 测试计数 337 与 M3-M5 验收记录一致（清单基线行记 317）：本模块未增删用例，以代码事实为准。
- 零行为变更抽查：类名常量逐字面量替位——POPUP_EMPTY_CLASS 与原 EMPTY_CLASS 同串、OVERLAY_PAGE/HEADER 与原 JSX className 同串、POPUP_TAB_TRIGGER_CLASS 与两原 TabsTrigger 同串；TAB_ACTION_META/TEAM_EMPTY_META 表值与原三元两支逐串一致（error 支拼接后同 `状态加载失败：${state.error}`）；BUILD_SESSION_META 四态 label/toneClass 与原 CARD_STATUS 逐串一致（active→text-business/待确认→text-warning/已入库→text-success/已放弃→text-muted-foreground）；BUILD_VIEW_META 八视图文案与原五分支渲染串同值（building 支拼接后同 `角色构建师工作中 · ${step}`、空档同落「准备中」）；JSX 仅组件抽取（ClearButton）与空白行折叠级差异。横幅程序化校验：五文件均 34 个 `=` 定宽、区序与 44.3.3 模板对位（页面模板/lib 模板），页内 handler 行注释分隔合规。

### M7 复用收口（2026-09-06）

- 门禁关键行：
  - `pnpm typecheck`：host + client 两工程 0 错误（每文件完成后即跑，终跑全绿）。
  - `pnpm lint`：`✖ 2 problems (0 errors, 2 warnings)`——memberDialog.tsx 64 / taskDrawer.tsx 113，既有基线两条 useEffect 依赖警告原样（行号随格式化微移），未新增。
  - `pnpm test`：`Test Files  24 passed (24)` / `Tests  337 passed (337)` 全绿（本模块未增删用例）。
  - `pnpm build`：`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`。
- 落地摘要（批序：lib/hook → 组件件 → 类常量收编）：
  - **lib 层 + hook**：`lib/errors.ts`（errorMessageOf：`e instanceof Error ? e.message : String(e)`；runWithBusy：setBusy(true)/setError(null)/try await run()/catch setError(errorMessageOf)/finally setBusy(false) 的字符串错误壳收口）；`lib/text.ts` matchesQuery（trim+lowercase 判据）；`hooks/usePoll.ts` usePoll(pull, intervalMs)（pull(isCurrent) 保留各处 alive 旗标语义，deps [pull, intervalMs]）。errorMessageOf 全仓替换收尾后 `grep "instanceof Error"` 仅剩 lib/errors.ts 定义位。
  - **组件件**（components/，kebab-case，相对导入，lucide 深层 .mjs 默认导入）：form-dialog（FormDialog 壳 + FormFooterActions，左槽 left + 内层按钮组 div 承载 justify-between/justify-end 档位）；confirm-delete-dialog（基于 FormDialog，error 以预渲染 ReactNode 槽传入）；back-bar（outline/secondary/ghost 走 Button sm、text 变体走裸 button 文字钮——tasksTab 原观感）；delete-button（destructive 默认档，taskSubtaskItem destructive={false} 既有漂移保留）；avatar-ring（RING_CLASS 环壳 + RandomAvatarButton + rollAvatarPair，RANDOM_AVATAR_BTN_META 自 lib/status.ts 迁入）；step-glyph（✔●◌ 三态字形 + GLYPH_TONE_CLASS 调色表）；avatar-stack（people/size/max/wrapperClass/titleOf/overflow 参数化，泛型保留原对象供 titleOf 消费）。
  - **类常量收编（M7-11，零观感变化）**：shared 增 `CARD_SURFACE_CLASS`（边框/底色/阴影三要素，PANEL_CARD_CLASS 与 member-cards MEMBER_CARD_CLASS 拼装复用）与 `TASK_CARD_CLASS`（taskHeaderCard 内联 ↔ taskSubtaskItem SUBTASK_CARD_CLASS 逐字重复合一，mt-1.5 档位差留消费位）；memberDialog DRAWER_CLASS 左竖线边框色改引 `BORDER_L1_CLASS`（与 taskDrawer ATTEMPT_CLASS 同族同口径，borderColor.border 同值）；teamsButton POPUP_BORDER_CLASS 同值异名归一（改自 teamsView/shared 导入 BORDER_L1_CLASS）；taskListCard 进度计数改 `LIST_COUNT_CLASS`；GLYPH_TONE_CLASS 自 shared.tsx 删除（两消费位均已迁 components/step-glyph）。
- 口径漂移与遗留（以代码事实为准）：
  1. **GLYPH_TONE_CLASS 归位 components/step-glyph.tsx 而非清单所写 taskDisplayStatus.ts**：依赖方向禁止 components 层消费 features 层，而两消费位分居 pages/teamsView 与 components 难以反向；调色表随组件同居（taskDisplayStatus 保留 dot/tone 族不受影响）。
  2. **ConfirmDeleteDialog 实际消费位 ×2（team-page/taskDialogs）**：team-detail-page 无删除确认弹窗（清单「删除确认弹窗 ×2」与此吻合，仅括注的 membersTab 侧不存在）；弹窗标题为纯文案非红色 destructive 面——按代码事实壳不做标题染色，error 槽收 ReactNode（FormErrorNote 是 pages 层私有件，components 不能上行导入）。
  3. **buildCard STATUS_PILL/INTERVIEW_PILL 与 PAGE_PILL_CLASS 不收编**：三者与 shared PILL_BASE_CLASS 均为「近失」异档——STATUS_PILL 缺 inline-flex/w-fit/items-center/gap-1.5 布局四件、PAGE_PILL 缺 gap-1.5 与 font-medium（多 whitespace-nowrap）、INTERVIEW_PILL（font-semibold）与 ROLE_CHIP（font-medium+布局件）字重不同——拼装即改字重/布局观感，违反「不改观感只去重」，保留各自字面量。
  4. **brand-tint 圆牌三档不收编**：ADD_MODE_ICON（h-8 w-8 rounded-full text-primary）/ STEP_NUM（h-5 w-5 rounded-full text-xs semibold brand-ink）/ taskAssign 站点 chip（h-[32px] rounded-[4px] 可拖签名）为三档异值，无逐字重复；且 taskAssign 在 features 层不能上行导入 pages/teamsView/shared，唯一共享面 bg-business-tint 已是 token 工具类本位。
  5. **teamsButton TEAM_CHIP_CLASS 排除**：其为单字首圆 chip（name.slice(0,1)），非头像栈，不在 M7-7 三密度收口范围（eteamsCard 文件头注记同步）。
  6. **taskAssign BORDER_TOKEN_CLASS 保留本位**：与 BORDER_L1_CLASS 同值异名，但 features→pages 导入方向非法，留独立表（文件头注记已声明同值关系）。
  7. **item 10 为核实项**：isStartable 消费 taskSubtaskItem ×2 + task-detail-page ×2、isTerminal 消费 taskListCard + task-detail-page，四文件全部经 taskDisplayStatus 谓词，无内联重写。
  8. **index.tsx 壳轮询 usePoll(pullAgentActivity, 3000)**：team 未就绪时 pull 内部照旧 no-op（原 effect 同语义，注释保留）；测试计数 337 与 M3-M6 验收记录一致（清单基线行记 317）。
- 零行为变更抽查：三密度头像栈（teamTab size20/max3/+N、eteamsCard size26/max8/-mr-1.5 + 「 · 领队/状态」title 尾注）、四处返回条变体类值与原 JSX 逐串一致（text 变体裸 button 串同原）、删除钮 destructive 族类值同原（taskSubtaskItem 非 destructive 档观感不变）；TASK_CARD_CLASS/CARD_SURFACE_CLASS 拼装串与原字面量逐工具类同集（仅串内顺序调整，互不冲突的工具类序不影响级联）；ATTEMPT_CLASS/DRAWER_CLASS 的 border-[color:var(--border)] → BORDER_L1_CLASS 经 tailwind.config borderColor.border 同值证实。横幅程序化校验：七个组件新件均 34 个 `=` 定宽、区序对位（组件件模板：类型→样式类→工具函数→主组件，空区省略）；三个 lib/hook 小件（errors/text/usePoll）单一职责无区可分，随 lib/cn.ts 先例整段省略横幅（44.3.1「用不上的区整段省略」）；既有文件全部小步 Edit，无整文件重写。

### M8 目录重排 + 终检（2026-09-06）

- 门禁关键行：
  - `pnpm typecheck`：host + client 两工程 0 错误（每步完成后即跑，终跑全绿）。
  - `pnpm lint`：`✖ 2 problems (0 errors, 2 warnings)`——tasks/task-drawer.tsx 113 / team/member-dialog.tsx 64，既有基线 2 条 useEffect 警告原样（文件随 M8 移动，行号未变），未新增。
  - `pnpm test`：`Test Files  24 passed (24)` / `Tests  337 passed (337)` 全绿。
  - `pnpm build`：`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`。
- 落地摘要（批序：shared 拆分 → rail 拆出 → 按域纯移动 → 横幅终查 → 文档收口）：
  - **shared.tsx 拆分**：`shared/styles.ts`（175 行：领域常量 LEADER_NAME 族、tone 徽标族 TONE_CLASS/PILL_*/pillClass/dotClass、页面级类名常量、ROLE_LIST_CSS；横幅按 lib 模板「常量与映射表→工具函数」）+ `shared/components.tsx`（77 行：Pill/FormErrorNote/PageHeader，pillClass/dotClass 经 import 消费）并删除 shared.tsx；24 个引用方按符号改导入（类名常量 ← styles、组件 ← components；跨目录层 ../shared/*）。
  - **rail 拆出**：`navigation/rail.tsx`（174 行，PanelRail）——宽栏（搜索框/分组标题/细线列表/链接三态）与窄栏两套渲染 + RAIL_* 类常量与查表 + railBtnClass/railLinkClass 自 index 迁入；railWide 由壳实测经 props 传入（测量锚点是壳的作用域根元素，useLayoutEffect/ResizeObserver 留驻 index），RAIL_WIDE_MIN_WIDTH 自 rail 导出供壳消费（单一档位源）；railQuery 筛选与 activeTab 派生（navIdOfPath(location.pathname)，与壳同源同值）随 JSX 迁入组件。
  - **纯移动 ×14**（git mv）：markdownDoc → shared/markdown-doc、boardTab → board/board-page、usageCalendar → board/usage-calendar、memberDialog/addMembersDialog/modelRoutePicker → team/ 三件、buildDraft → roster/build-draft、taskDialogs/taskDrawer/taskHeaderCard/taskListCard/taskSubtaskItem/taskPills → tasks/ 六件、reportsTab → reports/reports-page；各文件只改 import 相对路径与文件头 @module/文件头注释；消费方导入路径同步（routes.tsx 两路由、tasks-page/task-detail-page/task-subtask-item 等域内改同目录、tests/taskListCard.test.ts 导入与注释路径）。
  - **横幅终查**：程序化校验（临时脚本，验后删除）对 pages/components/lib/hooks/features 全量 .ts/.tsx 校验——横幅定宽左右各 34 个 `=`、区名属七区、区序与 44.3.3 三种模板子序列对位、无重复区：全部通过；index.tsx 瘦身为 样式类→子组件→主组件 三区（常量/工具函数两区随 rail 拆出整段省略），并清理两处模块级 `/* —— X —— */` 行注释（M1 验收口径：该形式仅限主组件内事件处理分隔）。
- 口径漂移与遗留（以代码事实为准）：
  1. **shared/styles.ts 兼收领域常量与纯函数**（LEADER_NAME/ROLE_BUILDER_NAME/PROTECTED_MEMBERS/SELECT_NONE/memberRank/pillClass/dotClass 非类名件）：方案只列 styles/components 两文件，styles.ts 即 shared 层非组件件的唯一落点，未硬造第三文件；pillClass/dotClass 收进工具函数区（函数体调用时求值，无初始化顺序问题），常量插值依赖（PILL_TONE_CLASS←PILL_NEUTRAL_CLASS、STATUS_PILL_CLASS/CARD_SURFACE_CLASS/TASK_CARD_CLASS/PANEL_CARD_CLASS←BORDER_L1_CLASS、LINE_CLASS←TEXT2_CLASS）均保持原声明顺序，逐字迁入未重排。
  2. **rail 拆出后壳保留宽/窄测量**：测量锚点是壳的作用域根元素（rootRef 挂在壳根 div），useLayoutEffect/ResizeObserver 留驻 index；railWide 经 props 传入 PanelRail，RAIL_WIDE_MIN_WIDTH 自 rail.tsx 导出（单一档位源，壳导入消费）；railQuery 筛选词随 JSX 迁入组件（宽窄切换不卸载组件、词保留），PanelRail 自查 activeTab（navIdOfPath(location.pathname)，与壳同源同值）。
  3. **纯移动核验方式**：工作树含未提交的 M1–M7 改动（按流程用户最后统一提交），git diff 对移动文件显示的是相对 HEAD 的累计差异而非本次移动净差异——核验以「Edit 仅命中 import/@module/文件头注释块」+ 消费方导入路径同步 + 四门禁全绿佐证，未逐文件比对 index 基线。
  4. **注释级文件名同步清单**（纯注释、零行为）：usage-calendar.tsx / board-page.tsx / member-cards.tsx 文件头、taskAssignCore.ts、taskDisplayStatus.ts ×3、tasks/task-detail-page.tsx 文件头、task-header-card.tsx、team/member-dialog.tsx、components/step-glyph.tsx、features/tasks/taskAssign.tsx——历史叙事中旧文件名按上下文保留（指历史事件时）。
  5. tsdown.config.ts 一处注释内 usage-calendar 路径同步（纯注释）。
  6. index.tsx 横幅瘦身为 样式类→子组件→主组件 三区，并删除两处模块级 `/* —— X —— */` 行注释（M1 口径：该形式仅限主组件内事件处理分隔）。
  7. docs/45 行数列为 M8 收口时实际值（与 M3/M4 验收记录所记不同，以代码为准）。
  8. 测试计数 337 与 M3–M7 验收记录一致（清单基线行记 317）；本模块未增删用例。横幅校验临时脚本 scripts-banner-check.cjs 已验后删除。
- 验收（独立验收 agent，2026-09-06）：**pass**。逐条核对 M8 十项完成：终态目录树与 44.2.4 表逐位对齐（29 文件，旧平铺 8 件与 shared.tsx 全删，pages 根 5 表面留位）；shared.tsx 拆分符号收点全量对账——HEAD shared.tsx 29 个导出符号逐一核对，28 个分居 styles.ts（26）/components.tsx（3），GLYPH_TONE_CLASS 系 M7 迁 components/step-glyph（记录在案非丢失）；rail 拆出核验（RAIL_* 类常量与查表迁入、railBtnClass/railLinkClass 同值、RAIL_WIDE_MIN_WIDTH 单一档位源自 rail 导出供壳、测量 useLayoutEffect/ResizeObserver 留驻壳且 railWide 经 props 传入、railQuery/activeTab 随 JSX 迁入组件与壳同源同值）。横幅合规独立程序化校验（自写脚本）：src/client 全量 34 文件 94 条横幅，34 个 `=` 定宽/七区命名/区序与 44.3.3 模板子序列对位/无重复区/主组件置末——0 问题。零行为变更抽查：移动文件 diff 逐 hunk 归类仅 import 路径重写、@module/文件头注释、既有 M3/M7 已记录替换（isStartable/isTerminal/DeleteButton/TASK_CARD_CLASS/LIST_COUNT_CLASS），无未解释行为面差异；routes.tsx 与 tests/taskListCard.test.ts 消费方导入同步；全仓旧路径引用清零（残留旧名均为「原/自/拆分前」历史叙事，符合记录条目 4 口径）；docs/45 行数列抽查 11 件与 wc -l 全部一致。验收中发现并小步修复一处：`styles/eteams.css` typeset 注记仍以现在时引用已移动的 markdownDoc.tsx（不在记录条目 4 同步清单内），Edit 更正为 shared/markdown-doc.tsx；纯注释变更后四道门禁重跑全绿（typecheck 0 错误 / lint 0 错误 2 既有警告 task-drawer 113 + member-dialog 64 / 337 用例 24 文件全绿 / SMOKE OK）。另注： teamsView 内 8 个纯移动件（tasks/ 六件 + roster/build-draft + shared/markdown-doc）无横幅分区——各模块清单从未指派其分区，M8 纯移动纪律下维持改造前逐符号 JSDoc 原样，属既有状态非本模块缺陷；若需全量分区由用户后续拍板。

### 二次调整：组件全驼峰 + 域目录上提（2026-09-06，用户拍板）

- **拍板两点**：①「组件名全部以驼峰命名」——撤销 M8 的 kebab-case 组件文件名；②「别用三层结构，teamsView 里面的放出来」——域目录自 `pages/teamsView/<域>/`（三层）上提到 `pages/<域>/`（两级），teamsView 只留壳。
- **落地**：
  - 纯移动 ×6（git mv）：board/team/roster/tasks/reports/shared 六域目录整体上提；`navigation/rail.tsx` → `teamsView/rail.tsx`（navigation/ 目录撤除）。teamsView 终态 3 文件（index/routes/rail）。
  - 改名 ×31（mv）：components/ 七件（formDialog/confirmDeleteDialog/avatarRing/avatarStack/backBar/deleteButton/stepGlyph）+ 域目录 24 件页面/子件全部 kebab→camelCase（boardPage/usageCalendar/reportsPage/teamPage/teamDetailPage/memberCards/memberDetailPage/memberDialog/addMembersDialog/modelRoutePicker/rosterPage/rosterAddPage/rosterDetailPage/buildWorkbench/buildDraft/tasksPage/taskDetailPage/taskDialogs/taskDrawer/taskHeaderCard/taskListCard/taskSubtaskItem/taskPills/markdownDoc）。
  - 导入修正：一次性 codemod（临时脚本，验后删除，42+35 文件×2 遍）——域文件 `'../../../` → `'../../`（上提一层）；31 个 kebab 模块名→驼峰（导入与注释同改，守卫前后邻接 [A-Za-z0-9-] 不改，保运行时串 `dsh-eteams-usage-calendar` 原样）；陈旧 `teamsView/<域>/` 引用重写。手工补壳层三件：routes.tsx 十条域导入 `./` → `../`、index.tsx `./shared/*` → `../shared/*` 与 `./navigation/rail` → `./rail`、rail.tsx 相对深度减一；styles/eteams.css 一处注释路径同步。
  - eslint.config.mjs：撤销 M2 的 teamsView 域 kebab 豁免块；vendored shadcn 的 kebab 豁免收窄至 `components/ui/**`（上游注册表惯例仅指 vendored 件），components/ 根首方组件回归全仓 camelCase 规则。
- **门禁关键行**：`pnpm typecheck` host+client 0 错误；`pnpm lint` 0 errors / 2 warnings（taskDrawer 113、memberDialog 64，既有基线原样）；`pnpm test` 24 文件 337 用例全绿；`pnpm build` SMOKE OK。
- **文档同步**：docs/44（44.2.4 终树改两级结构、44.2.3/44.3.3 组件命名改 camelCase）；docs/45（全表路径按调整后终态重写，状态行注明二次调整）；本文件追加本节。
- **口径**：历史叙事（各模块记录）中旧文件名/旧路径指历史事件，按上下文保留不回改；docs/45 为终态唯一权威路径表。
- **核验**：grep 全仓 src/client+tests kebab 文件名引用清零（仅余 data-source 运行时串与历史叙事）；四道门禁全绿。
