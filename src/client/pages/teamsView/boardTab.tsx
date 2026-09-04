/**
 * 看板 tab：目标、进度与最近动态（docs/13.3 看板）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 依赖 usageCalendar（Token 消耗卡）与 shared（页内跨 tab 共享层）。
 *
 * @module dsh-eteams/client/pages/teamsView/boardTab
 */
import { useState, type ReactNode } from 'react';
import { approveTeamPlan } from '../../lib/api';
import { refreshActivitySoon, relativeTime, type TeamSnapshot } from '../../lib/monitor';
import { PHASE_LABELS } from '../../lib/phaseLabels';
import { cn } from '../../lib/cn';
import { Alert } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Progress } from '../../components/ui/progress';
import { UsageCalendarCard } from './usageCalendar';
import {
  EMPTY_CLASS,
  FormErrorNote,
  LINE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
  PHASE_TONES,
  SECTION_TITLE_CLASS,
  TONE_CLASS,
} from './shared';/* docs/23 S23-3：原 styles.banner（BANNER_CLASS）迁移 shadcn Alert warning
   变体（amber 淡底以 className 覆盖保留），使用位内联；原
   PROGRESS_TRACK/FILL_CLASS 迁移 shadcn Progress（transform 技法，轨道
   bg-secondary 即原 layer-2 档），一并删除手写常量。 */
/** 原 styles.eventRow（D22f：去满宽下边线的表格观感，改留白分组——行
 * py-1.5 + 列表容器 space-y-1；正文 14px/24，meta 12px muted 见使用位）。 */
const EVENT_ROW_CLASS = 'py-1.5 text-sm leading-6 text-foreground';

/**
 * 看板：目标、进度与最近动态（原「概览」）。S12 迁移面：横幅/两张卡片/
 * 空态/事件行全部 Tailwind 化；卡片容器用 shadcn Card（底色/边框/阴影按原
 * styles.card 覆盖，见 PANEL_CARD_CLASS）；阶段徽标升级为 shadcn Badge +
 * TONE_CLASS 查表（S5 card 先例的 outline 小 pill 档）。
 */
