/**
 * 拖拽指派纯逻辑单测（docs/29 A.3.1 规则表锁；四轮撤上限）：drop =
 * chain 全量替换的纯计算——成员拖入成员槽按落点判位插入（三十五轮 DA48：
 * insertionIndexOf 落点判位 + chainAfterInsert 判位插入，空链=追加即放置、
 * 越界 index 夹取、全链同名 no-op 去重、只读窗口拒改；原「chip drop 定点
 * 替换」随 DA48 废止，不再有规则锁）；逐站移除、可编辑框承整链与只读框
 * 展示成员；罗列条工号徽章文案（五轮 DA18）；卡槽内调序与「＋」多选追加
 * （六轮 DA19）；小任务卡片拖拽调执行顺序 = 兄弟依赖链改写（七轮 DA20：
 * executionOrderOf 拓扑展示序 + depPatchesForReorder 依赖补丁）。组件交互
 * （HTML5 拖拽）不在 vitest 环境（无 DOM 拖拽事件合成）覆盖，见完成报告说明。
 */
import { describe, expect, it } from 'vitest';
import type { ChainTaskLike, OrderableTaskLike } from '../src/client/features/tasks/taskAssignCore';
import {
  boxCoversChain,
  canRemoveStation,
  chainAfterAppendMany,
  chainAfterInsert,
  chainAfterRemove,
  chainAfterReorder,
  depPatchesForReorder,
  employeeBadgeOf,
  executionOrderOf,
  insertionIndexOf,
  isAssignEditable,
  memberSessionIdOf,
  readonlyStationMember,
} from '../src/client/features/tasks/taskAssignCore';

/** 便捷构造：chain 站点（member, stageBrief）。 */
const st = (member: string, stageBrief = ''): { member: string; stageBrief: string } => ({
  member,
  stageBrief,
});

describe('isAssignEditable（DA6 客户端守卫：ready && chainCursor===-1）', () => {
  const base: ChainTaskLike = { status: 'ready', chain: [], chainCursor: -1 };
  it('ready 未领取可编辑（用户迭代 2026-09-11：draft 并入 ready）', () => {
    expect(isAssignEditable(base)).toBe(true);
    expect(isAssignEditable({ ...base, status: 'ready' })).toBe(true);
  });
  it('链已开跑（chainCursor≥0）不可编辑——即使 ready', () => {
    expect(isAssignEditable({ ...base, status: 'ready', chainCursor: 0 })).toBe(false);
    expect(isAssignEditable({ ...base, status: 'ready', chainCursor: 2 })).toBe(false);
  });
  it('非 ready（合同冻结）不可编辑', () => {
    for (const status of ['start', 'wait', 'paused', 'wait_user', 'completed', 'cancelled']) {
      expect(isAssignEditable({ ...base, status })).toBe(false);
    }
  });
});

describe('insertionIndexOf（三十五轮 DA48：按落点 X 判插入位）', () => {
  const mids = [10, 30, 50];
  it('空数组 → 0（空链=追加即放置）', () => {
    expect(insertionIndexOf([], 100)).toBe(0);
  });
  it('x 小于首中点 → 0（插首站前）', () => {
    expect(insertionIndexOf(mids, 5)).toBe(0);
  });
  it('两中点之间按左右半分：最近 chip 中点右半 → 插其后（i+1）', () => {
    expect(insertionIndexOf(mids, 25)).toBe(1);
    expect(insertionIndexOf(mids, 35)).toBe(2);
    expect(insertionIndexOf(mids, 55)).toBe(3);
  });
  it('越过全部中点 → len（末尾）', () => {
    expect(insertionIndexOf(mids, 999)).toBe(3);
  });
  it('恰等于中点 → 归右半（x < mid 才左，等号归后）', () => {
    expect(insertionIndexOf(mids, 10)).toBe(1);
    expect(insertionIndexOf(mids, 30)).toBe(2);
    expect(insertionIndexOf(mids, 50)).toBe(3);
  });
});

