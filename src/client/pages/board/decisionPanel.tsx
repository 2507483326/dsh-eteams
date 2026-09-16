/**
 * 看板「决策面板」卡（用户 2026-09-14「另加一个决策面板吧，将所有需要决策的
 * 放进来」）：把快照里所有需要用户处理的项（待决策 + 待问答）统一成一行一
 * 项，每项带「去回答 / 去处理」钮跳到对应会话。取代原顶部两条 Alert 横幅
 * （横幅只报数、不可点、与动态重复）。数据由 features/activity 的
 * `pendingActionsOf` 投影（纯函数，宿主只暴露原始项）。
 *
 * 二次迭代（用户 2026-09-14「做过决策后，决策面板还是 0，历史的也要显示出来，
 * 加个 tab，区分待决策和已决策」）：卡内分「待决策 / 已决策」两个 tab 页签
 * ——待决策沿用原口径；已决策走 `decidedActionsOf` 历史投影（已处置升级决策 +
 * 已结束问答单，最新在前、最近 30 条），行内展示处置结论/答案摘要与相对时间。
 *
 * 三次迭代（用户 2026-09-15「有新的待决策内容时，对话上面的团队TAB，需要出现
 * 红点提示。直到进入面板看到决策，或者决策被回答」）：本卡是「看到决策」的
 * 唯一判据位——挂在待决策页签且处于前台时，把当下展示出的待决策行记进
 * features/activity/decisionSeen 的已读账本（团队 tab 红点据此收点）。为此
 * Tabs 改受控，仅用于区分「用户真在看待决策」与「停在已决策页签」。
 *
 * 四次迭代（用户 2026-09-15「去掉面板中待决策，已决策外面的灰色背景」）：
 * TabsList 去默认 bg-muted 底盒，选中态改由 trigger 自身承载。
 * 五次迭代（用户 2026-09-15「改回原来左侧，然后灰色背景」）：四次迭代的页签
 * 外观改动整体撤回——恢复默认灰底盒与左贴位（self-start 抵消看板等分布局下
 * Card/Tabs 弹性列对 TabsList 的横向拉伸，详见渲染处注记）。
 *
 * 六次迭代（用户 2026-09-15「都在一行，按照 #任务ID  对话名称  详情 显示」）：
 * 每项由「标题 + 副行」两行收成**一行三列**——`#任务ID` · `对话名称` · `详情`，
 * 两个页签共用 `ActionRow`（列位对齐由同一份类名保证）；对话名称非主对话时
 * 显示提问代理名（用户「不是主对话对话名称显示对应的代理名称」）。三列取值由
 * features/activity 的投影直接给出（列镜像），本组件只做装配。
 *
 * @module dsh-eteams/client/pages/board/decisionPanel
 */
import { useEffect, useState, type ReactNode } from 'react';
import { decidedActionsOf, pendingActionsOf } from '../../features/activity/activityView';
import type { Tone } from '../../features/tasks/taskDisplayStatus';
import { markPendingDecisionsSeen } from '../../features/activity/decisionSeen';
import { relativeTime, type TeamSnapshot } from '../../lib/monitor';
import { Card } from '../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Pill } from '../shared/components';
import {
  BOARD_PANEL_CARD_CLASS,
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
} from '../shared/styles';
import { JumpConversationButton } from './jumpConversationButton';

/** ================================== 一行三列 ================================== */

/** `#任务ID` 列：定宽 + 等宽数字（tabular-nums）——多位数字等宽、跨行对齐。 */
const ID_COL_CLASS = `${LIST_COUNT_CLASS} w-10 shrink-0 tabular-nums`;
/** 对话名称列：限宽截断（代理名可长，`title` 兜底全名——同别处 truncate 纪律）。 */
const CONVERSATION_COL_CLASS = `${LIST_COUNT_CLASS} max-w-[7rem] shrink-0 truncate`;
/** 详情列：吃余宽、单行截断（`title` 兜底全文）。 */
const DETAIL_COL_CLASS = 'min-w-0 flex-1 truncate text-sm text-foreground';

/* 本卡高度口径（用户 2026-09-16「三个面板应该是占满整屏的……使用flex布局，限制
 * 最小高度」+「决策面板 没有最小高度了」+「最小高度太小了，至少300px 然后待决策
 * 中没有数据时，没有待决策的提示也没有看见了」）：与动态卡共用
 * BOARD_PANEL_CARD_CLASS（flex 吃看板余高 + min-h-[300px] 下限）——下限太低时
 * 卡身固定件就吃满整高，空态行（「暂无待决策」）被挤到可视区外，看着既没下限也
 * 丢了空态提示；余高不足时卡先冻在下限，溢出的列表内容由页签内容区的
 * `min-h-0 flex-1 overflow-y-auto` 内滚吸收——内部滚动条优先，不撑出外部滚动条。 */

/**
 * 决策面板一行（待决策 / 已决策共用）：一行三列 = `#任务ID` · `对话名称` ·
 * `详情`（用户 2026-09-15「都在一行」，对话名称非主对话时由投影给提问代理名）。
 * `trailing` 放页签专属收尾件（待决策=跳转钮 / 已决策=相对时间）——两个页签
 * 共用本组件，列位对齐由同一份类名保证。
 */
