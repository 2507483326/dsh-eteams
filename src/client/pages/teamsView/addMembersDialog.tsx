/**
 * 添加成员弹窗（用户迭代 2026-09 三）：角色购物车 + 加减步进器。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 teamTab 消费（依赖方向：teamTab → addMembersDialog → shared）。
 *
 * @module dsh-eteams/client/pages/teamsView/addMembersDialog
 */
import { useState, type ReactNode } from 'react';
import Minus from 'lucide-react/dist/esm/icons/minus.mjs';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import { addTeamMember, setTeamLeaderRemoved, type RosterMember } from '../../lib/api';
import type { TeamSnapshot } from '../../lib/monitor';
import { cn } from '../../lib/cn';
import { Avatar } from '../../features/avatar/avatar';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import {
  BORDER_L1_CLASS,
  FormErrorNote,
  LEADER_NAME,
  LIST_COUNT_CLASS,
  MUTED_CLASS,
  ROLE_BUILDER_NAME,
} from './shared';

/** 添加成员弹窗购物车项：角色名 + 已点份数。 */
interface CartItem {
  /** Roster role name（领队不进购物车——单独走恢复开关）。 */
  name: string;
  qty: number;
}

/**
 * 加减步进器（用户迭代 2026-09 三添加成员行尾）：− 减一份、＋ 加一份，
 * 中间数字 = 该角色已点份数。＋ 禁用时 title 说明名额口径，按钮不吞点击。
 * 按钮走 shadcn Button outline icon（h-6 w-6 覆盖档）——原手写
 * STEP_BTN_CLASS 与 outline 变体同观感（描边 + hover 淡底），迁移后焦点环/
 * 禁用态由组件基类统一。
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
      <span className="w-5 text-center text-sm font-semibold tabular-nums text-foreground">
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

/**
 * 添加成员弹窗（用户迭代 2026-09 三）：一行一个角色 + 加减步进器——每行
 * 行尾 [−] n [+]，＋ 加一份、－ 减一份（同一角色可加多份，第二份起自动
 * -2/-3 后缀并照抄角色库默认值）；弹窗底部给出已选人数与名额口径
 * （上限 = memberCap，含领队——用户迭代 2026-09 六：领队也算成员，初始化
 * 默认在团、占 1 个名额，移出后空位可补成员）。工号不在此展示也不逐份填写：
 * 角色还没加入成员时没有工号，加入团队时由 host 自动分配（同名角色沿用
 * 同一工号）。领队被移出时菜单首位出现「领队」行，＋ 即加回（占 1 个名额，
 * 满员时禁用）。下单 = 逐个 POST，遇到错误停在原地，已加成功的成员保留
 * 在团队里。
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
  const [hint, setHint] = useState<string | null>(null);

  // 团队名额（用户迭代 2026-09 六：领队也算成员）：上限含领队——领队默认
  // 在团占 1 个名额，移出后空出；「加回领队」行同样占名额。footer 的
  // 「成员 N/上限 · 还可加 K」与看板/团队页的人数口径一致。
  const occupied = team.members.length + (team.leaderRemoved ? 0 : 1);
  const total = cart.reduce((n, c) => n + c.qty, 0);
  const leaderTaken = leaderPicked ? 1 : 0;
  const left = Math.max(0, memberCap - occupied - total - leaderTaken);
  const menu = roster.filter((m) => m.name !== LEADER_NAME && m.name !== ROLE_BUILDER_NAME);

  const qtyOf = (roleName: string): number => cart.find((c) => c.name === roleName)?.qty ?? 0;

  /** 第 copy 份的成员名：队里已有 E 个同名时叫 base（E+copy=1）或 base-N。 */
  const copyName = (roleName: string, copy: number): string => {
    const occ = team.members.filter((m) => m.name === roleName).length + copy;
    return occ === 1 ? roleName : `${roleName}-${occ}`;
  };

  const addItem = (roleName: string): void => {
    setError(null);
    setHint(null);
    if (left <= 0) {
      setHint('成员名额已满');
      return;
    }
    // 去重必须在 updater 内判定：同拍连点（快速双击）时外层 qtyOf 是旧值。
    setCart((prev) =>
      prev.some((c) => c.name === roleName)
        ? prev.map((c) => (c.name === roleName ? { ...c, qty: c.qty + 1 } : c))
        : [...prev, { name: roleName, qty: 1 }],
    );
  };

  const removeOne = (roleName: string): void => {
    setCart((prev) =>
      prev
        .map((c) => (c.name === roleName ? { ...c, qty: c.qty - 1 } : c))
        .filter((c) => c.qty > 0),
    );
  };

  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      setCart([]);
      setLeaderPicked(false);
      setError(null);
      setHint(null);
    }
  };

  const confirmAdd = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (leaderPicked) await setTeamLeaderRemoved(team.teamId, false);
      for (const item of cart) {
        for (let copy = 1; copy <= item.qty; copy++) {
          const memberName = copyName(item.name, copy);
          await addTeamMember(team.teamId, {
            name: memberName,
            ...(memberName !== item.name ? { sourceName: item.name } : {}),
          });
        }
      }
      close(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 已加成功的保留；清空购物车避免重名二次报错。
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
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription className={MUTED_CLASS}>
            一行一个角色：＋ 加一份、－ 减一份，同一角色可加多份（自动加 -2、-3
            后缀），工号在加入团队时自动分配（这里不展示——角色没加入成员前没有工号）。
          </DialogDescription>
        </DialogHeader>

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

        {hint !== null && <div className={cn(MUTED_CLASS, 'text-xs')}>{hint}</div>}
        {error !== null && <FormErrorNote>{error}</FormErrorNote>}

        <div className="flex items-center justify-between gap-2">
          <span className={LIST_COUNT_CLASS}>
            已选 {total + leaderTaken} 人 · 成员 {occupied + total + leaderTaken}/{memberCap} ·
            还可加 {left} 人
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => close(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || (total === 0 && !leaderPicked)}
              onClick={() => void confirmAdd()}
            >
              添加成员
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
