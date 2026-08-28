/**
 * Shared initial-letter avatar placeholder (M6 replaces it with the seeded
 * SVG avatar renderer; docs/14). Hue is name-derived and stable.
 *
 * @module dsh-eteams/client/avatar
 */
import type { CSSProperties, ReactNode } from 'react';

function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * A stable-colored circle with the member's initial.
 * @param name - member display name (hue seed + initial).
 * @param size - rendered diameter in px (default 34).
 */
export function Avatar({ name, size = 34 }: { name: string; size?: number }): ReactNode {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `hsl(${hueOf(name)} 55% 45%)`,
    color: '#fff',
    fontWeight: 600,
    fontSize: Math.round(size * 0.44),
    flexShrink: 0,
  };
  return <span style={style}>{name.slice(0, 1)}</span>;
}
