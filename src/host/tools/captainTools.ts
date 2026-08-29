/**
 * Captain tool face (docs/11): team/roster/task management and dispatch.
 * Every execute re-resolves the caller (docs/05.8) — identity checks never
 * trust the tool surface.
 *
 * @module dsh-eteams/tools/captainTools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import { ETeamsError, stateRootOf, type RuntimeContext } from '../runtime/base.js';
import {
  createTeam,
  addMember,
  removeMember,
  updateMember,
  teamView,
  archiveTeam,
  deleteTeam,
  sendMessage,
} from '../runtime/teamOps.js';
import {
  createTask,
  updateTask,
  deleteTask,
  assignTask,
  advanceTask,
  reassignTask,
  suspendTask,
  resumeTask,
  cancelTask,
} from '../runtime/assignment.js';
import { listTeams, envForAgent, resolveCaller } from './identity.js';
import { readBox } from '../runtime/notifier.js';
import { readRoster, upsertRosterMember } from '../runtime/roster.js';
import {
  readBuildSession,
  reportBuildProgress,
  type BuildDraft,
} from '../runtime/roleBuilder.js';
import { stationProgress } from '../model/taskMachine.js';
import type { TaskRecord } from '../model/types.js';

/** JSON-schema snippet helpers (literal types required by the spec union). */
const str = (description: string) => ({ type: 'string' as const, description });
const strR = (description: string) => ({
  type: 'string' as const,
  description,
  required: true as const,
});
const strArr = (description: string, required = false) => ({
  type: 'array' as const,
  items: { type: 'string' as const },
  description,
  ...(required ? { required: true as const } : {}),
});
const bool = (description: string) => ({ type: 'boolean' as const, description });

const chainParam = () => ({
  type: 'array' as const,
  description: '执行链（D11）：成员按序接力的站点列表；空 = 单站点任务。',
  items: {
    type: 'object' as const,
    properties: {
      member: str('站点成员名（须在团队中）'),
      stageBrief: str('本站简报：该站产出与交接物'),
    },
    additionalProperties: false,
  },
});

/** Task summary rendered into captain tool output. */
function taskSummary(task: TaskRecord) {
  const station = stationProgress(task);
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    assignee: task.assignee ?? null,
    attemptId: task.currentAttemptId ?? null,
    retryCount: task.retryCount,
    chain:
      station !== undefined
        ? {
            done: station.done,
            total: station.total,
            next: task.chain[task.chainCursor + 1]?.member ?? null,
          }
        : null,
  };
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

/**
 * Create the captain tool set. Registered on the root context; members are
 * denied the whole list at spawn (`toolFilter.deny`).
 */
