/**
 * Seeded avatar (docs/14): a deterministic vue-color-avatar face derived
 * from the member's stored (seed, salt) pair — generated up-front at member
 * creation so every surface (成员库 / 团队 / 汇报) renders the same avatar
 * without storing image data. Falls back to the name-hued initial when no
 * avatar pair exists.
 *
 * Pipeline: (seed, salt) → avatarOption.ts (trait picks, ported from
 * upstream getRandomAvatarOption) → avatarSvg.ts (layer composition, ported
 * from VueColorAvatar.vue over the vendored SVG table avatarWidgets.ts).
 * The widget artwork derives from Codennnn/vue-color-avatar (MIT,
 * Copyright (c) 2021 LeoKu) — provenance in assets/avatar/UPSTREAM.json,
 * attribution in NOTICE.md.
 *
 * S14（docs/21-client-ui-stack.md 21.6）：本组件是纯 SVG 渲染器，仅容器样式
 * 迁 Tailwind——静态面（圆角/裁切/居中/字重/前景白/描边）走工具类（全部 Avatar
 * 消费方都在 `.eteams-ui` 表面内，后代选择器可命中）；随 props 运行时变化的
 * 尺寸/底色/字号保留 inline（S14 清点口径：动态值）。
 *
 * @module dsh-eteams/client/avatar
 */
import { useId, type CSSProperties, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { generateAvatarOption } from './avatarOption';
import { composeAvatarSvg } from './avatarSvg';

/** Stable hue from a name (initial-letter fallback). */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 静态容器面（S14）：工具类；尺寸/底色/字号随 props 动态（见 AVATAR_STYLE）。
 * 三十二轮 DA45：加 1px 描边（用户拍板「头像加上边框」全表面统一）；用户
 * 迭代 2026-09-07：描边定深灰（slate-500，原 --border 太浅）+ 白底兜底
 * （bg-white 垫在内联底色之下，调用位名字色相/头像背景色盖其上，无底色
 * 处不透出下层），框贴头像无间隔、尺寸不变；className 仍可覆盖。 */
const AVATAR_CONTAINER_CLASS =
  'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-solid border-slate-500 bg-white font-semibold text-white';

/**
 * 白底品牌描边壳（用户迭代 2026-09-07，仅角色页描边环消费）：包在 Avatar
 * **外层**——Avatar 容器底色是内联样式，壳的白底由自身承载。
 */
export const AVATAR_SHELL_CLASS =
  'rounded-full border-2 border-solid border-business bg-white p-0.5';

/**
 * The member avatar: seeded vue-color-avatar face when (seed, salt) are
 * supplied, else a stable initial-letter circle. Same pair always renders
 * the same face. 二十三轮 DA36：增 optional `className` 透传；三十二轮
 * DA45：容器默认加 1px `--border` 描边（用户拍板「头像加上边框」，全表面
 * 统一——className 仍可覆盖默认）。
 */
export function Avatar({
  name,
  seed,
  salt,
  size = 34,
  className,
}: {
  name: string;
  seed?: number;
  salt?: number;
  size?: number;
  className?: string;
}): ReactNode {
  // 动态值（S14 清点口径）：size 直接定宽高、字号按 0.44 比例、底色按名字
  // 色相——其余容器样式全部走 AVATAR_CONTAINER_CLASS 工具类。
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.44),
    background: `hsl(${hueOf(name)} 55% 45%)`,
  };
  if (seed === undefined || salt === undefined) {
    return (
      <span className={cn(AVATAR_CONTAINER_CLASS, className)} style={style}>
        {name.slice(0, 1)}
      </span>
    );
  }
  return (
    <SeedAvatar
      name={name}
      seed={seed}
      salt={salt}
      size={size}
      style={style}
      className={className}
    />
  );
}

/**
 * Seeded face. useId namespaces the mask/clipPath ids so a page of avatars
 * never cross-resolves references (upstream renders one avatar per page and
 * needs no such isolation).
 */
function SeedAvatar({
  name,
  seed,
  salt,
  size,
  style,
  className,
}: {
  name: string;
  seed: number;
  salt: number;
  size: number;
  style: CSSProperties;
  className?: string;
}): ReactNode {
  const reactId = useId().replaceAll(':', '');
  const option = generateAvatarOption(seed, salt);
  // 背景池含 upstream 原样的 'transparent'（avatarOption AVATAR_BACKGROUND_
  // COLORS 末位）：透明底的脸浮在页面上，团队卡叠放悬停放大会透出下层
  // 头像（用户迭代 2026-09-07「领队没有背景，放大时透出来了」）——渲染
  // 时落白底兜底（容器类的 bg-white 会被这条内联透明盖掉，必须在值上
  // 替换）。不动池子本身：池长度参与 pick 索引，增删会全量重排既有
  // (seed, salt) 的底色。
  const faceBackground =
    option.background.color === 'transparent' ? '#ffffff' : option.background.color;
  // The composed string is a complete <svg> document sized to `size`, so it
  // can sit directly inside the container span (upstream uses v-html too).
  return (
    <span
      className={cn(AVATAR_CONTAINER_CLASS, className)}
      style={{ ...style, background: faceBackground }}
      data-eteams="avatar"
      title={name}
      dangerouslySetInnerHTML={{
        __html: composeAvatarSvg({ option, size, idNamespace: reactId }),
      }}
    />
  );
}
