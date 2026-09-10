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
  // docs/18 §7.1: `/plugins` is owned by client-modules; our API must live at
  // the dedicated top-level prefix, and the bundle-URL hijack must never
  // reappear (2026-08-28 recovery-mode incident).
  ok('web routes bound under /eteams-api', /['"`]\/eteams-api['"`]/.test(host));
  ok('no /plugins namespace registration', !/['"`]\/plugins\/dsh-eteams/.test(host));
  ok(
    'member roster tools registered',
    host.includes('eteams_member_save') && host.includes('eteams_member_list'),
  );
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
  ok(
    'exports.inject declares every accessed service (slots + uiConversation + modelDirectories + sessions)',
    /inject\s*=\s*\[\s*"slots"\s*,\s*"uiConversation"\s*,\s*"modelDirectories"\s*,\s*"sessions"\s*\]/.test(
      client,
    ),
  );
  ok('registers conversation.view entry', client.includes('"conversation.view"'));
  ok('registers conversation.input.right entry', client.includes('"conversation.input.right"'));
  ok('client fetches stay under /eteams-api', !/['"`]\/plugins\/dsh-eteams/.test(client));
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
// stateDir 自 2026-09-04 起支持全局单库绝对路径（cordis.patch.yml 实配
// C:/Users/epat/.eteams），这里只校验键存在且非空，不再钉死相对值。
ok('stateDir configured', /stateDir:\s*\S+/.test(patch));

console.log('package.json manifest');
const pkg = JSON.parse(read('package.json'));
ok('dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
ok('dsh.client.platform web', pkg.dsh?.client?.platform === 'web');
ok(
  'dsh.client.inject matches the reference browser roster',
  Array.isArray(pkg.dsh?.client?.inject) &&
    JSON.stringify(pkg.dsh.client.inject) ===
      JSON.stringify([
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-layout',
        '@deepseek-ai/dsh-client-ui-model-selection',
      ]),
);
ok('exports ./cordis.patch.yml', pkg.exports?.['./cordis.patch.yml'] === './cordis.patch.yml');
ok('exports ./client', Boolean(pkg.exports?.['./client']));
ok(
  'host lib/index.js within size budget',
  !exists('lib/index.js') || statSync(new URL('lib/index.js', root)).size < 1024 * 1024,
);

if (failures > 0) {
  console.error(`\nverify-m0: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-m0: all checks passed');
