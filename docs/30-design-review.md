# 30 设计审核报告（docs/27 / 28 / 29）

- 审核对象：[27 SQLite 表结构](27-sqlite-schema.md)、[28 看板每日 Token 消耗日历](28-token-usage-calendar.md)、[29 小任务拖拽指派 + 任务展示态](29-subtask-dnd-task-status.md)（2026-09-04 产出）。
- 审核方法：只读代码与文档；对三份文档的全部证据条目逐条回查原文（node_modules 包内 `.d.ts`/`.js`、`src/host`、`src/client`、`scripts`、既有 docs 基线），关键断言独立重推导而非复述；两个 npm 依赖用 `pnpm view` 实查元数据。证据抽查共 40+ 处（任务书要求 ≥15 处）。
- 严重度：**阻塞** = 不修订会做出错误实现或与基线矛盾；**建议** = 开工前修订成本低、收益明确；**备忘** = 已核实、需留意的瑕疵或实现提示。
- 本文是本轮审核唯一产出文件；未改动任何被审对象。

---

## 一、docs/27-sqlite-schema.md

**结论：需修订**（阻塞 1 · 建议 3 · 备忘 2；2026-09-04 用户复审另定 3 项，见 1.3）。表结构主体质量高：11 张表与 types.ts / docs/26 的映射逐字段核对全部成立，枚举 CHECK 与代码枚举零出入；唯一硬伤是 token_usage 表与 docs/28 的记录模型直接矛盾（27-B1）。**复审状态**：token_usage 矛盾已于 2026-09-04 双侧修订完成（token_usage 表已删，现为 10 张表）；1.3 三项用户定案也已于同日全部落进 docs/27（去硬约束、route 并单列、新增 roles 表，现为 11 张表）。

### 1.1 问题

| # | 严重度 | 问题 | 证据 | 建议修法 |
| --- | --- | --- | --- | --- |
| 27-B1 | 阻塞（跨文档，与 28-B1 同一冲突） | token_usage 表与 docs/28 的存储模型不相容，且 27 文档多处预设该表有写入：(a) 粒度——DDL 是日聚合 `UNIQUE(team_id, member_name, day)`（400），docs/28 是事件粒度 usage.jsonl + 「读取时聚合，**不落盘日汇总**」（docs/28:132）；(b) 归属维度——`member_kind` CHECK 只允许 `member/captain`（388-389），docs/28 的 roleKind 是 `captain/captain-child/member/conversation/workspace` 五值（docs/28:82）；(c) `team_id NOT NULL`（385-386）使 docs/28 的 workspace 桶（teamId=null，docs/28:80）无法入库；(d) 表无 provider/model 列（392-398），27.6.2 却把「member.modelRoute 拍平 4 列」的动机写成「token/看板聚合的连接维度（按模型/档位统计）」（480）——members.route_* 是活状态，成员移除/改名后与台账 join 断裂，与 docs/28「记录时打快照」的设计（28.3.2）相反；(e) docs/27 多处预设该表有写入：表注释「看板日历预留，docs/28 将详述」（380）、27.7 引言「未来 token 日历（docs/28）的典型查询」+ Q7–Q9（488、528-553）、27.8 阶段 1「看板聚合查询先行落地（Q6–Q9）」（612）。而 docs/28 全文 0 处提及 SQLite/token_usage | docs/27:380-404、480、488、528-553、612；docs/28:132、249-257 | 三选一，两文档同步落笔：①（推荐）docs/27 删除表 8 与 Q7–Q9、idx_token_*（403-404），27.6.2 删该动机行，27.7/27.8 改口「token 日历存储由 docs/28 的 usage.jsonl 承担」；② token_usage 降级为「阶段 1 可选投影表」，行模型按 docs/28 对齐（role_kind 扩 5 值、team_id 可空或独立桶、加 provider/model、attempt_count 注明来源），docs/28 增「与 docs/27 的衔接」小节；③ docs/28 改为写 token_usage（放弃 28.4 的论证，不推荐）。无论哪种，27.9-1（627）应从「开放问题」改写为「已由 docs/28 定案：采集点 = session/event firehose，粒度 = 事件行」 |
| 27-S1 | 建议 | Q8 跨团队汇总口径 `SUM(input_tokens + output_tokens + reasoning_tokens)`（542）漏 cacheRead/cacheWrite 且把 reasoning 计入总量，与 docs/28 的计费口径（input+output+cacheRead+cacheWrite，reasoning 不计入，docs/28:120）不一致 | docs/27:542 vs docs/28:120 | 统一为计费口径四项和（若 27-B1 走删除路线则随之消失） |
| 27-S2 | 建议 | 27.9-9 记录了 docs/05 与 types.ts 的 createdBy/cancelReason/MailKind 漂移（635），漏了 AttemptKind：docs/05.4:141 的 attempt kind 含 `'resume'`（attempt status 另含 `'resumed'/'note'`，docs/05:159），types.ts:43 无 `'resume'`；27.5 attempts.kind CHECK（274）按 types.ts 只含 initial/stage/retry/reassign。现实现 resumeTask 用 kind:'reassign'，漂移真实存在且影响「建表前统一文档与类型」的清单完整性 | docs/27:635、274；docs/05-data-model.md:141,159；src/host/model/types.ts:43 | 27.9-9 补一行 AttemptKind/AttemptStatus 漂移（口径同现规则：本文按 types.ts，docs/05.4 待改） |
| 27-S3 | 建议 | docs/README.md 阅读顺序表（9-32）未收录 27/28/29；docs/27 自身无实现切面清单，docs/29 的 29.3 也漏了 README 行（docs/28 的 28.7 有同款条目）。README 纪律「文档按主题拆分、跨文档结论以本文为准」要求编号落位 | docs/README.md:9-32,83；docs/28:244,257；docs/29:324-338 | 三篇落位时一并补 README 行；docs/29 的 29.3 补该条目 |
| 27-M1 | 备忘 | DDL 注释节号重复：roster_members 与 tasks 都标「-- 3.」 | docs/27:194,216 | 顺延修正 |
| 27-M2 | 备忘 | token_usage.member_name 注释「领队子代理 = '领队'」（387）与 docs/28 的 roleKind='captain-child' 命名体系不同源（captain-child 的事件归属在 docs/28:106 按注册表解析，不是按名字）。两套口径合并时以 27-B1 的处置为准 | docs/27:387-389 vs docs/28:106 | 随 27-B1 一并处理 |

