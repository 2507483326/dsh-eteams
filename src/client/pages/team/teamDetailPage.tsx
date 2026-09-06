/**
 * 团队详情页（docs/13.3 团队）：返回条 + 成员卡列表（领队卡/成员卡：模型
 * 路线/推理等级/移出）+ 添加成员弹窗——自 teamTab 拆出（docs/44 M4，行为
 * 零变更），路由 /team/:teamId，:teamId 路由参数即原 detailId 态（选中团队
 * id）。页头（含「＋ 新增团队」按钮）与创建弹窗同款常驻（拆分前 TeamTab
 * 列表/详情两态共用同一页头——创建成功落新团队详情）；成员卡点击进成员
 * 详情——原 memberDetail 态改 /team/:teamId/member/:name 路由（见
 * memberDetailPage.tsx）。模型路线乐观补丁/推理等级/领队移除等提交回调
 * 逐位保持；详情态成员操作错误就地 FormErrorNote。
 *
 * @module dsh-eteams/client/pages/team/teamDetailPage
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import {
  createTeamViaPanel,
  removeTeamMember,
  setLeaderModel,
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
import { errorMessageOf, runWithBusy } from '../../lib/errors';
import { BackBar } from '../../components/backBar';
import { FormDialog, FormFooterActions } from '../../components/formDialog';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { AddMembersDialog } from './addMembersDialog';
import { LeaderCard, MemberCard } from './memberCards';
import { FormErrorNote, PageHeader } from '../shared/components';
import {
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
} from '../shared/styles';

/** ================================== 类型 ================================== */

/** 路由页入参（壳状态经 routes.tsx 传入，数据流与拆分前逐位一致）。 */
export interface TeamDetailPageProps {
  /** Current session id; undefined on the overlay panel (no session yet). */
  sessionId: string | undefined;
  /** 全部团队池（:teamId 回查团队快照）。 */
  pool: TeamSnapshot[];
  /** 角色库（添加成员弹窗购物车）。 */
  roster: RosterMember[];
  /** 每队成员上限（host /state maxMembers）：添加成员弹窗的购物车配额。 */
  memberCap: number;
  /** 选中团队回写（建团成功落新团队详情——原创建流程 onSelectTeam 保留）。 */
  onSelectTeam: (teamId: string) => void;
  /** Member subagent activity dots (docs/20.4 P4): childId → running/inactive. */
  agentActivity: Record<string, string>;
}

/** ================================== 样式类 ================================== */

/** 原 styles.memberGrid（成员卡片栅格，最小 230px 自适应列）。 */
/** 成员列表（用户迭代 2026-09 七）：与领队卡同款竖排——一行一个成员占满整行。 */
const MEMBER_LIST_CLASS = 'flex flex-col gap-2.5';

/** ================================== 主组件 ================================== */

/**
 * 团队详情（用户迭代 2026-09）：点团队卡进来——团队成员、拉人组队都在这里。
 * 返回按钮回团队列表。页头 + 创建弹窗与列表页同款常驻（拆分前 TeamTab 两态
 * 共用）；成员卡列表（LeaderCard/MemberCard）行尾模型二级菜单与移出钮的
 * 乐观补丁提交链逐位保持。
 */
