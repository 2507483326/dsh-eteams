/**
 * 小任务拖拽指派组件（docs/29 A 节）：DndProvider(HTML5Backend) 局部包裹器
 * （DA2——只包 TasksTab，单实例单 Provider，A.6 同文档注入无跨文档问题）、
 * 成员罗列条（A.5.3 用户拍板：每张组卡下方各一条，chip 副本相同；领队 chip
 * 单列置首、带徽标、不可拖；staged 成员可拖带「未启动」弱化标记）、小任务
 * 行尾成员框（TaskAssignDropBox：drop = 该小任务「下一待执行站点」快捷位，
 * 以拖放时刻最新快照的 chain 为底改一站后整链重发，DA10 复用 updateTeamTask、
 * 非乐观更新）。
 *
 * 拖拽 item 类型 'eteams-member'（A.2）；类名全部完整字面量映射（E17/
 * 21.5.1 禁拼接纪律，tailwind content 扫描可检出）。触屏/键盘降级（A.7）：
 * 框可聚焦，点击 / Enter/Space 打开既有「修改」弹窗（Select 选成员等价路径）。
 * react-dnd hooks 的 deps 数组刻意携带最新 props（useOptionalFactory 无 deps
 * 会以空数组冻结 spec——drop 闭包将过期，违反「不缓存旧 chain」）。
 *
 * @module dsh-eteams/client/taskAssign
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { Avatar } from '../avatar/avatar';
import { cn } from '../../lib/cn';
import type { TaskSlotInput } from '../../lib/api';
import type { CaptainView, MemberView, TeamSnapshot, TaskView } from '../../lib/monitor';
import {
  canClearStation,
  dropTargetMember,
  isAssignEditable,
  nextChainAfterDrop,
  readonlyStationMember,
} from './taskAssignCore';
import { DOT_BASE_CLASS, DOT_TONE_CLASS, memberTone } from './taskDisplayStatus';

/** 每条拖拽 item 的类型常量（A.2：同一 TasksTab Provider 内拖拽源/目标配对）。 */
export const MEMBER_DRAG_TYPE = 'eteams-member';

/** 拖拽 item 载荷：只有成员名——放置目标按 drop 时刻的最新快照重算新链。 */
interface MemberDragItem {
  member: string;
}

/** DndProvider（HTML5Backend）局部包裹器（DA2：仅 TasksTab 根，不放面板根）。 */
export function TaskDndProvider({ children }: { children: ReactNode }): ReactNode {
  return <DndProvider backend={HTML5Backend}>{children}</DndProvider>;
}

