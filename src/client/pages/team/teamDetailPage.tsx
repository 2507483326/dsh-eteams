/**
 * 团队详情页（docs/13.3 团队）：返回条 + 成员卡列表（领队卡/成员卡：模型
 * 路线/推理等级/移出）+ 添加成员弹窗——自 teamTab 拆出（docs/44 M4），路由
 * /team/:teamId，:teamId 路由参数即原 detailId 态（选中团队 id）。页头不再
 * 挂「＋ 新增团队」（用户迭代 2026-09-07「团队详情页面，去掉新增团队按钮」
 * ——创建只从团队列表页进）；「任务 X/Y 完成」进度行同步撤（进度在任务页
 * 看）；成员列表容器内部滚动（用户迭代 2026-09-07「团队成员内部加滚动条，
 * 不是页面滚动」，列表页满高纪律 docs/41 同链）。成员卡点击进成员详情——
 * 原 memberDetail 态改 /team/:teamId/member/:name 路由（见
 * memberDetailPage.tsx）。模型路线乐观补丁/推理等级/领队移除等提交回调
 * 逐位保持；详情态成员操作错误就地 FormErrorNote。用户迭代 2026-09-10：
 * 「选择成员」改回「添加成员」（只加不减，见 addMembersDialog）；成员卡
 * 列表新增多选删除——「批量删除」进入勾选模式，行头勾选、选择操作条
 * 全选/删除所选，确认后逐个 POST 移出（工号定位，遇错停在原地报错）。
 *
 * @module dsh-eteams/client/pages/team/teamDetailPage
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import {
  removeTeamMember,
  setLeaderModel,
  setMemberModel,
  setTeamLeaderRemoved,
  type RosterMember,
} from '../../lib/api';
import {
  applyRoutePatch,
  employeeIdNumberOf,
  refreshActivitySoon,
  revertRoutePatch,
  type MemberView,
  type RoutePatch,
  type RouteTriple,
  type TeamSnapshot,
} from '../../lib/monitor';
import { catalogRow, useModelCatalog } from '../../lib/modelCatalog';
import { cn } from '../../lib/cn';
import { errorMessageOf } from '../../lib/errors';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { ConfirmDeleteDialog } from '../../components/confirmDeleteDialog';
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
  /** 角色库（选择成员弹窗清单）。 */
  roster: RosterMember[];
  /** 每队成员上限（host /state maxMembers）：选择成员弹窗的名额配额。 */
  memberCap: number;
}

/** ================================== 样式类 ================================== */

/** 原 styles.memberGrid（成员卡片栅格，最小 230px 自适应列）。 */
/** 成员列表（用户迭代 2026-09 七）：与领队卡同款竖排——一行一个成员占满整行。 */
const MEMBER_LIST_CLASS = 'flex flex-col gap-2.5';

/** ================================== 主组件 ================================== */

/**
 * 团队详情（用户迭代 2026-09）：点团队卡进来——团队成员、选择成员都在这里。
 * 返回按钮回团队列表。成员卡列表（LeaderCard/MemberCard）行尾模型二级菜单
 * 与移出钮的乐观补丁提交链逐位保持。
 */
