/**
 * 团队成员卡片层（docs/13.3 团队）：领队卡 / 成员卡 / 成员详情页。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 teamTab 消费（依赖方向：teamTab → teamMembers → modelRoutePicker /
 * buildDraft → shared；R1 类型边 teamMembers→HandbookSource 走 import type）。
 *
 * @module dsh-eteams/client/pages/teamsView/teamMembers
 */
import { useState, type ReactNode } from 'react';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import { syncMemberToRoster, updateMemberPersona } from '../../lib/api';
import {
  refreshActivitySoon,
  type CaptainView,
  type MemberView,
  type TeamSnapshot,
} from '../../lib/monitor';
import type { ModelCatalogState } from '../../lib/modelCatalog';
import { catalogRowByModel } from '../../lib/modelCatalog';
import { cn } from '../../lib/cn';
import { Avatar } from '../../features/avatar/avatar';
import { MdEditor } from '../../features/mdEditor/mdEditor';
import { MEMBER_STATUS_LABELS, memberTone } from '../../features/tasks/taskDisplayStatus';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { toast } from '../../hooks/useToast';
import { ModelRoutePicker } from './modelRoutePicker';
import { MarkdownDoc } from './markdownDoc';
import { handbookSeed, type HandbookSource } from './buildDraft';
import {
  BORDER_L1_CLASS,
  FormErrorNote,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
  Pill,
  SECTION_TITLE_CLASS,
} from './shared';

/** 原 styles.memberCard（成员卡片：--border 边框 / 12px 圆角 / 官网 shadow-sm
 * 阴影档 / p-4 卡内呼吸感，D22f）。 */
const MEMBER_CARD_CLASS = `flex flex-col gap-2 rounded-xl border border-solid bg-background p-4 shadow-[0_1px_2px_rgba(15,23,42,0.05)] ${BORDER_L1_CLASS}`;
/** 原 styles.roleChip（品牌档圆 pill）：S14 团队卡片「当前」复用；D22e 官网
 * pill 口径（rounded-full / 12px / medium）+ 品牌淡底 token + brand-ink 字。 */
const ROLE_CHIP_CLASS =
  'inline-flex w-fit items-center rounded-full bg-business-tint px-2.5 py-0.5 text-xs font-medium text-[color:var(--eteams-brand-ink)]';

/** The 领队（项目牧羊人）leader card. S13 Tailwind 化。
 * 用户迭代 2026-09：领队可被移出团队（可经添加成员弹窗加回），onRemove 挂移除钮；
 * 领队也算团队一员——工号 + 右侧同款模型二级菜单（= 团队默认路线）。
 * 用户迭代 2026-09 四：查看手册按钮去掉，点卡片进领队详情（手册只读）。
 * 用户迭代 2026-09-04：领队模型选择恢复（此前 docs/35 §5#5 随审批重构下
 * 线）——写 task_members 领队行 model/reasoning_effort，领队子代理派发按
 * 它解析；空 = 会话默认。 */
