/**
 * 常驻角色段解析（systemPrompt order 105 薄壳）：同一段位按装配作用域的身份
 * 分流——主对话给**领队段**（CAPTAIN_SECTION_SHORT），成员装配面给**成员段**
 * （MEMBER_SECTION_SHORT），领队子代理与构建师子代理静默（人格段已是各自纪律
 * 全文，再叠一段只会冲突）。
 *
 * 为什么（用户 2026-09-18「为什么不是领队的成员也出现这个系统提示词？应该为
 * 成员构筑专属的提示词」）：order 105 此前注册的是**静态字符串**，宿主对每个
 * agent 装配都注入，领队口径因此无差别落到成员子代理、被成员人设接管的会话与
 * 各类子代理上。判定范式照搬 rootPrompt.ts（排除法 + 注册表覆盖 spawn 后首个
 * 装配的窗口，副本行是冷恢复兜底），全程吞错：空串最多让常驻段为空，绝不让
 * 装配失败。
 *
 * @module dsh-eteams/host/runtime/standingSection
 */
import type { ETeamsResolvedConfig } from '../config.js';
import { CAPTAIN_SECTION_SHORT } from '../prompts/system/captain.js';
import { MEMBER_SECTION_SHORT } from '../prompts/system/member.js';
import { getDb } from '../state/db.js';
import { taskMemberSessionRole } from '../state/store.js';
import { stateRootFor } from './base.js';
import { captainChildTeamOf } from './captainChildRegistry.js';
import { readBuildSession } from './roleBuilder.js';
import { getSessionPersona, sessionIdOfScope } from './sessionPersona.js';
import { lookupMemberSession } from './usage.js';

/** 装配 scope 的会话工作目录（identity.envForAgent 同口径：session.header.cwd）。 */
function workspaceOfScope(scope: unknown): string {
  if (typeof scope !== 'object' || scope === null) return process.cwd();
  const cwd = (scope as { session?: { header?: { cwd?: unknown } } }).session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/**
 * The 常驻角色段 for one assembly. `''` contributes nothing（无会话、领队子代理、
 * 构建师子代理、领队副本行都静默）。
 */
export function standingSection(config: ETeamsResolvedConfig, scope: unknown): string {
  try {
    const sessionId = sessionIdOfScope(scope);
    if (sessionId === undefined) return '';
    // 领队子代理：人格段已是领队纪律全文（且 eteams_dispatch_captain 对它不可见，
    // 再给「你转交」只会误导）。
    if (captainChildTeamOf(sessionId) !== undefined) return '';
    const stateRoot = stateRootFor(config, workspaceOfScope(scope));
    // 构建师子代理：人格段自带构建纪律，静默。
    if (readBuildSession(stateRoot)?.builderChildId === sessionId) return '';
    // 成员子代理：注册表覆盖 spawn 后首个装配的窗口（副本行还没回填），副本行
    // 是冷恢复兜底。领队副本行不是成员——静默（人格/注册表已覆盖其常驻面）。
    if (lookupMemberSession(sessionId) !== undefined) return MEMBER_SECTION_SHORT;
    const role = taskMemberSessionRole(getDb(stateRoot), sessionId);
    if (role === 'member') return MEMBER_SECTION_SHORT;
    if (role === 'leader') return '';
    // 被成员人设接管的会话（sessionPersona）：本会话以该成员身份说话，不给领队段。
    if (getSessionPersona(sessionId) !== undefined) return MEMBER_SECTION_SHORT;
    return CAPTAIN_SECTION_SHORT;
  } catch {
    return '';
  }
}