### 1.2 已核实通过的要点

- 枚举 CHECK 与 types.ts 逐一比对无出入：TeamPhase（types.ts:13）、PlanReviewState（16）、TaskStatus（19-32，13 态）、AttemptKind（43）、AttemptStatus（46-47）、MemberStatus（100）、Actor.kind（184，含 plugin/system）、MailKind（200）。
- roster_members ↔ RosterMember（src/host/runtime/roster.ts:22-48）逐字段对应（name/employee_id/role/duty/style/skills/rules/execution_prompt/persona_md/provider/model/reasoning_effort/avatar_seed/salt/updated_at）；employee-seq.json → schema_meta('employee_seq') 与 roster.ts:56-64 的计数器文件对应（DDL 注释 111 已声明取代关系）。
- TeamState/TaskRecord/AttemptRecord/DecisionRecord/EventRecord/MailMessage → 表映射（27.6.1）逐字段核对通过；`mail_seq 现实现闲置、按箱内行数发号`（141、448、27.9-8）与 notifier.ts:19 注释一致；「archived_at 取代目录搬移」（451）的映射诚实。
- tasks 的 group 库级 CHECK（258）正确落 docs/26.3 的禁 chain/dependencies/parent；「父必须 draft/ready」「依赖查环」留应用层，与现实现一致（432 已声明）。
- node:sqlite 选型与 package.json engines（`^22.19.0 || >=24`，package.json:28-30）兼容；27.9-11 对 Experimental 警告与 better-sqlite3 兜底（同一 DDL）的交代充分。
- 27.8 迁移三阶段与 docs/09 的原子写（09.2）/锁（09.3）/乐观版本（09.4）衔接描述与代码现状一致（atomicWriteText 的 Windows 重试协议在 src/host/state/store.ts:25-51 原样存在；withTeamLock 单写者假设见 620 行的演进说明）。

### 1.3 用户复审意见（2026-09-04）

> 三项都是用户定案，只改 docs/27，一次说清：**每张表只保留三样东西——列定义、主键、普通索引。** 不留外键、不留 CHECK、不留 UNIQUE、不留触发器；删除由代码在一个事务里逐表删，合法性由写入代码校验。现在的 JSON 实现正是这样工作的，SQLite 不额外引入约束面。

