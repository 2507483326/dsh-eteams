/**
 * 模型二级菜单（用户迭代 2026-09）：领队/成员卡共用的模型与推理等级选择
 * Popover（与对话 ModelSelect 同款交互）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 team/memberCards 消费（依赖方向：team/memberCards → modelRoutePicker
 * → lib；M4 起团队 tab 拆页，见 team/）。
 *
 * @module dsh-eteams/client/pages/team/modelRoutePicker
 */
import { useRef, useState, type ReactNode } from 'react';
import Check from 'lucide-react/dist/esm/icons/check.mjs';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import { catalogRow, type ModelCatalogState } from '../../lib/modelCatalog';
import { cn } from '../../lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';

/** ================================== 样式类 ================================== */

/** 模型二级菜单的行样式（完整字面量，对话 ModelSelect 同构的 token 化版本：
 * root 行 = label + 当前值 + 右箭头；列表项 = 名称 + 描述 + 选中勾）。 */
const PICKER_CELL_CLASS =
  'flex h-9 w-full items-center gap-2 rounded-lg bg-transparent px-2.5 text-left text-[13px] text-foreground outline-none hover:bg-accent disabled:cursor-default disabled:text-muted-foreground';
const PICKER_OPTION_CLASS =
  'flex min-h-[34px] w-full items-center gap-2 rounded-lg bg-transparent px-2 py-1 text-left text-foreground outline-none hover:bg-accent disabled:cursor-default disabled:text-muted-foreground';

/** ================================== 主组件 ================================== */

/** 模型二级菜单（用户迭代 2026-09：与对话 ModelSelect 同款交互）——root
 * 面板两行（「模型」「推理等级」：label + 当前值 + 右箭头），各自钻入列表。
 * 模型列表首行 inherit（会话默认——面板路线语义，对话没有此项），
 * 其后按提供方分组列出会话模型目录（与对话 /model 弹层同一份 groups：
 * 行 id=`provider/model`、名称=目录显示名、sticky 组头、title 带描述），
 * 加载失败的提供方以警示条列出（对话同款，不可选）；推理等级列表 = 该模型
 * reasoning.efforts（适配器命名），模型无目录默认值时前置「Default」= 提供
 * 方默认（提交 null，整路由省略 reasoningEffort）。对话组件不可直接复用
 * （未从包导出、模块加载器包裹、且其 select 会切换会话自身模型），这里按
 * 同一结构以面板 token 重建；目录缺失（旧运行时）时模型列表退回静态选项。
 * 交互对齐：每次打开刷新目录（对话 show() → reload()）、Esc 子面板返回
 * root / root 关闭、方向键在项间漫游、重选当前值仅关闭不上送（choose()
 * 同款）。 */
