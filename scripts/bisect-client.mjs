/**
 * A/B bisect for the renderer-boot failure: swap the wrapped client bundle
 * between the real build and progressively reduced diagnostic variants.
 *
 *   node scripts/bisect-client.mjs real    # restore the real build
 *   node scripts/bisect-client.mjs noop    # register NOTHING (graph-row presence only)
 *   node scripts/bisect-client.mjs slots   # register view+button slots, NO card
 *   node scripts/bisect-client.mjs card    # register card only (conversationEvents)
 *
 * Interpretation:
 *   noop boots, real fails  → fault is in the client plane's runtime behavior
 *   slots boots, card fails → fault is in the card path (conversationEvents)
 *   noop fails too          → fault is at the graph/serve layer, not our code
 *
 * verifyM0 reports missing registrations while a variant is installed — expected.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const mode = process.argv[2];
const client = new URL('../lib/client.js', import.meta.url);
const backup = new URL('../lib/client.js.real', import.meta.url);

/** Wrap a CJS body into the ModuleLoader envelope. */
const envelope = (body) =>
  [
    'window.__ModuleLoader__.load({',
    '\tid: "dsh-eteams",',
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    body,
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n');

const noop = envelope(
  [
    '\t\texports.inject = ["slots", "conversationEvents"];',
    '\t\texports.apply = function apply() {};',
  ].join('\n'),
);

const slots = envelope(
  [
    '\t\texports.inject = ["slots"];',
    '\t\texports.apply = function apply(ctx) {',
    '\t\t\tctx.slots.inject("conversation.view", () => ctx.slots.register({ name: "conversation.view", id: "eteams", order: 100, label: "团队" }, function Placeholder() { return null; }));',
    '\t\t\tctx.slots.inject("conversation.input.right", () => ctx.slots.register({ name: "conversation.input.right", id: "eteams-button", order: 100 }, function PlaceholderButton() { return null; }));',
    '\t\t};',
  ].join('\n'),
);

const card = envelope(
  [
    '\t\texports.inject = ["slots", "conversationEvents"];',
    '\t\texports.apply = function apply(ctx) {',
    '\t\t\tctx.conversationEvents.register({',
    '\t\t\t\tkind: "eteams", target: "chat",',
    '\t\t\t\tmatch: function (event) { return null; },',
    '\t\t\t\tstart: function () {},',
    '\t\t\t\tupdate: function () {},',
    '\t\t\t\tbuildViewNode: function () { return null; }',
    '\t\t\t});',
    '\t\t};',
  ].join('\n'),
);

const variants = { noop, slots, card };

if (mode === 'real') {
  if (!existsSync(backup)) {
    console.error('bisect: no backup present — nothing to restore');
    process.exit(1);
  }
  copyFileSync(backup, client);
  rmSync(backup);
  console.log('bisect: real client bundle restored');
} else if (mode in variants) {
  if (!existsSync(backup)) copyFileSync(client, backup);
  writeFileSync(client, variants[mode]);
  console.log(`bisect: "${mode}" client bundle installed (real build saved to lib/client.js.real)`);
} else {
  const current = existsSync(client) ? readFileSync(client, 'utf8') : '';
  console.log('usage: node scripts/bisect-client.mjs <real|noop|slots|card>');
  console.log(
    `current bundle: ${
      current.includes('function apply() {}')
        ? 'NOOP'
        : current.includes('PlaceholderButton')
          ? 'SLOTS'
          : current.includes('target: "chat"') && current.includes('"conversation.view"')
            ? 'REAL'
            : current.includes('target: "chat"')
              ? 'CARD'
              : 'UNKNOWN'
    }`,
  );
  process.exit(mode === undefined ? 0 : 1);
}