| # | 严重度 | 用户意见 | 现状与证据 | 修订要求 |
| --- | --- | --- | --- | --- |
| 27-B2 | 阻塞（用户定案） | 去掉外键依赖、删除时的外键判断和表硬约束——表结构臃肿，要小学生都能读懂 | docs/27 的 DDL 现有四层硬护栏：① FOREIGN KEY——7 张表 `REFERENCES teams` 级联删除，另有任务表自引用、attempts/decisions 指向任务的外键，连接时还要开 `PRAGMA foreign_keys`；② CHECK——枚举值限定、`json_valid` 校验、group 禁 chain/dependencies/parent 的库级守卫，出现在 9 张表里；③ UNIQUE——成员重名、工号、邮箱幂等键；④ 触发器——events 禁改写。为解释这套护栏，文档多写了三段说明（删除行为总表、group 守卫、改枚举值要重建表迁移）——读懂表结构之前得先读懂 SQLite 约束语义 | 四层全拿掉，每张表只剩列定义 + 主键 + 普通索引：① 删 FOREIGN KEY——删团队 = 代码在一个事务里逐表 DELETE（先删成员/任务，再删尝试/决策/事件/邮件，最后删团队行）；删任务单 = 先删它的小任务、尝试、决策，再删它自己；② 删 CHECK/`json_valid`——枚举合法、JSON 格式、group 守卫由写入代码校验，以后改枚举值不用动表结构；③ 删 UNIQUE——重名/工号查重、邮箱按 id 幂等由写入代码保证；④ 删触发器——events 只插入不改写由代码纪律保证；`PRAGMA foreign_keys` 一并删除。主键保留（行身份必需），普通索引保留（查询用） |
| 27-B3 | 阻塞（用户定案） | 生效路线快照为什么要 4 个字段？ | 这 4 列是成员模型路线的 4 个属性：route_provider（服务商）、route_model（模型名）、route_reasoning_effort（推理档位）、route_source（来源：继承/覆盖）。拆成 4 列是为了按列筛选/导出——这个用途随 token 表删除已经没有了；同类字段 teams.leader_model_route 本来就是一整列 JSON 文本 | 合并成 1 列 `route TEXT`：整段 JSON 存进一列（provider/model/reasoningEffort/source 原样保留），要读整读、要写整写。members 表少 3 列 |
| 27-B4 | 阻塞（用户定案） | 缺少角色表 | 角色现在没有自己的表：members.role / roster_members.role 只存一个标签字符串（如 engineer）；标签背后的定义——职责、技能、风格、纪律、角色手册全文——硬编码在 src/host/prompts/persona.ts 的 `ROLE_TEMPLATES` 代码常量里；角色构建师做出的新角色只写在 rolebuilder.json 临时文件里。在库里查不到「engineer 是什么」 | 加一张 roles 表（草图见下）：一行一个角色，标签背后是什么一目了然。成员行的 role 列照旧存标签名，用到时按名来 roles 表查定义，查不到回退通用模板；代码里的预置角色首次启动时写入 roles，角色构建师确认的新角色也写入 roles |

roles 表草图（每列一句人话注释，无外键无约束）：

```sql
CREATE TABLE roles (
  name             TEXT PRIMARY KEY,  -- 角色标签名；成员行的 role 存的就是它
  duty             TEXT,              -- 职责一句话
  skills           TEXT,              -- 技能清单
  style            TEXT,              -- 行为风格
  rules            TEXT,              -- 角色纪律，JSON 数组
  execution_prompt TEXT,              -- 每次唤醒注入的提示词
  persona_md       TEXT,              -- 完整角色手册（Markdown 全文）
  provider         TEXT,              -- 默认模型：服务商（可空）
  model            TEXT,              -- 默认模型：模型名（可空）
  reasoning_effort TEXT,              -- 默认模型：推理档位（可空）
  source           TEXT,              -- preset=代码预置 / builder=角色构建师做的 / manual=手工加的
  updated_at       INTEGER NOT NULL
);
```

- 角色定义从此只有一个存放处：代码里硬编码的预置角色，首次启动时写入 roles；角色构建师确认的新角色，确认时写入 roles。
- 成员用到角色时按标签名查 roles 表，查不到就用通用模板（行为与现在一致）；团队采纳成员时仍把定义复制进成员自己的人设字段，roles 表是模板真相。

---

## 二、docs/28-token-usage-calendar.md

**结论：需修订**（独立阻塞 0 · 跨文档阻塞 1 · 建议 3 · 备忘 4）。核心 seam（方案 A）在实现层成立，且有第一方同型先例佐证；依赖、路由落点、前端规格全部核实通过。修订项集中在：与 docs/27 的衔接（唯一阻塞）、方案 B 语义改写、装机冒烟扩面。

### 2.1 问题