export function ModelRoutePicker({
  catalogState,
  stored,
  inheritLabel,
  fallback,
  disabled,
  onModelPick,
  onEffortPick,
  title,
}: {
  /** 会话模型目录状态（数据 + loading/failed/reload，对话选择器同款）。 */
  catalogState: ModelCatalogState;
  /** 当前存储路线（inherit 哨兵 = 会话默认）。 */
  stored: { provider: string; model: string; reasoningEffort: string | null };
  /** inherit 行/触发器文案（用户迭代 2026-09 七：成员与领队统一「会话默认」）。 */
  inheritLabel: string;
  /** 静态回退选项（目录不可用时渲染，含 inherit 行）。 */
  fallback: { value: string; label: string }[];
  /** 路由保存中（触发器与选项短暂禁用防连点）。 */
  disabled?: boolean;
  /** 模型选择提交：'inherit' | `provider/model` | 回退裸模型 id。 */
  onModelPick: (value: string) => void;
  /** 推理等级提交：null = 提供方默认（整路由省略 reasoningEffort）。 */
  onEffortPick: (effort: string | null) => void;
  /** 触发器 tooltip。 */
  title: string;
}): ReactNode {
  const catalog = catalogState.catalog;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root');
  const override = stored.provider !== 'inherit' && stored.model !== 'inherit';
  const row = override ? catalogRow(catalog, stored.provider, stored.model) : null;
  const reasoning = row?.model.reasoning;
  // 触发器模型名：inherit → 跟随文案；目录行在 → 目录显示名；历史路线 →
  // 存量模型 id（目录查不到的历史路线合成行兜底，选中态可见）。
  const modelLabel = !override ? inheritLabel : row !== null ? row.model.name : stored.model;
  // 触发器/推理等级面板的当前等级（对话 effectiveEffort 口径）：已存强度
  // 优先（哪怕已不在词汇表——对话 find 失败时原样显示），否则目录默认；
  // null = 提供方默认（对话 effort.providerDefault，显示「Default」）。
  const effectiveEffort: string | null =
    override && stored.reasoningEffort !== null
      ? stored.reasoningEffort
      : (reasoning?.defaultEffort ?? null);
  const effortName = (effort: string | null): string =>
    effort === null ? 'Default' : (reasoning?.efforts.find((e) => e.id === effort)?.name ?? effort);
  const effortLabel = reasoning === undefined ? undefined : effortName(effectiveEffort);
  // 推理等级面板条目（对话 effortChoices 同构）：无目录默认值时前置
  // 「Default」（effort 提交 null = 省略）。
  const effortChoices: {
    key: string;
    effort: string | null;
    label: string;
    description?: string;
  }[] =
    reasoning === undefined
      ? []
      : [
          ...(reasoning.defaultEffort === undefined
            ? [{ key: 'provider-default', effort: null, label: 'Default' }]
            : []),
          ...reasoning.efforts.map((e) => ({
            key: `effort:${e.id}`,
            effort: e.id as string | null,
            label: e.name,
            ...(e.description !== undefined ? { description: e.description } : {}),
          })),
        ];
  // 行值口径（选中态匹配用，同旧 routeValue）：目录在 → `provider/model`；
  // 目录缺失 → 裸模型 id；inherit → 'inherit'。
  const currentValue = !override
    ? 'inherit'
    : catalog === null
      ? stored.model
      : `${stored.provider}/${stored.model}`;

  const close = (): void => setOpen(false);
  // 每次打开重置到 root 并刷新目录（对话 ModelSelect.show() 同款）。
  const openMenu = (): void => {
    setPane('root');
    catalogState.reload();
    setOpen(true);
  };
  const pickModel = (value: string): void => {
    // 重选当前路线仅关闭不上送（对话 choose() 同款，不重复提交）。
    if (value !== currentValue) onModelPick(value);
    close();
  };
  const pickEffort = (effort: string | null): void => {
    if (effort !== effectiveEffort) onEffortPick(effort);
    close();
  };
  // 对话同款焦点巡航：ArrowDown/Up 在浮层内可聚焦项间移动。
  const moveFocus = (offset: number): void => {
    const root = rootRef.current;
    if (root === null) return;
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (items.length === 0) return;
    const active = document.activeElement;
    const at = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
    items[(Math.max(at, 0) + offset + items.length) % items.length]?.focus();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) openMenu();
        else close();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 w-[132px] shrink-0 items-center gap-1 rounded-md border border-solid bg-transparent px-2 text-xs font-medium outline-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          title={title}
          disabled={disabled === true}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="min-w-0 flex-1 truncate text-left">{modelLabel}</span>
          {effortLabel !== undefined && (
            <span className="flex-none text-[11px] text-muted-foreground">{effortLabel}</span>
          )}
          <ChevronDown
            className={cn(
              'h-3 w-3 flex-none text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={rootRef}
        align="end"
        sideOffset={6}
        role="menu"
        aria-label="模型与推理等级"
        className="w-64 rounded-xl border-solid p-1 shadow-lg"
        // 焦点留在触发器（对话同款），ArrowDown/Up 才能漫游进浮层。
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Esc：子面板返回 root（对话同款），root 才真正关闭浮层。
        onEscapeKeyDown={(event) => {
          if (pane !== 'root') {
            event.preventDefault();
            setPane('root');
          }
        }}
        onKeyDown={(event) => {
          // Esc：root 面板手动关闭（对话 onRootKeyDown 同款——不依赖浮层库的
          // dismiss 链路，合成/真实事件行为一致）；子面板由 onEscapeKeyDown
          // 拦下并返回 root。
          if (event.key === 'Escape' && pane === 'root') {
            event.preventDefault();
            close();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveFocus(event.key === 'ArrowDown' ? 1 : -1);
          }
        }}
      >
        {pane === 'root' && (
          <>
            <button type="button" className={PICKER_CELL_CLASS} onClick={() => setPane('model')}>
              <span className="flex-none">模型</span>
              <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                {modelLabel}
              </span>
              <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
            </button>
            {reasoning !== undefined && (
              <button type="button" className={PICKER_CELL_CLASS} onClick={() => setPane('effort')}>
                <span className="flex-none">推理等级</span>
                <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                  {effortLabel ?? 'Default'}
                </span>
                <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
              </button>
            )}
          </>
        )}
        {pane === 'model' && (
          <>
            {/* inherit 行：面板路线语义（会话默认），对话没有此项。 */}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!override}
              className={PICKER_OPTION_CLASS}
              disabled={disabled === true}
              onClick={() => pickModel('inherit')}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {inheritLabel}
              </span>
              <span className="grid h-4 w-4 flex-none place-items-center">
                {!override && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
            {catalogState.loading && (
              <div className="px-2 py-2 text-xs text-muted-foreground">正在刷新模型列表…</div>
            )}
            {catalogState.failed && (
              <div className="mx-1 mb-1 flex items-center justify-between gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs text-destructive">
                <span className="min-w-0">目录加载失败</span>
                <button
                  type="button"
                  className="flex-none font-semibold hover:underline"
                  onClick={() => catalogState.reload()}
                >
                  重试
                </button>
              </div>
            )}
            {catalog !== null ? (
              <>
                {catalog.groups.map((g) => (
                  <section key={g.id} role="group" aria-label={g.name} className="mt-1 first:mt-0">
                    <div className="sticky top-0 z-[1] bg-popover px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
                      {g.name}
                    </div>
                    {g.models.map((m) => {
                      const selected =
                        override && stored.provider === g.id && stored.model === m.id;
                      return (
                        <button
                          key={`${g.id}/${m.id}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={PICKER_OPTION_CLASS}
                          disabled={disabled === true}
                          title={
                            m.description !== undefined ? `${g.name} · ${m.description}` : g.name
                          }
                          onClick={() => pickModel(`${g.id}/${m.id}`)}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-[13px] font-medium">{m.name}</span>
                            {m.description !== undefined && (
                              <span className="truncate text-[11px] text-muted-foreground">
                                {m.description}
                              </span>
                            )}
                          </span>
                          <span className="grid h-4 w-4 flex-none place-items-center">
                            {selected && <Check className="h-3.5 w-3.5" />}
                          </span>
                        </button>
                      );
                    })}
                  </section>
                ))}
                {catalog.failures.map((f) => (
                  <div
                    key={`failure/${f.id}`}
                    className="mx-1 mb-1 flex items-start justify-between gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs text-warning"
                    title={f.message}
                  >
                    <span className="min-w-0">
                      {f.name} 加载失败：{f.message}
                    </span>
                    <button
                      type="button"
                      className="flex-none font-semibold hover:underline"
                      onClick={() => catalogState.reload()}
                    >
                      重试
                    </button>
                  </div>
                ))}
                {/* 目录查不到的历史路线合成一行，保证选中态可见。 */}
                {override && row === null && (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked
                    className={PICKER_OPTION_CLASS}
                    disabled
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {stored.model}
                    </span>
                    <span className="grid h-4 w-4 flex-none place-items-center">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  </button>
                )}
              </>
            ) : !catalogState.failed ? (
              fallback
                .filter((o) => o.value !== 'inherit')
                .map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={currentValue === o.value}
                    className={PICKER_OPTION_CLASS}
                    disabled={disabled === true}
                    onClick={() => pickModel(o.value)}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {o.label}
                    </span>
                    <span className="grid h-4 w-4 flex-none place-items-center">
                      {currentValue === o.value && <Check className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                ))
            ) : null}
          </>
        )}
        {pane === 'effort' && (
          <>
            {effortChoices.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                当前模型未提供推理等级。
              </div>
            ) : (
              effortChoices.map((level) => {
                const selected = effectiveEffort === level.effort;
                return (
                  <button
                    key={level.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={PICKER_OPTION_CLASS}
                    disabled={disabled === true}
                    onClick={() => pickEffort(level.effort)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium">{level.label}</span>
                      {level.description !== undefined && (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {level.description}
                        </span>
                      )}
                    </span>
                    <span className="grid h-4 w-4 flex-none place-items-center">
                      {selected && <Check className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                );
              })
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
