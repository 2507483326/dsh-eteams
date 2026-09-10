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
import Check from 'lucide-react/dist/esm/icons/check.mjs';
import type { CaptainView, MemberView } from '../../lib/monitor';
import type { ModelCatalogState } from '../../lib/modelCatalog';
import { catalogRowByModel } from '../../lib/modelCatalog';
import { cn } from '../../lib/cn';
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
  // 行值渲染选中态，provider 优先用快照声明的（v9 回归：同 id 模型跨提供方
  // 时按 id 反查会命中错误条目）；旧快照缺省回退目录反查，再退 'legacy'；
  // 会话默认（model 空）回 inherit 哨兵。
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
                    provider:
                      captain.provider ?? routeRow?.group.id ?? 'legacy',
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
 * 名字 + 工号 · 角色，右侧模型选择（默认「会话默认」，与领队一致）+ 移出
 * 团队。状态 pill（staged 等）、「汇报记录」按钮与子代理活动点已去掉（用户
 * 迭代 2026-09 七 / 2026-09-10「成员没有状态」——成员只是工牌持有者，在忙
 * 什么看任务）；模型目录与对话一致——二级菜单内多档 effort 模型带「推理
 * 等级」子面板。用户迭代 2026-09 四：点卡片（头像/名字区）进成员详情页。
 * 团队可以没有领队：领队被移出时这里只剩成员行。
 * 用户迭代 2026-09-10 多选删除：selecting 模式下卡片行头出勾选框、点击改
 * 为勾选/取消（不进详情），右侧模型菜单与移出钮隐藏——批量动作收口在
 * teamDetailPage 的选择操作条。 */
export function MemberCard({
  member: m,
  catalog,
  onRemove,
  onModelChange,
  onEffortChange,
  modelSaving,
  onOpenDetail,
  selecting,
  selected,
  onToggleSelect,
}: {
  member: MemberView;
  /** 会话模型目录状态（数据 + loading/failed/reload，对话选择器同款）。 */
  catalog: ModelCatalogState;
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
  /** 多选模式（用户迭代 2026-09-10）：行头勾选框、点击改勾选。 */
  selecting?: boolean;
  /** 多选模式下本卡是否已勾选。 */
  selected?: boolean;
  /** 多选模式下点击卡片回调（整行携带，定位键 = 行内工号）。 */
  onToggleSelect?: (member: MemberView) => void;
}): ReactNode {
  const openDetail = (): void => {
    if (onOpenDetail !== undefined) onOpenDetail(m.name);
  };
  // 多选模式下整卡点击 = 勾选切换；普通模式保持进详情。
  const onCardClick = (): void => {
    if (selecting === true) onToggleSelect?.(m);
    else openDetail();
  };
  // 快照路线 v9 起带 provider——菜单内部仍按 `provider/model` 行值渲染选中
  // 态，provider 优先用快照声明的（同 id 模型跨提供方时按 id 反查会命中错误
  // 条目）；旧快照缺省回退目录反查；会话默认（model 空串）回 inherit 哨兵。
  const routeRow = catalogRowByModel(catalog.catalog, m.model);
  const inherit = m.model === '';
  return (
    <div
      className={cn(
        MEMBER_CARD_CLASS,
        selected === true && 'border-primary bg-primary/5',
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* 可点区（头像/名字 + 多选勾选框）：多选模式整行再无右侧控件，点击
        即全卡；普通模式右侧行尾控件在可点区外，点击不串进详情。 */}
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg',
            (selecting === true || onOpenDetail !== undefined) &&
              'cursor-pointer transition-colors hover:bg-muted/60',
          )}
          onClick={onCardClick}
          title={selecting === true ? (selected === true ? '取消勾选' : '勾选该成员') : '进入成员详情'}
        >
          {selecting === true && (
            /* 多选勾选框（用户迭代 2026-09-10）：行头方框，勾中实心品牌色。 */
            <span
              className={cn(
                'flex h-4 w-4 flex-none items-center justify-center rounded border border-solid',
                selected === true
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted-foreground/40 text-transparent',
              )}
            >
              <Check className="h-3 w-3" />
            </span>
          )}
          <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              {m.name}
            </div>
            <div className={cn(MUTED_CLASS, 'mt-px')}>
              {m.employeeId !== null ? `${m.employeeId} · ` : ''}
              {m.role}
            </div>
          </div>
        </div>
        {/* 多选模式下右侧控件（模型菜单/移出钮）让位，避免批量操作误触。 */}
        {selecting !== true && onModelChange !== undefined && (
          <ModelRoutePicker
            catalogState={catalog}
            stored={
              inherit
                ? { provider: 'inherit', model: 'inherit', reasoningEffort: null }
                : {
                    provider: m.provider ?? routeRow?.group.id ?? 'legacy',
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
        {selecting !== true && onRemove !== undefined && (
          <DeleteButton label="移出团队" onClick={() => onRemove(m)} />
        )}
      </div>
    </div>
  );
}