export function TeamDetailPage({
  sessionId,
  pool,
  roster,
  memberCap,
  onSelectTeam,
  agentActivity,
}: TeamDetailPageProps): ReactNode {
  const navigate = useNavigate();
  // :teamId 路由参数即原 detailId 态（选中团队 id，M4 拆页）。
  const { teamId } = useParams();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 创建弹窗开合（组件内瞬态）：页头「＋ 新增团队」按钮打开；卸载即复位
  // （用户反馈 2026-09 的自开弹窗类问题不再可能）。
  const [createOpen, setCreateOpen] = useState(false);
  // 添加成员弹窗（用户迭代 2026-09：Ele.me 点餐式）开合；详情态成员操作
  // （模型选择/移出/领队移除）的错误就地提示，不再静默吞掉。
  const [addOpen, setAddOpen] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [modelSavingName, setModelSavingName] = useState<string | null>(null);
  // 模型目录（用户迭代 2026-09：模型选择与对话一致；同日二级菜单）：与对话
  // /model 选择同一共享目录（ctx.modelDirectories，只读），loading/failed/
  // reload 与对话选择器打开时刷新、错误条+重试同款；catalog 为 null = 服务
  // 缺失（旧运行时），退回静态选项。成员/领队卡的选项与推理等级词汇表都
  // 来自这里。
  const modelCatalog = useModelCatalog(sessionId);
  // 面板创建团队绑定当前会话（领队即该会话代理）；浮层/无会话时没有可绑定的
  // 会话，创建按钮禁用并给出指引，而不是提交后吃 400 错误。
  const canCreate = typeof sessionId === 'string' && sessionId !== '';
  // 团队不在池中（已删/畸形 :teamId）：原 detailId 态快照回读落空即回落列表
  // 渲染的窗口，拆页后 navigate('/team')——渲染一帧空即跳列表（M3 任务详情
  // 页同款拆页差异，见 46 清单验收注记）。
  const detailTeam = teamId === undefined ? null : (pool.find((t) => t.teamId === teamId) ?? null);
  const teamFound = detailTeam !== null;
  useEffect(() => {
    if (!teamFound) navigate('/team');
  }, [teamFound, navigate]);

  /* —— 事件处理 —— */

  const create = async (): Promise<void> => {
    // M7-5 busy/error 壳收口 runWithBusy（守卫留在调用点，与原时机一致）。
    if (busy || !canCreate || name.trim() === '') return;
    await runWithBusy(
      async () => {
        const created = await createTeamViaPanel(sessionId, name.trim());
        setName('');
        setCreateOpen(false);
        // 创建成功即选中并跳进新团队详情（从 /state 快照回读前先按返回 id 落位
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

  // 行值 → POST body（与对话 /model 选择的 selectionOf 同语义，用户迭代
  // 2026-09：模型选择与对话一致）：行 id 为 `provider/model`；换模型取该
  // 模型目录默认强度（model.reasoning.defaultEffort——对话 /model 弹层的
  // selectionOf 同款）；同一路线重选由菜单自行关闭不上送（对话 choose()
  // 同款）。目录查不到的旧路线按裸模型 id 下发（host 按配置解析 provider）。
  // 'inherit' = 清 override（会话默认：用户迭代 2026-09-04——model 空串=
  // settings agent-default-model 即时快照，host 空 body 即重置）。null =
  // 非法行值（防御）。
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
        setDetailError(errorMessageOf(e));
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
        setDetailError(errorMessageOf(e));
      })
      .finally(() => setModelSavingName(null));
  };

  const removeMember = (memberName: string): void => {
    if (detailTeam === null) return;
    setDetailError(null);
    void removeTeamMember(detailTeam.teamId, memberName).catch((e) =>
      setDetailError(errorMessageOf(e)),
    );
  };

  // 领队模型选择（用户迭代 2026-09-04 恢复）：与 changeModel 同款乐观补丁 +
  // POST /leader/model，target 换成 captain。'inherit' = 会话默认（host 空
  // body = 重置）；有值即团队默认路线，领队子代理派发按它解析。
  const changeCaptainModel = (value: string): void => {
    if (detailTeam === null) return;
    const previous: RouteTriple = {
      model: detailTeam.captain.model ?? '',
      reasoningEffort: detailTeam.captain.reasoningEffort ?? null,
    };
    const body = routeBody(value, previous);
    if (body === null) return;
    setDetailError(null);
    setModelSavingName('__captain__');
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'captain' },
      route: { model: body.model ?? '', reasoningEffort: body.reasoningEffort ?? null },
    };
    applyRoutePatch(patch);
    void setLeaderModel(detailTeam.teamId, body)
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(errorMessageOf(e));
      })
      .finally(() => setModelSavingName(null));
  };

  // 领队推理等级（与 changeMemberEffort 同词汇表）：只对已有具体路线的领队
  // 生效；effort 为 null = 提供方默认。会话默认（model 空串）不可单独改。
  const changeCaptainEffort = (effort: string | null): void => {
    if (detailTeam === null) return;
    const captain = detailTeam.captain;
    if ((captain.model ?? '') === '') return;
    setDetailError(null);
    setModelSavingName('__captain__');
    const previous: RouteTriple = {
      model: captain.model ?? '',
      reasoningEffort: captain.reasoningEffort ?? null,
    };
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'captain' },
      route: { ...previous, reasoningEffort: effort },
    };
    applyRoutePatch(patch);
    void setLeaderModel(detailTeam.teamId, {
      model: captain.model ?? '',
      ...(effort !== null && effort !== '' ? { reasoningEffort: effort } : {}),
    })
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(errorMessageOf(e));
      })
      .finally(() => setModelSavingName(null));
  };

  const removeLeader = (): void => {
    if (detailTeam === null) return;
    setDetailError(null);
    void setTeamLeaderRemoved(detailTeam.teamId, true).catch((e) =>
      setDetailError(errorMessageOf(e)),
    );
  };

  if (detailTeam === null) {
    // 防御位：:teamId 在团队池里找不到（团队刚被删除 / 畸形路由段）——渲染
    // 一帧空即跳列表（上方 effect），见文件头注记。
    return null;
  }

  return (
    <div>
      {/* 团队页头（S24-2，官网 h2 签名）：标题 + 右侧「＋ 新增团队」主按钮。
        拆分前 TeamTab 列表/详情两态共用同一页头——详情态保持原观感，创建
        弹窗开合是组件内瞬态（用户反馈 2026-09：跳转信号自开弹窗撤销）。 */}
      <PageHeader label="团队">
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          新增团队
        </Button>
      </PageHeader>
      {/* 新增团队弹窗（用户迭代 2026-09）：shadcn Dialog + Input，输入名称按
      「新增团队」创建——创建由面板会话绑定限制（canCreate）同表单一致。
      创建成功跳新团队详情（详情态建团的落点，M4 拆页注记）。 */}
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

      {/* 返回条（M7-3 收口 components/backBar，outline 默认档；原返回钮清
      detailId/detailError/memberDetail 三态——拆页后瞬态随页面卸载即清，
      navigate 回列表即可）。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <BackBar label="返回团队列表" onClick={() => navigate('/team')} />
        <span className="text-lg font-semibold tracking-tight text-foreground">
          {detailTeam.name}
        </span>
        <span className={LIST_COUNT_CLASS}>
          任务 {detailTeam.progress.completed}/{detailTeam.progress.total} 完成
        </span>
      </div>

      {/* 团队成员卡（S13/S14）：容器 shadcn Card（PANEL_CARD_CLASS 覆盖层，
      S12 先例）；拉人下拉已移除（用户迭代 2026-09），改为右上「添加成员」
      按钮点开点餐式弹窗。成员卡点击进成员详情（原 memberDetail 态改路由，
      M4 拆页）。 */}
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
        {detailError !== null && <FormErrorNote className="mb-2.5">{detailError}</FormErrorNote>}
        <div className={MEMBER_LIST_CLASS}>
          {!detailTeam.leaderRemoved && (
            <LeaderCard
              captain={detailTeam.captain}
              catalog={modelCatalog}
              onRemove={removeLeader}
              onOpenDetail={() =>
                navigate(
                  `/team/${detailTeam.teamId}/member/${encodeURIComponent(detailTeam.captain.name)}`,
                )
              }
              onModelChange={changeCaptainModel}
              onEffortChange={changeCaptainEffort}
              modelSaving={modelSavingName === '__captain__'}
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
              onOpenDetail={() =>
                navigate(`/team/${detailTeam.teamId}/member/${encodeURIComponent(m.name)}`)
              }
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
    </div>
  );
}
