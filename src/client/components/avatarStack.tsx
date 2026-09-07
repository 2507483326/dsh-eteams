/**
 * 头像叠放（docs/44 M7-7，46 清单）：两档密度原是两份同款「头像个数截断 +
 * 包裹 span + title 兜底」的叠放——团队卡略缩图（teamPage：小号 20、白
 * 描边 ring、最多 3 个、超出 +N 余量牌）与官网团队卡名册（eteamsCard：26、
 * 负间距 -mr-1.5、最多 8 个、无余量牌）——收口到这里，密度差异全走 props。
 * 观感零变更：容器行（含 .eteams-team-avatars 动效类）留在调用方——本组件
 * 只渲染头像个 span + 余量牌的片段；叠放动效/负间距由容器样式表与包裹类
 * 各自驱动。
 *
 * @module dsh-eteams/client/avatarStack
 */
import type { ReactNode } from 'react';
import { Avatar, AVATAR_SHELL_CLASS } from '../features/avatar/avatar';

/** +N 余量牌（用户迭代 2026-09-07 与带壳头像同款收口）：白底品牌描边壳
 * （AVATAR_SHELL_CLASS）+ 内层 muted 圆面——h-7 w-7 外径 = 20px 脸 + 壳 8，
 * 与 teamPage 叠放（size 20）同高。 */
const OVERFLOW_CLASS = `inline-flex h-7 w-7 shrink-0 ${AVATAR_SHELL_CLASS}`;

/** ================================== 主组件 ================================== */

/**
 * 头像叠放片段：people 原序截断前 max 个；wrapperClass 是密度位（teamPage
 * 白描边 / eteamsCard 负间距）；titleOf 定悬浮兜底文案（默认名姓，eteamsCard
 * 带「 · 领队/状态」尾注）；overflow 开余量牌（+N，title「其余 N 人」）——
 * people 元素须含 name（作 key 与头像种子）与可选 seed/salt（未掷时
 * Avatar 自落名姓哈希，与原位口径同）。
 */
export function AvatarStack<P extends { name: string; seed?: number; salt?: number }>({
  people,
  size,
  max,
  wrapperClass,
  titleOf,
  overflow = false,
}: {
  people: readonly P[];
  size: number;
  max: number;
  wrapperClass: string;
  titleOf?: (person: P) => string;
  overflow?: boolean;
}): ReactNode {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <>
      {shown.map((p) => (
        <span
          key={p.name}
          className={wrapperClass}
          title={titleOf === undefined ? p.name : titleOf(p)}
        >
          <Avatar name={p.name} seed={p.seed} salt={p.salt} size={size} />
        </span>
      ))}
      {overflow && rest > 0 && (
        <span className={OVERFLOW_CLASS} title={`其余 ${rest} 人`}>
          <span className="flex h-full w-full items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
            +{rest}
          </span>
        </span>
      )}
    </>
  );
}
