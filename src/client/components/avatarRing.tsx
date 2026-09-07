/**
 * 头像描边环与随机头像钮（docs/44 M7-2，46 清单）：四处「双线描边圆环头像」
 * （构建台 40、角色添加页 40、角色详情页 52、成员详情页 52）与三处
 * 「随机头像」ghost 小钮（构建台、角色添加页、角色详情页）原是逐字重复，
 * 连同掷骰种子对 rollAvatarPair 一起收口到这里。环壳现为白底 + business
 * 实色描边双线（border-2 + p-0.5，用户迭代 2026-09-07）、随机钮元数据
 * （标题/文案/小号类）借 lib/status 的 RANDOM_AVATAR_BTN_META 原值。
 *
 * @module dsh-eteams/client/avatarRing
 */
import type { ReactNode } from 'react';
import Dices from 'lucide-react/dist/esm/icons/dices.mjs';
import { Avatar, AVATAR_SHELL_CLASS } from '../features/avatar/avatar';
import { Button } from './ui/button';

/** 描边环壳：白底 + 品牌实色双线圆环（用户迭代 2026-09-07：白底、描边
 * 加重）——壳面收口 features/avatar 的 AVATAR_SHELL_CLASS（任务区头像、
 * 团队卡叠放同款），此处只补内容行高归零。 */
const RING_CLASS = `${AVATAR_SHELL_CLASS} leading-none`;

/**
 * 随机头像钮元数据（M2 查表原表逐字随迁，lib/status 原注记指明 M7 落位
 * 在此）：三个渲染位（构建台 / 角色添加页 / 角色详情页头）同文同款——
 * 类名/title/label 一张表。
 */
const RANDOM_AVATAR_BTN_META = {
  className: 'h-6 gap-1 px-1.5 text-xs text-muted-foreground',
  title: '随机换一个头像',
  label: '随机头像',
} as const;

/** ================================== 类型 ================================== */

/** 掷骰结果：种子 + 盐，喂 Avatar 的确定性头像算法（原 buildWorkbench
 * 逐字迁入）。 */
export interface AvatarPair {
  seed: number;
  salt: number;
}

/** ================================== 工具函数 ================================== */

/** 掷一对随机头像参数：种子 0..996、盐 0..999（原 buildWorkbench
 * rollAvatarPair 逐字迁入，消费位：构建台 / 角色添加页 / 角色详情页）。 */
export function rollAvatarPair(): AvatarPair {
  return {
    seed: Math.floor(Math.random() * 997),
    salt: Math.floor(Math.random() * 1000),
  };
}

/** ================================== 主组件 ================================== */

/**
 * 描边环头像：size 透传（40/52 两档由调用方定），seed/salt 可选——手动
 * 未掷/回落原头像时原位就传 undefined（Avatar 自取名姓首字哈希）。
 */
export function AvatarRing({
  name,
  seed,
  salt,
  size,
}: {
  name: string;
  seed?: number;
  salt?: number;
  size: number;
}): ReactNode {
  return (
    <div className={RING_CLASS}>
      <Avatar name={name} seed={seed} salt={salt} size={size} />
    </div>
  );
}

/**
 * 随机头像钮：ghost sm 小号（RANDOM_AVATAR_BTN_META 类名/title/label
 * 原值），骰子图标 h-3.5 w-3.5；onRoll 由调用方自掷（setXxx(rollAvatarPair())
 * 或独立 state 翻转），组件不管 state 形状。
 */
export function RandomAvatarButton({ onRoll }: { onRoll: () => void }): ReactNode {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={RANDOM_AVATAR_BTN_META.className}
      title={RANDOM_AVATAR_BTN_META.title}
      onClick={onRoll}
    >
      <Dices className="h-3.5 w-3.5" />
      {RANDOM_AVATAR_BTN_META.label}
    </Button>
  );
}