| # | 严重度 | 问题 | 证据 | 建议修法 |
| --- | --- | --- | --- | --- |
| 28-B1 | 阻塞（跨文档） | 与 docs/27 表 8 的存储真相矛盾（27-B1 的另一面）：docs/28 选定 usage.jsonl + 读时聚合并明确「不落盘日汇总」，全文 0 处提及 SQLite/token_usage；而 docs/27 的注释、索引、查询场景、迁移阶段 1 都预设 token_usage 有写入。两文档被列为同期落位（28.8-7 自认），任何一边先开发都会做出与另一边矛盾的存储 | docs/28:132、257；docs/27:380-404、612 | docs/28 增「与 docs/27 的衔接」小节（usage.jsonl 是唯一记账真相；docs/27 表 8 删除或降级为投影），28.7 清单补 docs/27 行 |
| 28-S1 | 建议 | 方案 B（降级开关）的「仅该子代理子树」覆盖语义未被证据支持，且很可能不成立：E11 引的 activation-setup-registry.d.ts:15-22 只说明 childCtx 是「child's unpublished **scoped** context」（API 形态），不构成事件路由证据。实现层 `session/event` 的 scope 载体 key = `scopeOf(store ctx)`（dsh-session/lib/index.js:1695），tagged 监听者能否只收子树取决于 sessions store 的挂载拓扑——node_modules 内无 SessionStore 实例化点（在闭源宿主 app 内），无法证实。类型注释「agent-scoped listeners receive only sessions entered through that agent's context」（dsh-session/lib/types/index.d.ts:59-60）反而暗示按 agent scope 打标。A 成立时 B 只是纸面兜底，但 28.8-3 一旦证伪 A，按现文实现 B 有整体收不到事件的风险 | docs/28:36（E11）、63（28.2.3-5）、253（28.8-3）；dsh-subagent/lib/types/activation-setup-registry.d.ts:15-22；dsh-session/lib/index.js:1695；dsh-session/lib/types/index.d.ts:59-60 | E11 与 28.2.3-5 改写：B 的覆盖面标注「未核实，启用前需装机验证 childCtx 监听的实际覆盖面」；补一句 cordis 监听可带 `{ global: true }` 绕过 scope 过滤（cordis/lib/index.js:258-264）作为兜底的兜底；28.8-3 增「若证伪 A，先验证 B 语义再动工」 |
| 28-S2 | 建议 | 28.3.4 的对账面依赖「插件根 ctx 可解析 ctx.sessions 且 list() 覆盖成员/领队子代理会话」，类型面无保证（store 实例化点不可见，文档也未列为装机验证项）。实际上有第一方同型先例可引：dsh-session-persistence 在插件安装路径上做 `ctx.on("session/created")` + `ctx.on("session/event")` + 遍历 `ctx.sessions.list()`（index.js:1152-1162）——正是方案 A + 水位对账的同型实现，且持久化插件必须收全量会话事件才能成立。补进证据表可把「推断」升级为「第一方同型先例」 | docs/28:61、127；dsh-session-persistence/lib/index.js:1152-1162 | 证据表补一行「E18：dsh-session-persistence 同型先例（ctx.on session/event + ctx.sessions.list()）」；28.8-3 装机项加「ctx.sessions.list() 含成员/领队子代理会话」用例 |
| 28-S3 | 建议 | 28.8 的装机冒烟只覆盖成员子代理路径（253）；28.3.2 归属表第 3/4/5 优先级（领队主会话、面板绑定会话 conversation 桶、eteams-rolebuilder workspace 桶）没有验证用例，而归属正确性是日历数字的根基 | docs/28:101-109、252-253 | 28.8-2/3 合并为一组归属冒烟矩阵：成员子代理、领队子代理、领队主会话、面板绑定会话、构建子代理各跑一次，核对 roleKind/teamId |
| 28-M1 | 备忘 | 28.6.3 工作区解析引用 members.ts:237——该行是 `child.session?.header?.cwd ?? process.cwd()`，cwd 可缺省且有回退；usage 写入侧若照抄「按 header.cwd 解析」需保留同一回退，否则 header.cwd 缺失的会话被错桶 | docs/28:207；src/host/runtime/members.ts:237 | 28.3.2/28.6.3 补回退与告警 |
| 28-M2 | 备忘 | BoardTab 取数 useEffect 的位置约束未写：须置于早退分支（eteamsView.tsx:1029-1043 空态）之前（rules-of-hooks）；28.5.2 只写了「无团队空态分支不涉及本卡」 | docs/28:188；src/client/eteamsView.tsx:1029-1043 | 28.5.2 补一句 hook 位置约束 |
| 28-M3 | 备忘 | tooltip 样式覆写「在 .eteams-ui 作用域追加覆写」需确认 tooltip DOM 挂点：floating-ui tooltip 渲染位置若在 portal 根（body 下）而不在 .eteams-ui 子树内，作用域选择器不命中（eteams.css 的暗色块同为 body 后代选择器可覆盖，但需实测确认） | docs/28:186；src/client/eteams.css:116-146 | 实现时确认挂点；必要时选择器提到 body 级并加 data-source 标记 |
| 28-M4 | 备忘 | 28.5.1 的 v3 prop 断言（theme/tooltips/showWeekdayLabels/showColorLegend/labels）自标「以 tarball build/index.d.ts 为准」但未附行号证据；本审核核实了 peer/deps/exports/type（见 2.2），prop 级断言留待安装后校准 | pnpm view（见 2.2） | 实现首日按安装后的 build/index.d.ts 校准 prop 名 |

