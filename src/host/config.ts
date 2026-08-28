/**
 * Plugin configuration schema and resolved shape.
 *
 * Values are supplied by cordis.patch.yml (`config:` block) and validated
 * through this schemastery schema at mount time. Every field carries a
 * default so the plugin also mounts bare (`apply(ctx)` in tests).
 *
 * @module dsh-eteams/host/config
 */
import z from '@deepseek-ai/schemastery';

/** Resolved plugin configuration (all defaults applied). */
export interface ETeamsResolvedConfig {
  /** Directory under the session workspace holding team state (default `.eteams`). */
  stateDir: string;
  /** Workspace-relative root for per-team working directories (default `teams`). */
  workRoot: string;
  /** Hard cap on members per team (default 8). */
  maxMembers: number;
  /** Same-member auto-retry budget before a task fails hard (default 3, D6). */
  maxRetries: number;
  /** Member spawn provider: `'spawn'` or `'fork'` (default `spawn`). */
  memberProvider: string;
}

/** Schemasty schema validating the patch-supplied config block. */
export const ETeamsConfig = z
  .object({
    stateDir: z.string().default('.eteams'),
    workRoot: z.string().default('teams'),
    maxMembers: z.number().default(8),
    maxRetries: z.number().default(3),
    memberProvider: z.string().default('spawn'),
  })
  .description('dsh-eteams plugin configuration');

/** Apply defaults for a (possibly partial) raw config object. */
export function resolveConfig(
  raw: Partial<ETeamsResolvedConfig> | undefined,
): ETeamsResolvedConfig {
  return {
    stateDir: raw?.stateDir ?? '.eteams',
    workRoot: raw?.workRoot ?? 'teams',
    maxMembers: raw?.maxMembers ?? 8,
    maxRetries: raw?.maxRetries ?? 3,
    memberProvider: raw?.memberProvider ?? 'spawn',
  };
}
