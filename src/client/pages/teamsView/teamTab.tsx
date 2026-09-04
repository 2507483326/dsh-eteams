/**
 * 团队 tab（docs/13.3 团队）：团队卡片栅格、建团、团队详情（成员卡列表 +
 * 模型路线）、删除确认与添加成员弹窗。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 依赖 teamMembers / addMembersDialog / modelRoutePicker 与 shared 共享层。
 *
 * @module dsh-eteams/client/pages/teamsView/teamTab
 */
import { useState, type ReactNode } from 'react';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import {
  createTeamViaPanel,
  deleteTeam,
  removeTeamMember,
  setMemberModel,
  setTeamLeaderRemoved,
  type RosterMember,
} from '../../lib/api';
import {
  applyRoutePatch,
  refreshActivitySoon,
  revertRoutePatch,
  type RoutePatch,
  type RouteTriple,
  type TeamSnapshot,
} from '../../lib/monitor';
import { catalogRow, catalogRowByModel, useModelCatalog } from '../../lib/modelCatalog';
import { cn } from '../../lib/cn';
import { Avatar } from '../../features/avatar/avatar';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { AddMembersDialog } from './addMembersDialog';
import { LeaderCard, MemberCard, MemberDetailView } from './teamMembers';
import {
  CARD_GRID_CLASS,
  EMPTY_CLASS,
  FormErrorNote,
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
  PageHeader,
  PANEL_CARD_CLASS,
} from './shared';

/** 原 styles.memberGrid（成员卡片栅格，最小 230px 自适应列）。 */
/** 成员列表（用户迭代 2026-09 七）：与领队卡同款竖排——一行一个成员占满整行。 */
const MEMBER_LIST_CLASS = 'flex flex-col gap-2.5';

/** 团队小卡片（用户迭代 2026-09 八）：纵排三段式——头行（名称 + 人数）、
 * 目标一行（截断，给卡片一个「身体」），底栏以上边框分区放成员略缩图 +
 * 「详情/删除」。整卡可点进详情；底色/边框/悬停仍由
 * .eteams-team-card 样式表接管，p-3.5 = 卡内呼吸感。 */
const TEAM_CARD_CLASS = 'flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-3.5';

/**
 * 团队：新增团队（弹窗，名称即建）+ 团队列表/详情两级视图（用户迭代
 * 2026-09）。列表态是长条形团队卡（名称 + 阶段徽标 + 进度 + 右侧成员
 * 头像略缩图最多 3 个），点击卡片进入该团队的详情——成员栅格、拉人、
 * 移出等只在详情视图出现。
 */
