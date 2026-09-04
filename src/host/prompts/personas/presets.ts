/**
 * Role templates (可编辑): short summary fields + full Markdown playbook,
 * keyed by lowercased role label. Preset seeding order for roster members
 * (name = role) plus the team-adoption default persona builder. 2026-08-28：
 * 按用户要求从 holden-cpu/agency-agents-zh（MIT）引入五角色原文（roleDocs.ts，
 * 仅去 frontmatter）——personaMd 逐字引入，duty/skills/style 为摘要蒸馏。
 *
 * @module dsh-eteams/prompts/personas/presets
 */
import type { PersonaRecord } from '../../model/types.js';
import { ROLE_BUILDER_NAME, ROLE_BUILDER_PRESET } from './builder.js';
import {
  PERSONA_BASELINE_RULES,
  PERSONA_FRAMEWORK_VERSION,
  fallbackExecutionPrompt,
} from './framework.js';
import { ROLE_DOCS } from './roleDocs.js';

/**
 * Preset seeding order for roster members (name = role). The host seeds one
 * roster member per role on first panel access. 2026-09：按用户要求精简默认
 * 角色——只保留 角色构建师（领队 项目牧羊人 由 defaultCaptainPersona 单独
 * 注入）；前端开发者 / 后端架构师 / UI 设计师 / 趣味注入师 不再预置入库，
 * ROLE_TEMPLATES 仍保留，手动新增成员按角色标签照常套用。
 */
export const PRESET_MEMBER_ROLES = [ROLE_BUILDER_NAME] as const;

/** Role template: short summary fields + full Markdown playbook. */
export interface RoleTemplate {
  duty: string;
  skills: string;
  style: string;
  /** Role-specific discipline appended after PERSONA_BASELINE_RULES (D18). */
  rules?: string[];
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
  [ROLE_BUILDER_NAME]: {
    duty: ROLE_BUILDER_PRESET.duty,
    skills: ROLE_BUILDER_PRESET.skills,
    style: ROLE_BUILDER_PRESET.style,
    rules: [...ROLE_BUILDER_PRESET.rules],
    personaMd: ROLE_BUILDER_PRESET.personaMd,
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
    rules: [...PERSONA_BASELINE_RULES, ...(tpl.rules ?? [])],
    ...(tpl.personaMd !== undefined ? { personaMd: tpl.personaMd } : {}),
    executionPrompt: executionPrompt?.trim() || fallbackExecutionPrompt(name, role || 'member'),
  };
}