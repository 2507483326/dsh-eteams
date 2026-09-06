/**
 * 任务展开区正文工具（2026-09-06 三十四轮 DA47）：自 taskDetailPage 迁出
 * mergedBodyOf 共用 + 新增只读 readBodyOf——说明/合同并读单 MD 文档，与
 * 就地编辑器同源。
 *
 * @module dsh-eteams/client/pages/tasks/taskBody
 */
import type { TaskView } from '../../lib/monitor';

/** DA41 就地编辑：说明 + 合同 MD 并读为一个 MD 文本（说明在前、空行分隔），
 * 保存时整篇作为 contractMd 回写（description 落严格空串）。DA47 自
 * taskDetailPage 迁入共用。 */
export const mergedBodyOf = (t: TaskView): string =>
  (t.description !== null && t.description.trim() !== ''
    ? `${t.description.replace(/\s+$/, '')}\n\n`
    : '') + (t.contractMd ?? '');

/** DA47 只读展示版 mergedBodyOf：说明段独换行（\n 左右皆非 \n）升级为 GFM
 * 硬断行（行尾两空格）——单换行纯文本在 MD 软断行下折叠成空格（「文字都
 * 粘一起了」根因）；已有空行（段落断）不动；合同段逐字透传（作者已按 MD
 * 书写，列表/代码块结构不动——独换行升格若吃进合同会把紧凑列表
 * `1. a\n2. b` 变成单列表项，故只升说明段）。 */
export const readBodyOf = (t: TaskView): string => {
  const desc =
    t.description !== null && t.description.trim() !== ''
      ? `${t.description.replace(/\s+$/, '').replace(/(?<!\n)\n(?!\n)/g, '  \n')}\n\n`
      : '';
  return desc + (t.contractMd ?? '');
};
