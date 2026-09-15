/**
 * 待决策已读账本的行为锁定（用户 2026-09-15「有新的待决策内容时……直到进入
 * 面板看到决策，或者决策被回答」）：红点判据 = pending 且未读；进入面板标记
 * 已读收点；决策被处置（行离快照）自动熄灭；同一 id 换创建时刻视为新单；
 * 账本落 localStorage，刷新/重建内存不丢已读。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  markPendingDecisionsSeen,
  pendingItemKey,
  pendingItemKeys,
  resetDecisionSeenForTests,
  unseenPendingKeys,
} from '../src/client/features/activity/decisionSeen';
import type { PendingAction } from '../src/client/features/activity/activityView';
import type { TeamSnapshot } from '../src/client/lib/monitor';

interface DecisionSeed {
  id: number;
  taskId: number;
  error: string;
  retryCount: number;
  createdAt: number;
}

interface AskSeed {
  askId: string;
  askingName: string;
  askingKind: string;
  questionCount: number;
  createdAt: number;
}

/** 最小 TeamSnapshot：pendingActionsOf 只读 tasks/pendingDecisions/pendingAsks。 */
function fakeTeam(seed: {
  teamId?: string;
  decisions?: DecisionSeed[];
  asks?: AskSeed[];
}): TeamSnapshot {
  return {
    teamId: seed.teamId ?? '1',
    tasks: [],
    pendingDecisions: seed.decisions ?? [],
    pendingAsks: seed.asks ?? [],
  } as unknown as TeamSnapshot;
}

const decision = (id: number, createdAt: number): DecisionSeed => ({
  id,
  taskId: 42,
  error: '同成员重试超限',
  retryCount: 3,
  createdAt,
});

const ask = (askId: string, createdAt: number): AskSeed => ({
  askId,
  askingName: '领队',
  askingKind: 'captain',
  questionCount: 2,
  createdAt,
});

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  resetDecisionSeenForTests();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
    clear: (): void => {
      storage.clear();
    },
  };
});

afterEach(() => {
  resetDecisionSeenForTests();
  (globalThis as { localStorage?: unknown }).localStorage = undefined;
});

describe('待决策已读账本', () => {
  it('待决策与待问答都计入未读，键含创建时刻', () => {
    const team = fakeTeam({ decisions: [decision(7, 1000)], asks: [ask('1111-2222', 2000)] });
    expect(pendingItemKeys([team])).toEqual(['d7@1000', 'a1111-2222@2000']);
    expect(unseenPendingKeys([team])).toEqual(['d7@1000', 'a1111-2222@2000']);
    expect(pendingItemKey({ key: 'd7', at: 1000 } as PendingAction)).toBe('d7@1000');
  });

  it('进入面板标记已读后同一条不再计入（幂等）', () => {
    const team = fakeTeam({ decisions: [decision(7, 1000)] });
    expect(unseenPendingKeys([team])).toHaveLength(1);
    markPendingDecisionsSeen(team);
    expect(unseenPendingKeys([team])).toEqual([]);
    // 再调一次（每次快照都会调）不改变结果，也不重复写盘。
    storage.clear();
    markPendingDecisionsSeen(team);
    expect(storage.size).toBe(0);
    expect(unseenPendingKeys([team])).toEqual([]);
  });

  it('决策被回答/处置（行离开快照）后红点自行熄灭，无需标记', () => {
    const before = fakeTeam({ decisions: [decision(7, 1000)] });
    expect(unseenPendingKeys([before])).toHaveLength(1);
    const after = fakeTeam({ decisions: [] });
    expect(unseenPendingKeys([after])).toEqual([]);
  });

  it('同一 id 换创建时刻视为新单（id 复用不误判已读）', () => {
    const first = fakeTeam({ decisions: [decision(7, 1000)] });
    markPendingDecisionsSeen(first);
    expect(unseenPendingKeys([first])).toEqual([]);
    const reused = fakeTeam({ decisions: [decision(7, 5000)] });
    expect(unseenPendingKeys([reused])).toEqual(['d7@5000']);
  });

  it('跨团队不漏报，且标记只覆盖被展示的那一队', () => {
    const teamA = fakeTeam({ teamId: '1', decisions: [decision(7, 1000)] });
    const teamB = fakeTeam({ teamId: '2', decisions: [decision(8, 2000)] });
    expect(unseenPendingKeys([teamA, teamB])).toEqual(['d7@1000', 'd8@2000']);
    markPendingDecisionsSeen(teamA);
    expect(unseenPendingKeys([teamA, teamB])).toEqual(['d8@2000']);
    markPendingDecisionsSeen(teamB);
    expect(unseenPendingKeys([teamA, teamB])).toEqual([]);
  });

  it('账本落 localStorage：重建内存账本后已读不丢', () => {
    const team = fakeTeam({ decisions: [decision(7, 1000)] });
    markPendingDecisionsSeen(team);
    resetDecisionSeenForTests();
    expect(unseenPendingKeys([team])).toEqual([]);
  });

  it('无 localStorage（Node/隐私模式）按空账本，会话内仍生效', () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    resetDecisionSeenForTests();
    const team = fakeTeam({ decisions: [decision(7, 1000)] });
    expect(unseenPendingKeys([team])).toEqual(['d7@1000']);
    markPendingDecisionsSeen(team);
    expect(unseenPendingKeys([team])).toEqual([]);
  });
});
