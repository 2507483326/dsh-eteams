/**
 * Avatar option model + seeded generator — a faithful React-side port of
 * vue-color-avatar's types/enums, SETTINGS and getRandomAvatarOption
 * (MIT, Copyright (c) 2021 LeoKu; see assets/avatar/UPSTREAM.json and
 * NOTICE.md). docs/14 D8: port the data + composition logic, not the Vue
 * runtime.
 *
 * The member's stored (seed, salt) pair (docs/14 M6) drives mulberry32 the
 * same way the old renderer did, so the pair stays the only persisted thing:
 * same (seed, salt) → same option → same face on every surface, and any new
 * member without an avatar pair keeps falling back to the name-hued initial.
 *
 * @module dsh-eteams/client/avatarOption
 */

/** Widget categories, painted back-to-front per AVATAR_LAYER. */
export type AvatarWidgetType =
  | 'face'
  | 'ear'
  | 'earrings'
  | 'eyebrows'
  | 'eyes'
  | 'nose'
  | 'glasses'
  | 'mouth'
  | 'beard'
  | 'tops'
  | 'clothes';

export type AvatarWrapperShape = 'circle' | 'square' | 'squircle';

export interface AvatarBackground {
  /** Solid color or CSS gradient (upstream supports both). */
  color: string;
  borderColor: string;
}

/** One widget pick: which shape, what fill, optional z-order override. */
export interface AvatarWidgetOption {
  shape: string;
  fillColor?: string;
  zIndex?: number;
}

export interface AvatarOption {
  wrapperShape: AvatarWrapperShape;
  background: AvatarBackground;
  widgets: Record<AvatarWidgetType, AvatarWidgetOption>;
}

/** 'none' means "no widget for this category" (upstream NONE). */
export const AVATAR_NONE = 'none';

/** Paint order lifted verbatim from upstream utils/constant.ts AVATAR_LAYER. */
export const AVATAR_LAYER: Readonly<Record<AvatarWidgetType, number>> = {
  face: 10,
  ear: 102,
  earrings: 103,
  eyebrows: 70,
  eyes: 50,
  nose: 60,
  glasses: 90,
  mouth: 100,
  beard: 105,
  tops: 80,
  clothes: 110,
};

/** Upstream SETTINGS.commonColors. */
export const AVATAR_COMMON_COLORS = [
  '#6BD9E9',
  '#FC909F',
  '#F4D150',
  '#E0DDFF',
  '#D2EFF3',
  '#FFEDEF',
  '#FFEBA4',
  '#506AF4',
  '#F48150',
  '#48A99A',
  '#C09FFF',
  '#FD6F5D',
] as const;

/** Upstream SETTINGS.skinColors. */
export const AVATAR_SKIN_COLORS = ['#F8D9CE', '#F9C9B6', '#DEB3A3', '#C89583', '#9C6458'] as const;

/** Upstream SETTINGS.backgroundColor (getter → frozen array here). */
export const AVATAR_BACKGROUND_COLORS: readonly string[] = [
  ...AVATAR_COMMON_COLORS,
  'linear-gradient(45deg, #E3648C, #D97567)',
  'linear-gradient(62deg, #8EC5FC, #E0C3FC)',
  'linear-gradient(90deg, #ffecd2, #fcb69f)',
  'linear-gradient(120deg, #a1c4fd, #c2e9fb)',
  'linear-gradient(-135deg, #fccb90, #d57eeb)',
  'transparent',
];

/** Upstream SETTINGS.borderColor. */
export const AVATAR_BORDER_COLORS: readonly string[] = [...AVATAR_COMMON_COLORS, 'transparent'];

const TOPS_SHAPES = [
  'fonze',
  'funny',
  'clean',
  'punk',
  'danny',
  'wave',
  'turban',
  'pixie',
  'beanie',
] as const;

const EAR_SHAPES = ['attached', 'detached'] as const;
const EARRINGS_SHAPES = ['hoop', 'stud'] as const;
const EYEBROWS_SHAPES = ['up', 'down', 'eyelashesup', 'eyelashesdown'] as const;
const EYES_SHAPES = ['ellipse', 'smiling', 'eyeshadow', 'round'] as const;
const NOSE_SHAPES = ['curve', 'round', 'pointed'] as const;
const GLASSES_SHAPES = ['round', 'square'] as const;
const MOUTH_SHAPES = [
  'frown',
  'laughing',
  'nervous',
  'pucker',
  'sad',
  'smile',
  'smirk',
  'surprised',
] as const;
const CLOTHES_SHAPES = ['crew', 'collared', 'open'] as const;
const WRAPPER_SHAPES = ['circle', 'square', 'squircle'] as const;

