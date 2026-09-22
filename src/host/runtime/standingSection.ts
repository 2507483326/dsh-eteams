/**
 * 常驻角色段解析（systemPrompt order 105/106 薄壳）：同一套排除法先判**装配面
 * 身份**，再按段位取值——order 105 主对话给**领队段**
 * （CAPTAIN_SECTION_SHORT）、成员面给**成员段**（MEMBER_SECTION_SHORT）；
 * order 106 只有主对话面才给**角色构建师段**（ROLE_BUILDER_SECTION）。
 *
 * 为什么（用户 2026-09-18「为什么不是领队的成员也出现这个系统提示词？应该为
 * 成员构筑专属的提示词」；用户 2026-09-22「为什么角色构建的文本会出现在领队
 * 中？」）：order 105/106 此前注册的都是**静态字符串**，宿主对每个 agent 装配
 * 都注入，领队/构建师口径因此无差别落到领队子代理、成员子代理、被成员人设接管
 * 的会话与各类子代理上。105 先改，106 漏改——两段共用本文件的判定即不会再各改
 * 一遍。判定范式照搬 rootPrompt.ts（排除法 + 注册表覆盖 spawn 后首个装配的窗口，
 * 副本行是冷恢复兜底），**再加一层结构兜底**（用户 2026-09-22「领队的文本出现在
 * 了子成员中」：登记竞态下成员子代理首轮装配拿到领队段）——子代理会话头自带
 * `origin/delegationDepth`（早于首次装配），登记还没跟上时按静默处理。全程吞错：
 * 空串最多让常驻段为空，绝不让装配失败。
 *
 * @module dsh-eteams/host/runtime/standingSection
 */
import type { ETeamsResolvedConfig } from '../config.js';
import { CAPTAIN_SECTION_SHORT } from '../prompts/system/captain.js';
import { MEMBER_SECTION_SHORT } from '../prompts/system/member.js';
import { ROLE_BUILDER_SECTION } from '../prompts/system/roleBuilder.js';
import { getDb } from '../state/db.js';
import { taskMemberSessionRole } from '../state/store.js';
import { isSubagentScope, stateRootFor } from './base.js';
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
 * One assembly's face（排除法判定，见模块头）：
 * - `main` 主对话面（用户敲字的那扇窗）；
 * - `member` 成员面（成员子代理 / 被成员人设接管的会话）；
 * - `silent` 静默面（无会话、领队子代理、构建师子代理、领队副本行——各自
 *   人格段已是纪律全文，再叠常驻段只会冲突）。
 */
type AssemblyFace = 'main' | 'member' | 'silent';

/** 判定一个装配面的身份（查盘/查表；调用方负责吞错）。 */
function assemblyFace(config: ETeamsResolvedConfig, scope: unknown): AssemblyFace {
  const sessionId = sessionIdOfScope(scope);
  if (sessionId === undefined) return 'silent';
  // 领队子代理：人格段已是领队纪律全文（且 eteams_dispatch_captain 对它不可见，
  // 再给「你转交」只会误导）。
  if (captainChildTeamOf(sessionId) !== undefined) return 'silent';
  const stateRoot = stateRootFor(config, workspaceOfScope(scope));
  // 构建师子代理：人格段自带构建纪律，静默。
  if (readBuildSession(stateRoot)?.builderChildId === sessionId) return 'silent';
  // 成员子代理：注册表覆盖 spawn 后首个装配的窗口（副本行还没回填），副本行
  // 是冷恢复兜底。领队副本行不是成员——静默（人格/注册表已覆盖其常驻面）。
  if (lookupMemberSession(sessionId) !== undefined) return 'member';
  const role = taskMemberSessionRole(getDb(stateRoot), sessionId);
  if (role === 'member') return 'member';
  if (role === 'leader') return 'silent';
  // 被成员人设接管的会话（sessionPersona）：本会话以该成员身份说话，属成员面。
  if (getSessionPersona(sessionId) !== undefined) return 'member';
  // 结构兜底（用户 2026-09-22「领队的文本出现在了子成员中」）：子代理会话头
  // 自带 origin/delegationDepth，早于子代理首次装配——身份登记还没跟上时
  // （spawn 窗口 / 冷恢复），子代理一律按静默处理，绝不误发主对话的领队段
  // （未识别的子代理同理：它们不是领队，也不是我们的成员）。
  if (isSubagentScope(scope)) return 'silent';
  return 'main';
}

/** order 105 段：主对话拿领队段、成员面拿成员段、静默面 `''`（空段语义）。 */
export function standingSection(config: ETeamsResolvedConfig, scope: unknown): string {
  try {
    const face = assemblyFace(config, scope);
    if (face === 'main') return CAPTAIN_SECTION_SHORT;
    if (face === 'member') return MEMBER_SECTION_SHORT;
    return '';
  } catch {
    return '';
  }
}

/**
 * order 106 段：**只有主对话面**拿角色构建师段——它是直呼契约（docs/19.8.1,
 * D18：用户消息带 `eTeam --add-people` 前缀即当场变构建师调度员），领队子代理
 * 与成员面看到只会与人设/纪律冲突。前缀本身读不到（装配上下文只有 scope，
 * 没有本轮消息），故路由留在模型侧，本段只负责「发给谁」。
 */
export function roleBuilderSection(config: ETeamsResolvedConfig, scope: unknown): string {
  try {
    return assemblyFace(config, scope) === 'main' ? ROLE_BUILDER_SECTION : '';
  } catch {
    return '';
  }
}
