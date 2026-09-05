/**
 * 任务编辑/删除弹窗（2026-09-05 三十一轮 DA44④ 自 tasksTab 纯移动抽离）：
 * TaskEditTarget 类型 + TaskDialogs（编辑/新增 + 删除确认，列表/详情两页共用
 * 同一实例）。弹窗 JSX 原样搬移；瞬态状态与提交回调仍由 tasksTab 持有、经
 * props 传入。原注释逐字随迁（纯移动、零行为变更）。
 *
 * @module dsh-eteams/client/pages/teamsView/taskDialogs
 */
import type { ReactNode } from 'react';
import type { TaskView } from '../../lib/monitor';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { FormErrorNote, MUTED_CLASS } from './shared';

/** 任务编辑/新增弹窗目标（docs/26）：group = 挂靠的主任务（任务单）；
 * task = 被编辑的小任务，null = 新增小任务。六轮 DA19：弹窗不再编排链
 * （成员槽编辑段撤除）——链增删调序只走任务行下方卡槽（＋多选/×/拖动）。 */
export interface TaskEditTarget {
  group: TaskView;
  task: TaskView | null;
}

/** 任务编辑/删除弹窗（DA44④ 自 tasksTab `dialogs` 节点抽离）：open 判据/
 * 校验口径不动，onCloseEdit/onDeleteDismiss 即原 closeEdit 与删除槽清空。 */
export function TaskDialogs({
  editTarget,
  editSubject,
  editDesc,
  editBusy,
  editError,
  deleteTarget,
  deleteBusy,
  deleteError,
  onCloseEdit,
  onSaveEdit,
  onEditSubject,
  onEditDesc,
  onDeleteConfirm,
  onDeleteDismiss,
}: {
  editTarget: TaskEditTarget | null;
  editSubject: string;
  editDesc: string;
  editBusy: boolean;
  editError: string | null;
  deleteTarget: TaskView | null;
  deleteBusy: boolean;
  deleteError: string | null;
  onCloseEdit: () => void;
  onSaveEdit: () => void;
  onEditSubject: (value: string) => void;
  onEditDesc: (value: string) => void;
  onDeleteConfirm: () => void;
  onDeleteDismiss: () => void;
}): ReactNode {
  const editingTask = editTarget !== null && editTarget.task !== null ? editTarget.task : null;
  return (
    <>
      {/* docs/26 小任务编辑/新增弹窗：主题 + 说明（六轮 DA19：成员槽编辑
      段撤除——链编排只走任务行下方卡槽：＋多选 / × / chip 拖动调序）。
      新增时空表单。 */}
      <Dialog
        open={editTarget !== null}
        onOpenChange={(next) => {
          if (!next) onCloseEdit();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle>
              {editingTask !== null ? `修改 #${editingTask.taskId}` : '新增小任务'}
            </DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              挂靠任务单 #{editTarget?.group.taskId ?? ''}（{editTarget?.group.subject ?? ''}
              ）；成员接力请在详情页小任务卡下方的卡槽中拖放或点「＋」添加。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <Input
              value={editSubject}
              autoFocus
              placeholder="小任务主题"
              onChange={(e) => onEditSubject(e.target.value)}
            />
            <Textarea
              value={editDesc}
              rows={2}
              placeholder="说明 / 验收要点（可空）"
              onChange={(e) => onEditDesc(e.target.value)}
            />
            {editError !== null && <FormErrorNote>{editError}</FormErrorNote>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={editBusy}
                onClick={onCloseEdit}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={editBusy || editSubject.trim() === ''}
                onClick={() => void onSaveEdit()}
              >
                {editingTask !== null ? '保存' : '新增'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 任务删除确认弹窗（十二轮 DA25 共用面扩大：列表卡删除 + 详情页
      小任务删除；标题去「小任务」限定，主任务追加级联提示）。未领取
      （draft/ready）可删，host 校验，拒绝原因就地显示。 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) onDeleteDismiss();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle>删除任务</DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              确定删除「{deleteTarget?.subject ?? ''}」？
              {deleteTarget?.kind === 'group' ? '主任务将级联删除全部小任务，' : ''}
              未领取的任务删除后不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteError !== null && <FormErrorNote>{deleteError}</FormErrorNote>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deleteBusy}
              onClick={onDeleteDismiss}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleteBusy}
              onClick={() => void onDeleteConfirm()}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
