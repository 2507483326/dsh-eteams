/**
 * 表单弹窗壳与表单尾行（docs/44 M7-1，46 清单）：弹窗壳（Dialog +
 * DialogContent + 官网左对齐头）与「取消 + 确认」尾行原在各页逐字重复——
 * 新增团队弹窗（teamPage / teamDetailPage / memberDetailPage 三份同款）、
 * 任务编辑弹窗（taskDialogs）、添加成员弹窗（addMembersDialog）、角色详情
 * 页头保存行（rosterDetailPage）、成员手册头保存行（memberDetailPage）、
 * 任务就地编辑器尾行（taskDetailPage）——收口到这里。观感零变更：行差异
 * 位（pt-1 / justify-between / flex-none / ghost 取消钮 / 左槽计数）全部经
 * props 透传；按钮固定 type="button" size="sm"。
 *
 * @module dsh-eteams/client/formDialog
 */
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

/** 弹窗描述文字（同 pages/shared MUTED_CLASS 值——components 层
 * 不得上引 pages，字面量各自持有，见 45 依赖方向）。 */
const DESCRIPTION_CLASS = 'text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]';

/** ================================== 主组件 ================================== */

/**
 * 表单弹窗壳：open/onOpenChange 原样透传（消费位保留各自 if (!next) 复位
 * 守卫），标题/描述入官网左对齐头（space-y-1 text-left），描述吃 muted 小字
 * 档；正文（输入/错误槽/尾行）由 children 承载。width 默认 max-w-sm
 * （新增团队三份），任务弹窗传 max-w-md。
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  width = 'max-w-sm',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  width?: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={width}>
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={DESCRIPTION_CLASS}>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 表单尾行：取消（默认 outline）+ 确认（默认 default）两个 sm 钮。默认
 * justify-end 收右；行差异经 props：className 透传（pt-1 / justify-between /
 * flex-none 等原行差异位，恒与 'flex items-center' 合成）、cancelVariant
 * （成员手册头用 ghost）、left 左槽（添加成员弹窗的已选计数 span——按钮组
 * 保持成组靠右，与原内层行同构）。
 */
export function FormFooterActions({
  onCancel,
  onConfirm,
  confirmLabel,
  cancelLabel = '取消',
  cancelVariant = 'outline',
  confirmVariant = 'default',
  cancelDisabled = false,
  confirmDisabled = false,
  className = 'justify-end gap-2',
  left,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  cancelVariant?: 'outline' | 'ghost' | 'secondary';
  confirmVariant?: 'default' | 'destructive';
  cancelDisabled?: boolean;
  confirmDisabled?: boolean;
  className?: string;
  left?: ReactNode;
}): ReactNode {
  return (
    <div className={cn('flex items-center', className)}>
      {left}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={cancelVariant}
          size="sm"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={confirmVariant}
          size="sm"
          disabled={confirmDisabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
