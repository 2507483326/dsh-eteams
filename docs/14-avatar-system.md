# 14 头像系统（vue-color-avatar 移植）

D8 决策：**移植为 React 渲染器**--提取 vue-color-avatar（MIT，[Codennnn/vue-color-avatar](https://github.com/Codennnn/vue-color-avatar)）的形状/配色数据与随机组合算法，用 React SVG 渲染同款风格头像；不引入 Vue 运行时。

## 14.1 目标与约束

- 视觉与 vue-color-avatar 一致（同数据、同组合逻辑）。
- **确定性**：`seed = hash(memberId + ':' + salt)` 固定 -> 同一头像任何端可复现（面板/卡片/消息流）。
- **可重摇**：换 salt 即换头像（成员档案落盘新 option）。
- **可简化编辑**：逐类别挑选形状与配色（不做完整换装编辑器）。
- **离线**：无网络、无外部服务。
- **合规**：MIT 保留版权与许可声明；NOTICE 注明衍生关系与上游仓库。

## 14.2 数据提取（vendored 资产）

```
scripts/avatar/extract.mjs     # 提取脚本（锁定上游 commit）
assets/avatar/widgets.json     # 形状库：类别 -> [{id, svg(path/形状定义), 复杂度标记}]
assets/avatar/palettes.json    # 配色方案
src/shared/avatar/option.ts    # AvatarOption 类型 + 随机组合算法（同构共享）
```

提取流程：

1. clone 上游到临时目录，checkout 锁定 commit（记录于 `assets/avatar/UPSTREAM.json`：仓库地址、commit、提取时间、源文件清单）。
2. 从上游源码解析形状定义与配色（上游以组件/SVG 数据形式组织；提取脚本输出**纯 JSON**：每类别形状的 SVG 片段（path/变换/填充规则）+ 类别元数据（哪些类别必选、互斥规则、simple 模式过滤集））。
3. 产物带校验和（sha256 于 UPSTREAM.json），构建时校验。
4. `pnpm avatar:extract` 手动执行；产物入库（vendored），版本升级显式重跑。

> 不 npm 依赖上游：上游是应用而非库，无稳定包形态；vendored 快照同时解决离线与稳定性（[03](03-tech-stack.md) 3.7 风险项）。

## 14.3 AvatarOption 模型

```ts
interface AvatarOption {
  schemaVersion: 1;
  background: { color: string; shape: 'circle' | 'square' | 'squircle' };
  widgets: Record<string /*category*/, string /*shape id*/>;
  colors: Record<string /*category*/, string /*fill*/>;
}

// 类别（以上游实际提取为准，此处为规划口径）：
// 脸型 / 发型或帽饰 / 眉 / 眼 / 鼻 / 口 / 耳 / 饰品(眼镜等) / 服装 …
```

- option 是**唯一持久物**（存 MemberRecord.avatar.option，[05](05-data-model.md) 5.8）；不存渲染结果。
- 未知类别/形状 id（升级后数据变动）-> 渲染器跳过并保留其余（前向兼容）。

## 14.4 生成算法（种子化）

```
seed    = fnv1a(`${childId}:${salt}`)          // 32bit 稳定哈希
rand    = mulberry32(seed)                      // 确定性 PRNG
option  = randomOption(rand, widgets, palettes, {
            simple: true   // 过滤复杂形状（上游 simple 模式），保证小尺寸可辨识
          })
```

- `randomOption`：逐类别按权重抽取形状（必选类别必须抽到）、抽配色；逻辑移植上游随机生成器（保持同分布）。
- **同构**：`src/shared/avatar/` 同时被宿主（Node，成员创建时生成/落盘）与客户端（重摇预览）引用，一份实现两处编译（tsdown 双入口导出）。

## 14.5 React 渲染器

```
<Avatar option={opt} size={40} ring? bordered? />
```

- 纯函数组件：option -> 分层 SVG（背景形 -> 各类别形状按上游叠放顺序）；无副作用、可 memo。
- 尺寸梯度：24（任务行/消息流）/ 40（成员卡）/ 64（大图预览）；SVG viewBox 缩放，无需多份位图。
- `ring`：状态环（working 蓝/ready 绿/paused 黄/removed 灰），与状态点语义一致（色+形双编码）。
- 渲染性能：单头像 <1ms；形状 path 预解析为常量表。

## 14.6 重摇与编辑

- **重摇**：成员卡「重摇」按钮 -> 本地预览（salt+1）->「保留」落盘（12 路由 avatar/reroll）/「再摇」；领队头像同理（团队创建时生成，卡内可换）。
- **简化编辑器**（AvatarEditor 弹层）：
  - 每类别一行：左右切换形状（含「无」若类别可选）；
  - 配色：全局调色板切换 + 单类别覆盖；
  - 底部：随机（=重摇）/ 重置 / 保存。
- 编辑产物是新的 option（保存走 12 路由 avatar）。

## 14.7 许可与署名

- `NOTICE.md` 声明：头像形状与配色数据衍生自 Codennnn/vue-color-avatar（MIT），含上游版权行与仓库链接；`assets/avatar/UPSTREAM.json` 保存溯源元数据。
- NOTICE 随包分发（package.json files 列表包含）。

## 14.8 验证

1. 单测：种子确定性（同 seed 同 option 同 SVG 字符串）、类别覆盖（必选类别无缺）、前向兼容（注入未知 id 不崩）。
2. 快照测试：抽取 10 个种子渲染 SVG 字符串比对（防渲染器回归）。
3. 体积审计：`assets/avatar/*.json` gz <80KB 预算（超限则压缩策略：形状 path 去重/简化坐标精度）。


## 14.8 M6 首切片（2026-08-28 提前交付）

- **种子化 SVG 渲染器已上线**（`src/client/features/avatar/avatar.tsx`）：(seed, salt) 经 mulberry32 确定性推导 背景/肤色/发型×5/眼型×3/嘴型×3/眼镜/腮红，64×64 viewBox，无外部资产；无头像对时回退首字母色环。
- **头像提前生成**（用户需求）：成员库 upsert 时若未携带 avatar 即自动生成并落盘（`roster.json`），更新条目保留既有头像；团队采纳成员（fromRoster）继承成员库头像，非采纳路径按名字哈希 + 随机 salt 生成（`eteams_add_member`）。
- **展示面**：成员 tab（团队成员卡片 + 成员库行）、团队 tab、快照 `members[].avatar` 投影。
- M6 剩余：vue-color-avatar 完整形状数据移植、重摇/编辑器、种子化数据资产压缩。

## 14.9 完整形状库移植（2026-09-02，落地记录）

用户验收点：「还原出一模一样的样子」。本节记录实际落地（与 14.2 规划口径的差异见末尾）。

**资产与生成**

- `assets/avatar/widgets/**`：上游 `src/assets/widgets/` 全量 39 个形状 SVG **逐字 vendored**（face=1 ear=2 earrings=2 eyebrows=4 eyes=4 nose=3 glasses=2 mouth=8 beard=1 tops=9 clothes=3）；溯源在 `assets/avatar/UPSTREAM.json`（本地快照无 commit，版本 1.0.0），署名在 `NOTICE.md`（随包分发）。
- `scripts/genAvatarWidgets.mjs`：读取 vendored SVG → 生成 `src/client/features/avatar/avatarWidgets.ts` 字符串表（JSON.stringify 内联，带 sha256 指纹 `AVATAR_WIDGETS_FINGERPRINT`）。换资产重跑脚本即可，客户端零 loader 插件。

**模型与生成算法**（`src/client/features/avatar/avatarOption.ts`）

- 上游 `getRandomAvatarOption` 忠实移植：mulberry32 种子流、`usually` 条目 ×15 权重、`avoid` 过滤、性别池（女发 danny/wave/pixie，男发其余 6 种 + scruff 胡须 15:1 权重）、punk/fonze 发色规避同色背景、scruff `zIndex = mouth - 1`（压嘴下）。
- **契约不变**：`(seed, salt)` → `(seed ^ imul(salt+1, 2654435761))` 种子，成员库已落盘的 pair 全部沿用，无迁移。

**合成器**（`src/client/features/avatar/avatarSvg.ts`，移植 `VueColorAvatar.vue` watchEffect）

- 按 `AVATAR_LAYER` z 序排序、剥 `<svg>` 壳拼 `<g>` 层、`$fillColor` 替换、ear 继承肤色、`translate(100, 65)`，全部逐字对齐上游。
- **画板固定 400×400**：上游 viewBox 公式 `size/0.7` 以默认 size=280 校准（280/0.7=400），部件画稿按 400 板绘制；上游传其他尺寸会裁板。移植改为板恒 400、视口随 `size` 缩放——任意尺寸都呈现上游 280px 的完整观感（34px 名字行 → 72px 预览同一张脸）。
- **id 命名空间**（有意分歧）：上游单页单头像，`mask0`/`clip0` 裸 id 不冲突；本面板一页几十个头像，`namespaceIds()` 以 `eteams-av-{useId}-` 前缀改写全部 `id="…"`/`url(#…)`/`href="#…"`，浏览器实测 48 头像同页 0 重复 id、0 串色。
- 未知形状 id → 跳过该层（前向兼容，14.3 口径）。

**组件**（`src/client/features/avatar/avatar.tsx`）

- `Avatar({name, seed, salt, size})` API 与 12 处调用点不变；合成结果为完整 `<svg>` 文档，经 `dangerouslySetInnerHTML` 直挂容器 span（同上游 v-html）；容器背景 = `option.background.color`（含渐变），圆形裁切沿用 `AVATAR_CONTAINER_CLASS`。无 pair 回退首字母色环不变。

**验证**

- 单测 `tests/avatarPipeline.test.ts` 14 例：确定性、salt 分布、必选件齐全、punk/fonze 撞色、scruff z 序、400 板/translate 契约、层序、`$fillColor` 替换、肤色继承、命名空间隔离与前向兼容、39 形状表完整性。
- 浏览器取证（`node scripts/avatarPreview.mjs` → `.tmp-avatar-preview/`）：48 (seed,salt) 真实管线渲染，getBBox 全员居中不越板，canvas 像素采样（背景/肤色/发型/嘴/衣服落点全对，376 种颜色）。
- `pnpm build`（client 4.28MB smoke OK）、`pnpm verify` 162/162、typecheck、eslint、prettier 全绿。

**与 14.2 规划口径差异**：未走 `widgets.json` 中间格式与 `src/shared/avatar/` 同构层——SVG 原文直接 vendored + 字符串表，渲染纯在客户端；`schemaVersion`/option 持久化结构未变（仍只存 (seed, salt)），后续重摇/编辑器（14.6）沿用本管线。

**剩余**：重摇/简化编辑器（14.6）。
