/**
 * 中断观察者的纯判据（用户迭代 2026-09-11）：只有 `turn/end` 且结束原因是被
 * 取消（手动停止）或崩溃补记才算「中断」——正常完成/报错/上限都不改任务状态。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { isInterruptionEvent, resolveInterruptionTarget } from '../src/host/runtime/interruption';
import { registerCaptainChild, unregisterCaptainChild } from '../src/host/runtime/captainChildRegistry';
import { registerMemberSession, resetUsageMeterForTests } from '../src/host/runtime/usage';

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

/**
 * 路由判据（用户迭代 2026-09-14）：中断会话 id → 挂起目标。此前只认成员会话，
 * 领队子代理不在册被直接 return，主任务卡在「执行中」；本组锁定两路分流。
 */
describe('resolveInterruptionTarget（中断会话 → 挂起目标）', () => {
  const memberChild = 'sess-member-1';
  const captainChild = 'sess-captain-1';

  beforeEach(() => {
    resetUsageMeterForTests();
    unregisterCaptainChild(captainChild);
  });

  afterEach(() => {
    resetUsageMeterForTests();
    unregisterCaptainChild(captainChild);
  });

  it('未登记会话（构建器等）→ undefined（不触发）', () => {
    expect(resolveInterruptionTarget('sess-unknown')).toBeUndefined();
  });

  it('成员副本行会话 → member 目标（挂该小任务）', () => {
    registerMemberSession(memberChild, {
      teamId: '7',
      memberName: 'Alice',
      employeeId: 2,
      parentSessionId: 'cap-1',
    });
    expect(resolveInterruptionTarget(memberChild)).toEqual({ kind: 'member', teamId: '7' });
  });

  it('领队子代理 → captain 目标（挂锚定的大任务，taskId 数字化）', () => {
    registerCaptainChild(captainChild, '7', '/root', '63', 'cap-1');
    expect(resolveInterruptionTarget(captainChild)).toEqual({
      kind: 'captain',
      teamId: 7,
      taskId: 63,
    });
  });
});
