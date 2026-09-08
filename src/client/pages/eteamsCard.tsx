/**
 * The ETeams conversation card (docs/13.2): folds from the
 * `eteams_create_team` tool call/result pair in the session log via the
 * client-runtime Conversation Node mechanism, then renders live progress
 * from the polled activity snapshots (matching by teamId from the tool
 * result, falling back to the team name).
 *
 * S5 试点迁移（docs/21-client-ui-stack.md 21.6 / D19d/D19g）：inline style
 * 全部迁到 Tailwind 类 + shadcn 基础组件（Card/Badge/Button）。管线纪律的
 * 落地注记（后续表面迁移 S11+ 照此模式）：
 * - D19b 作用域机制：`important: '.eteams-ui'` 把工具类编译成后代选择器
 *   （`.eteams-ui .utility`）——作用域根元素自身不承样式，只承载 token 变量
 *   与 `eteams-ui` 字面量。故表面根是裸 div（挂 `.eteams-ui`），Card 作为
 *   其后代承载全部样式；Card 根 className 同样带 `eteams-ui` 字面量（对
 *   content 扫描与 D19b「表面根挂类」双保险）。
 * - preflight 已关（D19b）：`border` 工具类只产 border-width，border-style
 *   初始值 none——用标准 `border-solid` 工具类补齐（S3 桥只补了默认色）。
 * - D19c：token 色禁 /alpha 修饰——待决策徽标的半透明 warning 边框沿用 S4
 *   badge/button 先例的 color-mix() 任意值；类名一律完整字面量（21.5.1
 *   content 扫描纪律，禁拼接）。
 * 行为与降级路径（installCard 的 events 判空、parse 函数群、
 * activateETeamsTab）与迁移前逐字一致。docs/35 §5：goal 随建队审批重构砍掉
 * （create 工具参数只剩 {name, questionnaire?}），徽标改任务进度文案。
 *
 * M6 结构性改造（docs/44 44.3，行为零变更）：44.3 横幅分区（类型 → 常量与
 * 映射表（Node 定义）→ 工具函数（parse/install）→ 子组件 → 主组件）。头像
 * 栈 slice(0, 8) 密度已随 M7-7 收口 components/avatarStack.tsx（teamTab +N /
 * 本件 slice 8 / teamsButton chip——chip 是单字圆牌非头像栈，M7 验收注记：
 * 不在收口范围），本件密度走 props。
 *
 * @module dsh-eteams/client/card
 */
import { type ReactNode } from 'react';
import { Provider } from 'react-redux';
import type { Context } from '@deepseek-ai/cordis';
import { AvatarStack } from '../components/avatarStack';
import { activateETeamsTab } from '../lib/bridge';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Progress } from '../components/ui/progress';
import { ClientErrorBoundary } from '../lib/diagnostics';
import { useActivityState, type TeamSnapshot } from '../lib/monitor';
import { getApp } from '../store/app';

/** ================================== 类型 ================================== */

/** Card state folded from the create-team tool events. */
interface CardState {
  name: string;
  teamId: string | null;
  accepted: boolean;
}

/** Structural view of the Session events the definition matches. */
interface SessionEventLike {
  type: string;
  data: Record<string, unknown>;
}

/** Structural view of a tool-result content block. */
interface ToolResultBlock {
  type: string;
  text?: string;
  isError?: boolean;
}

/** ================================== 常量与映射表 ================================== */

