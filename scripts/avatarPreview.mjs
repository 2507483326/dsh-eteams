/**
 * Build .tmp-avatar-preview/index.html — a roster gallery rendered through
 * the real pipeline (avatarOption + avatarSvg + avatarWidgets), for browser
 * proof of the vue-color-avatar port. Throwaway preview artifact
 * (.tmp-* is gitignored); run: node scripts/avatarPreview.mjs
 * @module avatarPreview
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const { outputFiles } = await build({
  entryPoints: [`${ROOT}scripts/avatarPreviewEntry.ts`],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  logLevel: 'silent',
});

const code = outputFiles[0].text;

mkdirSync(`${ROOT}.tmp-avatar-preview`, { recursive: true });

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>avatar port preview</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f6f7f9; margin: 24px; }
  h1 { font-size: 18px; }
  .grid { display: flex; flex-wrap: wrap; gap: 14px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 4px;
          background: #fff; border-radius: 12px; padding: 10px; box-shadow: 0 1px 3px rgb(0 0 0 / 10%); }
  .cell span { font-size: 12px; color: #444; }
</style>
</head>
<body>
<h1>vue-color-avatar 移植预览 — (seed, salt) 真实管线渲染 × 48</h1>
<div class="grid" id="grid"></div>
<script>${code}</script>
</body>
</html>`;

writeFileSync(`${ROOT}.tmp-avatar-preview/index.html`, html);
console.log('wrote .tmp-avatar-preview/index.html');
