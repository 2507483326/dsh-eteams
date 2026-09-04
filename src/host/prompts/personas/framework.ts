/**
 * Persona framework (docs/05.3, D13): fixed field set, editable content.
 * Members get a full persona at spawn and a digest header on every wake.
 * Field rendering/merging only — role templates live in presets.ts, the
 * captain persona in captain.ts, the role builder preset in builder.ts.
 *
 * @module dsh-eteams/prompts/personas/framework
 */
import type { PersonaRecord } from '../../model/types.js';

/** Human framework version — bump only when field semantics change. */
export const PERSONA_FRAMEWORK_VERSION = 1 as const;

/** Baseline rules every member persona carries (框架底线). */
export const PERSONA_BASELINE_RULES: readonly string[] = [
  '只做被正式指派且已接取（claim 成功）的任务；未接取的工作请求一律要求正式指派。',
  '执行线路纪律：阶段节点必记 progress；重要结论同步写入任务 notes.md；失败如实报告并附复现要点。',
  '最小上下文：不主动打听其他任务；需要跨任务信息用 eteams_send_message 问领队。',
  '任务合同优先于人设风格偏好；不改合同范围外文件（声明 inScope 时）。',
  '完成后立即空闲等待领队调度，不自行续做下游任务。',
];

/**
 * 回退执行提示（四处同形统一：defaultPersonaFor / roster / state/db
 * personaFromMd / state/import personaFromFields）。原文本三处同形为
 * `你是「${name}」，以 ${role} 的身份为团队交付。`；members.ts 的变体
 * 「以团队成员身份为团队交付」形态不同，保留原样不并入（零行为铁律，
 * docs/38 §D）。
 */
export function fallbackExecutionPrompt(name: string, role: string): string {
  return `你是「${name}」，以 ${role} 的身份为团队交付。`;
}

/** Field-level persona merge (docs/11.2 update_member): fixed framework, patched content. */
export function mergePersona(
  base: PersonaRecord,
  patch: Partial<Omit<PersonaRecord, 'frameworkVersion'>>,
): PersonaRecord {
  return {
    frameworkVersion: PERSONA_FRAMEWORK_VERSION,
    role: patch.role?.trim() || base.role,
    duty: patch.duty ?? base.duty,
    style: patch.style ?? base.style,
    skills: patch.skills ?? base.skills,
    rules: patch.rules ?? base.rules,
    executionPrompt: patch.executionPrompt ?? base.executionPrompt,
    personaMd: patch.personaMd ?? base.personaMd,
  };
}

/** Human-readable persona block (spawn injection + docs). */
export function renderPersonaBlock(persona: PersonaRecord, name: string): string {
  const summary = [
    `# 人设 · ${name}`,
    `- 角色：${persona.role}`,
    `- 职责边界：${persona.duty}`,
    `- 工作风格：${persona.style}`,
    `- 能力：${persona.skills}`,
    `- 工作纪律：`,
    ...persona.rules.map((r) => `  - ${r}`),
    `- 执行提示：${persona.executionPrompt}`,
  ].join('\n');
  // Full Markdown role playbook (agency-agents-zh style) appended when present.
  return persona.personaMd !== undefined && persona.personaMd.trim() !== ''
    ? `${summary}\n\n---\n\n# 角色手册\n\n${persona.personaMd.trim()}`
    : summary;
}

/** One-line digest injected at the head of every wake message (D13/FR-39). */
export function personaDigest(persona: PersonaRecord, name: string): string {
  return `【人设摘要】${name} · ${persona.role} · ${persona.executionPrompt}`;
}