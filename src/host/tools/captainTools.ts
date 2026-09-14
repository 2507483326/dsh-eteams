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
import { recordEvent } from '../state/events.js';
import { readTeam } from '../state/store.js';
import { boardFileAbs, taskDirRel } from '../runtime/docs.js';
import {
  createTeam,
  addMember,
  removeMember,
  updateMember,
  teamView,
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
  escalateTask,
  suspendTask,
  resumeTask,
  cancelTask,
  finalizeCommissionTask,
} from '../runtime/assignment.js';
import { listTeams, envForAgent, resolveCaller } from './identity.js';
import { getSessionTeamId, anchoredMainTaskOf } from '../runtime/sessionTeam.js';
import { locateTeamAcrossWorkspaces } from '../runtime/workspaces.js';
import { readBox } from '../runtime/notifier.js';
import {
  formatEmployeeId,
  readRoster,
  taskMemberBadge,
  upsertRosterMember,
} from '../runtime/roster.js';
import {
  answerBuildInterview,
  hasBuildSessionFile,
  readBuildParentSession,
  readBuildSession,
  reportBuildProgress,
  cancelBuildSession,
  type BuildDraft,
} from '../runtime/roleBuilder.js';
import { startBuilderChild } from '../runtime/builderPhases.js';
import {
  leaderHandbookForChild,
  readCaptainTurn,
} from '../runtime/captainAgent.js';
import { captainChildTaskOf } from '../runtime/captainChildRegistry.js';
import { captainChildPersona } from '../prompts/spawn/captainChild.js';
import { stationPointsTo, stationProgress } from '../model/taskMachine.js';
import { renderContract } from '../prompts/handoff/mails.js';
import { ROLE_BUILDER_CHILD_PERSONA } from '../prompts/personas/builder.js';
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
/** 任务号 / 尝试号全库自增（docs/27）——参数与输出一律整数（docs/35 §5#11）。 */
const int = (description: string) => ({ type: 'integer' as const, description });
const intR = (description: string) => ({
  type: 'integer' as const,
  description,
  required: true as const,
});
const intArr = (description: string) => ({
  type: 'array' as const,
  items: { type: 'integer' as const },
  description,
});

const chainParam = () => ({
  type: 'array' as const,
  description: '执行链（D11）：成员按序接力的站点列表；空 = 单站点任务。',
  items: {
    type: 'object' as const,
    properties: {
      // v7 站点写工号（数字串也收，运行层统一解析）：同名成员各拿各的号，
      // 按名指派会随机命中同名行——工号是唯一可靠指称。
      member: str('站点成员工号（数字，如 7 = ET-0007；同名成员必须用工号）'),
      stageBrief: str('本站简报：该站产出与交接物'),
    },
    additionalProperties: false,
  },
});

/** 站点/成员 ref 显示（v7）：工号 → `T{n}-ETxxxx` 任务作用域工牌（n=任务
 * 主任务号）；旧名字站点原样显示（legacy）。 */
function stationDisplay(task: TaskRecord, ref: string | number): string {
  const trimmed = typeof ref === 'string' ? ref.trim() : '';
  const numeric = typeof ref === 'number' ? ref : Number.parseInt(trimmed, 10);
  if (!Number.isFinite(numeric) || (typeof ref === 'string' && String(numeric) !== trimmed)) {
    return typeof ref === 'string' ? ref : String(ref);
  }
  return taskMemberBadge(task.parentId ?? task.id, numeric);
}