export function LeaderCard({
  captain,
  catalog,
  onRemove,
  onOpenDetail,
  onModelChange,
  onEffortChange,
  modelSaving,
}: {
  captain: CaptainView;
  /** 会话模型目录状态（数据 + loading/failed/reload，对话选择器同款）。 */
  catalog: ModelCatalogState;
  onRemove?: () => void;
  /** 点卡片进领队详情（手册只读）。 */
  onOpenDetail?: () => void;
  /** 领队模型选择（右侧二级菜单）：行 id=`provider/model`，'inherit' = 会话默认。 */
  onModelChange?: (model: string) => void;
  /** 推理等级改写（菜单内「推理等级」子面板；null = 提供方默认）。 */
  onEffortChange?: (effort: string | null) => void;
  /** 领队模型路由保存中（菜单短暂禁用防连点）。 */
  modelSaving?: boolean;
}): ReactNode {
  // 领队行路线只剩 {model, reasoningEffort}——菜单内部仍按 `provider/model`
  // 行值渲染选中态，provider 由 model 经目录反查；会话默认（model 空）回
  // inherit 哨兵；目录查不到的历史路线按裸模型 id 兜底。
  const routeRow = catalogRowByModel(catalog.catalog, captain.model ?? '');
  return (
    <div className={MEMBER_CARD_CLASS}>
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg',
            onOpenDetail !== undefined && 'cursor-pointer transition-colors hover:bg-muted/60',
          )}
          onClick={onOpenDetail}
          title={onOpenDetail !== undefined ? '进入领队详情' : undefined}
        >
          <Avatar name={captain.name} seed={captain.avatar.seed} salt={captain.avatar.salt} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{captain.name}</span>
              <span className={ROLE_CHIP_CLASS}>领队</span>
            </div>
            <div className={cn(MUTED_CLASS, 'mt-px')}>
              {captain.employeeId !== '' ? `${captain.employeeId} · ` : ''}
              {captain.role} · 不接任务：负责拆解、指派与调度
            </div>
          </div>
        </div>
        {onModelChange !== undefined && (
          <ModelRoutePicker
            catalogState={catalog}
            stored={
              (captain.model ?? '') === ''
                ? { provider: 'inherit', model: 'inherit', reasoningEffort: null }
                : {
                    provider: routeRow?.group.id ?? 'legacy',
                    model: captain.model ?? '',
                    reasoningEffort: captain.reasoningEffort ?? null,
                  }
            }
            inheritLabel="会话默认"
            fallback={MODEL_OPTIONS}
            disabled={modelSaving}
            onModelPick={(v) => onModelChange !== undefined && onModelChange(v)}
            onEffortPick={(effort) => onEffortChange !== undefined && onEffortChange(effort)}
            title="选择领队运行的模型（「会话默认」= 设置里的会话默认模型；下次转交生效）"
          />
        )}
        {onRemove !== undefined && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            移出团队
          </Button>
        )}
      </div>
    </div>
  );
}

/** 成员模型选项（用户迭代 2026-09 七）：inherit=会话默认（用户迭代
 * 2026-09-04：settings agent-default-model 即时快照，不再继承领队会话模
 * 型）；切换只改 member.modelRoute——staged 成员启动即生效，运行中的成员
 * 下次启动生效。 */
/** 成员静态选项（目录不可用时的回退）：inherit=会话默认；切换只改
 * member.modelRoute——staged 成员启动即生效，运行中的成员下次启动生效。 */
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'inherit', label: '会话默认' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
];

/** 成员卡（用户迭代 2026-09 七）：与领队卡同款单行、竖排一行一个——头像 +
 * 名字（+ 子代理活动点）+ 工号 · 角色，右侧模型选择（默认「会话默认」，与
 * 领队一致）+ 移出团队。状态 pill（staged 等）与「汇报记录」按钮已去掉
 * （用户迭代 2026-09 七）；模型目录与对话一致——二级菜单内多档 effort 模型
 * 带「推理等级」子面板。用户迭代 2026-09 四：点卡片（头像/名字区）进成员
 * 详情页。团队可以没有领队：领队被移出时这里只剩成员行。 */
