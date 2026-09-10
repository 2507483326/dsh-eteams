/**
 * 添加成员弹窗（用户迭代 2026-09-10，原「选择成员」改回）：顶部搜索框 +
 * 一行一张角色大卡，点卡片勾选/取消勾选，确认一次性 POST 应用。用户迭代
 * 口径：
 * - 「暂时只能加一个」——每个角色至多加一份（同名 -N 后缀副本不再生成，
 *   也就不再有自动建出的「角色-2」角色行）；已在团队的角色（含历史副本）
 *   直接不展示——清单里只剩可加的（同日追加要求）；
 * - 「只能新增成员不能减少成员」——去掉加减步进器，移除走成员卡多选删除
 *   （teamDetailPage）；
 * - 角色行放大（头像 36 + 名字 + 角色标签 + 简介行）。
 * 名额口径不变（上限 = memberCap，领队默认在团占 1 个名额——用户迭代
 * 2026-09 六）：勾选受剩余名额约束。领队被移出时菜单首位出现「领队」卡，
 * 勾选即加回（占 1 个名额，满员时禁用）。确认 = 逐个 POST，遇到错误停在
 * 原地报错，已成功的操作保留。
 *
 * @module dsh-eteams/client/pages/team/addMembersDialog
 */
import { useState, type ReactNode } from 'react';
import Check from 'lucide-react/dist/esm/icons/check.mjs';
import { addTeamMember, setTeamLeaderRemoved, type RosterMember } from '../../lib/api';
import type { TeamSnapshot } from '../../lib/monitor';
import { cn } from '../../lib/cn';
import { errorMessageOf } from '../../lib/errors';
import { Avatar } from '../../features/avatar/avatar';
import { FormDialog, FormFooterActions } from '../../components/formDialog';
import { Input } from '../../components/ui/input';
import { FormErrorNote } from '../shared/components';
import { BORDER_L1_CLASS, LEADER_NAME, LIST_COUNT_CLASS, MUTED_CLASS, ROLE_BUILDER_NAME } from '../shared/styles';

/** ================================== 主组件 ================================== */

