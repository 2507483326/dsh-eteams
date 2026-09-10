/**
 * 小任务拖拽指派组件（docs/29 A 节）：DndProvider(HTML5Backend) 局部包裹器
 * （DA2——只包任务消费面根（原 TasksTab；M3 拆页后 tasks/ 两路由页各自包
 * 裹），单实例单 Provider，A.6 同文档注入无跨文档问题）、
 * 成员罗列条（A.5.3 用户拍板：每张组卡下方各一条，chip 副本相同；领队 chip
 * 单列置首、带徽标、不可拖）、小任务
 * 行尾成员框（TaskAssignDropBox：2026-09-04 二轮 DA13 多人接力槽位——可编辑
 * 窗口内框承整链 chips（按序=接力顺序），拖到空白处=追加站点、拖到 chip=
 * 替换该站（嵌套 drop target，dnd-core 内层先 drop + didDrop 防双触发）、
 * chip ×=移除该站、全链同名去重闪现；2026-09-05 四轮 DA17：卡槽移到任务行
 * 下方独立一行、chip 显「头像+名字」+ 工号入悬浮提示、接力链不设上限（三轮
 * DA15 上限废止）；五轮 DA18：卡槽横向单行（超宽横向滚动）、chip/框圆角收小
 * 为 4px、罗列条「未启动」改工号数字徽章（去 ET- 前缀）、拖动提示独占一行；
 * 六轮 DA19：站点 chip 可拖动调序（chip→chip 数组搬移）、行尾「＋」点开成员
 * 多选追加（Popover 勾选→整链重发），「修改」弹窗不再做链编排；
 * 二十二轮 DA35：多选面板标题简化为「选择成员」（用户拍板去掉「追加为接力
 * 站点」），已在链中的成员**不再出现在列表**（用户拍板；原禁用 +「已在链中」
 * 标废弃，chainAfterAppendMany 去重守卫仍兜底）；二十三轮 DA36：多选确认钮
 * 改「添加成员 / 添加 N 个成员」（用户拍板「添加站点改成添加成员」）、卡槽
 * 悬停高亮改品牌淡底 + chip 环加 ring-inset（用户拍板「拖拽时高亮显示被
 * 遮挡了」——原高亮底与 chip 底同色看不出、滚动态 chip 外缘环被滚动容器
 * 裁掉）、任务区头像加 --border 描边（Avatar 增 className 透传，用户拍板
 * 「任务中的成员头像加上border」）、罗列条改**头部卡下方左竖线提示块**并
 * 更新提示文案（用户拍板「不放到卡片里面，放到卡片下面，左边用小竖线标识
 * 为提示」）；二十四轮 DA37：罗列条**回卡内原位、只留 chips 行**，指派
 * 提示拆出 StripAssignHint 仍置卡下方左竖线块（用户拍板「团队成员还是在
 * 卡片内，只是拖拽成员到下方的成员卡槽完成指派不在」）；二十五轮 DA38：
 * 提示块左竖线加粗加色改显眼（用户拍板「左侧的竖线改得显眼一点」——2px
 * 中性 token 线改 4px 品牌色实线）；多选面板收起修复（用户拍板「点击小
 * 任务里面的选择成员弹出弹窗后点击小任务空白地方弹窗没有消失」——Radix
 * 1.1 外出点击关闭是 click 期 deferred，被卡内 stopPropagation 拦断；
 * 容器空白处点击显式收起 + 卡身防冒泡包装层撤除恢复原生冒泡）；二十六轮
 * DA39：锚面开合**改回 click 期翻转**（DA38 曾改 pointerdown 抢翻转——
 * 同交互尾部的焦点默认动作落在 portal 内容之外的锚面上，刚挂载的 Radix
 * focusin 外出关闭路径立即触发 onDismiss，弹窗一开即收，用户拍板「弹出
 * 弹窗后马上就消失了」；click 开合在整个交互结束后才挂外出监听，同交互
 * 不再自伤，点锚面收起由本处显式翻转承担、不依赖 deferred 关闭）；三十五
 * 轮 DA48：成员拖入成员槽改**松手放置**——按落点 X 判位插入（chip 中点左
 * 半=插其前、右半=插其后，悬停插入指示线可视化；空链=追加即放置），「拖
 * 到 chip=替换该站」废止（替换与悬空名修复改走 × 移除 + 再拖入），chip
 * 嵌套 drop 只剩调序；以拖放时刻最新快照的 chain 为底改后整链重发，DA10 复用
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
import { employeeIdNumberOf } from '../../lib/monitor';
import {
  canRemoveStation,
  chainAfterAppendMany,
  chainAfterInsert,
  chainAfterReorder,
  employeeBadgeOf,
  insertionIndexOf,
  isAssignEditable,
  readonlyStationMember,
} from './taskAssignCore';
import { Button } from '../../components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '../../components/ui/popover';

/** 每条拖拽 item 的类型常量（A.2：同一任务 Provider 内拖拽源/目标配对）。
 * 'eteams-member'=罗列条成员 chip（drop=按落点判位插入，三十五轮 DA48——
 * 原「追加/替换」废止）；'eteams-station'=卡槽内
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

/**
 * 成员行的链站点引用（v7 R3）：工号数字串；旧成员（无工号）退名字——与
 * host 侧「同名按号找人」同口径，同名成员必须按工号入链才不会互串。
 */