### 2.2 已核实通过的要点（含 pnpm view 实查）

- **依赖元数据（pnpm view，2026-09-04 实查）**：react-activity-calendar@3.2.1 peerDependencies `{ react: "^18.0.0 || ^19.0.0" }` ✓；dependencies `@floating-ui/react ^0.27.19` + `date-fns ^4.2.1` ✓；exports 含 `./tooltips.css` ✓；`type: module`（ESM，Rolldown 以 bundler 输入消化，radix/lexical 同面）✓。28.5.1 的三条断言全部成立；本仓 react ^18.2.0（package.json:84）满足 peer，无升级动作。
- **方案 A 核心语义在实现层成立（独立重推导）**：cordis dispatch 过滤为 `hook.global || !filter || filter.call(thisArg, hook.ctx)`（node_modules/@deepseek-ai/cordis/lib/index.js:258-264）；dsh-scope 的 scopeTarget 载体过滤器对未打标监听 ctx 恒放行（`tag = scopeOf(listener ctx); if (tag === undefined) return true`，dsh-scope/lib/index.js:327-338）；eteams 插件 ctx 无 scope 标签（src/host/index.ts:84-117 直接 register，无 createScope）。且 **dsh-session-persistence（DSH 第一方持久化插件）正是同型实现**：`ctx.on("session/event")` + `ctx.on("session/created")` + 遍历 `ctx.sessions.list()`（dsh-session-persistence/lib/index.js:1152-1162）——它必须收全进程所有会话的事件才能完成持久化职责，方案 A 从「类型注释推断」升级为「有第一方先例」。28.8-3 的装机冒烟仍应保留。
- E9 核实：构造种子不触发 session/event（dsh-session/lib/types/index.d.ts:124-145 原文「constructor seeds do not emit」）——重启不双计成立，28.3.4 水位补折的前提正确。
- E1-E8、E10-E17 抽查全部与 node_modules 原文一致：E7 实现链（dsh-session/lib/index.js:1444-1484，逐监听者 contain）；E10（session/created 36-44、get/list 390-398）；E4（EpochHeader 191-200、request/context 323-335、LlmCallConfig.provider/model call-config.d.ts:16-23、requestContext() index.d.ts:229-234）；E5/E6（SubagentResult 与 subagent/start|end 负载均无 usage/label）；E14（SessionStatsProjection.decodeTokens 确为输出子集，无输入/缓存维度）；E15（TokenMeter.measure 是请求压力快照非台账）；E16（投影注册表 eager drive + 检查点 37-68、106-144、185-222）；E17（events.ts 容错读 13-35、appendEvent 51-58、atomicWriteText store.ts:25-51）。
- 路由落点核实：GET `/team/<id>/...` 段（webui.ts:1489-1561）、locateTeam 调用点 1492（定义 1575）、sendJson/sendError（376-391）——28.4 的新子路由与既有 405 守卫（1470-1473）不冲突，`year > 当前年返回空 days` 的设计可无脑切年。
- usage.jsonl 追加写与 docs/09 自洽：events.jsonl 同型先例；不走 per-team 锁的理由（工作区级文件 + 模块级 Promise 链串行队列）成立；checkpoint/轮转用 atomicWriteText 正确；读侧 `(sessionId, seq)` 去重对「追加成功、checkpoint 未及推进」的重折免疫。
- 亮暗主题链路核实：mdEditor.tsx:85 样式字符串模块先例 + mdEditorCss.d.ts 垫片存在；useHostDark（157-169）+ `body[data-ds-dark-theme]`（eteams.css:116-146 暗色 token 块）与 28.5.2 规格一致。
- 28.7 切面清单完整（usage.ts/index.ts/members.ts/webui.ts/api.ts/eteamsView.tsx/useHostDark/垫片/package.json/测试三件/README/12 回写）；28.8 对 reasoning 重叠语义、usage 上报缺口、E8 装机验证的开放问题划分合理。
- 28.6 边界自洽：轮转「>730 天」与「日历只查当前年+上一年」一致；跨年无结转；out-of-process 盲区（28.6.5）与 memberProvider 默认 spawn（cordis.patch.yml:28）的声明准确。

---

## 三、docs/29-subtask-dnd-task-status.md