export function BoardTab({
  team,
  now,
  fetchedAt,
  error,
}: {
  team: TeamSnapshot | undefined;
  now: number;
  fetchedAt: number;
  error: string | null;
}): ReactNode {
  // docs/26 面板批准：staged + 计划待批准时的「批准计划」按钮（确认弹窗 →
  // POST approve → 立即回拉快照）。hooks 在早退分支之前，规则安全。
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const confirmApprove = (): void => {
    if (team === undefined) return;
    setApproveBusy(true);
    setApproveError(null);
    approveTeamPlan(team.teamId)
      .then(() => {
        setApproveOpen(false);
        refreshActivitySoon();
      })
      .catch((e: unknown) => setApproveError(e instanceof Error ? e.message : String(e)))
      .finally(() => setApproveBusy(false));
  };

  if (team === undefined) {
    return (
      <div className={EMPTY_CLASS}>
        <p>还没有团队。</p>
        <p className={LINE_CLASS}>
          推荐流程：先到「角色」页新增角色，再到「团队」页创建团队并把角色拉进去。
        </p>
        <p className={LINE_CLASS}>
          也可以在对话中说「用 AgentTeams 做某事」或 <code>/agent-teams</code>
          ，领队会先问询、再拆解计划等你批准。
        </p>
        <p className={MUTED_CLASS}>{error !== null ? `状态加载失败：${error}` : '尚未创建团队'}</p>
      </div>
    );
  }
  return (
    <div>
      {team.pendingDecisions.length > 0 && (
        /* docs/23 S23-3：原 BANNER_CLASS → shadcn Alert warning 变体（amber
           淡底 + foreground 正文以 className 覆盖保留）。D22f：去三角字符
           前缀、官网呼吸感 px-4 py-3、正文随基线 14px。 */
        <Alert
          variant="warning"
          className="mb-3 rounded-xl bg-[color:var(--dsw-static-amber-100,#fef5e7)] px-4 py-3 text-sm leading-6 text-foreground"
        >
          {team.pendingDecisions.length} 项待决策：
          {team.pendingDecisions.map((d) => `${d.taskId}（${d.error.slice(0, 40)}）`).join('；')} ——
          到对话里让领队处理，或等待 M5 的代答操作。
        </Alert>
      )}
      <Card className={PANEL_CARD_CLASS}>
        <div className={SECTION_TITLE_CLASS}>目标</div>
        <div className="text-sm font-semibold leading-6 text-foreground">{team.goal}</div>
        {/* docs/23 S23-3：进度条迁 shadcn Progress（h-1.5=原 6px 轨高；
            transform 技法指示器，bg-primary 即 D21a DSW 蓝）。 */}
        <Progress
          className="mt-2.5 mb-1.5 h-1.5"
          value={
            team.progress.total === 0 ? 0 : (team.progress.completed / team.progress.total) * 100
          }
        />
        <div className={MUTED_CLASS}>
          {team.progress.completed}/{team.progress.total} 完成 · {team.progress.active} 执行中 ·{' '}
          {/* 人数（用户迭代 2026-09 六：领队也算成员）——含领队，与看板卡、
          添加成员弹窗同一口径；领队被移出时只剩成员。 */}
          {team.members.length + (team.leaderRemoved ? 0 : 1)} 人 ·{' '}
          {/* 阶段徽标（S12）：原为 muted 行内文本，按「状态徽标用 shadcn」
          施工面升级为 outline Badge + TONE_CLASS 查表；tone 对齐 STATUS_GROUPS
          既有语义（PHASE_TONES）。D22d：12px 小字档（11px 档消灭）。 */}
          <Badge
            variant="outline"
            className={cn(
              'rounded-full border-solid px-2 py-px text-xs font-normal',
              TONE_CLASS[PHASE_TONES[team.phase] ?? 'muted'],
            )}
          >
            {PHASE_LABELS[team.phase] ?? team.phase}
          </Badge>
          {team.planReviewState !== null && team.phase === 'staged'
            ? ` · 计划${team.planReviewState === 'awaiting_review' ? '待批准' : team.planReviewState}`
            : ''}
        </div>
        {team.workDir !== null && <div className={MUTED_CLASS}>任务文档：{team.workDir}/</div>}
        {/* docs/26 面板批准入口：计划待批准（staged + awaiting_review）时出现。 */}
        {team.phase === 'staged' && team.planReviewState === 'awaiting_review' && (
          <div className="mt-2.5">
            <Button type="button" size="sm" onClick={() => setApproveOpen(true)}>
              批准计划
            </Button>
          </div>
        )}
      </Card>
      <Card className={PANEL_CARD_CLASS}>
        <div className={SECTION_TITLE_CLASS}>最近动态</div>
        {/* D22f：事件流去满宽下边线，改留白分组（列表 space-y-1 + 行 py-1.5）。 */}
        <div className="space-y-1">
          {team.latestEvents
            .slice(-8)
            .reverse()
            .map((e) => (
              <div key={e.seq} className={EVENT_ROW_CLASS}>
                <span className={MUTED_CLASS}>
                  {relativeTime(e.at, now)} · {e.actor}
                </span>{' '}
                {e.text}
              </div>
            ))}
          {team.latestEvents.length === 0 && <div className={MUTED_CLASS}>暂无事件</div>}
        </div>
        <div className={MUTED_CLASS}>
          数据更新于 {fetchedAt === 0 ? '—' : relativeTime(fetchedAt, now)}
        </div>
      </Card>

      {/* docs/28 看板 · 每日 Token 消耗日历（全年格子 + 悬浮明细）。取数 hooks
      都在子组件内部——子组件只在有团队时挂载，早退分支不会打断任何 hook 序
      （docs/30 28-M2 的「hooks 在早退前」约束等价成立）。 */}
      <UsageCalendarCard teamId={team.teamId} />

      {/* docs/26 批准计划确认弹窗：批准 = staged → running、小任务 draft→ready、
      全员子代理启动；合同冻结，后续变更在对话中留痕。失败就地显示。 */}
      <Dialog
        open={approveOpen}
        onOpenChange={(next) => {
          if (!next) {
            setApproveOpen(false);
            setApproveError(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle>批准计划</DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              批准后团队进入执行：小任务转为待指派，成员子代理全部启动；合同随之冻结，
              后续变更需在对话中留痕。
            </DialogDescription>
          </DialogHeader>
          {approveError !== null && <FormErrorNote>{approveError}</FormErrorNote>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={approveBusy}
              onClick={() => {
                setApproveOpen(false);
                setApproveError(null);
              }}
            >
              取消
            </Button>
            <Button type="button" size="sm" disabled={approveBusy} onClick={confirmApprove}>
              批准
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
