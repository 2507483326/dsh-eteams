# 子代理「按文件追加留言 / 纪要」纪律（复盘 2026-09-22）

## 起因：一次拆解收口连报三次错

用户贴出的领队实况（主任务 #18 拆解 → 收口 → 记录）里有三处工具报错：

1. `eteams_create_task` 报「本对话已有主任务 #18…创建任务必须挂在其下（parentTaskId=18）」；
2. 编辑 `留言板.md` 报 `file changed since it was read — re-read the file, then retry`；
3. 重读后再编辑，报 `old_string was not found`。

三处都不是模型「能力不够」，而是**接口没把话说清**。用户裁决（2026-09-22）：**只改提示词**，不动工具行为（不做「漏传 parentTaskId 自动补」这类兜底）。

## 根因

### 1. parentTaskId：散文约束写在长段落中间

规程里其实写了两遍（回合决策表只在第 41 行提了「拆解」，参数要求埋在拆解条第 51 行的中段）。而宿主守卫是硬的：`runtime/assignment.ts` 的 `createTask` 里，本对话已有主任务时漏传 `parentTaskId` 直接拒绝、**不落库**（`tests/lifecycle.test.ts` 有 `#43–#45` 事故回归用例）。结果是模型白跑一轮、重发一次。

改法：把参数要求**提到动作发生的位置**——回合决策表的两条拆解路径（dispatch / commission）各点一次名，拆解条的**开头**再点一次（不再是段落中段），措辞从「必带」升级为「硬性参数不是可选项 / 漏传会被拒（白跑一轮）」。

### 2. 留言板 / 纪要的编辑闸：读到的快照必然过期

被编辑的两个文件都是**宿主托管 + 多方共享**的 Markdown：

- `<主任务号>-slug.纪要.md`：上半段由宿主**随状态幂等重写**（`runtime/docs.ts` 的 `renderTeamDocs` 挂在几乎每次状态变化之后：状态、当前执行人、执行链进度、执行记录都在上半段）。模型「读 → 调几个 eteams 工具 → 再 Edit」时上半段早已重写，即便它要改的下半段「纪要正文」一个字没动，编辑闸也判过期 → 报 `file changed since it was read`。
- `留言板.md`：领队与全员**并发追加**的共享文件，任何先读后写的窗口里都可能被别人改。
- 收口（`eteams_submit_task`）与改主题（`eteams_update_task`）还会经 `renameTaskFolder` 重排任务目录名（`teams/<主任务号>-slug`），**收口前拿到的绝对路径随之失效**——这解释了为什么同一轮里「读到的文件」和「要编辑的文件」会对不上。

模型撞闸后的第二跳更是纯损失：它凭记忆把上次读到的内容当 `old_string` 重试，于是 `old_string was not found`。

改法：把「怎么改才不撞闸」写成纪律，而不是只说「在末尾追加一行」：

- **读和改挨着做**（中间不夹任何 eteams_* 调用）；
- 追加取**刚读到的最后一行**当锚点（不要拿文件开头的标题 / 说明句当锚点）；
- 报错**照 hint 处置、绝不原样重试**：过期就重读再改，`old_string` 找不到就重读全文换锚点；
- 收口 / 改主题之后要写文件，先重调 `eteams_captain_guide` 取最新快照路径；
- 留言板条目里的日期以上下文里的「今天」为准，拿不准就别写（本次实况里模型手写的时间戳就是错的：板上记 09-19，实际 09-22）。

## 落点（都是纯文本，不改行为）

| 文件 | 改动 |
|---|---|
| `src/host/prompts/spawn/noteFiles.ts`（新） | 抽共用的 `NOTE_APPEND_DISCIPLINE`——领队与成员同一条口径，避免两处各自描述「追加一行」而漂移（与 `workDirs.ts` 的 `workDirsBlock` 同款：纯文本常量，不触盘） |
| `src/host/prompts/spawn/captainChild.ts` | 决策表两条拆解路径点名 `parentTaskId`；拆解条开头点死参数；留言板 / 纪要两条加交叉指向；新增「按文件追加纪律」条（共用纪律 + 收口改目录名的路径失效提醒） |
| `src/host/prompts/spawn/member.ts` | 成员简报新增「追加纪律（留言板与纪要共守）」段（共用纪律 + 完工顺序：读纪要 → 写纪要 → 再 `eteams_complete_task`，别把 complete 夹在读和写中间） |
| `src/host/prompts/steering/dispatch.ts` | 开跑批准正文第 4 条（记录）就地补「先读后追加、读改挨着做、报错重读」 |

测试：`tests/captainDispatch.test.ts`（追加纪律 + parentTaskId 点名）、`tests/memberBriefing.test.ts`（简报含追加纪律段）。

## 没做的事（用户裁决的边界）

- 不加 `eteams_board_note` / `eteams_minutes_note` 这类宿主侧追加工具（那才是结构性解法：追加不依赖读快照、时间戳由宿主盖章、省掉一次 Read 的上下文开销），本次按用户选择先走提示词。
- 不做 `parentTaskId` 漏传自动补齐。
- 不动编辑闸本身（那是宿主 harness 的行为）。