describe('chainAfterInsert（三十五轮 DA48：松手放置判位插入）', () => {
  it('插中位：前后站点 stageBrief 保真，新站 brief 空串（29.5 冲突①）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('王五', '验收')],
      chainCursor: -1,
    };
    expect(chainAfterInsert(task, '李四', 1)).toEqual([
      st('张三', '设计'),
      st('李四', ''),
      st('王五', '验收'),
    ]);
  });

  it('插 0 = 首站前；插 len = 末尾追加（原「空白处追加」等价承接，不设上限）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: -1,
    };
    expect(chainAfterInsert(task, '王五', 0)).toEqual([
      st('王五', ''),
      st('张三', '设计'),
      st('李四', '实现'),
    ]);
    expect(chainAfterInsert(task, '王五', 2)).toEqual([
      st('张三', '设计'),
      st('李四', '实现'),
      st('王五', ''),
    ]);
  });

  it('全链同名去重（DA8 同源）→ null（不发请求）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: -1,
    };
    expect(chainAfterInsert(task, '张三', 0)).toBeNull();
    expect(chainAfterInsert(task, '张三', 2)).toBeNull();
    expect(chainAfterInsert(task, '李四', 1)).toBeNull();
  });

  it('不可编辑窗口 → null（只读，双保险不重发）', () => {
    expect(
      chainAfterInsert({ status: 'ready', chain: [st('张三')], chainCursor: 0 }, '李四', 1),
    ).toBeNull();
    expect(
      chainAfterInsert({ status: 'in_progress', chain: [st('张三')], chainCursor: -1 }, '李四', 0),
    ).toBeNull();
  });

  it('越界 index 夹取到 [0, len]（快照中途变化防越界，不误投）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: -1,
    };
    expect(chainAfterInsert(task, '王五', -5)).toEqual([
      st('王五', ''),
      st('张三', '设计'),
      st('李四', '实现'),
    ]);
    expect(chainAfterInsert(task, '王五', 99)).toEqual([
      st('张三', '设计'),
      st('李四', '实现'),
      st('王五', ''),
    ]);
  });

  it('空链：任意 index 夹取 → 单站链（拖入=追加即放置）', () => {
    const task: ChainTaskLike = { status: 'ready', chain: [], chainCursor: -1 };
    expect(chainAfterInsert(task, '张三', 0)).toEqual([st('张三', '')]);
    expect(chainAfterInsert(task, '张三', 7)).toEqual([st('张三', '')]);
  });
});

describe('canRemoveStation / chainAfterRemove（chip ×：DA13 逐站移除）', () => {
  it('可编辑窗口内任意站可移除；开跑/冻结不可', () => {
    expect(canRemoveStation({ status: 'ready', chain: [st('张三')], chainCursor: -1 })).toBe(true);
    expect(
      canRemoveStation({ status: 'ready', chain: [st('张三'), st('李四')], chainCursor: -1 }),
    ).toBe(true);
    expect(canRemoveStation({ status: 'ready', chain: [st('张三')], chainCursor: 0 })).toBe(false);
    expect(canRemoveStation({ status: 'completed', chain: [st('张三')], chainCursor: 0 })).toBe(
      false,
    );
  });

  it('移除中间站：其余站点按原序重发（接力顺序收紧）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现'), st('王五', '验收')],
      chainCursor: -1,
    };
    expect(chainAfterRemove(task, 1)).toEqual([st('张三', '设计'), st('王五', '验收')]);
  });

  it('移除末站/首站同理；移除后空链 = 整链重发空链（回领队自由指派，docs/06 §6.7）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: -1,
    };
    expect(chainAfterRemove(task, 1)).toEqual([st('张三', '设计')]);
    expect(chainAfterRemove(task, 0)).toEqual([st('李四', '实现')]);
    expect(chainAfterRemove({ ...task, chain: [st('张三', '设计')] }, 0)).toEqual([]);
  });
});

describe('readonlyStationMember（只读框展示，A.5.1）', () => {
  it('优先当前执行人 assignee', () => {
    const task: ChainTaskLike = {
      status: 'in_progress',
      chain: [st('张三'), st('李四')],
      chainCursor: 1,
      assignee: '李四',
    };
    expect(readonlyStationMember(task)).toBe('李四');
  });
  it('无 assignee 取下一待执行站成员；越界回退末站', () => {
    expect(
      readonlyStationMember({
        status: 'ready',
        chain: [st('张三'), st('李四')],
        chainCursor: 0,
      }),
    ).toBe('李四');
    expect(
      readonlyStationMember({ status: 'completed', chain: [st('张三')], chainCursor: 0 }),
    ).toBe('张三');
  });
  it('空链且未指派 → null（框不渲染）', () => {
    const task: ChainTaskLike = { status: 'assigned', chain: [], chainCursor: -1 };
    expect(readonlyStationMember(task)).toBeNull();
  });
});