export function MemberCard({
  member: m,
  catalog,
  activity,
  onRemove,
  onModelChange,
  onEffortChange,
  modelSaving,
  onOpenDetail,
}: {
  member: MemberView;
  /** 会话模型目录状态（数据 + loading/failed/reload，对话选择器同款）。 */
  catalog: ModelCatalogState;
  /** Subagent activity (docs/20.4 P4): 'running' | 'inactive' | undefined. */
  activity?: string;
  onRemove?: (name: string) => void;
  /** 模型选择（右侧二级菜单）：行 id=`provider/model`，'inherit' = 会话默认。 */
  onModelChange?: (memberName: string, model: string) => void;
  /** 推理等级改写（菜单内「推理等级」子面板；null = 提供方默认）。 */
  onEffortChange?: (memberName: string, effort: string | null) => void;
  /** 该成员的模型路由保存中（菜单短暂禁用防连点）。 */
  modelSaving?: boolean;
  /** 点卡片（头像/名字区）进成员详情页。 */
  onOpenDetail?: (name: string) => void;
}): ReactNode {
  const openDetail = (): void => {
    if (onOpenDetail !== undefined) onOpenDetail(m.name);
  };
  // 快照路线只剩 {model, reasoningEffort}（docs/35 §3#5）——菜单内部仍按
  // `provider/model` 行值渲染选中态，provider 由 model 经目录反查；会话默认
  // （model 空串）回 inherit 哨兵；目录查不到的历史路线按裸模型 id 兜底。
  const routeRow = catalogRowByModel(catalog.catalog, m.model);
  const inherit = m.model === '';
  return (
    <div className={MEMBER_CARD_CLASS}>
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg',
            onOpenDetail !== undefined && 'cursor-pointer transition-colors hover:bg-muted/60',
          )}
          onClick={openDetail}
          title={onOpenDetail !== undefined ? '进入成员详情' : undefined}
        >
          <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              {activity !== undefined && (
                <span
                  className={
                    activity === 'running'
                      ? // 状态点光晕（D22f）：green-100 死字面量改 color-mix
                        // success 淡环（token 半透明替代路径，button.tsx 先例，
                        // 亮暗自适应）。
                        'h-[7px] w-[7px] shrink-0 rounded-full bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_15%,transparent)]'
                      : 'h-[7px] w-[7px] shrink-0 rounded-full bg-muted-foreground'
                  }
                  title={activity === 'running' ? '子代理运行中' : '子代理已完结'}
                />
              )}
              {m.name}
            </div>
            <div className={cn(MUTED_CLASS, 'mt-px')}>
              {m.employeeId !== null ? `${m.employeeId} · ` : ''}
              {m.role}
            </div>
          </div>
        </div>
        {onModelChange !== undefined && (
          <ModelRoutePicker
            catalogState={catalog}
            stored={
              inherit
                ? { provider: 'inherit', model: 'inherit', reasoningEffort: null }
                : {
                    provider: routeRow?.group.id ?? 'legacy',
                    model: m.model,
                    reasoningEffort: m.reasoningEffort,
                  }
            }
            inheritLabel="会话默认"
            fallback={MODEL_OPTIONS}
            disabled={modelSaving}
            onModelPick={(v) => onModelChange !== undefined && onModelChange(m.name, v)}
            onEffortPick={(effort) =>
              onEffortChange !== undefined && onEffortChange(m.name, effort)
            }
            title="选择成员运行的模型（「会话默认」= 设置里的会话默认模型；运行中的成员下次启动时生效）"
          />
        )}
        {onRemove !== undefined && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onRemove(m.name)}
          >
            移出团队
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * 成员详情页（用户迭代 2026-09 四）：点成员/领队卡进入。成员详情与角色详情
 * 是两份独立数据——加入团队时从角色库复制一份，之后各自演化；这里查看/
 * 编辑成员自己的手册（「保存」只写成员记录），「同步到角色」把当前手册写回
 * 角色库同名角色（副本成员无同名角色时按成员记录新建）。领队也走这一页：
 * 手册由系统合成，只读、无保存/同步。
 */
