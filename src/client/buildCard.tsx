/**
 * /eteam 对话内创建卡片（docs/19.9.5，用户迭代 ⑤-4）：注册进
 * `conversation.chat.commandview` keyed 槽（key = 'eteam'），替换通用命令
 * 卡片。轮询 /eteams-api/rolebuilder 实时呈现构建状态——创建中（步骤）/
 * 待确认 / 已入库——点击「打开创建页」跳到成员构建工作台。
 *
 * @module dsh-eteams/client/buildCard
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Avatar } from './avatar';
import { openMemberBuilder } from './bridge';
import { ClientErrorBoundary } from './diagnostics';
import { fetchBuildState, type BuildSession } from './api';

/** Status → (label, tone color). */
const CARD_STATUS: Record<BuildSession['status'], { label: string; color: string }> = {
  active: { label: '创建中', color: 'var(--dsw-alias-state-business-primary, #1d4ed8)' },
  awaiting_confirmation: { label: '待确认', color: 'var(--dsw-alias-state-warn-primary, #b45309)' },
  confirmed: { label: '已入库', color: 'var(--dsw-alias-state-success-primary, #15803d)' },
  cancelled: { label: '已放弃', color: 'var(--dsw-alias-label-tertiary, #808da4)' },
};

const SPIN_KEYFRAMES = '@keyframes eteams-card-spin{to{transform:rotate(360deg)}}';

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
  const showStatus =
    shown === 'loading' || shown === null ? null : CARD_STATUS[shown.status];
  const showName = shown === 'loading' || shown === null ? '新成员' : (shown.draft?.name ?? '新成员');
  const showAvatar = shown === 'loading' || shown === null ? undefined : shown.draft?.avatar;
  const showInterviewPending =
    shown !== 'loading' && shown !== null &&
    shown.interview !== undefined && shown.interview.answers === undefined;
  const isOrphan = myCommandId !== null && orphaned;

  return (
    <ClientErrorBoundary label="成员创建卡片">
      <style>{SPIN_KEYFRAMES}</style>
      <div
        style={{
          border: '1px solid var(--dsw-alias-border-l2, rgba(100,116,139,0.26))',
          borderRadius: 12,
          padding: '10px 14px',
          margin: '6px 0',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: isOrphan ? 'default' : 'pointer',
          opacity: isOrphan ? 0.72 : 1,
        }}
        onClick={() => {
          if (!isOrphan) openMemberBuilder();
        }}
        role="button"
        title={isOrphan ? '本次构建已结束' : '点击打开成员创建页'}
      >
        <Avatar name={showName} seed={showAvatar?.seed} salt={showAvatar?.salt} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            <span>{isOrphan ? '成员构建 · 已结束' : `成员创建中 · ${showName}`}</span>
            {showStatus !== null && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '1px 8px',
                  borderRadius: 999,
                  color: showStatus.color,
                  background: 'var(--dsw-alias-bg-layer-2, rgba(100,116,139,0.1))',
                }}
              >
                {showStatus.label}
              </span>
            )}
            {showInterviewPending && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '1px 8px',
                  borderRadius: 999,
                  color: 'var(--dsw-alias-brand-primary, #4b7bec)',
                  background: 'var(--dsw-alias-interactive-bg-active, rgba(75,123,236,0.12))',
                }}
              >
                ✍️ 意图访谈待作答
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 12,
              opacity: 0.7,
              marginTop: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {isOrphan ? (
              <span>
                {shown !== 'loading' && shown !== null && shown.status === 'confirmed'
                  ? '本次构建已完成入库——新构建请发起 /eteam'
                  : '本次构建已结束（会话已被新构建取代）'}
              </span>
            ) : shown === 'loading' ? (
              <span>连接构建会话…</span>
            ) : shown !== null && (shown.status === 'active' || shown.status === 'awaiting_confirmation') ? (
              shown.status === 'active' && showInterviewPending ? (
                // 访谈未答 = 阶段代理按设计已结束回合，不是卡死——别转圈装忙。
                <span>✍️ 意图访谈待作答——点开回答后自动续跑</span>
              ) : (
                <>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      border: '2px solid var(--dsw-alias-brand-primary, #4b7bec)',
                      borderTopColor: 'transparent',
                      animation: 'eteams-card-spin 0.9s linear infinite',
                    }}
                  />
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
        {!isOrphan && <span style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}>打开创建页 →</span>}
      </div>
    </ClientErrorBoundary>
  );
}