describe('boxCoversChain（可编辑框承整链 → 抑制 TaskStations，DA5/DA13）', () => {
  it('可编辑 + 非空链：承整链（抑制站点行）', () => {
    expect(
      boxCoversChain({ status: 'ready', chain: [st('张三'), st('李四')], chainCursor: -1 }),
    ).toBe(true);
    expect(boxCoversChain({ status: 'ready', chain: [st('张三')], chainCursor: -1 })).toBe(true);
  });
  it('可编辑 + 空链：false（TaskStations 本就渲染 null，无需抑制）', () => {
    expect(boxCoversChain({ status: 'ready', chain: [], chainCursor: -1 })).toBe(false);
  });
  it('开跑/冻结：false（框只承单站，站点行照常）', () => {
    expect(
      boxCoversChain({ status: 'ready', chain: [st('张三'), st('李四')], chainCursor: 0 }),
    ).toBe(false);
    expect(boxCoversChain({ status: 'completed', chain: [st('张三')], chainCursor: 0 })).toBe(
      false,
    );
  });
});

describe('employeeBadgeOf（罗列条工号徽章文案，五轮 DA18）', () => {
  it('标准格式：剥 ET- 前缀只留数字', () => {
    expect(employeeBadgeOf('ET-0001')).toBe('0001');
    expect(employeeBadgeOf('ET-42')).toBe('42');
  });
  it('null/undefined/空串（legacy 成员）→ null，不渲染徽章', () => {
    expect(employeeBadgeOf(null)).toBeNull();
    expect(employeeBadgeOf(undefined)).toBeNull();
    expect(employeeBadgeOf('')).toBeNull();
  });
  it('非 ET- 前缀格式原样保留（不猜格式）', () => {
    expect(employeeBadgeOf('W-007')).toBe('W-007');
    expect(employeeBadgeOf('0009')).toBe('0009');
  });
});

describe('memberSessionIdOf（用户 2026-09-14：成员已有实例化会话→绿点+可点击）', () => {
  it('childId 非空串 = 会话已实例化，原样返回（跳转目标）', () => {
    expect(memberSessionIdOf({ childId: 'sess-child-1' })).toBe('sess-child-1');
  });
  it('null/空串/缺省（未起会话或旧快照）→ null，不画点不可点', () => {
    expect(memberSessionIdOf({ childId: null })).toBeNull();
    expect(memberSessionIdOf({ childId: '' })).toBeNull();
    expect(memberSessionIdOf({})).toBeNull();
  });
});

describe('chainAfterReorder（卡槽内 chip 拖动调序，六轮 DA19）', () => {
  it('前站拖到后站：被拖站占目标位、其余顺移（stageBrief 随站走）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现'), st('王五', '验收')],
      chainCursor: -1,
    };
    expect(chainAfterReorder(task, 0, 2)).toEqual([
      st('李四', '实现'),
      st('王五', '验收'),
      st('张三', '设计'),
    ]);
    expect(chainAfterReorder(task, 1, 2)).toEqual([
      st('张三', '设计'),
      st('王五', '验收'),
      st('李四', '实现'),
    ]);
  });
  it('后站拖到前站：被拖站插到目标位', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现'), st('王五', '验收')],
      chainCursor: -1,
    };
    expect(chainAfterReorder(task, 2, 0)).toEqual([
      st('王五', '验收'),
      st('张三', '设计'),
      st('李四', '实现'),
    ]);
  });
  it('自拖自放（from===to）→ null（no-op）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: -1,
    };
    expect(chainAfterReorder(task, 1, 1)).toBeNull();
  });
  it('越界（快照中途变化）→ null', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计')],
      chainCursor: -1,
    };
    expect(chainAfterReorder(task, 0, 1)).toBeNull();
    expect(chainAfterReorder(task, 1, 0)).toBeNull();
    expect(chainAfterReorder(task, -1, 0)).toBeNull();
  });
  it('只读窗口（开跑/冻结）→ null', () => {
    const task: ChainTaskLike = {
      status: 'in_progress',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: 0,
    };
    expect(chainAfterReorder(task, 1, 0)).toBeNull();
  });
});

describe('chainAfterAppendMany（「＋」多选追加，六轮 DA19）', () => {
  it('按勾选顺序逐个末尾追加，brief 空串', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计')],
      chainCursor: -1,
    };
    expect(chainAfterAppendMany(task, ['李四', '王五'])).toEqual([
      st('张三', '设计'),
      st('李四', ''),
      st('王五', ''),
    ]);
  });
  it('已在链中的名字过滤跳过（DA8 去重同源）；全重复 → null', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: -1,
    };
    expect(chainAfterAppendMany(task, ['张三', '王五'])).toEqual([
      st('张三', '设计'),
      st('李四', '实现'),
      st('王五', ''),
    ]);
    expect(chainAfterAppendMany(task, ['张三', '李四'])).toBeNull();
  });
  it('空勾选 → null；只读窗口 → null', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [],
      chainCursor: -1,
    };
    expect(chainAfterAppendMany(task, [])).toBeNull();
    expect(
      chainAfterAppendMany(
        { ...task, status: 'in_progress', chain: [st('张三')], chainCursor: 0 },
        ['李四'],
      ),
    ).toBeNull();
  });
});