function ActionRow({
  tone,
  kind,
  taskId,
  conversationName,
  detail,
  trailing,
}: {
  tone: Tone;
  kind: 'decision' | 'ask';
  taskId: number | null;
  conversationName: string;
  detail: string;
  trailing: ReactNode;
}): ReactNode {
  return (
    <div className="flex items-center gap-2.5">
      <Pill tone={tone} className="shrink-0">
        {kind === 'decision' ? '决策' : '问答'}
      </Pill>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {/* 无绑定任务（旧快照缺 mainTaskId / 任务已删）留占位符保住列位。 */}
        <span className={ID_COL_CLASS}>{taskId !== null ? `#${taskId}` : '—'}</span>
        <span className={CONVERSATION_COL_CLASS} title={conversationName}>
          {conversationName}
        </span>
        <span className={DETAIL_COL_CLASS} title={detail}>
          {detail}
        </span>
      </div>
      {trailing}
    </div>
  );
}

export function DecisionPanel({
  team,
  now,
}: {
  team: TeamSnapshot | undefined;
  now: number;
}): ReactNode {
  const pending = pendingActionsOf(team);
  const decided = decidedActionsOf(team);
  // 团队 tab 红点收点（用户 2026-09-15「直到进入面板看到决策」）：把本卡当下
  // 展示出的待决策行记为已读。受控 Tabs 只为这一判据——停在「已决策」页签时
  // 不标记：此刻新到的 pending 行用户并没有看见，红点该继续亮着。effect 随每次
  // 快照重跑（team 每秒都是新引用），markPendingDecisionsSeen 自带幂等短路。
  // 无团队（看板照常渲染，见 boardPage）没有可标记的行，直接跳过。
  const [tab, setTab] = useState('pending');
  useEffect(() => {
    if (tab === 'pending' && team !== undefined) markPendingDecisionsSeen(team);
  }, [tab, team]);
  return (
    // 用户 2026-09-16「三个面板应该是占满整屏的，和团队这种应该是一样的啊，使用
    // flex布局，限制最小高度」+「决策面板 没有最小高度了」+「至少300px 然后待决策
    // 中没有数据时，没有待决策的提示也没有看见了」：本卡与动态卡按 flex 吃满看板
    // 余高（三者合起来占满整屏），并保 300px 的下限——下限要留得下卡身固定件与
    // 空态行/几行列表（口径见 BOARD_PANEL_CARD_CLASS）。标题与页签条固定
    // （shrink-0），故压缩时页签条始终完整可见。
    <Card className={BOARD_PANEL_CARD_CLASS}>
      <div className="mb-2.5 flex shrink-0 items-center gap-2">
        <h3 className={LIST_TITLE_CLASS}>决策面板</h3>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        {/* 页签条恢复原观感（用户 2026-09-15「改回原来左侧，然后灰色背景」）：
        TabsList 默认灰底盒（bg-muted/p-1）+ 选中态默认（active 白底）。看板
        等分布局把 Card 改成 flex 列后，inline-flex 的 TabsList 作为弹性子项被
        横向拉伸满宽、自带 justify-center 把页签推到中间——self-start 令其按
        内容宽度贴左，回到块级时代的原始位置。 */}
        <TabsList className="shrink-0 self-start">
          <TabsTrigger value="pending">待决策 ({pending.length})</TabsTrigger>
          <TabsTrigger value="decided">已决策 ({decided.length})</TabsTrigger>
        </TabsList>
        {/* 待决策：需用户处理的可点击项（跳转作答会话）。 */}
        <TabsContent value="pending" className="min-h-0 flex-1 overflow-y-auto">
          {pending.length === 0 ? (
            <div className={`${MUTED_CLASS} pt-3 text-center`}>暂无待决策</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {pending.map((a) => (
                <ActionRow
                  key={a.key}
                  tone={a.kind === 'decision' ? 'warn' : 'info'}
                  kind={a.kind}
                  taskId={a.taskId}
                  conversationName={a.conversationName}
                  detail={a.detail}
                  trailing={
                    <JumpConversationButton
                      sessionId={a.sessionId}
                      label={a.kind === 'decision' ? '去处理' : '去回答'}
                    />
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>
        {/* 已决策：历史留档（已处置决策 + 已结束问答，最新在前）——行内给处置
        结论/答案摘要 + 相对时间，不再放跳转钮。 */}
        <TabsContent value="decided" className="min-h-0 flex-1 overflow-y-auto">
          {decided.length === 0 ? (
            <div className={`${MUTED_CLASS} pt-3 text-center`}>暂无已决策</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {decided.map((a) => (
                <ActionRow
                  key={a.key}
                  tone={a.outcome}
                  kind={a.kind}
                  taskId={a.taskId}
                  conversationName={a.conversationName}
                  detail={a.detail}
                  trailing={
                    <span className={`${LIST_COUNT_CLASS} shrink-0`}>
                      {relativeTime(a.at, now)}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Card>
  );
}
