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
 * @module dsh-eteams/client/pages/board/decisionPanel
 */
import type { ReactNode } from 'react';
import { decidedActionsOf, pendingActionsOf } from '../../features/activity/activityView';
import { relativeTime, type TeamSnapshot } from '../../lib/monitor';
import { Card } from '../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Pill } from '../shared/components';
import { LIST_COUNT_CLASS, LIST_TITLE_CLASS, MUTED_CLASS, PANEL_CARD_CLASS } from '../shared/styles';
import { JumpConversationButton } from './jumpConversationButton';

export function DecisionPanel({ team, now }: { team: TeamSnapshot; now: number }): ReactNode {
  const pending = pendingActionsOf(team);
  const decided = decidedActionsOf(team);
  return (
    <Card className={PANEL_CARD_CLASS}>
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className={LIST_TITLE_CLASS}>决策面板</h3>
      </div>
      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">待决策 ({pending.length})</TabsTrigger>
          <TabsTrigger value="decided">已决策 ({decided.length})</TabsTrigger>
        </TabsList>
        {/* 待决策：需用户处理的可点击项（跳转作答会话）。 */}
        <TabsContent value="pending">
          {pending.length === 0 ? (
            <div className={MUTED_CLASS}>暂无待决策</div>
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
        <TabsContent value="decided">
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
                  <span className={`${LIST_COUNT_CLASS} shrink-0`}>
                    {relativeTime(a.at, now)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Card>
  );
}
