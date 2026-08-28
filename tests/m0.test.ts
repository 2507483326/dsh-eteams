import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/host/config';
import { PLUGIN_ID, PLUGIN_VERSION, STATE_SCHEMA_VERSION, TOOL_PREFIX } from '../src/host/version';
import { activateETeamsTab, ETEAMS_TAB_LABEL, ETEAMS_VIEW_ID } from '../src/client/bridge';

describe('config resolution', () => {
  it('applies every default for a bare config', () => {
    expect(resolveConfig(undefined)).toEqual({
      stateDir: '.eteams',
      workRoot: 'teams',
      maxMembers: 8,
      maxRetries: 3,
      memberProvider: 'spawn',
    });
  });

  it('keeps explicit overrides and merges defaults around them', () => {
    expect(resolveConfig({ maxMembers: 3, stateDir: '.my-teams' })).toEqual({
      stateDir: '.my-teams',
      workRoot: 'teams',
      maxMembers: 3,
      maxRetries: 3,
      memberProvider: 'spawn',
    });
  });
});

describe('identity constants', () => {
  it('uses the eteams namespace', () => {
    expect(PLUGIN_ID).toBe('eteams');
    expect(TOOL_PREFIX).toBe('eteams_');
    expect(STATE_SCHEMA_VERSION).toBe(2);
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('view bridge', () => {
  it('exposes the eteams view id and zh tab label', () => {
    expect(ETEAMS_VIEW_ID).toBe('eteams');
    expect(ETEAMS_TAB_LABEL).toBe('团队');
  });

  it('degrades gracefully without a DOM (node environment)', () => {
    expect(activateETeamsTab()).toBe(false);
  });
});