/** mulberry32 PRNG — tiny, deterministic, good enough for avatar traits. */
export function mulberry32(a: number): () => number {
  let s = a | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random pick with upstream's `avoid` / `usually` weighting semantics. */
function pick<T>(
  rng: () => number,
  arr: readonly T[],
  { avoid = [], usually = [] }: { avoid?: unknown[]; usually?: (T | 'none')[] } = {},
): T {
  const avoidValues = avoid.filter((it) => it !== undefined && it !== null && it !== false);
  const filtered = arr.filter((it) => !avoidValues.includes(it));

  // usually entries are duplicated 15× upstream so they dominate the pool.
  const weighted: T[] = [];
  for (const it of usually) {
    if (it === undefined || it === null || it === false) continue;
    const value = it === 'none' ? ('none' as unknown as T) : it;
    for (let i = 0; i < 15; i++) weighted.push(value);
  }

  const finalArr = [...filtered, ...weighted];
  const index = Math.floor(rng() * finalArr.length);
  return finalArr[index] ?? filtered[0] ?? arr[0]!;
}

function pickFillColor(rng: () => number): string {
  const colors = AVATAR_COMMON_COLORS;
  return colors[Math.floor(rng() * colors.length)]!;
}

/**
 * Derive the deterministic avatar option for one (seed, salt) pair. Port of
 * upstream getRandomAvatarOption: gender-driven beard/hair pools, weighted
 * none-probability for earrings/glasses/beard, and the punk/fonze special
 * case that keeps the background off the hair color.
 */
export function generateAvatarOption(seed: number, salt: number): AvatarOption {
  const rng = mulberry32((seed ^ Math.imul(salt + 1, 2654435761)) >>> 0);

  // Upstream draws gender first; male widens the hair pool and may add a
  // scruff beard. Only the drawn outcomes matter here, so fold gender into
  // the same rng stream: even → female pool, odd → male pool.
  const male = rng() < 0.5;

  const beardPool: string[] = male ? ['scruff'] : [];
  let topsPool: readonly string[] = ['danny', 'wave', 'pixie'];

  if (male) {
    topsPool = TOPS_SHAPES.filter((shape) => !topsPool.includes(shape));
  }

  const hairShape = pick(rng, topsPool);
  const hairColor = pickFillColor(rng);

  const beardShape =
    beardPool.length > 0 ? pick(rng, beardPool, { usually: [AVATAR_NONE] }) : AVATAR_NONE;
  const earringsShape = pick(rng, EARRINGS_SHAPES, { usually: [AVATAR_NONE] });
  const glassesShape = pick(rng, GLASSES_SHAPES, { usually: [AVATAR_NONE] });

  return {
    wrapperShape: pick(rng, WRAPPER_SHAPES),
    background: {
      color: pick(rng, AVATAR_BACKGROUND_COLORS, {
        avoid: [
          // Handle the upstream special case: punk/fonze hair would blend
          // into a same-color background.
          (hairShape === 'punk' || hairShape === 'fonze') && hairColor,
        ],
      }),
      borderColor: pick(rng, AVATAR_BORDER_COLORS, { usually: ['transparent'] }),
    },
    widgets: {
      face: {
        shape: 'base',
        fillColor: AVATAR_SKIN_COLORS[Math.floor(rng() * AVATAR_SKIN_COLORS.length)]!,
      },
      tops: { shape: hairShape, fillColor: hairColor },
      ear: { shape: pick(rng, EAR_SHAPES) },
      earrings: { shape: earringsShape },
      eyebrows: { shape: pick(rng, EYEBROWS_SHAPES) },
      eyes: { shape: pick(rng, EYES_SHAPES) },
      nose: { shape: pick(rng, NOSE_SHAPES) },
      glasses: { shape: glassesShape },
      mouth: { shape: pick(rng, MOUTH_SHAPES) },
      beard:
        beardShape === AVATAR_NONE
          ? { shape: AVATAR_NONE }
          : // HACK (upstream): scruff must tuck under the mouth.
            { shape: beardShape, zIndex: AVATAR_LAYER.mouth - 1 },
      clothes: { shape: pick(rng, CLOTHES_SHAPES), fillColor: pickFillColor(rng) },
    },
  };
}
