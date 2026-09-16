/**
 * 子代理能力缺口工具（eteams_report_gap，v16；docs/subagentCapabilityGap.md）。
 *
 * 全体子代理共用：成员、领队子代理、构建师子代理都在被拒之后走它。注册在根
 * 作用域、不进任何 deny 列表（与 eteams_ask_user 同款处理）——领队也需要报缺口。
 *
 * 它是**唯一入口**：被拒之后「换法子 / 报缺口 / 拒」三种判定都从这里走，
 * 宿主负责确定性预筛（高风险与自判 refuse 拒收、命定常设路线直接按路线走、
 * 同操作去重）。分级口径见下方 description——那是提示词唯一的落点，别改到别处。
 *
 * 注意：`operation.argv` 由上报方填写，宿主**只校验形状**（非空、无换行），
 * 不校验真伪。它比 `summary` 强的地方是「精确、可原样交给执行侧」，不是「可信」。
 *
 * @module dsh-eteams/tools/gapTools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import { ETeamsError, stateRootOf, type RuntimeContext } from '../runtime/base.js';
import {
  applyGapRoute,
  handoffToMain,
  reportGap,
  type GapReportInput,
  type GapReportOutcome,
} from '../runtime/gaps.js';
import { chainIndexOfStation } from '../model/taskMachine.js';
import { readBuildSession } from '../runtime/roleBuilder.js';
import {
  GAP_ROUTES,
  readGapSync,
  type GapDecidedBy,
  type GapOperation,
  type GapRoute,
} from '../state/gaps.js';
import type { TeamState } from '../model/types.js';
import { envForAgent, resolveCaller } from './identity.js';

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

const str = (description: string) => ({ type: 'string' as const, description });
const num = (description: string) => ({ type: 'number' as const, description });
const bool = (description: string) => ({ type: 'boolean' as const, description });

/** 上报者视图（工具层从 resolveCaller 投影；runtime 不反向依赖 tools）。 */
interface GapCallerView {
  teamId: number;
  team?: TeamState;
  askingSessionId: string;
  askingName: string;
  /** 上报者当前在办的任务（成员取 in-flight 任务，构建师为 undefined）。 */
  taskId?: number;
  /** 成员副本行（用于派生执行链站点下标）。 */
  member?: { employeeId: number | null; name: string };
}

/** 校验并归一操作块（argv 是唯一可交给执行侧的字段，形状必须干净）。 */
function normalizeOperation(raw: unknown): GapOperation {
  if (raw === null || typeof raw !== 'object') {
    throw new ETeamsError('operation 必须是对象', '形如 { summary, argv, cwd, reason }');
  }
  const o = raw as Record<string, unknown>;
  const summary = typeof o['summary'] === 'string' ? o['summary'].trim() : '';
  if (summary === '') throw new ETeamsError('operation.summary 必填（一句话说明想做什么）');
  const cwd = typeof o['cwd'] === 'string' ? o['cwd'].trim() : '';
  if (cwd === '') throw new ETeamsError('operation.cwd 必填（执行时的工作目录）');
  if (!Array.isArray(o['argv'])) {
    throw new ETeamsError('operation.argv 必填（精确命令，字符串数组）');
  }
  const argv = o['argv'].filter((a): a is string => typeof a === 'string').map((a) => a.trim());
  if (argv.length === 0 || argv.some((a) => a === '')) {
    throw new ETeamsError('operation.argv 必须是非空字符串数组，且不得含空项');
  }
  if (argv.some((a) => a.includes('\n') || a.includes('\r') || a.includes('\u0000'))) {
    throw new ETeamsError('operation.argv 的每一项都不得含换行或 NUL（它要原样交给执行侧）');
  }
  const reason = typeof o['reason'] === 'string' ? o['reason'].trim() : '';
  if (reason === '') {
    throw new ETeamsError('operation.reason 必填（拒绝来源：approval / sandbox / tool）');
  }
  const writes = Array.isArray(o['writes'])
    ? o['writes'].filter((w): w is string => typeof w === 'string')
    : [];
  return {
    summary,
    argv,
    cwd,
    ...(writes.length > 0 ? { writes } : {}),
    reason,
  };
}