/** Conversation Node definition: create-tool call/result → card node. */
const eteamsCardDefinition = {
  kind: 'eteams',
  target: 'chat',
  match(event: SessionEventLike): { id: string; role: 'start' | 'update' } | null {
    if (event.type === 'tool/call' && event.data.name === 'eteams_create_team') {
      return parseCreateArgs(event.data.arguments) === undefined
        ? null
        : { id: String(event.data.callId), role: 'start' };
    }
    if (event.type === 'tool/result') {
      const source = (
        event.data.message as { source?: { kind?: string; callId?: unknown } } | undefined
      )?.source;
      if (source?.kind === 'tool') return { id: String(source.callId), role: 'update' };
    }
    return null;
  },
  start(_context: unknown, match: { event: SessionEventLike }): CardState {
    const parsed = parseCreateArgs(match.event.data.arguments);
    if (parsed === undefined) throw new Error('eteams card start requires valid create arguments');
    return { ...parsed, teamId: null, accepted: false };
  },
  update(context: { state: CardState }, match: { event: SessionEventLike }): CardState {
    if (match.event.type !== 'tool/result') return context.state;
    const data = match.event.data as { error?: unknown; message?: { content?: unknown } };
    if (data.error !== undefined) return context.state;
    const content = data.message?.content;
    const errored =
      Array.isArray(content) &&
      (content as ToolResultBlock[]).some((b) => b.type === 'tool-result' && b.isError === true);
    if (errored) return context.state;
    const teamId = parseTeamIdFromResult(content);
    return { ...context.state, accepted: true, teamId: teamId ?? context.state.teamId };
  },
  buildViewNode(context: {
    key: string;
    id: string;
    start?: { event: { seq: number }; location: unknown };
    state?: CardState;
  }): {
    key: string;
    kind: string;
    id: string;
    target: string;
    anchorSeq: number;
    location: unknown;
    visibility: 'visible';
    data: Record<string, unknown>;
  } | null {
    if (context.start === undefined || context.state === undefined) return null;
    if (!context.state.accepted) return null;
    return {
      key: context.key,
      kind: 'eteams',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: {
        teamId: context.state.teamId,
        teamName: context.state.name,
      },
    };
  },
};

/** ================================== 工具函数 ================================== */

/** docs/35 §5#1：create 工具参数只剩 {name, questionnaire?}——只要 name。
 * 不带 name 的调用（老版本/异常载荷）不渲染卡片。 */
function parseCreateArgs(raw: unknown): { name: string } | undefined {
  try {
    const args =
      typeof raw === 'string'
        ? (JSON.parse(raw) as Record<string, unknown>)
        : (raw as Record<string, unknown>);
    if (typeof args.name === 'string') return { name: args.name };
  } catch {
    // unparseable arguments: no card
  }
  return undefined;
}

function parseTeamIdFromResult(blocks: unknown): string | null {
  for (const block of (Array.isArray(blocks) ? blocks : []) as ToolResultBlock[]) {
    if (block.type !== 'tool-result' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text) as { teamId?: unknown };
      // docs/27：库内整数 id（数字）——客户端口径归一 string。
      if (typeof parsed.teamId === 'number') return String(parsed.teamId);
      if (typeof parsed.teamId === 'string') return parsed.teamId;
    } catch {
      // not our JSON payload
    }
  }
  return null;
}

function findTeam(
  state: { teams: TeamSnapshot[] },
  data: { teamId: string | null; teamName: string },
): TeamSnapshot | undefined {
  if (data.teamId !== null) return state.teams.find((t) => t.teamId === data.teamId);
  return state.teams.find((t) => t.name === data.teamName);
}

/**
 * Register the card definition and its chat-node renderer seat. The
 * `conversationEvents` service is optional: when the running client runtime
 * does not provide it, only the card degrades — tab and button stay up.
 * @param ctx - client root context (cordis).
 */
export function installCard(ctx: Context): void {
  const events = (
    ctx as unknown as { conversationEvents?: { register: (d: unknown) => () => void } }
  ).conversationEvents;
  if (typeof events?.register !== 'function') return;
  events.register(eteamsCardDefinition);
  (
    ctx as unknown as {
      slots: {
        inject: (n: string, f: () => unknown) => void;
        register: (d: Record<string, unknown>, c: unknown) => unknown;
      };
    }
  ).slots.inject('conversation.chat.node', () =>
    (
      ctx as unknown as { slots: { register: (d: Record<string, unknown>, c: unknown) => unknown } }
    ).slots.register({ name: 'conversation.chat.node', key: 'eteams' }, ETeamsCard),
  );
}

/** ================================== 子组件 ================================== */

