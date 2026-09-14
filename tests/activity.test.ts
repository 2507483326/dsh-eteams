/**
 * 看板动态事件域（runtime/activity）单测：`summarizeEvent` 补齐全部当前实际
 * 发出的事件类型（旧实现漏了 attempt 系列、task.wait、task.retrying、
 * decision.resolved 等，会渲染成裸 type 串），`eventTone` 语义分档（完成=ok、
 * 挂起等待=warn、取消=err、其余=info）。用户 2026-09-14「看板里面的动态改成
 * 和任务绑定」。
 *
 * @module dsh-eteams/tests/activity
 */
import { describe, expect, it } from 'vitest';
import { eventTone, summarizeEvent } from '../src/host/runtime/activity';
import type { EventRecord } from '../src/host/model/types';

const actor = { kind: 'system' as const };
const ev = (type: string, payload?: Record<string, unknown>, taskId?: number): EventRecord => ({
  seq: 1,
  at: 0,
  actor,
  type,
  ...(taskId !== undefined ? { taskId } : {}),
  ...(payload !== undefined ? { payload } : {}),
});

describe('summarizeEvent 补齐实际发出的事件类型', () => {
  it('attempt.*（当前运行时命名）渲染为中文而非裸 type 串', () => {
    expect(summarizeEvent(ev('attempt.claimed', { member: 'Alice' }, 3))).toContain('Alice');
    expect(summarizeEvent(ev('attempt.progress', { text: '写完接口' }, 3))).toContain('写完接口');
    expect(summarizeEvent(ev('attempt.declined', { reason: '忙' }, 3))).toContain('忙');
    expect(summarizeEvent(ev('attempt.revoked', { reason: '改派' }, 3))).toContain('改派');
  });

  it('task.wait / task.retrying / task.escalated / decision.resolved 有专门文案', () => {
    expect(summarizeEvent(ev('task.wait', { retryCount: 3 }, 3))).toContain('待领队分诊');
    expect(summarizeEvent(ev('task.retrying', { retry: 2 }, 3))).toContain('重试');
    expect(summarizeEvent(ev('task.escalated', { note: '需用户定夺' }, 3))).toContain('需用户定夺');
    expect(summarizeEvent(ev('decision.resolved', { choice: 'reassign' }, 3))).toContain('决策已处理');
    expect(summarizeEvent(ev('decision.resolved', { choice: 'reassign' }, 3))).toContain('reassign');
  });

  it('未知类型原样返回（不臆造文案）', () => {
    expect(summarizeEvent(ev('custom.future'))).toBe('custom.future');
  });
});

describe('eventTone 语义分档', () => {
  it('完成/站点完成/决策已处理 = ok', () => {
    expect(eventTone('task.completed')).toBe('ok');
    expect(eventTone('task.stage_completed')).toBe('ok');
    expect(eventTone('decision.resolved')).toBe('ok');
  });

  it('挂起/等待/升级/重试/婉拒/作废 = warn', () => {
    expect(eventTone('task.suspended')).toBe('warn');
    expect(eventTone('task.wait')).toBe('warn');
    expect(eventTone('task.escalated')).toBe('warn');
    expect(eventTone('task.retrying')).toBe('warn');
    expect(eventTone('attempt.declined')).toBe('warn');
  });

  it('取消 = err，其余 = info', () => {
    expect(eventTone('task.cancelled')).toBe('err');
    expect(eventTone('task.created')).toBe('info');
    expect(eventTone('custom.future')).toBe('info');
  });
});
