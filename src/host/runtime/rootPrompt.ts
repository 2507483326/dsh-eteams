/**
 * 主对话注入段薄壳（v12 用户迭代「system 角色」）：主对话窗口的 system
 * 提示词带上角色库中 is_root 保留角色「system」的手册(MD)。每次装配现读
 * roles 表（改 MD 即热生效，无需重启）；MD 为空/缺行 → ''（空段贡献语义，
 * registry 丢弃）。判定用排除法：装配 scope 是会话代理（sessionIdOfScope
 * 命中）且不是 eteams 子代理 → 即主对话——领队子代理（captainChildren
 * 注册表）、成员/领队副本行（task_members.session_id，持久）、构建器子
 * 代理（rolebuilder.json builderChildId）一律静默。全程吞错（空串最多让
 * 注入段为空，绝不让装配失败——leaderHandbookForChild 同纪律）。
 *
 * @module dsh-eteams/host/runtime/rootPrompt
 */
import type { ETeamsResolvedConfig } from '../config.js';
import { rootPromptBand } from '../prompts/system/rootPrompt.js';
import { getDb } from '../state/db.js';
import { hasTaskMemberSession, rootRoleRow } from '../state/store.js';
import { stateRootFor } from './base.js';
import { captainChildTeamOf } from './captainAgent.js';
import { readBuildSession } from './roleBuilder.js';
import { sessionIdOfScope } from './sessionPersona.js';

/** 装配 scope 的会话工作目录（identity.envForAgent 同口径：session.header.cwd）。 */
function workspaceOfScope(scope: unknown): string {
  if (typeof scope !== 'object' || scope === null) return process.cwd();
  const cwd = (scope as { session?: { header?: { cwd?: unknown } } }).session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/**
 * The 主对话注入 band for one assembly. `''` contributes nothing — only a
 * main-conversation scope（非 eteams 子代理的会话）with non-empty
 * system-role MD sees the band.
 */
export function rootPromptSection(config: ETeamsResolvedConfig, scope: unknown): string {
  try {
    const sessionId = sessionIdOfScope(scope);
    if (sessionId === undefined) return '';
    // 领队子代理（注册表命中，含 spawn 后首个装配的窗口）静默。
    if (captainChildTeamOf(sessionId) !== undefined) return '';
    const stateRoot = stateRootFor(config, workspaceOfScope(scope));
    const db = getDb(stateRoot);
    // 成员/领队副本行（task_members.session_id，持久，重启免疫）静默。
    if (hasTaskMemberSession(db, sessionId)) return '';
    // 构建器子代理（rolebuilder.json 的 builderChildId）静默。
    if (readBuildSession(stateRoot)?.builderChildId === sessionId) return '';
    const md = rootRoleRow(db)?.persona_md ?? '';
    if (md.trim() === '') return '';
    return rootPromptBand(md);
  } catch {
    return '';
  }
}
