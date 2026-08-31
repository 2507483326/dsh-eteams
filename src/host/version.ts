/**
 * dsh-eteams plugin version and identity constants.
 *
 * Keep `PLUGIN_VERSION` in lockstep with package.json `version` — the verify
 * script (scripts/verify-m0.mjs) cross-checks them at build time.
 *
 * @module dsh-eteams/host/version
 */

/** Plugin identity used in logs, tool outputs, and diagnostics. */
export const PLUGIN_ID = 'eteams';

/** Tool namespace prefix reserved by this plugin (coexists with agent_teams_*). */
export const TOOL_PREFIX = 'eteams_';

/** Current plugin version (mirrors package.json). */
export const PLUGIN_VERSION = '0.2.1';

/** Initial on-disk state schema version (docs/11: starts at 2). */
export const STATE_SCHEMA_VERSION = 2;
