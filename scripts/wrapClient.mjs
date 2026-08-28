/**
 * Wrap the tsdown CJS client bundle into the DSH client-bundle envelope.
 *
 * The host web app loads plugin client code through `window.__ModuleLoader__`:
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: "<package name>",
 *   factory: (require) => {
 *     var module = { exports: {} };
 *     var exports = module.exports;
 *     Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
 *     ...CJS body: require("react"), require("@deepseek-ai/...")...
 *     return module.exports;
 *   }
 * });
 * ```
 *
 * tsdown's CJS output already speaks exactly that dialect (top-level `require`
 * calls, ambient `module`/`exports`), so wrapping is mechanical: indent the
 * body one level, provide the two ambient bindings, and export `apply`/
 * `inject` by returning `module.exports`. The loader injects `react`,
 * `react/jsx-runtime`, and every package listed in the manifest's
 * `dsh.client.inject` array into the factory's `require`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const clientPath = new URL('../lib/client.js', import.meta.url);
const pkgPath = new URL('../package.json', import.meta.url);

const body = readFileSync(clientPath, 'utf8');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (body.includes('__ModuleLoader__')) {
  console.error('wrap-client: bundle is already wrapped — run a clean build');
  process.exit(1);
}

const stripped = body.replace(/\n\/\/# sourceMappingURL=.*?\s*$/, '\n');
const indented = stripped
  .split('\n')
  .map((line) => (line.length > 0 ? `\t${line}` : line))
  .join('\n');

const wrapped = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(pkg.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  indented,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n');

writeFileSync(clientPath, wrapped);
console.log(`wrap-client: wrapped lib/client.js as id ${JSON.stringify(pkg.name)}`);