**结论：通过**（阻塞 0 · 建议 4 · 备忘 3）。客户端守卫（DA6 `chainCursor===-1` 才注册 drop）把 host 侧三个已知缺口全部挡在拖拽入口之外，「host 零改动」路径成立；13 态→6 展示态映射与用户四档口径完全对齐。建议项修订成本低，建议开工前顺手落笔。

### 3.1 问题

| # | 严重度 | 问题 | 证据 | 建议修法 |
| --- | --- | --- | --- | --- |
| 29-S1 | 建议 | DA9/冲突③处置表述过宽：拖拽只能替换「框内站点」（下一待执行站，A.3.1 行 3）；悬空名若在**其余站点**（chainCursor===-1 的多站链），「其余站点原样重发」会把悬空名一起发回，被 assignment.ts:195-198 逐站校验拒绝 → 400。这与 DA9「拖入新成员到该框即替换悬空名（悬空名的唯一面板修复路径）」（51）和冲突③处置「替换后的整链不含悬空名、可过校验」（378）矛盾——只有悬空名恰在下一待执行站时论断成立；chainCursor≥0 时框只读，悬空名同样修不了 | docs/29:51、93、378；src/host/runtime/assignment.ts:193-198 | DA9 收窄为「悬空名位于下一待执行站时拖拽可修」；A.7 边界表补一行「悬空名在其余站点：拖拽与修改弹窗整链重发均被 host 拒绝（既有雷），面板修复路径须等开放问题 Q2 的 host 放行」 |
| 29-S2 | 建议 | 与 README 决策记录 D14 的关系未声明：D14（docs/README.md:53）记录「用户可拖拽成员入槽分配（staged 填链、ready 指派；偏离需确认说明；in_progress 禁用）」，29.A 的拖拽语义是 staged/ready 一律只填链槽位——ready 拖入不产生 assignee、不触发指派通知（指派仍由领队 eteams_assign_task/advance 执行）。README 纪律「如需变更，先改本表再改对应文档」（README:83），docs/29 全文未提 D14，验收时会按 D14 字面追问「ready 拖入为什么没指派」 | docs/README.md:53,83；docs/29:45（DA3）、48（DA6） | 增一小节「与 D14 的关系」：声明细化口径（拖拽=链槽位编辑；ready 指派路径由领队工具承担；纯填链语义下 D14 的「偏离需确认说明」不触发），或在 README D14 行加注记 |
| 29-S3 | 建议 | A.5.3 把用户原话「在任务下方把所有成员罗列出来」改为区块级单条（罗列条放在区块头与第一张组卡之间）。文档已自证理由（同队成员对全部组卡相同、去重、置顶视线），但属用户可见的布局变更 | docs/29:3（用户原话自引）、190-196 | 开发前向用户确认一次；若坚持逐卡罗列，组件按摆放位置参数化保留回退（成本低） |
| 29-S4 | 建议 | 29.3 实现切面清单缺 docs/README.md 阅读顺序表补行（28.7 有同款条目，28.8-7 也点名三篇一起增补） | docs/29:324-338；docs/28:244,257 | 29.3 补 docs/README.md 行 |
| 29-M1 | 备忘 | 风险③引证「teamOps.ts:243-253 上限 10 人」不准确：代码上限是 `env.config.maxMembers`（teamOps.ts:248），默认 8（cordis.patch.yml:24）；「10 人含领队」是代码注释里的用户口径（244-246） | docs/29:383；src/host/runtime/teamOps.ts:243-253；cordis.patch.yml:24 | 改为「上限 = maxMembers 配置（默认 8）」 |
| 29-M2 | 备忘 | 引证行号小漂移：E1「types.ts:99-167」（TaskRecord 实为 146-180，目标字段 kind/parentId/chain 在 153/155/164，范围内但夹带 MemberRecord 段）；E17「209-223」偏宽。不影响开发 | docs/29:11,27；src/host/model/types.ts:145-180 | 顺手校准 |
| 29-M3 | 备忘 | B.2 中 awaiting_decision/needs_user 行内 pill 点色 warning 黄、组卡汇总 chip 用 err 红，cancelled 同桶中性灰——同桶异色已写明，实现时按 B.2 逐格对表，避免实现走样为「error 桶一律红」 | docs/29:271-275,291 | 实现时对表 |

### 3.2 已核实通过的要点（含 pnpm view 实查）

