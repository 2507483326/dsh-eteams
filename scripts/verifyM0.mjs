/**
 * M0 verification gate — checks the built artifacts and manifest wiring
 * without touching the desktop profile. Run after `pnpm build`.
 *
 * Exits non-zero on the first failed group; prints ✓ per passed check.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import process from 'node:process';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const exists = (p) => existsSync(new URL(p, root));

let failures = 0;
const ok = (label, cond) => {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
};

console.log('lib/index.js (host bundle)');
ok('exists', exists('lib/index.js'));
if (exists('lib/index.js')) {
  const host = read('lib/index.js');
  ok('registers eteams_ping', host.includes('eteams_ping'));
  ok('applies config schema', host.includes('stateDir'));
}

console.log('lib/client.js (wrapped client bundle)');
ok('exists', exists('lib/client.js'));
if (exists('lib/client.js')) {
  const client = read('lib/client.js');
  ok('ModuleLoader envelope', client.includes('window.__ModuleLoader__.load({'));
  ok(`id "dsh-eteams"`, client.includes('id: "dsh-eteams"'));
  ok('factory receives require', client.includes('factory: (require) => {'));
  ok('exports.apply exported', client.includes('exports.apply'));
  ok('exports.inject exported', client.includes('exports.inject'));
  ok('registers conversation.view entry', client.includes('"conversation.view"'));
  ok('registers conversation.input.right entry', client.includes('"conversation.input.right"'));
  ok('no bare top-level import statements', !/^import\s/m.test(client));
}

console.log('lib/types (declarations)');
ok('lib/types/index.d.ts', exists('lib/types/index.d.ts'));
ok('lib/types/client/index.d.ts', exists('lib/types/client/index.d.ts'));

console.log('cordis.patch.yml');
const patch = exists('cordis.patch.yml') ? read('cordis.patch.yml') : '';
ok('- insert block present', /^- insert:\s*$/m.test(patch));
ok('id: eteams', /id: eteams\s*$/m.test(patch));
ok("name: 'dsh-eteams'", /name:\s*'dsh-eteams'/.test(patch));
ok('stateDir: .eteams', /stateDir:\s*\.eteams/.test(patch));

console.log('package.json manifest');
const pkg = JSON.parse(read('package.json'));
ok('dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
ok('dsh.client.platform web', pkg.dsh?.client?.platform === 'web');
ok('dsh.client.inject lists slots deps', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'));
ok('exports ./cordis.patch.yml', pkg.exports?.['./cordis.patch.yml'] === './cordis.patch.yml');
ok('exports ./client', Boolean(pkg.exports?.['./client']));
ok('host lib/index.js within size budget', !exists('lib/index.js') || statSync(new URL('lib/index.js', root)).size < 1024 * 1024);

if (failures > 0) {
  console.error(`\nverify-m0: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-m0: all checks passed');
