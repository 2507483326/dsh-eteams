/**
 * 汇报 tab（docs/13.3 汇报）：成员选择 + 汇报时间线（D15 只读口径）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 依赖 memberDialog（依赖方向：membersTab/reportsTab → memberDialog → shared）。
 *
 * @module dsh-eteams/client/pages/teamsView/reportsTab
 */
import type { ReactNode } from 'react';
import type { MemberView, TeamSnapshot } from '../../lib/monitor';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { MemberDialog } from './memberDialog';
import {
  FORM_LABEL_CLASS,
  FORM_ROW_CLASS,
  MUTED_CLASS,
  SELECT_NONE,
} from './shared';

/** 汇报：成员选择 + 汇报时间线（原「对话」，D15 只读）。S13 Tailwind 化。 */
export function ReportsTab({
  team,
  dialogMember,
  setDialogMember,
  member,
}: {
  team: TeamSnapshot;
  dialogMember: string | null;
  setDialogMember: (name: string | null) => void;
  member: MemberView | null;
}): ReactNode {
  return (
    <div>
      <div className={FORM_ROW_CLASS}>
        <span className={FORM_LABEL_CLASS}>选择成员</span>
        {/* docs/23 S23-3：原生 select 迁 shadcn Select（哨兵值映射回 null）。 */}
        <Select
          value={dialogMember ?? SELECT_NONE}
          onValueChange={(v) => setDialogMember(v === SELECT_NONE ? null : v)}
        >
          <SelectTrigger className="h-[30px] w-full max-w-[280px] px-2.5 text-[12px] font-medium">
            <SelectValue placeholder="— 选择 —" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_NONE} className="text-[12px]">
              — 选择 —
            </SelectItem>
            {team.members.map((m) => (
              <SelectItem key={m.name} value={m.name} className="text-[12px]">
                {m.name}（{m.role}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {member === null ? (
        <div className={MUTED_CLASS}>选择一个成员查看对话时间线。</div>
      ) : (
        <MemberDialog team={team} member={member} />
      )}
    </div>
  );
}
