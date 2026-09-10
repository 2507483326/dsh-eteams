# Taste
- 子代理完成任务（如上报待确认草稿）后应直接收束回合，不停驻/阻塞等待用户确认；收尾用一句话告知用户「请到面板确认」，确认动作由宿主直接处理，无须子代理在场。停驻（如 eteams_build_wait）已全面移除（2026-09-08 用户拍板原话「改成 结束回合等唤醒」，连「等技术性落盘」的例外分支也一并撤掉）：start/continue/restart/resume 四阶段提示词里所有 build_wait 分支（访谈中转 popSelf=false、弹窗被拒/报错、弹窗被关闭/未答）一律改为「上报后立即结束本回合（不要 eteams_build_wait、不要停驻）」——宿主把问题中转到用户所在对话，答案经唤醒链路（deliverToChild → sendMessage/followup）送达子代理新回合后继续起草。 Confidence: 0.9
- 功能改动收尾前跑全套验证、全绿才宣布完成：vitest 全量测试、`tsc --noEmit` 分别跑 tsconfig.host.json 与 tsconfig.client.json、对改动文件跑 eslint。 Confidence: 0.8
- 用户以中文交流，回复与总结应使用中文。 Confidence: 0.85
- 开发环境是 Windows（C:\eTeam）：shell 命令避免 Unix 专用工具（如 tail、管道 grep），直接运行命令即可。 Confidence: 0.9
- shell 受命令白名单限制：`ls`/`dir` 会被拦，工程外路径（如 C:\Users\epat\AppData 下的应用安装目录）查不了；目录/文件探查优先用 glob/grep/read_file 工具，确需 shell 时改用可用命令（如 find）。cmd 里 `ls`/`stat` 等 Unix 命令不存在（报「系统找不到指定的路径」），目录列表、产物/源码时间戳对比改用 powershell 工具（Get-ChildItem / Get-Item 查 LastWriteTime），已验证可用。多行 `node -e "..."` 在 cmd 下会因换行/转义静默失败（无输出也不报错）——复杂探查逻辑写成临时 .mjs 脚本执行；scratchpad 临时目录对 shell 写入受限，但 write_file 写 commandcode scratchpad（…\Temp\commandcode\…\scratchpad\*.js）后 node 直跑已多次验证可行（2026-09-07 mdeditor 排查的探查/实验脚本全走此路；嵌套引号把 node -e 一行式吞掉后改脚本文件即解决）——复杂探查脚本优先 write_file 写 scratchpad 执行，跑完即删；shell 写入场景才落仓库工作区（如 C:\eTeam\inspect-tmp.mjs）；再实证（2026-09-08 README prettier 校验流）：shell 重定向（>）写 scratchpad 文件本身可行（`git show HEAD:README.md > %COMMANDCODE_SCRATCHPAD%\README.orig.md`、prettier 输出落 scratchpad 再 fc 对比，多次成功）——临时对比类文件优先 shell 重定向落 scratchpad，不进仓库工作区。 Confidence: 0.75
- pnpm/corepack 垫片在这台机器上不可用（corepack 报错）：直接调用 `node_modules\.bin\*.cmd`（vitest.cmd、tsc.cmd、eslint.cmd）运行工具链；直接 `node node_modules\...` 也已验证可用（`node node_modules\vitest\vitest.mjs run`、`node node_modules\typescript\bin\tsc -p <tsconfig> --noEmit`、`node node_modules\eslint\bin\eslint.js <files>`）；npm 本体可用，项目脚本直接 `npm run <script>`（`npm run build` 已验证）。2026-09-08 更新：`pnpm typecheck` / `pnpm lint` / `pnpm test` 直跑已连续成功（v12 system 角色全轮验证），垫片问题未再复现——优先 pnpm/npm run 项目脚本，遇 corepack 报错再回退 .cmd / node 直调。再实证（2026-09-08 晚，dsh 更新连带弄坏 pnpm）：corepack 垫片 shim 指向缺失的 pnpm.cjs、`pnpm --version` 失败时，直接 `npm install -g pnpm` 会因存量坏 shim 拒绝覆盖，须 `npm install -g pnpm --force` 修复（修后 pnpm 12.3.4，typecheck/build/test 直跑正常）。 Confidence: 0.75
- 注释沿用仓库中英混排惯例；行为变更在模块头/相关注释标注来源（日期 + 用户原话，如「用户迭代 2026-09-07『发送后清空选择』」），并在易错点（竞态、时序、lint 规则约束）写明设计原因（2026-09-07 再实证：jsxLikeTags 模块头把根因机制、「转义只发生在编辑器入口、原手册不经手」与范围收窄理由逐条写全）。 Confidence: 0.75
- 测试用 vitest，位于 tests/*.test.ts；describe/it 可用中文表达业务语义；行为变更同步补用例（含回退/撤销等边缘路径）。 Confidence: 0.65
- 头像描边语言（用户迭代 2026-09-07 二次修正，原「白底 + 品牌实色描边壳」全表面推广被撤回）：通用头像一律在 Avatar 容器默认类上加 1px 实线深灰框（border-slate-500），紧贴头像无间隔、不占额外空间、尺寸不变；容器加 bg-white 垫在内联底色之下（无底色处不透出下层）。白底必须是值级的不透明兜底：背景池含 upstream 原样的 'transparent'，抽中时容器内联 background: transparent 会盖掉类上的 bg-white（内联样式优先级高于工具类），须在渲染处把 transparent 落成 #ffffff——用户报告「领队没有背景放大时透出来了」证实类级兜底救不了值级透明。白底品牌壳（AVATAR_SHELL_CLASS：border-2 business p-0.5）仅角色页描边环（avatarRing）保留，不再推广到其他头像位。点名某界面时仍会要求改全该界面所有头像位（「都改一下」）。 Confidence: 0.95
- 种子驱动的确定性视觉内容（按 (seed, salt) 生成的头像等）保持既有输出稳定：修视觉 bug 时不动随机池本身——池长度参与 pick 索引，增删一项会全量重排所有既有 (seed, salt) 的底色，全部成员头像变脸；兜底在渲染/消费点做值级替换（如 transparent → #ffffff）。 Confidence: 0.7
- 视觉微调不改变元素占位：用户要求加边框/描边这类外观调整时直接在元素本体改样式，不用带 padding 的外壳包装（会撑大尺寸、破坏叠放/对齐）——用户原话「怎么超出了原来的大小了」；发现尺寸变了要恢复原尺寸。 Confidence: 0.8
- 重复的样式/行为字面值收口成共享常量供各消费位复用（如壳样式收口 features/avatar 的 AVATAR_SHELL_CLASS，avatarRing/taskAssign/teamPage/avatarStack 复用），不逐字复制。 Confidence: 0.6
- 界面上要求显示的「实际」值要与主会话模型座位的口径一致，不是纯运行时观测值（用户原话「实际的 provider/model」；修正实证 2026-09-07「我主会话是 tokenrouter/glm-5.3-free……实际显示的是 领队 · tokenrouter/z-ai/glm-5.3-free」）：观测到的 model 是解析后的上游限定 id（z-ai/glm-5.3-free），主会话座位显示的是目录级 id（glm-5.3-free）——显示组合取「观测 provider（真实适配器名）+ 声明 model（spawn descriptor agentOptions 的目录级 id，在成员运行时 setup hook 登记声明路线、冷恢复自愈）」；声明 provider 不采信（覆盖路线会误填传输名 spawn/fork）。观感同样对齐参照组件——用户原话「也没主会话一样有背景色」：徽章做成模型座位同款胶囊（bg-muted 圆角、28px 高、13px medium）而非纯 muted 小字；仍是非交互元素，不干扰既有交互（主会话模型座位照旧）。2026-09-09 方案 A 修订：徽章改读 modelSelection 投影（与座位同源数据），显示口径由「观测 provider + 声明 model 组合修正」变为投影 next ?? lastUsed 实际路线 + 共享目录名反查——数据同源后不再需要组合修正，spawn descriptor 声明路线登记机制随之退役。 Confidence: 0.75
- 弹窗/表单里的 textarea 不允许拖拽改大小（用户反馈 textarea 会被拖出弹窗）：加 `resize-none` 禁用 resize，不用 `rows` 而用固定 Tailwind 高度类。高度宁高勿矮：默认略高（h-28=112px）用户仍嫌矮，追加「高度再加100px」→ 固定 212px（用任意值类 `h-[212px]` 表达精确像素）；用户会以具体像素增量口头迭代尺寸，按当前值精确累加即可。 Confidence: 0.65
- 任意代码改动收尾要主动跑构建并明确汇报编译状态：用户在运行中的面板/宿主里验收效果，只改源码不编译会「好像没更新」（用户原话「编译一下，好像没更新」）；宿主侧插件修复后用户又追问「编译了吗」——不只客户端 UI 改动，host 侧改动同样要跑 `npm run build`（tsc + tailwind + tsdown，宿主打到 lib/index.js、客户端打包到 lib/client.js），没说清编译状态时用户会主动追问；即便收尾汇总里已提过 build（SMOKE OK），用户仍会单独追问「编译了吗」要一句明确确认（再次实证：领队 md 修复后用户追问「编译了吗」；2026-09-08 同一轮长会话内再追问三次——「编译一下」「编译了吗」×2，均已编译过、按下行口径直接作答不重跑）。汇报口径：宿主和客户端两个 Build complete + 冒烟行 SMOKE OK，收尾提醒重启宿主/刷新客户端才能生效；被追问「编译了吗」时已编译过就不重跑，直接给证据作答（两个 Build complete + SMOKE OK、lib/ 即最新产物、重启宿主生效）。构建也不能交代给用户自己做：源码改完只跑测试/tsc 就写「重新构建插件后即可验收」，用户再测仍见旧行为（2026-09-07 徽章修复后「还是显示 领队 · tokenrouter/z-ai/glm-5.3-free」，根因是 lib/ 停在上一轮产物、缺本轮声明路线代码）——收尾要自己跑完整构建链（clean → tsc×2 → tailwind → tsdown → wrapClient → smokeEnvelope）并用特征串核验产物内容（node -e 查 lib/index.js / lib/client.js 是否包含本轮新增符号，如 recordDeclaredRouteFromChild），证实「产物确实含新代码」后再让用户重启验收。2026-09-09 再实证：build 跑完、产物 mtime 晚于全部 edit，bundle 仍可能缺本轮后半段 edit（appendEngageDiag 函数定义在 lib/index.js 里、steerEngageNotice 里的诊断调用 step: 'delivered' 却不在）——核验要逐编辑点查各自特征串、定义与调用点都查，只查一个符号会漏「半套产物」；发现缺失就重读源文件确认 edit 幸存（并发编辑可能在构建前吞掉已做的 edit），重 build 后复验再交用户重启，不能凭「build 已跑完」就认定改动在产物里。被追问时若确实没编译，如实区分 typecheck 与真构建并立即补跑，不把 tsc --noEmit 当编译交差（2026-09-08 再实证：本轮收尾只跑了全量 vitest + 双 tsconfig tsc --noEmit，用户追问「编译了吗」，如实答「类型检查过了，但还没跑真正的构建」并马上补跑 `npm run build` 后再汇报）。 Confidence: 0.9
- 卡片网格偏好高密度排布：角色卡片一排放 5 个，宁可拉宽/拉长页面容器来容纳，而不是保持原宽减少每行数量（用户原话「角色卡片页面拉长，一排放5个就行」）。做卡片列表布局时按每行 5 个设定网格列数，容器尺寸随内容适配。卡片文字层级同样偏紧凑：卡上条目名即用户说的「title」（非页头标题），字号要求小一档（用户原话「title字体小一点」），层级靠字重（semibold）撑。 Confidence: 0.7
- 单行截断的文字配原生 `title` 属性悬停兜底看全文：卡片名字/简介这类 truncate 行都加 `title`（简介传 trim 后的全文），沿用团队卡成员略缩图「title 兜底全名」的同款手法（用户原话「title 和 profile 加上title，让鼠标挪上去可以看完整文字」）。 Confidence: 0.7
- 页面专属的样式分档改动用新常量收口，不动多页共用的常量：团队列表卡加宽时新建 TEAM_GRID_CLASS（minmax 240px 自适应列，2026-09-07），不并轨 CARD_GRID_CLASS（210px，角色列表在用）以免牵动别页——同 TASK_GRID_CLASS（260px）不并轨的既有纪律；与前一条互补：两处视觉应一致时归一同一常量，刻意分档时各立常量。 Confidence: 0.7
- 统一不一致的样式/尺寸时以用户点名的参照元素为准，不取中间值、不自选基准（用户原话「role_name 和 profile 的 input 框长度不一样，都改成 profile 的长度」→ role_name 输入框从 max-w-[320px] 对齐到 profile 的 max-w-[420px]，只动落后的一侧）。 Confidence: 0.6
- 卡片内分区（上边框横线）上下留白对称：用户会点名「横线上下间距一致」——给分隔线上下两段配对等值 padding（如卡头 pb-2.5 对底栏 pt-2.5，各 10px）。 Confidence: 0.6
- 用户会并发手动编辑文件（会话进行中在改别的功能，如 teamsButton 的搜索框；2026-09-08 再实证：captainAgent.ts 被另一进程活跃编辑——自己的修复被覆盖回 `import type`、行号漂移 10 行、辅助函数被删）：动手前/遇错时重读文件确认当前状态，改完再复查自己的改动没被覆盖；typecheck/测试报错先分辨是不是并发编辑造成的既有问题，与本任务无关的不抢修（用户往往自己已修），只动任务范围，并在总结里说明「其余未碰」；但若 WIP 代码挡住本次改动的验证（host typecheck/相关测试跑不过），可做最小机械修复打通验证——只动无歧义的机械问题（import 形态、删除确认已成孤儿的死代码、noUncheckedIndexedAccess 下的空值窄化），不碰对方的设计与重构方向，并在汇报里点明改动与风险（2026-09-08 三度实证：jsxLikeTags.ts 03:19 中间态挡 tsc，提局部变量 3 行机械修复打通构建并明告用户；用户进行中的 mdEditorJsxLike.test.ts 失败用例明确不碰，只在总结里提示）。 Confidence: 0.75
- 新增 UI 功能先找仓库内同类先例照做，保持一致而非新造模式：动手前先 grep/read 现有实现（ui 组件目录、同类页面的 placeholder 模式），搜索框沿用 rail 官网 Quick search 的样式签名缩小为弹层档（h-8、13px、放大镜绝对定位、Input 去 border 改 ring；rail 宽栏筛选框本身已随用户迭代 2026-09-08 撤除，此先例以存量弹层档搜索框为准），过滤复用 lib/text 的 matchesQuery，输入框用 components/ui/Input，图标沿用 lucide 深层 .mjs 导入。 Confidence: 0.6
- 列表/弹层行的选中态用就地可视指示替代文字说明：选中行行尾显示品牌主色 Check 勾（`text-primary`）代替「已选」文案；状态已可视后冗余的提示行（「已选「xxx」（再次点击可取消）」）要删掉——用户原话「把已选换成有颜色的勾」「去掉团队选中的提示」。 Confidence: 0.6
- 列表页面容器高度占满：角色、团队、任务这类列表页要求 height 100%、容器卡片撑满内容区（用户原话「角色、团队、任务列表页面的高度100% 我想要里面的容器卡片是满的，方便展示」），页面/列表容器不随内容收缩。实现模式（teamsView 2026-09-07 落地）：CONTENT_CLASS 改纵 flex 列，列表页根 `flex min-h-0 flex-1 flex-col`，PANEL_CARD_CLASS 卡片加 `flex min-h-0 flex-1 flex-col` 拉满，卡内栅格加 `min-h-0 flex-1 content-start overflow-y-auto` 内部滚动——页头/分页常驻可视，卡片少时行保持自然高度、留白收在卡内；看板/汇报页不跟着改（仍内容自适应整页滚动）；同日用户点名团队详情页成员列表也要内滚（2026-09-07「团队成员内部加滚动条，不是页面滚动」）——同款模式落到团队详情（根 flex min-h-0 flex-1 flex-col、成员卡 flex-1、列表 overflow-y-auto），详情页不再一律整页滚动，用户点名哪页改哪页。 Confidence: 0.65
- 样式定调后全表面统一、不留旧式例外：改动落地后用户会逐页检查并点名漏改处（「角色详情页面还是老样子」；团队首字徽章上了列表卡标题后，用户随即点名「团队弹窗中的团队tab下面的团队也加上徽章」——同一实体的标识元素在它出现的每个面都要求同款），此前作为例外保留的旧样式组件也要一并撤掉换成新样式。 Confidence: 0.7
- 用户对 UI 做像素级验收，几 px 的错位也会点名（原话「搜索框图标和文字怎么没对齐」）：绝对定位图标必须相对它装饰的元素本身居中——外层容器上下 padding 不对称（pt-2/pb-0.5）时 `top-1/2` 以外层为基准会整体偏上（实测 3px），要在 Input 外再包一层只含「图标+Input」的 `relative`，让居中以 Input 为基准；间距按参照组件（rail Quick search）的精确值复刻（图标 left-2、文字 pl-7、图标-文字 6px），不凭感觉取近似值。 Confidence: 0.7
- 改动落在源头（常量/组件本身，不只是改调用点），避免新旧双轨并存。 Confidence: 0.8
- 产品语义（用户澄清）：选团队只是把团队身份绑定到会话（供 band 注入与 eteams_* 工具的派发身份解析），会话不必「属于」团队；任务行锚定发起会话（mainSessionId 记本会话）。用户原话「团队在不在会话没关系啊。是要创建一个任务，然后任务关联这个会话啊」。涉及团队/会话/任务的需求按此语义理解，不要假设会话必须隶属团队。团队对话工作流两步走（用户迭代 2026-09-07，用户原话「第一步先创建一个任务。然后把团队成员放进任务中去……第二步判断团队是否有领队，如果有则创建领队的子agent，子agent以领队的名字命名，然后开始分解和分配任务」）：第一步主会话立即 eteams_submit_task 建主任务——subject 由模型把用户原话简化成一句话标题（不照抄原话），团队成员随建任务自动落位（createTask 班底副本行机制，提示词注明不要重复拉人）；第二步判断有无领队——有则 dispatch 领队子代理并以领队的名字命名（v8+ 随大任务生灭，锚定本任务的领队副本行）（label `eteams-captain:<领队名>`，替代原 team id），分解与分配全部由子代理主持，出生提示词同步写明主任务已由主对话建好、不重复提交；无领队则维持主会话直接主持。流程类需求经三处联动落地：system prompt band（sessionTeam.ts）+ 领队子代理 label（captainAgent.ts）+ 出生提示词（captainChild.ts），band 红线同步收窄为两步涉及的工具。 Confidence: 0.8
- 拆解阶段的卡槽填人不等于启动任务（用户原话 2026-09-08「这个阶段只创建和拆解任务，为任务成员卡槽分配人员。并不是启动任务，其它没问题，开工」）：建任务/拆解阶段为成员卡槽填人（eteams_create_task 的 chain 站点按工号写）是流程内动作、照常进行；eteams_assign_task 指派与成员子会话起跑才是批准闸门后的动作（不自批开跑）——band/子代理提示词表述时把「填槽」与「启动」分开措辞，别把填槽也锁进闸门。 Confidence: 0.85
- 改提示词/文案类代码前先 grep tests 中依赖旧文案的断言（toContain 的精确字符串），动手前确认哪些断言会失配并同步更新测试；改完再全量 grep 旧文案短语扫尾，确认没有别的测试还引用。 Confidence: 0.6
- 排障回复结论先行、归因准确：用户拿报错或异常现象来问时（含「修了还是复现」类复发报告，2026-09-08「还是创建了 77」实证），先用一句话说清真正出错的组件/层，再展开机制与修复（本例：调用其实没跑错插件——报错 JSON 的入参形状正是自家 eteams_dispatch_captain 的，UI 里 "agent-teams" 只是共存的另一插件命名空间造成的显示混淆，错在自家工具的身份解析被拒）；归属不确定时先核实实际调用路径（工具入参形状、注册表、命名空间）再下结论，不顺着报错文案的字面归因走；修复总结按「根因 → 逐文件改动 → 验证（测试数/typecheck/lint/构建冒烟）」分层汇报。 Confidence: 0.75
- 依赖的类型定义/文档缺失时从 registry 拉包查类型：registry 是公网 npmmirror，直接 curl tarball 解包 grep .d.ts 即可确认上游形状（dsh-session 的 SessionEventMap/known-event-types、dsh-llm 的 UserMessage.source 都可这样查，不必等 npm install）；解包目录、拷到仓库根的类型文件等临时物用完即删，收尾用 git status 核对不留调试垃圾；运行时行为疑点同理直接读 node_modules 已安装包的 lib JS 源码求证再动手（2026-09-08 实证：读 dsh-subagent/dsh-system-prompt 的 index.js 查明 persona 段如何注册与渲染，不继续猜宿主行为）。 Confidence: 0.75
- bug 修复在既有已上线语义框架内解决，不借机重设计：本例保留「发送后清空选择」一次性消费语义，只把消费/撤销的触发收窄为真人输入（source.kind === 'user'），插件注入的 user 消息（唤醒/邮件/steer/文件通知，同样走 user/message 事件）不再误清本回合凭证。再实证 2026-09-08：用户报「进入角色页面反复弹已复制，去掉这个弹框」，诉求指向反复弹出的异常而非既有交互——只修僵尸 toast 复发机制（补 onOpenChange 收口），点「复制」的一次性反馈照留（docs/43 既有设计），不按字面把整个功能撤掉。再实证 2026-09-08：修「setLeaderModel 漏赋 provider」时据用户「我修改的是team_members,你怎么修改到task_members中去了？」的质疑擅自把领队路线存储位从主持行统一到班底领队行（leaderRouteOf 助手+搬迁迁移），被用户并行加的 lifecycle 用例（明确断言主持行存储）打回后一度整套撤销、恢复既有主持行方案只留 provider 修复；同日用户再报「其它成员都正常，就领队还是null」——用户一直在 team_members 查库验收（成员行有值、领队行 NULL 即判 bug），按其预期二次统一并落定（见下条）。 Confidence: 0.7
- 领队模型路线存储位终定（2026-09-08 同日三段反复后落定）：存班底领队行 team_members.is_leader=1 的 model/provider/reasoning_effort，与成员同表同列；task_members 主持行只留会话锚 session_id，模型列废弃不读写；v9 迁移一次性搬迁旧值（schema_meta 标记防重，只搬班底 model 为空的行、不覆盖用户后续重选）；setLeaderModel/captainAgent 派发/webui 快照全链改读写班底领队行，lifecycle/captainDispatch 用例同步改断言新存储位（seedTeam 默认 members 为空数组，播种覆盖路线需显式补一条班底领队行再 writeTeamInTx）。一般化教训：存储位取舍以用户实际查库/手改的那张表为准——用户拿表验收时，同类数据分表两处存会被当缺陷报（「就领队还是null」）；并行测试代码断言旧存储位不足以否定用户的直接预期与查库习惯，存储设计冲突时先确认用户的验收路径再定存储位，测试跟着定稿改。 Confidence: 0.8
- 轻量操作（复制等）偏好静默完成，反馈类 toast 用户点名「去掉」就整撤、不留「单次反馈」折中变体（2026-09-08 定案，用户原话「还是弹出，不需要弹完全去掉」）：点「复制」改为 writeClipboard 写入即止、失败也静默吞掉，成功/失败 toast 全撤，`toast` import、按钮 `void` 包装与过时注释一并清理（对齐「撤功能做整链清理」既有纪律）；用户对弹框的诉求以「弹框消失」为验收标准——修弹框行为（如修掉反复复发）但保留弹框本身不算满足，撤不撤由用户发起。rosterAddPage 的 toast 复发机制修复（toaster.tsx open/onOpenChange 接线）保留，供仍在用 toast 的其它页面正常关闭。2026-09-09 修订：静默 ≠ 永不给反馈——用户点名要复制成功效果时（原话「复制需要有复制成功效果，就让复制按钮边框变绿，按钮里面加一个绿色的勾，过几秒再变回来」），反馈形态是就地收在触发按钮自身、仍不弹任何 toast/浮层：写入剪贴板成功后按钮变成功态（边框+勾转 --success 绿），约 2 秒自动回弹；两态边框常驻占位（透明↔绿只换色）避免布局跳动，重复点击重置计时、卸载清定时器。 Confidence: 0.85
- 弹窗/覆盖层里的操作若产物落在被盖住的面上，操作成功落地后收掉弹窗让用户直接看到结果（用户迭代 2026-09-09 原话「新增角色的填充如果是弹窗，填充后隐藏弹窗」）：整页团队页（TeamsOverlay，role=dialog）里点「新增角色→填充」把命令落进对话输入框后即广播关页信号（沿用 lib/bridge 的 CustomEvent 跨面信号模式），用户直接看到已填充的输入框，弹窗继续盖着反而挡路；对话内 tab 场景弹窗未开时信号无接收方、零副作用，且只在命令确实落地（非 aborted）时发。 Confidence: 0.8
- `npm run build` 输出里的 tsdown 配置弃用 WARN（`external`/`inlineDynamicImports`）是既有噪音、不影响产物，不必追查；构建成功的验收点看产物生成（宿主 `lib/index.js`、客户端 `lib/client.js`）与末尾冒烟行 `SMOKE OK: exports=[apply, inject]`，向用户汇报时顺带说明该 WARN 一直都在，免得被当成新问题。 Confidence: 0.65
- 仓库 prettier 非强约束（2026-09-08 实证）：43 个存量 host 源文件本身 `--check` 不通过（多为换行偏好差异），新代码对齐相邻文件的手写风格即可，不为存量格式差异做全量重排、也不顺手 reformat 别人文件；全量 eslint 仅 `inspect-tmp.mjs`（shell 写入的临时探查脚本）报错，属既有问题不抢修、汇报时点明非本次引入即可。 Confidence: 0.6
- 子代理/助手的进入提示词不内嵌状态快照，改为指令让代理用工具自取现状（如首轮必调 eteams_team_status，后续按需再调）：单一事实源、状态永远现读现新、上下文最瘦，代价只是首轮多一次工具调用（用户原话「我希望是让子agent去获取团队现状，而不是直接输出在子agent里面」）。 Confidence: 0.9
- 设计类需求先讨论定稿再动手（用户原话「好好设计一下，跟我讨论」「请详细和我讨论」）：进计划模式摸清现状与根因，把关键设计取舍做成 ask_user_question 选项让用户拍板（如快照去留、profile 粒度、修复覆盖面），定稿后写计划文件再实施。定稿后用户仍会逐条追问计划步骤的「为什么」（如「为啥需要改角色库手册」「为啥从角色库取，团队成员里不是已经有了吗」）——回答要摆代码证据与数据流（用文本图区分 live 源与烘焙快照，逐点给文件/函数依据），并说清哪些步骤是必须、哪些只是验收建议（不把建议包装成必须项）；追问是在理解决策依据而非反对。定稿后用户还会要求把完整流程从头到尾复述一遍、核对与自己的想法一致（原话「再仔细说一遍现在的创建任务流程，我需要确保和我的想法一致」）——开工前给端到端流程叙述（分阶段：绑定→建任务→转交→执行→红线汇总），剩余待拍板点用显式标记逐项列出请用户确认，全部确认后再动手。实现落地后用户还会追问机制层面的概念问题（2026-09-08 实证「注入到系统提示段 和 上下文有啥区别？」；同日再实证「task_members 为什么会有一个 main_task_id 和 now_task_id 两个字段？」——追问范围扩到数据模型/表结构设计，答前先查 schema 定义与各读写点坐实字段语义，按「静态归属锚 vs 动态执行指针」分清各字段职责再作答）——同样是吃透设计依据、便于自己验收，不是质疑：用多维分节对比作答（位置与可见性、宿主加工程度、生命周期、权威性、可维护性逐项对比），每维落到实操含义，收尾给一句验收口径（打开哪、看哪一眼能确认生效）；对运行中的意外行为同样以「为啥」提问而非直接当 bug 报（再实证：「停止子 agent 的创建过程后，会话为啥会被自动唤醒」；再实证：「任务在创建过程中时，点开详情看不到团队成员、子任务的标题和创建按钮」——根因是创建窗口期的读时派生 kind 与状态闸门未覆盖 creating 中间态；再实证 2026-09-08：「怎么表里面老是会有一个 team_id=1 task_member_id=1 的项目牧羊人被创建出来」——根因是建队事务固定插领队班底行+主持行（v7 决策 2「领队入班底」，is_leader=1 行同时是身份解析/手册缓存的锚点），非 bug）——先沿代码把触发链查实再下结论，排查时先穷尽并排除备择来源（首启播种 seedPresetRows 只种 roles、删除后残留、旧数据导入）坐实「固定产物」归属，结论先行点明是既有设计还是缺陷，正文给带 file:line 的完整触发链，并附「若想改变该行为要动哪里」的指引；用户描述的现象本身有歧义（删了还在/每队一条/别处看到）时，用编号选项先让用户确认实际观察到的场景再定改动方向；这类只问「为啥」的回合收尾给最小修复方案（分点、对齐既有口径）后先询问用户是否按方案动手，不擅自改代码（再实证 2026-09-08 建构师模型路线：首轮答案给了三路 spawn 现状对照+修复选项但没把「为啥不跟/为啥被污染」的因果答透，用户以「我问的是为啥……」复述原题再追问——用户复述问题说明首轮没接住其真实关切，重答时正面直给该问题的完整因果链与运行时证据，不重复上一轮的选项清单）。 Confidence: 0.9
- 子代理模型路线的用户预期与运行时机制（2026-09-08 讨论中、方向未拍板）：用户预期建构师等 spawn 子代理应跟随主会话当前模型，把实际行为定性为「被污染」（原话「我问的是为啥 建构师 没有跟着当前主会话的模型走？而是被污染了」）；因果已查实——dsh-subagent 的 resolveChildAgentOptions 在 spawn 请求未传 agentOptions 时继承父代理 options.model（会话创建/恢复时 = agentDefaultModel.currentSelection() 的全局默认快照），会话内切模型走 installModelSelection 的 mutable selection、不回写 agent.options，而 builderPhases.ts 两处 spawn 只传传输名 provider → 建构师跑在全局默认快照上、冷恢复时还会随全局默认漂移；成员/领队 2026-09-04 起是显式钉 sessionDefaultRouteOf（同为全局默认）。已摆三方向（钉死对齐成员口径 / 真跟主会话 selection / 建构师专属配置），用户尚未拍板，动手前先等用户选向。 Confidence: 0.65
- 子代理模型徽章消失回归定案（2026-09-09 排障，修复方案已给、待用户拍板，不擅自动手）：「新版本迁移」提交 174a07e 删掉宿主 registerContinuableSetup 钩子后，kind 身份注册表与声明路线表（usage.ts，进程内存）只剩 spawn/唤醒两处登记（members.ts、captainAgent.ts；唤醒只补身份不补路线）——宿主重启后既有子代理会话两表全空，/session-route 返回 subagent:false/route:null，徽章（sessionModelBadge.tsx 渲染条件 subagent===true 且 route 非空）判不渲染；builder 走持久 rolebuilder.json 免疫，成员/领队不免疫；退化后徽章显示观测原值（上游限定 id），正是 09-07 用户要求修掉的「双重限定」显示，重启即回退。已实证排除：事件契约未变（request/header→data.header.config、request/context→data.provider/model）、firehose 活着（usage_detail boot 后有行、构建师会话 provider/model 齐全）、客户端徽章代码迁移零改动、宿主/客户端均为新 bundle。一般化教训：凡跨宿主重启要生效的判定不能只靠进程内存登记，须有落盘锚兜底（rootPrompt.ts:36-45 的 task_members.session_id 直查是仓库「重启免疫」先例）；修复方向＝/session-route 加落盘兜底（kind 兜底直查 task_members.session_id、captain 取 is_leader=1 副本行 session_id；declared route 兜底 join team_members 模型列；内存注册表保留覆盖 spawn 窗口竞态），同病副作用 usage 归属（resolveIdentity 成员/领队是内存优先级，重启后落 workspace 桶）一并修；测试补「重启后落盘兜底」分支。 Confidence: 0.7
- 快照/数据结构去冗余、粒度取概览：身份已编码的信息不重复携带（成员名=角色名时 teamView 去掉 role 列），有用的概览信息补进来（角色一句话简介 profile）；用户确认「一句话简介」粒度，不把整份角色手册烘进快照。 Confidence: 0.65
- 用户维护的手册/persona 要 live 生效：运行时现读角色库（跨工作区兜底），不读建队时烘死的行副本——副本改手册不回填，用户报「领队的 md 没注入进去」根因即静默回落；配套加来源日志标明 persona 取自哪份源，便于诊断。补一个关键陷阱：每个工作区首启都会播种一份默认「项目牧羊人」角色行——角色库查找必须以权威根（writeWorkspacePath，面板编辑落点）优先于本区根，本区过期的种子行会遮蔽用户编辑过的手册（收口为 workspaces.ts 的 rosterAuthoritativeRoot/findRosterMemberInRoots 供 webui 与 captainAgent 共用）。 Confidence: 0.7
- 领队手册的数据源最终定为团队成员表里的冻结缓存，角色库后续修改不管（用户原话 2026-09-08「不是读角色库，而是读团队成员表中的缓存MD，角色新修改的不管」——同日反转上一条「live 现读角色库」的中间方案）：手册烘进每个大任务的领队副本行 persona_md（createTask 铺副本时烘开工当时的手册——2026-09-08 晚间定案「领队子会话随大任务生灭、主持行取消」后由主持行缓存改为按任务冻结，各任务各自定格；存量主持行只作老任务补铺时的搬运源），persona 系统段只含插槽引用 {{eteams_leader_handbook}}，index.ts 注册同名 prompt 变量、provider 按装配子会话直读该原始列（is_leader=1 且 main_task_id=本任务号——registry 携 team+task 直查，绕过 hydration 的 roles LEFT JOIN；镜像同步只刷 team_members 班底行、不碰 task_members，天然无人改写）；缓存为空退内置手册，绝不抛错。宿主对插槽替换值不做二次扫描，md 里真实 {{xxx}} 原样进系统提示。live 现读角色库只保留在确需实时的消费位（teamView 的 profile 列）。 Confidence: 0.85
- 用户定案「创建时即最终版」后不为事后一致性加机制：手册后续修改与已创建的团队/子代理无关（用户原话 2026-09-08「不需要这么麻烦，当用户创建时就默认已经是最终可用的MD了。后续修改和当前任务无关了」），拒绝指纹对比自动重建这类一致性层；边界（已存在的子代理要换手册需重建）在注释/文档里写明即可。 Confidence: 0.8
- 用户报「修了还是没生效」时先别急着改代码（两次实证：「领队MD好像还是没注入进去啊」；2026-09-08「还是没有显示，创建完任务后任务详情还是只有一个头部卡片」——修复早已编译进产物，是运行宿主没加载新代码）：能自己拿证据就自己拿、沿代码装载链一锤定音，不先反问用户（2026-09-08 实证）：grep 构建产物（lib/index.js、lib/client.js）确认改动标记在产物里、排除「没编译」→ 读 cordis.patch.yml 确认插件经 `dsh plugin --profile add` 以 pnpm 装进 profile，再实测 `~/.dsh/profiles/desktop/node_modules/dsh-eteams` 是 Windows Junction 直指 C:\eTeam（Get-Item 查 LinkType/Target）、排除「宿主加载的是别的副本」→ 收敛为运行中宿主进程仍缓存启动时的旧 ESM 模块，答复「代码没问题、整个退出桌面应用再开」而非再动代码；产物里找不到改动标记或证据在宿主日志里时，才请用户提供一锤定音证据（如 `persona 来源=roster/yaml/builtin`）。典型分叉：宿主是否加载了最新构建（Node ESM 模块进程启动时缓存，重建 lib/ 不影响运行中的宿主，须整个退出再开）；2026-09-08 晚再实证（构建派发失败收尾）：请用户「彻底退出（含托盘）重启→重发」并约定回一声「发了」即由助手自己立刻读 rolebuilder.json 取结果，但状态文件里最新尝试时间戳早于诊断版构建完成、进程仍是 18:05 启动的旧 bundle——用户口头确认做了手动步骤不等于真跑上新构建，解读重试结果前先做时间三角验证（状态文件里的尝试时间戳 vs 本轮构建完成时间、host.log boot 行 builtAt、PowerShell Get-Process 查 DSH Desktop 进程 StartTime），对不上就明说「这次跑的还是旧 bundle」请重做，重启口径给成可核验判据（重启时间必须晚于构建完成时间）；用户侧手动验证步骤的交付形态＝编号清单＋可核验口径＋最简确认回路（用户回一词确认、助手读状态文件自取证据），不让用户转述现象；持久子代理是否诞生于修改/构建之前（persona 只在 spawn 那次传入，followup 续聊与宿主重启续上的旧会话永远带旧手册，换新团队/新 spawn 可隔离验证）；用户改的存储位是否就是被读取的位（面板角色库 vs 任务成员副本行——若用户用法落在副本行，说明可按「副本行优先、角色库兜底」另调读取源，先问清用法再改）。Confidence: 0.85
- 用户报「还是老问题、好早之前就修过」时按回归处理，先考古原修复再诊断（2026-09-08 实证「还是老问题，这个好早之前就修过，我点击对话会点不过去，会闪烁一下然后跳回角色页面」）：复发 ≠ 新 bug——先 grep 代码注释与 git 历史找回当初的修复（仓库注释惯例带日期+用户原话，正是留给检索的锚点），核实该机制是否还在、有没有被后续改动/并发编辑/重建覆盖失效，再沿失效点排查；不把复发当新问题从头另起炉灶，也不默认原修复仍生效。 Confidence: 0.7
- 用户 md（领队手册/成员人设）进子代理上下文走 persona 系统段这一正统通道，与宿主严格插值的冲突用转义解决，不为绕开插值另开消息通道：注入前过 `neutralizeInterpolation`（`{{`→全角 `｛｛`、`}}`→全角 `｝｝`，与 sessionPersona 角色接管 band 同一把函数），角色库里的 md 原文保持原样、转义只发生在注入瞬间，所有把用户 md 送进系统段的面（领队 persona、成员 persona）统一套用；用户明确要求撤销此前「首轮派发消息前置手册」的双通道补丁（用户原话「那还是放到系统提示段中间去，但是看能否通过转义等方式处理 md 里只要出现 {{xxx}} 这种情况」）。落定后用户随即追问「没有更好的方案吗？插槽这种无法渲染出真实的{{}}吗？」——转义被用户定位为过渡手段而非终点，见下条。 Confidence: 0.85
- 绕过宿主限制的变通方案不以有损改写用户内容收场，优先探平台原生机制保全内容原貌（用户原话「没有更好的方案吗？插槽这种无法渲染出真实的{{}}吗？」）：全角转义方案落地后用户仍追问更优解，目标是 md 里真实 `{{xxx}}` 原样呈现——宿主 dsh-system-prompt 的插槽机制可零转义做到（`systemPrompt.variable(name, provider)` 注册插槽，段文本只写 `{{name}}` 引用，provider 每次装配现读返回全文，替换值不再被二次扫描、md 内容不经过插值扫描）。用户对「能用但绕」的方案会持续追问有没有更好的——作答前先穷尽平台自身能力（插槽/钩子/原生通道），变通类手段（转义、改写用户内容）只作兜底。 Confidence: 0.8
- 修复里带轮询/重试兜底时要能答上「为什么需要重试」，用户会逐点质疑补丁式设计（2026-09-08 实证「怎么还需要轮询尝试跳转？会话应该不空白啊，我输入了调用指令怎么会是空白呢？」——问题直指机制必要性而非现象本身）：要么把底层状态真正修正到重试不再必要（本轮把 engage 通知改 user 身份注入后转场信号天然满足），要么精确说明重试防的是什么、为何仍有窗口期；此类反问常挖出宿主/平台状态定义的盲区（blank 何时清、lastPromptAt 何时设），先核实确切定义再作答，不凭直觉辩解。 Confidence: 0.7
- SQLite schema 演进按仓库既有纪律：升 DB_SCHEMA_VERSION、在 db.ts 新增幂等迁移函数挂进 getDb 迁移链——PRAGMA table_info 缺列检测后 ALTER ADD COLUMN 并按业务键回填存量行（重开重跑=自愈，不报错、不显式开事务，随 v4/v5 先例）；旧列一律不 DROP（弃用列保留不读写——DROP 是单向门，会炸旧版 lib 回滚）；schema.sql 头注同步补版本历史段；db.ts 内嵌 SCHEMA_SQL 用 node 脚本从 schema.sql 逐字同步并回读校验 identical；迁移行为照 tests/store.test.ts 既有模式补回归测试（当前 DDL 建新库 → DROP 新列 + 降版本号 → 重开触发迁移 → 断言各表回填值与重开幂等）；例外：用户已手改库结构时以用户改后的库为准、代码侧整体对齐（类型/读写链路回滚），不擅自补做迁移把去掉的列加回来（2026-09-08：用户自己把 team_members/task_members 改成 model + reasoning_effort 两列，原话「我已经数据库修改为了model + reasoning_effort 两个列了，按照这两个列继续任务，去掉provider 列」）——但这条例外不是终局：先摆可核验数据说明精简 schema 会丢什么（同日实证：tokenrouter/tr-test 目录里同一个模型 id z-ai/glm-5.3-free 显示名不同，只存 id 时显示反查与 spawn provider 都有歧义），用户理解后自会收回原指令（原话「我明白了确实需要provider ，继续你的思路」），再按既有纪律正常补做幂等迁移（v9 重加 provider 列，手改过的库重启自动补列、存量行 NULL 按目录反查兜底）——用户中途的精简指令与实证根因冲突时不盲从也不硬顶，用证据说服。v12 再实证（system 角色 is_root 列）：迁移照样板一次到位——table_info 检测→ALTER→按保留名回填、schema.sql 头注补版本历史段、db.ts 内嵌副本逐字同步、迁移用例照 store.test.ts 模式补回归。 Confidence: 0.85
- 派生/冗余列的写入收口单一派生助手保证不变量：is_leader 的全部写路径（store 写端、import 预置播种/旧快照导入、roster upsert、teamOps 建队/领队加回）统一经 `leaderFlagOf(name)` 落库，不变量「项目牧羊人=1 其余=0」只在一处维护；读端装列消费、不重复推导。再实证：v10 把 avatar 纳入 syncTeamMemberRoleMirrorInTx 四列镜像，角色保存全路径经该收口刷新班底副本列（角色删除不同步）；v12 再添 rootFlagOf 与 leaderFlagOf 并排，roles.is_root 全部写路径（store/import/roster）收口经它。 Confidence: 0.8
- 身份/角色解析用显式持久标识，不按名字符串匹配（用户原话 2026-09-08「获取领队就不是根据名字来获取领队，通过这个标识来获取领队」）：领队行查找从 LEADER_NAME 匹配整体切到 is_leader 标识（leaderRowOf、captainAgent 落盘 SQL、webui 领队卡、queries 看板 Q5、roster 预置升级一次切净）；按名匹配只保留给保留名守卫（防覆盖/防删除）这类保护语义；全库切换后 grep 旧匹配式扫尾、清理不再使用的 import。v12 再实证：rootRoleRow 按 is_root=1 取行不按名，保留名只用于守卫与写端派生。 Confidence: 0.8
- 派生汇总元素（chip/badge/提示行）只承担主状态指示器未表达的增量信息，不重复已可视状态（用户原话 2026-09-08「任务卡片怎么出现了两个状态了？去掉那个圆角的待开始」）：任务组卡上底栏状态 pill 与 GroupSummaryChip 同显「待开始」构成重复，修复落在源头——`groupDisplayOf` 的 ready/draft 兜底桶改为返回 null，chip 只留 ✕n 项异常 / n 执行中 / n 待接取 这类增量信息，基础状态（全 done/全 ready）一律不出 chip；与「选中态已可视后冗余提示行要删掉」同一原则，设计状态/汇总展示时先核对主指示器已表达什么。再实证同日（模型选择列表）：信息已由专属 UI 面承载时，不在选择器行内重复展示——模型行不显示 fast/快速响应等速度描述（用户原话「我们不是已经有推理等级选项卡了么，不需要选择模型时提示」），行内只留模型名、title 只留提供方名，推理档位语义统一由「推理等级」子面板承载。再实证 2026-09-09（角色详情页头副注）：前端硬编码文案与数据库已有的说明同义重复时，撤硬编码路径、以库内数据为单一事实源——system 角色页头同时渲染 status.ts 硬编码副注与建库播种进 roles.profile 的简介（用户原话「为什么提示重复了？已经有数据库里面的说明了」），修复=删 ROSTER_DETAIL_SUBTITLE_META 的 root 档、副注条件排除 isRoot，页头只显示库内简介；被删文案独有的增量信息（「不能加入团队」）仍由手册卡提示行交代，去重不丢信息。 Confidence: 0.8
- 文档类需求（命令总览等）落点在 README、动笔前先从源码盘点全部条目再写（2026-09-08 用户点名把「目前项目中有哪些命令」整理进 README）：pnpm 脚本读 package.json、工具命令 grep `name:` 注册点、斜杠命令读 commands/ 注册索引与 handler、scripts/ 独立脚本逐个读头注释取用途；工具作用域归属（root vs 成员子作用域、deny 屏蔽、问答类是否全员可用）以代码/注释为准不凭记忆；与既有章节重复的内容用锚点链接替代（「逐条说明见 [开发](#开发)」），不复制正文。 Confidence: 0.7
- README/文档编辑收尾对新内容跑 Prettier 校验（corepack pnpm 坏，直接 `node node_modules/prettier/bin/prettier.cjs --check README.md`）：--check 失败先分辨本次引入还是存量问题——`git show HEAD:README.md` 重定向导出旧版到 scratchpad 同样 check 对比；差异只在新增内容时逐字搬回 Prettier 产出（如表格列的等宽补齐），可把新增节裁成独立小文件到 scratchpad 单独 check 收敛；存量未过的部分不动，汇报点明「属既有问题，未动」——文档侧新内容按 Prettier，源码侧新代码按相邻手写风格（不 reformat 别人文件）。 Confidence: 0.7
- dsh 全局 CLI 更新会弄坏 npm 全局安装（2026-09-08 实证「我更新了dsh，帮我把eTeam插件装上」）：症状是 shim（…\AppData\Roaming\npm\dsh.cmd）还在但指向的模块目录被删，`dsh --version` 直接失败；机器上另有 `dsh1024` 包装器（转发官方 CLI：优先沿用 PATH 上现成的 `dsh`——坏 shim 会被照常继承——否则 npx 拉官方包），不能替代重装；修复路径是 `npm install -g @deepseek-ai/dsh` 重装官方包恢复 shim，`dsh --version` 验证后再做插件安装，装完按 README 用 `dsh --profile desktop --dump-config` 核对装配结果。插件安装（`dsh plugin add`）会在 profile 目录用 pnpm 装依赖，pnpm 垫片坏了会卡安装。用户自行更新 dsh 后，先怀疑全局 shim/module 断链再装插件。 Confidence: 0.7
- dsh 升级后客户端插件「Renderer boot failed for 1 plugin(s)」排障（2026-09-08 实证，dsh 0.1.2-rc.1）：该文案来自 DSH Desktop 主进程（resources/app.asar.unpacked/lib/main.js）的 generic 弹窗，report.error 为空、真实报错只在渲染端 console（agent-browser 未装、抓不到 console 时走静态分析）；运行时 client 包按 profile 装在 ~/.dsh/profiles/node_modules/@deepseek-ai/*（全局 dsh 包本体只是 CLI），渲染端模块系统在 dsh-client-modules/lib/client.js——inject 声明里缺服务只会静默跳过，factory 体顶层/apply 抛错才会炸 boot。本例根因是 harness 改名：0.1.2 把客户端服务 conversationEvents 重构为 uiConversation（事件注册表挪到 .events.register），插件 inject 硬依赖旧服务名 → cordis fiber 永不激活 → boot 失败。排障路径：全 .dsh 树 grep 失败文案定位来源 → 逐项核对新版 client 包的服务/导出面（ui-primitives 符号、conversation.chat.node 槽位、modelDirectories 均未变，唯一断点即服务改名）→ scripts/smokeEnvelope.mjs 冒烟排除 factory 体问题 → 对照仓库 node_modules 旧版 bundle 坐实改名。修复 = inject 与 ctx 服务访问同步改名 + 服务缺失仍优雅降级（tab+按钮照常），typecheck/完整 build/全量测试全绿后提醒重启 DSH Desktop（live link，lib/ 即最新产物）。dsh 更新后除装包断链，还要核对插件 inject 声明的服务名与新版 harness API 是否一致。 Confidence: 0.7
- 宿主 harness 运行时 API 的真身看全局 dsh 安装的内嵌包，不信仓库 node_modules 与官方文档（2026-09-08 实证「新版本，调不起子agent了」，宿主实跑 0.1.2-rc.1）：插件 @deepseek-ai/* 依赖 build 时 external、运行时解析到宿主副本——host 侧 API 在 C:\Users\epat\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\* 的 .d.ts/lib 源码里（渲染端在 ~/.dsh/profiles/node_modules/@deepseek-ai/*），实装版本可远新于 package.json pin（仓库 pin rc.6/rc.8，仓库 node_modules 恰好可作旧版对照）；官方 quickstart 文档不含 API 变更说明，逐项核对新旧两份包的 API 面（服务名、方法表、值导出、必填参数）才是可靠路径。0.1.2 host 侧破坏面：subagents.followup→sendMessage(sender,targetId,content,{signal})、registerContinuableSetup（per-child 工具装配钩子）整体移除、signal 变必填（运行时无保护 throwIfAborted，undefined 即 TypeError）。 Confidence: 0.75
- 宿主机制/语义类问题先查官方 reference 文档再逆向（用户 2026-09-08 原话「你看文档啊 https://deepseek-harness.github.io/deepseek-harness/reference/」——在助手扒 app.asar/内嵌包源码查唤醒原语时被用户直接贴文档链接纠正方向）：逆向宿主行为之前先 web_fetch 官方参考页，reference 文档覆盖机制语义（本例关键判据正出自文档：inbox 唤醒模型——「输入通过同一个 inbox 到达驱动器。有些消息会立即唤醒它；注入的上下文会留在 inbox 中，直到另一条消息将其唤醒」）。与上一条互补而非冲突：官方文档不含破坏性 API 变更说明（查 API 面仍以内嵌包 .d.ts/lib 为准），但机制/行为语义类问题文档是第一手来源，用户期望先查它而不是从二进制猜。再实证（2026-09-09，engage 方案被质疑费 token 时用户再贴 subsystems/subagent 文档原话「再仔细研读一下文档看看还有没有好的办法」——文档轮次流程给出 pre-step 拒收即空回合的机制线索，确切调用契约再 grep 内嵌包 dsh-agent-loop 源码坐实：文档找方向、内嵌包源码定契约）。2026-09-09 三度实证（原话「请再调研一下文档……请调研后和我讨论」）：用户对实现路径有疑问/质疑其必要性时，不等催促就把官方文档与机器实证（运行时缓存、内嵌包源码）查完再回来讨论。 Confidence: 0.85
- 对宿主 harness API 的调用写新旧兼容（能力探测+回退），不 pin 单一版本——宿主会先于仓库升级（2026-09-08 修复实证）：方法存在性探测分发（typeof face.sendMessage === 'function' 优先、旧宿主回退 followup），收口成 deliverToChild 兼容助手供派发/成员唤醒/问答唤醒三处共用；可用性守卫同样按能力探测（sendMessage || followup 任一即可）；宿主新增必填参数在插件侧兜底（signal 缺省用 new AbortController().signal）；per-child 钩子被移除时注册收口改到 root 作用域、子代理可见性用 spawn toolFilter deny 收口（领队拒见清单并入成员工具、构建器过滤同步收口、deny 清单与工具注册面加一致性断言测试），成员归属/声明路线登记点前移到 spawn/唤醒；探测式写法让测试的最小 fake 对象不受影响。再实证（同日二度踩 0.1.2 破坏面，用户贴报错「plugin tree failed to load…tool eteams_task_board is already registered…register through that agent's agent.ctx」）：0.1.2 root 注册遇重名即抛、per-agent 变体须走 agent.ctx——把成员工具提到 root 时，captainTools 里同名的 task_board/send_message/team_status 会撞名炸掉整个插件树（插件树加载失败＝全部 eteams 工具消失，表现为「完全没反应」）；解法是把同名变体合并为身份感知单工具（execute 按 caller.kind 分支：成员 caller 走成员视角、领队走领队视角），成员工厂只留成员专属件，领队拒见清单同步移除已合并名（合并后领队子代理看到的就是领队视角，不能再拒见），MEMBER_TOOL_NAMES/deny 清单与注册面的一致性断言测试同步更新；涉及工具注册面/挂载面的改动，收尾用假 ctx 跑 apply 挂载冒烟（假 registry 遇重名即抛）核实「N 个工具、无重名」再交付，临时冒烟脚本跑完即删。 Confidence: 0.75
- 空白/未开始会话的唤醒与 notice 投递原语（2026-09-08 LOGO 卡死实证）：插件调用宿主 API 静默不生效（无报错、notice 只进 inbox、回合永不开始）时，grep 宿主自家插件看它怎么做——dsh-schedule 0.1.2 的唤醒原语是 `agent.followup(message)`（「Queue an ordinary follow-up turn and wake the driver」，空会话同样开回合）；本轮实测 `agent.steer` 对从未开过回合的空白会话不再启动驱动器（/eteam 后主窗口停在 LOGO 屏的根因）、`agent.send` 在命令面的 agent 对象上也未生效。收口 deliverNotice 按 target 分发：`next-turn`（空白/空闲会话 engage）优先 followup，`next-step`（运行中插话/转交）优先 `send(msg,'next-step',true)`（wakeup 对 running/idle/blank 都正确），旧宿主逐级回退 steer；既有用例的最小 fake（只带 steer）锁定的语义（next-step 回退 steer）保持不动，按测试语义修分发、不改测试。再实证（同日换 followup 后 LOGO 屏依旧）：命令处理器拿到的 agent 对象可能是不带方法/不带 session 的 subject 引用——followup 在它身上静默无效（父会话日志连 inbox splice 都没有）；投递前先从注册表解析活 agent（`ctx.agents?.get?.(agent.id)`），解析失败/方法全缺不盲投，把投递诊断作为返回值交给调用点（engaged / agent-session-missing(id=…) / primitive=followup|send|steer|none / error:…）。判据分级：会话日志「连 inbox splice 都没有」＝投递根本没发生（agent 对象/解析层问题），「进了 inbox 但无回合」＝唤醒原语问题——两者归因方向不同，先分清再动手。2026-09-08 晚闭环实证：注册表解析活 agent + followup 投递后整条链路跑通（父会话日志坐实 turn/start、双消息入 inbox，对话视图翻转、构建子代理接管访谈映射）。教训：落 note 的诊断不可全信——rolebuilder.json 有受理→markBuilderChild→engage 多个异步写方并发写，markBuilderChild 的异步写会静默覆盖 engage 诊断 note；note 里读不到诊断/内容可疑时不要反复重写 note，直接改读父会话日志，「回合开没开」以会话日志为最终事实源。note 通道已彻底弃用为诊断面（2026-09-08 晚三度实证：engage 诊断 note 又被子代理 reportBuildProgress 的整文件写覆盖）；插件代码自身要落投递诊断时改用独立追加式日志文件——appendEngageDiag 写 <stateRoot>/logs/engage-diag.log（JSON lines，appendFileSync 只追加、无读改写竞态），记录投递结果与决策输入（agent 方法清单 typeof face.followup/send/steer/session、所选原语、异常原因），try/catch 包裹保证诊断绝不影响主流程。2026-09-09 决定性闭环（分步诊断版实测：engage-diag.log 吐出 `engage-result: "agent-session-missing(id=…)"`）：空白桌面会话在用户首条真实 prompt 之前，注册表里根本没有活 agent（`ctx.agents.get(id)` 返回 undefined——宿主只建了会话日志，驱动器实例要等首条 prompt 才物化）——这就是「三种原语全部静默无效」的最终根因：不是投递方法不对，而是根本没有可投递的对象；修复＝投递前注册表查不到活 agent 就 `ctx.agents.resume({resumeSessionId})` 把活 agent 物化出来再 followup（照搬 askUser 离线投递已验证的冷恢复模式，句柄不 dispose、锚定会话），steerEngageNotice 随之改 async、调用点 await；agent-session-missing 对空白会话不是异常分支而是预期态——处置动作是物化后照常投递，不是跳过、更不是盲投。 Confidence: 0.9
- DSH Desktop「发送没反应」排障路径（2026-09-08 实证「还是发送没有反应」，插件修复后复发——本轮查明根因在宿主模型配置层而非插件）：插件加载成功 ≠ 消息能进会话，先确认「回合有没有开起来」再归因自家代码。判据链全部自查：`~/.eteams/logs/host.log` 尾部 boot 行（builtAt=构建时间）确认宿主加载哪份 bundle，`~/.eteams/logs/client.log` 确认面板加载；宿主自身运行日志不落盘（profile 目录无 log 文件），进程端口用 PowerShell `netstat -ano` 按 PID 过滤 LISTENING 探测，web API 直探被 403 鉴权挡住走不通；会话事实看 `~/.dsh/sessions/<工作区slug>/session-<id>/session.jsonl.zstd`（zstd 压缩 JSONL，Node 24 的 `zlib.zstdDecompressSync` 可解）与投影缓存 `~/.dsh/storages/session_projcache/sessions/<session-id>.json`——turns: 0、steps: 0、lastPromptAt: null、blank: true = 消息在模型调用前就失败、连回合都没开。此时查 `~/.dsh/settings.yaml`：provider 用 `apiKeyEnv` 从环境变量读 key，该变量只存在于启动 `dsh web` 的终端会话，DSH Desktop GUI 进程继承不到（系统/用户级也没有，PowerShell GetEnvironmentVariable 双级验证）→ 没 key → 发送静默无反应。修复给三选项（桌面版设置→模型直接填 key / setx 用户级环境变量后彻底重启 / 回原终端跑 dsh web），推荐项放最前，并附验证口径：先在主对话发一句话确认模型能回，再试插件派发。临时探查脚本（probe-host.mjs、read-session.cjs）照惯例落 scripts/ 用完即删。第二轮再实证：桌面宿主运行日志不落盘（只进内存，logger.warn 拿不到），插件派发层失败靠插件自身状态文件 ~/.eteams/rolebuilder.json 看（受理成功→回滚 note；10ms 内回滚 = provider 查找/持久化服务的快失败，用失败耗时收窄嫌疑面）；桌面部署配置烘在 app.asar 里（profile 的 cordis.yml 为空），可把 asar 按 latin1 读入 grep 特征串核实桌面部署里某模块是否存在——不止部署配置/provider 包名，渲染端 UI 逻辑同样可查（2026-09-08 晚实证：按中文界面文案「探索未至之境」与客户端状态字段名 lastPromptAt/sessionBlank/isBlank 定位「未开始屏→对话视图」的翻转逻辑）；翻转机制已从全局 dsh 内嵌包源码坐实（dsh-session-projection / dsh-api-session-controller 的 applySessionListMetadata）：blank 标记在 turn/start 时清除——任何回合开始都清（插件唤醒的回合、乃至模型调用失败的回合都会翻转进对话视图，用户实证原话「调用模型失败会进入会话页面」），lastPromptAt 只在 source.kind==='user' 的消息时更新；据此「停在 LOGO 屏」严格等价于「回合从未开始」，与模型调用成败无关——先按回合边界归因，不把「没翻转」误归因为模型调用问题。 Confidence: 0.8
- 宿主运行日志不落盘时，把真实错误带上用户可见表面（2026-09-08 实证，构建派发失败排查）：失败处理回调（onSpawnFailure、同步 catch 等）不吞 error——用 `error instanceof Error ? error.message : String(error)` 把真实原因写进用户能看到的表面（构建卡片回滚 note「构建派发失败……（原因：xxx）」），让用户重试一次即可拿到根因，不在拿不到日志时盲猜原因；调用点注释写明理由（桌面宿主 logger.warn 不落盘，卡片是用户唯一可见的失败表面）。已闭环验证（同日晚）：用户重试一次，卡片 note 直接吐出根因「subagents 服务不可用」——定位到 subagentsReady 漏改；失败原因常驻卡片 note 不清（以后再出问题卡片即自带原因）。 Confidence: 0.85
- 排障结论被用户正面证据反驳时重新立案、往下一层查（2026-09-08 实证：原归因 API key 缺失，用户以「模型是好的，输入你好进入了对话页面、也看到成员构建卡片」反驳并要求「仔细排查」）：不辩护旧结论，转入下一层——对照会话日志与插件状态文件（rolebuilder.json）重新定位真实失败点（本例：构建会话受理成功但子代理 spawn 被回滚，是此前修复之外另一点 0.1.2 不兼容）。 Confidence: 0.75
- 持久子代理「创建成功却不推进」排障路径（2026-09-08 实证「还是发完没有跳转，但是子代理已经创建成功了」）：先 grep 面板代码坐实跳转/推进的触发条件（buildWorkbench：只有构建到达 awaiting_confirmation 草稿就绪才跳转），再查构建会话为何停在原地——rolebuilder.json 看 step、子代理会话日志看首回合做了什么；**子代理自己的推理文本是工具可见性类故障的直接证据**（日志尾部原话「build_report 通道不在我工具集里」「无法调用 eteams_member_save (not in schema)」直接点名缺失的能力，比对照代码猜快）。本轮根因（上一轮自埋）：builderToolFilter 把 MEMBER_DENIED_TOOLS 未过滤地摊进 deny，而该清单本就含构建四件套（build_report/build_wait/member_list/member_save），子代理被禁了自己的核心工具后只能降级乱试（误调 team_status 报身份错），永远到不了 awaiting_confirmation。一般化教训：**deny/allow 清单合并前先减去目标代理自身必需的工具**，并把「核心工具永不被禁」写成回归测试（builderToolFilter 导出供断言：构建四件套不在 deny、构建面之外的成员工具在 deny）。 Confidence: 0.75
- 「跳转」有两级转场，用户报「没跳转」先对齐是哪一级（2026-09-08 用户实测纠正原话「不是跳转新增页面，而是对话窗口没有进入到有对话、轨迹、团队这个tab页面」）：第一级＝/eteam 后主窗口从「未开始屏」进入带对话/轨迹/团队 tab 的会话视图（构建卡片挂在该视图里，靠 engage notice 开回合驱动）；第二级＝构建到达 awaiting_confirmation 草稿就绪后自动跳面板新增页。两级归因方向完全不同（第一级查唤醒原语/回合边界，第二级查构建管线推进）——上一轮把「还是没跳转」继续按第二级排查（子代理工具可见性），实际卡的是第一级；用户跟进报告会主动纠正症状所指的界面面，按纠正后的现象重新对齐触发链再排查。第一级排查的前置判据再加一道：先读目标新会话日志里有没有 command/run 事件——没有＝命令根本没在宿主执行（被门禁/投递层挡下，如上一个构建 active 挂着门禁），不是「执行了但没转场」（再实证 2026-09-08 晚：「老问题还是没解决，新会话填入创建角色指令后…没有进入到对话中」，20:52 新会话日志里连 command/run 都没有，先看日志才没按转场失败继续猜）。 Confidence: 0.75
- 受理即转场、消除「卡死」观感；自动转场只到对话视图，不自动跳二级页面（2026-09-08 用户迭代原话「我想跳对话不是跳到角色创建页面」，终态）：engage 通知（user 身份注入）开回合即把空白会话翻到对话视图——唤醒同步归入受理步本身（steerEngageNotice 紧跟受理写盘下一行执行，不另立后置步骤），视图翻转由 turn/start 瞬间驱动（通知走 user 身份保证 lastPromptAt 更新），不等模型回话；构建卡片就挂在对话视图里实时刷新，后台进度的可见反馈在用户所在处交付。曾按用户「我不想有这个延迟，我想直接跳过去看到创建卡片。不然用户会以为卡死了」两次 reinstated「构建卡片首轮轮询（≤1.5s）命中自己归属的构建会话即 openMemberBuilder() 跳成员构建工作台」（按 startedAt 去重、同一构建只跳一次），同日被「跳对话不是跳到角色创建页面」再次整套撤除——openMemberBuilder 只保留卡片点击跳转（用户主动），JUMPED_BUILD_STARTED_AT 去重变量一并清掉；2026-09-06 撤定时强跳、2026-09-08 两度反复，同根因多轮实证。泛化：任何「受理→可见反馈」链路不允许无反馈等待，即时反馈优先——用户会把延迟直接读成程序卡死；但反馈手段是在当前位置就地呈现（对话视图+卡片），不是把用户导航去别的页面——自动跳转工作台/创建页这类二级页面与用户意图相反。 Confidence: 0.9
- 程序化跳转/导航绝不放进轮询重试循环，严格一次尝试、立即标记（2026-09-08 回归实证，用户原话「我点击对话会点不过去，会闪烁一下然后跳回角色页面」）：中间版用 `teamsTabVisible()` DOM 探测判断「是否已跳」，0.1.2 桌面 tab DOM 变了探测恒 false → 视为永远没跳 → 每 1.5s 重新 `openMemberBuilder()` → 反复把用户从「对话」拽回面板角色页（正是 2026-09-06 删强制跳转的同一根因，重建该机制时没带上旧防护）。定案：首次轮询命中即跳并立即标记（不管点没点中），万一落空靠卡片手动点击兜底；跳转成功与否不用 DOM 可见性探测判定（跨宿主版本不可靠）。一般化：自动导航与用户自己的点击天然打架——重试型导航等于反复劫持用户焦点，宁可跳空一次也不能拉锯。 Confidence: 0.8
- 角色库保留角色「system」产品语义（2026-09-08 v12 用户迭代，原话「新增一个特殊角色，用 is_root 标识，这个角色主要在主队话窗口注入MD到system中间。默认MD是空的，提示用户这是往主队话注入的角色，这个角色叫 system。然后不能被添加到团队中间去」）：roles.is_root=1、保留名 system；手册(MD) 注入主对话窗口 system 提示词，默认空（空=不注入）；不能加入任何团队（面板弹窗过滤 + host addMember 硬拒双保险）、不可删除/改名；面板可编辑原文，页头只显示建库播种进 roles.profile 的库内简介（2026-09-09 撤详情页硬编码 root 副注——与库内简介同义重复，用户原话「为什么提示重复了？已经有数据库里面的说明了」）、手册卡提示行告知「这是往主对话注入的角色」但只在手册为空时显示、有内容后隐藏（同日用户原话「有内容后就不显示这个提示了」——空态引导定位，按已保存 persona_md 判断）；角色库列表排序 system 置顶第一（2026-09-08 用户原话「把system 排到第一个去」）——排序收口在客户端 memberRank（src/client/pages/shared/styles.ts，列表页复用），rank 定为 system=0、领队=1、构建师=2、其余=3，动排位逻辑或新增保留角色时维持此序。 Confidence: 0.85
- 宿主动态提示段注册惯例（index.ts 接线）：核心机制是 `systemPrompt.section`，text 闭包每次装配现求值（面板改 MD 即热生效，无需重启）；空串=不贡献作空段语义；注册与求值全程 try/catch 吞错降级返 ''，绝不让装配失败。旧注入（3b2/3b3 sessionPersona/sessionTeam）是 section+context 双通道先例（order 一前一后，whichever channel a composition renders 注入都存活），但新注入默认单通道——v12 的 3b4 起初照双通道先例各注册一份，用户读到汇报即质疑（「怎么是 上下文注入，而不是system注入」），随后拍板（原话 2026-09-08「不走上下文了，只走system 本体」）：context 快照通道（order 902）整套删除、只留 systemPrompt.section（order 109），注释记日期+原话；3b2/3b3 的双通道不跟着动，但不再照抄到新接线。一般化教训：冗余保险通道用户不认账（读汇报就能看出多余机制），拍板后整套删干净、不留「保险」折中；仓库既有惯例与用户显式拍板冲突时以后者为准。范围限主对话的注入用排除法过滤 eteams 子代理三件套：领队子代理（captainChildren 注册表）、成员/领队副本行（task_members.session_id，持久、重启免疫）、构建器子代理（rolebuilder.json builderChildId）。注入类改动汇报时讲清段落实际落点（system 本体 vs 上下文快照）。 Confidence: 0.75
- 保护性守卫收口在多入口汇聚点、面板与代理写路径用显式 opt-in 区分（allowLeader 先例扩展 allowRoot）：入团守卫加在 teamOps.addMember 一处即覆盖 captain 工具与面板路由两个入口；upsert 默认拒写保留角色（保留名 + 拒删 + 拒改名），面板显式保存经 options.allowRoot/allowLeader 放行，代理侧写路径（eteams_member_save 等）保持拒绝。 Confidence: 0.7
- 特殊行的用户编辑文本逐字往返、写读两端都不经结构烘焙（v12 system 角色 persona_md 直存原文：写端不走 personaToMd、读端特判不走 personaFromMd；客户端编辑初值同样跳过 handbookSeed 兜底）：否则空文会被兜底烘成结构脚手架、编辑回显与再保存污染原文——「空 MD=不注入」这类空有语义的字段必须原文保真。 Confidence: 0.65
��提示行要删掉」同一原则，设计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
非没写入）；`~/.dsh/settings.yaml` 直接读配置值坐实显示歧义根因（agent-default-model.model 本身就是 z-ai/glm-5.3-free，即目录 id）；profile 插件副本核对是否旧构建。向用户汇报时引用具体表/行/配置值作证据。「数据没落库/记录在哪」类问题只读直查实际库定位再归因（node:sqlite DatabaseSync readOnly：PRAGMA table_info 判列是否迁移出来=新构建+重启状态、目标行内容、schema_meta 版本；写入疑点用 events 表 payload 与行内容对比——事件 payload 带字段而行上 NULL = 写路径 setter 漏赋该字段，2026-09-08 实证：member.updated payload 带 provider 而主持行 77 provider 列 NULL → setLeaderModel 漏赋 provider，而非传输/迁移问题）；答「目前记录在哪里」按「谁的数据→哪张表→哪一行」对照表汇报。 Confidence: 0.8
- 数据完整性损伤优先做写路径内自愈而非一次性修库（实例 2026-09-08：领队主持行从 task_members 消失，leaderRowOf 为 undefined 使 setLeaderModel/persistCaptainChildId 全部静默 no-op——模型没入库、session_id 恒空、每次派发重建子代理）：写前就地补建（notifier.ensureLeaderAnchorRow 从班底领队行派生主持行；SQL 侧 UPDATE 零命中后 INSERT..SELECT 兜底），自愈发生即打 warn 日志留痕（复发可查），班底也无领队行才维持原静默口径。 Confidence: 0.75
- 第三方解析/渲染库的疑难 bug 先证伪初版方案再落码：读装包 dist 源码定机制后，把假说做成最小用例实测、允许被推翻（2026-09-07 实证：mdeditor 空白排查原定 jsxPlugin 通配描述符方案，最小用例实测发现裸 `<X>` 在严格 MDX 下是硬解析错误、启用 jsxPlugin 也救不了，转向编辑器入口转义）；定案后再把修复方案的关键行为逐条跑通（转义后可解析、导出幂等、边界不误伤 autolink/散文比较、mdast 往返字节保真）才写业务代码。 Confidence: 0.7
- 批量编号 UI 迭代逐条�钮」只撤详情页页头，成员详情页页头同款按钮保留并主动问「如也要去掉说一声」）。 Confidence: 0.65
- 有状态弹窗/行内控件的数值初值取当前真实持久状态，不从 0 起算（用户原话 2026-09-07「+ - 按钮的数量都是0，但是我已经有8个成员了」）：选择成员步进器中间数字显示该角色当前在团份数（同名 -N 后缀副本计入）。弹窗底栏汇总计数同理按「应用本次增减后」口径显示——「N人/上限人」（在团 + 增减 + 加回领队），随加减实时变，给确认后的团队规模而非打开时的静态快照（用户先要求撤掉底栏计数、同日又点名「团队添加成员弹窗里面还是要有 12人/20人显示出来」要回，恢复时按新口径实现而非机械还原旧版）。 Confidence: 0.65
- 撤功能/撤入口做整链清理再收尾：UI 元素、组件内死状态、props/接口字段、路由传参、壳层 handler、孤儿 import 一并撤（2026-09-07 实证：成员详情撤「汇报记录/编辑/同步到角色」时 onOpenReports 全链清掉；创建流程撤离后 onSelectTeam/error 死状态一并清理），以 typecheck 收敛确认无残留。 Confidence: 0.65
- 团队页产品语义（用户迭代 2026-09-07 十项清单定稿）：「添加成员」改名「选择成员」——一行一角色 + 加减步进器，确认时一次性逐个 POST 应用增减、遇错停在原地已成功的保留；＋加份按占用序号取下一空位、第二份起自动 -2/-3 后缀并照抄角色库默认值，−从后缀最大副本移出；工号不在此展示（入团时 host 自动发、每份各拿各的号），名额口径含领队。团队详情页撤「任务 X/Y 完成」行（进度在任务页看）、人数提示只留「n/cap 人」；成员详情页手册只读（撤「汇报记录/编辑/同步到角色」，手册改动走角色页）。 Confidence: 0.7
- 排障+修复类迭代用户明确要求「仔细排查，分步完成并校验」（原话 2026-09-08）：多个症状先分层各自查透（「没入库」与「显示歧义」分开归因，不混为一谈），结构性改动（加列跨 schema→types→store→host→client）用 todo 按层分步、每步落地即做对应校验（schema 改完 tsc、链路接完跑相关测试），收尾全套验证+完整构建链。再实证（2026-09-09，engage 跳转问题隔天仍复发）：疑难杂症多轮补丁不收敛时，用户会点名「启动workflow来修复这个疑难杂症」「再仔细梳理一下逻辑」——升级为系统化排查流程（先取全诊断证据，从头重新梳理整条逻辑链找断点），不是继续零敲碎打式打补丁。2026-09-09 晚再实证（同日 engage 排查中）：助手给出「诊断版已构建＋后台调查 agent 已起＋请你重启重试」的推进方案被用户整否（原话「不行，再找找原因，先理清楚思路」）——重试型推进（重建→重启→重发）不收敛时用户会直接喊停；「理清思路」有具体形态：停止盲改 → 先取一次完整证据（host.log boot 行、diag 日志、状态文件、bundle 内容）→ 摆已证实的完整逻辑链表格（每步状态、标出唯一断点）→ 点名核心矛盾（同一投递原语一路有效一路无效）→ 列待验证假设（A：代码没执行到；B：执行了但命令面 agent 对象缺方法）→ 埋区分性诊断（处理器每步 handler-enter→gate-read→accepted→child-dispatched→engage-result 落独立追加日志）让下一次重试一锤定位——先把这套推理完整呈现给用户，再谈操作步骤。 Confidence: 0.8
- 机制/根因讲解备一套零基础口径：用户听完带 file:line/SQL/术语的技术版排查结论后会点名「再仔细解释一下……用小学生都能听懂的话」（2026-09-08）——白话版不是把结论缩短，而是完整重讲：用日常生活比喻逐层映射系统概念（工地比喻：team_members=正式档案柜、task_members=每个项目的临时出入证、建大任务=开工时给全员复印出入卡、副本行 md/profile 空=复印卡忘写编号查不到档案），细节照给（用户原话「详细介绍一下」），配「该存在/不该存在」对比表格与「总结成一句话」收束，修复方案仍挂末尾等用户拍板。2026-09-08 再实证泛化：不応、task_members=每个项目的临时出入证、建大任务=开工时给全员复印出入卡、副本行 md/profile 空=复印卡忘写编号查不到档案），细节照给（用户原话「详细介绍一下」），配「该存在/不该存在」对比表格与「总结成一句话」收束，修复方案仍挂末尾等用户拍板。2026-09-08 再实证泛化：不必等技术版结论在前，用户主动提讲解类请求时就直接点名该口径（原话「详细列举eteams_命令做啥用的，那些模块用到了，用小学生都能听懂的话」）——按讲解主题现选贴切的比喻体系（班级比喻：领队=班长、成员=同学、任务=作业卡、工具=班长/同学手里的小按钮），覆盖面照旧全量不漏、一句话总结收束。 Confidence: 0.75
- 讲解命令/工具用途时逐条带模块归属（用户原话「那些模块用到了」）：每个条目白话描述后直接标注「→ 实现/消费模块」（如 eteams_create_team → runtime/teamOps、面板 eteamsCard.tsx），归属用 grep 全量反查坐实（runtime/prompts/client/tests 各目录按工具名 grep，覆盖定义、注册、提示词话术、面板渲染、测试引用），不凭记忆；条目按使用者/作用域分组（「谁手里有这些按钮」），收尾汇总一层「模块全景」（发按钮/门卫/后台/话术/看板/测试各归其位），让用户既懂用途也懂代码落点。 Confidence: 0.6
- 领队任务副本行是有意设计、不跳过（2026-09-08 定案，推翻同日早前的「跳过领队」实施）：用户先问「建大任务时不能直接用第一张卡吗？」被误当拍板实施了 createTask 循环跳过领队，随即被用户纠正「不对，领队也相当于普通成员，每个大任务也会给领队开一个独立的子会话」——领队与普通成员同权铺任务副本行（不按 isLeader continue），副本行是该大任务内领队独立子会话的锚点；已整套回退（edit 原样还原 + 注释标明「领队同样铺行（用户迭代 2026-09-08 确认）：领队也算普通成员，每个大任务给他开独立的子会话锚点」防后人当脏数据清理），回退后跑全量测试（447 全过）+ 双 tsconfig typecheck 收敛。副本行不落 role_id → 面板 md/profile 空是所有副本行（含普通成员）的既有口径，非领队行独有缺陷；主持行与副本行职责对比（当时主持行=领队常驻身份/手册缓存，副本行=项目内状态/子会话锚点/手册快照）已按工地比喻向用户讲清，用户追问「有了第一张卡，为啥还需要副本卡」属理解性追问、先答不动手。同日晚些时候用户定案终局方案（见下一条）：主持行取消。
- 领队子会话随大任务生灭、团队级主持行取消（2026-09-08 定案终局，用户原话「领队不会存在于还没有项目的时候，领队就是随任务生灭的呀，任务开始时判断团队有没有领队，有领队才创建领队引导后续所有的任务，没有领队就是主对话引导后续所有任务」）：领队不是常驻角色——「有没有领队」= 班底 is_leader 行 + hasLeader 的配置开关；任务开始（首派）时为本大任务建领队子会话，锚定该任务的领队副本行（is_leader=1 且 main_task_id=任务号，session 落副本行），任务删/完副本行级联删、会话随之回收；老任务副本行缺失时锁内补铺（手册=旧主持行缓存→班底→内置依次兜底，存量主持行新代码不再读写）；eteams_dispatch_captain 增加 taskId 参数（band 两步走改为「先建任务 → taskId=主任务号+用户原话转交」，缺省兜底最近主任务、无主任务明确报错「先建任务」）；createTeam 不再建主持行，移除/加回领队收拢为班底配置开关（删/建班底领队行+hasLeader）；领队副本行的子会话按 captain 解析身份（不误判 member）。Confidence: 0.85
- 补铺/去重类写前判断在锁内基于 fresh 读，不信任调用方传入的状态快照（2026-09-08 真 bug：面板 commission 路径传建任务前的旧团队快照，副本行补铺照旧快照查不到 → 同任务双铺领队副本行）：一律锁内 readTeamSync 现读再判再写。Confidence: 0.7
- 复发/异常数据类排障用「行指纹 → 唯一制造者」收敛，真实数据够不到时给用户最小判别步骤而非继续推理（2026-09-08 实证「还是创建了 77」）：先用异常行的字段特征组合（status=ready、persona_md 空、main_task_id NULL）反查代码里的唯一制造路径、并排除新代码已整删的路径，据此收敛到「旧构建自愈产物」而非继续改代码；宿主真实状态库不在 C:\eTeam 仓库工作区（.eteams 下无 .db，宿主在别的工作区跑），直查不到真实数据就不再猜，请用户代跑最小判别步骤——①宿主启动日志找新构建特征行（如 `eteams: leader handbook prompt variable registered`）判定加载的是新是旧（顺带查插件路径是否指向别处旧拷贝而非 C:\eTeam\lib）；②只读 SQL 查异常行全字段，附「特征 → 结论 → 处置」对号表（main_task_id NULL+md 空=旧自愈脏数据可删；main_task_id=任务号+session 非空=新模型副本行别删；重启后又长新行=确实旧构建）；破坏性清理（DELETE）放最后单独给，明示前置「确认宿主是新构建后再执行」并说明删除无功能影响，不凭未证实的推断就建议删数据；判别步骤会被用户照做（2026-09-08 实证：SQL 查询结果以制表符分隔的原始行、无表头贴回）——解码贴回的原始行前先读 schema.sql 对齐真实列顺序再逐列对号，不按口头列名硬套。归因与处置分离、归因优先：用户在助手据「旧构建产物」推断顺手加启动清理（启动 sweep 删废弃主持行）时纠正「不是删除，而是那里创建的，要搞清楚啊」——先穷举全部写路径把创建点钉死（结论按「唯一通用插口 → 各调用方 → 迁移/导入旁路」逐一对号成表），删除/清理类处置（含一次性清理与内置的自动清理机制）等创建点坐实并经用户确认后再定，不凭未证实的归因就往代码里加清理；被否掉的清理代码要立即整套撤销（函数+挂载点+import 一并撤，tsc/测试/构建同步收敛）再继续排查。Confidence: 0.8
- 用户对悬置方案的反问/质疑是探索性提问、不是拍板，不按反问直接实施设计变更（2026-09-08 实证教训：「建大任务时不能直接用第一张卡吗？」被解读为「认可 + 修正方向」并直接实施跳过领队，随即被用户纠正「不对，领队也相当于普通成员……」整套回退）：正确顺序是先答清两边道理、把「保持现状 vs 拟改方向」摆给用户选，等用户明确拍板再动手；用户连环追问机制依据（「有了第一张卡，为啥还需要副本卡？请详细与我沟通」）同样只做讲解不动代码——追问是在吃透设计以便自己验收，不是授权改。追问会连环多轮：上一轮的详细解答（比喻+对比表）没完全落地时，用户会带着自己的新推断再来一轮（2026-09-08 实证再追问：「我已经每个任务都有一个副本了，本来就不会打架了啊，再建一个副本的意义何在？请详细与我讨论」）——答案要正面接住用户自己的推断，先承认对的那一半（「你说的对了一半」）再点出缺失的那块（副本卡管项目内进度、随任务生灭；主持行管不随任务生灭的团队级事项），不照搬上一轮原文、每轮保持同等深度；用户一再点名「请详细与我讨论/沟通」，设计讨论回合按可来回往复的对话准备，不是一次性答疑。 Confidence: 0.8
- 子代理用户问答路由：已定稿并实现完毕（2026-09-08 用户拍板两项产品决策后「按照计划执行」，vitest 全量/typecheck/lint/构建全绿）。范围=eteam 创建的所有子 agent（领队/成员）统一走 `eteams_ask_user` 直问用户、不经领队转达（用户拍板「所有子agent」；构建器访谈管线保持原样不迁移）。路由=用户在看提问会话（presence 心跳 15s 内命中）就地直弹、否则**严格转交主会话**弹出——用户在 ask_user_question 选项里明确选了「严格主会话」、否掉助手标 Recommended 的「跟随用户位置」：转交目标取确定性锚点（task.main_session_id 快照）而非上下文感知，presence 只作就地弹判断（心跳缺失/过期一律按「不在」，宁可转交不可白弹）。硬约束（探索坐实）：dsh-user-questions 全局单 provider 不做路由、provider 层劫持不可行（DUPLICATE_PROVIDER），路由只能在工具层做。落地形态：DB v11 ask_questions 表（ask_id 幂等键、pending→answered/expired/cancelled）、eteams_ask_answer 回收、在线 steer/离线 agents.resume 冷恢复、工具结果+prompt 双通道要求子 agent 提示「问答已转交主会话」、面板 pendingAsks「N 项待问答」徽标。2026-09-08 用户实测后修订（用户原话「在主会话中回答完问题，子回话没有收到，而且子回话不需要一直wait呀」）：撤掉阻塞轮询（原 1800s）——转交后立即返回、子 agent 结束回合，答案经 eteams_ask_answer 回收后由宿主 wakeAskingChild followup 送达提问子代理新回合（锚点在线 steer/离线冷恢复，绝不排队饿死）；实测同时坐实直接诱因之一是宿主进程仍缓存旧 bundle（v0.2.12），改完必须重启宿主再测。构建器访谈切上统一路由见「改动落在源头」条。 Confidence: 0.9
- 子代理上报的进度状态由宿主按规范时间线推导，不给模型留整体替换型自报字段（用户报 2026-09-08 蓝点乱序：eteams_build_report 曾暴露 stepsDone 整体替换参数，模型报残缺列表把已点亮的步骤抹掉，出现第三步先蓝、前两步不蓝）：按字面匹配驱动的 UI 状态（面板蓝点按步骤名逐字点亮）以单一规范字面常量为准（BUILD_STEP_ORDER 与客户端 BUILD_STEPS 逐字对齐），提示词与工具描述同步引用同一字面序列，杜绝「提示词查重成员库 vs 客户端查重角色库」这类字面漂移；宿主边界加别名映射容忍播报名漂移，工具参数设计上直接撤掉可被模型报错的列表字段，已完成前缀由宿主从当前步骤推导（非时间线步骤不推导、沿用原列表）。 Confidence: 0.7
- 页头动作钮（返回钮）贴页头行最右端、不紧挨标题（用户原话 2026-09-08「按钮没有在最右边」）：返回钮统一收口 components/backButton 图标钮后，位置定为页头行最右——BackButton 内建 `ml-auto`、PageHeader 中压轴（最后）渲染，无动作位的页自动贴最右、有动作位的页（如「＋ 新增团队」）排在动作位之后仍居最右；整页覆盖层顶栏（teamsPanel）用 `justify-between` 让返回钮居顶栏右端。头部单个动作钮的默认锚点是行末，不是标题邻位。 Confidence: 0.85
- 收到「工具调用被中断、结果未持久化/结果未知」的恢复标记时不盲目重试（2026-09-08 实证）：按工具语义分流——只读/幂等操作才考虑重试，可能有副作用的先核对外部状态或问用户；本例用只读 node 直查插件状态文件（rolebuilder.json）与会话列表、再读会话日志核实中断点归属（上一轮失败构建尝试中、应用重启打断的工具调用，宿主补的遗留标记），结论「无害、无需重试」后随即继续推进当前任务，不在标记上空转；向用户交代时结论先行（标记来源 + 为何无害 + 当前构建健康），再给后续预期。 Confidence: 0.7
- 弹层内异步数据（模型目录这类按需拉取）的刷新提示用 stale-while-revalidate：已有数据时后台静默刷新、旧列表照常可点，loading 提示条只在首次无数据时显示——用户报「模型选择一直显示正在刷新模型列表」，根因是每次打开都强制 reload、宿主逐提供方拉取慢时提示常挂（2026-09-08 定案）。配套限时兜底（同日再实证，用户报「还是一直在 正在刷新模型列表」）：底层目录加载 RPC 无超时保护（ModelDirectory.load() 不传 signal，某个提供方挂起即 promise 永不结算），客户端加 15s 限时（Promise.race）——超时按加载失败处理（错误条+重试+静态回退），只放弃等待、不取消底层 RPC，迟到的成功仍写进共享目录 store 供下次打开/重试命中。 Confidence: 0.7
- 返回钮视觉档（2026-09-08 用户迭代「背景改成白色，边框加深」）：ghost 改 outline——白底 bg-white、显式 border-solid + slate-300 加深边框、hover 保持白底仅文字提亮、shadow-none；收口在 components/backButton 一处，全表面页头生效。 Confidence: 0.7
- 用户工作区有未提交改动时不用 git stash 做「失败用例是否既有」的对照实验：stash 会把用户改动一并卷走，pop 与测试串在一条命令里还会竞态延迟恢复（2026-09-08 实证，靠立即补 pop 抢救）；判归属改用只读手段（git status/diff、看测试 import 依赖、按改动文件相关性推理），确需 stash 必须单步执行、下一步立即恢复并核对工作区。 Confidence: 0.6
��提示行要删掉」同一原则，设计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
并校验」（原话 2026-09-08）：多个症状先分层各自查透（「没入库」与「显示歧义」分开归因，不混为一谈），结构性改动（加列跨 schema→types→store→host→client）用 todo 按层分步、每步落地即做对应校验（schema 改完 tsc、链路接完跑相关测试），收尾全套验证+完整构建链。 Confidence: 0.7
��提示行要删掉」同一原则，设计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
：多个症状先分层各自查透（「没入库」与「显示歧义」分开归因，不混为一谈），结构性改动（加列跨 schema→types→store→host→client）用 todo 按层分步、每步落地即做对应校验（schema 改完 tsc、链路接完跑相关测试），收尾全套验证+完整构建链。 Confidence: 0.7
��提示行要删掉」同一原则，设计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
idence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
」同一原则，设计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
计状态/汇总展示时先核对主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
idence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
idence: 0.7
nce: 0.7
idence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��器已表达什么。 Confidence: 0.7
nfidence: 0.7

nfidence: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
��指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7

�主指示器已表达什么。 Confidence: 0.7
nfidence: 0.7
nce: 0.7
