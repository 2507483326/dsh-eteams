/**
 * 成员详情页（docs/13.3 团队 / 用户迭代 2026-09 四）：查看成员自己的手册
 * 副本（只读——用户迭代 2026-09-07「团队成员详情里面去掉汇报记录，去掉
 * 编辑和同步到角色按钮」：编辑/同步/汇报入口撤，手册卡与领队一致走只读
 * 渲染）；领队也走这一页：手册由系统合成，只读。自 teamMembers 拆出
 * （docs/44 M4），路由 /team/:teamId/member/:name——:teamId 路由参数即团队
 * id（快照池回查），:name 即成员/领队名（react-router 自动解码）；原
 * memberDetail 的 kind（领队/成员）语义并入路由：:name 命中成员行 = 成员
 * 详情，命中领队名 = 领队详情。页头（「团队 + ＋ 新增团队」）与创建弹窗
 * 同款常驻——拆分前成员详情视图在 TeamTab 树内渲染，页头原样可达（创建
 * 成功落同 :name 的新队成员/领队详情——原 detailId 换队 + memberDetail
 * 保留的同态映射）。领队卡/成员卡见 memberCards.tsx（本页头领队徽标
 * ROLE_CHIP_CLASS 自那里导入）。
 *
 * @module dsh-eteams/client/pages/team/memberDetailPage
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import { createTeamViaPanel } from '../../lib/api';
import type { TeamSnapshot } from '../../lib/monitor';
import { cn } from '../../lib/cn';
import { runWithBusy } from '../../lib/errors';
import { MEMBER_STATUS_LABELS, memberTone } from '../../features/tasks/taskDisplayStatus';
import { Avatar } from '../../features/avatar/avatar';
import { FormDialog, FormFooterActions } from '../../components/formDialog';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
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
}

/** ================================== 主组件 ================================== */

/**
 * 成员详情页（原 MemberDetailView 收编为路由页）：成员详情与角色详情是两份
 * 独立数据——加入团队时从角色库复制一份，之后各自演化。手册只读展示；返回
 * 钮回团队详情页（原 onBack = 收起 memberDetail 态）。
 */
export function MemberDetailPage({ sessionId, pool, onSelectTeam }: MemberDetailPageProps): ReactNode {
  const navigate = useNavigate();
  // :teamId 即团队 id（快照池回查），:name 即成员/领队名。
  const { teamId, name } = useParams();
  // 页头创建弹窗（与列表/详情页同款常驻——拆分前成员详情视图在 TeamTab 树
  // 内，页头按钮原样可达）：表单瞬态，卸载即复位。
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
  const memberRow =
    team === null || name === undefined ? undefined : team.members.find((m) => m.name === name);
  const target:
    | { kind: 'captain' }
    | { kind: 'member'; name: string; employeeId: string | null }
    | null =
    memberRow !== undefined && name !== undefined
      ? { kind: 'member', name, employeeId: memberRow.employeeId }
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
  // 返回钮（用户迭代 2026-09-08：页面返回统一收口 PageHeader onBack 槽，
  // 页头行最右图标钮——原 BackBar 文案钮撤，成员/领队详情与 not-found 卡
  // 窗口共用同一返回位）。
  const teamHeader = (
    <>
      <PageHeader label="团队" onBack={onBack}>
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
        {/* 返回钮走上方页头 onBack（用户迭代 2026-09-08 统一收口）——
        卡内原 BackBar 文案钮撤。 */}
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
          <div className={MUTED_CLASS}>成员不在团队里——可能刚被移出。</div>
        </Card>
      </div>
    );
  }

  // 详情页展示口径：优先成员自己的手册副本；旧成员没有副本时按结构字段
  // 合成骨架。
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

  return (
    <div>
      {teamHeader}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* 返回钮走上方页头 onBack（用户迭代 2026-09-08 统一收口）——
        标题行原 BackBar 文案钮撤，只留成员名 + 角色/状态徽标。 */}
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
          {/* 头像（描边环已撤——用户迭代 2026-09-07，描边统一走 Avatar
          默认 1px 深灰框、白底、无间隔）。 */}
          <Avatar
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
          </div>
        </div>
      </Card>

      <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
        <div className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
          <span className="flex-1">
            {target.kind === 'captain' ? '领队手册（Markdown）' : '成员手册（Markdown）'}
          </span>
          {target.kind === 'captain' && (
            <span className={MUTED_CLASS}>领队手册由系统合成，只读</span>
          )}
        </div>
        {/* 手册只读（用户迭代 2026-09-07：编辑/同步到角色撤——成员与领队
        同款 MarkdownDoc；手册改动去「角色」页编辑角色库）。 */}
        <MarkdownDoc text={display} />
      </Card>
    </div>
  );
}
