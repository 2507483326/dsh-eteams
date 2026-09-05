/**
 * 小任务拖拽指派组件（docs/29 A 节）：DndProvider(HTML5Backend) 局部包裹器
 * （DA2——只包 TasksTab，单实例单 Provider，A.6 同文档注入无跨文档问题）、
 * 成员罗列条（A.5.3 用户拍板：每张组卡下方各一条，chip 副本相同；领队 chip
 * 单列置首、带徽标、不可拖；staged 成员可拖带「未启动」弱化标记）、小任务
 * 行尾成员框（TaskAssignDropBox：2026-09-04 二轮 DA13 多人接力槽位——可编辑
 * 窗口内框承整链 chips（按序=接力顺序），拖到空白处=追加站点、拖到 chip=
 * 替换该站（嵌套 drop target，dnd-core 内层先 drop + didDrop 防双触发）、
 * chip ×=移除该站、全链同名去重闪现；2026-09-05 四轮 DA17：卡槽移到任务行
 * 下方独立一行、chip 显「头像+名字」+ 工号入悬浮提示、接力链不设上限（三轮
 * DA15 上限废止）；五轮 DA18：卡槽横向单行（超宽横向滚动）、chip/框圆角收小
 * 为 4px、罗列条「未启动」改工号数字徽章（去 ET- 前缀）、拖动提示独占一行；
 * 六轮 DA19：站点 chip 可拖动调序（chip→chip 数组搬移）、行尾「＋」点开成员
 * 多选追加（Popover 勾选→整链重发），「修改」弹窗不再做链编排；
 * 以拖放时刻最新快照的 chain 为底改后整链重发，DA10 复用
 * updateTeamTask、非乐观更新）。
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
  canRemoveStation,
  chainAfterAppendMany,
  chainAfterReorder,
  employeeBadgeOf,
  isAssignEditable,
  nextChainAfterDrop,
  readonlyStationMember,
} from './taskAssignCore';
import { DOT_BASE_CLASS, DOT_TONE_CLASS, memberTone } from './taskDisplayStatus';
import { Button } from '../../components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '../../components/ui/popover';

/** 每条拖拽 item 的类型常量（A.2：同一 TasksTab Provider 内拖拽源/目标配对）。
 * 'eteams-member'=罗列条成员 chip（drop=追加/替换）；'eteams-station'=卡槽内
 * 站点 chip（六轮 DA19：drop 到另一 chip=调序，容器不接受该类型——空白处
 * 落点无目标即 not-allowed，语义「调序只能 chip→chip」）；'eteams-subtask'=
 * 小任务卡片**把手**（七轮 DA20 调序 + 十轮 DA23 把手化：drop 到另一张卡=
 * 调整执行顺序，依赖改写补丁——只有卡片左上 grip 图标可拖，卡身不可拖）。 */
export const MEMBER_DRAG_TYPE = 'eteams-member';
export const STATION_DRAG_TYPE = 'eteams-station';
export const SUBTASK_DRAG_TYPE = 'eteams-subtask';

/** 小任务卡片拖拽载荷（七轮 DA20）：源卡 id + 父任务 id + 源卡可编辑态
 * （canDrop 双端校验用——同父兄弟才可互拖；drop 时刻以最新快照重算补丁）。 */
export interface SubtaskDragItem {
  taskId: number;
  parentId: number | null;
  editable: boolean;
}

/** 拖拽 item 载荷：只有成员名——放置目标按 drop 时刻的最新快照重算新链。 */
interface MemberDragItem {
  member: string;
}

/** 站点 chip 拖拽载荷（六轮 DA19 调序）：源站下标 + 成员名（成员名仅用于
 * 拖拽预览/调试，调序计算只认下标——drop 时刻以最新快照重算）。 */
interface StationDragItem {
  index: number;
  member: string;
}

/** DndProvider（HTML5Backend）局部包裹器（DA2：仅 TasksTab 根，不放面板根）。 */
export function TaskDndProvider({ children }: { children: ReactNode }): ReactNode {
  return <DndProvider backend={HTML5Backend}>{children}</DndProvider>;
}

