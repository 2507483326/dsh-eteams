/**
 * 中断观察者的纯判据（用户迭代 2026-09-11）：只有 `turn/end` 且结束原因是被
 * 取消（手动停止）或崩溃补记才算「中断」——正常完成/报错/上限都不改任务状态。
 */
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { isInterruptionEvent } from '../src/host/runtime/interruption';

function turnEnd(kind: string): SessionEvent {
  return {
    type: 'turn/end',
    data: { turn: 1, reason: { kind } as never },
  } as unknown as SessionEvent;
}

describe('isInterruptionEvent（中断事件判据）', () => {
  it('aborted（手动停止）/ interrupted（崩溃补记）→ 命中', () => {
    expect(isInterruptionEvent(turnEnd('aborted'))).toBe(true);
    expect(isInterruptionEvent(turnEnd('interrupted'))).toBe(true);
  });

  it('completed/max-tokens/blocked/error/其它事件 → 不命中', () => {
    expect(isInterruptionEvent(turnEnd('completed'))).toBe(false);
    expect(isInterruptionEvent(turnEnd('max-tokens'))).toBe(false);
    expect(isInterruptionEvent(turnEnd('blocked'))).toBe(false);
    expect(isInterruptionEvent(turnEnd('error'))).toBe(false);
    expect(
      isInterruptionEvent({ type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent),
    ).toBe(false);
  });
});
