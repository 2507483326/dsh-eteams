/**
 * Avatar SVG composer — React-side port of vue-color-avatar's
 * VueColorAvatar.vue watchEffect (MIT, Copyright (c) 2021 LeoKu; see
 * assets/avatar/UPSTREAM.json and NOTICE.md). Takes an AvatarOption and
 * produces the final inline `<svg>` document: widgets sorted by paint
 * order, each SVG's inner content spliced into a `<g>` layer, `$fillColor`
 * placeholders substituted, ear inheriting the face skin color.
 *
 * One deliberate divergence from upstream: mask/clipPath ids inside the
 * widget SVGs (face base, laughing/surprised mouths) are namespaced per
 * avatar. Upstream renders exactly one avatar per page so the raw ids never
 * collide; this panel paints a whole roster on one page, so `mask0` from two
 * faces would cross-resolve and bleed fills between avatars.
 *
 * @module dsh-eteams/client/avatarSvg
 */
import type { AvatarOption, AvatarWidgetType } from './avatarOption';
import { AVATAR_LAYER } from './avatarOption';
import { AVATAR_WIDGET_SVGS } from './avatarWidgets';

/**
 * The art board. Upstream's viewBox formula is `${size} / 0.7`, calibrated
 * on its default size=280 → a 400×400 board the widget artwork is drawn
 * against (translate(100, 65), head top ≈ y63, bust clipped at the bottom).
 * Upstream only ever renders at 280, so passing other sizes there crops the
 * board; we keep the board fixed at 400 and scale the viewport instead, so
 * every size reproduces the upstream 280px look.
 */
const BOARD_SIZE = 400;
const WIDGETS_OFFSET_X = 100;
const WIDGETS_OFFSET_Y = 65;

/** Extract the inner content of a widget SVG document (drop <svg> wrapper). */
function innerSvg(svg: string): string {
  const openEnd = svg.indexOf('>', svg.indexOf('<svg'));
  const closeStart = svg.lastIndexOf('</svg>');
  if (openEnd < 0 || closeStart < 0) return '';
  return svg.slice(openEnd + 1, closeStart);
}

/**
 * Rewrite url(#...) / href="#..." references and the ids they point to with
 * a per-avatar suffix, so parallel avatars on one page stay isolated.
 */
function namespaceIds(content: string, ns: string): string {
  if (!content.includes('id="') && !content.includes('url(#')) return content;
  // Every id defined inside the widget SVGs.
  const ids: string[] = [];
  const idPattern = /\bid="([^"]+)"/g;
  for (const match of content.matchAll(idPattern)) ids.push(match[1]!);
  if (ids.length === 0) return content;
  let out = content;
  for (const id of ids) {
    const namespaced = `${ns}${id}`;
    const reference = new RegExp(`url\\(#${id}\\)`, 'g');
    const href = new RegExp(`(\\shref="#)${id}(")`, 'g');
    const definition = new RegExp(`(\\sid=")${id}(")`, 'g');
    out = out
      .replace(reference, `url(#${namespaced})`)
      .replace(href, `$1${namespaced}$2`)
      .replace(definition, `$1${namespaced}$2`);
  }
  return out;
}

export interface ComposeAvatarSvgInput {
  option: AvatarOption;
  /** Rendered size in px; the viewBox stays the fixed 400-unit art board. */
  size: number;
  /**
   * Isolation namespace for mask/clipPath ids — pass something unique per
   * mounted avatar (React useId, member name…). Same namespace + same option
   * is fine; different avatars on one page must differ.
   */
  idNamespace: string;
}

/**
 * Compose the final avatar SVG document. Pure: same inputs → same string
 * (snapshot-test contract, docs/14.8).
 */
export function composeAvatarSvg({ option, size, idNamespace }: ComposeAvatarSvgInput): string {
  const ns = `eteams-av-${idNamespace}-`;

  const sorted = (
    Object.entries(option.widgets) as [
      AvatarWidgetType,
      { shape: string; fillColor?: string; zIndex?: number },
    ][]
  ).sort(
    ([prevType, prev], [nextType, next]) =>
      (prev.zIndex ?? AVATAR_LAYER[prevType]) - (next.zIndex ?? AVATAR_LAYER[nextType]),
  );

  let skinColor: string | undefined;

  const layers = sorted.map(([widgetType, widget]) => {
    const raw = AVATAR_WIDGET_SVGS[widgetType]?.[widget.shape];
    if (widget.shape === 'none' || raw === undefined) return '';

    let fillColor = widget.fillColor;
    if (widgetType === 'face') skinColor = fillColor;
    // Upstream: the ear always wears the face's skin color.
    if (skinColor !== undefined && widgetType === 'ear') fillColor = skinColor;

    const content = namespaceIds(innerSvg(raw), ns).replaceAll(
      '$fillColor',
      fillColor ?? 'transparent',
    );

    return `<g id="${ns}${widgetType}">${content}</g>`;
  });

  return [
    `<svg width="${size}" height="${size}" viewBox="0 0 ${BOARD_SIZE} ${BOARD_SIZE}"`,
    `preserveAspectRatio="xMidYMax meet" fill="none" xmlns="http://www.w3.org/2000/svg">`,
    `<g transform="translate(${WIDGETS_OFFSET_X}, ${WIDGETS_OFFSET_Y})">`,
    ...layers,
    `</g></svg>`,
  ].join('');
}