/** 路线枚举校验（未知值原样拒收，避免落库出脏词）。 */
function normalizeRoute(raw: unknown, field: string): GapRoute | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !GAP_ROUTES.includes(raw as GapRoute)) {
    throw new ETeamsError(
      `${field} 只接受 ${GAP_ROUTES.join(' / ')}`,
      '拿不准就省略，由领队决定路线',
    );
  }
  return raw as GapRoute;
}

/** 缺口的去向指引（模型可见正文——必须进 render，规范值不回放）。 */
function hintOf(outcome: GapReportOutcome, next: string | undefined): string {
  switch (outcome.kind) {
    case 'self-resolvable':
      return [
        `判定：可自解。按你申报的替代做法继续${next !== undefined ? `（${next}）` : ''}。`,
        '不要重试原做法，也不要为它再问任何人；把这次自解用 eteams_append_progress 记一笔。',
      ].join('\n');
    case 'refused':
      return [
        `判定：拒绝（${outcome.reason}）。`,
        '不要执行、不要换写法绕过、不要请人授权。用 eteams_fail_task 把风险与已试方案写清楚后停止。',
      ].join('\n');
    case 'known-route':
      return [
        `判定：本类操作已有常设路线「${outcome.route}」——按路线转交，**不要自己重试**。`,
        '（路线是「这类活儿由谁干」的既定安排，不是给你的放行条。）',
      ].join('\n');
    case 'deduped':
      return `判定：这条缺口已经报过了（gapId=${outcome.gapId}）——不要重复上报，等领队按那条处置。`;
    case 'reported':
      return [
        `已上报（gapId=${outcome.gapId}）。`,
        '接着用 eteams_send_message to="captain" 把 gapId 与一句话摘要发给领队（唤醒他处置），',
        '然后**停下这一条路**等路线决定——不要重试原做法，也不要用别的写法硬绕。',
      ].join('\n');
  }
}

/**
 * 定下路线之后的下一步（模型可见正文）。每条对应「谁去干」的一个具体动作——
 * 领队看完就知道下一句该发什么，不需要自己去推理限制在哪里。
 *
 * **`main-executes` 不在这里**：那条的下一步由宿主**自动执行**（P2 交付动作），
 * 指引按投递成败现算（见 execute 里的分支），不靠这份静态文案。
 */
const NEXT_ACTION: Record<Exclude<GapRoute, 'main-executes'>, string> = {
  'widen-and-redelegate':
    '先请用户放宽父会话范围（这一步只有用户能做），随后**重新委派**这一站——已存在的成员子会话不会追溯生效，必须重派。',
  'split-stage':
    '把这一站交给有权限的一侧：改执行链卡槽后按链重派，或并入主会话执行；不要让它继续在受限的子会话里循环。',
};

/**
 * Build the two gap tools:
 * - `eteams_report_gap` —— 上报。根作用域注册、**不进任何 deny 列表**，全体子代理
 *   （成员 / 领队子代理 / 构建师子代理）被拒之后都走它。
 * - `eteams_route_gap` —— 处置。也在根作用域注册，但**加进 MEMBER_DENIED_TOOLS**，
 *   成员在 spawn 时被拒见（「成员不能给自己定路线」的可见性纪律）；执行体另有
 *   `resolveCaller` 门禁，两道都拦。
 */
