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
 * Neutralize strict `{{variable}}` interpolation markers before embedding a
 * handbook verbatim: the system-prompt renderer treats `{{…}}` as variable
 * references and THROWS on unknown names (dsh-system-prompt `interpolate`),
 * which would break the whole assembly. Full-width braces keep the text
 * readable while never forming a reference group.
 */
function neutralizeInterpolation(text: string): string {
  return text.split('{{').join('｛｛').split('}}').join('｝｝');
}

/**
 * The dynamic band text for one assembly. `''` contributes nothing (the
 * registry drops empty sections/contexts), so only the session with an active
 * persona sees the band.
 *
 * The persona handbook is embedded VERBATIM (用户反馈：只注入一部分感觉不全)
 * — a lossy 10-line digest dropped exactly the sections that shape behavior
 * (关键规则/沟通风格/专章). A generous 8000-char clip is the only bound, and it
 * announces itself instead of truncating silently.
 */
export function sessionPersonaSection(sessionId: string | undefined): string {
  if (sessionId === undefined) return '';
  const persona = personas.get(sessionId);
  if (persona === undefined) return '';
  const role = typeof persona.role === 'string' && persona.role !== '' ? `（${neutralizeInterpolation(persona.role)}）` : '';
  const name = neutralizeInterpolation(persona.name);
  const lines = [
    `【eteams 角色接管·生效中】从现在起，你就是团队成员「${name}」${role}，本会话的每一次回复都由这个角色说出，不是通用助手：`,
    '- 接管后的第一条回复：先用一句话以该角色身份自报家门（我是谁、擅长什么），再进入正题——这是用户确认接管生效的信号。',
    '- 之后每次回复的视角、措辞、语气、关注点、建议取舍全部从其人设出发；禁止退回中性助手腔，寒暄与短句也不例外。',
  ];
  if (typeof persona.duty === 'string' && persona.duty !== '') {
    lines.push(`- 该角色的职责边界：${neutralizeInterpolation(persona.duty)}`);
  }
  if (typeof persona.personaMd === 'string' && persona.personaMd.trim() !== '') {
    const full = neutralizeInterpolation(persona.personaMd.trim());
    const clipped =
      full.length > 8000
        ? `${full.slice(0, 8000)}\n（手册过长已截断——完整内容请在角色详情页查看）`
        : full;
    lines.push(
      '- 下面是该角色的完整角色手册原文——结构化阅读并严格遵守，特别是其中的关键规则与沟通风格章节：',
      '',
      clipped,
    );
  }
  lines.push('- 问题超出该角色职责时，仍以该角色的口吻回应，说明这不在你的专长范围内，并给出你视角下的方向性建议——不要默默换回助手口吻。');
  lines.push('- eteams 的建队/指派/成员构建等能力照常可用，表达一律以该角色的口吻进行。');
  return lines.join('\n');
}
