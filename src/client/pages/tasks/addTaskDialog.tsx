/**
 * 添加任务弹窗（docs/panelTaskCommission 自面板手动建任务）：任务描述
 * Textarea（必填）+ 团队 Select（默认当前团队，选项 = pool 全部团队）。
 * 提交 = 面板 POST /team/<id>/task/commission——宿主建「创建中」容器并交
 * 完善者（有领队 = 领队子代理；无领队 = 主会话），完善前任务卡显「创建中」。
 * 瞬态状态（open/description/teamId/busy/error）由消费页持有、经 props
 * 传入（与 TaskDialogs 同风格）；壳收口 FormDialog/FormFooterActions。
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
import { FORM_LABEL_CLASS, FORM_ROW_CLASS, SELECT_NONE } from '../shared/styles';

/** 团队选择哨兵项文案（placeholder 与哨兵映射同文字面量——reports 页
 * MEMBER_SELECT_PLACEHOLDER 同款单点维护口径；pool 空时仅占位，确认钮
 * 由 teamId 空判禁用）。 */
const TEAM_SELECT_PLACEHOLDER = '— 选择团队 —';

/** 添加任务弹窗（docs/panelTaskCommission §4.2）：描述 + 目标团队两件套，
 * 提交回调在页面（submitAddTask）；校验口径 = 描述非空 + 已选团队，busy
 * 中防连点。 */
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
      description="写出任务目标即可——提交后由团队完善：有领队的队交领队问询并拆解，未设领队的队由当前对话主持；完善收口前任务显示「创建中」。"
    >
      <div className="space-y-2.5">
        {/* 任务描述（必填，用户原话即完善者的拆解输入）。 */}
        <Textarea
          value={description}
          autoFocus
          className="h-[212px] resize-none"
          placeholder="任务描述：一句话说清目标，越具体越好，如「把 docs 下的旧文档迁移到新目录结构并校对链接」"
          onChange={(e) => onDescription(e.target.value)}
        />
        {/* 目标团队（默认当前团队——面板快照池全量选项；SELECT_NONE 哨兵
        映射回 ''，Radix SelectItem 禁空串 value）。 */}
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
                <SelectItem key={t.teamId} value={t.teamId} className="text-[12px]">
                  {t.name}
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