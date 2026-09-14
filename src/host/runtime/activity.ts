/**
 * 看板「动态」事件域：把 `events` 表的原始事件规范化成看板时间线可用的一行
 * 人类文案与语义色调（顺序无关、纯函数，可单测）。原 `summarizeEvent` 自
 * webui.ts 迁入本模块（webui 改为再导出，既有消费/测试 import 不变），并
 * **补齐全部当前实际发出的事件类型**——旧实现只覆盖早期类型，`attempt.*`/
 * `task.wait`/`task.retrying` 等会渲染成原始 type 串（看板时间线暴露为
 * 裸英文），此次一并收编。
 *
 * @module dsh-eteams/runtime/activity
 */
import type { EventRecord } from '../model/types.js';

/** 语义色调（与客户端 Tone 同字面量）：看板时间线的行首彩点用。 */
export type EventTone = 'info' | 'ok' | 'warn' | 'err' | 'muted';

/** 事件类型 → 色调：完成/站点完成=ok；挂起/等待/升级/重试/婉拒/作废=warn；
 * 失败/取消/偏离=err；其余变更=info；未知=muted。 */
export function eventTone(type: string): EventTone {
  switch (type) {
    case 'task.completed':
    case 'task.stage_completed':
    case 'decision.resolved':
      return 'ok';
    case 'task.suspended':
    case 'task.wait':
    case 'task.escalated':
    case 'decision.requested':
    case 'task.retrying':
    case 'task.failed':
    case 'attempt.declined':
    case 'attempt.revoked':
    case 'chain.deviated':
      return 'warn';
    case 'task.cancelled':
      return 'err';
    default:
      return 'info';
  }
}

/**
 * One-line human summary of an event for the 动态 view（补齐全部实际发出类型）。
 */
export function summarizeEvent(e: EventRecord): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const task = e.taskId !== undefined ? `#${e.taskId}` : '';
  const member = String(p.member ?? '');
  switch (e.type) {
    case 'team.created':
      return `创建团队「${String(p.name ?? '')}」`;
    case 'plan.questionnaire':
      return `问询完成（${String(p.count ?? '?')} 问）`;
    case 'member.added':
      return `成员「${String(p.name ?? '')}」加入`;
    case 'member.updated':
      return `成员「${String(p.name ?? '')}」已更新`;
    case 'member.removed':
      return `成员「${String(p.name ?? '')}」移除`;
    case 'member.synced_roster':
      return `成员「${String(p.name ?? '')}」同步到角色库`;
    case 'leader.removed':
      return '领队已移出团队';
    case 'leader.restored':
      return '领队回到团队';
    case 'task.created':
      return `新建任务 ${task}`;
    case 'task.updated':
      return `任务 ${task} 已更新`;
    case 'task.deleted':
      return `任务 ${task} 已删除`;
    case 'task_commissioned':
      // 面板手动建任务（docs/panelTaskCommission）：派发失败也如实展示。
      return p.dispatched === true
        ? `面板创建任务 ${task}，已交${p.hasLeader === true ? '领队' : '主会话'}完善`
        : `面板创建任务 ${task}（创建中），完善者未送达：${String(p.reason ?? '')}`;
    case 'task.assigned':
      return `${task} 指派给 ${member}`;
    case 'task.unassigned':
      return `${task} 取消指派`;
    case 'task.started':
      return `${task} 开始执行`;
    case 'task.reopened':
      return `${task} 重新打开`;
    case 'task.redelivered':
      return `${task} 已重新派发`;
    // 新命名（当前运行时实际发出）：attempt.claimed / attempt.progress。
    case 'attempt.claimed':
    case 'task.claimed':
      return `${member} 接取 ${task}`;
    case 'attempt.progress':
    case 'task.progress':
      return `${task} 进度：${String(p.text ?? '')}`;
    case 'attempt.declined':
      return `${member} 婉拒 ${task}：${String(p.reason ?? '')}`;
    case 'attempt.revoked':
      return `${task} 尝试作废：${String(p.reason ?? '')}`;
    case 'task.stage_completed':
      return `${task} 站点完成，下一站 ${String(p.next ?? '?')}`;
    case 'task.completed':
      return `${task} 已完成`;
    case 'task.wait':
      return `${task} 待领队分诊（已重试 ${String(p.retryCount ?? '?')} 次）`;
    case 'task.escalated':
      return `${task} 升级待用户处理：${String(p.note ?? p.error ?? '')}`;
    case 'task.retrying':
    case 'task.retried':
      return `${task} 第 ${String(p.retry ?? p.retryCount ?? '?')} 次重试`;
    case 'task.failed':
      return `${task} 失败：${String(p.error ?? '')}`;
    case 'chain.deviated':
      return `${task} 偏离执行链：${String(p.note ?? '')}`;
    case 'task.suspended':
      return `${task} 已挂起`;
    case 'task.resumed':
      return `${task} 已恢复`;
    case 'task.cancelled':
      return `${task} 已取消`;
    case 'decision.requested':
      return `${task} 待用户处理：${String(p.error ?? '')}`;
    case 'decision.resolved':
      return `${task} 决策已处理（${String(p.choice ?? '')}）`;
    case 'message.sent':
      return `消息 → ${String(p.to ?? '')}`;
    case 'mail.queued':
      return `邮件入箱 → ${String(p.to ?? '')}`;
    default:
      return e.type;
  }
}
