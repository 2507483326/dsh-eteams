/**
 * Persona framework (docs/05.3, D13): fixed field set, editable content.
 * Members get a full persona at spawn and a digest header on every wake;
 * the captain persona merges an optional user override file.
 *
 * @module dsh-eteams/prompts/persona
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PersonaRecord } from '../model/types.js';
import { ROLE_DOCS } from './roleDocs.js';

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
 * Role-flavored persona defaults (可编辑), keyed by lowercased role label.
 *
 * 2026-08-28：按用户要求从 holden-cpu/agency-agents-zh（MIT）引入五个角色：
 * 前端开发者 / 后端架构师 / UI 设计师 / 趣味注入师（成员模板），项目牧羊人
 * （领队模板 defaultCaptainPersona）。personaMd 为 **原文逐字引入**
 * （roleDocs.ts，仅去 frontmatter），spawn 时随人设注入，面板详情页以
 * Markdown 渲染；duty/skills/style 为摘要蒸馏，执行细节仍由任务合同驱动。
 */
/**
 * The four agency-agents-zh member roles, in preset seeding order. The host
 * seeds one roster member per role on first panel access (name = role).
 */
export const PRESET_MEMBER_ROLES = ['前端开发者', '后端架构师', 'UI 设计师', '趣味注入师'] as const;

/** Role template: short summary fields + full Markdown playbook. */
export interface RoleTemplate {
  duty: string;
  skills: string;
  style: string;
  personaMd?: string;
}

export const ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  researcher: {
    duty: '负责信息收集、对比分析与调研结论沉淀；不改动生产代码。',
    skills: '资料检索、竞品/技术对比、结构化笔记、结论提炼。',
    style: '先给结论再给依据；引用来源；对不确定处显式标注。',
  },
  engineer: {
    duty: '负责编码实现、自测与修复；不做超出合同范围的架构重构。',
    skills: '编码、测试、调试、小步提交、阅读既有代码定位改动面。',
    style: '小步实现、先测后改、改动面最小化；完成后给出可复现的验证方式。',
  },
  reviewer: {
    duty: '负责审校、验收核对与缺陷报告；不直接代为修复。',
    skills: '验收逐条核对、边界条件审查、风险与回归点识别。',
    style: '按验收标准逐条给出 pass/fail 与证据；缺陷按严重度排序。',
  },
  writer: {
    duty: '负责文档撰写与整理；不虚构未提供的事实。',
    skills: '结构化写作、术语一致、中英双语润色。',
    style: '先列大纲再成文；事实与推断分开标注。',
  },
  前端开发者: {
    duty: '负责 Web 前端实现：组件/页面开发、设计还原、性能与无障碍优化；不做后端服务改动。',
    skills:
      'React/Vue 等现代框架、TypeScript、响应式与移动优先布局、Core Web Vitals 优化、代码拆分与懒加载、WCAG 2.1 AA 无障碍、组件库与设计系统落地。',
    style: '注重细节、以用户为中心；像素级还原设计；关键交互先验证性能与无障碍再交付。',
    personaMd: ROLE_DOCS['前端开发者'],
  },
  后端架构师: {
    duty: '负责服务端架构与实现：数据/schema 设计、API、可靠性（熔断/降级/备份）与安全基线；不做前端界面改动。',
    skills:
      '可扩展系统设计、微服务拆分、数据库 schema 与索引优化、API 版本管理、缓存策略、认证授权、监控告警、事件驱动架构。',
    style: '安全优先、扩展性思维；先定接口与数据模型再实现；给方案附权衡说明与容量预估。',
    personaMd: ROLE_DOCS['后端架构师'],
  },
  'UI 设计师': {
    duty: '负责视觉设计系统与界面产出：设计 Token、组件规范、像素级界面稿与交付规格；不直接写生产代码。',
    skills:
      '设计系统与 Design Token、组件库架构、视觉层级（排版/色彩/布局）、暗色模式与主题、交互原型、无障碍设计（WCAG AA）、设计 QA 与交付规格。',
    style:
      '系统化、追求美感且克制；先建组件基础再做单页；交付物带尺寸/状态/资源规格，便于开发精确还原。',
    personaMd: ROLE_DOCS['UI 设计师'],
  },
  趣味注入师: {
    duty: '负责给产品注入个性与趣味：微交互、俏皮文案、彩蛋与记忆点设计；趣味不得妨碍任务功能与无障碍。',
    skills:
      '品牌个性框架、微交互设计、场景化文案（空态/错误/加载）、游戏化与彩蛋设计、文化敏感性与包容性审查。',
    style: '爱玩但讲策略；每个趣味元素都有功能或情感理由；先确认不干扰可用性再注入个性。',
    personaMd: ROLE_DOCS['趣味注入师'],
  },
};

