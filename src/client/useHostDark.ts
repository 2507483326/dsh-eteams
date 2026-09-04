/**
 * 宿主暗色订阅（docs/28.5.2 复用 mdEditor 的判定）：body[data-ds-dark-theme]
 * 属性即暗色，MutationObserver 跟随宿主切换。供面板卡片与 Markdown 编辑器
 * 共用——抽到这里避免第二个实现漂移。
 *
 * @module dsh-eteams/client/useHostDark
 */
import { useEffect, useState } from 'react';

/** 当前是否宿主暗色（body[data-ds-dark-theme]），实时跟随切换。 */
export function useHostDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme'),
  );
  useEffect(() => {
    const sync = (): void => setDark(document.body.hasAttribute('data-ds-dark-theme'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}