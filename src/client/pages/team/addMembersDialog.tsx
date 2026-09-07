/**
 * 选择成员弹窗（用户迭代 2026-09-07「添加成员改成选择成员」+「+ - 按钮的
 * 数量都是 0，但是我已经有 8 个成员了」）：一行一个角色 + 加减步进器——
 * 中间数字 = 该角色当前在团队的份数（同名 -N 后缀副本计入，不再从 0 起），
 * ＋ 加一份、− 减一份；确认时一次性应用增减（加：新副本按占用序号取下一个
 * 空位自动 -2/-3 后缀，工号加入时由 host 自动发；减：从后缀最大的副本开始
 * 移出在团成员）。名额口径不变（上限 = memberCap，领队默认在团占 1 个
 * 名额——用户迭代 2026-09 六）：＋ 受剩余名额约束。领队被移出时菜单首位
 * 出现「领队」行，＋ 即加回（占 1 个名额，满员时禁用）。下单 = 逐个 POST，
 * 遇到错误停在原地报错，已成功的操作保留。
 *
 * @module dsh-eteams/client/pages/team/addMembersDialog
 */
import { useState, type ReactNode } from 'react';
import Minus from 'lucide-react/dist/esm/icons/minus.mjs';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import {
  addTeamMember,
  removeTeamMember,
  setTeamLeaderRemoved,
  type RosterMember,
} from '../../lib/api';
import { employeeIdNumberOf, type MemberView, type TeamSnapshot } from '../../lib/monitor';
import { cn } from '../../lib/cn';
import { errorMessageOf } from '../../lib/errors';
import { Avatar } from '../../features/avatar/avatar';
import { FormDialog, FormFooterActions } from '../../components/formDialog';
import { Button } from '../../components/ui/button';
import { FormErrorNote } from '../shared/components';
import { BORDER_L1_CLASS, LEADER_NAME, MUTED_CLASS, ROLE_BUILDER_NAME } from '../shared/styles';

/** ================================== 类型 ================================== */

/** 选择成员弹窗增减项：角色名 + 相对在团份数的增减（负数 = 待移出份数）。 */
interface CartItem {
  /** Roster role name（领队不进清单——单独走恢复开关）。 */
  name: string;
  delta: number;
}

/** ================================== 子组件 ================================== */

/**
 * 加减步进器：− 减一份、＋ 加一份，中间数字 = 该角色当前在团份数（含本次
 * 增减）。＋ 禁用时 title 说明名额口径，按钮不吞点击。按钮走 shadcn Button
 * outline icon（h-6 w-6 覆盖档）——原手写 STEP_BTN_CLASS 与 outline 变体同
 * 观感（描边 + hover 淡底），迁移后焦点环/禁用态由组件基类统一。
 */
