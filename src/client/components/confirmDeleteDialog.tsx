/**
 * 危险操作确认弹窗（docs/44 M7-1，46 清单）：删除团队（teamPage）与删除
 * 任务（taskDialogs，级联提示多一句）原是两份同款「标题 + 描述 + 错误槽 +
 * 破坏性尾行」的 Dialog 壳，收口到这里。观感零变更：弹窗宽 max-w-sm、头
 * 左对齐、尾行经 FormFooterActions 破坏性档（标题不带红字——原两处
 * DialogTitle 均为普通档，破坏性只在确认钮 variant 上）。
 *
 * 错误/描述文案由调用方以已渲染 ReactNode 传入——各弹窗错误槽原本就长在
 * 正文里（shared FormErrorNote 样式，pages 层私有），components 层不得上引
 * pages，故描述/错误以节点形式下沉而不是在此复刻样式类。
 *
 * @module dsh-eteams/client/confirmDeleteDialog
 */
import type { ReactNode } from 'react';
import { FormDialog, FormFooterActions } from './formDialog';

/** ================================== 主组件 ================================== */

/**
 * 危险确认弹窗：open/onOpenChange 原样透传（消费位保留 if (!next) 复位
 * 守卫），title/description 走弹窗头两槽（普通档标题 + muted 小字描述），
 * 确认钮 destructive，busy 中双钮禁用、确认走异步回调（调用方自持
 * try/catch 落错）；error 槽为调用方已渲染节点（原位是 shared
 * FormErrorNote，条件渲染由调用方表达式承担），落在描述与尾行之间——与
 * 两处原弹窗的错误位同构。
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  error,
  confirmLabel,
  confirmBusy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** 提交错误槽（调用方条件渲染的 FormErrorNote 节点——样式类属 pages 层）。 */
  error?: ReactNode;
  confirmLabel: string;
  confirmBusy: boolean;
  onConfirm: () => void;
}): ReactNode {
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      {error}
      <FormFooterActions
        onCancel={() => onOpenChange(false)}
        onConfirm={onConfirm}
        confirmLabel={confirmLabel}
        confirmVariant="destructive"
        cancelDisabled={confirmBusy}
        confirmDisabled={confirmBusy}
      />
    </FormDialog>
  );
}