export function createCaptainTools(
  config: ETeamsResolvedConfig,
  hostCtx: Context,
): ReturnType<typeof defineTool>[] {
  const runtime = hostCtx as unknown as RuntimeContext;

  const createTeamTool = defineTool({
    name: 'eteams_create_team',
    description:
      '创建一个多代理团队并成为其领队。默认 staged：随后用 eteams_add_member / eteams_create_task 完成计划并等待用户批准。approval="automatic" 时立即批准并启动（跳过用户审阅）。拆解前先完成问询（FR-37），questionnaire 记录你的提问。',
    parameters: {
      name: strR('团队名（将用作目录名）'),
      goal: strR('团队目标（一句话，成员可见）'),
      approval: {
        type: 'string' as const,
        enum: ['required', 'automatic'],
        description: 'required=等待用户批准（默认）；automatic=立即启动',
      },
      questionnaire: strArr('问询记录：拆解前向用户确认的问题（FR-37 五区）'),
      maxRetries: { type: 'integer' as const, description: '同成员自动重试上限（默认取插件配置）' },
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          teamId: str('团队 id'),
          phase: str('团队阶段'),
          planReviewState: str('计划审阅状态'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`团队「${v.teamId}」已创建（${v.phase}）`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const team = await createTeam(env, exec.agent!, {
        name: args.name,
        goal: args.goal,
        approval: args.approval,
        questionnaire: args.questionnaire,
        maxRetries: args.maxRetries,
      });
      return {
        ok: true as const,
        teamId: team.id,
        phase: team.phase,
        planReviewState: team.planReviewState ?? '',
      };
    },
  });

  const addMemberTool = defineTool({
    name: 'eteams_add_member',
    description:
      '添加团队成员（staged 计划或运行中团队均可）。不指定 provider/model 时继承当前会话路线（route source=inherited）。',
    parameters: {
      name: strR('成员名（任务链与指派都用它）'),
      role: strR('角色：researcher/engineer/reviewer/writer/…（决定默认人设）'),
      executionPrompt: str('成员执行提示（写入人设）'),
      duty: str('职责边界（覆盖角色模板默认人设）'),
      style: str('工作风格（覆盖角色模板默认人设）'),
      skills: str('能力（覆盖角色模板默认人设）'),
      rules: strArr('工作纪律列表（覆盖角色模板默认人设）'),
      personaMd: str('完整角色手册（Markdown），或成员库已有同名定义则自动带入'),
      provider: str('LLM provider（与 model 同给才生效，覆盖继承路线）'),
      model: str('LLM model'),
      reasoningEffort: str('推理力度（可选）'),
      teamId: str('团队 id（默认当前领队团队）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          member: str('成员名'),
          status: str('staged|ready'),
          teamId: str('团队 id'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`成员 ${v.member}（${v.status}）`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const { team, member } = await addMember(env, exec.agent!, {
        teamId: args.teamId,
        name: args.name,
        role: args.role,
        executionPrompt: args.executionPrompt,
        duty: args.duty,
        style: args.style,
        skills: args.skills,
        rules: args.rules,
        personaMd: args.personaMd,
        provider: args.provider,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
      });
      return { ok: true as const, member: member.name, status: member.status, teamId: team.id };
    },
  });

  const memberSaveTool = defineTool({
    name: 'eteams_member_save',
    description:
      '把成员定义存入工作区成员库（D16，按名字 upsert）。成员库是人设模板：各团队用 eteams_add_member 或面板「添加成员」引用同一份定义。修改已有条目即更新，下次组建团队生效。',
    parameters: {
      name: strR('成员名（成员库唯一键）'),
      role: strR('角色：researcher/engineer/reviewer/writer/…'),
      duty: str('职责边界'),
      style: str('工作风格'),
      skills: str('能力'),
      rules: strArr('工作纪律列表（整体替换）'),
      executionPrompt: str('执行提示'),
      personaMd: str('完整角色手册（Markdown：使命/核心职责/关键规则/交付标准）'),
      provider: str('LLM provider（与 model 同给才生效）'),
      model: str('LLM model'),
      reasoningEffort: str('推理力度（可选）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          name: str('成员名'),
          updatedAt: { type: 'integer' as const, description: '更新时间戳（毫秒）' },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`成员库已保存：${v.name}`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const stored = await upsertRosterMember(stateRootOf(env), {
        name: args.name,
        role: args.role,
        ...(args.duty !== undefined ? { duty: args.duty } : {}),
        ...(args.style !== undefined ? { style: args.style } : {}),
        ...(args.skills !== undefined ? { skills: args.skills } : {}),
        ...(args.rules !== undefined ? { rules: args.rules } : {}),
        ...(args.executionPrompt !== undefined ? { executionPrompt: args.executionPrompt } : {}),
        ...(args.personaMd !== undefined ? { personaMd: args.personaMd } : {}),
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
      });
      return { ok: true as const, name: stored.name, updatedAt: stored.updatedAt };
    },
  });

  const memberListTool = defineTool({
    name: 'eteams_member_list',
    description: '列出工作区成员库（D16）：可复用的成员定义。组建团队时可从中点名并带入人设。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          count: { type: 'integer' as const, description: '成员库条目数' },
          names: {
            type: 'array' as const,
            items: { type: 'string' as const },
            description: '成员名列表',
          },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) =>
        text(
          (v.count ?? 0) > 0
            ? `成员库（${v.count ?? 0}）：${(v.names ?? []).join('、')}`
            : '成员库为空',
        ),
    },
    execute: async (_args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const members = readRoster(stateRootOf(env));
      return {
        ok: true as const,
        count: members.length,
        names: members.map((m) => m.name),
      };
    },
  });

  const buildReportTool = defineTool({
    name: 'eteams_build_report',
    description:
      '角色构建师进度播报（D18-5）：把成员构建会话的一步写入 .eteams/rolebuilder.json，面板实时轮询渲染（步骤时间线 + 草稿渐次呈现）。status 缺省沿用当前状态；首轮报告开启会话（active）；draft 浅合并累积；终态会话上 status=active 的报告开启新一轮。',
    parameters: {
      status: {
        type: 'string' as const,
        enum: ['active', 'awaiting_confirmation', 'confirmed', 'cancelled'],
        description: '会话状态（缺省=沿用当前状态）',
      },
      step: str('当前步骤名（如：撰写角色手册）'),
      stepsDone: strArr('已完成步骤列表（整体替换）'),
      request: str('用户需求原文（开启会话时传入）'),
      draft: {
        type: 'object' as const,
        description: '人设草稿（字段与 eteams_member_save 参数逐字对齐；浅合并累积）',
        properties: {
          name: str('成员名（成员库唯一键）'),
          role: str('角色标签'),
          duty: str('职责边界'),
          style: str('工作风格'),
          skills: str('能力'),
          rules: strArr('工作纪律列表'),
          executionPrompt: str('执行提示'),
          personaMd: str('完整角色手册（Markdown 全文）'),
          provider: str('LLM provider（与 model 同给才生效）'),
          model: str('LLM model'),
          reasoningEffort: str('推理力度'),
          avatar: {
            type: 'object' as const,
            description: '头像对（seed/salt）——newBuild 新开时留空由宿主自动分配',
            properties: {
              seed: { type: 'integer' as const, description: '头像 seed' },
              salt: { type: 'integer' as const, description: '头像 salt' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      note: str('一句话进度（面板时间线旁展示）'),
      interview: {
        type: 'object' as const,
        description:
          '意图访谈（后台构建代理与用户交互的唯一通道，docs/19.16）：把问题写入会话，工作台渲染为选项问卷，宿主把用户答案经 followup 发回。发布后立即结束回合等答案。',
        properties: {
          questions: {
            type: 'array' as const,
            description: '问题列表（一次问全 ≤5 问）',
            items: {
              type: 'object' as const,
              properties: {
                id: str('问题唯一 id'),
                question: str('问题文本'),
                options: {
                  type: 'array' as const,
                  description: '2-4 个选项，推荐项放首位并在 label 尾加「（推荐）」',
                  items: {
                    type: 'object' as const,
                    properties: {
                      label: str('选项文案'),
                      description: str('选项说明（可省）'),
                    },
                    additionalProperties: false,
                  },
                },
                multi: { type: 'boolean' as const, description: '允许多选（缺省单选）' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      newBuild: {
        type: 'boolean' as const,
        description:
          '开一个全新构建（docs/19.16）：无条件覆盖现有会话（含待确认/已结束）。仅主对话构建师开启新需求时传 true；后台构建代理与普通步进播报禁止传。',
      },
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          status: str('会话状态'),
          step: str('当前步骤'),
          updatedAt: { type: 'integer' as const, description: '更新时间戳（毫秒）' },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`构建会话：${v.status} · ${v.step}`),
    },
    // 会话内行内呈现（docs/19.16）：默认卡会把整包 args（含 personaMd 全文）
    // 渲染成大 JSON 行——这里收敛为一行「构建进度 · 步骤」，细节只在面板。
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `构建进度 · ${args.step !== undefined && args.step !== '' ? args.step : '准备中'}`,
    }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined;
      return { card: 'generic' as const, title: '构建进度已同步（面板实时可见）', content: [] };
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const session = await reportBuildProgress(stateRootOf(env), {
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.step !== undefined ? { step: args.step } : {}),
        ...(args.stepsDone !== undefined ? { stepsDone: args.stepsDone } : {}),
        ...(args.request !== undefined ? { request: args.request } : {}),
        ...(args.draft !== undefined ? { draft: args.draft as BuildDraft } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.interview !== undefined
          ? { interview: args.interview as { questions: never[] } }
          : {}),
        ...(args.newBuild === true ? { newBuild: true } : {}),
      });
      return {
        ok: true as const,
        status: session.status,
        step: session.step,
        updatedAt: session.updatedAt,
      };
    },
  });

  const removeMemberTool = defineTool({
    name: 'eteams_remove_member',
    description:
      '移除成员：未接取指派直接撤下；进行中工作吊销 attempt、任务回到就绪池，并中断其当前回合。',
    parameters: { name: strR('成员名'), teamId: str('团队 id（默认当前团队）') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.ok ? '成员已移除' : '移除失败'),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      await removeMember(env, exec.agent!, args.name, args.teamId);
      return { ok: true as const };
    },
  });

  const updateMemberTool = defineTool({
    name: 'eteams_update_member',
    description:
      '更新成员人设（固定框架、可改内容）：role/duty/style/skills/rules/executionPrompt/personaMd。',
    parameters: {
      name: strR('成员名'),
      role: str('新角色'),
      duty: str('职责边界'),
      style: str('工作风格'),
      skills: str('能力'),
      rules: strArr('工作纪律列表（整体替换）'),
      executionPrompt: str('执行提示'),
      personaMd: str('完整角色手册（Markdown：使命/核心职责/关键规则/交付标准）'),
      teamId: str('团队 id（默认当前团队）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.ok ? '成员已更新' : '更新失败'),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      await updateMember(env, exec.agent!, { ...args });
      return { ok: true as const };
    },
  });

  const createTaskTool = defineTool({
    name: 'eteams_create_task',
    description:
      '创建任务：一句主题 + 合同（description/acceptance/inScope/outOfScope/deliverables/idempotencyNote）+ 显式 dependencies + 可选执行链 chain。staged 团队生成草稿，批准后自动就绪；running 团队直接就绪。',
    parameters: {
      subject: strR('任务主题（一句话，作为文件夹 slug）'),
      description: str('任务说明'),
      acceptance: strArr('验收标准（逐条可核对）'),
      inScope: strArr('允许改动的范围'),
      outOfScope: strArr('明确非目标'),
      deliverables: strArr('交付物'),
      idempotencyNote: str('幂等说明（重跑安全的前提）'),
      dependencies: strArr('依赖任务 id 列表'),
      chain: chainParam(),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: str('任务 id'), status: str('任务状态') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 ${v.taskId}（${v.status}）`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以创建任务');
      // Runtime re-validates chain members/stageBrief (schema-level required
      // is unavailable inside nested value schemas).
      const chain = args.chain?.map((s) => ({
        member: s.member ?? '',
        stageBrief: s.stageBrief ?? '',
      }));
      const task = await createTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        { ...args, chain },
      );
      return { ok: true as const, taskId: task.id, status: task.status };
    },
  });

  const updateTaskTool = defineTool({
    name: 'eteams_update_task',
    description: '更新草稿任务的合同/依赖/执行链（计划期可改；批准后合同冻结）。',
    parameters: {
      taskId: strR('任务 id'),
      subject: str('新主题'),
      description: str('任务说明'),
      acceptance: strArr('验收标准'),
      inScope: strArr('允许改动范围'),
      outOfScope: strArr('非目标'),
      deliverables: strArr('交付物'),
      idempotencyNote: str('幂等说明'),
      dependencies: strArr('依赖任务 id（整体替换）'),
      chain: chainParam(),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: str('任务 id') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 ${v.taskId} 已更新`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以更新任务');
      const chain = args.chain?.map((s) => ({
        member: s.member ?? '',
        stageBrief: s.stageBrief ?? '',
      }));
      const task = await updateTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        { ...args, chain },
      );
      return { ok: true as const, taskId: task.id };
    },
  });

  const deleteTaskTool = defineTool({
    name: 'eteams_delete_task',
    description: '删除草稿任务（被依赖或已入执行的任务不可删）。',
    parameters: { taskId: strR('任务 id') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.ok ? '任务已删除' : '删除失败'),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以删除任务');
      await deleteTask(env, { teamId: caller.team.id, actor: caller.actor }, args.taskId);
      return { ok: true as const };
    },
  });

  const assignTaskTool = defineTool({
    name: 'eteams_assign_task',
    description:
      '把 ready 任务指派给成员并投递指派信。链任务默认指派执行链下一站；改派其他成员必须给 deviationNote（D11）。handoff 是给受派成员的上一站交接说明。',
    parameters: {
      taskId: strR('任务 id'),
      member: strR('受派成员名'),
      deviationNote: str('偏离执行链的原因（改派非下一站成员时必填）'),
      handoff: str('交接说明（可选）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: str('任务 id'),
          member: str('成员'),
          attemptId: str('attempt id'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 ${v.taskId} → ${v.member}（${v.attemptId}）`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以指派任务');
      const { task, attempt } = await assignTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        { ...args },
      );
      return { ok: true as const, taskId: task.id, member: attempt.member, attemptId: attempt.id };
    },
  });

  const advanceTaskTool = defineTool({
    name: 'eteams_advance_task',
    description:
      '推进链任务到下一站（完成即续派的第一动作）。无链任务会报错并提示用 eteams_assign_task。',
    parameters: { taskId: strR('任务 id'), handoff: str('交接说明（可选）') },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: str('任务 id'),
          member: str('下一站成员'),
          attemptId: str('attempt id'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 ${v.taskId} → 下一站 ${v.member}（${v.attemptId}）`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以推进任务');
      const { task, attempt } = await advanceTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        args.taskId,
        args.handoff,
      );
      return { ok: true as const, taskId: task.id, member: attempt.member, attemptId: attempt.id };
    },
  });

  const reassignTaskTool = defineTool({
    name: 'eteams_reassign_task',
    description:
      '改派进行中/待决策任务：吊销当前 attempt（旧 token 立即失效），任务转新成员。链任务偏离需 deviationNote。也用于处置 awaiting_decision。',
    parameters: {
      taskId: strR('任务 id'),
      member: str('新成员（缺省=原成员重派）'),
      deviationNote: str('偏离原因（偏离链时必填）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: str('任务 id'),
          member: str('新成员'),
          attemptId: str('attempt id'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 ${v.taskId} 改派 → ${v.member}（${v.attemptId}）`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以改派任务');
      const { task, attempt } = await reassignTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        { ...args },
      );
      return { ok: true as const, taskId: task.id, member: attempt.member, attemptId: attempt.id };
    },
  });

  const suspendTaskTool = defineTool({
    name: 'eteams_suspend_task',
    description: '挂起任务：吊销 attempt 并通知成员停止；ready 任务转入依赖阻塞态。',
    parameters: { taskId: strR('任务 id'), note: str('挂起原因') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: str('任务 id') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 ${v.taskId} 已挂起`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以挂起任务');
      const task = await suspendTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        args.taskId,
        args.note,
      );
      return { ok: true as const, taskId: task.id };
    },
  });

  const resumeTaskTool = defineTool({
    name: 'eteams_resume_task',
    description: '恢复挂起任务：向原成员发新 attempt（重新接取）。',
    parameters: { taskId: strR('任务 id') },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: str('任务 id'),
          attemptId: str('attempt id（ready 恢复时为空）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 ${v.taskId} 已恢复（${v.attemptId}）`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以恢复任务');
      const { task, attempt } = await resumeTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        args.taskId,
      );
      return { ok: true as const, taskId: task.id, attemptId: attempt?.id ?? '' };
    },
  });

  const cancelTaskTool = defineTool({
    name: 'eteams_cancel_task',
    description: '取消任务（终态）：吊销 attempt、通知成员、解除打开的决策。',
    parameters: { taskId: strR('任务 id'), reason: str('取消原因') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: str('任务 id') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 ${v.taskId} 已取消`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以取消任务');
      const task = await cancelTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        args.taskId,
        args.reason,
      );
      return { ok: true as const, taskId: task.id };
    },
  });

  const sendMessageTool = defineTool({
    name: 'eteams_send_message',
    description: '私信团队成员（to=成员名）。对用户的状态汇报直接写在你的回复里，不走此工具。',
    parameters: {
      to: strR('收件成员名'),
      content: strR('消息内容'),
      taskId: str('相关任务 id（可选）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), to: str('收件人') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`已发送给 ${v.to}`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('成员请用成员版 eteams_send_message');
      await sendMessage(env, caller.team, caller.actor, args.to, args.content, {
        taskId: args.taskId,
      });
      return { ok: true as const, to: args.to };
    },
  });

  const teamStatusTool = defineTool({
    name: 'eteams_team_status',
    description:
      '查看团队概览：阶段、成员与状态、任务与执行链进度、待决策、领队邮箱近况、构建会话（角色构建师派发前用它判断是否已有构建进行中）。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          view: { type: 'object' as const, properties: {}, additionalProperties: true },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(JSON.stringify(v.view, null, 2)),
    },
    execute: async (_args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      const view = teamView(env, caller.team);
      // 构建会话行（docs/19.16）：调度员只看这一行决定是否派发新构建。
      const build = readBuildSession(stateRootOf(env));
      (view as Record<string, unknown>)['构建会话'] =
        build === null
          ? null
          : `${build.status} · ${build.step}${build.draft?.name ? ` · ${build.draft.name}` : ''}（更新于 ${Math.max(0, Math.round((Date.now() - build.updatedAt) / 1000))} 秒前）`;
      return { ok: true as const, view };
    },
  });

  const taskBoardTool = defineTool({
    name: 'eteams_task_board',
    description: '任务看板：全部任务的合同摘要与执行记录；status 过滤可选。',
    parameters: { status: str('按状态过滤（如 ready/assigned/in_progress/completed）') },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          tasks: {
            type: 'array' as const,
            items: { type: 'object' as const, properties: {}, additionalProperties: true },
          },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(JSON.stringify(v.tasks, null, 2)),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      const tasks = caller.team.tasks
        .filter((t) => !args.status || t.status === args.status)
        .map((t) => ({
          ...taskSummary(t),
          dependencies: t.dependencies,
          description: t.description ?? null,
          acceptance: t.acceptance ?? [],
          attempts: t.attempts.map((a) => ({
            id: a.id,
            kind: a.kind,
            member: a.member,
            status: a.status,
            progress: a.progress.map((p) => p.text),
            result: a.result?.output ?? null,
            error: a.error ?? null,
          })),
        }));
      return { ok: true as const, tasks };
    },
  });

  const listTeamsTool = defineTool({
    name: 'eteams_list_teams',
    description: '列出本工作区全部团队（含历史）。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          teams: {
            type: 'array' as const,
            items: { type: 'object' as const, properties: {}, additionalProperties: true },
          },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(JSON.stringify(v.teams, null, 2)),
    },
    execute: async (_args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const teams = await listTeams(stateRootOf(env));
      return {
        ok: true as const,
        teams: teams.map((t) => ({ id: t.id, name: t.name, phase: t.phase, goal: t.goal })),
      };
    },
  });

  const archiveTeamTool = defineTool({
    name: 'eteams_archive_team',
    description: '归档 completed/halted 团队（状态目录移入 archive/）。',
    parameters: { teamId: strR('团队 id') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), archivedTo: str('归档目录') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`已归档至 ${v.archivedTo}`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const to = await archiveTeam(env, exec.agent!, args.teamId);
      return { ok: true as const, archivedTo: to };
    },
  });

  const deleteTeamTool = defineTool({
    name: 'eteams_delete_team',
    description: '删除 staged/completed 团队的全部状态（不可恢复）。',
    parameters: { teamId: strR('团队 id') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.ok ? '团队已删除' : '删除失败'),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      await deleteTeam(env, exec.agent!, args.teamId);
      return { ok: true as const };
    },
  });

  const mailboxTool = defineTool({
    name: 'eteams_mailbox',
    description: '读取领队邮箱（最近 20 条）。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          messages: {
            type: 'array' as const,
            items: { type: 'object' as const, properties: {}, additionalProperties: true },
          },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(JSON.stringify(v.messages, null, 2)),
    },
    execute: async (_args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      const messages = readBox(env, caller.team.id, 'captain')
        .slice(-20)
        .map((m) => ({
          id: m.id,
          seq: m.seq,
          at: m.at,
          from: { kind: m.from.kind, name: m.from.name ?? null },
          to: { kind: m.to.kind, name: m.to.name ?? null },
          kind: m.kind,
          taskId: m.taskId ?? null,
          attemptId: m.attemptId ?? null,
          content: m.content,
          readAt: m.readAt ?? null,
        }));
      return { ok: true as const, messages };
    },
  });

  return [
    createTeamTool,
    addMemberTool,
    memberSaveTool,
    memberListTool,
    buildReportTool,
    removeMemberTool,
    updateMemberTool,
    createTaskTool,
    updateTaskTool,
    deleteTaskTool,
    assignTaskTool,
    advanceTaskTool,
    reassignTaskTool,
    suspendTaskTool,
    resumeTaskTool,
    cancelTaskTool,
    sendMessageTool,
    teamStatusTool,
    taskBoardTool,
    listTeamsTool,
    archiveTeamTool,
    deleteTeamTool,
    mailboxTool,
  ];
}