function memberRefOf(m: MemberView): string {
  const id = employeeIdNumberOf(m.employeeId);
  return id !== null ? String(id) : m.name;
}

/**
 * 站点/assignee 引用 → 成员行（v7 反查）：工号数字串按工号找；旧名字串按名
 * 找（legacy 站点）。找不到 = 悬空（成员已移出或快照不同步）。
 */
function memberByRef(members: readonly MemberView[], ref: string): MemberView | undefined {
  const trimmed = ref.trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && String(numeric) === trimmed) {
    return members.find((m) => employeeIdNumberOf(m.employeeId) === numeric);
  }
  return members.find((m) => m.name === trimmed);
}

/** 拖拽 item 载荷：只有成员引用（工号数字串/旧名字）——放置目标按 drop 时刻
 * 的最新快照重算新链。 */
interface MemberDragItem {
  member: string;
}

/** 站点 chip 拖拽载荷（六轮 DA19 调序）：源站下标 + 成员引用（仅用于拖拽
 * 预览/调试，调序计算只认下标——drop 时刻以最新快照重算）。 */
interface StationDragItem {
  index: number;
  member: string;
}

/** DndProvider（HTML5Backend）局部包裹器（DA2：仅任务消费面根，不放面板根
 * ——原 TasksTab 根，M3 拆页后 tasks/ 两路由页各自包裹）。 */
export function TaskDndProvider({ children }: { children: ReactNode }): ReactNode {
  return <DndProvider backend={HTML5Backend}>{children}</DndProvider>;
}

/** 去重微反馈（A.3.1：200ms 边框/环闪现，不发请求）——三十五轮 DA48 起
 * flash 只落容器（成员 drop 不再命中 chip——判位插入/同名去重都在容器判，
 * chip 侧闪现随「chip=替换」废止一并撤除），卸载时清定时器。 */
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

/**
 * 三十五轮 DA48 判位测量（drop 判位与悬停插入指示线共用）：按 DOM 序取容器
 * 内站点 chip 的几何——mids=chip 视口中点 X（getBoundingClientRect，与
 * getClientOffset 同一视口坐标系，insertionIndexOf 判位用）；lefts=chip
 * offsetLeft（内容坐标，滚动容器下 caret 定位稳）；endLeft=末 chip 右缘 +
 * 2（无 chip → 8，空链 caret 缺省位）。chip 以 data-station-index 锚定。
 */
function stationMetricsOf(box: HTMLElement): { mids: number[]; lefts: number[]; endLeft: number } {
  const chips = box.querySelectorAll<HTMLElement>('[data-station-index]');
  const mids: number[] = [];
  const lefts: number[] = [];
  for (const chip of chips) {
    const rect = chip.getBoundingClientRect();
    mids.push(rect.left + chip.offsetWidth / 2);
    lefts.push(chip.offsetLeft);
  }
  const last = chips.item(chips.length - 1);
  const endLeft = last === null ? 8 : last.offsetLeft + last.offsetWidth + 2;
  return { mids, lefts, endLeft };
}

