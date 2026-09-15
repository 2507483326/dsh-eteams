/**
 * 团队列表页（docs/13.3 团队）：团队卡片栅格 + 建团/删团弹窗——自 teamTab
 * 拆出（docs/44 M4，行为零变更），路由 /team。页头（含「＋ 新增团队」按钮）
 * 与创建弹窗留页内（与拆分前 TeamTab 常驻渲染一致——创建弹窗开合是组件内
 * 瞬态，用户反馈 2026-09：跳转信号自开弹窗撤销，创建只从这里进）；删除确认
 * 弹窗同页内（host 只放行 staged/completed/halted）。卡片点击/详情钮进详情
 * ——原 detailId 态改 /team/:teamId 路由（team/teamDetailPage），选中
 * 语义（看板/任务/汇报联动）保留 onSelectTeam 派发。
 *
 * @module dsh-eteams/client/pages/team/teamPage
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import { createTeamViaPanel, deleteTeam } from '../../lib/api';
import { refreshActivitySoon, type TeamSnapshot } from '../../lib/monitor';
import { cn } from '../../lib/cn';
import { errorMessageOf, runWithBusy } from '../../lib/errors';
import { AvatarStack } from '../../components/avatarStack';
import { ConfirmDeleteDialog } from '../../components/confirmDeleteDialog';
import { DeleteButton } from '../../components/deleteButton';
import { FormDialog, FormFooterActions } from '../../components/formDialog';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { FormErrorNote, PageHeader } from '../shared/components';
import {
  EMPTY_CLASS,
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  PANEL_CARD_CLASS,
  TEAM_CHIP_CLASS,
  TEAM_GRID_CLASS,
} from '../shared/styles';

/** ================================== 类型 ================================== */

/** 路由页入参（壳状态经 routes.tsx 传入，数据流与拆分前逐位一致）。 */
export interface TeamPageProps {
  /** Current session id; undefined on the overlay panel (no session yet). */
  sessionId: string | undefined;
  /** All teams in the pool (卡片化：团队列表在这里选择). */
  pool: TeamSnapshot[];
  /** 当前选中团队（删除联动：删的是当前选中团队则清空看板选择 ''）。 */
  team: TeamSnapshot | undefined;
  /** 选中团队回写（ui/setSelectedTeam——看板/任务/汇报联动对象跟着走）。 */
  onSelectTeam: (teamId: string) => void;
}

/** ================================== 样式类 ================================== */

/** 团队小卡片（用户迭代 2026-09 八）：纵排两段式——头部放徽章 + 名称 + 人数，
 * 底栏（上边框分区）放成员略缩图 + 「详情/删除」；min-h + justify-between
 * 把两段上下撑开（卡片拉长、中段留白，用户「拉长好看一点」），整卡可点进
 * 详情；底色/边框/悬停仍由 .eteams-team-card 样式表接管。
 * （用户迭代 2026-09-07：头部压 pb-2.5 与底栏 pt-2.5 对称——分割线上下
 * 间距一致；标题行加对话选中团队同款首字徽章。） */
const TEAM_CARD_CLASS =
  'flex min-h-28 min-w-0 cursor-pointer flex-col justify-between rounded-xl p-4';

/** ================================== 主组件 ================================== */

/**
 * 团队列表（用户迭代 2026-09 八）：长条形小卡片栅格——头部放名称 + 人数，
 * 底栏放成员略缩图（领队 + 成员头像最多 3 个，超出 +N）+「详情/删除」；
 * 整卡可点进详情，按钮区 stopPropagation 不触发整卡点击。删除走确认弹窗
 * （host 只放行 staged/completed/halted）。当前团队不再做选中高亮描边，
 * 目标行也只在有真目标时出现（用户迭代 2026-09 九）。
 */