/** Task summary rendered into captain tool output. */
function taskSummary(task: TaskRecord) {
  const station = stationProgress(task);
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    assignee: task.assignee ?? null,
    // 产出不落列（docs/35 §5#10）：当前尝试 = 最新一条 attempt 行。
    attemptId: task.attempts.at(-1)?.id ?? null,
    retryCount: task.retryCount,
    chain:
      station !== undefined
        ? {
            // 末站完成即 completed（chainCursor 不再推进）——完成态按满进度口径显示。
            done: task.status === 'completed' ? station.total : station.done,
            total: station.total,
            // 下一站 ref 是工号（v7）——显示层转任务作用域工牌。
            next: task.chain[task.chainCursor + 1]?.member
              ? stationDisplay(task, task.chain[task.chainCursor + 1]!.member)
              : null,
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
      '创建一个多代理团队并成为其领队（建队即生效，无审批环节）。随后用 eteams_add_member 拉人、eteams_submit_task / eteams_create_task 拆任务推进。拆解前先完成问询（FR-37），questionnaire 记录你的提问。',
    parameters: {
      name: strR('团队名（将用作目录名）'),
      questionnaire: strArr('问询记录：拆解前向用户确认的问题（FR-37 五区）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          teamId: int('团队 id（全库自增）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`团队 #${v.teamId} 已创建`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      // 锁定守卫（用户迭代 2026-09-10「1 个主对话只能有 1 个团队」）：绑定
      // 常驻且绑定优先——锁定对话里再建队，队虽建成但工具调用仍落在绑定队
      // 上，只会制造「建了队却动不了」的死路。旧队已死（删队清绑定竞态窗）
      // 时放行：resolveCaller 对死绑定自然 fall-through 到建队身份。
      const boundTeamId = getSessionTeamId(String(exec.agent?.id ?? ''));
      if (boundTeamId !== undefined) {
        const stillAlive = locateTeamAcrossWorkspaces(runtime, config, boundTeamId);
        if (stillAlive !== undefined) {
          throw new ETeamsError(
            `本对话已固定为团队「${stillAlive.team.name}」——一个对话只能服务一个团队`,
            '新建团队请在团队页或未绑定团队的新对话中进行',
          );
        }
      }
      const team = await createTeam(env, exec.agent!, {
        name: args.name,
        questionnaire: args.questionnaire,
      });
      return { ok: true as const, teamId: team.id };
    },
  });

  const addMemberTool = defineTool({
    name: 'eteams_add_member',
    description:
      '添加团队成员（新团队或运行中团队均可）。不指定 model 时执行会话跟随领队路线（派发时解析）。v7 工号（表自增）：每次添加发新班底行，工号 = 班底行自增主键（同名成员各拿各的号；号全局只增不复用，不支持指定号）。',
    parameters: {
      name: strR('成员名（任务链与指派都用它）'),
      role: strR('角色：researcher/engineer/reviewer/writer/…（决定默认人设）'),
      executionPrompt: str('成员执行提示（写入人设）'),
      duty: str('职责边界（覆盖角色模板默认人设）'),
      style: str('工作风格（覆盖角色模板默认人设）'),
      skills: str('能力（覆盖角色模板默认人设）'),
      rules: strArr('工作纪律列表（覆盖角色模板默认人设）'),
      personaMd: str('完整角色手册（Markdown），或成员库已有同名定义则自动带入'),
      model: str('LLM model'),
      reasoningEffort: str('推理力度（可选）'),
      teamId: int('团队 id（默认当前领队团队）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          member: str('成员名'),
          teamId: int('团队 id'),
          employeeId: int('工号（补零显示为 ET-xxxx）'),
        },
        additionalProperties: false as const,
      },
      // 工号必须进 render：model-facing content = render 输出，而后续
      // eteams_assign_task / eteams_reassign_task 的 member 要的就是工号——
      // 只回名字会让同名成员无法指称（2026-09-14 同类缺陷排查）。
      render: (_a, v) =>
        text(
          `成员 ${v.member} 已加入团队 #${v.teamId}（工号 ${formatEmployeeId(v.employeeId ?? 0)}，指派时 member 传数字 ${v.employeeId ?? 0}）`,
        ),
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
        model: args.model,
        reasoningEffort: args.reasoningEffort,
      });
      return {
        ok: true as const,
        member: member.name,
        teamId: team.id,
        employeeId: member.employeeId ?? 0,
      };
    },
  });

  const memberSaveTool = defineTool({
    name: 'eteams_member_save',
    description:
      '把成员定义存入工作区成员库（D16，按名字 upsert）。成员库是人设模板：各团队用 eteams_add_member 或面板「添加成员」引用同一份定义。修改已有条目即更新，下次组建团队生效。',
    parameters: {
      name: strR('成员名（成员库唯一键）'),
      role: strR('角色：researcher/engineer/reviewer/writer/…'),
      profile: str('一句话简介（面板角色列表/详情头展示）'),
      duty: str('职责边界'),
      style: str('工作风格'),
      skills: str('能力'),
      rules: strArr('工作纪律列表（整体替换）'),
      executionPrompt: str('执行提示'),
      personaMd: str('完整角色手册（Markdown：使命/核心职责/关键规则/交付标准）'),
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
        ...(args.profile !== undefined ? { profile: args.profile } : {}),
        ...(args.duty !== undefined ? { duty: args.duty } : {}),
        ...(args.style !== undefined ? { style: args.style } : {}),
        ...(args.skills !== undefined ? { skills: args.skills } : {}),
        ...(args.rules !== undefined ? { rules: args.rules } : {}),
        ...(args.executionPrompt !== undefined ? { executionPrompt: args.executionPrompt } : {}),
        ...(args.personaMd !== undefined ? { personaMd: args.personaMd } : {}),
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
      '角色构建师进度播报（D18-5）：把成员构建会话的一步写入 .eteams/rolebuilder.json，面板实时轮询渲染（步骤时间线 + 草稿渐次呈现）。status 缺省沿用当前状态；首轮报告开启会话（active）；draft 浅合并累积；已结束（confirmed/cancelled）的会话只允许显式 newBuild=true 开新局，普通播报会被拒绝。',
    parameters: {
      status: {
        type: 'string' as const,
        enum: ['active', 'awaiting_confirmation', 'confirmed', 'cancelled'],
        description: '会话状态（缺省=沿用当前状态）',
      },
      step: str(
        '当前步骤名（时间线逐字用：收到需求 → 查重角色库 → 意图访谈 → 起草统一手册 → 深化领域章节 → 完成草稿）——已完成前缀由宿主按当前步骤推导，无需也不能自报',
      ),
      request: str('用户需求原文（开启会话时传入）'),
      draft: {
        type: 'object' as const,
        description: '人设草稿（字段与 eteams_member_save 参数逐字对齐；浅合并累积）',
        properties: {
          name: str('成员名（成员库唯一键）'),
          role: str('角色标签'),
          profile: str('一句话简介（面板角色列表/详情头展示）'),
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
          '意图访谈（2026-09-10 统一问答）：把问题写入会话（发布前先播报步骤「意图访谈」），然后**立即调 eteams_ask_user 把同一组问题弹给用户**——原生弹窗弹在用户当前所在会话（用户正看着你的对话就弹这里，否则发起构建的主对话；不在线自动退回你的对话），答案由宿主自动写回构建会话（无须再 eteams_build_report(answers)），你在同回合继续起草。弹窗被拒/报错：不重试弹窗——按 degradeHint 把问题写进汇报文本直接问用户。',
        properties: {
          questions: {
            type: 'array' as const,
            description: '问题列表（一次问全 ≤5 问；问题会原样经 eteams_ask_user 弹出，按提问口径写）',
            items: {
              type: 'object' as const,
              properties: {
                id: str('问题唯一 id'),
                question: str(
                  '问题文本（提问口径：自包含——点名哪个任务/哪一步、为什么问；说人话——不用代号、缩写与行话，术语一句解释）',
                ),
                header: str(
                  '问题题头（可省）：模型常沿用 ask_user_question 的 header 习惯，渲染为问题上方的小标题',
                ),
                options: {
                  type: 'array' as const,
                  description:
                    '2-4 个选项：每个都写清「选它会怎样」，推荐项放首位并在 label 尾加「（推荐）」；禁止 A/B 代号式无信息量选项',
                  items: {
                    type: 'object' as const,
                    properties: {
                      label: str('选项文案（直接写具体做法与后果；推荐项尾标「（推荐）」）'),
                      description: str('选项说明（可省）：一句具体影响或例子'),
                    },
                    additionalProperties: false,
                  },
                },
                multi: { type: 'boolean' as const, description: '允许多选（缺省单选）' },
              },
              // 访谈问题项放宽（2026-09-11 实况）：模型常把多选字段漂移成
              // multi_select/multiSelect，严格 additionalProperties:false 会让整次
              // build_report 被宿主按 invalid arguments 拒收——别名在 interviewOf
              // 归一为规范字段 multi，未知键忽略。
              additionalProperties: true,
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
      answers: {
        type: 'array' as const,
        description:
          '意图访谈答案（旁路入口，2026-09-10 统一后构建子代理通常无须调用——eteams_ask_user 的答案由宿主自动写回）：[{id, choice}]，与已发布问题一一对应；宿主写回会话，构建代理随后继续起草。主对话亲自构建的降级路径与面板补交用本面。',
        items: {
          type: 'object' as const,
          properties: {
            id: str('问题唯一 id'),
            choice: str('所选项文案（多选以「、」连接）'),
          },
          additionalProperties: false,
        },
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
      const root = stateRootOf(env);
      // 构建代理拿到用户答案 → 只落盘：答案来源已统一为 eteams_ask_user（宿
      // 主自动写回，2026-09-10），本工具的 answers 面保留给两条旁路——主对话
      // 亲自构建的降级路径（prompts/system/roleBuilder）与面板补交（answer-
      // BuildInterview 幂等覆写，双入口不冲突）。
      const inlineAnswers = (Array.isArray(args.answers) ? args.answers : []).filter(
        (a): a is { id: string; choice: string } => {
          const o = a as Record<string, unknown>;
          return (
            typeof o.id === 'string' &&
            o.id !== '' &&
            typeof o.choice === 'string' &&
            o.choice !== ''
          );
        },
      );
      if (inlineAnswers.length > 0) {
        const answered = await answerBuildInterview(root, inlineAnswers);
        return {
          ok: true as const,
          status: answered.status,
          step: answered.step,
          updatedAt: answered.updatedAt,
        };
      }
      const session = await reportBuildProgress(root, {
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.step !== undefined ? { step: args.step } : {}),
        ...(args.request !== undefined ? { request: args.request } : {}),
        ...(args.draft !== undefined ? { draft: args.draft as BuildDraft } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.interview !== undefined
          ? { interview: args.interview as { questions: never[] } }
          : {}),
        ...(args.newBuild === true ? { newBuild: true } : {}),
      });
      // 发布即返回（2026-09-10 统一问答）：interview 只写进构建会话，弹窗由
      // 子代理随后自己调 eteams_ask_user 发起（原生弹窗弹在用户当前所在会话，
      // 否则主对话；答案宿主自动写回）。宿主不做任何会话路由/中转/唤醒。
      return {
        ok: true as const,
        status: session.status,
        step: session.step,
        updatedAt: session.updatedAt,
      };
    },
  });

  const buildGuideTool = defineTool({
    name: 'eteams_build_guide',
    description:
      '领取角色构建师规程与本回合任务（构建子代理每回合第一步先调本工具）：返回 guide=构建纪律全文（含按 turn 的回合决策表、可用接口清单——播报规范、意图访谈与统一问答、回合收束纪律、人设手册规格）、turn=本回合种类、snapshot=会话快照（status/step/request/stepsDone/draft/interview/parentSessionId）。只读幂等，可重复领取。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          guide: str('构建纪律全文（含回合决策表与可用接口清单）'),
          turn: str(
            '本回合种类：start=受理开局 / continue=访谈答案已送达 / resume=放弃后恢复 / restart=手动重启 / none=无进行中会话',
          ),
          snapshot: str(
            '会话快照 JSON（status 会话状态 / step 当前步骤 / request 原需求 / stepsDone 已完成步骤 / draft 当前草稿 / interview 意图访谈{questions,answers} / parentSessionId 发起构建的主会话 id；无会话为 null）',
          ),
        },
        additionalProperties: false as const,
      },
      // render = 模型可见内容（dsh-tools 契约：output.render 产出 Native/
      // model content，presentResult 才是用户卡片）——规程与快照必须在这里
      // 全文进模型上下文（2026-09-10 用户实测：render 只回一行占位文案时
      // 模型拿不到 turn/snapshot，转而去读文件、误判无会话）。
      render: (_a, v) =>
        text(
          `【构建规程】\n${v.guide}\n\n【本回合任务】turn=${v.turn}\n【会话快照】${v.snapshot}`,
        ),
    },
    // 用户卡片静默呈现：规程与快照全文只进模型上下文，对话卡片收敛为一行，
    // 不把整包大 JSON 铺进用户视野。
    presentCall: () => ({ card: 'generic' as const, title: '领取构建规程' }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined;
      return { card: 'generic' as const, title: '已领取构建规程', content: [] };
    },
    // 无状态只读：纪律单一来源 = persona 常量（与子代理系统段同文）；turn
    // 来自宿主派发/唤醒时写的 wakeKind（旧会话无字段回退 start 受理语义）；
    // snapshot 投影宿主管理的会话字段（status/step/request/stepsDone/draft/
    // interview/parentSessionId——子代理自己不读状态文件，一切经本工具）。
    // 成员被拒见本工具。
    execute: async (_args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const root = stateRootOf(env);
      const session = readBuildSession(root);
      return {
        ok: true as const,
        guide: ROLE_BUILDER_CHILD_PERSONA,
        turn: session === null ? 'none' : (session.wakeKind ?? 'start'),
        snapshot: JSON.stringify(
          session === null
            ? null
            : {
                status: session.status,
                step: session.step,
                request: session.request ?? '',
                stepsDone: session.stepsDone ?? [],
                draft: session.draft,
                interview:
                  session.interview === undefined
                    ? null
                    : {
                        questions: session.interview.questions ?? [],
                        ...(session.interview.answers !== undefined
                          ? { answers: session.interview.answers }
                          : {}),
                      },
                parentSessionId: readBuildParentSession(root),
              },
        ),
      };
    },
  });

  const buildWaitTool = defineTool({
    name: 'eteams_build_wait',
    description:
      '停驻等待（遗留停驻原语）：阻塞轮询构建会话文件直到会话变化或超时。注意：访谈问答已改为「发布即结束回合等宿主唤醒」——正常构建流程不要调用本工具等答案（回合边界才消费排队消息，停驻会把唤醒饿死在队列里）；仅用于诊断/特殊场景的受控停驻。会话已终态（confirmed/cancelled）即时返回（changed=true），缺失则报错。',
    parameters: {
      maxWaitSeconds: int('最长等待秒数（缺省 1800，钳制 10-3600）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          changed: bool('等待期间会话是否发生变化'),
          status: str('当前会话状态'),
          step: str('当前步骤'),
          waitedSeconds: int('实际等待秒数'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) =>
        text(v.changed ? `构建会话已变化：${v.status} · ${v.step}` : '构建会话无变化（超时）'),
    },
    // 静默呈现（docs/19.17.1）：停驻是构建子代理的常态动作，默认卡会把
    // 整包渲染成大 JSON 行——收敛为一行，细节只在面板。
    presentCall: () => ({ card: 'generic' as const, title: '构建停驻等待中…' }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined;
      return { card: 'generic' as const, title: '停驻返回（细节见面板）', content: [] };
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const root = stateRootOf(env);
      if (!exec.agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
      const session = readBuildSession(root);
      if (session === null) throw new ETeamsError('没有进行中的构建会话（无法停驻）');
      // 调用者守卫（docs/19.17.1）：只有当前持有本构建的持续子代理能停驻
      //——主对话/成员拿不到凭据。严格相等；受理即预落盘 childId（builderPhases
      // 预生成写入），子代理开跑时凭据已在盘上，无毫秒放行窗口。
      if (session.builderChildId === undefined || session.builderChildId !== String(exec.agent.id)) {
        throw new ETeamsError('只有当前构建子代理可以停驻等待（eteams_build_wait）');
      }
      // 已终态（confirmed/cancelled）立即返回不停驻（docs/19.17.1）：按
      // changed=true 呈现，子代理决策表 (a) 静默收束——返回 changed=false
      // 会让它走「纯超时 → 续驻」分支在死会话上空转。
      if (session.status === 'confirmed' || session.status === 'cancelled') {
        return {
          ok: true as const,
          changed: true,
          status: session.status,
          step: session.step,
          waitedSeconds: 0,
        };
      }
      const maxWaitSeconds = Math.min(3600, Math.max(10, args.maxWaitSeconds ?? 1800));
      // signal 兜底（直接 execute 的测试调用方可能不带 signal）。
      const signal = exec.signal ?? new AbortController().signal;
      // 分片睡眠（2.5s 一拍）且全程响应放弃中断（cancel 路由 interrupt =
      // 打断停驻）：abort 即 reject，工具报错让子代理按决策表立即收束回合。
      const sleepChunk = (ms: number): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new ETeamsError('停驻等待已中断'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      if (signal.aborted) throw new ETeamsError('停驻等待已中断');
      // 变更令牌 = 原始文件内容字符串比对（docs/19.17.1）：不能用 updatedAt
      //——markBuilderWake 唤醒标记不动它，且它驱动工作台草稿表单重置，
      // 拿来当唤醒信号会误重置用户正在编辑的表单。
      const startedAt = Date.now();
      const baseline = JSON.stringify(readBuildSession(root));
      let changed = false;
      for (;;) {
        // 每拍入口先查（验收 P2-1）：interrupt 若落在两片睡眠之间的同步段
        // （读盘+比对的毫秒窗口），abort 事件已成过去式、监听器不会触发——
        // 轮询位自查保证停驻在最迟下一拍前退出。
        if (signal.aborted) throw new ETeamsError('停驻等待已中断');
        const remaining = startedAt + maxWaitSeconds * 1000 - Date.now();
        if (remaining <= 0) break;
        await sleepChunk(Math.min(2500, remaining));
        if (JSON.stringify(readBuildSession(root)) === baseline) continue;
        // 确认读（防瞬时读失败误报变更 → 子代理无谓收束回合多一条结算
        // 噪音行）：100ms 后复读，仍不同于基线才算变更。
        await sleepChunk(100);
        if (JSON.stringify(readBuildSession(root)) !== baseline) {
          changed = true;
          break;
        }
      }
      const latest = readBuildSession(root);
      return {
        ok: true as const,
        changed,
        status: latest !== null ? latest.status : session.status,
        step: latest !== null ? latest.step : session.step,
        waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
      };
    },
  });

  const buildDispatchTool = defineTool({
    name: 'eteams_build_dispatch',
    description:
      '派发成员构建（角色构建师调度专用，docs/19.16）：自带门禁——已有构建进行中（active/awaiting）返回 busy；否则受理并派发持续构建子代理（受理：开会话 → 查重 → 发布意图访谈；同一子代理随后经访谈弹窗/宿主续聊完成起草，一次构建只有一个子代理）。按返回 detail 回应用户即可。',
    parameters: {
      request: strR('用户激活消息原文（eTeam --add-people …）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          spawned: bool('是否已派发新构建'),
          detail: str('给用户的一句话结果'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.detail ?? ''),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const root = stateRootOf(env);
      const current = readBuildSession(root);
      if (
        current !== null &&
        (current.status === 'active' || current.status === 'awaiting_confirmation')
      ) {
        return {
          ok: true as const,
          spawned: false,
          detail: `已有成员构建在进行（${current.draft?.name || '未命名'} · ${current.step}）——请先在面板完成或放弃它`,
        };
      }
      if (current === null && hasBuildSessionFile(root)) {
        // 会话文件在但读不出（瞬时 IO 竞态）——按忙处理，宁拒不漏放。
        return {
          ok: true as const,
          spawned: false,
          detail: '构建状态正在写入，请稍候 1-2 秒重试',
        };
      }
      if (!exec.agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
      // 立即受理（与 /eteam 命令同语义）：先写盘再派发——卡片/面板首轮轮询
      // 即命中，request 用工具入参的用户原文（修复子代理继承旧会话需求）。
      await reportBuildProgress(root, {
        newBuild: true,
        step: '收到需求',
        stepsDone: ['收到需求'],
        request: args.request,
        note: '构建请求已受理——角色构建师启动中',
      });
      startBuilderChild({
        ctx: env.ctx,
        config,
        parent: exec.agent,
        stateRoot: root,
        logger: env.ctx.logger,
        onSpawnFailure: (error) => {
          // 真实原因进 note——桌面宿主的 logger.warn 不落盘，卡片是用户
          // 唯一能看到派发失败的表面。
          const reason = error instanceof Error ? error.message : String(error);
          void cancelBuildSession(root, `构建派发失败——可重新派发（原因：${reason}）`).catch(
            () => undefined,
          );
        },
      });
      return {
        ok: true as const,
        spawned: true,
        detail: '已受理并派发——创建卡片与新增页已显示构建状态，意图访谈将在其上出现',
      };
    },
  });

  const removeMemberTool = defineTool({
    name: 'eteams_remove_member',
    description:
      '移除成员：未接取指派直接撤下；进行中工作吊销 attempt、任务回到就绪池，并中断其当前回合。',
    parameters: { name: strR('成员名'), teamId: int('团队 id（默认当前团队）') },
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
      teamId: int('团队 id（默认当前团队）'),
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
      '创建任务：一句主题 + 合同（description/contractMd/idempotencyNote，合同统一写在一篇 Markdown 里：验收标准/允许改动/禁止改动/交付物分节）+ 显式 dependencies + 可选执行链 chain。对话任务拆解（docs/26）：传 parentTaskId 把本任务挂为对应主任务（任务单）下的小任务——chain 站点即成员槽，成员按序接力；小任务文件夹落在主任务文件夹 sub/ 下。**拆解小任务必须带 parentTaskId**：本对话已有主任务时漏传会被宿主拒绝、不入库（否则会静默建成顶层任务，主任务页的小任务列表里看不到）；首次创建主任务请用 eteams_submit_task（本工具建的是任务，不是任务单容器）。**小任务必须带含非空「## 验收标准」段的合同**（二级标题、标题文字精确为「验收标准」，段内非空）：收口会逐个校验，缺段即拒绝收口。',
    parameters: {
      subject: strR('任务主题（一句话，作为文件夹 slug）'),
      parentTaskId: int(
        '父主任务号（拆解小任务必填：挂到对应任务单下；本对话已有主任务时漏传会被拒绝）',
      ),
      description: str('任务说明'),
      contractMd: str(
        '任务合同全文（Markdown）：## 验收标准（编号列表，小任务必填且非空）/ ## 允许改动 / ## 禁止改动 / ## 交付物 分节统一写在这篇 MD 里',
      ),
      idempotencyNote: str('幂等说明（重跑安全的前提）'),
      dependencies: intArr('依赖任务号列表'),
      chain: chainParam(),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: int('任务号'), status: str('任务状态') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId}（${v.status}）`),
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

  const submitTaskTool = defineTool({
    name: 'eteams_submit_task',
    description:
      '对话任务入口（docs/26）：用户在对话中把一个任务交给团队时先调它——立即生成任务 ID（主任务/任务单容器）与专属任务文件夹，面板「任务」页立刻以「创建中」显示（旋转动画 + 状态「创建中」+ 不可点进）。提交后按工作流推进：先向用户问询明确目标（结论用 eteams_update_task 写回本主任务 description），再用 eteams_create_task（带 parentTaskId）把任务拆解成多个小任务（每个小任务 chain 站点即成员槽）；拆解全部完成后**必须**再调本工具带 taskId 收口：回写主题/说明并把「创建中」转「待开始」（面板随即可开跑）——收口须带 questionnaire（问过用户的问题清单）或 skipQuestionnaire=true（用户已给全/要求直接开始），两者皆无会被宿主拒绝（问询必须在执行前完成，且已迭代到无未决项——成员结论/合同里不得留「推荐默认 / 待复核」类项）。收口还会校验拆解质量：主任务下须有至少 1 个未取消小任务，且每个小任务的合同都要含非空「## 验收标准」段——缺任一即拒绝收口。面板手动创建的任务（docs/panelTaskCommission）同样传 taskId 收口。',
    parameters: {
      taskId: int(
        '收口目标主任务号（不带 = 新建主任务容器，先落「创建中」待拆解收口；带 = 拆解完成后收口，把「创建中」转「待开始」）',
      ),
      subject: strR('任务主题（一句话）'),
      description: str('当前对任务的理解/背景（问询后更新）'),
      questionnaire: strArr('收口时必带：问过用户的问题清单（留档；答案更新进 description；问询迭代到无未决项）'),
      skipQuestionnaire: bool('无需问询：用户已给全或要求直接开始时置 true（跳过收口问询自检）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: int('主任务号'),
          status: str('任务状态'),
          folder: str('专属任务文件夹（相对工作区）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId} 已提交（任务单文件夹 ${v.folder}）`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以提交对话任务');
      const who = { teamId: caller.team.id, actor: caller.actor };
      let task: TaskRecord;
      if (args.taskId !== undefined) {
        // 完善收口（docs/panelTaskCommission）：面板「创建中」容器一次性
        // 落定（回写 + creating→ready + 事件，单事务）。
        task = await finalizeCommissionTask(env, who, args.taskId, {
          subject: args.subject,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.questionnaire !== undefined && args.questionnaire.length > 0
            ? { questionnaire: args.questionnaire }
            : {}),
          ...(args.skipQuestionnaire === true ? { skipQuestionnaire: true } : {}),
        });
      } else {
        // 锁定 + 增补守卫（用户迭代 2026-09-10；2026-09-12 加严「每个会话
        // 只有一个主任务」）：本对话已有主任务（**含 completed**——完成只是
        // 可回退标识）就不再开新容器——band 是软约束，这里是硬兜底（模型忘
        // 了带 taskId 或无视 band 时给出可执行出路）。锚点只有容器删除或
        // cancelled 才释放，故正常流程里本对话不会再建第二个主任务。
        const freshBefore = await readTeam(stateRootOf(env), caller.team.id);
        // env.sessionId 缺省（无会话上下文的调用）按无锚定处理：'' 在判据里
        // 恒返回 undefined，不误拦面板等无会话路径。
        const anchored =
          freshBefore !== undefined ? anchoredMainTaskOf(freshBefore, env.sessionId ?? '') : undefined;
        if (anchored !== undefined) {
          throw new ETeamsError(
            `本对话已有主任务 #${anchored.id}「${anchored.subject}」——一个对话只有一个主任务（完成也不新开），不要再另建主任务`,
            caller.team.hasLeader
              ? `新请求用 eteams_dispatch_captain（taskId=${anchored.id}，message=用户原话）转交领队，由领队在主任务下增补小任务`
              : `新请求先问询，然后 eteams_create_task（parentTaskId=${anchored.id}）在主任务下增补小任务`,
          );
        }
        task = await createTask(
          env,
          who,
          {
            subject: args.subject,
            description: args.description,
            kind: 'group',
            // 用户迭代 2026-09-12「任务创建中时我希望有一个创建中的动画，而且状态
            // 显示创建中，且不能点进去」：对话建的主任务先落「创建中」（面板显示
            // 动画/状态/禁点），拆解全部完成后由 eteams_submit_task(taskId) 收口
            // （finalizeCommissionTask）转「待开始」——与面板 commission 同一条
            // 收口口径。
            status: 'creating',
          },
        );
        if (args.questionnaire !== undefined && args.questionnaire.length > 0) {
          await recordEvent(stateRootOf(env), caller.team.id, caller.actor, 'plan.questionnaire', {
            taskId: task.id,
            payload: { questions: args.questionnaire },
          });
        }
      }
      const fresh = await readTeam(stateRootOf(env), caller.team.id);
      return {
        ok: true as const,
        taskId: task.id,
        status: task.status,
        folder: fresh ? taskDirRel(fresh, task) : '',
      };
    },
  });

  const updateTaskTool = defineTool({
    name: 'eteams_update_task',
    description:
      '更新未领取任务（creating/ready 可改）的合同/依赖/执行链；对话任务工作流里用它把问询结论写回主任务（任务单）description。已入执行（指派后）的任务合同冻结。',
    parameters: {
      taskId: intR('任务号'),
      subject: str('新主题'),
      description: str('任务说明'),
      contractMd: str('新合同全文（Markdown 整篇替换：验收标准/允许改动/禁止改动/交付物分节）'),
      idempotencyNote: str('幂等说明'),
      dependencies: intArr('依赖任务号（整体替换）'),
      chain: chainParam(),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: int('任务号') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId} 已更新`),
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
    description:
      '删除未领取任务（creating/ready 可删；主任务级联删除其全部未领取小任务并清任务文件夹）。被依赖或已入执行的任务不可删。',
    parameters: { taskId: intR('任务号') },
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
      '把 ready 任务指派给成员并投递指派信。**按链来**（用户 2026-09-14「没有特殊情况，按链来」）：有执行链的任务用 eteams_advance_task 按当前站推进（自动按链取人、不跳站）；本工具用于**无执行链**的任务。传不在本任务链上的成员时，系统会自动补 task_members 副本行（幂等去重）并把该成员追加到链尾——这会**绕过链**，有链的任务不要这样做（要换人/调序先改链再按链派）。handoff 是给受派成员的交接说明。',
    parameters: {
      taskId: intR('任务号'),
      member: strR('受派成员（成员工号数字，如 7 = ET-0007；同名成员必须用工号）'),
      deviationNote: str('改派原因（可选审计留痕，不再必填）'),
      handoff: str('交接说明（可选）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: int('任务号'),
          member: str('成员'),
          attemptId: int('attempt id'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId} → ${v.member}（attempt ${v.attemptId}）`),
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
      '推进链任务到**当前站**（最靠前的未跑站，自动按链取人）——开跑/续派的第一动作，不跳站、不越过当前站、不自己挑人。无链任务会报错并提示用 eteams_assign_task。',
    parameters: { taskId: intR('任务号'), handoff: str('交接说明（可选）') },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: int('任务号'),
          member: str('下一站成员'),
          attemptId: int('attempt id'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId} → 下一站 ${v.member}（attempt ${v.attemptId}）`),
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
      '改派进行中/待领队(wait)/待用户(wait_user)任务：吊销当前 attempt（旧 token 立即失效），任务转新成员/原成员重新执行。wait 任务（失败自动重试超限后）用本工具重新派人 loop——member 缺省=最近执行者。执行链是弱顺序（用户 2026-09-13）：可改派任意在册成员，不在链上会自动补 task_members 副本行并追加到链尾，不再要求 deviationNote（有则记为审计留痕）。BUG 修复优先在当前任务内派人（链上换人/补人），复杂多成员协同才新增小任务。',
    parameters: {
      taskId: intR('任务号'),
      member: str('新成员工号（缺省=原成员/最近执行者重派；同名成员必须用工号）'),
      deviationNote: str('改派原因（可选审计留痕，不再必填）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: int('任务号'),
          member: str('新成员'),
          attemptId: int('attempt id'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId} 改派 → ${v.member}（attempt ${v.attemptId}）`),
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

  const escalateTaskTool = defineTool({
    name: 'eteams_escalate_task',
    description:
      '升级待领队(wait)任务为待用户(wait_user)：流程/环境类问题（非小 bug）交用户决策时用——开一条决策记录并把问题交给用户；小 bug 请改用 eteams_reassign_task 重新指派 loop。',
    parameters: { taskId: intR('任务号'), note: str('升级原因/要用户决策的问题') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: int('任务号') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId} 已升级为待用户`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind !== 'captain') throw new ETeamsError('只有领队可以升级任务');
      const task = await escalateTask(
        env,
        { teamId: caller.team.id, actor: caller.actor },
        args.taskId,
        args.note,
      );
      return { ok: true as const, taskId: task.id };
    },
  });

  const suspendTaskTool = defineTool({
    name: 'eteams_suspend_task',
    description:
      '挂起任务：吊销在办/待接取 attempt 并通知成员停止，任务转 paused；恢复走 eteams_resume_task（回到待开始待重新派发）。',
    parameters: { taskId: intR('任务号'), note: str('挂起原因') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: int('任务号') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId} 已挂起`),
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
    description:
      '恢复挂起任务：paused 任务回待开始（ready）并给原成员开新一轮尝试（新 attempt）。',
    parameters: { taskId: intR('任务号') },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          taskId: int('任务号'),
          attemptId: int('attempt id（阻塞还原时无新尝试，缺省）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) =>
        text(`任务 #${v.taskId} 已恢复${v.attemptId !== undefined ? `（attempt ${v.attemptId}）` : ''}`),
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
      return {
        ok: true as const,
        taskId: task.id,
        ...(attempt !== undefined ? { attemptId: attempt.id } : {}),
      };
    },
  });

  const cancelTaskTool = defineTool({
    name: 'eteams_cancel_task',
    description: '取消任务（终态）：吊销 attempt、通知成员、解除打开的决策。',
    parameters: { taskId: intR('任务号'), reason: str('取消原因') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: bool('是否成功'), taskId: int('任务号') },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`任务 #${v.taskId} 已取消`),
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
    description:
      '私信团队成员（to=成员名/工号）。成员侧 to="captain" 发给领队（求助/决策/汇报），不能给自己发。对用户的状态汇报直接写在你的回复里，不走此工具。',
    parameters: {
      to: strR('收件成员名'),
      content: strR('消息内容'),
      taskId: int('相关任务号（可选）'),
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
      if (caller.kind === 'member') {
        // 成员分支（原 memberTools 成员变体——harness 0.1.2 起同名工具在
        // root 只能有 一个，成员/领队行为按 caller.kind 合一到本工具）。
        if (args.to.trim() === caller.member.name) throw new ETeamsError('不能给自己发消息');
      }
      await sendMessage(env, caller.team, caller.actor, args.to, args.content, {
        taskId: args.taskId,
      });
      return { ok: true as const, to: args.to };
    },
  });

  const teamStatusTool = defineTool({
    name: 'eteams_team_status',
    description:
      '查看团队概览：成员与状态、任务与执行链进度、待决策、领队邮箱近况、构建会话（角色构建师派发前用它判断是否已有构建进行中）。',
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

  // 领队子代理的领取面（用户迭代 2026-09-10「领取完成流程」，与角色构建师
  // 的 eteams_build_guide 同款）：可见回合提示词只剩一句话指路，工作流程
  // 全文、本回合任务与团队现状全部经本工具进模型上下文。成员拒见
  // （MEMBER_DENIED_TOOLS）；领队子代理不加 deny（CAPTAIN_CHILD_DENIED_TOOLS）。
  const captainGuideTool = defineTool({
    name: 'eteams_captain_guide',
    description:
      '领取领队规程与本回合任务（领队子代理每回合第一步先调本工具）：返回 guide=工作流程全文（含回合决策表 + 角色手册）、turn=本回合种类（dispatch=主对话转交 / commission=面板任务完善 / start=面板开始批准 / none=无待处理转交）、snapshot=快照 JSON（taskId 锚定主任务 / boardFile 队伍留言板绝对路径 / teamStatus 团队现状 / latestMessage 本回合转交内容 / parentSessionId 发起会话 id）。只读幂等，可重复领取。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          guide: str('领队工作流程全文（含回合决策表与角色手册）'),
          turn: str(
            '本回合种类：dispatch=主对话转交 / commission=面板任务完善 / start=面板开始批准 / none=无待处理转交',
          ),
          snapshot: str(
            '会话快照 JSON（taskId 锚定主任务 / boardFile 队伍留言板绝对路径 / teamStatus 团队现状 / latestMessage 本回合转交内容 / parentSessionId 发起会话 id）',
          ),
        },
        additionalProperties: false as const,
      },
      // render = 模型可见内容（dsh-tools 契约，与 eteams_build_guide 同理：
      // presentResult 只是用户卡片）——规程/turn/快照必须全文铺进模型内容。
      render: (_a, v) =>
        text(
          `【领队规程】\n${v.guide}\n\n【本回合任务】turn=${v.turn}\n【会话快照】${v.snapshot}`,
        ),
    },
    // 用户卡片收敛为一行：整包规程与快照只进模型上下文，不铺进用户视野。
    presentCall: () => ({ card: 'generic' as const, title: '领取领队规程' }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined;
      return { card: 'generic' as const, title: '已领取领队规程', content: [] };
    },
    // 无状态只读：turn/message 来自派发核写的回合 sidecar（<stateRoot>/
    // captain-turn/<taskId>.json）；锚定主任务按领队副本行（sessionId=本子
    // 会话且 is_leader）解析，注册表兜底；手册 = 副本行缓存实文（与 persona
    // 系统段插槽同一来源，经 leaderHandbookForChild 解析、缺省内置兜底）。
    execute: async (_args, exec) => {
      if (!exec.agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const root = stateRootOf(env);
      const childId = String(exec.agent.id);
      const caller = await resolveCaller(env, exec.agent);
      if (caller.kind !== 'captain') {
        throw new ETeamsError('只有领队身份可以领取团队规程（eteams_captain_guide）');
      }
      // 锚定主任务：领队副本行（本子会话锚）优先，派发注册表兜底（重启后
      // followup 重登记的窗口）。
      const replicaTaskId = caller.team.taskMembers.find(
        (r) => r.isLeader === true && r.sessionId === childId,
      )?.mainTaskId;
      const registryTaskId = captainChildTaskOf(childId);
      const anchoredTaskId =
        replicaTaskId ?? (registryTaskId !== undefined ? Number(registryTaskId) : null);
      const turnRec =
        anchoredTaskId !== null ? readCaptainTurn(root, String(anchoredTaskId)) : null;
      // 队伍留言板绝对路径（用户 2026-09-14）：锚定主任务文件夹根下的
      // 留言板.md——派发/推进前先读、每完成一个编排动作追加一行。
      const anchoredTask =
        anchoredTaskId !== null
          ? caller.team.tasks.find((t) => t.id === anchoredTaskId)
          : undefined;
      const boardFile =
        anchoredTask !== undefined ? boardFileAbs(env.workspace, caller.team, anchoredTask) : null;
      // 团队现状快照与 eteams_team_status 同一视图（含构建会话行）。
      const view = teamView(env, caller.team);
      const build = readBuildSession(root);
      (view as Record<string, unknown>)['构建会话'] =
        build === null
          ? null
          : `${build.status} · ${build.step}${build.draft?.name ? ` · ${build.draft.name}` : ''}（更新于 ${Math.max(0, Math.round((Date.now() - build.updatedAt) / 1000))} 秒前）`;
      return {
        ok: true as const,
        guide: captainChildPersona(leaderHandbookForChild(config, childId)),
        turn: turnRec === null ? 'none' : turnRec.turn,
        snapshot: JSON.stringify({
          ...(anchoredTaskId !== null ? { taskId: anchoredTaskId } : {}),
          ...(boardFile !== null ? { boardFile } : {}),
          teamStatus: view,
          latestMessage: turnRec?.message ?? '',
          parentSessionId: turnRec?.parentSessionId ?? null,
        }),
      };
    },
  });

  const taskBoardTool = defineTool({
    name: 'eteams_task_board',
    description:
      '任务看板：领队看全部任务的合同摘要与执行记录（status 过滤可选）；成员看自己名下的任务与执行链进度。',
    parameters: { status: str('按状态过滤（如 ready/start/paused/wait_user/completed）') },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          tasks: {
            type: 'array' as const,
            items: { type: 'object' as const, properties: {}, additionalProperties: true },
          },
          view: { type: 'object' as const, properties: {}, additionalProperties: true },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) =>
        text(JSON.stringify('view' in (v as Record<string, unknown>) ? v.view : v.tasks, null, 2)),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent!);
      if (caller.kind === 'member') {
        // 成员视角看板（原 memberTools 成员变体——0.1.2 起同名工具合一）：
        // 我名下的任务 = assignee 或执行链余下站点指向我的工号（v7 链站点写
        // 工号；旧名字站点退按名比对）。
        const me = caller.member;
        const mine = caller.team.tasks.filter(
          (t) =>
            t.assignee === me.name ||
            t.chain.some((s, i) => i > t.chainCursor && stationPointsTo(s, me)),
        );
        // 角色/路线读班底行（docs/35 §3#5：人设/路线在班底，task_members=副本行）。
        const template = caller.team.members.find((m) => m.employeeId === me.employeeId);
        // 当前任务口径（docs/36 建议 2；用户迭代 2026-09-11 精简状态集）：
        // start/paused/wait_user 算在办；ready 只是待派发、终态不算当前。
        const current = mine.find((t) => ['start', 'paused', 'wait_user'].includes(t.status));
        const view = {
          member: me.name,
          employeeId: me.employeeId,
          role: template?.role ?? me.name,
          currentTask: current?.id ?? null,
          tasks: mine
            .filter((t) => !args.status || t.status === args.status)
            .map((t) => ({
              id: t.id,
              subject: t.subject,
              status: t.status,
              assignee: t.assignee ?? null,
              station:
                t.chain.length > 0
                  ? {
                      // 末站完成即 completed——完成态按满进度口径显示。
                      done: t.status === 'completed' ? t.chain.length : t.chainCursor + 1,
                      total: t.chain.length,
                      mine: t.chain.findIndex(
                        (s, i) => i > t.chainCursor && stationPointsTo(s, me),
                      ),
                    }
                  : null,
              contract: renderContract(t),
            })),
        };
        return { ok: true as const, view };
      }
      const tasks = caller.team.tasks
        .filter((t) => !args.status || t.status === args.status)
        .map((t) => ({
          ...taskSummary(t),
          dependencies: t.dependencies,
          description: t.description ?? null,
          contractMd: t.contractMd ?? null,
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
        teams: teams.map((t) => ({ id: t.id, name: t.name })),
      };
    },
  });

  const deleteTeamTool = defineTool({
    name: 'eteams_delete_team',
    description: '删除团队的全部状态（不可恢复）。仍有活跃任务（start/paused/wait_user）时会被拒绝。',
    parameters: { teamId: intR('团队 id') },
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
    buildGuideTool,
    buildWaitTool,
    buildDispatchTool,
    captainGuideTool,
    removeMemberTool,
    updateMemberTool,
    submitTaskTool,
    createTaskTool,
    updateTaskTool,
    deleteTaskTool,
    assignTaskTool,
    advanceTaskTool,
    reassignTaskTool,
    escalateTaskTool,
    suspendTaskTool,
    resumeTaskTool,
    cancelTaskTool,
    sendMessageTool,
    teamStatusTool,
    taskBoardTool,
    listTeamsTool,
    deleteTeamTool,
    mailboxTool,
  ];
}