/** 成员 chip 的拖拽源 hook：deps 携带成员名（空 deps 会冻结 spec——见文件头）。 */
function useMemberDrag(memberName: string) {
  return useDrag<MemberDragItem, unknown, { isDragging: boolean }>(
    () => ({
      type: MEMBER_DRAG_TYPE,
      item: { member: memberName },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [memberName],
  );
}

/* —— 类名常量（完整字面量；边框 token 类与 eteamsView BORDER_L1_CLASS 同值，
   独立成表避免与视图模块互相 import 成环）—— */
const BORDER_TOKEN_CLASS = 'border-[color:var(--border)]';
/** 成员框基座（A.5.1：26px 高 / min-w-96px / 圆角 6px / 12px 字）。 */
const BOX_BASE_CLASS =
  'inline-flex h-[26px] min-w-[96px] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs leading-none transition-colors';
/** 空框：虚线槽（BORDER_L1 类边框 token）。 */
const BOX_EMPTY_CLASS = `border border-dashed text-muted-foreground ${BOX_BASE_CLASS} ${BORDER_TOKEN_CLASS}`;
/** 可放置（非悬停）：虚线边框转品牌淡边——token 色禁 /alpha，半透明走
 * color-mix（token 纪律；eteamsView MemberCard 的 shadow 光晕同路径）。 */
const BOX_CAN_DROP_CLASS = `${BOX_BASE_CLASS} border border-dashed border-[color:color-mix(in_srgb,var(--primary)_60%,transparent)] text-muted-foreground`;
/** 拖拽悬停：虚线转实线 + 品牌边 + 中性 pill 底（A.5.1 悬停行）。 */
const BOX_OVER_CLASS = `${BOX_BASE_CLASS} border border-solid border-primary bg-[color:var(--eteams-pill-bg)] text-foreground`;
/** 框内已放置 chip（PILL_BASE 家族口径：中性底 + 12px medium）。 */
const BOX_CHIP_CLASS =
  'inline-flex h-[26px] min-w-[96px] shrink-0 items-center gap-1.5 rounded-full bg-[color:var(--eteams-pill-bg)] px-2 text-xs font-medium text-[color:var(--eteams-pill-ink)]';
/** 只读框 chip：灰化（A.7 终态/领取后）。 */
const BOX_READONLY_CLASS = `${BOX_CHIP_CLASS} opacity-60`;
/** 悬停时 chip 轻微上浮阴影（A.5.1；D22f 阴影档同 MEMBER_CARD）。 */
const BOX_OVER_SHADOW_CLASS = 'shadow-[0_1px_2px_rgba(15,23,42,0.08)]';
/** 「已移出」弱化小标（悬空名，DA9/A.5.1）。 */
const BOX_DANGLING_CLASS = 'text-[10px] font-normal text-muted-foreground';
/** 罗列条 chip（可拖签名 = ROLE_CHIP_CLASS 品牌淡底变体，A.5.3；hover 提示
 * 走 title，光标 grab/grabbing）。 */
const STRIP_CHIP_CLASS =
  'inline-flex h-[26px] shrink-0 cursor-grab items-center gap-1.5 rounded-full bg-business-tint px-2 text-xs font-medium text-[color:var(--eteams-brand-ink)] active:cursor-grabbing';
/** 领队 chip：中性底 + 虚线边（不可拖签名，A.5.2 草图 ╌╌ 口径）。 */
const CAPTAIN_CHIP_CLASS = `inline-flex h-[26px] shrink-0 cursor-default items-center gap-1.5 rounded-full border border-dashed bg-[color:var(--eteams-pill-bg)] px-2 text-xs font-medium text-[color:var(--eteams-pill-ink)] ${BORDER_TOKEN_CLASS}`;
/** 领队徽标（A.5.3：带「领队」徽标；成员 chip 的弱化小字同款 10px）。 */
const CHIP_TAG_CLASS = 'text-[10px] font-normal text-muted-foreground';

/** 成员罗列条的可拖 chip（A.3.2：staged 可拖带「未启动」，源 chip 拖拽中
 * 半透明；头像渲染复用 Avatar，状态点 memberTone 五桶）。 */
function MemberDragChip({ member }: { member: MemberView }): ReactNode {
  const [{ isDragging }, dragRef] = useMemberDrag(member.name);
  return (
    <div
      ref={dragRef}
      className={STRIP_CHIP_CLASS}
      style={isDragging ? { opacity: 0.5 } : undefined}
      title="拖到小任务成员框完成指派"
    >
      <Avatar name={member.name} seed={member.avatar?.seed} salt={member.avatar?.salt} size={18} />
      <span>{member.name}</span>
      {member.status === 'staged' && <span className={CHIP_TAG_CLASS}>未启动</span>}
      <span className={cn(DOT_BASE_CLASS, DOT_TONE_CLASS[memberTone(member.status)])} />
    </div>
  );
}

/** 罗列条的领队 chip：单列置首、带「领队」徽标、**不可拖**（DA7：领队不在
 * team.members，且「不接任务：负责拆解、指派与调度」既有口径）；领队已
 * 移出（leaderRemoved）时由调用方不渲染。 */
function CaptainChip({ captain }: { captain: CaptainView }): ReactNode {
  return (
    <div className={CAPTAIN_CHIP_CLASS} title="领队不接任务：负责拆解、指派与调度">
      <Avatar name={captain.name} seed={captain.avatar.seed} salt={captain.avatar.salt} size={18} />
      <span>{captain.name}</span>
      <span className={CHIP_TAG_CLASS}>领队</span>
    </div>
  );
}

/**
 * 成员罗列条（A.5.3，用户 2026-09-04 拍板）：渲染在每张任务单（group）卡内
 * 小任务行之后——每卡一份相同副本，数据仍只取同一份成员快照（同队成员对
 * 全部组卡相同），无重复请求。领队 chip 单列置首；「从成员库添加」入口不在
 * 条内提供（DA12/E21），条尾只放一行 12px 说明文字。
 */
export function TeamMemberStrip({ team }: { team: TeamSnapshot }): ReactNode {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-solid pt-2 leading-none">
      <span className="text-xs font-semibold text-muted-foreground">团队成员</span>
      {!team.leaderRemoved && <CaptainChip captain={team.captain} />}
      {team.members.map((m) => (
        <MemberDragChip key={m.name} member={m} />
      ))}
      <span className="text-xs text-muted-foreground">拖到本卡小任务行尾成员框完成指派</span>
    </div>
  );
}

/**
 * 小任务成员框（A.5.1）：行尾 drop target——语义 = 该小任务「下一待执行
 * 站点」快捷位（DA4/DA5）。drop 以**拖放时刻最新快照的 chain**为底改一站后
 * 整链重发（nextChainAfterDrop 在 drop 回调里从 props 现算，不缓存旧 chain，
 * A.7 风险②）；同名成员拖入 = no-op（DA8 去重，不发请求 + 200ms 微反馈）。
 *
 * 客户端守卫（DA6，比 host 状态闸更严）：仅 `draft/ready && chainCursor===-1`
 * 注册 drop target；其余状态框呈只读（已领取后显示当前执行人/站点成员）。
 * 悬空名恰在框内站点时可被拖入替换（DA9）；在其余站点时整链重发会被 host
 * 逐站校验拒（A.7 边界表——报错经 FormErrorNote 就地展示，不绕过）。
 */
export function TaskAssignDropBox({
  task,
  members,
  busy,
  onAssign,
  onClear,
  onOpenEdit,
}: {
  task: TaskView;
  /** 团队成员快照（悬空名判断 + 框内 chip 头像；快照已滤 removed）。 */
  members: readonly MemberView[];
  /** 该小任务的指派提交中（assignBusy，A.5.1 提交中行）。 */
  busy: boolean;
  /** drop 命中且 nextChainAfterDrop 产出新链：整链重发。 */
  onAssign: (chain: TaskSlotInput[]) => void;
  /** 框内 ×（仅单站链）：清空站点 = 整链重发为空链。 */
  onClear: () => void;
  /** 触屏/键盘降级：空框 / 框内 chip 点击 = 打开「修改」弹窗。 */
  onOpenEdit: () => void;
}): ReactNode {
  const editable = isAssignEditable(task);
  const stationMember = editable ? dropTargetMember(task) : readonlyStationMember(task);
  // 去重微反馈（A.3.1：200ms 边框闪现，不发请求）。
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );
  const eligible = editable && !busy;
  // deps 携带最新 task/回调：spec 闭包逐渲染刷新（drop 不缓存旧 chain）。
  const [{ isOver }, dropRef] = useDrop<MemberDragItem, unknown, { isOver: boolean }>(
    () => ({
      accept: MEMBER_DRAG_TYPE,
      canDrop: () => eligible,
      drop: (item) => {
        const chain = nextChainAfterDrop(task, item.member);
        if (chain !== null) {
          onAssign(chain);
          return;
        }
        if (isAssignEditable(task) && dropTargetMember(task) === item.member) {
          setFlash(true);
          if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
          flashTimer.current = window.setTimeout(() => setFlash(false), 200);
        }
      },
      collect: (monitor) => ({ isOver: monitor.isOver() && monitor.canDrop() }),
    }),
    [task, eligible, onAssign],
  );

  // 无可渲染内容（空链且未领取/未指派）→ 不渲染。
  if (!editable && stationMember === null) return null;
  const dangling = stationMember !== null && !members.some((m) => m.name === stationMember);
  const stationAvatar = members.find((m) => m.name === stationMember);

  // 只读：chip 静态渲染（不注册 drop target、无 ×；终态灰化）。
  if (!editable) {
    return (
      <div className={BOX_READONLY_CLASS}>
        <Avatar
          name={stationMember ?? ''}
          seed={stationAvatar?.avatar?.seed}
          salt={stationAvatar?.avatar?.salt}
          size={18}
        />
        <span>{stationMember}</span>
        {dangling && <span className={BOX_DANGLING_CLASS}>已移出</span>}
      </div>
    );
  }

  // 可编辑：drop target + chip 点击打开「修改」弹窗（键盘 Enter/Space 同路径）。
  const onKeyOpen = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenEdit();
    }
  };
  return (
    <div
      ref={dropRef}
      tabIndex={0}
      title="拖入成员完成指派；点击打开修改弹窗"
      className={cn(
        stationMember === null ? BOX_EMPTY_CLASS : BOX_CHIP_CLASS,
        isOver && BOX_OVER_CLASS,
        !isOver && eligible && stationMember === null && BOX_CAN_DROP_CLASS,
        isOver && stationMember !== null && BOX_OVER_SHADOW_CLASS,
        flash && 'border border-solid border-primary',
        busy && 'pointer-events-none opacity-50',
      )}
      onClick={(e) => {
        e.stopPropagation();
        onOpenEdit();
      }}
      onKeyDown={onKeyOpen}
    >
      {stationMember === null ? (
        <span>{isOver ? '松手指派' : '＋ 拖入成员'}</span>
      ) : (
        <>
          <Avatar
            name={stationMember}
            seed={stationAvatar?.avatar?.seed}
            salt={stationAvatar?.avatar?.salt}
            size={18}
          />
          <span>{stationMember}</span>
          {dangling && <span className={BOX_DANGLING_CLASS}>已移出</span>}
          {canClearStation(task) && (
            <button
              type="button"
              aria-label="清空站点"
              className="shrink-0 rounded-full px-1 text-xs leading-none text-muted-foreground transition-colors hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
            >
              ×
            </button>
          )}
        </>
      )}
    </div>
  );
}