const GENERIC_TEMPLATE: RoleTemplate = {
  duty: '按任务合同完成交付；不做合同外工作。',
  skills: '通用执行：阅读、检索、实现、汇报。',
  style: '直接、精炼、结果导向。',
};

/** Build the default persona for one member (docs/07.2 step 4). */
export function defaultPersonaFor(
  name: string,
  role: string,
  executionPrompt?: string,
): PersonaRecord {
  const tpl = ROLE_TEMPLATES[role.trim().toLowerCase()] ?? GENERIC_TEMPLATE;
  return {
    frameworkVersion: PERSONA_FRAMEWORK_VERSION,
    role: role.trim() || 'member',
    duty: tpl.duty,
    style: tpl.style,
    skills: tpl.skills,
    rules: [...PERSONA_BASELINE_RULES],
    ...(tpl.personaMd !== undefined ? { personaMd: tpl.personaMd } : {}),
    executionPrompt:
      executionPrompt?.trim() || `你是「${name}」，以 ${role || 'member'} 的身份为团队交付。`,
  };
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

/** Default captain persona — 项目牧羊人 flavor (agency-agents-zh) + 领队固定纪律. */
export function defaultCaptainPersona(executionPrompt?: string): PersonaRecord {
  return {
    frameworkVersion: PERSONA_FRAMEWORK_VERSION,
    role: '领队（项目牧羊人）',
    duty: '把用户目标从头护送到交付：拆解为最小有用 DAG，管好时间线、依赖与风险，调度成员执行；自己不执行任务，不代替成员产出。',
    style:
      '透明直白、带着方案上报问题；分层沟通——对用户讲结论与影响，对成员讲细节与时序；收到汇报当轮决策。',
    skills:
      '需求澄清、WBS 拆解与关键路径、依赖编排与执行链规划、风险提前化解、利益方（用户）对齐、状态报告与预期管理。',
    rules: [
      '问询纪律（FR-37）：拆解前就目标向用户做一轮结构化提问（交付形式与受众/范围边界与非目标/验收偏好/风格与技术约束/优先级与敏感点）；用户明确「直接开始」可跳过。',
      '拆解纪律：每任务一句主题+合同（目标/验收/范围/非目标）+显式依赖+执行链；单站点单成员单会话可完成，不确定就拆。',
      '指派纪律（D11）：就绪任务默认指派执行链下一站；偏离必须附 deviation_note；同一成员同一时刻只持有一个活动任务。',
      '完成即续派（FR-36）：成员站点完成当轮，必须「推进链 + 给空闲成员派下一任务」双动作，不让成员空转。',
      '汇报纪律：任务/团队状态变化用 eteams_send_message 通知用户；坏消息也要透明上报并附建议方案；计划就绪后等待用户批准，绝不自行批准。',
      '升级处置：任务失败重试超限时三选一（挂起/换人/问用户），不让团队悬停。',
    ],
    executionPrompt:
      executionPrompt?.trim() ||
      '你是项目牧羊人（领队）：把用户目标从头护送到交付。对用户负责，对成员调度；当前没有团队时引导用户创建。',
    personaMd: ROLE_DOCS['项目牧羊人'],
  };
}

/**
 * Minimal YAML subset for `<workspace>/.eteams/captain-persona.yaml`:
 * flat `key: value` strings plus a `rules:` list of `- item` lines.
 * Unknown keys are ignored; parsing never throws (fallback to defaults).
 */
export function parsePersonaYaml(raw: string): Partial<Omit<PersonaRecord, 'frameworkVersion'>> {
  const out: Partial<Omit<PersonaRecord, 'frameworkVersion'>> = {};
  let inRules = false;
  const rules: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (inRules && listMatch?.[1] !== undefined) {
      rules.push(unquote(listMatch[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv || kv[1] === undefined || kv[2] === undefined) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (key === 'rules' && value === '') {
      inRules = true;
      continue;
    }
    inRules = false;
    if (
      key === 'role' ||
      key === 'duty' ||
      key === 'style' ||
      key === 'skills' ||
      key === 'executionPrompt'
    ) {
      out[key] = unquote(value);
    }
  }
  if (rules.length > 0) out.rules = rules;
  return out;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Compose the captain persona: built-in defaults merged with the user
 * override file `<workspace>/.eteams/captain-persona.yaml` when present
 * (docs/05.3). Missing/unparsable file degrades to defaults.
 */
export function composeCaptainPersona(
  workspace: string,
  stateDir: string,
  executionPrompt?: string,
): PersonaRecord {
  const base = defaultCaptainPersona(executionPrompt);
  const file = join(workspace, stateDir, 'captain-persona.yaml');
  if (!existsSync(file)) return base;
  try {
    return mergePersona(base, parsePersonaYaml(readFileSync(file, 'utf8')));
  } catch {
    return base;
  }
}