/** 去重微反馈（A.3.1：200ms 边框/环闪现，不发请求）——落点跟随 drop 命中面
 * （chip drop 闪 chip、空白处 drop 闪容器，二轮 DA13），卸载时清定时器。 */
function useFlash200(): [boolean, () => void] {
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );
  const flashOnce = (): void => {
    setFlash(true);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(false), 200);
  };
  return [flash, flashOnce];
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

/** 站点 chip 的拖拽源 hook（六轮 DA19 调序源）：deps 携带下标与成员名。 */
function useStationDrag(index: number, memberName: string) {
  return useDrag<StationDragItem, unknown, { isDragging: boolean }>(
    () => ({
      type: STATION_DRAG_TYPE,
      item: { index, member: memberName },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [index, memberName],
  );
}

/* —— 类名常量（完整字面量；边框 token 类与 teamsView shared.tsx 的
   BORDER_L1_CLASS 同值（原 eteamsView），独立成表避免与视图模块互相 import 成环）—— */
const BORDER_TOKEN_CLASS = 'border-[color:var(--border)]';
/** 成员框基座（A.5.1：32px 高 / min-w-96px / 圆角 4px（DA18 五轮收小）/ 12px 字；
 * DA14 二轮 26→30、DA16 三轮 30→32 随头像放大）。 */
const BOX_BASE_CLASS =
  'inline-flex h-[32px] min-w-[96px] shrink-0 items-center gap-1.5 rounded-[4px] px-2 text-xs leading-none transition-colors';
/** 空框：虚线槽（BORDER_L1 类边框 token）。 */
const BOX_EMPTY_CLASS = `border border-dashed text-muted-foreground ${BOX_BASE_CLASS} ${BORDER_TOKEN_CLASS}`;
/** 可放置（非悬停）：虚线边框转品牌淡边——token 色禁 /alpha，半透明走
 * color-mix（token 纪律；teamMembers.tsx MemberCard 的 shadow 光晕同路径）。 */
const BOX_CAN_DROP_CLASS = `${BOX_BASE_CLASS} border border-dashed border-[color:color-mix(in_srgb,var(--primary)_60%,transparent)] text-muted-foreground`;
/** 拖拽悬停：虚线转实线 + 品牌边 + 中性 pill 底（A.5.1 悬停行）。 */
const BOX_OVER_CLASS = `${BOX_BASE_CLASS} border border-solid border-primary bg-[color:var(--eteams-pill-bg)] text-foreground`;
/** 多站容器（可编辑框承整链，DA13/DA5 二轮）：虚线圆角框**横向单行**（五轮
 * DA18：去 280px 宽上限与换行，超宽横向滚动），行尾「＋」追加提示；chip 与
 * 容器 canDrop 同条件（A.3.1 注记）。 */
const BOX_MULTI_CLASS =
  'inline-flex max-w-full flex-nowrap items-center gap-1 overflow-x-auto rounded-[4px] border border-dashed px-1.5 py-1 text-xs leading-none transition-colors';
/** 多站容器悬停（空白处，shallow）：虚线转实线 + 品牌边 + 中性 pill 底。 */
const BOX_MULTI_OVER_CLASS = 'border-solid border-primary bg-[color:var(--eteams-pill-bg)]';
/** 多站容器可放置（非悬停）：虚线边框转品牌淡边（color-mix，同 BOX_CAN_DROP）。 */
const BOX_MULTI_CAN_DROP_CLASS =
  'border-[color:color-mix(in_srgb,var(--primary)_60%,transparent)]';
/** 行尾追加提示小槽（装饰性：真落点是整个容器空白处；DA16 随 chip 32px 对齐、
 * DA18 圆角 4px）。 */
const APPEND_HINT_CLASS =
  'inline-flex h-[32px] min-w-[32px] items-center justify-center rounded-[4px] border border-dashed border-[color:var(--border)] px-1 text-xs leading-none text-muted-foreground';
/** 框内已放置 chip 基座（中性底 + 12px medium；DA14 26→30、DA16 30→32、DA18
 * 圆角 4px；卡槽 chip 与只读框 chip 共用——头像+名字，工号入悬浮提示）。 */
const BOX_CHIP_CLASS =
  'inline-flex h-[32px] min-w-[96px] shrink-0 items-center gap-1.5 rounded-[4px] bg-[color:var(--eteams-pill-bg)] px-2 text-xs font-medium text-[color:var(--eteams-pill-ink)]';
/** 只读框 chip：灰化（A.7 终态/领取后）。 */
const BOX_READONLY_CLASS = `${BOX_CHIP_CLASS} opacity-60`;
/** 悬停时 chip 轻微上浮阴影（A.5.1；D22f 阴影档同 MEMBER_CARD）。 */
const BOX_OVER_SHADOW_CLASS = 'shadow-[0_1px_2px_rgba(15,23,42,0.08)]';
/** chip 被悬停（=替换该站）/去重闪现：brand 环（box-shadow 不引发回流）。 */
const CHIP_RING_CLASS = 'ring-1 ring-primary';
/** 「已移出」弱化小标（悬空名，DA9/A.5.1）。 */
const BOX_DANGLING_CLASS = 'text-[10px] font-normal text-muted-foreground';
/** 罗列条 chip（可拖签名 = ROLE_CHIP_CLASS 品牌淡底变体，A.5.3；hover 提示
 * 走 title，光标 grab/grabbing；DA14 26→30、DA16 30→32、DA18 圆角 4px）。 */
const STRIP_CHIP_CLASS =
  'inline-flex h-[32px] shrink-0 cursor-grab items-center gap-1.5 rounded-[4px] bg-business-tint px-2 text-xs font-medium text-[color:var(--eteams-brand-ink)] active:cursor-grabbing';
/** 领队 chip：中性底 + 虚线边（不可拖签名，A.5.2 草图 ╌╌ 口径；DA14 26→30、
 * DA16 30→32、DA18 圆角 4px）。 */
const CAPTAIN_CHIP_CLASS = `inline-flex h-[32px] shrink-0 cursor-default items-center gap-1.5 rounded-[4px] border border-dashed bg-[color:var(--eteams-pill-bg)] px-2 text-xs font-medium text-[color:var(--eteams-pill-ink)] ${BORDER_TOKEN_CLASS}`;
/** 领队徽标（A.5.3：带「领队」徽标；成员 chip 的弱化小字同款 10px）。 */
const CHIP_TAG_CLASS = 'text-[10px] font-normal text-muted-foreground';
/** 罗列条工号徽章（五轮 DA18：未启动→工号，只显数字不带 ET- 前缀）：小型
 * 徽章面——中性 pill 底 + token 边 + 10px medium，区别于 chip 主题色。 */
const STRIP_BADGE_CLASS =
  `inline-flex items-center rounded-[3px] border border-solid bg-[color:var(--eteams-pill-bg)] ${BORDER_TOKEN_CLASS} px-1 text-[10px] font-medium leading-none text-muted-foreground`;

/** 成员罗列条的可拖 chip（A.3.2：staged 可拖，源 chip 拖拽中半透明；头像
 * 渲染复用 Avatar，状态点 memberTone 五桶——staged 态由状态点表达；五轮
 * DA18：原「未启动」小字改工号数字徽章 STRIP_BADGE_CLASS）。 */
function MemberDragChip({ member }: { member: MemberView }): ReactNode {
  const [{ isDragging }, dragRef] = useMemberDrag(member.name);
  const badge = employeeBadgeOf(member.employeeId);
  return (
    <div
      ref={dragRef}
      className={STRIP_CHIP_CLASS}
      style={isDragging ? { opacity: 0.5 } : undefined}
      title="拖到小任务下方的成员卡槽完成指派"
    >
      <Avatar name={member.name} seed={member.avatar?.seed} salt={member.avatar?.salt} size={26} />
      <span>{member.name}</span>
      {badge && <span className={STRIP_BADGE_CLASS}>{badge}</span>}
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
      <Avatar name={captain.name} seed={captain.avatar.seed} salt={captain.avatar.salt} size={26} />
      <span>{captain.name}</span>
      <span className={CHIP_TAG_CLASS}>领队</span>
    </div>
  );
}

/**
 * 成员罗列条（A.5.3，用户 2026-09-04 拍板）：渲染在每张任务单（group）卡内
 * 小任务行之后——每卡一份相同副本，数据仍只取同一份成员快照（同队成员对
 * 全部组卡相同），无重复请求。领队 chip 单列置首；「从成员库添加」入口不在
 * 条内提供（DA12/E21）；拖动提示独占 chips 下一行（五轮 DA18）。
 */
export function TeamMemberStrip({ team }: { team: TeamSnapshot }): ReactNode {
  return (
    <div className="mt-2 border-t border-solid pt-2 leading-none">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-muted-foreground">团队成员</span>
        {!team.leaderRemoved && <CaptainChip captain={team.captain} />}
        {team.members.map((m) => (
          <MemberDragChip key={m.name} member={m} />
        ))}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">拖到本卡小任务下方的成员卡槽完成指派</div>
    </div>
  );
}

/**
 * 小任务成员卡槽（A.5.1，二轮 DA13 多人接力槽位；四轮 DA17 起置于任务行
 * 下方独立一行；五轮 DA18 横向单行 + 圆角 4px；六轮 DA19 链编排全收进卡槽）：
 * drop target。可编辑窗口（DA6：`draft/ready && chainCursor===-1`）内框承
 * 整链——空链时容器即空槽（拖入或点击多选=追加站点，不设上限，DA15 已废止）；
 * 有链时容器横向单行排布站点 chips（Avatar 26px + 名字，工号入悬浮提示）+
 * 行尾「＋」多选按钮，拖到空白处=追加、拖到 chip=替换该站、chip 拖到另一
 * chip=调序、「＋」点开=多选追加（嵌套 drop target：dnd-core 内层先 drop，
 * 容器以 `didDrop` 让位、`isOver({shallow})` 区分悬停面；chip 与容器对成员
 * 类型 canDrop 同条件；容器不接受站点类型——调序只能 chip→chip，空白处
 * not-allowed）。drop 以**拖放时刻最新快照的 chain**为底现算新链整链重发
 * （不缓存旧 chain，A.7 风险②）；同名成员拖入 = no-op（DA8 全链去重 +
 * 200ms 微反馈，闪现落点跟随命中面）。
 *
 * 「修改」弹窗不再做链编排（DA19）：容器空白处/chip 点击仍打开弹窗（任务
 * 主题/说明），链增删调序只走卡槽（＋多选 / × / chip 拖动）。
 *
 * 只读（已领取/合同冻结/开跑）：chip 静态渲染，承单站（assignee 优先，
 * readonlyStationMember）。悬空名 chip（可编辑窗口内任意站）可被拖拽定点
 * 替换修复（DA9 二轮）；报错经 FormErrorNote 就地展示，不绕过。
 */
export function TaskAssignDropBox({
  task,
  members,
  busy,
  onAssign,
  onRemoveStation,
  onOpenEdit,
}: {
  task: TaskView;
  /** 团队成员快照（悬空名判断 + 框内 chip 头像；快照已滤 removed）。 */
  members: readonly MemberView[];
  /** 该小任务的指派提交中（assignBusy，A.5.1 提交中行）。 */
  busy: boolean;
  /** drop 命中且 nextChainAfterDrop 产出新链：整链重发。 */
  onAssign: (chain: TaskSlotInput[]) => void;
  /** chip ×（移除该站）：chainAfterRemove 后整链重发。 */
  onRemoveStation: (index: number) => void;
  /** 「修改」弹窗入口（六轮 DA19 起弹窗不再编排链——仅任务主题/说明等；
   * 多站容器空白处 / chip 点击仍打开，键盘 Enter/Space 同路径）。 */
  onOpenEdit: () => void;
}): ReactNode {
  const editable = isAssignEditable(task);
  const eligible = editable && !busy;
  // 容器级去重微反馈（空白处 drop 的 no-op：chip 级闪现在 StationChip 内部）。
  const [flash, flashOnce] = useFlash200();
  // 「＋」多选追加面板（六轮 DA19）：picked=勾选中的成员名（按勾选顺序追
  // 加为站点）；openPicker 清空上轮勾选。
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const togglePicked = (name: string): void => {
    setPicked((cur) => (cur.includes(name) ? cur.filter((m) => m !== name) : [...cur, name]));
  };
  const confirmPick = (): void => {
    const chain = chainAfterAppendMany(task, picked);
    setPickerOpen(false);
    setPicked([]);
    if (chain !== null) onAssign(chain);
  };
  const openPicker = (): void => {
    setPicked([]);
    setPickerOpen(true);
  };
  // 容器 drop target（空白处 = 追加）：shallow 区分悬停面；didDrop 让位 chip。
  // chip 与容器 canDrop 同条件（A.3.1 注记——更严方会被 dnd-core 滤掉改变落
  // 点语义；三轮曾收容器为满员禁投，四轮废止恢复对称）。
  // deps 携带最新 task/回调：spec 闭包逐渲染刷新（drop 不缓存旧 chain）。
  const [{ isOver }, dropRef] = useDrop<MemberDragItem, unknown, { isOver: boolean }>(
    () => ({
      accept: MEMBER_DRAG_TYPE,
      canDrop: () => eligible,
      drop: (item, monitor) => {
        if (monitor.didDrop()) return;
        const chain = nextChainAfterDrop(task, item.member);
        if (chain !== null) {
          onAssign(chain);
          return;
        }
        if (isAssignEditable(task)) flashOnce();
      },
      collect: (monitor) => ({ isOver: monitor.isOver({ shallow: true }) && monitor.canDrop() }),
    }),
    [task, eligible, onAssign, flashOnce],
  );

  const onKeyOpen = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenEdit();
    }
  };
  // 空框键盘降级（六轮 DA19）：Enter/Space 打开多选面板（弹窗不再编排链）。
  const onKeyPicker = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  };

  // 只读：chip 静态渲染（不注册 drop target、无 ×；终态灰化）。承单站：
  // assignee 优先，无则下一待执行站（越界回末站）；均无 → 框不渲染。
  if (!editable) {
    const stationMember = readonlyStationMember(task);
    if (stationMember === null) return null;
    const stationAvatar = members.find((m) => m.name === stationMember);
    const dangling = !members.some((m) => m.name === stationMember);
    // 五轮 DA18：工号撤出版面、随悬空标折叠进悬浮提示。
    const detail = [stationAvatar?.employeeId, dangling ? '已移出' : null]
      .filter(Boolean)
      .join('，');
    return (
      <div
        className={BOX_READONLY_CLASS}
        title={detail ? `${stationMember}（${detail}）` : stationMember}
      >
        <Avatar
          name={stationMember}
          seed={stationAvatar?.avatar?.seed}
          salt={stationAvatar?.avatar?.salt}
          size={26}
        />
        <span>{stationMember}</span>
        {dangling && <span className={BOX_DANGLING_CLASS}>已移出</span>}
      </div>
    );
  }

  // 可编辑 + 空链：容器即空槽（拖入 = 追加站点；六轮 DA19：点击/键盘 =
  // 「＋」多选面板——弹窗不再编排链，一轮空框口径的点击行为随之改道）。
  if (task.chain.length === 0) {
    return (
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverAnchor asChild>
          <div
            ref={dropRef}
            tabIndex={0}
            title="拖入成员=追加站点；点击多选添加"
            className={cn(
              BOX_EMPTY_CLASS,
              isOver && BOX_OVER_CLASS,
              !isOver && eligible && BOX_CAN_DROP_CLASS,
              flash && 'border-solid border-primary',
              busy && 'pointer-events-none opacity-50',
            )}
            onClick={(e) => {
              e.stopPropagation();
              openPicker();
            }}
            onKeyDown={onKeyPicker}
          >
            <span>{isOver ? '松手追加' : '＋ 拖入成员'}</span>
          </div>
        </PopoverAnchor>
        <StationPicker
          members={members}
          chainMembers={task.chain.map((s) => s.member)}
          picked={picked}
          busy={busy}
          onToggle={togglePicked}
          onConfirm={confirmPick}
        />
      </Popover>
    );
  }

  // 可编辑 + 有链：容器承整链 chips（按序=接力顺序）+ 行尾「＋」多选按钮
  // （六轮 DA19：点开面板勾选追加；容器空白处/chip 点击仍开「修改」弹窗）。
  // busy 时整框禁用。
  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <div
        ref={dropRef}
        tabIndex={0}
        title="拖到空白处=追加站点；拖到成员上=替换该站；chip 拖动=调序；×=移除该站；点击打开修改弹窗"
        className={cn(
          BOX_MULTI_CLASS,
          isOver && eligible && BOX_MULTI_OVER_CLASS,
          !isOver && eligible && BOX_MULTI_CAN_DROP_CLASS,
          flash && 'border-solid border-primary',
          busy && 'pointer-events-none opacity-50',
        )}
        onClick={(e) => {
          e.stopPropagation();
          onOpenEdit();
        }}
        onKeyDown={onKeyOpen}
      >
        {task.chain.map((s, i) => (
          <StationChip
            key={i}
            task={task}
            index={i}
            member={s.member}
            members={members}
            eligible={eligible}
            removable={canRemoveStation(task)}
            onAssign={onAssign}
            onRemove={() => onRemoveStation(i)}
          />
        ))}
        <PopoverAnchor asChild>
          <button
            type="button"
            title="多选成员追加站点"
            className={cn(APPEND_HINT_CLASS, 'cursor-pointer')}
            onClick={(e) => {
              e.stopPropagation();
              openPicker();
            }}
          >
            {isOver ? '松手追加' : '＋'}
          </button>
        </PopoverAnchor>
      </div>
      <StationPicker
        members={members}
        chainMembers={task.chain.map((s) => s.member)}
        picked={picked}
        busy={busy}
        onToggle={togglePicked}
        onConfirm={confirmPick}
      />
    </Popover>
  );
}

