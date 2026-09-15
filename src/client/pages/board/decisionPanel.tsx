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
 * @module dsh-eteams/client/pages/board/decisionPanel
 */
import { useEffect, useState, type ReactNode } from 'react';
import { decidedActionsOf, pendingActionsOf } from '../../features/activity/activityView';
import { markPendingDecisionsSeen } from '../../features/activity/decisionSeen';
import { relativeTime, type TeamSnapshot } from '../../lib/monitor';
import { Card } from '../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Pill } from '../shared/components';
import {
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
} from '../shared/styles';
import { JumpConversationButton } from './jumpConversationButton';

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
    // 看板等分布局（用户 2026-09-15）：卡成弹性列吃 1/2 余高——标题与页签
    // 条固定（shrink-0），列表区 flex-1 min-h-0 + 内滚（外层看板根定高，
    // 卡内溢出不再撑出页面滚动条）。
    <Card className={`flex min-h-0 flex-1 flex-col ${PANEL_CARD_CLASS}`}>
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
            <div className={`${MUTED_CLASS} text-center`}>暂无待决策</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {pending.map((a) => (
                <div key={a.key} className="flex items-center gap-2.5">
                  <Pill tone={a.kind === 'decision' ? 'warn' : 'info'} className="shrink-0">
                    {a.kind === 'decision' ? '决策' : '问答'}
                  </Pill>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground" title={a.title}>
                      {a.title}
                    </div>
                    {(a.detail !== '' || a.isMainSession) && (
                      <div className={MUTED_CLASS}>
                        {a.isMainSession ? '主对话' : ''}
                        {a.isMainSession && a.detail !== '' ? ' · ' : ''}
                        {a.detail}
                      </div>
                    )}
                  </div>
                  <JumpConversationButton
                    sessionId={a.sessionId}
                    label={a.kind === 'decision' ? '去处理' : '去回答'}
                  />
                </div>
              ))}
            </div>
          )}
        </TabsContent>
        {/* 已决策：历史留档（已处置决策 + 已结束问答，最新在前）——行内给处置
        结论/答案摘要 + 相对时间，不再放跳转钮。 */}
        <TabsContent value="decided" className="min-h-0 flex-1 overflow-y-auto">
          {decided.length === 0 ? (
            <div className={MUTED_CLASS}>暂无已决策</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {decided.map((a) => (
                <div key={a.key} className="flex items-center gap-2.5">
                  <Pill tone={a.outcome} className="shrink-0">
                    {a.kind === 'decision' ? '决策' : '问答'}
                  </Pill>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground" title={a.title}>
                      {a.title}
                    </div>
                    {a.detail !== '' && <div className={MUTED_CLASS}>{a.detail}</div>}
                  </div>
                  <span className={`${LIST_COUNT_CLASS} shrink-0`}>{relativeTime(a.at, now)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Card>
  );
}
