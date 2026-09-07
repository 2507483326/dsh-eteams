/**
 * 子代理会话声明路线登记单测（用户迭代 2026-09-07「子代理会话中显示实际的
 * provider/model」）：recordDeclaredRouteFromChild 从 continuable 子代理的
 * `subagent/descriptor` 事件折出 agentOptions 声明（目录级 id）并登记——
 * 观测路线（request/header）的 model 是上游限定 id，显示以声明值为准。
 * 重点是折不出/折坏时的安全早退（登记绝不影响子代理）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import {
  declaredRouteOf,
  recordDeclaredRouteFromChild,
  resetSessionRoutesForTests,
} from '../src/host/runtime/sessionRoutes';
import { installMemberRuntime } from '../src/host/runtime/members';

/** 一个 continuable descriptor 事件（键集与 parseSubagentDescriptor 的白名单一致）。 */
function descriptorEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'subagent/descriptor',
    data: {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'eteams-member:t1:1:2',
      agentProvider: 'tokenrouter',
      agentModel: 'glm-5.3-free',
      ...overrides,
    },
  };
}

describe('sessionRoutes（子代理声明路线登记）', () => {
  beforeEach(() => {
    resetSessionRoutesForTests();
  });

  it('continuable 子代理：从 descriptor 折出 agentProvider/agentModel 登记', () => {
    recordDeclaredRouteFromChild({
      id: 'child-1',
      session: {
        header: { seedLength: 3 },
        events: [{ type: 'user/message' }, { type: 'x' }, { type: 'y' }, descriptorEvent()],
      },
    });
    expect(declaredRouteOf('child-1')).toEqual({ provider: 'tokenrouter', model: 'glm-5.3-free' });
  });

  it('one-shot 子代理不登记；无 descriptor 的会话不登记', () => {
    recordDeclaredRouteFromChild({
      id: 'child-one-shot',
      session: { header: { seedLength: 0 }, events: [descriptorEvent({ mode: 'one-shot' })] },
    });
    recordDeclaredRouteFromChild({
      id: 'child-plain',
      session: { header: { seedLength: 0 }, events: [{ type: 'user/message' }] },
    });
    expect(declaredRouteOf('child-one-shot')).toBeUndefined();
    expect(declaredRouteOf('child-plain')).toBeUndefined();
  });

  it('descriptor 缺 agentModel（未声明路线）不登记', () => {
    recordDeclaredRouteFromChild({
      id: 'child-no-model',
      session: {
        header: { seedLength: 0 },
        events: [descriptorEvent({ agentModel: undefined })],
      },
    });
    expect(declaredRouteOf('child-no-model')).toBeUndefined();
  });

  it('不合规 descriptor payload 折叠 throw 被吞掉——安全无登记', () => {
    recordDeclaredRouteFromChild({
      id: 'child-bad',
      session: {
        header: { seedLength: 0 },
        // version 正确但 mode 非法 → parseSubagentDescriptor throw
        events: [descriptorEvent({ mode: 'bogus' })],
      },
    });
    expect(declaredRouteOf('child-bad')).toBeUndefined();
  });

  it('缺 id / 非对象入参直接早退', () => {
    recordDeclaredRouteFromChild(undefined);
    recordDeclaredRouteFromChild({ session: { events: [descriptorEvent()] } });
    expect(declaredRouteOf('undefined')).toBeUndefined();
    expect(declaredRouteOf('')).toBeUndefined();
  });

  it('installMemberRuntime 的 setup hook 接线：非成员子代理（领队）也登记声明路线', () => {
    // 成员运行时 hook 在成员身份过滤**之前**登记——领队/构建师子代理标签
    // 不是成员标签，同样要进登记表（webui /session-route 的声明值来源）。
    const contributions: ((childCtx: unknown) => () => void)[] = [];
    installMemberRuntime(
      {
        logger: { info: () => undefined, warn: () => undefined },
        subagents: {
          registerContinuableSetup: (fn: (childCtx: unknown) => () => void) => {
            contributions.push(fn);
            return () => undefined;
          },
        },
      } as never,
      { stateDir: '.eteams' } as never,
      () => undefined,
    );
    const contribution = contributions[0]!;
    // 领队子代理：标签不是成员标签 → hook 走成员早退，但登记已发生。
    contribution({
      agent: {
        id: 'cap-child-1',
        session: {
          header: { seedLength: 0 },
          events: [descriptorEvent({ label: 'eteams-captain:项目牧羊人' })],
        },
      },
    });
    expect(declaredRouteOf('cap-child-1')).toEqual({
      provider: 'tokenrouter',
      model: 'glm-5.3-free',
    });
  });
});
