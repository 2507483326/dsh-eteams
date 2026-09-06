/**
 * eteams_build_wait tests（docs/19.17.1 主对话零播报）：调用者守卫、终态
 * 即回、变更唤醒（原始文件内容令牌——builderWakeKey 不动 updatedAt 也要能
 * 唤醒）与受理即预落盘 childId。直接驱动工具 execute，走与 webui.test.ts
 * 同款的离线 ctx 桩。
 *
 * @module dsh-eteams/tests/buildWait
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../src/host/config';
import { ETeamsConfig } from '../src/host/config';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { startBuilderChild } from '../src/host/runtime/builderPhases';
import {
  cancelBuildSession,
  confirmBuildSession,
  markBuilderChild,
  markBuilderWake,
  readBuildSession,
  reportBuildProgress,
} from '../src/host/runtime/roleBuilder';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let workspace: string;
let config: ETeamsResolvedConfig;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eteams-buildwait-'));
  config = ETeamsConfig({}) as ETeamsResolvedConfig;
});

afterEach(() => {
  cleanupTempWorkspace(workspace);
});

const stateRoot = (): string => join(workspace, '.eteams');

/** 构建子代理侧的假调用者（id 即守卫凭据；cwd 定位状态根）。 */
function childAgent(): { id: string; session: { header: { cwd: string } } } {
  return { id: 'builder-child-1', session: { header: { cwd: workspace } } };
}

/** 与 webui.test.ts fakeCtx 同款的离线桩（无 subagents 面——本套件不派发）。 */
function fakeCtx(subagents?: unknown): Context {
  return {
    logger: { info: () => undefined, warn: () => undefined },
    ...(subagents !== undefined ? { subagents } : {}),
    agents: { get: () => undefined },
    tools: { register() {} },
    systemPrompt: { section() {} },
    get: (key: string) =>
      key === 'workspaceRegistry'
        ? { list: () => [{ path: workspace, title: 'ws' }] }
        : undefined,
  } as unknown as Context;
}

function callWait(
  args: Record<string, unknown> = {},
  agent: { id: string } = childAgent(),
): Promise<Record<string, unknown>> {
  const tools = createCaptainTools(config, fakeCtx());
  const tool = tools.find((t) => t.name === 'eteams_build_wait');
  if (!tool) throw new Error('eteams_build_wait 未注册');
  return tool.execute(args as never, { agent, signal: undefined } as never) as Promise<
    Record<string, unknown>
  >;
}

describe('eteams_build_wait（docs/19.17.1 停驻等待）', () => {
  it('errors on a missing session', async () => {
    await expect(callWait({ maxWaitSeconds: 10 })).rejects.toThrow(/没有进行中的构建会话/);
  });

  it('only the current builder child may park (strict caller guard)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    // 会话还没落 builderChildId → 无凭据可用，一律拒绝
    await expect(callWait({ maxWaitSeconds: 10 })).rejects.toThrow(/只有当前构建子代理/);
    // 凭据在盘上但属于另一个持有者 → 拒绝
    await markBuilderChild(stateRoot(), 'someone-else');
    await expect(callWait({ maxWaitSeconds: 10 })).rejects.toThrow(/只有当前构建子代理/);
  });

  it('returns immediately (changed=true) on a terminal session', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await cancelBuildSession(stateRoot());
    const result = await callWait({ maxWaitSeconds: 10 });
    expect(result).toMatchObject({ ok: true, changed: true, status: 'cancelled', waitedSeconds: 0 });
  });

  it('wakes on confirm — raw-content token, no updatedAt dependency', async () => {
    await reportBuildProgress(stateRoot(), {
      request: 'r',
      draft: { name: 'data-eng', role: '数据工程师', personaMd: '# 手册' },
    });
    await reportBuildProgress(stateRoot(), { status: 'awaiting_confirmation' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    const pending = callWait();
    // 停驻期间确认入库（builderWakeKey 路径之外的真实写入）：轮询按原始
    // 内容比对在数秒内醒来，status 直报 confirmed。
    await confirmBuildSession(stateRoot(), { name: 'data-eng', role: '数据工程师' });
    await vi.waitFor(() => expect(pending).resolves.toMatchObject({ changed: true }), {
      timeout: 15_000,
    });
    expect(await pending).toMatchObject({ ok: true, changed: true, status: 'confirmed' });
  });

  it('wakes on a bare wake-mark write (markBuilderWake leaves updatedAt alone)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    const pending = callWait();
    await markBuilderWake(stateRoot(), `${readBuildSession(stateRoot())?.startedAt ?? 0}:ans-1`);
    await vi.waitFor(() => expect(pending).resolves.toMatchObject({ changed: true }), {
      timeout: 15_000,
    });
    expect(await pending).toMatchObject({ ok: true, changed: true, status: 'active' });
  });
});

describe('startBuilderChild pre-writes the guard credential (docs/19.17.1)', () => {
  it('builderChildId is on disk before startContinuable submits the prompt', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r', commandId: 'cmd-1' });
    const seen: { specChildId?: string; onDiskAtSubmit?: string | undefined } = {};
    const ctx = fakeCtx({
      async startContinuable(spec: { childId?: string }) {
        seen.specChildId = spec.childId;
        seen.onDiskAtSubmit = readBuildSession(stateRoot())?.builderChildId;
        return { childId: spec.childId, messageId: 'm-fake' };
      },
      async followup() {
        return 'm-fake';
      },
    });
    startBuilderChild({
      ctx: { subagents: (ctx as unknown as { subagents: unknown }).subagents } as never,
      config,
      parent: { id: 'parent-1' } as never,
      stateRoot: stateRoot(),
      logger: console,
    });
    await vi.waitFor(() => expect(seen.specChildId).toBeDefined(), { timeout: 5_000 });
    // 提交初始 prompt 时凭据已在盘上且与 spec.childId 一致——eteams_build_wait
    // 的守卫从子代理第一拍起就能放行。
    expect(seen.onDiskAtSubmit).toBe(seen.specChildId);
    expect(readBuildSession(stateRoot())?.builderChildId).toBe(seen.specChildId);
  });
});