/** 便捷构造：可排序小任务（OrderableTaskLike，七轮 DA20；parentId 缺省同父）。 */
const ord = (
  taskId: number,
  deps: number[],
  status = 'ready',
  parentId: number | null = 1,
): OrderableTaskLike => ({ taskId, parentId, status, dependencies: deps });

describe('executionOrderOf（兄弟依赖拓扑展示序，七轮 DA20）', () => {
  it('无依赖 → 创建序原样', () => {
    expect(executionOrderOf([ord(3, []), ord(1, []), ord(2, [])]).map((t) => t.taskId)).toEqual([
      3, 1, 2,
    ]);
  });
  it('兄弟依赖决定先后（输入乱序也按拓扑输出）', () => {
    expect(executionOrderOf([ord(3, [2]), ord(1, []), ord(2, [1])]).map((t) => t.taskId)).toEqual([
      1, 2, 3,
    ]);
  });
  it('外部依赖（兄弟集外）不参与兄弟排序', () => {
    expect(executionOrderOf([ord(2, [99]), ord(1, [])]).map((t) => t.taskId)).toEqual([2, 1]);
  });
  it('增补的无依赖任务追加到末尾，不插队进首个依赖层（用户 2026-09-13）', () => {
    // 1←2←3 线性链 + 后增补的无依赖 4：应连续排开为 1,2,3,4（旧分层实现会给出
    // 1,4,2,3——新任务挤到第二，面板顺序与宿主发棒顺序 subExecutionOrder 不一致）。
    expect(
      executionOrderOf([ord(1, []), ord(2, [1]), ord(3, [2]), ord(4, [])]).map((t) => t.taskId),
    ).toEqual([1, 2, 3, 4]);
  });
  it('环（防御）：剩余按输入序追加，不丢任务', () => {
    expect(executionOrderOf([ord(1, [2]), ord(2, [1]), ord(3, [])]).map((t) => t.taskId)).toEqual([
      3, 1, 2,
    ]);
  });
});

describe('depPatchesForReorder（拖卡调执行顺序 = 兄弟依赖链改写，七轮 DA20）', () => {
  it('前拖后：被拖卡占目标位（数组搬移同 chip 口径），按新序重写线性链；deps 未变的卡不发补丁', () => {
    const tasks = [ord(1, []), ord(2, []), ord(3, [])];
    // 拖 #1 到 #3：新序 [2,3,1] → #2 仍在第 0 位（无补丁）、#3 依赖 #2、#1 依赖 #3。
    expect(depPatchesForReorder(tasks, 1, 3)).toEqual([
      { taskId: 3, dependencies: [2] },
      { taskId: 1, dependencies: [3] },
    ]);
  });
  it('后拖前：被拖卡插到目标位', () => {
    const tasks = [ord(1, []), ord(2, []), ord(3, [])];
    // 拖 #3 到 #1：新序 [3,1,2]。
    expect(depPatchesForReorder(tasks, 3, 1)).toEqual([
      { taskId: 1, dependencies: [3] },
      { taskId: 2, dependencies: [1] },
    ]);
  });
  it('外部依赖保留（补丁只含外部 deps + 前一位兄弟）', () => {
    const tasks = [ord(1, []), ord(2, [99])];
    expect(depPatchesForReorder(tasks, 2, 1)).toEqual([{ taskId: 1, dependencies: [2] }]);
  });
  it('已领取/冻结的兄弟不改写（host 会拒），只补丁 draft/ready 的卡', () => {
    const tasks = [ord(1, [], 'assigned'), ord(2, []), ord(3, [])];
    expect(depPatchesForReorder(tasks, 2, 3)).toEqual([
      { taskId: 3, dependencies: [1] },
      { taskId: 2, dependencies: [3] },
    ]);
  });
  it('from===to / 找不到卡 / 非同父 / 端点不可编辑 → null（no-op）', () => {
    const tasks = [ord(1, []), ord(2, []), ord(9, [], 'ready', 2)];
    expect(depPatchesForReorder(tasks, 2, 2)).toBeNull();
    expect(depPatchesForReorder(tasks, 1, 42)).toBeNull();
    expect(depPatchesForReorder(tasks, 1, 9)).toBeNull();
    expect(depPatchesForReorder([ord(1, [], 'assigned'), ord(2, [])], 1, 2)).toBeNull();
    expect(depPatchesForReorder([ord(1, []), ord(2, [], 'assigned')], 1, 2)).toBeNull();
  });
});