export function TeamDetailPage({
  sessionId,
  pool,
  roster,
  memberCap,
}: TeamDetailPageProps): ReactNode {
  const navigate = useNavigate();
  // :teamId 路由参数即原 detailId 态（选中团队 id，M4 拆页）。
  const { teamId } = useParams();
  // 添加成员弹窗（用户迭代 2026-09-10 改回，原「选择成员」）开合；详情态
  // 成员操作（模型选择/移出/领队移除）的错误就地提示，不再静默吞掉。
  const [addOpen, setAddOpen] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [modelSavingName, setModelSavingName] = useState<string | null>(null);
  // 多选删除（用户迭代 2026-09-10）：selecting = 勾选模式；selected = 勾选集
  // （键 = 工号显示串，每行唯一——同名成员各归各）；confirmOpen = 批量移出
  // 确认弹窗；batchBusy = 移出在途（防连点）。
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  // 模型目录（用户迭代 2026-09：模型选择与对话一致；同日二级菜单）：与对话
  // /model 选择同一共享目录（ctx.modelDirectories，只读），loading/failed/
  // reload 与对话选择器打开时刷新、错误条+重试同款；catalog 为 null = 服务
  // 缺失（旧运行时），退回静态选项。成员/领队卡的选项与推理等级词汇表都
  // 来自这里。
  const modelCatalog = useModelCatalog(sessionId);
  // 团队不在池中（已删/畸形 :teamId）：原 detailId 态快照回读落空即回落列表
  // 渲染的窗口，拆页后 navigate('/team')——渲染一帧空即跳列表（M3 任务详情
  // 页同款拆页差异，见 46 清单验收注记）。
  const detailTeam = teamId === undefined ? null : (pool.find((t) => t.teamId === teamId) ?? null);
  const teamFound = detailTeam !== null;
  useEffect(() => {
    if (!teamFound) navigate('/team');
  }, [teamFound, navigate]);

  /* —— 事件处理 —— */

  // 行值 → POST body（与对话 /model 选择的 selectionOf 同语义，用户迭代
  // 2026-09：模型选择与对话一致）：行 id 为 `provider/model`；换模型取该
  // 模型目录默认强度（model.reasoning.defaultEffort——对话 /model 弹层的
  // selectionOf 同款）；同一路线重选由菜单自行关闭不上送（对话 choose()
  // 同款）。v9 provider 回归（用户迭代 2026-09-08「选 glm1 显示
  // glm-5.3-free」）：provider 整组入档——同 id 模型跨提供方时按 id 反推
  // 会命中错误条目。目录查不到的旧路线按裸模型 id 下发。
  // 'inherit' = 清 override（会话默认：用户迭代 2026-09-04——model 空串=
  // settings agent-default-model 即时快照，host 空 body 即重置）。null =
  // 非法行值（防御）。
  const routeBody = (
    value: string,
    stored: RouteTriple,
  ): { provider?: string; model?: string; reasoningEffort?: string } | null => {
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
    const effort =
      stored.model === model && (stored.provider ?? '') === provider
        ? (stored.reasoningEffort ?? row?.model.reasoning?.defaultEffort)
        : row?.model.reasoning?.defaultEffort;
    return {
      provider,
      model,
      ...(effort !== undefined && effort !== '' ? { reasoningEffort: effort } : {}),
    };
  };

  // v7 R3：数据回调携带整行，定位键 = 行内工号（同名成员各归各）。
  const changeModel = (member: MemberView, value: string): void => {
    if (detailTeam === null) return;
    const employeeId = employeeIdNumberOf(member.employeeId);
    if (employeeId === null) return;
    const member2 = detailTeam.members.find((m) => m.employeeId === member.employeeId);
    if (member2 === undefined) return;
    const previous: RouteTriple = {
      model: member2.model,
      provider: member2.provider ?? null,
      reasoningEffort: member2.reasoningEffort,
    };
    const body = routeBody(value, previous);
    if (body === null) return;
    setDetailError(null);
    setModelSavingName(member.name);
    // 选择即变（对话 choose() 同款本地即时性）：先打乐观补丁——触发器文案/
    // 勾选/推理等级入口不等 POST + 1s 轮询；pending 覆盖层防在途旧快照闪回，
    // POST 成功立即快照确认，失败回滚 + 就地报错。
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'member', employeeId },
      route: {
        model: body.model ?? '',
        provider: body.provider ?? null,
        reasoningEffort: body.reasoningEffort ?? null,
      },
    };
    applyRoutePatch(patch);
    // inherit = 跟随（host 空 body = 重置）；其余按会话模型目录（与对话一致）。
    void setMemberModel(detailTeam.teamId, employeeId, body)
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
  const changeMemberEffort = (member: MemberView, effort: string | null): void => {
    if (detailTeam === null) return;
    const employeeId = employeeIdNumberOf(member.employeeId);
    if (employeeId === null) return;
    const member2 = detailTeam.members.find((m) => m.employeeId === member.employeeId);
    if (member2 === undefined || member2.model === '') {
      return;
    }
    setDetailError(null);
    setModelSavingName(member.name);
    const previous: RouteTriple = {
      model: member2.model,
      provider: member2.provider ?? null,
      reasoningEffort: member2.reasoningEffort,
    };
    // 同 changeModel：乐观补丁即时生效，POST 确认/回滚。整条路线重发必须带
    // provider（v9：漏发会丢覆盖 provider，显示退回按 id 反查）。
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'member', employeeId },
      route: { ...previous, reasoningEffort: effort },
    };
    applyRoutePatch(patch);
    void setMemberModel(detailTeam.teamId, employeeId, {
      ...(previous.provider !== null && previous.provider !== '' ? { provider: previous.provider } : {}),
      model: member2.model,
      ...(effort !== null && effort !== '' ? { reasoningEffort: effort } : {}),
    })
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(errorMessageOf(e));
      })
      .finally(() => setModelSavingName(null));
  };

  const removeMember = (member: MemberView): void => {
    if (detailTeam === null) return;
    const employeeId = employeeIdNumberOf(member.employeeId);
    if (employeeId === null) return;
    setDetailError(null);
    void removeTeamMember(detailTeam.teamId, employeeId).catch((e) =>
      setDetailError(errorMessageOf(e)),
    );
  };

  /* —— 多选删除（用户迭代 2026-09-10）—— */

  /** 可勾选成员：legacy 无工号的行定位不了移出 API，不进勾选集。 */
  const selectableMembers = detailTeam?.members.filter((m) => m.employeeId !== null) ?? [];
  const selectedCount = selectableMembers.filter((m) => selected.has(m.employeeId ?? '')).length;

  const toggleSelect = (member: MemberView): void => {
    const key = member.employeeId;
    if (key === null) return;
    setDetailError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const exitSelecting = (): void => {
    setSelecting(false);
    setSelected(new Set());
    setDetailError(null);
  };

  // 全选/取消全选：可勾选成员全部已中即视为清空。
  const toggleSelectAll = (): void => {
    setDetailError(null);
    setSelected((prev) => {
      const allSelected =
        selectableMembers.length > 0 && selectableMembers.every((m) => prev.has(m.employeeId ?? ''));
      return allSelected
        ? new Set()
        : new Set(selectableMembers.map((m) => m.employeeId ?? '').filter((k) => k !== ''));
    });
  };

  // 批量移出：逐个 POST（工号定位），遇错停在原地报错——已成功的移出生效
  // （1s 轮询回拉），剩余勾选保留供重试。
  const applyBatchRemove = async (): Promise<void> => {
    if (detailTeam === null || batchBusy) return;
    const victims = selectableMembers.filter((m) => selected.has(m.employeeId ?? ''));
    if (victims.length === 0) {
      setConfirmOpen(false);
      return;
    }
    setBatchBusy(true);
    setDetailError(null);
    try {
      for (const m of victims) {
        const employeeId = employeeIdNumberOf(m.employeeId);
        if (employeeId === null) throw new Error(`成员「${m.name}」没有工号，无法移出`);
        await removeTeamMember(detailTeam.teamId, employeeId);
      }
      setSelected(new Set());
      setConfirmOpen(false);
      setSelecting(false);
      refreshActivitySoon();
    } catch (e) {
      setConfirmOpen(false);
      setDetailError(errorMessageOf(e));
    } finally {
      setBatchBusy(false);
    }
  };

  // 领队模型选择（用户迭代 2026-09-04 恢复）：与 changeModel 同款乐观补丁 +
  // POST /leader/model，target 换成 captain。'inherit' = 会话默认（host 空
  // body = 重置）；有值即团队默认路线，领队子代理派发按它解析。
  const changeCaptainModel = (value: string): void => {
    if (detailTeam === null) return;
    const previous: RouteTriple = {
      model: detailTeam.captain.model ?? '',
      provider: detailTeam.captain.provider ?? null,
      reasoningEffort: detailTeam.captain.reasoningEffort ?? null,
    };
    const body = routeBody(value, previous);
    if (body === null) return;
    setDetailError(null);
    setModelSavingName('__captain__');
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'captain' },
      route: {
        model: body.model ?? '',
        provider: body.provider ?? null,
        reasoningEffort: body.reasoningEffort ?? null,
      },
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
      provider: captain.provider ?? null,
      reasoningEffort: captain.reasoningEffort ?? null,
    };
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'captain' },
      route: { ...previous, reasoningEffort: effort },
    };
    applyRoutePatch(patch);
    void setLeaderModel(detailTeam.teamId, {
      ...(previous.provider !== null && previous.provider !== '' ? { provider: previous.provider } : {}),
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
    // 根改纵 flex 列并占满内容列（用户迭代 2026-09-07「团队成员内部加滚动
    // 条，不是页面滚动」）：成员卡 flex-1 拉满、卡内列表内部滚动——页面本体
    // 不再纵滚（列表页满高纪律 docs/41 同链）。
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 团队页头（S24-2，官网 h2 签名）：「＋ 新增团队」按钮撤（用户迭代
      2026-09-07）——创建只从团队列表页进，页头只留标题。返回钮（用户迭代
      2026-09-08：页面返回统一收口 PageHeader onBack 槽，页头行最右图标钮——
      原 BackBar 文案钮随拆页瞬态一并撤，navigate 回列表即可）。「任务 X/Y
      完成」撤（用户迭代 2026-09-07——进度在任务页看）。 */}
      <PageHeader label="团队" onBack={() => navigate('/team')} />

      <div className="text-lg font-semibold tracking-tight text-foreground">{detailTeam.name}</div>

      {/* 团队成员卡（S13/S14）：容器 shadcn Card（PANEL_CARD_CLASS 覆盖层，
      S12 先例）纵 flex 拉满（用户迭代 2026-09-07 内滚链，见根注记）；右上
      「添加成员」按钮（用户迭代 2026-09-10 改回，原「选择成员」）点开弹窗；
      「批量删除」进多选模式——选择操作条（全选/删除所选/完成）替换原按钮组。
      成员卡点击进成员详情（多选模式点击改勾选）。 */}
      <Card className={cn(PANEL_CARD_CLASS, 'mt-2 flex min-h-0 flex-1 flex-col')}>
        <div className="mb-2.5 flex items-center gap-2">
          {/* 计数紧贴标题靠左（用户迭代 2026-09-07「8/20 人的提示改到靠左
          显示而不是居中」）：LIST_TITLE_CLASS 自带 flex-1 会把计数挤向右，
          本页就地 flex-none 覆盖（共享常量不动）。 */}
          <h3 className={cn(LIST_TITLE_CLASS, 'flex-none')}>团队成员</h3>
          <span className={LIST_COUNT_CLASS}>
            {detailTeam.members.length + (detailTeam.leaderRemoved ? 0 : 1)}/{memberCap} 人
          </span>
          {selecting && (
            <span className={LIST_COUNT_CLASS}>已选 {selectedCount} 人</span>
          )}
          <span className="flex-1" />
          {selecting ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={selectableMembers.length === 0}
                onClick={toggleSelectAll}
              >
                {selectableMembers.length > 0 &&
                selectableMembers.every((m) => selected.has(m.employeeId ?? ''))
                  ? '取消全选'
                  : '全选'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={selectedCount === 0}
                onClick={() => {
                  setDetailError(null);
                  setConfirmOpen(true);
                }}
              >
                删除所选（{selectedCount}）
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={exitSelecting}>
                完成
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={detailTeam.members.length === 0}
                onClick={() => {
                  setDetailError(null);
                  setSelecting(true);
                }}
              >
                批量删除
              </Button>
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
            </>
          )}
        </div>
        {detailError !== null && <FormErrorNote className="mb-2.5">{detailError}</FormErrorNote>}
        {/* 成员列表：卡内弹性区 + 纵向内部滚动（页面不滚，用户迭代
        2026-09-07「团队成员内部加滚动条」）。key 用工号显示串（每行唯一，
        同名成员不撞）。 */}
        <div className={cn(MEMBER_LIST_CLASS, 'min-h-0 flex-1 overflow-y-auto pr-0.5')}>
          {!detailTeam.leaderRemoved && (
            <LeaderCard
              captain={detailTeam.captain}
              catalog={modelCatalog}
              onRemove={selecting ? undefined : removeLeader}
              onOpenDetail={() =>
                navigate(
                  `/team/${detailTeam.teamId}/member/${encodeURIComponent(detailTeam.captain.name)}`,
                )
              }
              onModelChange={selecting ? undefined : changeCaptainModel}
              onEffortChange={selecting ? undefined : changeCaptainEffort}
              modelSaving={modelSavingName === '__captain__'}
            />
          )}
          {detailTeam.members.map((m) => (
            <MemberCard
              key={m.employeeId ?? m.name}
              member={m}
              catalog={modelCatalog}
              onRemove={selecting ? undefined : removeMember}
              onModelChange={selecting ? undefined : changeModel}
              onEffortChange={selecting ? undefined : changeMemberEffort}
              modelSaving={modelSavingName === m.name}
              onOpenDetail={
                selecting
                  ? undefined
                  : () => navigate(`/team/${detailTeam.teamId}/member/${encodeURIComponent(m.name)}`)
              }
              selecting={selecting}
              selected={m.employeeId !== null && selected.has(m.employeeId)}
              onToggleSelect={toggleSelect}
            />
          ))}
          {detailTeam.members.length === 0 && (
            <div className={MUTED_CLASS}>还没有成员——点右上角「添加成员」把角色加进团队。</div>
          )}
        </div>
      </Card>

      {/* 添加成员弹窗（用户迭代 2026-09-10 改回）：搜索 + 角色大卡勾选，
      只加不减，确认逐个 POST 应用。 */}
      <AddMembersDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        team={detailTeam}
        roster={roster}
        memberCap={memberCap}
      />

      {/* 批量移出确认（M7-1 壳收口 ConfirmDeleteDialog，破坏性确认钮档）。 */}
      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="移出所选成员"
        description={`将把所选 ${selectedCount} 名成员移出团队：工号作废不回收，任务副本行保留留档；正在执行的任务会回到就绪池。`}
        confirmLabel="移出成员"
        confirmBusy={batchBusy}
        onConfirm={() => void applyBatchRemove()}
      />
    </div>
  );
}
