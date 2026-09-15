/**
 * /eteam 对话内创建卡片（docs/19.9.5，用户迭代 ⑤-4）：注册进
 * `conversation.chat.commandview` keyed 槽（key = 'eteam'），替换通用命令
 * 卡片。轮询 /eteams-api/rolebuilder 实时呈现构建状态——创建中（步骤）/
 * 待确认 / 已入库——点击「打开创建页」跳到成员构建工作台。
 *
 * S14（docs/21-client-ui-stack.md 21.6）：inline style 迁 Tailwind 类。卡片
 * 原先不在任何 `.eteams-ui` 作用域内——表面根按 D19b 挂作用域类（根自身
 * 不承工具类，后代选择器机制），卡片样式全部迁内层工具类；状态色改语义
 * token 类查表（BUILD_SESSION_META.toneClass，完整字面量，content 扫描可
 * 检出）。跳转/轮询/归属判定等行为逻辑与迁移前逐字一致。
 * M6 结构性改造（docs/44 44.3，行为零变更）：44.3 横幅分区；状态 pill 表
 * CARD_STATUS 迁 lib/status.ts（BUILD_SESSION_META，BUILD_SESSION 表）；
 * 渲染端 5 分支大三元链拆 buildView 视图键 → BUILD_VIEW_META 文案表（键由
 * 归属/轮询态推导，三元只算键名）；轮询 setTimeout 链语义原样保留（不并
 * usePoll，44.2.2/M7-8 注记）。
 * 用户 2026-09-15「转圈圈完全变成圆的，然后改成橙色」：状态行 spinner 由
 * border/rounded 技法（宿主压圆角渲染成方角）换成 SVG 圆环 + warning 橙
 * （CardSpinner，推理见该组件头注），注入式 keyframes 随撤。
 *
 * @module dsh-eteams/client/buildCard
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Provider } from 'react-redux';
// lucide 深层图标导入（dialog.tsx 先例：深层 .mjs 只进用到的图标）。
import PenLine from 'lucide-react/dist/esm/icons/pen-line.mjs';
import { Avatar } from '../features/avatar/avatar';
import { openMemberBuilder } from '../lib/bridge';
import { cn } from '../lib/cn';
import { Badge } from '../components/ui/badge';
import { ClientErrorBoundary } from '../lib/diagnostics';
import { fetchBuildState, type BuildSession } from '../lib/api';
import { BUILD_SESSION_META } from '../lib/status';
import { getApp } from '../store/app';

/** 状态行视图键（M6）：归属/轮询态推导的渲染形态——见主组件 buildView 推导。 */
type BuildViewKey =
  | 'orphanConfirmed'
  | 'orphanEnded'
  | 'loading'
  | 'activeInterview'
  | 'building'
  | 'awaitingConfirm'
  | 'confirmed'
  | 'idle';

/** ================================== 样式类 ================================== */

/** 状态 pill（S24-2 D22e 官网圆 pill 口径：中性半透明底 + 12px medium；
 * 原 layer-2 淡底任意值直引收敛到 --eteams-pill-bg token。状态字色仍由
 * BUILD_SESSION_META.toneClass 经 tailwind-merge 覆盖中性字色——彩底撤、彩
 * 字留）。 */
const STATUS_PILL_CLASS =
  'rounded-full bg-[color:var(--eteams-pill-bg)] px-2.5 py-0.5 text-xs font-medium text-[color:var(--eteams-pill-ink)]';
/** 访谈待作答 pill（D22e 品牌档：品牌淡底 token + brand-ink 字 token）。 */
const INTERVIEW_PILL_CLASS =
  'rounded-full bg-business-tint px-2.5 py-0.5 text-xs font-semibold text-[color:var(--eteams-brand-ink)]';

/** ================================== 常量与映射表 ================================== */

/**
 * 状态行视图表（M6 拆渲染端 5 分支大三元链，44.2.2）：键 = 归属/轮询态推导
 * 的视图名，text + spin 查表（推导式见主组件 buildView——三元只算键名，
 * 21.5.1 同纪律）。stepFallback 仅 building 行消费：实时步骤是运行时值不上
 * 表，表存前缀字面量件（text）与空档兜底，消费位拼接（M5 boardTab
 * EMPTY_FOOTNOTE_META 同模式）。spin = 该视图带构建 spinner。
 */
const BUILD_VIEW_META: Record<
  BuildViewKey,
  { text: string; spin: boolean; stepFallback: string }
> = {
  orphanConfirmed: { text: '本次构建已完成入库——新构建请发起 /eteam', spin: false, stepFallback: '' },
  orphanEnded: { text: '本次构建已结束（会话已被新构建取代）', spin: false, stepFallback: '' },
  loading: { text: '连接构建会话…', spin: false, stepFallback: '' },
  // 访谈未答 = 构建子代理阻塞在问答弹窗上（2026-09-10 统一问答，弹窗弹在
  // 发起构建的主对话）——不是卡死，别转圈装忙。
  activeInterview: {
    text: '意图访谈待作答——问答弹窗已弹在本对话，作答后自动续跑',
    spin: false,
    stepFallback: '',
  },
  building: { text: '角色构建师工作中 · ', spin: true, stepFallback: '准备中' },
  awaitingConfirm: { text: '草稿就绪——待你确认入库', spin: true, stepFallback: '' },
  confirmed: { text: '构建完成，成员已入库——点击查看详情', spin: false, stepFallback: '' },
  idle: { text: '没有进行中的构建会话', spin: false, stepFallback: '' },
};

