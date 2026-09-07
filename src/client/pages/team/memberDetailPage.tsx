/**
 * 成员详情页（docs/13.3 团队 / 用户迭代 2026-09 四）：查看/编辑成员自己的
 * 手册副本（「保存」只写成员记录），「同步到角色」把当前手册写回角色库同名
 * 角色（副本成员无同名角色时按成员记录新建）；领队也走这一页：手册由系统
 * 合成，只读、无保存/同步。自 teamMembers 拆出（docs/44 M4，行为零变更），
 * 路由 /team/:teamId/member/:name——:teamId 路由参数即团队 id（快照池回查），
 * :name 即成员/领队名（react-router 自动解码）；原 memberDetail 的 kind
 * （领队/成员）语义并入路由：:name 命中成员行 = 成员详情，命中领队名 =
 * 领队详情。页头（「团队 + ＋ 新增团队」）与创建弹窗同款常驻——拆分前成员
 * 详情视图在 TeamTab 树内渲染，页头原样可达（创建成功落同 :name 的新队
 * 成员/领队详情——原 detailId 换队 + memberDetail 保留的同态映射）。
 * 领队卡/成员卡见 memberCards.tsx（本页头领队徽标 ROLE_CHIP_CLASS
 * 自那里导入）。
 *
 * @module dsh-eteams/client/pages/team/memberDetailPage
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import { createTeamViaPanel, syncMemberToRoster, updateMemberPersona } from '../../lib/api';
import { employeeIdNumberOf, refreshActivitySoon, type TeamSnapshot } from '../../lib/monitor';
import { cn } from '../../lib/cn';
import { runWithBusy } from '../../lib/errors';
import { MdEditor } from '../../features/mdEditor/mdEditor';
import { MEMBER_STATUS_LABELS, memberTone } from '../../features/tasks/taskDisplayStatus';
import { AvatarRing } from '../../components/avatarRing';
import { BackBar } from '../../components/backBar';
import { FormDialog, FormFooterActions } from '../../components/formDialog';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { toast } from '../../hooks/useToast';
import { MarkdownDoc } from '../shared/markdownDoc';
import { handbookSeed, type HandbookSource } from '../roster/buildDraft';
import { ROLE_CHIP_CLASS } from './memberCards';
import { FormErrorNote, PageHeader, Pill } from '../shared/components';
import { MUTED_CLASS, PANEL_CARD_CLASS, SECTION_TITLE_CLASS } from '../shared/styles';

/** ================================== 类型 ================================== */

/** 路由页入参（壳状态经 routes.tsx 传入，数据流与拆分前逐位一致）。 */
export interface MemberDetailPageProps {
  /** Current session id; undefined on the overlay panel (no session yet). */
  sessionId: string | undefined;
  /** 全部团队池（:teamId 回查团队快照）。 */
  pool: TeamSnapshot[];
  /** 选中团队回写（页头建团成功落新团队——原创建流程 onSelectTeam 保留）。 */
  onSelectTeam: (teamId: string) => void;
  /** 「汇报记录」跳汇报页（壳 navigate('/reports') + 选成员）。 */
  onOpenReports?: (name: string) => void;
}

/** ================================== 主组件 ================================== */

/**
 * 成员详情页（原 MemberDetailView 收编为路由页）：成员详情与角色详情是两份
 * 独立数据——加入团队时从角色库复制一份，之后各自演化。编辑/同步/toast 反馈
 * 行为逐位保持；返回钮回团队详情页（原 onBack = 收起 memberDetail 态）。
 */
