/**
 * A/B bisect for the renderer-boot failure: swap the wrapped client bundle
 * between the real build and a minimal no-op that registers nothing.
 *
 *   node scripts/bisect-client.mjs noop   # install the no-op bundle
 *   node scripts/bisect-client.mjs real   # restore the real build
 *
 * The no-op keeps the ModuleLoader envelope and the service declaration but
 * skips every registration — if the desktop boots with it yet fails with the
 * real bundle, the fault is in the client plane's runtime behavior; if it
 * fails with both, the fault is at the graph/serve layer. verifyM0 will
 * report missing registrations while the no-op is installed — expected.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const mode = process.argv[2];
const client = new URL('../lib/client.js', import.meta.url);
const backup = new URL('../lib/client.js.real', import.meta.url);

const noop = [
  'window.__ModuleLoader__.load({',
  '\tid: "dsh-eteams",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '\t\texports.inject = ["slots", "conversationEvents"];',
  '\t\texports.apply = function apply() {};',
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n');

if (mode === 'noop') {
  if (!existsSync(backup)) copyFileSync(client, backup);
  writeFileSync(client, noop);
  console.log('bisect: no-op client bundle installed (real build saved to lib/client.js.real)');
} else if (mode === 'real') {
  if (!existsSync(backup)) {
    console.error('bisect: no backup present — nothing to restore');
    process.exit(1);
  }
  copyFileSync(backup, client);
  rmSync(backup);
  console.log('bisect: real client bundle restored');
} else {
  const current = readFileSync(client, 'utf8');
  console.log(`usage: node scripts/bisect-client.mjs <noop|real>`);
  console.log(`current bundle: ${current.includes('exports.apply = function apply') ? 'NO-OP' : 'REAL'}`);
  process.exit(mode === undefined ? 0 : 1);
}
