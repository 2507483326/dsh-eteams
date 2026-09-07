/**
 * 随机头像钮与掷骰工具（docs/44 M7-2，46 清单收口）：三处「随机头像」
 * ghost 小钮（构建台、角色添加页、角色详情页）原是逐字重复，连同掷骰
 * 种子对 rollAvatarPair 收口到这里；随机钮元数据（标题/文案/小号类）借
 * lib/status 的 RANDOM_AVATAR_BTN_META 原值。原同文件的 AvatarRing 描边
 * 环已撤（用户迭代 2026-09-07：头像描边统一为 Avatar 默认 1px 深灰框、
 * 白底、无间隔——环壳与白缝废止），四处调用位改直用 features/avatar
 * 的 Avatar。
 *
 * @module dsh-eteams/client/avatarRing
 */
import type { ReactNode } from 'react';
import Dices from 'lucide-react/dist/esm/icons/dices.mjs';
import { Button } from './ui/button';

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