export function TeamTab({
  sessionId,
  pool,
  team,
  roster,
  memberCap,
  onSelectTeam,
  agentActivity,
  onOpenReports,
}: {
  /** Current session id; undefined on the overlay panel (no session yet). */
  sessionId: string | undefined;
  /** All teams in the pool (卡片化：团队列表在这里选择). */
  pool: TeamSnapshot[];
  team: TeamSnapshot | undefined;
  roster: RosterMember[];
  /** 每队成员上限（host /state maxMembers）：添加成员弹窗的购物车配额。 */
  memberCap: number;
  onSelectTeam: (teamId: string) => void;
  /** Member subagent activity dots (docs/20.4 P4): childId → running/inactive. */
  agentActivity: Record<string, string>;
  onOpenReports: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 列表/详情两级视图（用户迭代 2026-09）：null=列表（小卡片栅格），非 null=
  // 详情（该团队 id）。弹窗建团成功后自动跳进新团队详情。
  const [detailId, setDetailId] = useState<string | null>(null);
  // 创建弹窗开合（组件内瞬态）：页头「＋ 新增团队」按钮打开；卸载即复位
  // （切 tab 重挂不残留——用户反馈 2026-09 的自开弹窗类问题不再可能）。
  const [createOpen, setCreateOpen] = useState(false);
  // 添加成员弹窗（用户迭代 2026-09：Ele.me 点餐式）开合；详情态成员操作
  // （模型选择/移出/领队移除）的错误就地提示，不再静默吞掉。
  const [addOpen, setAddOpen] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // 成员详情页（用户迭代 2026-09 四）：点成员/领队卡进入——成员详情与角色
  // 详情是两份独立数据（加入时复制），这里查看编辑成员自己的那份。null =
  // 成员栅格；kind='captain' = 领队详情（手册只读）。
  const [memberDetail, setMemberDetail] = useState<
    { kind: 'captain' } | { kind: 'member'; name: string } | null
  >(null);
  const [modelSavingName, setModelSavingName] = useState<string | null>(null);
  // 删除团队（用户迭代 2026-09 七）：小卡片「删除」按钮 → 确认弹窗。null =
  // 收起；deleting 提交中防连点；错误就地显示在弹窗内。
  const [deleteTarget, setDeleteTarget] = useState<{ teamId: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 模型目录（用户迭代 2026-09：模型选择与对话一致；同日二级菜单）：与对话
  // /model 选择同一共享目录（ctx.modelDirectories，只读），loading/failed/
  // reload 与对话选择器打开时刷新、错误条+重试同款；catalog 为 null = 服务
  // 缺失（旧运行时），退回静态选项。成员/领队卡的选项与推理等级词汇表都
  // 来自这里。
  const modelCatalog = useModelCatalog(sessionId);
  // 面板创建团队绑定当前会话（领队即该会话代理）；浮层/无会话时没有可绑定的
  // 会话，创建按钮禁用并给出指引，而不是提交后吃 400 错误。
  const canCreate = typeof sessionId === 'string' && sessionId !== '';

  const create = async (): Promise<void> => {
    if (busy || !canCreate || name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const created = await createTeamViaPanel(sessionId, name.trim());
      setName('');
      setCreateOpen(false);
      // 创建成功即选中并进入新团队详情（从 /state 快照回读前先按返回 id 落位）。
      if (created.teamId !== '') {
        onSelectTeam(created.teamId);
        setDetailId(created.teamId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const detailTeam = detailId === null ? null : (pool.find((t) => t.teamId === detailId) ?? null);

  // 删除团队（用户迭代 2026-09 七）：确认弹窗提交——host 端 deleteTeam 只放行
  // staged/completed/halted（running 拒绝，错误就地显示）；成功后清弹窗、若删
  // 的是当前选中团队则把看板联动选中清空（'' → find 落空），并刷新快照。
  const confirmDeleteTeam = (): void => {
    if (deleteTarget === null || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    void deleteTeam(deleteTarget.teamId)
      .then(() => {
        const removedId = deleteTarget.teamId;
        setDeleteTarget(null);
        if (team?.teamId === removedId) onSelectTeam('');
        refreshActivitySoon();
      })
      .catch((e) => {
        setDeleteError(memberOpError(e));
      })
      .finally(() => setDeleting(false));
  };

  // 详情态成员操作（用户迭代 2026-09）：失败统一落到 detailError 就地展示。
  const memberOpError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // 行值 → POST body（与对话 /model 选择的 selectionOf 同语义，用户迭代
  // 2026-09：模型选择与对话一致）：行 id 为 `provider/model`；换模型取该
  // 模型目录默认强度（model.reasoning.defaultEffort——对话 /model 弹层的
  // selectionOf 同款）；同一路线重选由菜单自行关闭不上送（对话 choose()
  // 同款）。目录查不到的旧路线按裸模型 id 下发（host 按配置解析 provider）。
  // 'inherit' = 清 override（跟随：docs/35 §3#5——model 空串=继承领队会话
  // 模型，host 空 body 即重置为跟随）。null = 非法行值（防御）。
  const routeBody = (
    value: string,
    stored: RouteTriple,
  ): { model?: string; reasoningEffort?: string } | null => {
    if (value === 'inherit') return {};
    const slash = value.indexOf('/');
    if (slash === -1) {
      // 目录缺失时的静态回退选项（旧版裸模型 id）：按裸模型 id 下发。
      return { model: value };
    }
    if (slash <= 0 || slash === value.length - 1) return null;
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    const row = catalogRow(modelCatalog.catalog, provider, model);
    // 同模型跨提供方时以目录行核对 provider；反查不到的旧路线按裸 model 下发
    // （stored.provider 已随快照瘦身砍掉，provider 由目录反推）。
    const effort =
      stored.model === model && catalogRowByModel(modelCatalog.catalog, stored.model) !== null
        ? (stored.reasoningEffort ?? row?.model.reasoning?.defaultEffort)
        : row?.model.reasoning?.defaultEffort;
    return {
      model,
      ...(effort !== undefined && effort !== '' ? { reasoningEffort: effort } : {}),
    };
  };

  const changeModel = (memberName: string, value: string): void => {
    if (detailTeam === null) return;
    const member = detailTeam.members.find((m) => m.name === memberName);
    if (member === undefined) return;
    const previous: RouteTriple = {
      model: member.model,
      reasoningEffort: member.reasoningEffort,
    };
    const body = routeBody(value, previous);
    if (body === null) return;
    setDetailError(null);
    setModelSavingName(memberName);
    // 选择即变（对话 choose() 同款本地即时性）：先打乐观补丁——触发器文案/
    // 勾选/推理等级入口不等 POST + 1s 轮询；pending 覆盖层防在途旧快照闪回，
    // POST 成功立即快照确认，失败回滚 + 就地报错。
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'member', name: memberName },
      route: { model: body.model ?? '', reasoningEffort: body.reasoningEffort ?? null },
    };
    applyRoutePatch(patch);
    // inherit = 跟随（host 空 body = 重置）；其余按会话模型目录（与对话一致）。
    void setMemberModel(detailTeam.teamId, memberName, body)
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(memberOpError(e));
      })
      .finally(() => setModelSavingName(null));
  };

  // 推理等级（与对话「推理等级」二级菜单同一词汇表）：只对已有具体路线的
  // 成员生效——整条路线重发（host 每次整路由写入）。effort 为 null = 提供方
  // 默认（对话 chooseEffort 的 provider-default 项同款）：重发时省略
  // reasoningEffort，host 即无强度 override。跟随中（model 空串）不可单独改。
  const changeMemberEffort = (memberName: string, effort: string | null): void => {
    if (detailTeam === null) return;
    const member = detailTeam.members.find((m) => m.name === memberName);
    if (member === undefined || member.model === '') {
      return;
    }
    setDetailError(null);
    setModelSavingName(memberName);
    const previous: RouteTriple = {
      model: member.model,
      reasoningEffort: member.reasoningEffort,
    };
    // 同 changeModel：乐观补丁即时生效，POST 确认/回滚。
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'member', name: memberName },
      route: { ...previous, reasoningEffort: effort },
    };
    applyRoutePatch(patch);
    void setMemberModel(detailTeam.teamId, memberName, {
      model: member.model,
      ...(effort !== null && effort !== '' ? { reasoningEffort: effort } : {}),
    })
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(memberOpError(e));
      })
      .finally(() => setModelSavingName(null));
  };

  const removeMember = (memberName: string): void => {
    if (detailTeam === null) return;
    setDetailError(null);
    void removeTeamMember(detailTeam.teamId, memberName).catch((e) =>
      setDetailError(memberOpError(e)),
    );
  };

  const removeLeader = (): void => {
    if (detailTeam === null) return;
    setDetailError(null);
    void setTeamLeaderRemoved(detailTeam.teamId, true).catch((e) =>
      setDetailError(memberOpError(e)),
    );
  };

  return (
    <div>
      {/* 团队页头（S24-2，官网 h2 签名）：标题 + 右侧「＋ 新增团队」主按钮。
        创建弹窗只从这里开——跳转信号自开弹窗已撤（用户反馈 2026-09：一进
        团队页就弹新增弹窗很突兀）。 */}
      <PageHeader label="团队">
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          新增团队
        </Button>
      </PageHeader>
      {/* 新增团队弹窗（用户迭代 2026-09）：shadcn Dialog + Input，输入名称按
      「新增团队」创建——创建由面板会话绑定限制（canCreate）同表单一致。 */}
      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          if (!next) {
            setCreateOpen(false);
            setError(null);
            setName('');
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle>新增团队</DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              {canCreate
                ? '只需名称即可创建——目标与任务在对话中与领队继续完善。'
                : '当前还没有进行中的对话——开始对话后才能创建团队。'}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            autoFocus
            placeholder="团队名称，如：文档迁移小组"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
          {error !== null && <FormErrorNote>{error}</FormErrorNote>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || !canCreate || name.trim() === ''}
              onClick={() => void create()}
            >
              新增团队
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除团队确认弹窗（用户迭代 2026-09 七）：小卡片「删除」→ 二次确认。
      host 只放行 staged/completed/halted；running 拒绝的错误就地显示。 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle>删除团队</DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              确定删除「{deleteTarget?.name ?? ''}」？团队记录将永久移除，不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteError !== null && <FormErrorNote>{deleteError}</FormErrorNote>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deleting}
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={confirmDeleteTeam}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 列表态：小卡片栅格（用户迭代 2026-09 八，复用 CARD_GRID_CLASS）——
      最小 210px 自适应列，窄两列宽三列。卡片纵排三段式：头行（名称 + 人数）、
      目标一行（截断）、底栏（上边框分区）放成员略缩图 + 「详情/删除」；整卡
      可点进详情，按钮区 stopPropagation 不触发整卡点击。删除走确认弹窗
      （host 只放行 staged/completed/halted）。当前团队不再做选中高亮描边，
      目标行也只在有真目标时出现（用户迭代 2026-09 九）。 */}
      {detailTeam === null && pool.length > 0 && (
        <Card className={cn(PANEL_CARD_CLASS, 'pb-3')}>
          <div className="mb-2.5 flex items-center gap-2">
            <h3 className={LIST_TITLE_CLASS}>团队</h3>
            <span className={LIST_COUNT_CLASS}>{pool.length} 个</span>
          </div>
          <div className={CARD_GRID_CLASS}>
            {pool.map((t) => {
              // 人数含领队（用户迭代 2026-09 六：领队也算成员，初始化默认在团；
              // 移出后只剩成员）——与详情页/添加弹窗同口径。
              const headcount = t.members.length + (t.leaderRemoved ? 0 : 1);
              const faces = t.leaderRemoved ? t.members : [t.captain, ...t.members];
              return (
                <div
                  key={t.teamId}
                  className={cn('eteams-team-card', TEAM_CARD_CLASS)}
                  onClick={() => {
                    // 进详情同时选中该团队：看板/任务/汇报的联动对象跟着走
                    // （原卡片点击的选中语义保留，只是不再画高亮描边）。
                    onSelectTeam(t.teamId);
                    setDetailId(t.teamId);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="eteams-team-name min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                      {t.name}
                    </span>
                    <span className={LIST_COUNT_CLASS}>{headcount} 人</span>
                  </div>
                  {/* 进度一行（docs/35 §3：goal 字段已砍——小卡片身体改为任务
                  进度；无任务时留空保持三段式排版）。 */}
                  {t.progress.total > 0 && (
                    <p className="truncate text-xs text-muted-foreground">
                      任务 {t.progress.completed}/{t.progress.total} 完成
                      {t.progress.active > 0 ? ` · ${t.progress.active} 进行中` : ''}
                    </p>
                  )}
                  {/* 底栏（上边框分区）：成员略缩图（领队 + 成员头像最多 3 个，
                  超出 +N；小号头像负间距叠放，滑过整组间距松开、滑过单个放大
                  ——动效由样式表 .eteams-team-avatars 驱动，title 兜底全名）
                  + 详情/删除。 */}
                  <div className="mt-0.5 flex items-center gap-2 border-t border-solid pt-2.5">
                    <div className="eteams-team-avatars flex min-w-0 flex-1 items-center">
                      {faces.slice(0, 3).map((m) => (
                        <span
                          key={m.name}
                          className="inline-flex shrink-0 rounded-full ring-2 ring-[color:var(--background)]"
                          title={m.name}
                        >
                          <Avatar
                            name={m.name}
                            seed={m.avatar?.seed}
                            salt={m.avatar?.salt}
                            size={20}
                          />
                        </span>
                      ))}
                      {headcount > 3 && (
                        <span
                          className={cn(
                            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold',
                            'bg-muted text-muted-foreground ring-2 ring-[color:var(--background)]',
                          )}
                          title={`其余 ${headcount - 3} 人`}
                        >
                          +{headcount - 3}
                        </span>
                      )}
                    </div>
                    <div
                      className="flex shrink-0 gap-1"
                      onClick={(e) => {
                        // 按钮区不冒泡：点详情/删除不触发整卡的进详情点击。
                        e.stopPropagation();
                      }}
                    >
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onSelectTeam(t.teamId);
                          setDetailId(t.teamId);
                        }}
                      >
                        详情
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget({ teamId: t.teamId, name: t.name });
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {detailTeam === null && pool.length === 0 && (
        <div className={EMPTY_CLASS}>还没有团队。点右上角「新增团队」创建第一个团队。</div>
      )}

      {/* 成员详情页（用户迭代 2026-09 四）：点成员/领队卡进来，盖在成员栅格
      之上——查看/编辑成员自己的手册副本、同步回角色库。 */}
      {detailTeam !== null && memberDetail !== null && (
        <MemberDetailView
          team={detailTeam}
          target={memberDetail}
          onBack={() => setMemberDetail(null)}
          onOpenReports={onOpenReports}
        />
      )}

      {/* 详情态（用户迭代 2026-09）：点长条卡片才进来——团队成员、拉人组队
      都在这里。返回按钮回列表。 */}
      {detailTeam !== null && memberDetail === null && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDetailId(null);
                setDetailError(null);
                setMemberDetail(null);
              }}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回团队列表
            </Button>
            <span className="text-lg font-semibold tracking-tight text-foreground">
              {detailTeam.name}
            </span>
            <span className={LIST_COUNT_CLASS}>
              任务 {detailTeam.progress.completed}/{detailTeam.progress.total} 完成
            </span>
          </div>

          {/* 团队成员卡（S13/S14）：容器 shadcn Card（PANEL_CARD_CLASS 覆盖层，
          S12 先例）；拉人下拉已移除（用户迭代 2026-09），改为右上「添加成员」
          按钮点开点餐式弹窗。 */}
          <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
            <div className="mb-2.5 flex items-center gap-2">
              <h3 className={LIST_TITLE_CLASS}>团队成员</h3>
              <span className={LIST_COUNT_CLASS}>
                {detailTeam.members.length + (detailTeam.leaderRemoved ? 0 : 1)}/{memberCap} 人 ·{' '}
                {detailTeam.leaderRemoved ? '领队已移除' : '含领队'}
              </span>
              <span className="flex-1" />
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setDetailError(null);
                  setAddOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                添加成员
              </Button>
            </div>
            {detailError !== null && (
              <FormErrorNote className="mb-2.5">{detailError}</FormErrorNote>
            )}
            <div className={MEMBER_LIST_CLASS}>
              {!detailTeam.leaderRemoved && (
                <LeaderCard
                  captain={detailTeam.captain}
                  onRemove={removeLeader}
                  onOpenDetail={() => setMemberDetail({ kind: 'captain' })}
                />
              )}
              {detailTeam.members.map((m) => (
                <MemberCard
                  key={m.name}
                  member={m}
                  catalog={modelCatalog}
                  activity={m.childId !== null ? agentActivity[m.childId] : undefined}
                  onRemove={removeMember}
                  onModelChange={changeModel}
                  onEffortChange={changeMemberEffort}
                  modelSaving={modelSavingName === m.name}
                  onOpenDetail={() => setMemberDetail({ kind: 'member', name: m.name })}
                />
              ))}
              {detailTeam.members.length === 0 && (
                <div className={MUTED_CLASS}>
                  还没有成员——点右上角「添加成员」，像点餐一样把角色加进团队。
                </div>
              )}
            </div>
          </Card>

          {/* 添加成员弹窗（用户迭代 2026-09）：Ele.me 点餐式角色加团。 */}
          <AddMembersDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            team={detailTeam}
            roster={roster}
            memberCap={memberCap}
          />
        </>
      )}
    </div>
  );
}