/**
 * 添加成员弹窗（用户迭代 2026-09-10）：搜索框 + 角色大卡勾选清单，确认
 * 逐个 POST（name = 角色名，工号由 host 发——v7 班底行自增主键即工号）。
 * 步进器与 -N 副本命名已随「只能加一个」迭代撤除。
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
  const [selected, setSelected] = useState<string[]>([]);
  const [leaderPicked, setLeaderPicked] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 团队名额（用户迭代 2026-09 六：领队也算成员）：上限含领队——领队默认
  // 在团占 1 个名额，移出后空出；「加回领队」卡同样占名额。
  const occupied = team.members.length + (team.leaderRemoved ? 0 : 1);
  const leaderTaken = leaderPicked ? 1 : 0;
  const left = Math.max(0, memberCap - occupied - selected.length - leaderTaken);
  // 主对话注入角色（v12）不进菜单：system 的手册是主对话注入原文，不是
  // 团队成员（host 侧 addMember 亦硬拒，双保险）。
  const menu = roster.filter(
    (m) => m.name !== LEADER_NAME && m.name !== ROLE_BUILDER_NAME && m.isRoot !== true,
  );

  /** 该角色是否已在团队（同名 + -N 后缀历史副本都算占坑——只能加一个）。 */
  const inTeamOf = (roleName: string): boolean =>
    team.members.some((m) => m.name === roleName || m.name.startsWith(`${roleName}-`));

  // 已在团队的角色直接不展示（用户迭代 2026-09-10 追加）——清单只出可加的。
  const available = menu.filter((m) => !inTeamOf(m.name));
  // 搜索（用户迭代 2026-09-10）：按名字/角色标签/简介过滤。
  const q = query.trim().toLowerCase();
  const hitMenu =
    q === ''
      ? available
      : available.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.role.toLowerCase().includes(q) ||
            (m.profile ?? '').toLowerCase().includes(q),
        );

  const toggleRole = (roleName: string): void => {
    setError(null);
    // 名额满（未勾选状态下）不可再加——已勾选的取消不受限。
    if (!selected.includes(roleName) && left <= 0) return;
    setSelected((prev) =>
      prev.includes(roleName) ? prev.filter((n) => n !== roleName) : [...prev, roleName],
    );
  };

  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      setSelected([]);
      setLeaderPicked(false);
      setQuery('');
      setError(null);
    }
  };

  const confirmApply = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (leaderPicked) await setTeamLeaderRemoved(team.teamId, false);
      for (const name of selected) {
        await addTeamMember(team.teamId, { name });
      }
      close(false);
    } catch (e) {
      // 错误规范化收口 errorMessageOf（M7-5）；已成功的操作保留在团队里，
      // 清空勾选避免重名二次报错，弹窗停在原地显示错误。
      setError(errorMessageOf(e));
      setSelected([]);
      setLeaderPicked(false);
    } finally {
      setBusy(false);
    }
  };

  /** 角色大卡（用户迭代 2026-09-10）：头像 36 + 名字 + 角色标签（+ 简介），
   * 行尾勾选圈；已在团队置灰出「已在团队」徽，不可点。 */
  const cardClass = (active: boolean, disabled: boolean): string =>
    cn(
      'flex w-full items-center gap-3 rounded-xl border border-solid px-3 py-2.5 text-left transition-colors',
      disabled
        ? 'cursor-not-allowed border-border bg-muted/40 opacity-60'
        : active
          ? 'border-primary bg-primary/5'
          : cn(BORDER_L1_CLASS, 'bg-background hover:bg-muted/60'),
    );

  return (
    // 弹窗壳（M7-1 收口 FormDialog）：加一档宽（max-w-lg）配大卡。尾行按钮
    // 组靠右，计数槽随底栏保留（确认后的团队规模）。
    <FormDialog open={open} onOpenChange={close} width="max-w-lg" title="添加成员">
      {/* 搜索框（用户迭代 2026-09-10）：置顶，按名字/角色/简介过滤。 */}
      <Input
        value={query}
        placeholder="搜索角色名…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-0.5">
        {team.leaderRemoved && (
          <button
            type="button"
            className={cardClass(leaderPicked, !leaderPicked && left <= 0)}
            title={!leaderPicked && left <= 0 ? '名额已满：团队上限 ' + memberCap + ' 人（含领队）' : undefined}
            onClick={() => {
              // 名额满（未勾选状态下）不可加回——已勾选的取消不受限。
              if (!leaderPicked && left <= 0) return;
              setLeaderPicked((v) => !v);
              setError(null);
            }}
          >
            <Avatar
              name={team.captain.name}
              seed={team.captain.avatar.seed}
              salt={team.captain.avatar.salt}
              size={36}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {team.captain.name}
              </div>
              <div className={cn(MUTED_CLASS, 'truncate text-xs')}>领队 · 勾选加回（占 1 个名额）</div>
            </div>
            <PickCheck picked={leaderPicked} />
          </button>
        )}
        {hitMenu.map((m) => {
          const picked = selected.includes(m.name);
          return (
            <button
              key={m.name}
              type="button"
              className={cardClass(picked, !picked && left <= 0)}
              title={
                !picked && left <= 0
                  ? '名额已满：团队上限 ' + memberCap + ' 人（含领队）'
                  : undefined
              }
              onClick={() => toggleRole(m.name)}
            >
              <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{m.name}</div>
                <div className={cn(MUTED_CLASS, 'truncate text-xs')}>{m.role}</div>
                {m.profile !== undefined && m.profile.trim() !== '' && (
                  <div
                    className={cn(MUTED_CLASS, 'mt-0.5 truncate text-xs leading-4')}
                    title={m.profile.trim()}
                  >
                    {m.profile.trim()}
                  </div>
                )}
              </div>
              <PickCheck picked={picked} />
            </button>
          );
        })}
        {menu.length === 0 && !team.leaderRemoved && (
          <div className={cn(MUTED_CLASS, 'py-4 text-center text-xs')}>
            角色库还没有可选角色——先到「角色」页新增。
          </div>
        )}
        {menu.length > 0 && hitMenu.length === 0 && (
          <div className={cn(MUTED_CLASS, 'py-4 text-center text-xs')}>
            {q !== ''
              ? `没有匹配「${query.trim()}」的角色。`
              : '角色库里的角色都已加进团队。'}
          </div>
        )}
      </div>

      {error !== null && <FormErrorNote>{error}</FormErrorNote>}

      <FormFooterActions
        className="justify-between gap-2"
        left={
          // 名册计数：在团人数 + 本次勾选（加回领队计入）= 确认后的团队规模。
          <span className={LIST_COUNT_CLASS}>
            {occupied + selected.length + leaderTaken}人/{memberCap}人
          </span>
        }
        cancelDisabled={busy}
        confirmDisabled={busy || (selected.length === 0 && !leaderPicked)}
        confirmLabel="添加"
        onCancel={() => close(false)}
        onConfirm={() => void confirmApply()}
      />
    </FormDialog>
  );
}

/** 行尾勾选圈：勾中实心品牌色，未勾空圈。 */
function PickCheck({ picked }: { picked: boolean }): ReactNode {
  return (
    <span
      className={cn(
        'flex h-5 w-5 flex-none items-center justify-center rounded-full border border-solid',
        picked
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-muted-foreground/30 text-transparent',
      )}
    >
      <Check className="h-3 w-3" />
    </span>
  );
}
