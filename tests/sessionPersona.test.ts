/**
 * Session persona takeover (docs/13.8.2): per-assembly section text keyed by
 * the assembling agent id (=== sessionId on the session axis), empty for
 * every other agent, and the deselect path.
 *
 * @module dsh-eteams/tests/sessionPersona
 */
import { describe, expect, it } from 'vitest';
import {
  clearSessionPersona,
  sessionIdOfScope,
  sessionPersonaSection,
  setSessionPersona,
} from '../src/host/runtime/sessionPersona.js';

describe('sessionIdOfScope', () => {
  it('reads the agent id off the scope object', () => {
    expect(sessionIdOfScope({ id: 'sess-1' })).toBe('sess-1');
  });
  it('is defensive about foreign scope shapes', () => {
    expect(sessionIdOfScope(null)).toBeUndefined();
    expect(sessionIdOfScope(undefined)).toBeUndefined();
    expect(sessionIdOfScope({})).toBeUndefined();
    expect(sessionIdOfScope({ id: 42 })).toBeUndefined();
  });
});

describe('sessionPersonaSection', () => {
  it('renders the band only for the persona session', () => {
    setSessionPersona('sess-1', { name: '后端架构师', role: 'engineer', duty: '守护接口边界' });
    const band = sessionPersonaSection('sess-1');
    expect(band).toContain('后端架构师');
    expect(band).toContain('engineer');
    expect(band).toContain('守护接口边界');
    expect(band).toContain('角色接管');
    // Another session's agent assembles nothing.
    expect(sessionPersonaSection('sess-2')).toBe('');
    expect(sessionPersonaSection(undefined)).toBe('');
  });

  it('digests the personaMd playbook into a bounded hint', () => {
    setSessionPersona('sess-md', {
      name: '研究员',
      personaMd: ['---', '# 手册', '第一要点', '', '第二要点', ...Array.from({ length: 30 }, (_, i) => `填充行${i}`)].join('\n'),
    });
    const band = sessionPersonaSection('sess-md');
    expect(band).toContain('第一要点');
    expect(band).toContain('第二要点');
    expect(band).not.toContain('# 手册');
    expect(band).not.toContain('填充行29'); // bounded — no full-playbook dump
  });

  it('clear drops the band entirely', () => {
    setSessionPersona('sess-3', { name: '测试员' });
    expect(sessionPersonaSection('sess-3')).not.toBe('');
    clearSessionPersona('sess-3');
    expect(sessionPersonaSection('sess-3')).toBe('');
  });
});
