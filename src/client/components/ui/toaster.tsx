/**
 * shadcn/ui Toaster（new-york 风格，手动 vendoring — docs/43）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/toaster.json
 * 渲染 useToast 全局单例 store 里的 toasts（hooks/useToast.ts）。本仓适配：
 * 文案本地化（关闭 sr-only 已在 toast.tsx）；挂载位 = 团队面板根
 * （teamsView/index.tsx）——Radix Toast Viewport 就地渲染无 portal，
 * 必须在 `.eteams-ui` 子树内工具类才生效（D19b）。
 *
 * @module dsh-eteams/client/components/ui/toaster
 */
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from './toast';
import { useToast } from '../../hooks/useToast';

export function Toaster(): React.ReactNode {
  const { toasts, dismiss } = useToast();
  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, ...props }) => (
        // open/onOpenChange 接线（上游 shadcn 同款，用户反馈 2026-09-08「反复
        // 弹出已复制」）：不接线时 Radix duration 到点的视觉关闭不回写 store
        // ——僵尸 toast 留在模块级单例里，面板重挂载即以非受控 defaultOpen
        // 复活，每次进页重新弹一遍。这里把关闭事件收口回 store（open=false
        // + 入移除队列），重挂载不再复现。
        <Toast
          key={id}
          {...props}
          open={props.open}
          onOpenChange={(open) => {
            if (!open) dismiss(id);
          }}
        >
          <div className="grid gap-1">
            {title !== undefined && <ToastTitle>{title}</ToastTitle>}
            {description !== undefined && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}