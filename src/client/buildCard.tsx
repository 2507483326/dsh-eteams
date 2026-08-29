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
 * The in-conversation card for `/eteam` command runs. The keyed slot owner is
 * `{ node: commandNode }`; the card renders live build state instead of the
 * generic command summary.
 */
export function EteamBuildCard(_props: { node?: unknown }): ReactNode {
  const [build, setBuild] = useState<BuildSession | null | 'loading'>('loading');
  // 发送即跳转（docs/19.16）：首次拉取发现「新鲜」active 会话（20s 内开启）
  // 就直接打开成员创建页。老会话/历史卡片不跳，避免回滚历史时被拽走。
  const jumpedRef = useRef<number | null>(null);
  // 受理写盘与首次拉取存在竞态：扑空（null）时以 800ms 有界重试（~20s），
  // 避免错过刚受理的会话；旧历史卡片重试完自然停。
  const nullRetriesRef = useRef(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = (): void => {
      void fetchBuildState()
        .then((s) => {
          if (!alive) return;
          setBuild(s);
          if (
            s !== null &&
            s.status === 'active' &&
            Date.now() - s.startedAt < 20_000 &&
            jumpedRef.current !== s.startedAt
          ) {
            jumpedRef.current = s.startedAt;
            openMemberBuilder();
          }
          const status = s?.status;
          if (status === 'active' || status === 'awaiting_confirmation') {
            timer = window.setTimeout(tick, 1500);
          } else if (s === null && nullRetriesRef.current < 25) {
            nullRetriesRef.current += 1;
            timer = window.setTimeout(tick, 800);
          }
        })
        .catch(() => {
          if (alive && nullRetriesRef.current < 25) {
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
  }, []);

  const status =
    build === 'loading' || build === null ? null : CARD_STATUS[build.status];
  const name =
    build === 'loading' || build === null ? '新成员' : (build.draft?.name ?? '新成员');
  const step = build === 'loading' || build === null ? '' : build.step;

  return (
    <ClientErrorBoundary label="成员创建卡片">
      <style>{SPIN_KEYFRAMES}</style>
      <div
        style={{
          border: '1px solid var(--dsw-alias-border-l2, rgba(100,116,139,0.26))',
          borderRadius: 12,
          padding: '10px 14px',
          margin: '6px 0',
          maxWidth: 560,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
        }}
        onClick={() => {
          openMemberBuilder();
        }}
        role="button"
        title="点击打开成员创建页"
      >
        <Avatar name={name} size={34} />
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
            <span>成员创建中 · {name}</span>
            {status !== null && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '1px 8px',
                  borderRadius: 999,
                  color: status.color,
                  background: 'var(--dsw-alias-bg-layer-2, rgba(100,116,139,0.1))',
                }}
              >
                {status.label}
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
            {build === 'loading' ? (
              <span>连接构建会话…</span>
            ) : build !== null && (build.status === 'active' || build.status === 'awaiting_confirmation') ? (
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
                  {build.status === 'active'
                    ? `角色构建师工作中 · ${step !== '' ? step : '准备中'}`
                    : '草稿就绪——待你确认入库'}
                </span>
              </>
            ) : build !== null && build.status === 'confirmed' ? (
              <span>构建完成，成员已入库——点击查看详情</span>
            ) : (
              <span>没有进行中的构建会话</span>
            )}
          </div>
        </div>
        <span style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}>打开创建页 →</span>
      </div>
    </ClientErrorBoundary>
  );
}
