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
      <div style={styles.meta}>ETeams {PLUGIN_VERSION_LABEL} · M0 脚手架</div>
      <div style={styles.card}>
        <p style={styles.line}>
          <span style={styles.badge}>里程碑</span>
          团队面板（成员网格 / 任务图 / 执行槽 / 成员对话框）将在 M4–M5 开放。
        </p>
        <p style={styles.line}>
          <span style={styles.badge}>当前会话</span>
          {props.sessionId || '（未绑定会话）'}
        </p>
        <p style={styles.line}>
          <span style={styles.badge}>冒烟验证</span>
          在对话中调用 <code>eteams_ping</code> 工具可验证宿主端插件连通性。
        </p>
      </div>
    </div>
  );
}
