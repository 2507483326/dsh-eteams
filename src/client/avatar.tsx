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
 * 迁 Tailwind——静态面（圆角/裁切/居中/字重/前景白）走工具类（全部 Avatar
 * 消费方都在 `.eteams-ui` 表面内，后代选择器可命中）；随 props 运行时变化的
 * 尺寸/底色/字号保留 inline（S14 清点口径：动态值）。
 *
 * @module dsh-eteams/client/avatar
 */
import { useId, type CSSProperties, type ReactNode } from 'react';

import { generateAvatarOption } from './avatarOption';
import { composeAvatarSvg } from './avatarSvg';

/** Stable hue from a name (initial-letter fallback). */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 静态容器面（S14）：工具类；尺寸/底色/字号随 props 动态（见 AVATAR_STYLE）。 */
const AVATAR_CONTAINER_CLASS =
  'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white';

/**
 * The member avatar: seeded vue-color-avatar face when (seed, salt) are
 * supplied, else a stable initial-letter circle. Same pair always renders
 * the same face.
 */
export function Avatar({
  name,
  seed,
  salt,
  size = 34,
}: {
  name: string;
  seed?: number;
  salt?: number;
  size?: number;
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
      <span className={AVATAR_CONTAINER_CLASS} style={style}>
        {name.slice(0, 1)}
      </span>
    );
  }
  return <SeedAvatar name={name} seed={seed} salt={salt} size={size} style={style} />;
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
}: {
  name: string;
  seed: number;
  salt: number;
  size: number;
  style: CSSProperties;
}): ReactNode {
  const reactId = useId().replaceAll(':', '');
  const option = generateAvatarOption(seed, salt);
  // The composed string is a complete <svg> document sized to `size`, so it
  // can sit directly inside the container span (upstream uses v-html too).
  return (
    <span
      className={AVATAR_CONTAINER_CLASS}
      style={{ ...style, background: option.background.color }}
      data-eteams="avatar"
      title={name}
      dangerouslySetInnerHTML={{
        __html: composeAvatarSvg({ option, size, idNamespace: reactId }),
      }}
    />
  );
}
