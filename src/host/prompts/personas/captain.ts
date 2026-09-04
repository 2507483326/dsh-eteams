/**
 * Captain persona — 项目牧羊人 flavor (agency-agents-zh) + 领队固定纪律,
 * merged with an optional user override file
 * `<workspace>/.eteams/captain-persona.yaml` (docs/05.3, D13). The 领队子代理
 * persona band lives in prompts/spawn/captainChild.ts.
 *
 * @module dsh-eteams/prompts/personas/captain
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PersonaRecord } from '../../model/types.js';
import { mergePersona, PERSONA_FRAMEWORK_VERSION } from './framework.js';
import { ROLE_DOCS } from './roleDocs.js';

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