/**
 * 「＋」点开的成员多选追加面板（六轮 DA19）：Popover 列出团队成员快照
 * （host 已滤 removed）——已在链中的成员禁用并标「已在链中」（DA8 去重同
 * 源），勾选若干人按勾选顺序末尾追加站点（chainAfterAppendMany 整链重发）。
 * 只做加站，不做调序/移除/站点说明编辑（调序=chip 拖动、移除=×，brief 恒
 * 空串；「修改」弹窗不再编排链，DA19）。
 */
function StationPicker({
  members,
  chainMembers,
  picked,
  busy,
  onToggle,
  onConfirm,
}: {
  members: readonly MemberView[];
  chainMembers: readonly string[];
  picked: readonly string[];
  busy: boolean;
  onToggle: (name: string) => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <PopoverContent align="start" className="w-64 p-2">
      <div className="px-1 text-xs font-semibold text-muted-foreground">选择成员，追加为接力站点</div>
      <div className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto">
        {members.map((m) => {
          const inChain = chainMembers.includes(m.name);
          const checked = picked.includes(m.name);
          return (
            <button
              key={m.name}
              type="button"
              disabled={inChain}
              title={inChain ? '已在链中（接力链同成员只占一站）' : undefined}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-left text-xs leading-none transition-colors',
                inChain
                  ? 'cursor-not-allowed opacity-50'
                  : 'cursor-pointer hover:bg-[color:var(--eteams-pill-bg)]',
              )}
              onClick={() => onToggle(m.name)}
            >
              <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={20} />
              <span className="font-medium">{m.name}</span>
              <span className="text-[10px] font-normal text-muted-foreground">
                {inChain ? '已在链中' : m.role}
              </span>
              <span
                className={cn(
                  'ml-auto text-[10px] font-medium text-primary',
                  checked ? 'opacity-100' : 'opacity-0',
                )}
              >
                ✓
              </span>
            </button>
          );
        })}
        {members.length === 0 && (
          <div className="px-1.5 py-2 text-xs text-muted-foreground">暂无可选成员</div>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        className="mt-2 w-full"
        disabled={busy || picked.length === 0}
        onClick={onConfirm}
      >
        {picked.length > 0 ? `添加 ${picked.length} 站` : '添加站点'}
      </Button>
    </PopoverContent>
  );
}

