/**
 * 汇报 tab（docs/13.3 汇报）：成员选择 + 汇报时间线（D15 只读口径）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 依赖 team/memberDialog（依赖方向：routes → reportsPage → memberDialog →
 * shared）。
 * M5 结构性改造（docs/44 44.3，行为零变更）：44.3 横幅分区；哨兵项文案
 * 收编 MEMBER_SELECT_PLACEHOLDER（placeholder 与哨兵选项两处同文字面量
 * 单点维护）。页内两处条件式原样保留——Select 哨兵值归一是回调内的值
 * 映射（非渲染位）、正文 member 空判两支 JSX 结构不同，均不属 44.2.2
 * 状态域查表面（见 46 验收记录）。
 *
 * @module dsh-eteams/client/pages/reports/reportsPage
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
import { MemberDialog } from '../team/memberDialog';
import {
  FORM_LABEL_CLASS,
  FORM_ROW_CLASS,
  MUTED_CLASS,
  SELECT_NONE,
} from '../shared/styles';

/** ================================== 常量与映射表 ================================== */

/** 成员选择哨兵项文案（M5 收编字面量）：placeholder 与哨兵选项同文——
 * 单点维护（哨兵值本身是 shared 的 SELECT_NONE，Radix SelectItem 禁空串
 * value，docs/23 S23-3）。 */
const MEMBER_SELECT_PLACEHOLDER = '— 选择 —';

/** ================================== 主组件 ================================== */

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
            <SelectValue placeholder={MEMBER_SELECT_PLACEHOLDER} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_NONE} className="text-[12px]">
              {MEMBER_SELECT_PLACEHOLDER}
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
