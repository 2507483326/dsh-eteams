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

// docs/23 S23-2 增补：Select 的三枚图标（check / chevron-down / chevron-up），
// 同款深层导入纪律（一个图标只进一个模块）。
declare module 'lucide-react/dist/esm/icons/check.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const Check: ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;
  export default Check;
}

declare module 'lucide-react/dist/esm/icons/chevron-down.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const ChevronDown: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default ChevronDown;
}

declare module 'lucide-react/dist/esm/icons/chevron-up.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const ChevronUp: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default ChevronUp;
}

// docs/24 S24-2（D22f emoji 清零 + 官网图标化）增补五枚：Search（侧栏筛选框）、
// Plus（「新增」钮前缀）、ArrowLeft（返回钮）、MessageSquare（对话页入口）、
// PenLine（意图访谈语义）。消费方：teamsView（原 eteamsView，已拆分至
// pages/teamsView/）/ teamsPanel / teamsButton / buildCard。同款深层导入纪律（一个图标只进一个模块）。
declare module 'lucide-react/dist/esm/icons/search.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const Search: ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;
  export default Search;
}

declare module 'lucide-react/dist/esm/icons/plus.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const Plus: ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;
  export default Plus;
}

declare module 'lucide-react/dist/esm/icons/arrow-left.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const ArrowLeft: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default ArrowLeft;
}

declare module 'lucide-react/dist/esm/icons/message-square.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const MessageSquare: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default MessageSquare;
}

declare module 'lucide-react/dist/esm/icons/pen-line.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const PenLine: ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;
  export default PenLine;
}

// 用户迭代 2026-09 增补：模型二级菜单的右箭头（root 行钻入指示，对话
// ModelSelect 的 cellChevron 同款）。同款深层导入纪律（一个图标只进一个模块）。
declare module 'lucide-react/dist/esm/icons/chevron-right.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const ChevronRight: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default ChevronRight;
}

// 用户迭代 2026-09 三增补：添加成员行尾加减步进器的 −（Minus；＋ 已有）。
// 同款深层导入纪律（一个图标只进一个模块）。
declare module 'lucide-react/dist/esm/icons/minus.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const Minus: ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;
  export default Minus;
}

// 用户迭代 2026-09-03 增补：角色详情「随机头像」钮（Dices，骰子语义）。
// 同款深层导入纪律（一个图标只进一个模块）。
declare module 'lucide-react/dist/esm/icons/dices.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const Dices: ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;
  export default Dices;
}

// docs/28 增补：看板 Token 消耗卡年份切换的左箭头（与 chevron-right 同款）。
// 同款深层导入纪律（一个图标只进一个模块）。
declare module 'lucide-react/dist/esm/icons/chevron-left.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const ChevronLeft: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default ChevronLeft;
}

// 用户迭代 2026-09-05 增补：主任务详情页小任务卡片的拖拽把手（GripVertical，
// 十轮 DA23——只有把手可拖，卡身点击进详情）。同款深层导入纪律（一个图标
// 只进一个模块）。
declare module 'lucide-react/dist/esm/icons/grip-vertical.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const GripVertical: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default GripVertical;
}

// docs/43 十九轮增补：Pagination 分页省略号的 MoreHorizontal。同款深层导入
// 纪律（一个图标只进一个模块）。
declare module 'lucide-react/dist/esm/icons/more-horizontal.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const MoreHorizontal: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default MoreHorizontal;
}

// docs/panelTaskCommission 增补：任务卡「创建中」态的旋转 loader（任务列表
// 卡 pill 旁 animate-spin）。同款深层导入纪律（一个图标只进一个模块）。
declare module 'lucide-react/dist/esm/icons/loader-circle.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LucideProps } from 'lucide-react';

  const LoaderCircle: ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
  >;
  export default LoaderCircle;
}