function StepButtons({
  qty,
  onAdd,
  onRemove,
  addDisabled,
  removeDisabled,
  addTitle,
  removeTitle,
}: {
  qty: number;
  onAdd: () => void;
  onRemove: () => void;
  addDisabled: boolean;
  removeDisabled: boolean;
  addTitle: string;
  removeTitle: string;
}): ReactNode {
  return (
    <div className="flex flex-none items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={removeTitle}
        title={removeTitle}
        disabled={removeDisabled}
        className="h-6 w-6 bg-transparent text-muted-foreground shadow-none hover:text-foreground disabled:opacity-40"
        onClick={onRemove}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <span className="min-w-5 text-center text-sm font-semibold tabular-nums text-foreground">
        {qty}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={addTitle}
        title={addTitle}
        disabled={addDisabled}
        className="h-6 w-6 bg-transparent text-muted-foreground shadow-none hover:text-foreground disabled:opacity-40"
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** ================================== 主组件 ================================== */

/**
 * 选择成员弹窗（用户迭代 2026-09-07，原「添加成员」）：一行一个角色 + 加减
 * 步进器，步进器显示该角色在团份数；＋ 加一份（第二份起自动 -2/-3 后缀并
 * 照抄角色库默认值）、− 减一份（后缀最大的副本先出）。确认逐个 POST 应用
 * 增减；工号不在此展示也不逐份填写：加入团队时由 host 自动发（v7 表自增：
 * 班底行自增主键即工号，每份各拿各的号）。
 */
export function AddMembersDialog({
  open,
  onOpenChange,
  team,
  roster,
  memberCap,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: TeamSnapshot;
  roster: RosterMember[];
  memberCap: number;
}): ReactNode {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [leaderPicked, setLeaderPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 团队名额（用户迭代 2026-09 六：领队也算成员）：上限含领队——领队默认
  // 在团占 1 个名额，移出后空出；「加回领队」行同样占名额。
  const occupied = team.members.length + (team.leaderRemoved ? 0 : 1);
  const totalDelta = cart.reduce((n, c) => n + c.delta, 0);
  const leaderTaken = leaderPicked ? 1 : 0;
  const left = Math.max(0, memberCap - occupied - totalDelta - leaderTaken);
  const menu = roster.filter((m) => m.name !== LEADER_NAME && m.name !== ROLE_BUILDER_NAME);

  /** 该角色在团的成员行（同名 + -N 后缀副本，与出单命名同一约定）。 */
  const roleMembersOf = (roleName: string): MemberView[] =>
    team.members.filter((m) => m.name === roleName || m.name.startsWith(`${roleName}-`));

  /** 成员行在角色副本序列里的序号：本体 = 1，`-N` 后缀 = N（异常后缀 0）。 */
  const occOf = (memberName: string, roleName: string): number =>
    memberName === roleName ? 1 : Number(memberName.slice(roleName.length + 1)) || 0;

  const existingOf = (roleName: string): number => roleMembersOf(roleName).length;
  const deltaOf = (roleName: string): number => cart.find((c) => c.name === roleName)?.delta ?? 0;
  // 步进器显示值 = 在团份数 + 本次增减（用户迭代 2026-09-07：不再从 0 起）。
  const qtyOf = (roleName: string): number => existingOf(roleName) + deltaOf(roleName);

  /** 已占用序号集合（下一个空位从这里找，跳过被删中份数留下的空洞）。 */
  const usedOccsOf = (roleName: string): Set<number> => {
    const used = new Set<number>();
    for (const m of roleMembersOf(roleName)) {
      const occ = occOf(m.name, roleName);
      if (occ > 0) used.add(occ);
    }
    return used;
  };

  const addItem = (roleName: string): void => {
    setError(null);
    if (left <= 0) return;
    setCart((prev) =>
      prev.some((c) => c.name === roleName)
        ? prev.map((c) => (c.name === roleName ? { ...c, delta: c.delta + 1 } : c))
        : [...prev, { name: roleName, delta: 1 }],
    );
  };

  const removeOne = (roleName: string): void => {
    setError(null);
    // 减到在团份数 0 为止（− 再点由 removeDisabled 拦住）；份数归零即删项。
    setCart((prev) =>
      prev
        .map((c) => (c.name === roleName ? { ...c, delta: c.delta - 1 } : c))
        .filter((c) => existingOf(c.name) + c.delta > 0),
    );
  };

  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      setCart([]);
      setLeaderPicked(false);
      setError(null);
    }
  };

  const confirmApply = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (leaderPicked) await setTeamLeaderRemoved(team.teamId, false);
      for (const item of cart) {
        if (item.delta > 0) {
          // 加：按占用序号取下一个空位命名（洞不复用会撞名，复用即自然回填）。
          const used = usedOccsOf(item.name);
          for (let j = 0; j < item.delta; j++) {
            let occ = 1;
            while (used.has(occ)) occ += 1;
            used.add(occ);
            const memberName = occ === 1 ? item.name : `${item.name}-${occ}`;
            await addTeamMember(team.teamId, {
              name: memberName,
              ...(memberName !== item.name ? { sourceName: item.name } : {}),
            });
          }
        } else if (item.delta < 0) {
          // 减：后缀最大的副本先出（与加份次序对称），按工号定位移出。
          const victims = roleMembersOf(item.name)
            .map((m) => ({ m, occ: occOf(m.name, item.name) }))
            .sort((a, b) => b.occ - a.occ)
            .slice(0, -item.delta);
          for (const { m } of victims) {
            const employeeId = employeeIdNumberOf(m.employeeId);
            if (employeeId === null) throw new Error(`成员「${m.name}」没有工号，无法移出`);
            await removeTeamMember(team.teamId, employeeId);
          }
        }
      }
      close(false);
    } catch (e) {
      // 错误规范化收口 errorMessageOf（M7-5）；已成功的操作保留在团队里，
      // 清空增减缓冲避免重名二次报错，弹窗停在原地显示错误。
      setError(errorMessageOf(e));
      setCart([]);
      setLeaderPicked(false);
    } finally {
      setBusy(false);
    }
  };

  const rowClass = (active: boolean): string =>
    cn(
      'flex items-center gap-2.5 rounded-xl border border-solid bg-background px-2.5 py-1.5',
      active ? 'border-primary' : BORDER_L1_CLASS,
    );

  return (
    // 弹窗壳（M7-1 收口 FormDialog，max-w-md 档；onOpenChange 即 close 原样
    // 透传；描述行撤——用户迭代 2026-09-07，步进器即语义）。尾行按钮组靠右
    // （FormFooterActions 默认档），计数槽随底栏一并撤。
    <FormDialog open={open} onOpenChange={close} width="max-w-md" title="选择成员">
      {/* 菜单：一行一个角色，行尾加减步进器（名额满时全体 ＋ 禁用）。 */}
      <div className="flex max-h-[300px] flex-col gap-1.5 overflow-y-auto pr-0.5">
        {team.leaderRemoved && (
          <div className={rowClass(leaderPicked)}>
            <Avatar
              name={team.captain.name}
              seed={team.captain.avatar.seed}
              salt={team.captain.avatar.salt}
              size={28}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {team.captain.name}
              </div>
              <div className={cn(MUTED_CLASS, 'truncate text-xs')}>
                领队 · ＋ 加回（占 1 个名额）
              </div>
            </div>
            <StepButtons
              qty={leaderPicked ? 1 : 0}
              onAdd={() => {
                setLeaderPicked(true);
                setError(null);
              }}
              onRemove={() => {
                setLeaderPicked(false);
                setError(null);
              }}
              addDisabled={leaderPicked || left <= 0}
              removeDisabled={!leaderPicked}
              addTitle={
                left <= 0 ? '名额已满：团队上限 ' + memberCap + ' 人（含领队）' : '加回领队'
              }
              removeTitle="取消加回"
            />
          </div>
        )}
        {menu.map((m) => {
          const qty = qtyOf(m.name);
          return (
            <div key={m.name} className={rowClass(qty > 0)}>
              <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{m.name}</div>
                <div className={cn(MUTED_CLASS, 'truncate text-xs')}>{m.role}</div>
              </div>
              <StepButtons
                qty={qty}
                onAdd={() => addItem(m.name)}
                onRemove={() => removeOne(m.name)}
                addDisabled={left <= 0}
                removeDisabled={qty === 0}
                addTitle={
                  left <= 0 ? '名额已满：团队上限 ' + memberCap + ' 人（含领队）' : '加一份'
                }
                removeTitle="减一份"
              />
            </div>
          );
        })}
        {menu.length === 0 && !team.leaderRemoved && (
          <div className={cn(MUTED_CLASS, 'py-4 text-center text-xs')}>
            角色库还没有可选角色——先到「角色」页新增。
          </div>
        )}
      </div>

      {error !== null && <FormErrorNote>{error}</FormErrorNote>}

      <FormFooterActions
        cancelDisabled={busy}
        confirmDisabled={busy || (totalDelta === 0 && !leaderPicked)}
        confirmLabel="选择成员"
        onCancel={() => close(false)}
        onConfirm={() => void confirmApply()}
      />
    </FormDialog>
  );
}
