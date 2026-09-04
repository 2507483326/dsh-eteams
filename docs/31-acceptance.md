# 31 验收报告（本轮四功能：Token 日历 / SQLite 设计 / 小任务拖拽 / 展示态）

- 验收对象：功能①②③④（设计→审核→开发已走完）的最终集成态（工作区未提交改动，HEAD = `e74b560`）。
- 验收方法：全链构建冒烟 + 全量门禁（**全部为本报告自己的运行输出**，不转述前序 agent 结论）+ HEAD 基线对拍测体积 + 逐条需求对照 + 关键实现点抽查。
- 结论：**验收通过**。`pnpm build / typecheck / lint / test` 四绿（272/272），构建冒烟与 envelope 求值通过，两个 ESM-only 依赖被正确打进 client CJS envelope；需求四条逐条核验通过。无阻塞问题，未修改任何功能代码；记录 6 条观察/偏差与一份装机冒烟清单（见 §5/§6，全部标注「未在真实宿主验证」）。

---

## 一、构建冒烟（最高优先项）——通过

`pnpm build` 全链（clean → tsc×2 → buildTailwind → tsdown → wrapClient → smokeEnvelope）**exit 0**，关键输出：

```
ℹ [CJS] lib\client.stage.js  5.21 MB
✔ Build complete in 4460ms
wrap-client: wrapped lib/client.stage.js -> lib/client.js (atomic) as id "dsh-eteams"
SMOKE OK: id=dsh-eteams, exports=[apply, inject]
```

两个 ESM-only 库的打包面逐项确认：

| 项 | 结论 |
| --- | --- |
| react-dnd@16.0.1 + react-dnd-html5-backend@16.0.1 | tsdown 依赖清单中出现 `react-dnd / @react-dnd/invariant / dnd-core / @react-dnd/asap / fast-deep-equal / @react-dnd/shallowequal / react-dnd-html5-backend`——已内联进 bundle；`lib/client.js` 中 grep `require("react-dnd")` 等 0 命中（无运行时 require，全量打进） |
| react-activity-calendar@3.2.1（含 tooltips.css 虚拟模块） | `tsdown.config.ts` 新增 `usageTooltipsCssInline()` 插件把 `react-activity-calendar/tooltips.css` 改道为 `\0…css-js` 虚拟模块（字符串导出，规避开 `css-guard`），插件在构建日志中出现且占插件耗时 18%——生效；`tooltips.css` 内容已进包（bundle 内 `react-activity-calendar__tooltip` 标记 ×8） |
| css-guard / 动态 import / 循环引用 | 无一触发：`inlineDynamicImports: true` 兜底、单文件无代码分块；SMOKE OK = envelope 顶层可求值、导出 `apply/inject` 齐全（Node 模拟宿主 ModuleLoader） |
| 宿主面 | `lib/index.js`（host）正常产出；`src/host/index.ts` 挂载点 `installUsageMeter` 包 try/catch，失败仅 warn 不影响装机 |

### 体积台账（docs/21 口径：`lib/client.js` 字节数，实测）

HEAD 基线用临时 git worktree（`.accept-wt`，junction 共享 `node_modules`，同一工具链）以 HEAD 源码跑同一构建链得出——**非估算**，是两次真实构建对拍：

| 产物 | HEAD 基线（功能前） | 本轮终态 | 增量 |
| --- | --- | --- | --- |
| `lib/client.js`（min） | 4,493,769 B（4388 KB） | **5,348,587 B（5223 KB）** | **+854,818 B（+835 KB，+19.0%）** |
| `lib/client.js`（gzip） | 1,166,335 B（1139 KB） | **1,296,481 B（1266 KB）** | **+130,146 B（+127 KB，+11.2%）** |
| `lib/index.js`（min / gzip） | 334,094 / — B（326 KB） | 356,436 / 106,334 B（348 KB） | +22,342 B（+21.8 KB；usage.ts ~800 行宿主模块） |
| tsdown stage 裸 CJS | 4.38 MB | 5.21 MB | —（envelope 壳约 +137 KB） |

增量归因（包源码体积口径：**未压缩、含 ESM+CJS 双份拷贝的 dist，是上界**，非最终增量）：