/** 成员 chip 的拖拽源 hook：deps 携带成员引用（空 deps 会冻结 spec——见文件头）。 */
function useMemberDrag(memberRef: string) {
  return useDrag<MemberDragItem, unknown, { isDragging: boolean }>(
    () => ({
      type: MEMBER_DRAG_TYPE,
      item: { member: memberRef },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [memberRef],
  );
}

/** 站点 chip 的拖拽源 hook（六轮 DA19 调序源）：deps 携带下标与成员引用。 */
function useStationDrag(index: number, memberRef: string) {
  return useDrag<StationDragItem, unknown, { isDragging: boolean }>(
    () => ({
      type: STATION_DRAG_TYPE,
      item: { index, member: memberRef },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [index, memberRef],
  );
}

/* —— 类名常量（完整字面量；边框 token 类与 shared/styles.ts 的
   BORDER_L1_CLASS 同值（原 eteamsView），独立成表避免与视图模块互相 import 成环）—— */
const BORDER_TOKEN_CLASS = 'border-[color:var(--border)]';
/** 成员框基座（A.5.1：32px 高 / min-w-96px / 圆角 4px（DA18 五轮收小）/ 12px 字；
 * DA14 二轮 26→30、DA16 三轮 30→32 随头像放大）。 */
const BOX_BASE_CLASS =
  'inline-flex h-[32px] min-w-[96px] shrink-0 items-center gap-1.5 rounded-[4px] px-2 text-xs leading-none transition-colors';
/** 空框：虚线槽（BORDER_L1 类边框 token）。 */
const BOX_EMPTY_CLASS = `border border-dashed text-muted-foreground ${BOX_BASE_CLASS} ${BORDER_TOKEN_CLASS}`;
/** 可放置（非悬停）：虚线边框转品牌淡边——token 色禁 /alpha，半透明走
 * color-mix（token 纪律；team/memberCards.tsx MemberCard 的 shadow 光晕
 * 同路径）。 */
const BOX_CAN_DROP_CLASS = `${BOX_BASE_CLASS} border border-dashed border-[color:color-mix(in_srgb,var(--primary)_60%,transparent)] text-muted-foreground`;
/** 拖拽悬停：虚线转实线 + 品牌边 + 中性 pill 底（A.5.1 悬停行）。 */
const BOX_OVER_CLASS = `${BOX_BASE_CLASS} border border-solid border-primary bg-[color:var(--eteams-pill-bg)] text-foreground`;
/** 多站容器（可编辑框承整链，DA13/DA5 二轮）：虚线圆角框**横向单行**（五轮
 * DA18：去 280px 宽上限与换行，超宽横向滚动），行尾「＋」追加提示；chip 与
 * 容器 canDrop 同条件（A.3.1 注记）；三十五轮 DA48 加 relative——悬停插入
 * 指示线（INSERT_CARET_CLASS 绝对定位）以容器为 containing block。 */
const BOX_MULTI_CLASS =
  'inline-flex max-w-full flex-nowrap items-center gap-1 overflow-x-auto rounded-[4px] border border-dashed px-1.5 py-1 text-xs leading-none transition-colors relative';
/** 悬停插入指示线（三十五轮 DA48：落点前后判位可视化——2px 品牌色竖线，
 * 锚 chip 左缘/末 chip 右缘；top/bottom 撑满容器可见高）。 */
const INSERT_CARET_CLASS = 'absolute bottom-0 top-0 w-0.5 bg-primary';
/** 多站容器悬停（空白处）：虚线转实线 + 品牌边 + 品牌淡底（color-mix——
 * 二十三轮 DA36：原中性 pill 底与 chip 底同色，chip 列表顶满时高亮看不出
 * （用户拍板「拖拽时高亮显示被遮挡了」），改品牌淡底让悬停面始终可辨）。 */
const BOX_MULTI_OVER_CLASS =
  'border-solid border-primary bg-[color:color-mix(in_srgb,var(--primary)_12%,transparent)]';
/** 多站容器可放置（非悬停）：虚线边框转品牌淡边（color-mix，同 BOX_CAN_DROP）。 */
const BOX_MULTI_CAN_DROP_CLASS = 'border-[color:color-mix(in_srgb,var(--primary)_60%,transparent)]';
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
/** chip 被悬停（站点拖拽=调序目标；三十五轮 DA48 起成员拖拽不再命中 chip
 * ——判位插入/去重闪现落容器）：brand 环（box-shadow 不引发回流）。
 * 二十三轮 DA36：加 ring-inset——环画进 chip 内缘，滚动容器（overflow-x-auto）
 * 裁不掉（chip 列表顶到左边/滚动态时外缘环会被裁，用户拍板「拖拽时高亮
 * 显示被遮挡了」）。 */
const CHIP_RING_CLASS = 'ring-1 ring-inset ring-primary';
/** 「已移出」弱化小标（悬空名，DA9/A.5.1）。 */
const BOX_DANGLING_CLASS = 'text-[10px] font-normal text-muted-foreground';
/* 任务区头像描边：二十三轮 DA36 起 5 处显式传入；三十二轮 DA45 描边进
 * Avatar 容器默认（用户拍板「头像加上边框」全表面统一），调用位显式类撤除。 */
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
const STRIP_BADGE_CLASS = `inline-flex items-center rounded-[3px] border border-solid bg-[color:var(--eteams-pill-bg)] ${BORDER_TOKEN_CLASS} px-1 text-[10px] font-medium leading-none text-muted-foreground`;

/** 成员罗列条的可拖 chip（A.3.2：可拖，源 chip 拖拽中半透明；头像渲染复用
 * Avatar；五轮 DA18：原「未启动」小字改工号数字徽章 STRIP_BADGE_CLASS；
 * 用户迭代 2026-09-10「成员没有状态」：原状态点随 memberTone 下线——成员
 * 只是工牌持有者，不挂状态）。 */
function MemberDragChip({ member }: { member: MemberView }): ReactNode {
  const [{ isDragging }, dragRef] = useMemberDrag(memberRefOf(member));
  const badge = employeeBadgeOf(member.employeeId);
  return (
    <div
      ref={dragRef}
      className={STRIP_CHIP_CLASS}
      style={isDragging ? { opacity: 0.5 } : undefined}
      title="拖拽成员到下方的成员卡槽完成指派"
    >
      <Avatar name={member.name} seed={member.avatar?.seed} salt={member.avatar?.salt} size={26} />
      <span>{member.name}</span>
      {badge && <span className={STRIP_BADGE_CLASS}>{badge}</span>}
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
 * 条内提供（DA12/E21）。
 *
 * 版式：二十轮 DA33 入头部卡（border-t 分区）；二十三轮 DA36 曾整条移出卡，
 * 二十四轮 DA37 订正（用户拍板「团队成员还是在卡片内，只是拖拽成员到下方
 * 的成员卡槽完成指派不在」）——罗列条回卡内原位（border-t 分区），**只留
 * chips 行**；指派提示拆出为 {@link StripAssignHint}（仍置卡下方左竖线块）。
 */
export function TeamMemberStrip({ team }: { team: TeamSnapshot }): ReactNode {
  return (
    <div className="mt-2 border-t border-solid pt-2 leading-none">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-muted-foreground">团队成员</span>
        {!team.leaderRemoved && <CaptainChip captain={team.captain} />}
        {team.members.map((m) => (
          <MemberDragChip key={memberRefOf(m)} member={m} />
        ))}
      </div>
    </div>
  );
}

/**
 * 指派提示块（二十四轮 DA37：用户拍板「拖拽成员到下方的成员卡槽完成指派
 * 不在（卡内）」——提示文案不入罗列条，独立置**头部卡下方**，左小竖线
 * （border-l-2 + pl-3）标识提示语义；渲染判据与罗列条同源（存在可编辑
 * 小任务才渲染），罗列条入卡、提示在卡下，同屏一上一下）。
 *
 * 二十五轮 DA38：左竖线加粗加色改显眼（用户拍板「左侧的竖线改得显眼一点」
 * ——2px 中性 token 线改 4px 品牌色实线，与卡槽虚线的品牌系呼应）。
 */
export function StripAssignHint(): ReactNode {
  return (
    <div className="mt-2 border-l-4 border-solid border-primary pl-3 text-xs leading-none text-muted-foreground">
      拖拽成员到下方的成员卡槽完成指派
    </div>
  );
}

/**
 * 小任务成员卡槽（A.5.1，二轮 DA13 多人接力槽位；四轮 DA17 起置于任务行
 * 下方独立一行；五轮 DA18 横向单行 + 圆角 4px；六轮 DA19 链编排全收进卡槽）：
 * drop target。可编辑窗口（DA6：`draft/ready && chainCursor===-1`）内框承
 * 整链——空链时容器即空槽（拖入或点击多选=追加站点，不设上限，DA15 已废止）；
 * 有链时容器横向单行排布站点 chips（Avatar 26px + 名字，工号入悬浮提示）+
 * 行尾「＋」多选按钮，成员拖入=松手放置**判位插入**（三十五轮 DA48：按落
 * 点 X 判位——空链=追加即放置、悬停插入指示线可视化；原「拖到 chip=替换
 * 该站」废止，替换改走 × + 再拖入）、chip 拖到另一
 * chip=调序、「＋」点开=多选追加（嵌套 drop target：dnd-core 内层先 drop，
 * 容器以 `didDrop` 让位、`isOver({shallow})` 区分悬停面；chip 与容器对成员
 * 类型 canDrop 同条件；容器不接受站点类型——调序只能 chip→chip，空白处
 * not-allowed）。drop 以**拖放时刻最新快照的 chain**为底现算新链整链重发
 * （不缓存旧 chain，A.7 风险②）；同名成员拖入 = no-op（DA8 全链去重 +
 * 200ms 微反馈，闪现落容器）。
 *
 * 「修改」弹窗不再做链编排（DA19）：容器空白处/chip 点击仍打开弹窗（任务
 * 主题/说明），链增删调序只走卡槽（＋多选 / × / chip 拖动）。
 *
 * 只读（已领取/合同冻结/开跑）：chip 静态渲染，承单站（assignee 优先，
 * readonlyStationMember）。悬空名 chip 修复改走 × 移除 + 再拖入（三十五轮
 * DA48：原「拖拽定点替换修复」废止）；报错经 FormErrorNote 就地展示，不绕过。
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
  /** drop 命中且 chainAfterInsert 产出新链：整链重发。 */
  onAssign: (chain: TaskSlotInput[]) => void;
  /** chip ×（移除该站）：chainAfterRemove 后整链重发。 */
  onRemoveStation: (index: number) => void;
  /** 「修改」弹窗入口（六轮 DA19 起弹窗不再编排链——仅任务主题/说明等；
   * 多站容器空白处 / chip 点击仍打开，键盘 Enter/Space 同路径）。 */
  onOpenEdit: () => void;
}): ReactNode {
  const editable = isAssignEditable(task);
  const eligible = editable && !busy;
  // 容器级去重微反馈（三十五轮 DA48：成员 drop 全落容器，flash 也只落容器——
  // chip 侧闪现已撤，chip 悬停环只剩调序目标高亮）。
  const [flash, flashOnce] = useFlash200();
  // 「＋」多选追加面板（六轮 DA19）：picked=勾选中的成员引用（工号数字串/
  // 旧名字，按勾选顺序追加为站点）；openPicker 清空上轮勾选。
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const togglePicked = (ref: string): void => {
    setPicked((cur) => (cur.includes(ref) ? cur.filter((m) => m !== ref) : [...cur, ref]));
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
  // 容器 drop target（三十五轮 DA48：成员拖入=松手放置**判位插入**——原
  // 「空白处=末尾追加」改按落点 X 判位，空链 mids 空 → index 0=追加，行为
  // 等价）：shallow 区分悬停面；didDrop 让位 chip（防御位保留）。判位测量
  // 锚点=容器 DOM（boxRef），collect 顺带取落点坐标（悬停 caret 渲染用）。
  // chip 与容器 canDrop 同条件（A.3.1 注记——更严方会被 dnd-core 滤掉改变落
  // 点语义；三轮曾收容器为满员禁投，四轮废止恢复对称）。
  // deps 携带最新 task/回调：spec 闭包逐渲染刷新（drop 不缓存旧 chain）。
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [{ isOver, offset }, dropRef] = useDrop<
    MemberDragItem,
    unknown,
    { isOver: boolean; offset: { x: number; y: number } | null }
  >(
    () => ({
      accept: MEMBER_DRAG_TYPE,
      canDrop: () => eligible,
      drop: (item, monitor) => {
        if (monitor.didDrop()) return;
        // 三十五轮 DA48：按落点 X 判插入位（视口坐标，与 chip 中点同系）；
        // 测不到容器/落点（防御）退回末尾追加。
        const dropOffset = monitor.getClientOffset();
        const box = boxRef.current;
        const index =
          box === null || dropOffset === null
            ? task.chain.length
            : insertionIndexOf(stationMetricsOf(box).mids, dropOffset.x);
        const chain = chainAfterInsert(task, item.member, index);
        if (chain !== null) {
          onAssign(chain);
          return;
        }
        if (isAssignEditable(task)) flashOnce();
      },
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }) && monitor.canDrop(),
        offset: monitor.getClientOffset(),
      }),
    }),
    [task, eligible, onAssign, flashOnce],
  );

  // 三十五轮 DA48 悬停插入指示（落点前后判位可视化——caret 锚 chip 左缘/
  // 末 chip 右缘，offsetLeft 内容坐标滚动稳；非悬停/测不到落点 → null 不
  // 渲染）。容器 DOM 节点走回调 ref 存进 state（react-hooks/refs 禁渲染期
  // 读 ref.current——commit 期回调存节点、渲染期读 state 不受限；boxRef 供
  // drop 处理器取节点用，与 boxEl 同一回调写入、不会分叉）。
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  let caret: number | null = null;
  if (isOver && eligible && offset !== null && boxEl !== null) {
    const metrics = stationMetricsOf(boxEl);
    const anchored = metrics.lefts[insertionIndexOf(metrics.mids, offset.x)];
    caret = anchored === undefined ? metrics.endLeft : anchored - 1;
  }

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
    // v7 反查：assignee 是名字，链站点引用是工号数字串（或旧名字串）——
    // memberByRef 双口径解析；显示名优先快照行名字。
    const stationAvatar = memberByRef(members, stationMember);
    const display = stationAvatar?.name ?? stationMember;
    const dangling = stationAvatar === undefined;
    // 五轮 DA18：工号撤出版面、随悬空标折叠进悬浮提示。
    const detail = [stationAvatar?.employeeId, dangling ? '已移出' : null]
      .filter(Boolean)
      .join('，');
    return (
      <div
        className={BOX_READONLY_CLASS}
        title={detail ? `${display}（${detail}）` : display}
      >
        <Avatar
          name={display}
          seed={stationAvatar?.avatar?.seed}
          salt={stationAvatar?.avatar?.salt}
          size={26}
        />
        <span>{display}</span>
        {dangling && <span className={BOX_DANGLING_CLASS}>已移出</span>}
      </div>
    );
  }

  // 可编辑 + 空链：容器即空槽（拖入 = 追加站点；三十五轮 DA48：drop 走判位
  // 路径——空链 mids 空 → index 0 = 追加，与原追加等价；六轮 DA19：点击/键盘 =
  // 「＋」多选面板——弹窗不再编排链，一轮空框口径的点击行为随之改道）。
  // 二十五轮 DA38→二十六轮 DA39 修订：开合承载事件从 pointerdown 改回
  // click（用户拍板「弹出弹窗后马上就消失了」——pointerdown 开合让刚挂载
  // 的 Radix 外出监听撞上同交互尾部的焦点变化：锚面在 portal 内容之外，
  // focusin 外出关闭路径立即触发 onDismiss；click 开合在整个交互结束后才
  // 挂外出监听，同交互不再自伤；点锚面收起由本处显式翻转承担、不依赖
  // deferred 外出关闭；空白处收起仍由包装层撤除后的原生冒泡 + Radix
  // deferred click 关闭承载）。
  if (task.chain.length === 0) {
    return (
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverAnchor asChild>
          <div
            ref={(node) => {
              dropRef(node);
              boxRef.current = node;
              setBoxEl(node);
            }}
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
              // 二十六轮 DA39：开合改回 click 期翻转——按下即翻转让同交互
              // 尾部的焦点变化落进刚挂载的 Radix 外出监听，弹窗一开即收。
              if (pickerOpen) setPickerOpen(false);
              else openPicker();
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
  // （六轮 DA19：点开面板勾选追加；容器点击仍开「修改」弹窗）。busy 时整框
  // 禁用。三十五轮 DA48：悬停成员拖拽时渲染插入指示线（caret 判位见上方
  // boxEl 状态分支——与 drop 同源 stationMetricsOf）。
  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <div
        ref={(node) => {
          dropRef(node);
          boxRef.current = node;
          setBoxEl(node);
        }}
        tabIndex={0}
        title="拖入成员按落点插入（成员前/后）；chip 拖动=调序；×=移除该站；点击打开修改弹窗"
        className={cn(
          BOX_MULTI_CLASS,
          isOver && eligible && BOX_MULTI_OVER_CLASS,
          !isOver && eligible && BOX_MULTI_CAN_DROP_CLASS,
          flash && 'border-solid border-primary',
          busy && 'pointer-events-none opacity-50',
        )}
        onClick={(e) => {
          e.stopPropagation();
          // 二十五轮 DA38：弹窗开着时点容器空白处要先收起弹窗再开「修改」
          // （stopPropagation 拦断了 Radix 的 deferred 外出关闭——显式收起）。
          if (pickerOpen) setPickerOpen(false);
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
              // 二十六轮 DA39：开合改回 click 期翻转（理由同空链锚面——
              // pointerdown 开合会被同交互尾部的焦点变化触发的 Radix
              // focusin 外出关闭立即收掉；显式翻转承担点锚面收起）。
              if (pickerOpen) setPickerOpen(false);
              else openPicker();
            }}
          >
            ＋
          </button>
        </PopoverAnchor>
        {/* 三十五轮 DA48：悬停插入指示线（判位可视化）——落点判位与 drop 一致 */}
        {caret !== null && <span className={INSERT_CARET_CLASS} style={{ left: caret }} />}
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
 * （host 已滤 removed）——二十二轮 DA35 起**已在链中的成员不再出现在
 * 列表**（用户拍板「已经选中的成员不出现在列表中」；原禁用 + 「已在链中」
 * 标废弃，chainAfterAppendMany 的去重守卫仍兜底），标题简化为「选择成员」
 * （用户拍板去掉「追加为接力站点」）；勾选若干人按勾选顺序末尾追加站点
 * （chainAfterAppendMany 整链重发）。只做加站，不做调序/移除/站点说明编辑
 * （调序=chip 拖动、移除=×，brief 恒空串；「修改」弹窗不再编排链，DA19）。
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
  /** 链中成员的站点引用（工号数字串/旧名字串）——互斥按引用比对。 */
  chainMembers: readonly string[];
  picked: readonly string[];
  busy: boolean;
  onToggle: (ref: string) => void;
  onConfirm: () => void;
}): ReactNode {
  // 二十二轮 DA35：链中成员从可选列表滤除（不渲染，不只是禁用）。v7 R3：
  // 互斥按站点引用（工号数字串）比对，不再按名——同名第二人也能入链。
  const selectable = members.filter((m) => !chainMembers.includes(memberRefOf(m)));
  return (
    <PopoverContent align="start" className="w-64 p-2">
      <div className="px-1 text-xs font-semibold text-muted-foreground">选择成员</div>
      <div className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto">
        {selectable.map((m) => {
          const ref = memberRefOf(m);
          const checked = picked.includes(ref);
          return (
            <button
              key={ref}
              type="button"
              className={cn(
                'flex w-full cursor-pointer items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-left text-xs leading-none transition-colors',
                'hover:bg-[color:var(--eteams-pill-bg)]',
              )}
              onClick={() => onToggle(ref)}
            >
              <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={20} />
              <span className="font-medium">{m.name}</span>
              <span className="text-[10px] font-normal text-muted-foreground">{m.role}</span>
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
        {selectable.length === 0 && (
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
        {picked.length > 0 ? `添加 ${picked.length} 个成员` : '添加成员'}
      </Button>
    </PopoverContent>
  );
}

/**
 * 站点 chip（二轮 DA13 嵌套 drop target；四轮 DA17 恢复 pill；五轮 DA18
 * 工号撤出版面；六轮 DA19 兼作拖拽源=调序；三十五轮 DA48 accept 收窄为
 * 站点单一类型）：
 * - 本 chip 拖到另一 chip = 调序（chainAfterReorder 数组搬移，stageBrief
 *   随站走）；自拖自放 no-op；容器不接受站点类型——空白处无落点。isOver =
 *   站点拖拽悬停（调序目标）提示——成员拖拽不再命中 chip（判位插入与去重
 *   反馈由容器承担，DA48）。
 * 中性 pill：Avatar 26px + 名字（工号与悬空标入悬浮提示，legacy 无工号不提）
 * + 悬空标（DA9；修复改走 × 移除 + 再拖入，DA48 替换废止）；× 移除该站
 * （整链重发）。
 * canDrop 与容器同 eligible（A.3.1 注记——更严方会被 dnd-core 滤掉、落点
 * 语义改变；三轮非对称已随 DA15 废止）；deps 携带最新 task/回调（不缓存旧
 * chain）。拖拽中半透明；点击冒泡到容器 = 打开「修改」弹窗。
 * data-station-index=本站下标（三十五轮 DA48 判位测量锚点——容器
 * stationMetricsOf 按 DOM 序取中点/offsetLeft）。
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
  /** 站点引用（工号数字串/旧名字串，快照原样）——显示名经 memberByRef 反查。 */
  member: string;
  members: readonly MemberView[];
  eligible: boolean;
  removable: boolean;
  onAssign: (chain: TaskSlotInput[]) => void;
  onRemove: () => void;
}): ReactNode {
  // 六轮 DA19：站点 chip 兼作拖拽源（调序）。拖拽中半透明（罗列条同款）。
  const [{ isDragging }, dragRef] = useStationDrag(index, member);
  // deps 携带最新 task/回调：spec 闭包逐渲染刷新（drop 不缓存旧 chain）。
  // 三十五轮 DA48：accept 收窄为站点单一类型（原成员/站点双类型——成员拖到
  // chip 的「定点替换」废止），drop 只剩调序分支；useFlash200 随之在本组件
  // 无消费（成员 drop 不再命中 chip，同名去重/判位插入闪现都在容器）。
  const [{ isOver }, dropRef] = useDrop<StationDragItem, unknown, { isOver: boolean }>(
    () => ({
      accept: STATION_DRAG_TYPE,
      canDrop: () => eligible,
      drop: (item) => {
        // 站点 chip → 调序：被拖站搬到本站位置（自拖自放 no-op）。
        const chain = chainAfterReorder(task, item.index, index);
        if (chain !== null) onAssign(chain);
      },
      collect: (monitor) => ({ isOver: monitor.isOver() && monitor.canDrop() }),
    }),
    [task, index, eligible, onAssign],
  );
  // v7 反查：站点 member 是工号数字串（或旧名字串）——memberByRef 双口径
  // 解析；显示名优先快照行名字（悬空时原样显示引用）。
  const record = memberByRef(members, member);
  const display = record?.name ?? member;
  const dangling = record === undefined;
  // 五轮 DA18：工号不占版面，折叠进悬浮提示（悬空标同段；两者皆无则不带括注）。
  const detail = [record?.employeeId, dangling ? '已移出' : null].filter(Boolean).join('，');
  return (
    <div
      ref={(node) => {
        dragRef(node);
        dropRef(node);
      }}
      data-station-index={index}
      style={isDragging ? { opacity: 0.5 } : undefined}
      title={`站点 ${index + 1}：${display}${detail ? `（${detail}）` : ''} · 拖到另一 chip=调序；点击打开修改弹窗`}
      className={cn(BOX_CHIP_CLASS, isOver && CHIP_RING_CLASS, isOver && BOX_OVER_SHADOW_CLASS)}
    >
      <Avatar name={display} seed={record?.avatar?.seed} salt={record?.avatar?.salt} size={26} />
      <span>{display}</span>
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
