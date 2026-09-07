/**
 * 团队成员卡片层（docs/13.3 团队）：领队卡 / 成员卡——自 teamMembers 拆出
 * （docs/44 M4，行为零变更），供 team/teamDetailPage 与
 * team/memberDetailPage（ROLE_CHIP_CLASS）消费（依赖方向：
 * team/teamDetailPage → team/memberCards → modelRoutePicker → shared）。
 * 成员详情页见 memberDetailPage.tsx（/team/:teamId/member/:name 路由页）。
 *
 * @module dsh-eteams/client/pages/team/memberCards
 */
import type { ReactNode } from 'react';
import type { CaptainView, MemberView } from '../../lib/monitor';
import type { ModelCatalogState } from '../../lib/modelCatalog';
import { catalogRowByModel } from '../../lib/modelCatalog';
import { cn } from '../../lib/cn';
import { ACTIVITY_DOT } from '../../lib/status';
import { Avatar } from '../../features/avatar/avatar';
import { DeleteButton } from '../../components/deleteButton';
import { ModelRoutePicker } from './modelRoutePicker';
import { CARD_SURFACE_CLASS, MUTED_CLASS } from '../shared/styles';

/** ================================== 样式类 ================================== */

/** 原 styles.memberCard（成员卡片：--border 边框 / 12px 圆角 / 官网 shadow-sm
 * 阴影档 / p-4 卡内呼吸感，D22f）。M7-11：卡面三要素（边框/底色/阴影）收编
 * shared/CARD_SURFACE_CLASS——与 PANEL_CARD_CLASS 同值件合一，圆角/内距
 * 档位差留在本位。 */
const MEMBER_CARD_CLASS = `flex flex-col gap-2 rounded-xl p-4 ${CARD_SURFACE_CLASS}`;
/** 原 styles.roleChip（品牌档圆 pill）：S14 团队卡片「当前」复用；D22e 官网
 * pill 口径（rounded-full / 12px / medium）+ 品牌淡底 token + brand-ink 字。
 * 领队卡与成员详情页头（领队徽标）共用——memberDetailPage 导入消费。 */
export const ROLE_CHIP_CLASS =
  'inline-flex w-fit items-center rounded-full bg-business-tint px-2.5 py-0.5 text-xs font-medium text-[color:var(--eteams-brand-ink)]';

/** ================================== 常量与映射表 ================================== */

/** 成员静态选项（目录不可用时的回退）：inherit=会话默认；切换只改
 * member.modelRoute——staged 成员启动即生效，运行中的成员下次启动生效。
 * （用户迭代 2026-09-04：settings agent-default-model 即时快照，不再继承
 * 领队会话模型。） */
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'inherit', label: '会话默认' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
];

/** ================================== 主组件 ================================== */

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
        {/* 移出团队（M7-4 收口 components/deleteButton，destructive 默认档）。 */}
        {onRemove !== undefined && <DeleteButton label="移出团队" onClick={onRemove} />}
      </div>
    </div>
  );
}

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
  // v7 R3：数据回调携带整行（定位键 = 行内工号，同名成员各归各）。
  onRemove?: (member: MemberView) => void;
  /** 模型选择（右侧二级菜单）：行 id=`provider/model`，'inherit' = 会话默认。 */
  onModelChange?: (member: MemberView, model: string) => void;
  /** 推理等级改写（菜单内「推理等级」子面板；null = 提供方默认）。 */
  onEffortChange?: (member: MemberView, effort: string | null) => void;
  /** 该成员的模型路由保存中（菜单短暂禁用防连点）。 */
  modelSaving?: boolean;
  /** 点卡片（头像/名字区）进成员详情页（路由按名，纯导航不带数据语义）。 */
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
  // 子代理活动点查表（lib/status.ts ACTIVITY_DOT，M4 双三元收拢）：键只算
  // 名——非 running 一律按 inactive 档渲染（与原三元回落同口径）。
  const activityDot = activity === 'running' ? ACTIVITY_DOT.running : ACTIVITY_DOT.inactive;
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
                <span className={activityDot.className} title={activityDot.title} />
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
            onModelPick={(v) => onModelChange !== undefined && onModelChange(m, v)}
            onEffortPick={(effort) => onEffortChange !== undefined && onEffortChange(m, effort)}
            title="选择成员运行的模型（「会话默认」= 设置里的会话默认模型；运行中的成员下次启动时生效）"
          />
        )}
        {/* 移出团队（M7-4 收口 components/deleteButton，destructive 默认档）。 */}
        {onRemove !== undefined && <DeleteButton label="移出团队" onClick={() => onRemove(m)} />}
      </div>
    </div>
  );
}
