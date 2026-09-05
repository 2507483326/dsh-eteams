# 42 编辑模式代码块塌陷与语言下拉错位（CodeMirror 双实例去重）

> 用户报告（2026-09-05）：「编辑模式下，代码块中的下拉选择语言有点错位」。
> 定位结论：不是定位 bug——是构建产物里 @codemirror/state 等包被双实例化，
> CodeMirror 从未挂载，代码块塌成 ~28px 空条，语言 chip/弹层悬在塌陷块上，
> 观感即「错位」。修复在构建链（tsdown alias 去重），不动任何编辑器代码。

## 42.1 症状与误判排除

编辑模式（成员手册 MdEditor）代码块右上的语言下拉观感错位。排查中逐项
排除并实测（真实构建产物 + 宿主链同构复现环境）：

- chip 弹层几何本身没有问题：Radix Select（`position: popper`、默认
  `align: "start"`），触发器与弹层同为 `--spacing-36`（144px），实测
  dxLeft/dxRight = 0、dyTop ≈ 0；transform/contain 等 containing-block
  由 floating-ui 自动补偿；宿主渲染器 CSS（app.asar 全量抽取）无
  zoom/contain/常驻 transform；运行时 JS 无 zoomFactor/inline zoom。
- 真正的异常在代码块本体：CodeMirror 内容区高度 0，wrapper 只有
  27.6px（正常 ~272px）。

## 42.2 根因链

1. node_modules 混装两套实体：pnpm 商店（`node_modules/.pnpm/…`）与
   npm 安装留下的顶层真实目录（`node_modules/@codemirror/…`，本包源码
   直接 import 的 `@codemirror/lang-*` 不在 package.json 声明里，只能落
   在这批顶层副本上）。
2. rolldown 按解析路径计模块：`@mdxeditor/editor`（peer 链 → 商店
   state 6.7.2）与 `@codemirror/lang-*`（顶层 state 6.7.1）各得一份
   `@codemirror/state`。双份的还有 view/language/autocomplete 与
   `@lezer/common`、`@lezer/highlight`（共 7 包 9 区域；另
   @marijn/find-cluster-break、style-mod、w3c-keyname 双份但无跨边界
   类实例）。
3. `mdEditor.tsx` 的 `CODE_BLOCK_LANGUAGES` 在模块顶层创建
   LanguageSupport 实例（顶层副本）；mdxeditor 的 CodeMirrorEditor 把
   它们 push 进扩展集后，`EditorState.create` 内 `instanceof Extension`
   对不上另一份副本的类 → 抛 "Unrecognized extension value in extension
   set (…two copies of @codemirror/state are loaded…)"。
4. 挂载 IIFE 中断，`el.innerHTML` 已清空 → CodeMirror 永不挂载，代码块
   塌成空条；语言 chip/下拉仍渲染，悬在 ~28px 空块上。
5. 顶层副本版本落后于 pnpm 商店（state 6.7.1 vs 6.7.2、view 6.43.9 vs
   6.43.10），双实例之外还是陈旧代码。

## 42.3 修复

`tsdown.config.ts` 客户端构建新增 `alias: codemirrorDedupeAlias()`：
把 `@codemirror/state / view / language / autocomplete` 与
`@lezer/common / highlight` 六个包统一别名到 **@mdxeditor/editor 的
解析链**（`createRequire(resolve('@mdxeditor/editor')).resolve(id)`，
构建期动态求值，落包根让 rolldown 按 conditionNames 自选入口；不硬编码
.pnpm 哈希路径）。被孤儿化的顶层副本随摇树消失。

- 产物验证：`lib/client.js` 中上述包各只剩 1 个 region（且为商店版本
  state 6.7.2 / view 6.43.10）；envelope 体积 5.40 MB → 4.95 MB。
- 门禁：`pnpm build`（含双 tsc typecheck + smokeEnvelope）全绿，
  `eslint tsdown.config.ts` 零告警，`vitest run` 317/317 通过。
- 运行验证（真实产物 `lib/client.js` + 宿主链同构 + fetch 打桩）：
  成员详情 → 编辑，CodeMirror 正常挂载（244px、代码高亮 + 行号），
  语言下拉展开后与 chip 左右边完全对齐（dxLeft = dxRight = 0，
  dyTop = −0.47px），弹层整体落在代码块内（右缘距块缘 37px）。

## 42.4 遗留隐患（记录在案，未动）

- `@codemirror/lang-css/html/javascript/json/python/yaml` 被
  `mdEditor.tsx` 直接 import 但**不在 package.json 声明**——当前由 npm
  顶层副本供给。全新 `pnpm install` 会缺模块、构建即断。后续要么补进
  devDependencies，要么等 node_modules 重建时现形；本次不动依赖清单。
- .npmrc 沙箱里 npm 与 pnpm 混装是双实例滋生的土壤（package-lock.json
  与 pnpm-lock.yaml 并存，npm 侧 2026-09-03 还有活动）。alias 修复对
  布局免疫；若要根治可重建 node_modules（仅 pnpm 一套），非本次范围。