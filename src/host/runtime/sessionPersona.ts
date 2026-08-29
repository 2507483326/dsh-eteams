/**
 * Session persona takeover (docs/13.8.2): the panel selects a member for a
 * session and the session agent's system prompt gains a persona band —
 * evaluated per assembly, keyed by the assembling agent. In dsh the
 * assembling scope IS the agent object (`assembleContextFor` passes
 * `scope: agent`) and a session agent's id IS its sessionId (same axis, see
 * dsh-agent), so the band applies to exactly that session's agent and
 * contributes nothing for member subagents or other sessions.
 *
 * The store is in-memory on purpose: the client re-asserts its persisted
 * selection on mount, so a host restart self-heals without a state file.
 *
 * @module dsh-eteams/host/runtime/sessionPersona
 */

/** The persona payload the panel sends for one session. */
export interface SessionPersona {
  readonly name: string;
  readonly role?: string;
  readonly duty?: string;
  readonly personaMd?: string;
}

const personas = new Map<string, SessionPersona>();

/** Set (or replace) the persona band for one session. */
export function setSessionPersona(sessionId: string, persona: SessionPersona): void {
  if (sessionId === '') return;
  personas.set(sessionId, persona);
}

/** Remove the persona band for one session (deselect). */
export function clearSessionPersona(sessionId: string): void {
  personas.delete(sessionId);
}

/**
 * Read the agent id off an assembly scope. The scope is the agent object
 * itself; its string `id` is the sessionId for session agents and something
 * else (member/child axes) for every other agent — those never match a
 * stored session key, which is exactly the isolation we want.
 */
export function sessionIdOfScope(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined;
  const id = (scope as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * The dynamic section text for one assembly. `''` contributes nothing (the
 * registry drops empty sections), so only the session with an active
 * persona sees the band.
 */
export function sessionPersonaSection(sessionId: string | undefined): string {
  if (sessionId === undefined) return '';
  const persona = personas.get(sessionId);
  if (persona === undefined) return '';
  const role = typeof persona.role === 'string' && persona.role !== '' ? `（${persona.role}）` : '';
  const lines = [
    `【eteams 角色接管】从现在起，你在本会话中以团队成员「${persona.name}」${role}的身份与口吻与用户对话：`,
    '- 你的所有输出都代表该角色：语气、称呼、专业视角以其人设为准，不再以助手身份自我表述。',
  ];
  if (typeof persona.duty === 'string' && persona.duty !== '') {
    lines.push(`- 该角色的职责边界：${persona.duty}`);
  }
  if (typeof persona.personaMd === 'string' && persona.personaMd.trim() !== '') {
    const digest = persona.personaMd
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('---'))
      .slice(0, 10)
      .join('；');
    if (digest !== '') lines.push(`- 角色手册要点：${digest}`);
  }
  lines.push('- eteams 的建队/指派/成员构建等能力照常可用，只是表达一律以该角色的口吻进行。');
  return lines.join('\n');
}
