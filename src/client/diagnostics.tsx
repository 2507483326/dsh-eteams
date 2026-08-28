/**
 * Client-side diagnostics (FR: 插件日志记录): capture every renderer-side
 * error the main-process logs cannot see — bundle load, window errors,
 * unhandled rejections, React render failures — into a ring buffer and
 * batch-upload them to the host route `POST /plugins/dsh-eteams/client-log`,
 * which persists them under `<workspace>/.eteams/logs/client.log` for
 * offline inspection.
 *
 * @module dsh-eteams/client/diagnostics
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { PLUGIN_VERSION_LABEL } from './versionLabel';

/** Client-side log URL served by the host web surface. */
const CLIENT_LOG_URL = '/plugins/dsh-eteams/client-log';

/** One captured client-side event. */
export interface ClientDiagEntry {
  at: number;
  kind: string;
  message: string;
  source?: string;
}

const MAX_ENTRIES = 30;
const entries: ClientDiagEntry[] = [];
let installed = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Record one diagnostic event (console + ring buffer + scheduled upload). */
export function recordClientDiag(kind: string, message: string, source?: string): void {
  const entry: ClientDiagEntry = {
    at: Date.now(),
    kind: kind.slice(0, 60),
    message: String(message).slice(0, 500),
    source: source === undefined ? undefined : String(source).slice(0, 200),
  };
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
  console.warn('[eteams]', entry.kind, entry.message);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flush();
  }, 2000);
}

async function flush(): Promise<void> {
  if (entries.length === 0) return;
  const batch = { version: PLUGIN_VERSION_LABEL, entries: entries.slice() };
  try {
    await fetch(CLIENT_LOG_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      keepalive: true,
    });
  } catch {
    // Host unreachable (webless profile or shutdown): entries stay local only.
  }
}

/** Current ring buffer (for the panel's self-diagnostics view). */
export function clientDiagEntries(): ClientDiagEntry[] {
  return entries.slice();
}

/**
 * Install the global capture hooks. Safe to call once from apply(); no-op in
 * non-DOM environments and on repeated calls.
 */
export function installClientDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    recordClientDiag(
      'error',
      event.message,
      `${event.filename ?? ''}:${event.lineno}:${event.colno}`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordClientDiag('unhandledrejection', String((event as PromiseRejectionEvent).reason));
  });
  recordClientDiag('bundle', `eteams client bundle loaded ${PLUGIN_VERSION_LABEL}`);
}

interface BoundaryProps {
  readonly label: string;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly error: Error | null;
}

/**
 * Render-isolating boundary: a crash inside any eteams surface degrades only
 * that surface (visible fallback box) and is recorded — it can never take
 * down the surrounding GUI tree.
 */
export class ClientErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    recordClientDiag(
      `render:${this.props.label}`,
      error.message,
      info.componentStack?.split('\n')[1],
    );
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div
          style={{
            border: '1px solid #c0454566',
            borderRadius: 10,
            padding: '12px 16px',
            margin: 8,
            fontSize: 13,
            opacity: 0.85,
          }}
        >
          ⚠️ eteams「{this.props.label}」渲染失败（已记录日志，可继续使用其余功能）
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            {String(this.state.error.message).slice(0, 200)}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