export function createGapTools(
  config: ETeamsResolvedConfig,
  hostCtx: Context,
): ReturnType<typeof defineTool>[] {
  const runtime = hostCtx as unknown as RuntimeContext;

  const reportGapTool = defineTool({
    name: 'eteams_report_gap',
    description:
      '被拒绝、被拦住之后走这里——**唯一入口**，三种判定都从这里过，由宿主做确定性预筛（高风险与自判 refuse 一律拒收；本类操作已有常设路线就直接按路线走；同任务同操作已有 open 缺口就去重）。\n' +
      '什么时候用：一次工具调用被拒（沙箱越界 / 审批拒绝 / 环境拦住），而这件事**换做法也过不去**时。\n' +
      '\n' +
      '先自问属于哪一类（verdict，按优先级）：\n' +
      '1. refuse —— 该操作要把当前信任边界内的数据送出去（外发、上传、写凭据、绕过安全机制）。这一类**永远不升级**：直接报 refuse，宿主会让你 eteams_fail_task 收尾。\n' +
      '2. self-resolvable —— 拒绝的原因是**做法**，换一个等价或更保守的做法就能达成同一目标，且不需要任何额外权限。例：用 head 代替 cat；用 --noEmit 只做类型检查代替完整构建；写进工作区内允许的目录代替写系统目录。**必须填 next** 写清换成什么。「换法子」不等于「重试同样的事」。\n' +
      '3. report-gap —— 换做法也过不去：需要超出当前范围的能力（越出工作区根的写入、需要网络、执行了被禁止的命令类别），或拒绝来源是策略而不是做法。**必须填 why** 挂到具体哪条验收标准上（挂不上说明这事可能不该做）。\n' +
      '\n' +
      '要点：\n' +
      '- operation.argv 填**精确命令**（字符串数组，如 ["npm","run","build"]），它与 cwd 是唯一会被原样交给执行侧的字段——summary 只是给人读的说明。\n' +
      '- tried 填你已经试过、确实不行的替代做法（不是打算试的）。\n' +
      '- suggestedRoute 只是你的建议，领队/用户可推翻；拿不准就省略：main-executes（一次性，请有权限的一侧代跑）/ widen-and-redelegate（本站整体需要该能力，且可整体重跑）/ split-stage（该能力会被反复用到，如构建测试，应把这一站整体交给有权限的一侧）。\n' +
      '- **不要为单次操作反复问许可**：报一次，等路线；超时/无解才用 eteams_fail_task。',
    parameters: {
      verdict: {
        type: 'string' as const,
        required: true as const,
        description:
          '你的判定：refuse（外发/凭据类，永不升级）/ self-resolvable（换做法能过，必须填 next）/ report-gap（换做法也过不去，必须填 why）',
      },
      risk: {
        type: 'string' as const,
        required: true as const,
        description:
          '风险分级：medium（需要额外的能力或范围）/ high（涉及把信任边界内的数据送出去——宿主一律拒收，不落表不升级）',
      },
      operation: {
        type: 'object' as const,
        required: true as const,
        description: '被拒的那次操作（argv 与 cwd 会被原样交给执行侧）',
        properties: {
          summary: str('一句话说明想做什么（给人读）'),
          argv: {
            type: 'array' as const,
            required: true as const,
            description: '精确命令（如 ["npm","run","build"]）；不得含换行',
            items: { type: 'string' as const },
          },
          cwd: str('执行时的工作目录（绝对路径）'),
          reason: str('拒绝来源标记：approval / sandbox / tool'),
          writes: {
            type: 'array' as const,
            description: '预期副作用（可选，参考用，不作授权依据）',
            items: { type: 'string' as const },
          },
        },
        additionalProperties: false,
      },
      why: str('verdict=report-gap 时必填：挂到哪条验收标准上（挂不上说明这事可能不该做）'),
      next: str('verdict=self-resolvable 时必填：换成什么做法（具体到命令或改法）'),
      tried: {
        type: 'array' as const,
        description: '已经试过、确实不行的替代做法（不是打算试的）',
        items: { type: 'string' as const },
      },
      suggestedRoute: str(`路线建议（可省）：${GAP_ROUTES.join(' / ')}——只是建议，领队/用户可推翻`),
      taskId: num('相关任务号（可省：默认取你当前在办的任务）'),
      attemptId: num('相关尝试号（可省）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: { type: 'boolean' as const, description: '是否成功受理' },
          mode: str('结局：self-resolvable / refused / known-route / deduped / reported'),
          gapId: str('缺口 ID（reported / deduped 时存在）'),
          route: str('命中或采纳的路线（known-route 时存在）'),
          hint: str('下一步指引（正文）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => {
        // 指引必须进 render：model-facing content 就是 render 的输出。
        return text(v.hint ?? '缺口已受理');
      },
    },
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `能力缺口 · ${typeof args.verdict === 'string' ? args.verdict : '?'}`,
    }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined;
      return { card: 'generic' as const, title: '缺口已受理（细节见工具结果）', content: [] };
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      if (!exec.agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
      const askingSessionId = String(exec.agent.id ?? '');

      // 入参校验（先做，避免带着坏载荷去解析身份）
      const verdict = args.verdict;
      if (verdict !== 'self-resolvable' && verdict !== 'report-gap' && verdict !== 'refuse') {
        throw new ETeamsError(
          'verdict 只接受 refuse / self-resolvable / report-gap',
          '拿不准时按 report-gap 处理（不确定必须上报，不要自判可自解）',
        );
      }
      const risk = args.risk === 'high' ? 'high' : 'medium';
      const operation = normalizeOperation(args.operation);
      const why = typeof args.why === 'string' ? args.why.trim() : '';
      const next = typeof args.next === 'string' ? args.next.trim() : '';
      if (verdict === 'report-gap' && why === '') {
        throw new ETeamsError(
          'report-gap 必须填 why：挂到具体哪条验收标准上',
          '挂不上验收标准说明这事可能不该做——那就别报缺口',
        );
      }
      if (verdict === 'self-resolvable' && next === '') {
        throw new ETeamsError(
          'self-resolvable 必须填 next：换成什么做法',
          '「换法子」不等于「重试同样的事」——说不出换成什么就别自判可自解',
        );
      }
      const suggestedRoute = normalizeRoute(args.suggestedRoute, 'suggestedRoute');
      const tried = Array.isArray(args.tried)
        ? args.tried.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        : [];

      // 身份解析：先按团队身份（成员/领队）；构建师子代理不在任何团队会抛
      // ——此时按构建会话判定（builderChildId 严格相等），两者皆非原样抛错。
      // 两支都赋值（catch 里非构建师即 rethrow），故不设初值。
      let view: GapCallerView;
      try {
        const caller = await resolveCaller(env, exec.agent);
        if (caller.kind === 'member') {
          // 在办任务优先（缺口挂的是「哪张卡的验收标准」），退到任务锚。
          const current = caller.member.nowTaskId ?? caller.member.mainTaskId;
          view = {
            teamId: caller.team.id,
            team: caller.team,
            askingSessionId,
            askingName: caller.member.name,
            ...(current !== null ? { taskId: current } : {}),
            member: caller.member,
          };
        } else {
          view = {
            teamId: caller.team.id,
            team: caller.team,
            askingSessionId,
            askingName: '领队',
          };
        }
      } catch (error) {
        const root = stateRootOf(env);
        const buildSession = readBuildSession(root);
        if (
          buildSession?.builderChildId !== undefined &&
          buildSession.builderChildId === askingSessionId
        ) {
          view = { teamId: 0, askingSessionId, askingName: '角色构建师' };
        } else {
          throw error;
        }
      }

      // 站点下标由宿主派生（成员在链上按工号/名找），不让上报方自报。
      const taskId = typeof args.taskId === 'number' ? args.taskId : view.taskId;
      let stationIndex: number | undefined;
      if (taskId !== undefined && view.team !== undefined && view.member !== undefined) {
        const task = view.team.tasks.find((t) => t.id === taskId);
        if (task !== undefined) {
          stationIndex = chainIndexOfStation(task.chain, view.member);
        }
      }

      const input: GapReportInput = {
        teamId: view.teamId,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(typeof args.attemptId === 'number' ? { attemptId: args.attemptId } : {}),
        ...(stationIndex !== undefined ? { stationIndex } : {}),
        askingSessionId,
        askingName: view.askingName,
        risk,
        verdict,
        operation,
        why,
        ...(tried.length > 0 ? { tried } : {}),
        ...(suggestedRoute !== undefined ? { suggestedRoute } : {}),
      };
      const outcome = reportGap(env, input);
      return {
        ok: true as const,
        mode: outcome.kind,
        ...(outcome.kind === 'reported' || outcome.kind === 'deduped'
          ? { gapId: outcome.gapId }
          : {}),
        ...(outcome.kind === 'known-route' ? { route: outcome.route } : {}),
        hint: hintOf(outcome, next !== '' ? next : undefined),
      };
    },
  });

  /**
   * 处置一条能力缺口（**领队面**，成员在 spawn 时被 MEMBER_DENIED_TOOLS 拒见）。
   * 定路线 + 可选沉淀常设路线；两件事同一事务落（见 runtime/gaps.applyGapRoute）。
   */
  const routeGapTool = defineTool({
    name: 'eteams_route_gap',
    description:
      '处置一条能力缺口：定下**路线**（这类活儿由谁干），并可选把「以后这类都这么办」沉淀成常设路线。成员报缺口之后由你（领队）处置——成员不能自己给自己定路线。\n' +
      '\n' +
      '三条路线：\n' +
      '- main-executes —— 一次性操作、做完就好：宿主会**自动**把「来源 + 精确 argv/cwd」交给主会话，由它主动执行（交付不成会告诉你改手动）。**不要自己去跑**（你在同样的限制里），也不要让成员重试。\n' +
      '- widen-and-redelegate —— 这一站整体需要该能力，且可以整体重跑：先请用户放宽父会话范围（这一步只有用户能做），随后重新委派这一站。注意：**已存在的成员子会话不会追溯生效**（策略在委派时钉死），所以必须重派、不要指望原会话自愈。\n' +
      '- split-stage —— 该能力会被反复用到（构建 / 测试 / 部署这类**循环**）：把这一站整体交给有权限的一侧（改执行链卡槽后按链重派，或并入主会话执行）。**循环型工作一律走这条**——逐次代执行的往返成本会吃掉收益。\n' +
      '\n' +
      'memoize=true 把这次决定沉淀成常设路线（同类操作以后直接按它转交、不再升级）。**它沉淀的是路由，不是权限**——不会让任何子代理获得它本来没有的能力。危险操作（refuse 档）不要 memoize。\n' +
      '\n' +
      'decidedBy 填 captain（你自己判断的）或 user（你问过用户、这是他的拍板）——它只作审计标签。\n' +
      '路线本身只有用户能定时，用 eteams_ask_user 问清再回来调本工具。',
    parameters: {
      gapId: str('缺口 ID（eteams_report_gap 返回的那个，或面板上的）'),
      route: {
        type: 'string' as const,
        required: true as const,
        description: `路线：${GAP_ROUTES.join(' / ')}`,
      },
      decidedBy: str('谁定的：captain（你自己）/ user（用户拍板）；缺省 captain'),
      note: str('决定理由 / 用户原话（可省，会留在缺口上供回溯）'),
      memoize: bool('true = 沉淀成常设路线（同类操作以后按它转交、不再升级）；危险操作不要开'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功受理'),
          mode: str('结局：routed / already-decided'),
          gapId: str('缺口 ID'),
          route: str('已定下的路线'),
          memoId: num('沉淀出的常设路线号（开了 memoize 且写下时存在）'),
          handoff: bool('main-executes 时：操作是否已自动交付给主会话（false=需你手动交付）'),
          hint: str('下一步指引（正文）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.hint ?? '缺口已处置'),
    },
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `处置能力缺口 · ${typeof args.route === 'string' ? args.route : '?'}`,
    }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined;
      return { card: 'generic' as const, title: '缺口已处置（细节见工具结果）', content: [] };
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      if (!exec.agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
      const gapId = typeof args.gapId === 'string' ? args.gapId.trim() : '';
      if (gapId === '') throw new ETeamsError('gapId 必填');
      const route = normalizeRoute(args.route, 'route');
      if (route === undefined) {
        throw new ETeamsError(
          `route 必填，只接受 ${GAP_ROUTES.join(' / ')}`,
          '拿不准就选 split-stage（循环型工作）或先问用户',
        );
      }
      const decidedBy: GapDecidedBy = args.decidedBy === 'user' ? 'user' : 'captain';
      const note =
        typeof args.note === 'string' && args.note.trim() !== '' ? args.note.trim() : undefined;

      // 身份门禁：只有领队能处置（成员不能给自己定路线）。
      const caller = await resolveCaller(env, exec.agent);
      if (caller.kind !== 'captain') {
        throw new ETeamsError(
          '只有领队能处置能力缺口',
          '成员报缺口（eteams_report_gap）后等领队定路线——不要自己给自己定',
        );
      }

      const stateRoot = stateRootOf(env);
      const gap = readGapSync(stateRoot, gapId);
      if (gap === undefined) {
        throw new ETeamsError(`能力缺口 ${gapId} 不存在`, '核对 gapId（面板上可见）后重试');
      }
      // 跨团队守卫：单库多团队共用一个状态根，按 gapId 读得到的别人家缺口必须挡掉。
      if (gap.teamId !== caller.team.id) {
        throw new ETeamsError('这条缺口不属于你的团队', '缺口只能由它所属团队的领队处置');
      }
      if (gap.status !== 'open') {
        return {
          ok: true as const,
          mode: 'already-decided' as const,
          gapId,
          ...(gap.route !== undefined ? { route: gap.route } : {}),
          hint: [
            `这条缺口已经被处置过了（status=${gap.status}${gap.decidedBy !== undefined ? `，by ${gap.decidedBy}` : ''}）——不要重复处置。`,
            '按既有路线走，或去看板「能力缺口」核对。',
          ].join('\n'),
        };
      }

      const applied = applyGapRoute(env, {
        gapId,
        route,
        decidedBy,
        ...(note !== undefined ? { note } : {}),
        ...(args.memoize === true ? { memoize: true } : {}),
      });
      if (!applied.won) {
        // 读到 open 但写入时已被人处置（领队自定 vs 用户作答的竞态）。
        return {
          ok: true as const,
          mode: 'already-decided' as const,
          gapId,
          hint: '这条缺口刚被另一方处置了——按已定的路线走，不要重复处置。',
        };
      }

      // P2 交付动作：main-executes 的含义就是「交给有权限的一侧」——由宿主把
      // 「来源 + 精确 argv/cwd」自动发给主会话（子 → 父相邻投递），领队不必手写
      // 消息。交付失败只降级（路线已落库），指引里告诉领队改手动。
      let next: string;
      let handoffDelivered: boolean | undefined;
      if (route === 'main-executes') {
        const handoff = await handoffToMain(
          runtime.subagents,
          exec.agent,
          caller.team,
          gap,
          env.signal,
        );
        handoffDelivered = handoff.delivered;
        if (handoff.delivered) {
          next = `**已自动把这条操作交给主会话**（会话 ${handoff.targetSessionId ?? '?'}）——它会主动执行；你不要自己去跑，也不要让成员重试。`;
        } else {
          env.ctx.logger.warn(
            `eteams: 缺口 ${gapId} 的 main-executes 交付未送达（${handoff.reason ?? '未知原因'}）——改由领队手动交付`,
          );
          next = `**需要你手动交付**（自动交付未成：${handoff.reason ?? '未知原因'}）：把「来源 + 精确 argv/cwd」用 eteams_send_message 发给主会话，由它主动执行。`;
        }
      } else {
        next = NEXT_ACTION[route];
      }

      return {
        ok: true as const,
        mode: 'routed' as const,
        gapId,
        route,
        ...(applied.memoId !== undefined ? { memoId: applied.memoId } : {}),
        ...(handoffDelivered !== undefined ? { handoff: handoffDelivered } : {}),
        hint: [
          `已定路线「${route}」。下一步：${next}`,
          args.memoize === true
            ? applied.memoId !== undefined
              ? '已沉淀常设路线：同类操作以后直接按它转交，不再升级。'
              : '（memoize 已开，但这条缺口的 argv 无法归一成路线键，未沉淀。）'
            : '未沉淀常设路线：同类操作下次还会来问——同类反复出现时考虑 memoize=true。',
        ].join('\n'),
      };
    },
  });

  return [reportGapTool, routeGapTool];
}
