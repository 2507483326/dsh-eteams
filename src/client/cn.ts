/**
 * shadcn 类名合并工具（docs/21-client-ui-stack.md：clsx + tailwind-merge 标准件）。
 *
 * `cn()` 是后续所有表面迁移（S4 起的 shadcn 组件与 Tailwind 化改写）的类名
 * 入口：clsx 串接条件 / 数组 / 对象并过滤假值，tailwind-merge 再做同组冲突
 * 去重（后写覆盖先写）——调用方传「组件默认类 + 覆盖类」时无需手工排重，
 * 这也是 shadcn 组件合并 className 的标准惯例。
 *
 * 注意 content 扫描纪律（21.5.1）：动态样式必须传完整字面量类名
 * （映射表查表），禁 `tone-${x}` 拼接——拼接类名不在扫描产物里，样式会静默缺失。
 *
 * @module dsh-eteams/client/cn
 */
import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并类名：clsx 过滤假值并展平嵌套，tailwind-merge 去同组冲突（后者胜）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
