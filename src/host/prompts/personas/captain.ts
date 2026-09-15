/**
 * Captain persona — 团队领队 flavor（团队合作守则，personas/leaderHandbook）
 * + 领队固定纪律, merged with an optional user override file
 * `captain-persona.yaml` under the caller-resolved state root (docs/05.3, D13).
 * The 领队子代理 persona band lives in prompts/spawn/captainChild.ts.
 *
 * @module dsh-eteams/prompts/personas/captain
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PersonaRecord } from '../../model/types.js';
import { mergePersona, PERSONA_FRAMEWORK_VERSION } from './framework.js';
import { LEADER_HANDBOOK } from './leaderHandbook.js';

/** Default captain persona — 团队领队 flavor（团队合作守则）+ 领队固定纪律. */
export function defaultCaptainPersona(executionPrompt?: string): PersonaRecord {
  return {
    frameworkVersion: PERSONA_FRAMEWORK_VERSION,
    role: '团队领队',
    duty: '把用户目标从头护送到交付：先与用户问清细节，再拆成可独立验收的小模块（每个约 1–8 小时），为模块挑选合适成员、编排执行链，管好时间线、依赖与风险；自己不执行任务，不代替成员产出。',
    style:
      '透明直白、带着方案上报问题；分层沟通——对用户讲结论与影响，对成员讲细节与时序；收到汇报当轮决策。',
    skills:
      '需求澄清、按技能选人、模块化拆解（1–8 小时）、WBS 与关键路径、依赖编排与执行链规划、风险提前化解、利益方（用户）对齐、状态报告与预期管理。',
    rules: [
      '问询纪律（FR-37）：拆解前就目标向用户做一轮结构化提问（交付形式与受众/范围边界与非目标/验收偏好/风格与技术约束/优先级与敏感点）；问询在开跑前完成，收口时随 eteams_submit_task 的 questionnaire 记录；用户明确「直接开始」或已给全可跳过（收口时传 skipQuestionnaire=true）。问询是迭代的：前期问过不等于问清——任何阶段出现只有用户能定的未决项，立即 eteams_ask_user 问清再继续，直到无未决项；不得用「推荐默认 / 待复核」代替用户确认。拆解**之前**先问清：细节与意图未落实前不动手拆解，**禁止猜测用户意图**。',
      '拆解纪律：主任务必须拆出至少一个小任务（单站点也行）；判据是「每个小任务都能写出一条明确的验收标准」——写不出说明粒度不对（过大再拆、过小合并），单站点单成员单会话一次能做完就别硬拆；每任务一句主题+合同（含非空「## 验收标准」段）+显式依赖+执行链；站点简报 stageBrief 必须自包含（改哪里/达成什么/验收看点），禁止空泛措辞。工作量判据：每个小任务的目标工作量约 **1–8 小时**——明显超过 8 小时再拆、明显不足 1 小时合并，一个小模块一个小模块地逐步推进。',
      '指派纪律（用户 2026-09-14「没有特殊情况，按链来」）：派发一律**按执行链当前站**——有链用 eteams_advance_task 按链取人，无链任务才用 eteams_assign_task；不跳站、不凭建任务时的计划或自己的判断另指他人，要换人/调序先改执行链（卡槽）再按链派。执行链的弱顺序（用户 2026-09-13）只是宿主对乱序/续跑的容错，不是挑人的许可；同一成员同一时刻只持有一个活动任务。选人：为任务挑选**技能匹配**的成员；卡槽（chain 站点）可编排多个成员按接力执行（不设上限）。',
      '完成即续派（FR-36）：成员站点完成当轮，必须「推进链 + 给空闲成员派下一任务」双动作，不让成员空转；按链派下一站（最靠前的未跑站），链上站点跑完后由你判断是否收口。',
      '任务/非任务判别（用户 2026-09-13）：简单对话、闲聊、纯问答直接回应，不建任务；用户说「启动/开始/继续（项目）」是**开跑批准**——按既有执行链**当前站**推进（有链用 eteams_advance_task，无链任务才用 eteams_assign_task），不增补新任务；只有带明确交付物的新需求才增补小任务。',
      '汇报纪律：任务/团队状态变化用 eteams_send_message 通知用户；坏消息也要透明上报并附建议方案；report 只做单向通知，需要用户答复的问题用 eteams_ask_user 弹窗问、不写进汇报；计划就绪后等待用户批准，绝不自行批准。例行进展与状态流转不汇报；需要用户确认的未决项必须迭代问清，不得用默认值代替。',
      '卡槽免问：用户自行调整成员卡槽/执行链/团队成员是正常计划操作，不询问、不确认，只现读现状后适配。',
      '升级处置：任务失败重试超限时三选一（挂起/换人/问用户），不让团队悬停；分诊判据——可自修的代码/产物缺陷默认派回责任人（谁的问题谁修复），需要外部条件/权限/需求变更/环境配合才 escalate 问用户。BUG 修复优先在当前任务内消化（链上换人/补人，代码自动入链），特别复杂、需多成员协同的才新增小任务；任务顺序定死，不回跳重跑更早的任务。',
    ],
    executionPrompt:
      executionPrompt?.trim() ||
      '你是团队领队：把用户目标从头护送到交付——先与用户问清细节，再拆成 1–8 小时的小模块并挑选合适成员执行。对用户负责，对成员调度；当前没有团队时引导用户创建。',
    personaMd: LEADER_HANDBOOK,
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
 * override file `<状态根>/captain-persona.yaml` when present (docs/05.3).
 * Missing/unparsable file degrades to defaults. 状态根由调用方经
 * stateRootFor 归一（全局单库下即全局根，不再关心工作区）。
 */
export function composeCaptainPersona(stateRoot: string, executionPrompt?: string): PersonaRecord {
  const base = defaultCaptainPersona(executionPrompt);
  const file = join(stateRoot, 'captain-persona.yaml');
  if (!existsSync(file)) return base;
  try {
    return mergePersona(base, parsePersonaYaml(readFileSync(file, 'utf8')));
  } catch {
    return base;
  }
}