/**
 * 对话内创建卡片（docs/19.9.5）的跳转口径：
 * - 2026-09-06:删除「发送即跳转」定时强跳（强跳与用户意图相反）。
 * - 2026-09-08:曾短暂 reinstated「受理即跳工作台」,因反复强拉用户离开
 *   对话（点对话闪烁弹回角色页）而再次撤除——engage 通知（用户身份消息）
 *   本身会把桌面切到对话视图,卡片在对话里实时刷新;openMemberBuilder 只
 *   保留卡片点击跳转（用户主动）。
 */

/** ================================== 进度 spinner ================================== */

/**
 * 状态行进度 spinner（用户 2026-09-15「转圈圈完全变成圆的，然后改成橙色」）：
 * 原 border/rounded 技法（border-2 + border-t-transparent 缺口环）在宿主
 * 侧样式压过 border-radius 时渲染成方角——与 stepGlyph 同因（见该模块头注）。
 * 改 SVG `<circle>` 矢量形状 + 内建 `<animateTransform>`：不经 CSS 圆角通道，
 * 宿主样式无从干扰，也不再依赖注入式 keyframes（SPIN_KEYFRAMES 随撤）。
 * 色走 warning token（橙），与构建台「进行中」档的 StepDot 同色。
 */
function CardSpinner(): ReactNode {
  return (
    <svg viewBox="0 0 10 10" className="h-3 w-3 shrink-0" aria-hidden>
      <circle
        cx="5"
        cy="5"
        r="3.75"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="15.5 8"
        style={{ stroke: 'var(--warning)' }}
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 5 5"
          to="360 5 5"
          dur="1s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  );
}

/** ================================== 主组件 ================================== */

/**
 * The in-conversation card for `/eteam` command runs. The keyed slot owner is
 * `{ node: commandNode }`; the card renders live build state instead of the
 * generic command summary.
 */
export function EteamBuildCard(props: { node?: unknown }): ReactNode {
  // 构建归属（用户迭代）：命令节点自带本次调用的 commandId，会话里记录
  // 同一个 id——卡片只跟自己的构建；对不上的历史卡片冻结在「已结束」，
  // 不再跟着工作区单槽里的新构建状态跑。
  // myCommandId 由节点数据派生、对一张卡片而言终生不变——用初始化一次
  // 的 state 固定住，既满足 exhaustive-deps，也语义正确（归属不可变）。
  const [myCommandId] = useState<string | null>(() =>
    typeof (props.node as { commandId?: unknown } | undefined)?.commandId === 'string'
      ? (props.node as { commandId: string }).commandId
      : null,
  );
  const [build, setBuild] = useState<BuildSession | null | 'loading'>('loading');
  // 归属构建最后一次匹配到的快照（state，渲染期可安全读取）：会话槽被
  // 新构建覆盖后，旧卡片用它冻结出真实的终态（已入库/已放弃），而不是
  // 无凭据的「已结束」。
  const [lastMatch, setLastMatch] = useState<BuildSession | null>(null);
  const [orphaned, setOrphaned] = useState(false);
  // 受理即写盘后首轮轮询即命中；扑空（null）时仍以 800ms 有界重试兜底
  // （宿主重启/磁盘慢的场合），旧历史卡片重试完自然停。
  const nullRetriesRef = useRef(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = (): void => {
      void fetchBuildState()
        .then((s) => {
          if (!alive) return;
          setBuild(s);
          const owned =
            s !== null &&
            s.commandId !== undefined &&
            myCommandId !== null &&
            s.commandId === myCommandId;
          if (owned) {
            setLastMatch(s);
            setOrphaned(false);
            // 跳转已撤（用户迭代 2026-09-08「跳对话不是跳到角色创建页面」）：
            // engage 通知（用户身份）本身会把桌面切到对话视图，构建卡片就在
            // 对话里实时刷新；点击卡片仍可打开构建工作台（用户主动）。
          } else if (s !== null && myCommandId !== null) {
            // 槽里是别人的构建——本卡片归属的构建已被覆盖，冻结终态并停轮询。
            setOrphaned(true);
            return;
          }
          const status = s?.status;
          if (status === 'active' || status === 'awaiting_confirmation') {
            timer = window.setTimeout(tick, 1500);
          } else if (s === null && nullRetriesRef.current < 75) {
            nullRetriesRef.current += 1;
            timer = window.setTimeout(tick, 800);
          }
        })
        .catch(() => {
          if (alive && nullRetriesRef.current < 75) {
            nullRetriesRef.current += 1;
            timer = window.setTimeout(tick, 1500);
          }
        });
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // myCommandId 经 useState 初始化器固定，终生不变——mount-once 轮询语义
    // 下无重复执行需求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 归属判定（渲染期）：本卡片对应的构建会话。
  // - myCommandId === null：旧版卡片（无节点标识）→ 维持旧行为跟实时槽；
  // - orphaned：槽里已是别人的构建 → 用最后匹配快照渲染冻结终态。
  const shown: BuildSession | null | 'loading' =
    myCommandId !== null && orphaned ? lastMatch : build;
  const showStatus =
    shown === 'loading' || shown === null ? null : BUILD_SESSION_META[shown.status];
  const showName =
    shown === 'loading' || shown === null ? '新成员' : (shown.draft?.name ?? '新成员');
  const showAvatar = shown === 'loading' || shown === null ? undefined : shown.draft?.avatar;
  const showInterviewPending =
    shown !== 'loading' &&
    shown !== null &&
    shown.interview !== undefined &&
    shown.interview.answers === undefined;
  const isOrphan = myCommandId !== null && orphaned;
  // 状态行视图键（M6 拆 5 分支大三元链）：三元只算键名，文案与 spinner 形态
  // 查 BUILD_VIEW_META。推导顺序与原三元分支判定逐支等价——orphan 的
  // confirmed 终态优先（loading/null 亦落已结束档，原分支同口径）；active
  // 带未答访谈单列（不转圈）；active/awaiting 走 spinner；confirmed 入库；
  // cancelled 与无会话同落 idle（原 else 兜底「没有进行中的构建会话」）。
  const buildView: BuildViewKey = isOrphan
    ? shown !== 'loading' && shown !== null && shown.status === 'confirmed'
      ? 'orphanConfirmed'
      : 'orphanEnded'
    : shown === 'loading'
      ? 'loading'
      : shown === null
        ? 'idle'
        : shown.status === 'active'
          ? showInterviewPending
            ? 'activeInterview'
            : 'building'
          : shown.status === 'awaiting_confirmation'
            ? 'awaitingConfirm'
            : shown.status === 'confirmed'
              ? 'confirmed'
              : 'idle';
  // building 行的实时步骤串（其余视图无此插值）：空档落表内兜底「准备中」。
  const shownStep = shown === 'loading' || shown === null ? '' : shown.step;

  return (
    <ClientErrorBoundary label="成员创建卡片">
      {/* R2-F2（docs/21 21.5.3）：表面根包 Provider——单例 store，多 Provider
      同 store 无害。本表面自身暂无 store hook，Provider 供子树按 dva 拓扑
      消费 useSelector/useDispatch。 */}
      <Provider store={getApp().store}>
        {/* 表面根（D19b/S14）：对话内卡片不在任何 .eteams-ui 作用域内——根
      自身不承工具类（`.eteams-ui .utility` 后代选择器机制），这里挂作用域
      类承载 token 变量与字面量，卡片样式全部迁内层。 */}
        <div className="eteams-ui">
          <div
            className={cn(
              'my-1.5 flex items-center gap-2.5 rounded-xl border border-solid px-3.5 py-2.5',
              // S24-2（D22a）：l2 别名任意值直引收敛语义 token --border（官网
              // slate-200/slate-800，亮暗随主题翻档）。
              'border-[color:var(--border)]',
              isOrphan ? 'cursor-default opacity-[0.72]' : 'cursor-pointer opacity-100',
            )}
            onClick={() => {
              if (!isOrphan) openMemberBuilder();
            }}
            role="button"
            title={isOrphan ? '本次构建已结束' : '点击打开成员创建页'}
          >
            <Avatar name={showName} seed={showAvatar?.seed} salt={showAvatar?.salt} size={34} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                <span>{isOrphan ? '成员构建 · 已结束' : `成员创建中 · ${showName}`}</span>
                {showStatus !== null && (
                  /* docs/23 S23-5：状态 pill 迁 shadcn Badge（视觉口径以
                      className 覆盖层保留）。 */
                  <Badge
                    variant="secondary"
                    className={cn(STATUS_PILL_CLASS, showStatus.toneClass)}
                  >
                    {showStatus.label}
                  </Badge>
                )}
                {showInterviewPending && (
                  <Badge variant="secondary" className={INTERVIEW_PILL_CLASS}>
                    <PenLine className="h-3.5 w-3.5" />
                    意图访谈待作答
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                {BUILD_VIEW_META[buildView].spin ? (
                  <>
                    <CardSpinner />
                    <span>
                      {buildView === 'building'
                        ? `${BUILD_VIEW_META.building.text}${
                            shownStep === '' ? BUILD_VIEW_META.building.stepFallback : shownStep
                          }`
                        : BUILD_VIEW_META[buildView].text}
                    </span>
                  </>
                ) : (
                  <span>{BUILD_VIEW_META[buildView].text}</span>
                )}
              </div>
            </div>
            {!isOrphan && (
              <span className="shrink-0 text-xs text-muted-foreground">打开创建页 →</span>
            )}
          </div>
        </div>
      </Provider>
    </ClientErrorBoundary>
  );
}
