/**
 * /eteam 对话内创建卡片（docs/19.9.5，用户迭代 ⑤-4）：注册进
 * `conversation.chat.commandview` keyed 槽（key = 'eteam'），替换通用命令
 * 卡片。轮询 /eteams-api/rolebuilder 实时呈现构建状态——创建中（步骤）/
 * 待确认 / 已入库——点击「打开创建页」跳到成员构建工作台。
 *
 * S14（docs/21-client-ui-stack.md 21.6）：inline style 迁 Tailwind 类。卡片
 * 原先不在任何 `.eteams-ui` 作用域内——表面根按 D19b 挂作用域类（根自身
 * 不承工具类，后代选择器机制），卡片样式全部迁内层工具类；状态色改语义
 * token 类查表（CARD_STATUS.toneClass，完整字面量，content 扫描可检出）。
 * 跳转/轮询/归属判定等行为逻辑与迁移前逐字一致。
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
import { getApp } from '../store/app';

/** Status → (label, toneClass)：语义 token 类（active→business、待确认→
 * warning、已入库→success、放弃→muted-foreground，与原 state-err/warn/
 * success、label-tertiary 变量同源，D19c）；类名一律完整字面量（21.5.1
 * content 扫描纪律）。 */
const CARD_STATUS: Record<BuildSession['status'], { label: string; toneClass: string }> = {
  active: { label: '创建中', toneClass: 'text-business' },
  awaiting_confirmation: { label: '待确认', toneClass: 'text-warning' },
  confirmed: { label: '已入库', toneClass: 'text-success' },
  cancelled: { label: '已放弃', toneClass: 'text-muted-foreground' },
};

const SPIN_KEYFRAMES = '@keyframes eteams-card-spin{to{transform:rotate(360deg)}}';

/** 状态 pill（S24-2 D22e 官网圆 pill 口径：中性半透明底 + 12px medium；
 * 原 layer-2 淡底任意值直引收敛到 --eteams-pill-bg token。状态字色仍由
 * CARD_STATUS.toneClass 经 tailwind-merge 覆盖中性字色——彩底撤、彩字留）。 */
const STATUS_PILL_CLASS =
  'rounded-full bg-[color:var(--eteams-pill-bg)] px-2.5 py-0.5 text-xs font-medium text-[color:var(--eteams-pill-ink)]';
/** 访谈待作答 pill（D22e 品牌档：品牌淡底 token + brand-ink 字 token）。 */
const INTERVIEW_PILL_CLASS =
  'rounded-full bg-business-tint px-2.5 py-0.5 text-xs font-semibold text-[color:var(--eteams-brand-ink)]';
/** 进度 spinner（标准 border 技法：brand 主色描边、顶部透明、keyframes 旋转）。 */
const SPINNER_CLASS =
  'inline-block h-3 w-3 rounded-full border-2 border-solid border-primary border-t-transparent [animation:eteams-card-spin_0.9s_linear_infinite]';

/**
 * 发送即跳转的去重标记（模块级，docs/19.16）：卡片会随聊天重渲染频繁重
 * 挂载，useRef 每次归零会把用户从对话页反复拽回面板——按 startedAt 全局
 * 只跳一次，用户之后可以自由切回对话 tab。
 */
let jumpedSessionAt: number | null = null;
/** 用户最后一次点击的时间戳（capture）：会话开启之后的任何点击 = 接管导航。 */
let lastUserClickAt = 0;
if (typeof document !== 'undefined') {
  const flag = '__eteamsClickLatch__';
  const g = globalThis as Record<string, unknown>;
  if (g[flag] !== true) {
    g[flag] = true;
    // 任何用户点击都记时间戳：自动跳转仅当「会话开启（startedAt）之后用户
    // 没有点过任何东西」才允许。判定与宿主 tab 的标记结构完全解耦（存在
    // button[role=tab] 与旧版 leaf div 两种变体，按选择器匹配会漏——漏掉的
    // 那次点击之后，受理竞态窗口内的重试跳转就会把用户从对话拽回团队）。
    // 发送动作发生在会话创建之前，不影响本次跳转资格；我们自己
    // openMemberBuilder 的程序化点击也落在跳转之后，只影响同会话的后续
    // 跳转（本就不存在）。
    document.addEventListener(
      'click',
      () => {
        lastUserClickAt = Date.now();
      },
      true,
    );
  }
}

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
          } else if (s !== null && myCommandId !== null) {
            // 槽里是别人的构建——本卡片归属的构建已被覆盖，冻结终态并停轮询。
            setOrphaned(true);
            return;
          }
          if (
            s !== null &&
            s.status === 'active' &&
            Date.now() - s.startedAt < 20_000 &&
            lastUserClickAt < s.startedAt &&
            jumpedSessionAt !== s.startedAt
          ) {
            jumpedSessionAt = s.startedAt;
            openMemberBuilder();
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
  const showStatus = shown === 'loading' || shown === null ? null : CARD_STATUS[shown.status];
  const showName =
    shown === 'loading' || shown === null ? '新成员' : (shown.draft?.name ?? '新成员');
  const showAvatar = shown === 'loading' || shown === null ? undefined : shown.draft?.avatar;
  const showInterviewPending =
    shown !== 'loading' &&
    shown !== null &&
    shown.interview !== undefined &&
    shown.interview.answers === undefined;
  const isOrphan = myCommandId !== null && orphaned;

  return (
    <ClientErrorBoundary label="成员创建卡片">
      {/* R2-F2（docs/21 21.5.3）：表面根包 Provider——单例 store，多 Provider
      同 store 无害。本表面自身暂无 store hook，Provider 供子树按 dva 拓扑
      消费 useSelector/useDispatch。 */}
      <Provider store={getApp().store}>
        <style>{SPIN_KEYFRAMES}</style>
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
                {isOrphan ? (
                  <span>
                    {shown !== 'loading' && shown !== null && shown.status === 'confirmed'
                      ? '本次构建已完成入库——新构建请发起 /eteam'
                      : '本次构建已结束（会话已被新构建取代）'}
                  </span>
                ) : shown === 'loading' ? (
                  <span>连接构建会话…</span>
                ) : shown !== null &&
                  (shown.status === 'active' || shown.status === 'awaiting_confirmation') ? (
                  shown.status === 'active' && showInterviewPending ? (
                    // 访谈未答 = 阶段代理按设计已结束回合，不是卡死——别转圈装忙。
                    <span>意图访谈待作答——点开回答后自动续跑</span>
                  ) : (
                    <>
                      <span className={SPINNER_CLASS} />
                      <span>
                        {shown.status === 'active'
                          ? `角色构建师工作中 · ${shown.step !== '' ? shown.step : '准备中'}`
                          : '草稿就绪——待你确认入库'}
                      </span>
                    </>
                  )
                ) : shown !== null && shown.status === 'confirmed' ? (
                  <span>构建完成，成员已入库——点击查看详情</span>
                ) : (
                  <span>没有进行中的构建会话</span>
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
