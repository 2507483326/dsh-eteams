/**
 * Preview entry: render 48 seeded avatars through the real pipeline into
 * #grid (consumed by scripts/avatarPreview.mjs).
 */
import { generateAvatarOption } from '../src/client/features/avatar/avatarOption';
import { composeAvatarSvg } from '../src/client/features/avatar/avatarSvg';

const grid = document.getElementById('grid');
if (grid) {
  for (let i = 0; i < 48; i++) {
    const seed = 1000 + i * 137;
    const salt = i * 7;
    const option = generateAvatarOption(seed, salt);
    const cell = document.createElement('div');
    cell.className = 'cell';
    // Mirror the real SeedAvatar container: background painted on the
    // wrapper (upstream Background.vue), art clipped to a circle.
    const frame = document.createElement('span');
    Object.assign(frame.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '72px',
      height: '72px',
      borderRadius: '9999px',
      overflow: 'hidden',
      lineHeight: '0',
      background: option.background.color,
    } satisfies Partial<CSSStyleDeclaration>);
    frame.innerHTML = composeAvatarSvg({ option, size: 72, idNamespace: `p${i}` });
    cell.appendChild(frame);
    const label = document.createElement('span');
    label.textContent = `#${i} ${option.widgets.tops.shape}/${option.widgets.mouth.shape}`;
    cell.appendChild(label);
    grid.appendChild(cell);
  }
}
