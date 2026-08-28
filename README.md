# dsh-eteams

ETeams for DeepSeek Harness — 领队（captain）把目标拆解为任务、成员（members）
执行的多智能体团队插件，含会话内「团队」面板与执行槽 UI。

- 设计文档：[`docs/README.md`](docs/README.md)（决策表 D1–D15、里程碑计划 M0–M8）
- 当前里程碑：**M0 工程脚手架**（插件骨架 + `eteams_ping` 冒烟工具 + 团队 tab/按钮）

## 构建

```bash
pnpm install
pnpm build       # clean → tsc 声明 → tsdown 双包 → wrap-client 信封
pnpm typecheck
pnpm test
pnpm verify      # 校验 lib/ 产物、cordis.patch.yml、package.json 清单
```

## 安装到 DSH profile

```bash
dsh plugin --profile desktop add C:\eTeam
dsh --profile desktop --dump-config   # 应看到 id 为 eteams 的插件行
```

安装后：

- 对话区头部出现「团队」tab（位于 对话 / 轨迹 旁）；
- 输入区工具行右侧出现「团队」按钮，弹层 v1 含「＋ 新增团队」，点击跳转团队 tab；
- 会话内可调用 `eteams_ping` 冒烟工具验证宿主端连通性。

## 结构

| 路径 | 说明 |
| --- | --- |
| `cordis.patch.yml` | bundle patch：挂载插件行与默认配置（stateDir/workRoot/maxMembers/maxRetries/memberProvider） |
| `src/host/` | 宿主端插件（配置 schema、`eteams_ping`；M1+ 起为团队生命周期工具与运行时） |
| `src/client/` | 浏览器端插件（`conversation.view` 团队 tab、`conversation.input.right` 团队按钮、tab 激活桥接） |
| `scripts/` | clean / wrap-client（ModuleLoader 信封）/ verify-m0 |
| `docs/` | 18 篇设计文档（中文） |

## 文件与命名规范

参考《[迈向前端 Leader - 制定前端规范](https://juejin.cn/post/7490458997540372495)》：

**文件/目录名** —— 一律小写 kebab-case，全仓库唯一允许的大写是 npm 生态惯例的 `README.md`：

- 组件文件与模块文件统一 kebab-case（`eteams-view.tsx`、`teams-button.tsx`、`bridge.ts`、`version-label.ts`）
- 脚本与配置沿用各自生态的既有惯例（`package.json`、`tsconfig.*.json`、`tsdown.config.ts`、`cordis.patch.yml`）

**代码标识符**（与文章规则一一对应）：

- 变量、函数：小驼峰 camelCase（`resolveConfig`、`callerLabel`）
- 类、类型、接口、React 组件名：大驼峰 PascalCase（`ETeamsView`、`TeamsButton`、`ETeamsResolvedConfig`）
- 模块级字面量常量：UPPER_SNAKE_CASE（`PLUGIN_VERSION`、`ETEAMS_VIEW_ID`），需变更的字面量一律先声明为常量再使用

## 许可

MIT
