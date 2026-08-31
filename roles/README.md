# eTeam 角色库

> 来源：`C:\Users\epat\Downloads\agency-agents-zh-main`（agency-agents 中文角色库）
> 导入日期：2026-09（由领队会话批量导入）　成员库总量：**192 名成员**

本文件夹是 eTeam 成员库的**文件形态镜像**：既存放了从 agency-agents-zh 导入的全部角色，也存放了 eTeam 原有成员的导出件，并按「角色分类 + 常用分类」两级目录组织。

## 目录结构

```
roles/
├── 常用/                    ← 新增常用分类（20 个角色）
├── 00-角色目录-CATALOG.md    ← 全部角色的中文名↔路径速查表（含 Ctrl+F 用法）
├── README.md                ← 本文件
├── academic/                学术部（6）
├── design/                  设计部（8）
├── engineering/             工程部（30）
├── finance/                 金融部（3）
├── game-development/        游戏开发部（20，含 blender/godot/roblox-studio/unity/unreal-engine 子目录）
├── hr/                      人力资源部（2）
├── legal/                   法务部（2）
├── marketing/               营销部（34）
├── paid-media/              付费媒体部（7）
├── product/                 产品部（5）
├── project-management/      项目管理部（6）
├── sales/                   销售部（8）
├── spatial-computing/       空间计算部（6）
├── specialized/             专项部（34）
├── supply-chain/            供应链部（3）
├── support/                 支持部（8）
└── testing/                 测试部（9）
```

每个角色是一个 Markdown 单文件（YAML frontmatter：name/description/emoji/color + 正文手册），可直接复制改造，或按名字加入团队。

## 常用分类（roles/常用/）

高频角色的快捷入口，共 20 个：

- **eTeam 原有 6 名成员的导出件**：前端开发者、后端架构师、UI 设计师、趣味注入师、项目牧羊人、角色构建师（注意：成员库中的版本为定制人设，比导出件更完整）
- **14 个高频导入角色**：代码审查员、软件架构师、高级开发者、数据工程师、DevOps 自动化师、安全工程师、Git 工作流大师、快速原型师、技术文档工程师、高级项目经理、产品经理、提示词工程师、UX 架构师、API 测试员

## 成员库导入说明

- 已导入 **186** 个新角色到 eTeam 成员库（6 名原有成员保留不动，库内合计 192）。
- 成员库中每个导入成员的 `role` 字段即其**部门分类**（如「工程部」「营销部」），`duty/style/skills/rules` 为从手册提炼的摘要，`personaMd` 为完整角色手册。
- 加入团队时用 `eteams_add_member` 按中文名点名即可。

### 导入特例

| 情况 | 处理 |
|------|------|
| 「招聘专家」重名（hr 与 specialized 各一个） | hr 版保留原名，specialized 版改名 **招聘专家·专项** |
| 「项目牧羊人」为 eTeam 领队保留名 | 手册文件保留在 `project-management/`，未作为独立成员入库（领队即其定制版） |
| 前端开发者、UI 设计师、趣味注入师、后端架构师 | 成员库中已有更完整的定制人设，未覆盖；仓库原版仍在本目录对应分类下 |

## 维护

- 新增角色：按 `分类/文件名.md` 放入对应目录并更新 CATALOG；如需入库，走 `eTeam --add-people` 由角色构建师构建。
- 临时导入工件（批次清单/元数据/合并脚本）在 `C:\eTeam\roles-manifest\`，可整体删除，不影响成员库与本目录。
