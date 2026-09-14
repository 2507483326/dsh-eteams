/**
 * 跳转会话按钮（看板「决策面板」的「去回答 / 去处理」）：复用任务页同款跳转
 * 原语 `openSession`（宿主 SessionRuntime.open 把目标会话选为当前）。用户
 * 2026-09-14「用户可以点击到对应的对话去回答」。
 *
 * 与任务页「跳转会话」钮的差别：这里**不做 canOpenSession 预隐藏**——目标是
 * 待办项，按钮消失等于「点了没反应」（用户可发起的动作禁静默 no-op 纪律）。
 * 一律渲染，点击时才判定，失败 toast 明确告知。
 *
 * @module dsh-eteams/client/pages/board/jumpConversationButton
 */
import type { ReactNode } from 'react';
import { openSession } from '../../lib/sessionState';
import { toast } from '../../hooks/useToast';
import { Button } from '../../components/ui/button';

/** 目标会话不在列表时的统一提示（与任务页 jumpToSession 同口径）。 */
const JUMP_FAILED = { title: '无法跳转', description: '目标会话不在当前会话列表中。' };

export function JumpConversationButton({
  sessionId,
  label,
}: {
  /** 目标会话 id；null/空 = 无法定位（点击提示）。 */
  sessionId: string | null;
  /** 按钮文案（决策「去处理」/ 问答「去回答」）。 */
  label: string;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => {
        if (sessionId === null || sessionId === '' || !openSession(sessionId)) {
          toast(JUMP_FAILED);
        }
      }}
    >
      {label}
    </Button>
  );
}
