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
  const { toasts } = useToast();
  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, ...props }) => (
        <Toast key={id} {...props}>
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