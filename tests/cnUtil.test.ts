/**
 * cn() 合并工具单测（docs/21-client-ui-stack.md S2）：clsx 串接 +
 * tailwind-merge 去重。重点是 tailwind-merge 的组冲突语义——同组后者胜、
 * `p` 是 `px`/`py` 的超集组（后写的 p 清掉先写的 px/py，反之并存）、
 * 互不冲突的组全部保留。这是后续表面迁移「调用方覆盖组件默认类」的
 * 行为契约（shadcn cn 合并惯例，S4 起的组件全走这条路）。
 */
import { describe, expect, it } from 'vitest';
import { cn } from '../src/client/cn';

describe('cn（clsx + tailwind-merge）', () => {
  it('同组冲突：后写覆盖先写，无关类保留', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    // 字号与字色是不同组：text-base 只覆盖 text-sm，字色保留。
    expect(cn('text-sm text-red-600', 'text-base')).toBe('text-red-600 text-base');
  });

  it('条件类：falsy 输入被过滤；布尔开关两分支各归其位', () => {
    expect(cn('flex', false, undefined, null, '')).toBe('flex');
    // 典型调用面：boolean 开关决定是否附加类（参数化以覆盖两个分支）。
    const withFlag = (flag: boolean): string => cn('flex', flag && 'flex-col');
    expect(withFlag(true)).toBe('flex flex-col');
    expect(withFlag(false)).toBe('flex');
  });

  it('多参合并：字符串 / 数组 / 对象混合，falsy 对象值被剔除', () => {
    expect(cn('flex', ['items-center', 'gap-2'], { 'justify-between': true, hidden: false })).toBe(
      'flex items-center gap-2 justify-between',
    );
  });

  it('px/py 特异性：后写 p 覆盖 px/py；后写 px 与 p 并存', () => {
    // p 是 px/py 的超集组：后写的 p-2 清掉先写的 px-4 / py-1。
    expect(cn('px-4 py-1', 'p-2')).toBe('p-2');
    // px 是更具体的组：后写的 px-4 不清 p-2，两者并存（具体类留后生效）。
    expect(cn('p-2', 'px-4')).toBe('p-2 px-4');
    expect(cn('py-1', 'py-3')).toBe('py-3');
  });
});
