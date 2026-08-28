/**
 * Seeded avatar (M6 first slice, docs/14): a deterministic SVG face derived
 * from the member's stored (seed, salt) pair — generated up-front at member
 * creation so every surface (成员库 / 团队 / 汇报) renders the same avatar
 * without storing image data. Falls back to the name-hued initial when no
 * avatar pair exists.
 *
 * @module dsh-eteams/client/avatar
 */
import type { CSSProperties, ReactNode } from 'react';

/** Stable hue from a name (initial-letter fallback + hair-color pairing). */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** mulberry32 PRNG — tiny, deterministic, good enough for avatar traits. */
function mulberry32(a: number): () => number {
  let s = a | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BACKGROUNDS = [
  '#ffd5dc',
  '#d3e5ff',
  '#d8f3dc',
  '#fff3c4',
  '#ffe0c7',
  '#e8dcff',
  '#cff4f2',
  '#ffe4f0',
];
const SKINS = ['#ffd7b3', '#f2c19b', '#e0a173', '#c68863', '#8d5a3b', '#6b4226'];
const HAIRS = ['#2f2a28', '#5b3a29', '#8a5a33', '#c9873f', '#e3c07b', '#4a4f5c', '#7c4a8a'];
const SHIRTS = ['#4b7bec', '#2e8b57', '#c04545', '#5b3a29', '#3a6ea5', '#8a5a33'];

/** Deterministic avatar trait bundle for one (seed, salt) pair. */
function traits(seed: number, salt: number) {
  const rng = mulberry32((seed ^ Math.imul(salt + 1, 2654435761)) >>> 0);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  return {
    background: pick(BACKGROUNDS),
    skin: pick(SKINS),
    hair: pick(HAIRS),
    shirt: pick(SHIRTS),
    hairStyle: Math.floor(rng() * 5), // 0 short 1 sweep 2 long 3 bun 4 curly
    eyes: Math.floor(rng() * 3), // 0 dots 1 happy 2 sleepy
    mouth: Math.floor(rng() * 3), // 0 smile 1 open 2 flat
    glasses: rng() < 0.25,
    blush: rng() < 0.4,
  };
}

/**
 * The member avatar: seeded SVG face when (seed, salt) are supplied, else a
 * stable initial-letter circle. Same pair always renders the same face.
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
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    overflow: 'hidden',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: `hsl(${hueOf(name)} 55% 45%)`,
    color: '#fff',
    fontWeight: 600,
    fontSize: Math.round(size * 0.44),
  };
  if (seed === undefined || salt === undefined) {
    return <span style={style}>{name.slice(0, 1)}</span>;
  }
  const t = traits(seed, salt);
  const k = size / 64; // scale helper not needed — viewBox scales, kept for stroke tuning
  void k;
  return (
    <span style={style} data-eteams="avatar">
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden={true}>
        <rect width={64} height={64} fill={t.background} />
        {/* shoulders / shirt */}
        <path d="M10 64 Q10 44 32 44 Q54 44 54 64 Z" fill={t.shirt} />
        {/* head */}
        <circle cx={32} cy={27} r={16} fill={t.skin} />
        {/* hair variants */}
        {t.hairStyle === 0 && (
          <path d="M16 24 Q16 9 32 9 Q48 9 48 24 Q48 17 32 17 Q16 17 16 24 Z" fill={t.hair} />
        )}
        {t.hairStyle === 1 && (
          <path d="M16 26 Q14 8 32 9 Q50 10 48 22 Q40 12 26 18 Q20 21 16 26 Z" fill={t.hair} />
        )}
        {t.hairStyle === 2 && (
          <>
            <path d="M15 25 Q15 8 32 9 Q49 8 49 25 Q49 15 32 15 Q15 15 15 25 Z" fill={t.hair} />
            <path d="M13 26 Q11 44 15 50 L21 50 Q17 40 19 26 Z" fill={t.hair} />
            <path d="M51 26 Q53 44 49 50 L43 50 Q47 40 45 26 Z" fill={t.hair} />
          </>
        )}
        {t.hairStyle === 3 && (
          <>
            <path d="M16 24 Q16 9 32 9 Q48 9 48 24 Q48 17 32 17 Q16 17 16 24 Z" fill={t.hair} />
            <circle cx={32} cy={8} r={6} fill={t.hair} />
          </>
        )}
        {t.hairStyle === 4 && (
          <>
            <circle cx={22} cy={14} r={6} fill={t.hair} />
            <circle cx={32} cy={11} r={7} fill={t.hair} />
            <circle cx={42} cy={14} r={6} fill={t.hair} />
            <path d="M16 24 Q16 12 32 12 Q48 12 48 24 Q48 18 32 18 Q16 18 16 24 Z" fill={t.hair} />
          </>
        )}
        {/* eyes */}
        {t.eyes === 0 && (
          <>
            <circle cx={26} cy={27} r={1.9} fill="#2f2a28" />
            <circle cx={38} cy={27} r={1.9} fill="#2f2a28" />
          </>
        )}
        {t.eyes === 1 && (
          <>
            <path
              d="M23.5 27 Q26 24.5 28.5 27"
              stroke="#2f2a28"
              strokeWidth={1.8}
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M35.5 27 Q38 24.5 40.5 27"
              stroke="#2f2a28"
              strokeWidth={1.8}
              fill="none"
              strokeLinecap="round"
            />
          </>
        )}
        {t.eyes === 2 && (
          <>
            <path d="M23.5 27 L28.5 27" stroke="#2f2a28" strokeWidth={1.8} strokeLinecap="round" />
            <path d="M35.5 27 L40.5 27" stroke="#2f2a28" strokeWidth={1.8} strokeLinecap="round" />
          </>
        )}
        {/* mouth */}
        {t.mouth === 0 && (
          <path
            d="M28 33 Q32 36.5 36 33"
            stroke="#2f2a28"
            strokeWidth={1.8}
            fill="none"
            strokeLinecap="round"
          />
        )}
        {t.mouth === 1 && <ellipse cx={32} cy={34.5} rx={3} ry={2.4} fill="#2f2a28" />}
        {t.mouth === 2 && (
          <path d="M29 34 L35 34" stroke="#2f2a28" strokeWidth={1.8} strokeLinecap="round" />
        )}
        {/* blush */}
        {t.blush && (
          <>
            <circle cx={22} cy={31.5} r={2.2} fill="#f08080" opacity={0.45} />
            <circle cx={42} cy={31.5} r={2.2} fill="#f08080" opacity={0.45} />
          </>
        )}
        {/* glasses */}
        {t.glasses && (
          <>
            <circle cx={26} cy={27} r={4.6} fill="none" stroke="#2f2a28" strokeWidth={1.4} />
            <circle cx={38} cy={27} r={4.6} fill="none" stroke="#2f2a28" strokeWidth={1.4} />
            <path d="M30.6 27 L33.4 27" stroke="#2f2a28" strokeWidth={1.4} />
          </>
        )}
      </svg>
    </span>
  );
}