export function MemberDetailView({
  team,
  target,
  onBack,
  onOpenReports,
}: {
  team: TeamSnapshot;
  target: { kind: 'captain' } | { kind: 'member'; name: string };
  onBack: () => void;
  onOpenReports?: (name: string) => void;
}): ReactNode {
  // 编辑缓冲：null = 只读渲染；string = 编辑中。进入编辑时从当前手册播种。
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberRow =
    target.kind === 'member' ? team.members.find((m) => m.name === target.name) : undefined;

  if (target.kind === 'member' && memberRow === undefined) {
    return (
      <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
        <div className={MUTED_CLASS}>成员不在团队里——可能刚被移出。</div>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          返回团队成员
        </Button>
      </Card>
    );
  }

  // 详情页展示口径：优先成员自己的手册副本；旧成员没有副本时按结构字段
  // 合成骨架（首次保存/同步即落成正式手册）。
  const view: {
    name: string;
    employeeId: string | null;
    role: string;
    status: string | null;
    avatar: { seed: number; salt: number } | null;
    source: HandbookSource;
  } =
    target.kind === 'captain'
      ? {
          name: team.captain.name,
          employeeId: team.captain.employeeId,
          role: team.captain.role,
          status: null,
          avatar: team.captain.avatar,
          source: {
            name: team.captain.name,
            role: team.captain.role,
            personaMd: team.captain.personaMd,
            duty: team.captain.duty,
            style: team.captain.style,
            skills: team.captain.skills,
          },
        }
      : {
          name: memberRow?.name ?? target.name,
          employeeId: memberRow?.employeeId ?? null,
          role: memberRow?.role ?? '',
          status: memberRow?.status ?? null,
          avatar: memberRow?.avatar ?? null,
          source: {
            name: memberRow?.name ?? target.name,
            role: memberRow?.role ?? '',
            personaMd: memberRow?.personaMd ?? null,
            duty: memberRow?.duty ?? null,
            style: memberRow?.style ?? null,
            skills: memberRow?.skills ?? null,
            rules: memberRow?.rules ?? null,
            executionPrompt: memberRow?.executionPrompt ?? null,
          },
        };
  const display = handbookSeed(view.source);

  const save = async (): Promise<void> => {
    if (draft === null || saving || target.kind !== 'member') return;
    const text = draft.trim();
    if (text === '') {
      setError('手册内容为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateMemberPersona(team.teamId, target.name, text);
      setDraft(null);
      // 保存反馈迁 shadcn toast()（docs/43 十九轮；原就地瞬时行 2.5s 撤除）。
      toast({ title: '✓ 已保存到成员详情' });
      refreshActivitySoon();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const syncToRole = async (): Promise<void> => {
    if (syncing || target.kind !== 'member') return;
    const text = (draft ?? display).trim();
    if (text === '') {
      setError('成员手册为空，先编辑保存');
      return;
    }
    setSyncing(true);
    setError(null);
    try {
      await syncMemberToRoster(team.teamId, target.name, text);
      if (draft !== null) setDraft(null); // 编辑中的草稿已一并落库
      // 同步反馈迁 shadcn toast()（docs/43 十九轮；原就地瞬时行 2.5s 撤除）。
      toast({ title: `✓ 已同步到角色「${view.name}」` });
      refreshActivitySoon();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          返回团队成员
        </Button>
        <span className="text-lg font-semibold tracking-tight text-foreground">{view.name}</span>
        {target.kind === 'captain' && <span className={ROLE_CHIP_CLASS}>领队</span>}
        {view.status !== null && (
          <Pill tone={memberTone(view.status)}>
            {MEMBER_STATUS_LABELS[view.status] ?? view.status}
          </Pill>
        )}
      </div>

      <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
        <div className="flex items-center gap-3.5">
          {/* 头像描边环：角色详情页同款（品牌淡底档）。 */}
          <div className="rounded-full border-2 border-solid p-0.5 leading-none border-business-tint">
            <Avatar name={view.name} seed={view.avatar?.seed} salt={view.avatar?.salt} size={52} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold tracking-tight text-foreground">{view.name}</div>
            <div className={cn(MUTED_CLASS, 'mt-0.5')}>
              {view.employeeId !== null ? `${view.employeeId} · ` : ''}
              {view.role}
              {target.kind === 'captain' ? ' · 不接任务：负责拆解、指派与调度' : ''}
            </div>
            {target.kind === 'member' && (
              <div className={cn(MUTED_CLASS, 'mt-0.5')}>
                详情独立于角色库：加入团队时复制了一份，可编辑后同步回去
              </div>
            )}
          </div>
          {target.kind === 'member' && onOpenReports !== undefined && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenReports(view.name)}
            >
              汇报记录
            </Button>
          )}
        </div>
      </Card>

      <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
        <div className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
          <span className="flex-1">
            {target.kind === 'captain' ? '领队手册（Markdown）' : '成员手册（Markdown）'}
          </span>
          {target.kind === 'captain' ? (
            <span className={MUTED_CLASS}>领队手册由系统合成，只读</span>
          ) : draft === null ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError(null);
                  setDraft(display);
                }}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={syncing}
                onClick={() => void syncToRole()}
                title="把当前手册写回角色库同名角色（无同名角色时按成员新建）；编辑中的草稿会一并保存"
              >
                同步到角色
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
                取消
              </Button>
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                保存
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving || syncing}
                onClick={() => void syncToRole()}
                title="把当前手册写回角色库同名角色（无同名角色时按成员新建）"
              >
                同步到角色
              </Button>
            </>
          )}
        </div>
        {draft === null ? (
          <MarkdownDoc text={display} />
        ) : (
          <MdEditor value={draft} onChange={setDraft} minHeight={260} />
        )}
        {error !== null && <FormErrorNote className="mt-2">{error}</FormErrorNote>}
      </Card>
    </div>
  );
}
