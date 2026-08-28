/**
 * M0 placeholder for the 团队 tab (the `eteams` entry in the
 * `conversation.view` ring). The full team panel (member grid, task graph,
 * execution slots, member dialogs) lands in M4/M5 — this stub proves the
 * registration, the standard session kit, and the tab lifecycle end to end.
 *
 * @module dsh-eteams/client/eteamsView
 */
import type { CSSProperties, ReactNode } from 'react';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { PLUGIN_VERSION_LABEL } from './versionLabel';

const styles: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    overflow: 'auto',
    padding: '32px 40px',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    color: 'var(--dsw-alias-text-primary, inherit)',
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
  },
  meta: {
    margin: '6px 0 20px',
    fontSize: 12,
    opacity: 0.6,
  },
  card: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
    borderRadius: 10,
    padding: '18px 20px',
    maxWidth: 560,
    background: 'var(--dsw-alias-bg-base, transparent)',
  },
  line: {
    margin: '6px 0',
    fontSize: 13,
    lineHeight: 1.6,
  },
  badge: {
    display: 'inline-block',
    padding: '1px 8px',
    marginRight: 6,
    borderRadius: 999,
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    fontSize: 11,
    opacity: 0.8,
  },
};

/**
 * The eteams conversation view entry.
 *
 * @param props - framework-standard session kit (sessionId et al); M0 uses
 *   only `sessionId` for the diagnostic footer.
 */
export function ETeamsView(props: ConvViewProps): ReactNode {
  return (
    // The literal attribute marks eteams-owned DOM for the activation bridge.
    <div style={styles.root} data-eteams="view">
      <h2 style={styles.title}>团队</h2>
      <div style={styles.meta}>ETeams {PLUGIN_VERSION_LABEL} · M1 状态与核心工具</div>
      <div style={styles.card}>
        <p style={styles.line}>
          <span style={styles.badge}>当前里程碑</span>
          M1 已交付宿主端全生命周期（staged → 批准 → 指派 → 执行链 → 完成/升级）；面板数据视图在 M4–M5 开放。
        </p>
        <p style={styles.line}>
          <span style={styles.badge}>当前会话</span>
          {props.sessionId || '（未绑定会话）'}
        </p>
        <p style={styles.line}>
          <span style={styles.badge}>开始使用</span>
          在对话中说「用 AgentTeams 做某事」或 <code>/agent-teams</code>：领队建队 → 问询 → 拆解 → 等待你批准 → 派活执行。
        </p>
        <p style={styles.line}>
          <span style={styles.badge}>状态落盘</span>
          <code>&lt;工作区&gt;/.eteams/&lt;团队&gt;/</code>（team.json + events.jsonl + inbox/）；任务文档在
          <code> teams/&lt;团队slug&gt;/</code>。
        </p>
        <p style={styles.line}>
          <span style={styles.badge}>冒烟验证</span>
          在对话中调用 <code>eteams_ping</code> 工具可验证宿主端插件连通性。
        </p>
      </div>
    </div>
  );
}