- **依赖元数据（pnpm view 实查）**：react-dnd@16.0.1 peer `{ react: ">= 16.14" }` ✓、dependencies 含 `dnd-core ^16.0.1` ✓、`type: module`（ESM-only）✓；react-dnd-html5-backend@16.0.1 无 React peer ✓、依赖 dnd-core ^16.0.1 ✓、ESM ✓。A.2 的版本/peer/ESM 三条断言全部成立（文档未声称 engines，无冲突）。打包面：tsdown external 仅 `@deepseek-ai/*`/react/react-dom（tsdown.config.ts:3），client 段 CJS + inlineDynamicImports + conditionNames（120-153）；react-dnd 不在 `dsh.client.inject` 清单（package.json:45-51）→ 属 bundler 输入，E18/E19 结论成立；wrapClient.mjs:1-25 的 envelope 机制核实（loader 注入 react/jsx-runtime + inject 清单）。
- **host 缺口①亲自证实**：updateTask 状态闸只查 draft/ready（assignment.ts:175-180），而链中间站完成后任务回 ready 且 chainCursor+1（assignment.ts:767-770）——`ready && chainCursor≥0` 的任务确实可整链替换，宽于 docs/06.4:93「draft/ready（chainCursor=-1）可整体编辑」。DA6 的客户端守卫是正确的临时闸，Q1 的 host 补齐建议成立。
- **冲突①证实**：createTask 拒空 stageBrief（assignment.ts:96-98）、updateTask 不校验（193-199）——不对称真实存在，拖拽只走 update 通道不受影响。
- **冲突③证实**：removeMember 只置 status='removed'、不清 chain（teamOps.ts:595）。
- **E14/2522 证实**：成员状态 pill 复用 STATUS_LABELS（eteamsView.tsx:2522），且 `STATUS_LABELS['ready']='待指派'` 对成员态本就词表错位——冲突④的共存策略（B.3：STATUS_LABELS 降级为 13 态精确词表、展示态映射只用于任务位）是正确解法。
- **STATUS_GROUPS 单消费方**：全仓仅 eteamsView.tsx:163（定义）与 4446（顶层分组行）两处，收敛影响面即 B.3 所述，无隐藏消费方；TasksTab 单实例（定义 4258、唯一挂载点 973），A.6「单实例单 Provider」成立；挂载/卸载条件（972-979）证实 Provider 随 tab 销毁重建、1s 轮询只换数据不重挂（monitor.ts:24、218-250）。
- **拖拽技术面**：TasksTab 单实例同文档注入（docs/03-tech-stack.md:59 iframe 已放弃、package.json:52 platform:'web'）、HTML5 backend 无跨文档 dataTransfer 问题——A.6 结论成立；触屏取舍与点击降级路径（A.7）可达。
- 其余抽查一致：E2 saveEdit 整链重发（eteamsView.tsx:4293-4324）、E3 readChainParam 逐字段收紧（webui.ts:1112-1147、1617-1626）、E7 stationStatusOf（webui.ts:103-115）、E8 快照单列 captain（webui.ts:185-259）与 addMember staged 初始（teamOps.ts:286）、E10 快照滤 removed（webui.ts:236）、E12/E13 小任务行与 TaskStations（4387-4440、533-557）、E15 completeGroupIfDone（assignment.ts:1035-1055）、E20 Avatar（avatar.tsx:43-70）、E22 refreshActivitySoon/FormErrorNote（monitor.ts:343-345、eteamsView.tsx:432-447、4599/4641）、E23 1s 整包替换（monitor.ts:24）。B.2 的 13 态映射与 types.ts:19-32、taskMachine.ts:21-43 逐一可对，blocked 恢复（taskMachine.ts:82-94）与 POISON 集（97-102）引证准确，group 汇总优先级与 POISON 传染语义一致。

---

## 四、用户需求覆盖度核对

| 用户需求 | 承接文档 | 覆盖结论 |
| --- | --- | --- |
| ① 看板 react-activity-calendar 记录每日 TOKEN 消耗 | docs/28 | 覆盖 ✓：全年日历 + tooltip 五分项（28.5.2）；无数据兜底（全 0 档照渲 + 兜底文案 + FormErrorNote）、亮暗主题（useHostDark + theme 双色板）均有规格；精度盲区主动声明（28.6.5）。依赖核实通过（2.2） |
| ② SQLite 管理角色/团队/任务表结构（先不做改造） | docs/27 | 覆盖：10 表全域（schema_meta/teams/members/roster_members/tasks/attempts/events/mail_messages/decisions/task_status_changes；原表 8 token_usage 已按 27-B1 修订删除），27.8 阶段 0 明确「纯设计、不建库不迁移」，边界与要求一致。2026-09-04 用户复审另定三项结构性修订（1.3）：表硬约束全拆（27-B2）、route 拍平 4 列合并单列（27-B3）、**新增 roles 角色表**（27-B4——原设计角色只是标签列，模板硬编码在 persona.ts，缺独立表）；roster 映射无缺口（27-S3 的 README 行除外） |
| ③ 小任务后加成员框 + 任务下方罗列全部成员 + 拖拽到成员框 | docs/29 | 功能面覆盖：成员框（A.5.1）、成员罗列条（A.5.3）、拖拽语义（A.3）齐备，host 零改动可行。两处需注意：罗列条从「每张组卡下方」改为「区块级单条」偏离用户原话字面（29-S3，开发前确认）；ready 状态拖入只填链不指派，与 README D14 的「ready 指派」字面有出入（29-S2，需声明口径） |
| ④ 任务状态 初始化→已创建→等待执行→进行中→已完成 + 错误标记 | docs/29 | 覆盖：13 态全覆盖映射（B.2）：draft→初始化、ready→已创建、assigned/blocked/paused/suspended→等待执行、in_progress/retrying→进行中、completed→已完成、failed/awaiting_decision/needs_user→错误；cancelled 单列「已取消」（归 error 桶但中性灰），处置合理；底层 13 态状态机不动，detail 保留 13 态精度（B.3），成员 pill 复用面已隔离 |