/** Card body — mounted inside the Provider (see {@link ETeamsCard}). */
function ETeamsCardBody({ node }: { node: { data: unknown } }): ReactNode {
  const state = useActivityState();
  const data = node.data as { teamId: string | null; teamName: string };
  const team = findTeam(state, data);
  return (
    /* 表面根（D19b）：.eteams-ui 作用域根，工具类经后代选择器作用于子树。 */
    <div className="eteams-ui">
      <Card className="eteams-ui my-2 border-solid px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* S24-2（D22f）：标题 emoji 清零——官网标题纯文字；14px bold → 官网
              小标题签名 text-sm semibold tracking-tight。 */}
          <strong className="text-sm font-semibold tracking-tight text-foreground">
            {data.teamName}
          </strong>
          <Badge
            variant="outline"
            className="rounded-full border-solid px-2 py-px text-xs font-normal"
          >
            {team !== undefined
              ? `${team.progress.completed}/${team.progress.total} 完成`
              : '连接中…'}
          </Badge>
          {team !== undefined && team.pendingDecisions.length > 0 && (
            <Badge
              variant="outline"
              className="rounded-full border-solid border-[color:color-mix(in_srgb,var(--warning)_40%,transparent)] px-2 py-px text-xs font-normal text-warning"
            >
              {team.pendingDecisions.length} 项待决策
            </Badge>
          )}
          {team !== undefined && team.pendingAsks.length > 0 && (
            <Badge
              variant="outline"
              className="rounded-full border-solid border-[color:color-mix(in_srgb,var(--warning)_40%,transparent)] px-2 py-px text-xs font-normal text-warning"
            >
              {team.pendingAsks.length} 项待问答
            </Badge>
          )}
        </div>
        {team !== undefined ? (
          <>
            <div className="mb-1 mt-2 flex items-center">
              {/* 人数/头像含领队（用户迭代 2026-09 六：领队也算成员，初始化
              默认在团；移出后只剩成员）——与团队页、添加弹窗同一口径。
              （M7-7 收口 components/avatarStack：本件密度 = slice(0, 8)、
              -mr-1.5 重叠、title 带「 · 领队/状态」尾注；人数行在栈外原位。） */}
              <AvatarStack
                people={team.leaderRemoved ? team.members : [team.captain, ...team.members]}
                size={26}
                max={8}
                wrapperClass="-mr-1.5"
                titleOf={(m) => `${m.name}${'status' in m ? ` · ${m.status}` : ' · 领队'}`}
              />
              <span className="ml-3 text-xs text-muted-foreground">
                {team.members.length + (team.leaderRemoved ? 0 : 1)} 人
              </span>
            </div>
            {/* docs/23 S23-5：进度条迁 shadcn Progress（原手写 track/fill 双 div；
                R1-F5 注记见下——填充色 bg-primary 经 D21a 即 DSW 蓝）。
                R1-F5：进度条填充要实心品牌色——--accent 改映射 interactive
                淡底后（原首跳死映射恒落 brand-primary），这里改 bg-primary，
                渲染色不变（--accent 原本就恒等于 brand-primary）。
                docs/23 D21a：--primary 已改桥 button-info-fill——本条随之呈现
                DSW 蓝（宿主内与主按钮同源）。 */}
            <Progress
              className="h-[5px]"
              value={
                team.progress.total === 0
                  ? 0
                  : (team.progress.completed / team.progress.total) * 100
              }
            />
            <div className="my-1.5 text-xs text-muted-foreground">
              {team.progress.completed}/{team.progress.total} 完成
              {team.latestEvents.at(-1) !== undefined ? ` · ${team.latestEvents.at(-1)!.text}` : ''}
            </div>
          </>
        ) : (
          <div className="my-1.5 text-xs text-muted-foreground">等待面板同步…</div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-solid"
          onClick={() => {
            activateETeamsTab();
          }}
        >
          打开面板
        </Button>
      </Card>
    </div>
  );
}

/** ================================== 主组件 ================================== */

/**
 * The in-transcript card renderer (live via polled snapshots).
 * R2-F2（docs/21 21.5.3）：表面根包 Provider——本组件自身的 hook 调用
 * （useActivityState → useSelector）必须在 Provider 子树内，故拆为
 * 「包装层（错误边界 + Provider）+ 内体（hook 消费 + 表面根）」两层；
 * 单例 store，多 Provider 同 store 无害。
 */
export function ETeamsCard({ node }: { node: { data: unknown } }): ReactNode {
  return (
    <ClientErrorBoundary label="团队卡片">
      <Provider store={getApp().store}>
        <ETeamsCardBody node={node} />
      </Provider>
    </ClientErrorBoundary>
  );
}
