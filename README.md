<div align="center">

<!-- 可选：项目 Logo。把图片存到 docs/images/logo.png 后取消下一行注释
<img src="docs/images/logo.png" alt="ETeams" width="88" />
-->

# ETeams

**让 AI 组成一支真正的团队。**

领队拆解目标，成员接力执行 —— DeepSeek Harness 的多智能体团队协作插件。

[![Version](https://img.shields.io/badge/version-0.2.16-4B6BFB?style=flat-square)](package.json)
[![License](https://img.shields.io/badge/license-MIT-3DA639?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?style=flat-square)](package.json)
[![Platform](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6E56CF?style=flat-square)](https://github.com/deepseek-ai)

[安装](#安装) · [三步上手](#三步上手) · [核心能力](#核心能力) · [界面](#界面) · [工具一览](#工具一览) · [配置](#配置)

</div>

---

<!-- ⬇ 截图位 ①：保存到 docs/images/panel-board.png（建议 1600×900，2x 更佳） -->
<p align="center">
  <img src="docs/images/panel-board.png" alt="ETeams 面板 · 看板" width="880" />
  <br />
  <sub><b>看板</b> —— 团队目标、成员状态与实时动态，一屏总览</sub>
</p>

## 这是什么

ETeams 给 DeepSeek Harness 装上「一支团队」：你把目标丢给**领队**，领队把目标拆成任务、按**执行链**派给**成员**，每个成员在自己的子会话里独立干活，进度、失败、决策全程落库、实时可见。

不是「一个大模型假装多个人」，而是真实的多会话协作：**每个任务都是新人新会话**，谁在做、做到哪一步、出了什么问题，看得见、查得到、管得住。

- **包名** `dsh-eteams`，插件 id `eteams`，双端单包（宿主端 + 浏览器端）。
- **自包含**：构建产物已内联全部依赖，无运行时安装负担；状态存本机 SQLite（内置 `node:sqlite`），不联网、不上传。

## 三步上手

| 步骤         | 做什么                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| **1 · 造人** | `/eteam` 面试式生成角色手册，落进全局角色库 —— 每个角色就是一张岗位卡。 |
| **2 · 组队** | 面板「团队」页从角色库挑人进班子，指定一人为领队。                      |
| **3 · 交活** | 对话里说清目标 → 领队拆解、你批准 → 自动派发执行，全程在面板围观。      |

<!-- ⬇ 截图位 ②：保存到 docs/images/panel-team.png（建议 1600×900） -->
<p align="center">
  <img src="docs/images/panel-team.png" alt="ETeams 面板 · 团队" width="880" />
  <br />
  <sub><b>团队</b> —— 挑人进班子、发放工牌、给每个成员配置独立的模型路线</sub>
</p>

## 核心能力

| 能力                    | 说明                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **领队 + 成员双层协作** | 领队负责拆解与调度，成员负责执行；有领队则由领队主持，没有就由主会话直接主持。                                      |
| **执行链接力**          | 任务带成员序列，站点按序接力，一站完成即自动续派下一站；偏离必须留痕。                                              |
| **任务状态机**          | 8 态收敛（创建中 / 待开始 / 执行中 / 待分诊 / 已挂起 / 待用户 / 已完成 / 已取消），非法流转当场拒绝并给出中文原因。 |
| **失败自动重试与升级**  | 同成员自动重试，预算耗尽后进「待分诊」：换人、挂起、还是来问你，由你决定。                                          |
| **角色库 + 角色构建师** | 面试式问询产出结构化角色手册；角色可复用，同一角色能请多份工牌。                                                    |
| **实时 Web 面板**       | 看板 / 团队 / 角色 / 任务四页，快照轮询实时刷新，写操作直接落库。                                                   |
| **对话内卡片**          | 主会话里工具调用处自动折出任务卡，一键跳到任务详情或成员会话。                                                      |
| **用量台账**            | 自动采集每个会话的模型用量，日历热力图看清团队花了多少 token。                                                      |
| **持久化与文档**        | 单库 SQLite 存全部状态；每个主任务一个工作目录（留言板 / 纪要 / 计划 / 文档）。                                     |

## 界面

<!-- ⬇ 截图位 ③：保存到 docs/images/panel-tasks.png（建议 1600×900） -->
<p align="center">
  <img src="docs/images/panel-tasks.png" alt="ETeams 面板 · 任务" width="880" />
  <br />
  <sub><b>任务</b> —— 主任务与小任务、执行链站点、状态一屏看全</sub>
</p>

<!-- ⬇ 截图位 ④：保存到 docs/images/panel-roster.png（建议 1600×900） -->
<p align="center">
  <img src="docs/images/panel-roster.png" alt="ETeams 面板 · 角色" width="880" />
  <br />
  <sub><b>角色</b> —— 全局角色库，手册、头像与一句话简介集中管理</sub>
</p>

<!-- ⬇ 截图位 ⑤：保存到 docs/images/conversation-team-tab.png（建议 1600×900） -->
<p align="center">
  <img src="docs/images/conversation-team-tab.png" alt="对话内的团队面板与任务卡片" width="880" />
  <br />
  <sub><b>会话内</b> —— 对话顶部「团队」页签、输入区「团队」按钮与可跳转的任务卡片</sub>
</p>

## 安装

**方式一：插件市场（推荐）**

在 DeepSeek Harness 插件市场搜索 **ETeams**，一键安装后重启应用。

**方式二：命令行**

```bash
dsh plugin --profile desktop add dsh-eteams
```

**方式三：本地源码（开发调试）**

```bash
git clone <repo-url> && cd eTeam
pnpm install && pnpm build
dsh plugin --profile desktop add C:\eTeam
```

安装后核对装配结果，并重载客户端：

```bash
dsh --profile desktop --dump-config
```

**验证是否就绪**：对话区头部出现「团队」页签、输入区工具行出现「团队」按钮；在任意对话里发一句 `eteams_ping`，能收到回执就说明通路正常。

## 工具一览

插件为模型提供 `eteams_*` 工具面。通常你不需要手写这些调用——直接说目标，领队会自己用。

<details>
<summary><b>领队工具</b>（拆解、派发、调度）</summary>

| 分组     | 工具                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| 团队     | `create_team` · `list_teams` · `delete_team`                                                               |
| 成员     | `add_member` · `remove_member` · `update_member` · `member_save` · `member_list`                           |
| 角色构建 | `build_report` · `build_wait` · `build_dispatch` · `interview_answer`                                      |
| 任务编排 | `create_task` · `submit_task` · `update_task` · `delete_task`                                              |
| 派发执行 | `assign_task` · `advance_task` · `reassign_task` · `suspend_task` · `resume_task` · `cancel_task`          |
| 协同     | `send_message` · `team_status` · `task_board` · `mailbox` · `dispatch_captain` · `ask_user` · `ask_answer` |

</details>

<details>
<summary><b>成员工具</b>（在成员子会话内可用）</summary>

| 分组     | 工具                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| 执行面   | `claim_task` · `decline_task` · `append_progress` · `complete_task` · `fail_task` |
| 视图协同 | `task_board` · `send_message` · `team_status`                                     |

</details>

## 命令

| 命令                | 说明                                                       |
| ------------------- | ---------------------------------------------------------- |
| `/eteam [需求描述]` | 角色构建师入口：面试式问询 → 生成角色手册 → 落全局角色库。 |
| `eteams_ping`       | 连通性冒烟，安装后首选验证。                               |

## 配置

在 `cordis.patch.yml` 的 `config:` 块中调整（均有默认值，可留空）：

| 配置项           | 默认值    | 说明                                                                                     |
| ---------------- | --------- | ---------------------------------------------------------------------------------------- |
| `stateDir`       | `.eteams` | 状态根目录。**绝对路径 = 全局单库**（所有工作区共用一份）；相对路径 = 每个工作区各一份。 |
| `workRoot`       | `teams`   | 任务工作目录根：`<workspace>/<workRoot>/<主任务号>-slug/`。                              |
| `maxMembers`     | `10`      | 单团队成员数上限。                                                                       |
| `maxRetries`     | `3`       | 同一成员自动重试预算，超限转入「待分诊」。                                               |
| `memberProvider` | `spawn`   | 成员子代理的派生方式：`spawn` 或 `fork`。                                                |

## 架构

**双端单包**：同一个 npm 包里同时装宿主端（Node cordis 插件）与浏览器端（Web 面板），一次安装两端就位。

```
dsh-eteams/
├─ src/host/      宿主端：eteams_* 工具面、成员运行时、SQLite 持久层、/eteam 命令
│  ├─ model/      纯领域模型 —— 任务状态机、任务合同（无框架依赖，可直接单测）
│  ├─ state/      SQLite 持久层 —— schema、迁移、查询、用量台账
│  ├─ runtime/    派发执行、执行链、角色库、成员构建、会话绑定、Web 回环面
│  └─ prompts/    领队 / 成员 / 构建师的全部提示词（单一平面）
├─ src/client/    浏览器端：团队面板四页、对话卡片、角色构建工作台
│  ├─ pages/      看板 / 团队 / 角色 / 任务
│  └─ store/      dva 单例 store（activity / ui / roster / build）
├─ scripts/       构建与校验脚本
└─ tests/         vitest 单测
```

**数据模型一句话**：`roles` 是全局角色库（岗位卡），`team_members` 是团队班底（工牌），`task_members` 是任务执行实例 —— **真相在角色，班底存副本，工牌跟人走、花名册跟任务走。**

**存储**：单库 SQLite（`<stateDir>/db/eteams.db`），WAL 单写多读；每个主任务在 `<workspace>/teams/<主任务号>-slug/` 下有一份工作目录（`留言板.md`、`<任务号>-slug.纪要.md`、`计划/`、`文档/`）。

## 开发

```bash
pnpm install
pnpm build       # clean → tsc 双端 → tailwind → tsdown 双包 → 客户端信封 → 冒烟
pnpm typecheck
pnpm lint
pnpm test
pnpm verify      # 校验 lib/ 产物与清单 + 全量测试
```

发布前 `prepublishOnly` 会串起 build → typecheck → lint → test 全链。

更详细的命令总览、工具面清单、项目结构与存储设计见 **[开发文档](docs/development.md)**。

## 常见问题

**改了源码没生效？**
插件运行的是 `lib/` 构建产物。改完源码跑一次 `pnpm build`，再重启宿主（客户端重载）才会加载新代码。

**面板一直转圈 / 连不上？**
多为宿主未重启或客户端未重载。先 `dsh --profile desktop --dump-config` 确认插件已装配，再彻底退出应用重新打开。

**数据存在哪？会上传吗？**
全部存在本机 `<stateDir>/db/eteams.db`，不联网、不上传。

## 许可

[MIT](LICENSE)

<!--
============================================================
  截图清单（发布前替换完成后，删除本节）
============================================================
  把图片放进 docs/images/，文件名与 README 中的引用保持一致即可自动生效。
  建议尺寸：1600×900（或 2x 后的 3200×1800），统一窗口宽度、统一主题（浅色或暗色择一）。

  | # | 文件                            | 内容                                       |
  |---|---------------------------------|--------------------------------------------|
  | ① | panel-board.png                 | 面板 · 看板：团队目标、成员、实时动态      |
  | ② | panel-team.png                  | 面板 · 团队：成员栅格、领队与模型路线      |
  | ③ | panel-tasks.png                 | 面板 · 任务：主/小任务与执行链站点         |
  | ④ | panel-roster.png                | 面板 · 角色：角色库与一句话简介            |
  | ⑤ | conversation-team-tab.png       | 会话内：团队页签、团队按钮与任务卡片       |
  | — | logo.png（可选）                | 项目 Logo，取消文件开头注释即可启用        |

  发布前还可选：补一张 GIF 演示「交目标 → 领队拆解 → 自动派发」的完整闭环。
-->
