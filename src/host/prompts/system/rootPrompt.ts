/**
 * 主对话注入 band 文本组装（v12 用户迭代「system 角色」）：角色库中
 * is_root 保留角色「system」的手册(MD)注入主对话窗口的 system 提示词。
 * 纯文本函数：注入行查表由 runtime 薄壳（runtime/rootPrompt.ts）完成后
 * 传参，这里不触状态（依赖方向 prompts ← runtime，同 sessionPersona.ts）。
 *
 * @module dsh-eteams/prompts/system/rootPrompt
 */
import { neutralizeInterpolation } from './sessionPersona.js';

/**
 * The 主对话注入 band for one assembly（runtime 薄壳查到原文后委托；空段
 * 语义在薄壳里——无会话/空原文直接给 ''，不进本函数；此处空防为兜底）。
 *
 * 手册原文 VERBATIM 嵌入（注入内容逐字等于用户编辑的文本）——先过
 * `neutralizeInterpolation` 防宿主插值渲染器在未知 `{{变量}}` 上炸整个
 * 装配；8000 字符截断并自述（sessionPersonaBand 同口径）。
 */
export function rootPromptBand(md: string): string {
  const full = neutralizeInterpolation(md.trim());
  if (full === '') return '';
  const clipped =
    full.length > 8000
      ? `${full.slice(0, 8000)}\n（注入内容过长已截断——完整内容请在角色库「system」详情页查看）`
      : full;
  return [
    '【eteams 主对话注入·生效中】角色库中的保留角色「system」为本次主对话注入了以下自定义指令——它们是对你的全局补充约束，与内置说明同等遵守：',
    '',
    clipped,
  ].join('\n');
}