---

## 五、开发前必须修订清单（阻塞项）

1. **docs/27 表 8（token_usage）与 docs/28 记录模型的矛盾**（27-B1 / 28-B1，同一冲突，两文档同步修订）：
   - 推荐：docs/27 删除表 8（380-404）、查询 Q7–Q9（528-553）、idx_token_* 索引、27.6.2 的 route 拍平动机行（480），27.7 引言与 27.8 阶段 1 改口「token 日历存储由 docs/28 的 usage.jsonl 承担」，27.9-1 改写为已定案；docs/28 增「与 docs/27 的衔接」小节，28.7 补 docs/27 行。
   - 备选：token_usage 降级为「阶段 1 可选投影表」，行模型按 docs/28 对齐（role_kind 5 值、team_id 可空或独立桶、provider/model 列），docs/28 同步声明衔接关系。
   - 不修的后果：阶段 1 落地时按 Q7–Q9 建 token_usage 写入路径，与已上线的 usage.jsonl 形成两份互不知情的 token 真相。
   - 状态：**已完成**（2026-09-04 双侧修订：docs/27 删表 8/Q7–Q9/idx_token_*、27.9-1 定案；docs/28 增 28.3.5 衔接小节与 28.7 联动行）。
2. **docs/27 表结构去硬约束**（27-B2，用户定案 2026-09-04）：DDL 里不留 FOREIGN KEY、CHECK、UNIQUE、触发器、`PRAGMA foreign_keys`——每张表只有列定义、主键、普通索引。删团队/删任务单的级联由代码在一个事务里逐表 DELETE（先子后父）；枚举、JSON 格式、group 守卫、重名/工号查重、邮箱幂等、events 只插不改，全部由写入代码保证。
3. **members 的 route 四列并成一列**（27-B3，用户定案 2026-09-04）：改为 `route TEXT`，整段 JSON（服务商/模型名/推理档位/来源）存进一列，整读整写。
4. **docs/27 增加 roles 角色表**（27-B4，用户定案 2026-09-04）：一行一个角色，存职责/技能/风格/纪律/手册全文/默认模型路线/来源（草图见 1.3）；成员行只存角色标签名，按名查定义；预置角色首启写入、角色构建师产物写入。

## 六、可以带进开发的建议

1. docs/28 证据表补「E18：dsh-session-persistence 同型先例」（dsh-session-persistence/lib/index.js:1152-1162：ctx.on session/created + session/event + ctx.sessions.list()），并把「ctx.sessions.list() 含成员/领队子代理会话」列入 28.8-3 装机项（28-S2）。
2. docs/28 方案 B 的覆盖语义改写为「未核实」并补 cordis `{ global: true }` 兜底（28-S1）；装机冒烟扩成归属矩阵（28-S3）。
3. docs/28 实现时落实两处细节：header.cwd 缺省回退（28-M1）、BoardTab 取数 hook 置于早退分支前（28-M2）；tooltip 挂点确认（28-M3）。
4. docs/29 DA9/冲突③处置收窄 + A.7 补悬空名边界（29-S1）。
5. docs/29 增「与 D14 的关系」声明或 README D14 注记（29-S2）；A.5.3 布局决策开发前向用户确认（29-S3）。
6. docs/29 29.3 补 docs/README.md 行；三篇 README 阅读顺序行落位时一并增补（27-S3、29-S4）。
7. docs/27 27.9-9 补 AttemptKind/AttemptStatus 漂移；Q8 汇总口径统一为计费口径；DDL 注释节号顺延（27-S1/S2、27-M1）。
8. 引证行号校准（27/29 各一处，29-M1/M2），不影响开发，顺手修正。