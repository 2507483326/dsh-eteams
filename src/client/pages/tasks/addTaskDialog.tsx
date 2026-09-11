/**
 * 添加任务弹窗：任务描述 Textarea（必填）+ 目标团队 Select（默认当前会话
 * 绑定的团队，选项 = pool 全部团队，选项行带首字徽章——用户迭代 2026-09-11
 * 「和对话里的团队选择样式差不多」）。提交不再是面板 commission，而是
 * **新开一个对话**：描述作为新对话首条消息、团队绑定到新对话，由该对话从零
 * 建立任务单（编排见 lib/taskConversation）。瞬态状态（open/description/
 * teamId/busy/error）由消费页持有、经 props 传入（与 TaskDialogs 同风格）；
 * 壳收口 FormDialog/FormFooterActions。
 *
 * @module dsh-eteams/client/pages/tasks/addTaskDialog
 */
import type { ReactNode } from 'react';
import type { TeamSnapshot } from '../../lib/monitor';
import { FormDialog, FormFooterActions } from '../../components/formDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { FormErrorNote } from '../shared/components';
import { FORM_LABEL_CLASS, FORM_ROW_CLASS, SELECT_NONE, TEAM_CHIP_CLASS } from '../shared/styles';

/** 团队选择哨兵项文案（placeholder 与哨兵映射同文字面量——reports 页
 * MEMBER_SELECT_PLACEHOLDER 同款单点维护口径；pool 空时仅占位，确认钮
 * 由 teamId 空判禁用）。 */
const TEAM_SELECT_PLACEHOLDER = '— 选择团队 —';

/**
 * 团队选项行（用户迭代 2026-09-11：观感对齐对话里的团队选择）：首字徽章
 * （TEAM_CHIP_CLASS，对话弹层团队行/团队列表卡标题同款）+ 队名，选中态走
 * 品牌淡底 + 品牌字（teamsButton 弹层 `data-[selected=true]` 的同款视觉，
 * 这里落在 Radix 的 `data-[state=checked]`）。选项内容是 SelectItemText 的
 * 子节点——Radix 会把选中项内容一并投影进 SelectValue，触发器因此也带徽章。
 */
const TEAM_OPTION_CLASS =
  'gap-2 rounded-[8px] text-[12px] font-medium data-[state=checked]:bg-business-tint data-[state=checked]:text-[color:var(--eteams-brand-ink)]';

/** 添加任务弹窗：描述 + 目标团队两件套，提交回调在页面（submitAddTask，
 * 新开对话编排）；校验口径 = 描述非空 + 已选团队，busy 中防连点。 */
export function AddTaskDialog({
  open,
  description,
  teamId,
  pool,
  busy,
  error,
  onDescription,
  onTeamId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  description: string;
  teamId: string;
  pool: TeamSnapshot[];
  busy: boolean;
  error: string | null;
  onDescription: (value: string) => void;
  onTeamId: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}): ReactNode {
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      width="max-w-md"
      title="添加任务"
      description="写出任务目标 + 选团队——提交后会新开一个对话，把这段描述发给团队并从零建立任务单：有领队的队交领队问询拆解，未设领队的队由该对话直接主持。"
    >
      <div className="space-y-2.5">
        {/* 任务描述（必填，用户原话即新对话的首条消息）。 */}
        <Textarea
          value={description}
          autoFocus
          className="h-[212px] resize-none"
          placeholder="任务描述：一句话说清目标，越具体越好，如「把 docs 下的旧文档迁移到新目录结构并校对链接」"
          onChange={(e) => onDescription(e.target.value)}
        />
        {/* 目标团队（默认当前会话绑定的团队——面板快照池全量选项；SELECT_NONE
        哨兵映射回 ''，Radix SelectItem 禁空串 value）。选项带首字徽章，观感
        对齐对话里的团队选择（用户迭代 2026-09-11）。 */}
        <div className={FORM_ROW_CLASS}>
          <span className={FORM_LABEL_CLASS}>目标团队</span>
          <Select
            value={teamId === '' ? SELECT_NONE : teamId}
            onValueChange={(v) => onTeamId(v === SELECT_NONE ? '' : v)}
          >
            <SelectTrigger className="h-[30px] w-full px-2.5 text-[12px] font-medium">
              <SelectValue placeholder={TEAM_SELECT_PLACEHOLDER} />
            </SelectTrigger>
            <SelectContent>
              {pool.map((t) => (
                <SelectItem key={t.teamId} value={t.teamId} className={TEAM_OPTION_CLASS}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={TEAM_CHIP_CLASS} aria-hidden={true}>
                      {t.name.slice(0, 1)}
                    </span>
                    <span className="truncate">{t.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error !== null && <FormErrorNote>{error}</FormErrorNote>}
        <FormFooterActions
          className="justify-end gap-2 pt-1"
          cancelDisabled={busy}
          confirmDisabled={busy || description.trim() === '' || teamId === ''}
          confirmLabel="添加任务"
          onCancel={onClose}
          onConfirm={onSubmit}
        />
      </div>
    </FormDialog>
  );
}