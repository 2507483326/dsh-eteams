/**
 * shadcn useToast hook（new-york 基线，手动 vendoring — docs/43）。
 *
 * 源码基线：https://ui.shadcn.com/r/hooks/use-toast（new-york 文档页源码）。
 * 文件名用 camelCase（hooks/ 目录 eslint 强制 camelCase——useHostDark.ts
 * 同款；components/ui 的 kebab-case override 不覆盖本目录）。
 *
 * 全局单例 store：任意代码调用 `toast()`，挂了 `<Toaster/>` 的 React 树
 * 渲染之。本仓多表面架构（index.tsx 按槽位注册独立表面）——首个挂载位 =
 * 团队面板根（teamsView/index.tsx）；其它表面以后要发 toast，须在自身树里
 * 挂 `<Toaster/>`（store 是模块级单例，不随表面销毁）。
 *
 * @module dsh-eteams/client/hooks/useToast
 */
import * as React from 'react';
import type { ToastActionElement, ToastProps } from '../components/ui/toast';

/** 上游默认：同时最多 1 枚。 */
const TOAST_LIMIT = 1;

/** 上游默认：状态移除延迟（视觉关闭由 Radix duration 承担，此处只做内存清理）。 */
const TOAST_REMOVE_DELAY = 1000000;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

let count = 0;
function genId(): string {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type Action =
  | { type: 'ADD_TOAST'; toast: ToasterToast }
  | { type: 'UPDATE_TOAST'; toast: Partial<ToasterToast> }
  | { type: 'DISMISS_TOAST'; toast?: ToasterToast['id'] }
  | { type: 'REMOVE_TOAST'; toast: ToasterToast['id'] };

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const addToRemoveQueue = (toastId: string): void => {
  if (toastTimeouts.has(toastId)) return;
  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({ type: 'REMOVE_TOAST', toast: toastId });
  }, TOAST_REMOVE_DELAY);
  toastTimeouts.set(toastId, timeout);
};

let memoryState: ToasterToast[] = [];
const listeners: Array<(state: ToasterToast[]) => void> = [];

function dispatch(action: Action): void {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => listener(memoryState));
}

export function reducer(state: ToasterToast[], action: Action): ToasterToast[] {
  switch (action.type) {
    case 'ADD_TOAST':
      return [...state, action.toast].slice(-TOAST_LIMIT);
    case 'UPDATE_TOAST':
      return state.map((t) => (t.id === action.toast.id ? { ...t, ...action.toast } : t));
    case 'DISMISS_TOAST': {
      const { toast: id } = action;
      if (id !== undefined) addToRemoveQueue(id);
      else state.forEach((t) => addToRemoveQueue(t.id));
      return state.map((t) => (id === undefined || t.id === id ? { ...t, open: false } : t));
    }
    case 'REMOVE_TOAST':
      return state.filter((t) => t.id !== action.toast);
    default:
      return state;
  }
}

export function toast(props: Omit<ToasterToast, 'id'>): {
  id: string;
  dismiss: () => void;
  update: (props: Partial<ToasterToast>) => void;
} {
  const id = genId();
  const update = (props: Partial<ToasterToast>): void =>
    dispatch({ type: 'UPDATE_TOAST', toast: { ...props, id } });
  const dismiss = (): void => dispatch({ type: 'DISMISS_TOAST', toast: id });

  dispatch({ type: 'ADD_TOAST', toast: { ...props, id } });
  return { id, dismiss, update };
}

export function useToast(): {
  toasts: ToasterToast[];
  toast: typeof toast;
  dismiss: (id?: ToasterToast['id']) => void;
} {
  const [state, setState] = React.useState<ToasterToast[]>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) listeners.splice(index, 1);
    };
  }, []);

  return {
    toasts: state,
    toast,
    dismiss: (id?: ToasterToast['id']) => dispatch({ type: 'DISMISS_TOAST', toast: id }),
  };
}