export function MemberDetailPage({
  sessionId,
  pool,
  onSelectTeam,
  onOpenReports,
}: MemberDetailPageProps): ReactNode {
  const navigate = useNavigate();
  // :teamId 即团队 id（快照池回查），:name 即成员/领队名。
  const { teamId, name } = useParams();
  // 编辑缓冲：null = 只读渲染；string = 编辑中。进入编辑时从当前手册播种。
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 页头创建弹窗（与列表/详情页同款常驻——拆分前成员详情视图在 TeamTab 树
  // 内，页头按钮原样可达）：表单瞬态，卸载即复位。error 是手册编辑错误，
  // 创建表单错误独立命名 createError（原两态分属 TeamTab/MemberDetailView
  // 两个组件的各自 error）。
  const [createName, setCreateName] = useState('');
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // 面板创建团队绑定当前会话（领队即该会话代理）；浮层/无会话时没有可绑定的
  // 会话，创建按钮禁用并给出指引，而不是提交后吃 400 错误。
  const canCreate = typeof sessionId === 'string' && sessionId !== '';

  const team = teamId === undefined ? null : (pool.find((t) => t.teamId === teamId) ?? null);
  // 团队不在池中（已删/畸形 :teamId）：原 detailId 态快照回读落空即回落列表
  // 渲染的窗口，拆页后 navigate('/team')——渲染一帧空即跳列表（M3 任务详情
  // 页同款拆页差异，见 46 清单验收注记）。
  const teamFound = team !== null;
  useEffect(() => {
    if (!teamFound) navigate('/team');
  }, [teamFound, navigate]);

  // kind 并入路由：:name 命中成员行 = 成员详情；命中领队名 = 领队详情（手册
  // 只读）；两者皆不中 = 原成员不在团队里的 not-found 窗口（可能刚被移出）。
  // v7：成员数据的保存/同步按工号定位（employeeId 解析自行内显示串；导航
  // 仍按名——路由参数不动）。
  const memberRow =
    team === null || name === undefined ? undefined : team.members.find((m) => m.name === name);
  const memberEmployeeId = memberRow !== undefined ? employeeIdNumberOf(memberRow.employeeId) : null;
  const target:
    | { kind: 'captain' }
    | { kind: 'member'; name: string; employeeId: number | null }
    | null =
    memberRow !== undefined && name !== undefined
      ? { kind: 'member', name, employeeId: memberEmployeeId }
      : team !== null && name !== undefined && team.captain.name === name
        ? { kind: 'captain' }
        : null;

  if (team === null) {
    return null;
  }

  /* —— 事件处理 —— */

  // 返回团队成员（原 onBack = 收起 memberDetail 态回详情视图）。
  const onBack = (): void => {
    navigate(`/team/${team.teamId}`);
  };

  // 页头创建弹窗提交（与列表/详情页同款）：创建成功即选中并进入新团队——
  // 原 detailId 换新队、memberDetail 保留，成员/领队详情视图随新队重查
  // （成员名在新队未命中即原「成员不在团队里」卡）——映射为同 :name 的新队
  // 成员/领队详情路由（M4 拆页）。
  const create = async (): Promise<void> => {
    // M7-5 busy/error 壳收口 runWithBusy（守卫留在调用点，与原时机一致）。
    if (busy || !canCreate || createName.trim() === '') return;
    await runWithBusy(
      async () => {
        const created = await createTeamViaPanel(sessionId, createName.trim());
        setCreateName('');
        setCreateOpen(false);
        if (created.teamId !== '') {
          onSelectTeam(created.teamId);
          if (name !== undefined) {
            navigate(`/team/${created.teamId}/member/${encodeURIComponent(name)}`);
          } else {
            navigate(`/team/${created.teamId}`);
          }
        }
      },
      setBusy,
      setCreateError,
    );
  };

  // 团队页头（S24-2，官网 h2 签名）：标题 + 右侧「＋ 新增团队」主按钮 + 创建
  // 弹窗——拆分前成员详情视图在 TeamTab 树内渲染，页头原样可见（列表/详情/
  // 成员详情三态共用，含下方 not-found 卡窗口）；弹窗开合是组件内瞬态。
  const teamHeader = (
    <>
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
            setCreateError(null);
            setCreateName('');
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
          value={createName}
          autoFocus
          placeholder="团队名称，如：文档迁移小组"
          onChange={(e) => setCreateName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
        {createError !== null && <FormErrorNote>{createError}</FormErrorNote>}
        <FormFooterActions
          cancelDisabled={busy}
          confirmDisabled={busy || !canCreate || createName.trim() === ''}
          confirmLabel="新增团队"
          onCancel={() => setCreateOpen(false)}
          onConfirm={() => void create()}
        />
      </FormDialog>
    </>
  );

  if (target === null) {
    return (
      <div>
        {teamHeader}
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
          <div className={MUTED_CLASS}>成员不在团队里——可能刚被移出。</div>
          {/* 返回条（M7-3 收口 components/backBar，outline 默认档）。 */}
          <BackBar className="mt-2" label="返回团队成员" onClick={onBack} />
        </Card>
      </div>
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
    // M7-5 busy/error 壳收口 runWithBusy（空稿守卫留在调用点——早退不发请求，
    // 与原时机一致）。
    if (draft === null || saving || target.kind !== 'member') return;
    const text = draft.trim();
    if (text === '') {
      setError('手册内容为空');
      return;
    }
    // v7 R3：按工号定位保存；无号（异常旧行）不可保存——host 路由找不到人。
    if (target.employeeId === null) {
      setError('该成员没有工号，无法保存');
      return;
    }
    await runWithBusy(
      async () => {
        await updateMemberPersona(team.teamId, target.employeeId!, text);
        setDraft(null);
        // 保存反馈迁 shadcn toast()（docs/43 十九轮；原就地瞬时行 2.5s 撤除）。
        toast({ title: '✓ 已保存到成员详情' });
        refreshActivitySoon();
      },
      setSaving,
      setError,
    );
  };

  const syncToRole = async (): Promise<void> => {
    // M7-5 busy/error 壳收口 runWithBusy（空稿守卫留在调用点，与原时机一致）。
    if (syncing || target.kind !== 'member') return;
    const text = (draft ?? display).trim();
    if (text === '') {
      setError('成员手册为空，先编辑保存');
      return;
    }
    // v7 R3：按工号定位同步；无号（异常旧行）不可同步。
    if (target.employeeId === null) {
      setError('该成员没有工号，无法同步');
      return;
    }
    await runWithBusy(
      async () => {
        await syncMemberToRoster(team.teamId, target.employeeId!, text);
        if (draft !== null) setDraft(null); // 编辑中的草稿已一并落库
        // 同步反馈迁 shadcn toast()（docs/43 十九轮；原就地瞬时行 2.5s 撤除）。
        toast({ title: `✓ 已同步到角色「${view.name}」` });
        refreshActivitySoon();
      },
      setSyncing,
      setError,
    );
  };

  return (
    <div>
      {teamHeader}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* 返回条（M7-3 收口 components/backBar，outline 默认档）。 */}
        <BackBar label="返回团队成员" onClick={onBack} />
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
          {/* 头像描边环：角色详情页同款（品牌淡底档）。（M7-2 收口
          components/avatarRing。） */}
          <AvatarRing
            name={view.name}
            seed={view.avatar?.seed}
            salt={view.avatar?.salt}
            size={52}
          />
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
              {/* 保存行（M7-1 收口 FormFooterActions，ghost 取消档）+ 同步到角色
              原位外挂——与原三钮 gap-2 行同距。 */}
              <FormFooterActions
                className=""
                cancelVariant="ghost"
                cancelDisabled={saving}
                confirmDisabled={saving}
                confirmLabel="保存"
                onCancel={() => setDraft(null)}
                onConfirm={() => void save()}
              />
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
