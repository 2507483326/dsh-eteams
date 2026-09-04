/**
 * 成员汇报时间线（docs/13.3 汇报）：成员对话框记录只读列表（M5 开放直发）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 membersTab / reportsTab 消费（依赖方向：membersTab/reportsTab → memberDialog → shared）。
 *
 * @module dsh-eteams/client/pages/teamsView/memberDialog
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { MemberView, TeamSnapshot } from '../../lib/monitor';
import { MUTED_CLASS } from './shared';

/** 原 styles.drawer（sunken 抽屉面板）：任务抽屉已升级为 Dialog，现仅成员
 * 汇报时间线使用。D22f：去双层灰底嵌套——容器改白底 + 左细线时间线签名。 */
const DRAWER_CLASS = `mt-2 mb-3.5 border-l-2 border-solid border-[color:var(--border)] pl-3`;
/** 原 styles.dialogItem（汇报时间线条目）：D22f 去灰底小卡，改普通段落
 * （正文 14px foreground；12px meta 前缀语义留在使用位的 MUTED_CLASS）。 */
const DIALOG_ITEM_CLASS = 'my-1 text-sm leading-6 text-foreground';

export function MemberDialog({ team, member }: { team: TeamSnapshot; member: MemberView }): ReactNode {
  const [items, setItems] = useState<{ at: number; kind: string; text: string; from?: string }[]>(
    [],
  );
  useEffect(() => {
    let alive = true;
    void fetch(
      `/eteams-api/team/${encodeURIComponent(team.teamId)}/member/${encodeURIComponent(member.name)}/dialog`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (alive && body !== null) setItems(body.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [team.teamId, team.version, member.name]);
  const kindLabel: Record<string, string> = {
    assignment: '指派',
    report: '汇报',
    question: '提问',
    notice: '通知',
    user_message: '用户',
    progress: '进度',
  };
  return (
    <div className={DRAWER_CLASS}>
      <div className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-foreground">
        汇报记录 · {member.name}
        <span className="text-xs font-normal text-muted-foreground">
          （只读；直发消息在 M5 开放）
        </span>
      </div>
      {items.length === 0 && <div className={MUTED_CLASS}>暂无消息记录</div>}
      {items.map((it, i) => (
        <div key={i} className={DIALOG_ITEM_CLASS}>
          <span className={MUTED_CLASS}>
            [{kindLabel[it.kind] ?? it.kind}] {it.from ?? ''} ·{' '}
          </span>
          {it.text.length > 160 ? `${it.text.slice(0, 160)}…` : it.text}
        </div>
      ))}
    </div>
  );
}
