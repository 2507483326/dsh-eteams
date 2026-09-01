/**
 * lucide-react 深层图标导入的类型垫片（docs/21-client-ui-stack.md D19d / S13）。
 *
 * 背景：lucide-react@1.38 的主入口（dist/esm/lucide-react.mjs）含
 * `import * as index from './icons/index.mjs'; export { index as icons }`
 * ——命名空间再导出使 rolldown 无法 tree-shake 掉未用图标，一个 X 图标会
 * 把全量 ~1500 个图标（≈850KB）拖进单文件 envelope。改为按图标模块深层
 * 导入（`lucide-react/dist/esm/icons/x`）只进 X 一个图标，符合 21.3
 * 「仅 X 图标 tree-shake 后增量极小」的选型口径。
 *
 * 类型面：上游只随包整包 .d.ts（dist/lucide-react.d.ts），深层路径没有
 * 逐图标声明（dist/esm/icons/x.d.mts 不存在）——这里对用到的图标做最小
 * 环境声明（LucideProps 沿用主入口的导出，仅类型导入、零打包体积）。
 * 导入说明符必须带 .mjs 扩展名（上游无 exports 字段，打包器不会为无扩展
 * 名 id 试 .mjs）。升级 lucide-react 时如深层路径变化，同步改这里与
 * dialog.tsx 的导入。
 *
 * @module dsh-eteams/client/components/ui/lucide-icon
 */
declare module 'lucide-react/dist/esm/icons/x.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const X: ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;
  export default X;
}