export function TeamPage({ sessionId, pool, team, onSelectTeam }: TeamPageProps): ReactNode {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 创建弹窗开合（组件内瞬态）：页头「＋ 新增团队」按钮打开；卸载即复位
  // （切 tab 重挂不残留——用户反馈 2026-09 的自开弹窗类问题不再可能）。
  const [createOpen, setCreateOpen] = useState(false);
  // 删除团队（用户迭代 2026-09 七）：小卡片「删除」按钮 → 确认弹窗。null =
  // 收起；deleting 提交中防连点；错误就地显示在弹窗内。
  const [deleteTarget, setDeleteTarget] = useState<{ teamId: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 面板创建团队绑定当前会话（领队即该会话代理）；浮层/无会话时没有可绑定的
  // 会话，创建按钮禁用并给出指引，而不是提交后吃 400 错误。
  const canCreate = typeof sessionId === 'string' && sessionId !== '';

  /* —— 事件处理 —— */

  const create = async (): Promise<void> => {
    // M7-5 busy/error 壳收口 runWithBusy（守卫留在调用点——busy 中/会话未绑/
    // 名空仍在此早退，与原时机一致）。
    if (busy || !canCreate || name.trim() === '') return;
    await runWithBusy(
      async () => {
        const created = await createTeamViaPanel(sessionId, name.trim());
        setName('');
        setCreateOpen(false);
        // 创建成功即选中并进入新团队详情（从 /state 快照回读前先按返回 id 落位
        // ——原 setDetailId(created.teamId) 改路由导航，M4 拆页）。
        if (created.teamId !== '') {
          onSelectTeam(created.teamId);
          navigate(`/team/${created.teamId}`);
        }
      },
      setBusy,
      setError,
    );
  };

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
        setDeleteError(errorMessageOf(e));
      })
      .finally(() => setDeleting(false));
  };

  return (
    // 列表卡满高（用户迭代 2026-09-07）：页根占内容列剩余空间，卡 flex-1
    // 拉满、栅格 min-h-0 内部滚动（卡满高、页头常驻可视）。
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 团队页头（S24-2，官网 h2 签名）：标题 + 右侧「＋ 新增团队」主按钮。
        创建弹窗只从这里开——跳转信号自开弹窗已撤（用户反馈 2026-09：一进
        团队页就弹新增弹窗很突兀）。页头与创建弹窗在详情页同款常驻（拆分前
        TeamTab 列表/详情两态共用同一页头）。 */}
      <PageHeader label="团队">
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          新增团队
        </Button>
      </PageHeader>
      {/* 新增团队弹窗（用户迭代 2026-09）：shadcn Dialog + Input，输入名称按
      「新增团队」创建——创建由面板会话绑定限制（canCreate）同表单一致。
      （M7-1 壳收口 FormDialog/FormFooterActions，开合复位守卫留在调用点。） */}
      <FormDialog
        open={createOpen}
        onOpenChange={(next) => {
          if (!next) {
            setCreateOpen(false);
            setError(null);
            setName('');
          }
        }}
        title="新增团队"
        description={
          canCreate
            ? '只需名称即可创建——目标与任务在对话中与领队继续完善。'
            : '当前还没有进行中的对话——开始对话后才能创建团队。'
        }
      >
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
        <FormFooterActions
          cancelDisabled={busy}
          confirmDisabled={busy || !canCreate || name.trim() === ''}
          confirmLabel="新增团队"
          onCancel={() => setCreateOpen(false)}
          onConfirm={() => void create()}
        />
      </FormDialog>

      {/* 删除团队确认弹窗（用户迭代 2026-09 七）：小卡片「删除」→ 二次确认。
      host 只放行 staged/completed/halted；running 拒绝的错误就地显示。
      （M7-1 壳收口 ConfirmDeleteDialog，破坏性确认钮档。） */}
      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        title="删除团队"
        description={<>确定删除「{deleteTarget?.name ?? ''}」？团队记录将永久移除，不可恢复。</>}
        error={deleteError !== null && <FormErrorNote>{deleteError}</FormErrorNote>}
        confirmLabel="删除"
        confirmBusy={deleting}
        onConfirm={confirmDeleteTeam}
      />

      {/* 列表态：小卡片栅格（用户迭代 2026-09 八；2026-09-07 换
      TEAM_GRID_CLASS 加宽一档——最小 240px 自适应列，窄列少宽列多，不并轨
      CARD_GRID_CLASS 以免牵动角色列表）。卡片纵排两段式：头部放徽章 +
      名称 + 人数，底栏（上边框分区）放成员略缩图 + 「详情/删除」；整卡
      可点进详情，按钮区 stopPropagation 不触发整卡点击。删除走确认弹窗
      （host 只放行 staged/completed/halted）。当前团队不再做选中高亮描边，
      目标行也只在有真目标时出现（用户迭代 2026-09 九）。 */}
      {pool.length > 0 && (
        <Card className={cn(PANEL_CARD_CLASS, 'pb-3 flex min-h-0 flex-1 flex-col')}>
          {/* 标题 + 计数（2026-09-15 列表页头口径，同 rosterPage/tasksPage）：
            计数补「共」并与标题底部对齐——收进 items-baseline 子行，不再受
            外层 items-center 摆布。 */}
          <div className="mb-2.5 flex items-center gap-2">
            <div className="flex min-w-0 flex-none items-baseline gap-2">
              <h3 className={cn(LIST_TITLE_CLASS, 'flex-none')}>团队</h3>
              <span className={LIST_COUNT_CLASS}>共 {pool.length} 个</span>
            </div>
          </div>
          <div className={cn(TEAM_GRID_CLASS, 'min-h-0 flex-1 content-start overflow-y-auto')}>
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
                    navigate(`/team/${t.teamId}`);
                  }}
                >
                  <div className="min-w-0 pb-2.5">
                    {/* 标题行：对话选中团队同款首字徽章（shared/styles 的
                    TEAM_CHIP_CLASS——与 teamsButton 收编同一常量，视觉由构造
                    保证一致）+ 名称；头部压 pb-2.5 与底栏 pt-2.5 对称，
                    分割线上下间距一致（用户迭代 2026-09-07）。 */}
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={TEAM_CHIP_CLASS} aria-hidden={true}>
                        {t.name.slice(0, 1)}
                      </span>
                      <div className="eteams-team-name truncate text-base font-semibold text-foreground">
                        {t.name}
                      </div>
                    </div>
                    <p className={cn('m-0 mt-1.5', LIST_COUNT_CLASS)}>{headcount} 人</p>
                  </div>
                  {/* 头部放名称 + 人数（用户迭代：去掉「任务 X/Y 完成」进度行
                  ——进度在任务页/详情页看；人数从头行挪到名称下方）。 */}
                  {/* 底栏（上边框分区）：成员略缩图（领队 + 成员头像最多 3 个，
                  超出 +N；小号头像负间距叠放，滑过整组间距松开、滑过单个放大
                  ——动效由样式表 .eteams-team-avatars 驱动，title 兜底全名）
                  + 详情/删除。 */}
                  <div className="mt-auto flex items-center gap-2 border-t border-solid pt-2.5">
                    <div className="eteams-team-avatars flex min-w-0 flex-1 items-center">
                      {/* 成员略缩图（M7-7 收口 components/avatarStack）：领队 +
                      成员头像最多 3 个，超出 +N；小号头像负间距叠放，滑过整组
                      间距松开、滑过单个放大——动效由样式表
                      .eteams-team-avatars 驱动，title 兜底全名。 */}
                      <AvatarStack
                        people={faces.map((m) => ({
                          name: m.name,
                          seed: m.avatar?.seed,
                          salt: m.avatar?.salt,
                        }))}
                        size={20}
                        max={3}
                        wrapperClass="inline-flex shrink-0 rounded-full ring-2 ring-[color:var(--background)]"
                        overflow
                      />
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
                          navigate(`/team/${t.teamId}`);
                        }}
                      >
                        详情
                      </Button>
                      <DeleteButton
                        label="删除"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget({ teamId: t.teamId, name: t.name });
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {pool.length === 0 && (
        <div className={EMPTY_CLASS}>还没有团队。点右上角「新增团队」创建第一个团队。</div>
      )}
    </div>
  );
}