/**
 * 站点 chip（二轮 DA13 嵌套 drop target；四轮 DA17 恢复 pill；五轮 DA18
 * 工号撤出版面；六轮 DA19 兼作拖拽源=调序）：
 * - 罗列条成员 chip 拖到本 chip = 定点替换该站（nextChainAfterDrop 显式
 *   stationIndex）；同名去重 → 闪现该 chip（flash 落点跟随命中面）。
 * - 本 chip 拖到另一 chip = 调序（chainAfterReorder 数组搬移，stageBrief
 *   随站走）；自拖自放 no-op；容器不接受站点类型——空白处无落点。
 * 中性 pill：Avatar 26px + 名字（工号与悬空标入悬浮提示，legacy 无工号不提）
 * + 悬空标（DA9：拖到本 chip 替换即修复）；× 移除该站（整链重发）。
 * canDrop 与容器同 eligible（A.3.1 注记——更严方会被 dnd-core 滤掉、落点
 * 语义改变；三轮非对称已随 DA15 废止）；deps 携带最新 task/回调（不缓存旧
 * chain）。拖拽中半透明；点击冒泡到容器 = 打开「修改」弹窗。
 */
function StationChip({
  task,
  index,
  member,
  members,
  eligible,
  removable,
  onAssign,
  onRemove,
}: {
  task: TaskView;
  index: number;
  member: string;
  members: readonly MemberView[];
  eligible: boolean;
  removable: boolean;
  onAssign: (chain: TaskSlotInput[]) => void;
  onRemove: () => void;
}): ReactNode {
  const [flash, flashOnce] = useFlash200();
  // 六轮 DA19：站点 chip 兼作拖拽源（调序）。拖拽中半透明（罗列条同款）。
  const [{ isDragging }, dragRef] = useStationDrag(index, member);
  // deps 携带最新 task/回调：spec 闭包逐渲染刷新（drop 不缓存旧 chain）。
  // accept 为成员/站点双类型数组：成员 chip=替换该站、站点 chip=调序（drop
  // 按 'index' in item 分流；容器只收成员类型——空白处对站点类型无落点）。
  const [{ isOver }, dropRef] = useDrop<MemberDragItem | StationDragItem, unknown, { isOver: boolean }>(
    () => ({
      accept: [MEMBER_DRAG_TYPE, STATION_DRAG_TYPE],
      canDrop: () => eligible,
      drop: (item) => {
        if ('index' in item) {
          // 站点 chip → 调序：被拖站搬到本站位置（自拖自放 no-op）。
          const chain = chainAfterReorder(task, item.index, index);
          if (chain !== null) onAssign(chain);
          return;
        }
        const chain = nextChainAfterDrop(task, item.member, index);
        if (chain !== null) {
          onAssign(chain);
          return;
        }
        if (isAssignEditable(task)) flashOnce();
      },
      collect: (monitor) => ({ isOver: monitor.isOver() && monitor.canDrop() }),
    }),
    [task, index, eligible, onAssign, flashOnce],
  );
  const record = members.find((m) => m.name === member);
  const dangling = !members.some((m) => m.name === member);
  // 五轮 DA18：工号不占版面，折叠进悬浮提示（悬空标同段；两者皆无则不带括注）。
  const detail = [record?.employeeId, dangling ? '已移出' : null].filter(Boolean).join('，');
  return (
    <div
      ref={(node) => {
        dragRef(node);
        dropRef(node);
      }}
      style={isDragging ? { opacity: 0.5 } : undefined}
      title={`站点 ${index + 1}：${member}${detail ? `（${detail}）` : ''} · 拖到本 chip 上=替换该站；点击打开修改弹窗`}
      className={cn(
        BOX_CHIP_CLASS,
        (isOver || flash) && CHIP_RING_CLASS,
        isOver && BOX_OVER_SHADOW_CLASS,
      )}
    >
      <Avatar name={member} seed={record?.avatar?.seed} salt={record?.avatar?.salt} size={26} />
      <span>{member}</span>
      {dangling && <span className={BOX_DANGLING_CLASS}>已移出</span>}
      {removable && (
        <button
          type="button"
          aria-label="移除该站"
          className="shrink-0 rounded-[4px] px-1 text-xs leading-none text-muted-foreground transition-colors hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