| 依赖 | dist JS 源码体积 | 备注 |
| --- | --- | --- |
| @floating-ui/react（日历 tooltip） | ~617 KB | **最大贡献者**；gzip 口径的主增量 |
| react-dnd + html5-backend（+dnd-core/@react-dnd/*） | ~80-120 KB | gzip 增量小（压缩友好） |
| react-activity-calendar（+date-fns 子集） | ~25 KB + 裁剪后 date-fns（bundle 内 `January` 标记 ×97，tree-shaken 子集） | |
| 新增应用代码 | usage 卡片 + taskAssign/taskAssignCore/taskDisplayStatus/罗列条 ~1200 行 | |

对照预估：docs/28 预估 +120KB min / +35KB gzip、docs/29 预估 +35~45KB min——**gzip 实测 +127KB 与预估同量级偏上，min 实测 +835KB 显著高于预估**，主因 @floating-ui/react（docs/28 只按主包体量估了 3.2.1 本体，未计入 floating-ui 全家）。非异常膨胀（无 tree-shaking 失效证据：date-fns 未整包进、无重复打包标记），记入台账观察，不构成整改项。

## 二、全量门禁——四绿

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | **0 错误**（host + client 两个 tsconfig 均通过） |
| lint | `pnpm lint` | **0 错误**（`$ eslint .` 无输出退出 0） |
| test | `pnpm test` | **272/272 全绿**（23 个测试文件，5.08s） |
| build | `pnpm build` | **exit 0**（§一） |

过程注记：lint 曾一次报 237 个 tseslint「multiple candidate TSConfigRootDirs」解析错——根因是**验收过程自身**在仓库内临时创建的 `.accept-wt` 基线 worktree 干扰了 tseslint 根目录推断，非仓库问题；移除该 worktree（连同其 `node_modules` junction，已确认主 `node_modules` 完好无损）后复跑即绿。此为测量装置伪象，与代码无关。

## 三、两 agent 集成核验（同一 eteamsView.tsx 先后修改）——通过

`git diff HEAD -- src/client/eteamsView.tsx`（+690/-344）逐段核对：

| 核验点 | 结论 |
| --- | --- |
| UsageCalendarCard（BoardTab，~1162/1315-1446）与 TasksTab 拖拽改动（~4544-5015） | 互不覆盖：日历卡是 BoardTab 的独立子组件（1159-1162 处一个挂载点），拖拽面全部在 TasksTab 函数体内；两区无重叠编辑痕迹 |
| imports 无重复/缺失 | typecheck+lint 双绿背书；react-activity-calendar、taskAssign、taskDisplayStatus、useHostDark、usageTooltipsCss 各 import 恰一次（grep 确认） |
| STATUS_GROUPS 收敛后的旧结构引用 | 全仓 grep：`STATUS_GROUPS` 仅 eteamsView.tsx:194（定义）与 4787（消费）两处，无其他文件引用旧 10 组结构 |
| 词表/tone 迁移无残留 | `STATUS_LABELS / memberTone / DOT_BASE_CLASS / DOT_TONE_CLASS` 唯一定义在 `taskDisplayStatus.ts`（原值迁移，测试锁定 13 态值一致）；eteamsView 内无同名残留定义 |
| DndProvider 单实例 | `TaskDndProvider` 全仓唯一消费点 = TasksTab 根（4650-5013）；`from 'react-dnd'` 全仓唯一 import 在 taskAssign.tsx |
| TaskDrawer / 成员 pill 精度隔离 | TaskDrawer（654）与 attempt 行（666）保留 13 态 `STATUS_LABELS`；成员状态 pill（2804）不动——B.3 共存策略落实 |

## 四、需求覆盖度逐条对照——全部通过

### ① 看板 react-activity-calendar · 按日展示 token 消耗 ✓

- `BoardTab` 挂 `<UsageCalendarCard>`（eteamsView.tsx:1162）；全年 365/366 零填充格子来自 API（服务端聚合，图即真相）。
- **空数据兜底**：全 0 天恒 0 档照渲 + 兜底文案「今年还没有记录到消耗——成员执行任务后这里会逐日亮起。」；拉取失败 `FormErrorNote` + 重试按钮；有上次成功数据时降级为「上次刷新失败：…」脚注并保留日历。
- **亮暗主题**：`useHostDark()`（useHostDark.ts，从 mdEditor 提取共享）+ `USAGE_CALENDAR_THEME` 亮/暗两套 5 档色板（28.5.2 定稿色值逐字一致）。
- **tooltip 分项**：`输入/输出/缓存读/缓存写` 四分项 + `推理 n（可能与输出重叠）`（reasoning>0 时）+ `调用 n 次`；千分位固定 en-US；多行靠注入的 `white-space:pre-line` 覆盖。
- **年份切换**：未来年禁用（`year >= currentYear` 置灰），切年即重拉；60s 低频轮询仅在 `document.visibilityState==='visible'` 触发，卸载丢弃迟到响应。

### ② docs/27 SQLite 表结构设计 ✓（无代码交付，核对完整性）

- 覆盖 **角色(roster)/团队/任务全域**：`schema_meta / teams / members / roster_members / roles / tasks / attempts / events / mail_messages / decisions / task_status_changes` 共 **11 张表**，DDL 逐表核对**零 FOREIGN KEY / 零 CHECK / 零 UNIQUE / 零触发器**（grep 证实，正文声明与 DDL 一致，27-B2 用户定案落实）；route 并单列 JSON（27-B3）、roles 表落位（27-B4）。
- **明确「先不做改造」**：文件头「设计稿——只设计，未实施…team.json/events.jsonl/roster.json 仍是磁盘真相」+ 27.8 阶段 0「纯设计」+ 范围表「不做：建库/读写代码、引依赖」三处声明齐备。
- **token 记账明确不进库**：文件头 + 27.9-1（改写为 usage.jsonl 定案引用）+ 与 28.3.5 的分工声明（SQLite 管角色/团队/任务，usage.jsonl 管 token，互不替代）。
- 口径说明：验收任务书与 docs/30 §四 row② 写「10 表」——该计数是 token_usage 删除后、roles 表新增前的中间态；**最终口径 11 表**（docs/30 §5.4 与 docs/27:107/366 一致），差异源于用户 27-B4 定案，非文档错误（docs/30 该行残留见 §5-④）。

### ③ 小任务成员框 + 组卡下成员罗列条 + 拖拽指派 ✓

- **行尾成员框**：`TaskAssignDropBox`（taskAssign.tsx:152-282）挂每条小任务行尾（eteamsView.tsx:4750）；空框虚线「＋ 拖入成员」、悬停实线「松手指派」、chip 上浮阴影、busy 半透明禁用。
- **成员罗列条**：`TeamMemberStrip` **每张组卡下方各一条**（eteamsView.tsx:4776-4781，A.5.3 用户拍板位置），chip 可拖（`cursor-grab` + `bg-business-tint` 淡底签名 + title 提示）、staged 带「未启动」弱化、领队 chip 置首带「领队」徽标且**不可拖**、`leaderRemoved` 时不渲染。
- **拖拽写入下一待执行站**：`isAssignEditable = draft/ready && chainCursor===-1` 才注册 drop target（taskAssignCore.ts:26-28，DA6 客户端守卫，比 host 更严）；`nextChainAfterDrop` 空链建站 / 同站替换保 stageBrief / 多站只改站点 0 / 同名 no-op（200ms 微反馈不发请求）；整链重发复用 `updateTeamTask`（DA10，无新通道）。
- **host 校验失败就地中文报错**：`assignError` 行内 `FormErrorNote`（eteamsView.tsx:4762-4764），host 文案即中文（「任务 x 处于 y，合同已冻结」「执行链成员「z」不在团队中」，assignment.ts:175/196-198）；`readChainParam` 对 present-but-empty 数组清空链（× 按钮路径合法）。

### ④ 展示态 ✓

- **映射表 13 态全覆盖**：`DISPLAY_STATUS_TABLE` 13 键齐（taskDisplayStatus.ts:87-101），tests/taskDisplayStatus.test.ts 全表断言（含未知态中性回退）。
- **error 桶同桶异色（29-M3）**：awaiting_decision/needs_user → warn 黄、failed → err 红、cancelled → muted 灰 + 文案独立「已取消」——逐格对表有测试锁定。
- **TaskDrawer 保留 13 态**：654/666 行直用 `STATUS_LABELS`；`STATUS_LABELS` 未动（值迁移至 taskDisplayStatus.ts 原样，测试断言逐值一致）；成员 pill 复用面隔离（冲突④处置落实）。
- **STATUS_GROUPS 收敛**：6+1 组（初始化/已创建/等待执行/进行中/已完成/错误/已取消独立组），组头与行内展示态同口径；组卡汇总 chip `groupDisplayOf`（error > doing > waiting > created，异常 chip ✕ 前缀 + 首个异常 detail）。

## 五、代码抽查（关键实现点对照设计，18 处）——全部相符

| # | 抽查点 | 证据 | 结论 |
| --- | --- | --- | --- |
| 1 | firehose 类型早退门（热路径） | usage.ts:388-392（非 assistant/message·request/* 第一行 return） | ✓ 28.6.6 |
| 2 | 路线折叠（request/header EpochHeader.config / request/context） | usage.ts:394-403 + rememberRoute 上限防膨胀 | ✓ E4/28.3.3 |
| 3 | 归属优先级 1→5 + 10s TTL 身份缓存 | usage.ts:147-187（五级顺序与 docs/28 表逐行一致，captain 命中读盘） | ✓ 28.3.2 |
| 4 | 串行追加队列 + 失败节流 warn（计量绝不破坏会话） | usage.ts:225-239（enqueueWrite 吞错 + 1min 节流） | ✓ 28.3.1 |
| 5 | 水位（5s 去抖整写、30 天剪枝、单调 max、unref） | usage.ts:285-374 | ✓ 28.3.4 |
| 6 | 轮转双阈值（2MB/730 天，保留尾部 KEEP_BYTES，归档原子整写+合并读） | usage.ts:534-570 | ✓ 28.6.1 |
| 7 | 聚合：全年零填充 + (sessionId,seq) 去重 + mtime/size 解析缓存 | usage.ts:644-686、583-604 | ✓ 28.4 |
| 8 | 装机对账（ctx.sessions.list() + session/created 补折，与 live 行同队列） | usage.ts:741-777 | ✓ E9/E10/E18 |
| 9 | cwd 缺省回退 + 1min 节流 warn（28-M1） | usage.ts:257-275 | ✓ |
| 10 | firehose 挂载（apply() 内 installUsageMeter，try/catch 降级） | src/host/index.ts:118-129（inject 未动） | ✓ 28.7 |
| 11 | 成员身份登记（setup hook 内 registerMemberSession，冷恢复重登记） | src/host/runtime/members.ts:249-255 | ✓ 28.7 |
| 12 | 路由 405 守卫（usage/calendar 位于 GET 段，`method!=='GET'` 先行 405） | webui.ts:1470-1473 + 1563-1585 | ✓ docs/12.5 |
| 13 | year 校验（缺省当年、非法 400、未来年零格不 404） | webui.ts:1565-1572 + webui.test 断言 | ✓ 28.4 |
| 14 | drop 以最新快照重算（useDrop spec deps 携带最新 task，drop 回调内现算，不缓存旧 chain） | taskAssign.tsx:184-204 + 注释（useOptionalFactory 冻结风险有意识规避） | ✓ 29 风险② |
| 15 | 罗列条渲染条件「仅存在 draft/ready 小任务时」 | eteamsView.tsx:4779（`subs.some(draft||ready)`） | ✓ |
| 16 | DndProvider 单实例包裹位置（仅 TasksTab 根，随 tab 卸载） | taskAssign.tsx:43-45、eteamsView.tsx:4650/5013 | ✓ DA2 |
| 17 | 单站点抑制 TaskStations（`chain.length===1 && boxRendersContent`） | eteamsView.tsx:4707/4760 | ✓ A.5.1 |
| 18 | tooltip 挂点（28-M3：FloatingPortal 在 body 根 → 样式标签挂 head、选择器 body 级全局生效 + `data-source` 标记） | eteamsView.tsx:1226-1252 | ✓ |

测试面：tests/usage.test.ts（归属 5 行全表、路线折叠、水位重启不重折、读侧去重、双阈值轮转、未来年、聚合口径 reasoning 不计总量）、tests/taskAssign.test.ts（A.3.1 规则表锁 16 例）、tests/taskDisplayStatus.test.ts（映射全表 + 汇总优先级 14 例）、tests/webui.test.ts（路由契约 200/400/404）。

## 六、发现并修复的问题 / 记录的偏差

**未发现需要改代码的问题；本轮未修改任何功能代码。** 过程中处理的两件事：

1. 基线体积测量装置（本报告自建自拆）：`.accept-wt` worktree + `node_modules` junction，用毕先 `rmdir` junction（主 node_modules 验证完好）再移除 worktree；它一度干扰 lint，已消除。
2. 首次构建前 lib/ 已含当日产物，故基线不走「git stash 重跑」而走 HEAD worktree 对拍（更可靠，见 §一体积台账）。

**记录的偏差/观察（均不阻塞，未动手改）**：

| # | 事项 | 说明 |
| --- | --- | --- |
| ① | docs/29 B.2「图标」列（◌/⏳/●/✔/✕）未在行内展示态 pill 落地 | 实现为「Pill(彩点)+文案+detail」三通道，达意无歧义；组卡异常 chip 保留 ✕ 前缀。属呈现取舍（Q6 开放项的变体），若用户要字形可后补 |
| ② | 空数据兜底文案措辞与 docs/28 原文略异（「今年还没有记录到消耗——…」vs 原文「本团队还没有 Token 消耗记录（统计自启用后开始）」） | 语义等价，无功能差异 |
| ③ | package.json 删除了空键 `"dependencies": {}` | 功能等价（peerDependencies/peerDependenciesMeta 契约不变）；docs 口径只陈述「运行时依赖为空集」，无文档强制该键 |
| ④ | docs/30 §四 row② 残留「10 表全域」表述 | 被同文 §5.4（roles 表 → 11 表）取代的中间态残留；docs/27 最终口径 11 表正确。按纪律未改 docs/30 结论性内容 |
| ⑤ | docs/28 体积预估偏低（+120KB min vs 实测 +855KB min） | 主因 @floating-ui/react 未计入预估；见 §一归因 |
| ⑥ | 依赖钉版本 `react-activity-calendar: 3.2.1`（非 ^3.2.1） | 比文档安装命令更严格，无害 |

## 七、遗留风险与装机冒烟清单（**全部未在真实宿主验证**）

以下各项在本轮验收中只能做到代码/测试级确认，装机（真实 DSH 宿主）冒烟时逐项目检：

1. **firehose 全量（E8/28.8-3）**：装机后确认 `usage.jsonl` 能收到本进程全部会话的 usage 行；若证伪方案 A，先验证 docs/28 B 方案 childCtx 覆盖面再降级，必要时 cordis `{ global: true }` 兜底。
2. **`ctx.sessions.list()` 覆盖面**：装机对账前提——确认其包含成员/领队子代理会话（E10/E18）。
3. **归属矩阵（28.8-3）**：成员子代理 / 领队子代理 / 领队主会话 / 面板绑定会话 / eteams-rolebuilder 构建子代理各跑一次，逐条核对 usage.jsonl 行的 `roleKind`/`teamId`（优先级表 1-5 行各至少一例）。
4. **usage 上报缺口（28.8-2）**：哪些 provider/adapter 在 assistant/message 缺 usage（低估面）；必要时 tooltip/文档标注「部分调用未上报」。
5. **reasoningTokens 与 outputTokens 重叠语义（28.8-1）**：DeepSeek adapter 实测；当前按「不计入 totalTokens、tooltip 注明可能与输出重叠」保守处理。
6. **拖拽真机手感（29 风险①）**：hover 高亮、drag image、Esc 取消、宿主全局 dragstart/dragover 干预、BrowserView 缩放下手感；触屏/键盘降级路径（点击/Enter 打开修改弹窗）实测可达。
7. **tooltip 挂点与暗色反色（28-M3）**：FloatingPortal 在 body 根，注入样式已在 <head> 且选择器 body 级——亮/暗两态目检确认深底浅字覆盖生效。
8. **亮暗主题跟随**：宿主切换暗色（body[data-ds-dark-theme]）时日历色板/tooltip/展示态色点全部跟随。
9. **60s 低频轮询**：面板不可见（document.hidden）时应静止不请求。
10. **轮转真实触发**：usage.jsonl 达 2MB 后老行搬入 usage-archive.jsonl、聚合读两文件合并、日历数字不回退。
11. **bundle 真实加载**：smokeEnvelope 是 Node 模拟求值；真实宿主 ModuleLoader 加载 5.1MB envelope 的加载耗时与内存表现需装机观察（docs/21 R1 阈值纪律）。
12. **1s 轮询与拖拽并发**：代码已保证 drop 以最新快照重算（抽查点 14），真机复核拖拽中快照替换不闪断。

**未做验证的面**：docs/16 的「装机后团队跑一轮任务 → 看板非空日历格 / tooltip 五分项正确」人工验收面；多工作区（28.6.3）与跨工作区移动团队的历史行归属。